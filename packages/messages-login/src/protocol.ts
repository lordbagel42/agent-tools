import type { GoogleCredentials } from "./cookies.js";

const MAX_START_RESPONSE_BYTES = 16 * 1024;
const MAX_SETUP_TOKEN_BYTES = 1024;
const MAX_LEASE_LIFETIME_MS = 15 * 60_000;
const PORTAL_SESSION_MESSAGE =
  "The portal session may have expired. Close and reopen the helper, enter the portal PIN, then try again.";

export type SessionFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface SetupLease {
  readonly token: string;
  readonly expiresAt: number;
}

export type HandoffDecision =
  | { readonly kind: "accepted"; readonly paired: false; readonly retry: false }
  | {
      readonly kind: "ambiguous" | "expired" | "rejected" | "replay";
      readonly retry: false;
    };

export class PairingProtocolError extends Error {
  constructor(message = "The pairing server returned an invalid response.") {
    super(message);
    this.name = "PairingProtocolError";
  }
}

async function readBoundedBody(
  response: Response,
  byteLimit: number,
): Promise<string> {
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > byteLimit
  ) {
    throw new PairingProtocolError();
  }

  if (response.body === null) {
    throw new PairingProtocolError();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalLength += value.byteLength;
      if (totalLength > byteLimit) {
        try {
          await reader.cancel();
        } catch {
          // The size failure is the only result exposed to the caller.
        }
        throw new PairingProtocolError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PairingProtocolError();
  }
}

function hasHeaderControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function parseLease(value: unknown, now: number): SetupLease {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PairingProtocolError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "expiresAt" || keys[1] !== "token") {
    throw new PairingProtocolError();
  }

  const { token, expiresAt } = record;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    new TextEncoder().encode(token).byteLength > MAX_SETUP_TOKEN_BYTES ||
    hasHeaderControlCharacter(token)
  ) {
    throw new PairingProtocolError();
  }
  if (
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_LEASE_LIFETIME_MS
  ) {
    throw new PairingProtocolError();
  }

  return Object.freeze({ token, expiresAt });
}

function postInit(headers: Record<string, string>, body: string): RequestInit {
  return {
    method: "POST",
    headers,
    body,
    credentials: "include",
    redirect: "manual",
    cache: "no-store",
  };
}

export class PairingProtocol {
  readonly #origin: string;
  readonly #fetch: SessionFetch;
  readonly #now: () => number;
  readonly #consumedLeases = new WeakSet<SetupLease>();

  constructor(origin: string, fetch: SessionFetch, now = Date.now) {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin) {
      throw new TypeError("PairingProtocol requires a canonical HTTPS origin.");
    }
    this.#origin = origin;
    this.#fetch = fetch;
    this.#now = now;
  }

  async start(): Promise<SetupLease> {
    const startedAt = this.#now();
    let response: Response;
    try {
      response = await this.#fetch(
        new URL("/connect/start", this.#origin).href,
        postInit(
          {
            "Content-Type": "application/json",
            Origin: this.#origin,
          },
          "{}",
        ),
      );
    } catch (error) {
      // Electron 44 rejects manual redirects rather than returning a 3xx.
      // Recognize only that exact error; never expose other transport details.
      throw new PairingProtocolError(
        error instanceof Error && error.message === "Redirect was cancelled"
          ? PORTAL_SESSION_MESSAGE
          : "Could not reach the pairing server.",
      );
    }

    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new PairingProtocolError(PORTAL_SESSION_MESSAGE);
    }
    if (response.status !== 200) {
      const guidance =
        response.status === 401
          ? PORTAL_SESSION_MESSAGE
          : "Check the server page and try again.";
      throw new PairingProtocolError(
        `Could not start setup (HTTP ${response.status}). ${guidance}`,
      );
    }
    const contentType = response.headers.get("Content-Type");
    if (
      contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      throw new PairingProtocolError();
    }

    const text = await readBoundedBody(response, MAX_START_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new PairingProtocolError();
    }
    const now = this.#now();
    const serverDate = Date.parse(response.headers.get("Date") ?? "");
    if (!Number.isFinite(serverDate)) return parseLease(parsed, now);

    // The server owns the deadline; the desktop's wall clock may differ. HTTP
    // Date has second precision, so subtract its uncertainty and the round trip
    // rather than extending the server's lease by either amount.
    const serverNow = serverDate + 1000;
    const lease = parseLease(parsed, serverNow);
    const expiresAt = startedAt + (lease.expiresAt - serverNow);
    if (expiresAt <= now) throw new PairingProtocolError();
    return Object.freeze({ token: lease.token, expiresAt });
  }

  async complete(
    lease: SetupLease,
    cookies: GoogleCredentials,
  ): Promise<HandoffDecision> {
    if (this.#consumedLeases.has(lease)) {
      return { kind: "replay", retry: false };
    }
    this.#consumedLeases.add(lease);

    if (lease.expiresAt <= this.#now()) {
      return { kind: "expired", retry: false };
    }

    let response: Response;
    try {
      response = await this.#fetch(
        new URL("/connect/complete", this.#origin).href,
        postInit(
          {
            "Content-Type": "application/json",
            Origin: this.#origin,
            "X-Setup-Token": lease.token,
          },
          JSON.stringify({ cookies }),
        ),
      );
    } catch {
      return { kind: "ambiguous", retry: false };
    }

    if (response.redirected || response.status !== 202) {
      return { kind: "rejected", retry: false };
    }
    return { kind: "accepted", paired: false, retry: false };
  }
}

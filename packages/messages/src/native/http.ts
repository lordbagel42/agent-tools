import { createHash } from "node:crypto";
import { ApiError } from "../types.js";
import { array, parsePblite } from "./wire.js";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type RpcMethod =
  | "SignInGaia"
  | "RegisterRefresh"
  | "SendMessage"
  | "AckMessages"
  | "ReceiveMessages";
const origin = "https://messages.google.com";
const relay =
  "https://instantmessaging-pa.clients6.google.com/$rpc/google.internal.communications.instantmessaging.v1.";
export const userAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

export async function readBody(
  response: Response,
  max = 8 * 1024 * 1024,
): Promise<string> {
  if (!response.body) throw new Error("Missing Google response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) {
        await reader.cancel();
        throw new Error("Google response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class GoogleHttp {
  private apiKey = "";
  constructor(
    readonly cookies: Record<string, string>,
    private readonly saveCookies: () => Promise<void>,
    private readonly fetcher: Fetch = fetch,
    private readonly now = Date.now,
  ) {}

  async prepare(
    signal?: AbortSignal,
  ): Promise<{ deviceId: string; version: unknown[] }> {
    const page = await this.request(
      `${origin}/web/welcome`,
      undefined,
      false,
      signal,
    );
    const html = (await readBody(page)).replace(
      /\\x([0-9a-f]{2})/gi,
      (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)),
    );
    // This is Google's public frontend API key, fetched from Google rather than a third-party source.
    const match = /"A16fYe",\s*\[null,null,"(AIza[\w-]{35})"/.exec(html);
    if (!match?.[1])
      throw new ApiError(
        503,
        "GOOGLE_CONFIG_CHANGED",
        "Google's public client configuration changed.",
      );
    this.apiKey = match[1];
    const response = await this.request(
      `${origin}/web/config`,
      undefined,
      true,
      signal,
    );
    const config = array(parsePblite(await readBody(response)));
    const deviceId = Array.isArray(config[4]) ? config[4][3] : undefined;
    if (
      typeof deviceId !== "string" ||
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(deviceId)
    )
      throw new ApiError(
        401,
        "GOOGLE_LOGIN_REQUIRED",
        "Google sign-in is required. Use the local login helper.",
      );
    const date =
      typeof config[0] === "string"
        ? /^(\d{4})(\d{2})(\d{2})/.exec(config[0])
        : null;
    if (!date)
      throw new ApiError(
        503,
        "GOOGLE_CONFIG_CHANGED",
        "Google's client version is unavailable.",
      );
    return {
      deviceId,
      version: [
        null,
        null,
        Number(date[1]),
        Number(date[2]),
        Number(date[3]),
        null,
        4,
        null,
        6,
      ],
    };
  }

  private async request(
    url: string,
    payload: unknown[] | undefined,
    authenticated: boolean,
    signal?: AbortSignal,
    streaming = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "user-agent": userAgent,
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
    };
    if (authenticated) {
      headers.cookie = Object.entries(this.cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
      const timestamp = Math.floor(this.now() / 1000);
      const hash = createHash("sha1")
        .update(`${timestamp} ${this.cookies.SAPISID ?? ""} ${origin}`)
        .digest("hex");
      headers.authorization = `SAPISIDHASH ${timestamp}_${hash}`;
      headers["x-goog-api-key"] = this.apiKey;
      headers.referer = `${origin}/`;
    }
    if (payload) {
      headers["content-type"] = "application/json+protobuf";
      headers.origin = origin;
      headers["x-user-agent"] = "grpc-web-javascript/0.1";
    }
    // No request (especially SendMessage) is automatically retried here. Only the read loop reconnects.
    const timeout = AbortSignal.timeout(streaming ? 5 * 60_000 : 30_000);
    const response = await this.fetcher(url, {
      method: payload ? "POST" : "GET",
      headers,
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (authenticated) {
      let changed = false;
      for (const header of response.headers.getSetCookie()) {
        const first = header.split(";", 1)[0] ?? "";
        const equals = first.indexOf("=");
        const name = first.slice(0, equals);
        const value = first.slice(equals + 1);
        if (
          equals < 1 ||
          !/^[A-Za-z0-9_-]+$/.test(name) ||
          !/^[\x21-\x7e]*$/.test(value) ||
          value.length > 4096
        )
          continue;
        if (this.cookies[name] !== value) {
          this.cookies[name] = value;
          changed = true;
        }
      }
      if (changed) await this.saveCookies();
    }
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      const login = [401, 403, 404].includes(response.status);
      throw new ApiError(
        login ? 401 : 503,
        login ? "GOOGLE_LOGIN_REQUIRED" : "GOOGLE_UNAVAILABLE",
        login
          ? "Google rejected the session. Sign in again with the local helper."
          : "Google's Messages service is unavailable.",
      );
    }
    return response;
  }

  async rpc(
    method: RpcMethod,
    payload: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const service =
      method === "SignInGaia" || method === "RegisterRefresh"
        ? "Registration"
        : "Messaging";
    const response = await this.request(
      `${relay}${service}/${method}`,
      payload,
      true,
      signal,
    );
    return array(parsePblite(await readBody(response)));
  }

  async receive(payload: unknown[], signal: AbortSignal): Promise<Response> {
    return this.request(
      `${relay}Messaging/ReceiveMessages`,
      payload,
      true,
      signal,
      true,
    );
  }
}

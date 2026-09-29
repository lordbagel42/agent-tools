import { z } from "zod";

export const createSchema = z
  .object({
    retentionSeconds: z.number().int().min(60).max(2592000).default(86400),
    linkTtlSeconds: z.number().int().min(60).max(604800).default(86400),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(50 * 1024 * 1024)
      .default(50 * 1024 * 1024),
    webhookUrl: z.string().max(2048).url().optional(),
  })
  .strict();
export type CreateInput = z.infer<typeof createSchema>;

export function validateWebhook(value: string, env: Env) {
  const url = new URL(value);
  const allowed = env.WEBHOOK_ORIGINS.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !allowed.includes(url.origin) ||
    !url.hostname.includes(".") ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":") ||
    /\.(localhost|local|internal)$/.test(url.hostname)
  ) {
    throw new Error(
      "Webhook must use an operator-approved HTTPS origin, without credentials or a fragment",
    );
  }
}

export async function signHmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
    ),
  );
}

export function token() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

export function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function digest(value: string) {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

export function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export async function matches(value: string, expectedHash: string) {
  const hash = await digest(value);
  return crypto.subtle.timingSafeEqual(
    new TextEncoder().encode(hash),
    new TextEncoder().encode(expectedHash),
  );
}

export async function authenticated(request: Request, env: Env) {
  if (!env.API_TOKEN || env.API_TOKEN.length < 32) return false;
  return matches(bearer(request), await digest(env.API_TOKEN));
}

export async function downloadLink(
  env: Env,
  id: string,
  fileExpiresAt: number,
) {
  const expires = Math.min(fileExpiresAt, Date.now() + 300000);
  const signature = await signHmac(
    env.API_TOKEN,
    `download\n${id}\n${expires}`,
  );
  return {
    downloadUrl: `${env.PUBLIC_ORIGIN}/api/uploads/${id}/content?expires=${expires}&signature=${signature}`,
    downloadUrlExpiresAt: expires,
  };
}

export async function authorizedDownload(url: URL, id: string, env: Env) {
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (
    !env.API_TOKEN ||
    env.API_TOKEN.length < 32 ||
    !Number.isSafeInteger(expires) ||
    expires <= Date.now() ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return false;
  const expected = await signHmac(env.API_TOKEN, `download\n${id}\n${expires}`);
  return matches(signature, await digest(expected));
}

export function filename(header: string | null) {
  try {
    const name =
      decodeURIComponent(header ?? "file")
        .split(/[\\/]/)
        .pop() ?? "file";
    // Files are attachments; names are display metadata, never storage paths.
    return (
      name
        .replace(/[\p{C}]/gu, "")
        .trim()
        .slice(0, 180) || "file"
    );
  } catch {
    return "file";
  }
}

export async function smallJson(request: Request) {
  if (!request.body) throw new Error("Missing JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) throw new Error("JSON too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function problem(status: number, error: string) {
  return Response.json({ error }, { status });
}

export function secured(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, headers });
}

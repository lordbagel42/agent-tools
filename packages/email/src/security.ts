import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const policySchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(80),
        tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
        inboxes: z.array(z.string().min(1).max(64)).max(100).default([]),
        webhooks: z.boolean(),
        manageInboxes: z.boolean().default(false),
      })
      .strict(),
  )
  .max(100);
export type Principal = z.infer<typeof policySchema>[number];

export function policy(env: Env) {
  const entries = policySchema.parse(JSON.parse(env.ACCESS_POLICY));
  if (
    new Set(entries.map((p) => p.id)).size !== entries.length ||
    new Set(entries.map((p) => p.tokenHash)).size !== entries.length
  )
    throw new Error("Duplicate principals");
  return entries;
}

export function authenticate(request: Request, env: Env) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return undefined;
  const hash = createHash("sha256").update(authorization.slice(7)).digest();
  return policy(env).find((p) =>
    timingSafeEqual(hash, Buffer.from(p.tokenHash, "hex")),
  );
}

export function inboxName(value: string) {
  const name = value.toLowerCase();
  // Canonical ASCII dot-atom local parts; no prefix restriction.
  if (
    name.length > 64 ||
    !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(
      name,
    )
  ) {
    throw new Error("Invalid inbox");
  }
  return name;
}

export async function authorize(
  principal: Principal,
  inbox: string,
  env: Env,
  write = false,
) {
  const name = inboxName(inbox);
  if (write && !principal.webhooks)
    throw new Error("Webhook permission denied");
  if (
    name !== env.MAIN_INBOX &&
    !principal.inboxes.includes(name) &&
    (await env.DIRECTORY.getByName(env.MAIL_DOMAIN).owner(name)) !==
      principal.id
  )
    throw new Error("Inbox access denied");
  return name;
}

export async function knownInbox(name: string, env: Env) {
  return (
    name === env.MAIN_INBOX ||
    policy(env).some((p) => p.inboxes.includes(name)) ||
    (await env.DIRECTORY.getByName(env.MAIL_DOMAIN).owner(name)) !== null
  );
}

export function webhookUrl(value: string, env: Env) {
  const url = new URL(value);
  const allowed = z.array(z.string()).parse(JSON.parse(env.WEBHOOK_URLS));
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(url.hostname) ||
    /\.(localhost|local|internal|test|invalid|onion)$/.test(url.hostname) ||
    !allowed.includes(url.href)
  )
    throw new Error("Webhook endpoint not approved");
  return url.href;
}

export function secret() {
  return randomBytes(32).toString("hex");
}

export class SizeLimitError extends Error {}

export async function boundedBytes(
  stream: ReadableStream<Uint8Array>,
  max: number,
) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new SizeLimitError("Message too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

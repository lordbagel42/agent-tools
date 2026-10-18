import { requireMcpAuth } from "@better-auth/mcp";
import { createAuth, ownerId } from "./auth";
import { MAX_MAIL } from "./inbox";
import { tools } from "./mcp";
import { consentPage, loginPage, setupPage } from "./pages";
import {
  authenticate,
  authorize,
  boundedBytes,
  inboxName,
  knownInbox,
  type Principal,
  policy,
  SizeLimitError,
} from "./security";

export { Directory } from "./directory";
export { Inbox } from "./inbox";

async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.origin !== env.PUBLIC_ORIGIN)
    return new Response("Unexpected host", { status: 421 });
  if (
    request.headers.has("origin") &&
    request.headers.get("origin") !== env.PUBLIC_ORIGIN
  )
    return new Response("Cross-origin denied", { status: 403 });
  const auth = createAuth(env);
  if (
    url.pathname.startsWith("/api/auth/") ||
    url.pathname.startsWith("/.well-known/")
  ) {
    if (request.body)
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: await boundedBytes(request.body, 32768),
      });
    return auth.handler(request);
  }
  if (request.method === "GET") {
    if (url.pathname === "/login" || url.pathname === "/") return loginPage();
    if (url.pathname === "/setup") return setupPage();
    if (url.pathname === "/consent") {
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session || session.user.id !== (await ownerId(env)))
        return new Response(null, {
          status: 302,
          headers: { location: `/login${url.search}` },
        });
      const id = url.searchParams.get("client_id") ?? "";
      const client = await auth.api.getOAuthClientPublic({
        headers: request.headers,
        query: { client_id: id },
      });
      return consentPage(client.client_name ?? "MCP client", id);
    }
  }
  const principal = authenticate(request, env);
  if (principal) return protectedRoute(request, env, principal);
  return requireMcpAuth(
    auth,
    async (req, claims) => {
      const owner = policy(env).find((p) => p.id === env.OAUTH_PRINCIPAL_ID);
      if (
        !owner ||
        claims.sub !== (await ownerId(env)) ||
        typeof claims.azp !== "string"
      )
        return new Response("Forbidden", { status: 403 });
      return protectedRoute(req, env, owner);
    },
    { resource: `${env.PUBLIC_ORIGIN}/mcp`, requiredScopes: ["email:manage"] },
  )(request);
}

async function protectedRoute(
  request: Request,
  env: Env,
  principal: Principal,
) {
  const url = new URL(request.url);
  if (url.pathname === "/mcp" && request.method === "POST") {
    if (!request.body) return new Response("Missing body", { status: 400 });
    let bytes: Uint8Array;
    try {
      bytes = await boundedBytes(request.body, 16384);
    } catch {
      return new Response("Request too large", { status: 413 });
    }
    return tools(env, principal).fetch(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: bytes,
      }),
    );
  }
  const raw = /^\/mail\/([^/]+)\/([a-f0-9-]{36})\.eml$/.exec(url.pathname);
  if (raw && request.method === "GET") {
    const inbox = await authorize(principal, decodeURIComponent(raw[1]), env);
    const { bytes } = await env.INBOXES.getByName(
      `${inbox}@${env.MAIL_DOMAIN}`,
    ).raw(raw[2]);
    return new Response(bytes, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${raw[2]}.eml"`,
      },
    });
  }
  return new Response("Not found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env) {
    let response: Response;
    try {
      response = await route(request, env);
    } catch {
      response = new Response("Request unavailable", { status: 403 });
    }
    response.headers.set("cache-control", "no-store");
    response.headers.set("x-content-type-options", "nosniff");
    if (!response.headers.has("content-security-policy"))
      response.headers.set(
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'",
      );
    return response;
  },
  async email(message: ForwardableEmailMessage, env: Env) {
    const recipient = message.to.toLowerCase();
    const split = recipient.lastIndexOf("@");
    let inbox: string | undefined;
    try {
      if (recipient.slice(split + 1) === env.MAIL_DOMAIN)
        inbox = inboxName(recipient.slice(0, split));
    } catch {
      /* Invalid envelope recipients are rejected, never used as storage keys. */
    }
    if (!inbox || !(await knownInbox(inbox, env))) {
      message.setReject(
        "Unknown inbox; create the address before sending mail",
      );
      return;
    }
    if (message.rawSize > MAX_MAIL) {
      message.setReject("Mail exceeds 25 MiB limit");
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await boundedBytes(message.raw, MAX_MAIL);
    } catch (error) {
      if (!(error instanceof SizeLimitError)) throw error;
      message.setReject("Mail exceeds 25 MiB limit");
      return;
    }
    // Await durable commit; do not acknowledge mail with only waitUntil persistence.
    const stub = env.INBOXES.getByName(`${inbox}@${env.MAIL_DOMAIN}`);
    await stub.receive(
      message.from,
      recipient,
      message.headers.get("subject") ?? "",
      bytes,
    );
  },
} satisfies ExportedHandler<Env>;

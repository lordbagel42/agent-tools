import { requireMcpAuth } from "@better-auth/mcp";
import { Elysia } from "elysia";
import { marked } from "marked";
import { z } from "zod";
import type { createAuth } from "./auth";
import { type ArtifactConfig, artifactUrl } from "./config";
import { createTools } from "./mcp";
import {
  consentPage,
  galleryPage,
  loginPage,
  markdownPage,
  signupPage,
  viewerPage,
} from "./pages";
import {
  type Artifact,
  ArtifactError,
  type ArtifactStore,
  type Metadata,
  revisionSchema,
  slugSchema,
} from "./store";

const contentPolicy =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net/npm/ https://cdn.tailwindcss.com https://code.jquery.com; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
const notFound = () => Response.json({ error: "Not found" }, { status: 404 });
const forbidden = () => Response.json({ error: "Forbidden" }, { status: 403 });

function contentResponse(artifact: Artifact): Response {
  const content =
    artifact.format === "markdown"
      ? markdownPage(marked.parse(artifact.content, { async: false }))
      : artifact.content;
  return new Response(content, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": contentPolicy,
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()",
    },
  });
}

export function createApp(options: {
  config: ArtifactConfig;
  auth: ReturnType<typeof createAuth>;
  store: ArtifactStore;
  ownerId: string;
  log?: (record: {
    method: string;
    route: string;
    status: number;
    durationMs: number;
  }) => void;
}) {
  const { config, auth, store, ownerId } = options;
  const management = new URL(config.origin);
  const sdk = createTools(store, ownerId, config);
  const protectedMcp = requireMcpAuth(
    auth,
    (request, claims) => {
      if (
        claims.sub !== ownerId ||
        typeof claims.azp !== "string" ||
        typeof claims.exp !== "number"
      )
        return forbidden();
      return sdk.fetch(request);
    },
    { resource: `${config.origin}/mcp`, requiredScopes: ["artifacts:manage"] },
  );
  const ownerSession = async (request: Request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user.id === ownerId;
  };
  let streams = 0;
  function events(
    request: Request,
    current: () => Promise<Metadata | null>,
  ): Response {
    if (streams >= 128)
      return new Response("Too many viewers", {
        status: 503,
        headers: { "Retry-After": "30" },
      });
    streams++;
    let finish = () => {};
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let pending = false;
        let interval: ReturnType<typeof setInterval>;
        let timeout: ReturnType<typeof setTimeout>;
        finish = () => {
          if (closed) return;
          closed = true;
          streams--;
          clearInterval(interval);
          clearTimeout(timeout);
          request.signal.removeEventListener("abort", finish);
          if (!cancelled) controller.close();
        };
        async function tick() {
          if (pending || closed) return;
          pending = true;
          try {
            const item = await current();
            if (closed) return;
            controller.enqueue(
              encoder.encode(
                item
                  ? `event: revision\ndata: ${JSON.stringify({ revision: item.revision })}\n\n`
                  : "event: unavailable\ndata: {}\n\n",
              ),
            );
            if (!item) finish();
          } catch {
            if (!closed) finish();
          } finally {
            pending = false;
          }
        }
        interval = setInterval(() => void tick(), 2000);
        timeout = setTimeout(() => finish(), 10 * 60 * 1000);
        request.signal.addEventListener("abort", finish, { once: true });
        if (request.signal.aborted) finish();
        else void tick();
      },
      cancel() {
        cancelled = true;
        finish();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("origin");
    const isManagement = url.host === management.host;
    if (!isManagement) {
      if (
        request.method !== "GET" ||
        !url.hostname.endsWith(config.hostSuffix) ||
        url.port !== management.port
      )
        return notFound();
      const candidate = slugSchema.safeParse(
        url.hostname.slice(0, -config.hostSuffix.length),
      );
      if (!candidate.success) return notFound();
      const item = store.publicRead(candidate.data);
      if (!item) return notFound();
      if (path === "/")
        return viewerPage(item, {
          private: false,
          publicUrl: artifactUrl(config, item.slug),
        });
      if (path === "/content") return contentResponse(item);
      if (path === "/events")
        return events(request, async () =>
          store.publicMetadata(candidate.data),
        );
      return notFound();
    }
    // Never trust X-Forwarded-Host. The configured origin is canonical even
    // when the verified edge forwards HTTP internally (including DPoP URLs).
    if (url.origin !== config.origin)
      request = new Request(`${config.origin}${path}${url.search}`, request);
    if (path === "/healthz" && request.method === "GET")
      return Response.json({ status: "ok" });
    if (path === "/mcp") {
      if (origin && origin !== config.origin) return forbidden();
      return protectedMcp(request);
    }
    if (path.startsWith("/api/auth/") || path.startsWith("/.well-known/"))
      return auth.handler(request);
    if (path === "/login" && request.method === "GET") return loginPage();
    if (path === "/signup" && request.method === "GET") return signupPage();
    const owner = await ownerSession(request);
    if (!owner) {
      if (
        request.method === "GET" &&
        (path === "/" || path === "/consent" || /^\/a\/[^/]+$/.test(path))
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `/login${path === "/consent" ? url.search : ""}`,
          },
        });
      }
      return Response.json({ error: "Sign in required" }, { status: 401 });
    }
    if (!["GET", "HEAD"].includes(request.method) && origin !== config.origin)
      return forbidden();
    if (path === "/consent" && request.method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const client = await auth.api.getOAuthClientPublic({
        headers: request.headers,
        query: { client_id: clientId },
      });
      return consentPage(
        client.client_name ?? "MCP client",
        clientId,
        url.searchParams.get("scope") ?? "",
        `${config.origin}/mcp`,
      );
    }
    if (path === "/" && request.method === "GET")
      return galleryPage(store.list(ownerId), config.origin);
    if (path === "/api/artifacts" && request.method === "GET")
      return Response.json({ artifacts: store.list(ownerId) });
    const privatePath = path.match(/^\/a\/([^/]+)(?:\/(content|events))?$/);
    if (privatePath && request.method === "GET") {
      const slug = slugSchema.parse(privatePath[1]);
      if (privatePath[2] === "events")
        return events(request, async () =>
          (await ownerSession(request)) ? store.metadata(ownerId, slug) : null,
        );
      const revision = url.searchParams.has("revision")
        ? revisionSchema.parse(Number(url.searchParams.get("revision")))
        : undefined;
      const item = store.read(ownerId, slug, revision);
      if (privatePath[2] === "content") return contentResponse(item);
      return viewerPage(item, {
        private: true,
        publicUrl: artifactUrl(config, slug),
        history: store.history(ownerId, slug),
        pinned: revision !== undefined,
      });
    }
    const api = path.match(
      /^\/api\/artifacts\/([^/]+)(?:\/(publish|unpublish))?$/,
    );
    if (api) {
      const slug = slugSchema.parse(api[1]);
      if (request.method === "GET" && !api[2])
        return Response.json({ artifact: store.metadata(ownerId, slug) });
      if (request.method === "POST" && api[2] === "publish") {
        const input = z
          .object({
            revision: revisionSchema,
            expectedRevision: revisionSchema,
          })
          .parse(await request.json());
        return Response.json({
          artifact: store.publish(
            ownerId,
            slug,
            input.revision,
            input.expectedRevision,
          ),
        });
      }
      if (request.method === "POST" && api[2] === "unpublish")
        return Response.json({ artifact: store.unpublish(ownerId, slug) });
    }
    return notFound();
  }

  return new Elysia().all(
    "*",
    async ({ request }) => {
      const start = performance.now();
      let response: Response;
      try {
        response = await route(request);
      } catch (error) {
        const status =
          error instanceof ArtifactError
            ? error.status
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? 400
              : 500;
        response = Response.json(
          {
            error:
              error instanceof ArtifactError
                ? error.message
                : status === 400
                  ? "Invalid request"
                  : "Request failed",
          },
          { status },
        );
      }
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
      const path = new URL(request.url).pathname;
      options.log?.({
        method: request.method,
        route:
          path === "/mcp"
            ? "mcp"
            : path.startsWith("/api/auth/")
              ? "auth"
              : path.endsWith("/content")
                ? "content"
                : path.endsWith("/events")
                  ? "events"
                  : "web",
        status: response.status,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      });
      return response;
    },
    { parse: "none" },
  );
}

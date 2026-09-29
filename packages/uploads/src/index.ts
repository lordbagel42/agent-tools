import { tools } from "./mcp";
import {
  authenticated,
  authorizedDownload,
  problem,
  secured,
  smallJson,
} from "./security";
import { createUpload } from "./upload";

export { Upload } from "./upload";

async function route(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.origin !== env.PUBLIC_ORIGIN) return problem(421, "Unexpected host");
  const origin = request.headers.get("origin");
  if (origin && origin !== env.PUBLIC_ORIGIN)
    return problem(403, "Cross-origin request denied");
  if (url.pathname === "/healthz" && request.method === "GET")
    return Response.json({ ok: true });
  const match = /^\/api\/uploads\/([a-f0-9-]{36})(\/content|\/info)?$/.exec(
    url.pathname,
  );
  if (
    match &&
    ((match[2] === "/content" && request.method === "PUT") ||
      (match[2] === "/info" && request.method === "GET"))
  ) {
    return env.UPLOADS.getByName(match[1]).fetch(request);
  }
  if (
    match?.[2] === "/content" &&
    request.method === "GET" &&
    (await authorizedDownload(url, match[1], env))
  ) {
    return env.UPLOADS.getByName(match[1]).download();
  }
  if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
    if (!(await authenticated(request, env)))
      return problem(401, "Management Bearer token required");
    if (url.pathname === "/mcp") {
      if (request.method !== "POST")
        return problem(405, "Use MCP over HTTP POST");
      let body: unknown;
      try {
        body = await smallJson(request);
      } catch {
        return problem(400, "Invalid or oversized MCP request");
      }
      return tools(env).fetch(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
        }),
      );
    }
    if (url.pathname === "/api/uploads" && request.method === "POST") {
      try {
        return Response.json(
          await createUpload(env, await smallJson(request)),
          { status: 201 },
        );
      } catch {
        return problem(400, "Invalid upload options or request body");
      }
    }
    if (match) {
      const stub = env.UPLOADS.getByName(match[1]);
      if (request.method === "GET" && match[2] === "/content")
        return stub.download();
      if (!match[2] && request.method === "GET") {
        const status = await stub.status();
        return status
          ? Response.json(status)
          : problem(410, "Upload expired or unavailable");
      }
      if (!match[2] && request.method === "DELETE") {
        await stub.remove();
        return Response.json({ deleted: true });
      }
    }
    return problem(404, "Not found");
  }
  if (
    request.method === "GET" &&
    (url.pathname === "/" || /^\/u\/[a-f0-9-]{36}$/.test(url.pathname))
  ) {
    return env.ASSETS.fetch(new Request(new URL("/", env.PUBLIC_ORIGIN)));
  }
  if (
    request.method === "GET" &&
    ["/style.css", "/upload.js"].includes(url.pathname)
  ) {
    return env.ASSETS.fetch(
      new Request(new URL(url.pathname, env.PUBLIC_ORIGIN)),
    );
  }
  return problem(404, "Not found");
}

export async function sweep(env: Env) {
  // Bound each sweep and persist pagination, so large buckets do not starve later keys.
  const checkpoint = await env.FILES.get("maintenance/sweep-cursor");
  const cursor = checkpoint ? await checkpoint.text() : undefined;
  const page = await env.FILES.list({ prefix: "uploads/", limit: 100, cursor });
  for (const object of page.objects) {
    const id = object.key.split("/")[1];
    await env.UPLOADS.getByName(id).reconcile(object.key);
  }
  if (page.truncated)
    await env.FILES.put("maintenance/sweep-cursor", page.cursor);
  else await env.FILES.delete("maintenance/sweep-cursor");
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return secured(await route(request, env));
    } catch {
      console.error(JSON.stringify({ event: "upload_request_failed" }));
      return secured(problem(500, "Request failed; retry later"));
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await sweep(env);
  },
} satisfies ExportedHandler<Env>;

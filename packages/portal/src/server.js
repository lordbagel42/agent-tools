import { createServer } from "node:http";
import { chmod } from "node:fs/promises";
import { once } from "node:events";
import httpProxy from "http-proxy";
import { PortalAuth } from "./auth.js";
import { PortalManager } from "./manager.js";
import { loginPage } from "./login.js";
import { validatePrefix } from "./config.js";

const cookieName = "__Host-raygen-portal";
const cookies = (req) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean);
const session = (req) =>
  cookies(req)
    .find((c) => c.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
function safePath(value) {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\s]/.test(value) &&
    !value.startsWith("/__portal/")
    ? value
    : "/";
}
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}
function prepare(req, record, config) {
  for (const name of Object.keys(req.headers)) {
    if (
      name.startsWith("cf-access-") ||
      name.startsWith("x-forwarded-") ||
      name === "forwarded"
    )
      delete req.headers[name];
  }
  req.headers.cookie = cookies(req)
    .filter(
      (c) =>
        !c.startsWith(cookieName + "=") && !c.startsWith("CF_Authorization="),
    )
    .join("; ");
  req.headers.host = `${record.id}.${config.domain}`;
  req.headers["x-forwarded-host"] = req.headers.host;
  req.headers["x-forwarded-proto"] = "https";
  req.headers["x-forwarded-port"] = "443";
}

export async function createService(config) {
  validatePrefix(config);
  if (
    !/^[a-z0-9.-]+$/.test(config.domain) ||
    !/^[a-z0-9.-]+$/.test(config.loginHost)
  )
    throw new Error("Invalid portal domains");
  const auth = new PortalAuth(config);
  await auth.init();
  const manager = new PortalManager(config, auth);
  const proxy = httpProxy.createProxyServer({ ws: true });
  const sockets = new Set();
  const portalSockets = new Map();
  function track(record, socket) {
    if (!portalSockets.has(record.id)) portalSockets.set(record.id, new Set());
    const active = portalSockets.get(record.id);
    if (active.has(socket)) return;
    active.add(socket);
    socket.once("close", () => {
      active.delete(socket);
      if (!active.size) portalSockets.delete(record.id);
    });
  }
  manager.on("removed", (id) => {
    for (const socket of portalSockets.get(id) ?? []) socket.destroy();
    portalSockets.delete(id);
  });
  proxy.on("proxyReqWs", (request, _req, downstream) => {
    request.once("upgrade", (_response, upstream) => {
      // http-proxy pipes clean FINs, but a forced portal revocation destroys
      // the downstream without ending its pipe. Close both halves explicitly.
      downstream.once("close", () => upstream.destroy());
      if (downstream.destroyed) upstream.destroy();
    });
  });
  proxy.on("error", (_error, _req, res) => {
    if (typeof res.writeHead === "function" && !res.headersSent)
      send(res, 502, "Preview unavailable; check its status and logs.");
    else res.destroy();
  });
  const http = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Portal request failed");
      else res.destroy();
    });
  });
  async function handle(req, res) {
    // Do not allow shared edge caches to bypass authorization, even if an app
    // explicitly marks its response public/cacheable.
    res.setHeader("cache-control", "no-store");
    const host = req.headers.host;
    const url = new URL(req.url, `https://${config.loginHost}`);
    if (host === config.loginHost) {
      if (url.pathname === "/" && req.method === "GET")
        return send(
          res,
          200,
          "Portal is ready. Ask Amp to start or expose a preview, then open its link.",
        );
      if (url.pathname !== "/login") return send(res, 404, "Not found");
      const record = manager.byHost(
        `${url.searchParams.get("portal")}.${config.domain}`,
      );
      if (!record) return send(res, 404, "Portal not found or expired");
      if (req.method === "GET")
        return loginPage(res, manager.public(record).url);
      if (req.method !== "POST") return send(res, 405, "GET or POST required");
      if (req.headers.origin !== `https://${config.loginHost}`)
        return send(res, 403, "Same-origin form submission required");
      if (
        req.headers["content-type"]?.split(";")[0] !==
        "application/x-www-form-urlencoded"
      )
        return send(res, 415, "Form data required");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return send(res, 413, "Request too large");
      }
      const version = auth.version(record.pinHash);
      const result = await auth.checkPin(
        new URLSearchParams(body).get("pin"),
        record.pinHash,
      );
      if (result.status === 429)
        return loginPage(
          res,
          manager.public(record).url,
          429,
          "Too many attempts. Try again later.",
          {
            "retry-after": String(result.retryAfter),
          },
        );
      if (result.status !== 200 || version !== auth.version(record.pinHash))
        return loginPage(
          res,
          manager.public(record).url,
          401,
          "Incorrect PIN. Try again.",
        );
      if (manager.byHost(`${record.id}.${config.domain}`) !== record)
        return send(res, 404, "Portal not found or expired");
      const target = new URL("/__portal/auth", manager.public(record).url);
      target.searchParams.set("ticket", auth.ticket(record.id, record.pinHash));
      target.searchParams.set(
        "returnTo",
        safePath(url.searchParams.get("returnTo")),
      );
      return send(res, 303, "", { location: target.href });
    }
    const record = manager.byHost(host);
    if (!record) return send(res, 404, "Portal not found or expired");
    if (url.pathname.startsWith("/__portal/")) {
      if (url.pathname !== "/__portal/auth") return send(res, 404, "Not found");
      if (
        req.method !== "GET" ||
        !auth.consume(url.searchParams.get("ticket"), record.id, record.pinHash)
      )
        return send(res, 403, "Login ticket invalid or expired");
      const token = await auth.session(record.id, record.pinHash);
      return send(res, 303, "", {
        location: safePath(url.searchParams.get("returnTo")),
        "set-cookie": `${cookieName}=${token}; Path=/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax`,
      });
    }
    const version = auth.version(record.pinHash);
    if (
      !(await auth.validSession(session(req), record.id, record.pinHash)) ||
      version !== auth.version(record.pinHash)
    ) {
      if (req.method !== "GET" && req.method !== "HEAD")
        return send(res, 401, "Portal login required");
      const target = new URL(`https://${config.loginHost}/login`);
      target.searchParams.set("portal", record.id);
      target.searchParams.set("returnTo", safePath(req.url));
      return send(res, 302, "", { location: target.href });
    }
    if (manager.byHost(host) !== record)
      return send(res, 404, "Portal expired");
    track(record, req.socket);
    prepare(req, record, config);
    proxy.web(req, res, { target: `http://127.0.0.1:${record.port}` });
  }
  proxy.on("proxyRes", (response) => {
    response.headers["cache-control"] = "no-store";
    delete response.headers["cdn-cache-control"];
    delete response.headers["cloudflare-cdn-cache-control"];
    // A preview may set its own cookies, but cannot replace the portal cookie
    // or plant a parent-domain cookie into another portal or the login host.
    if (response.headers["set-cookie"])
      response.headers["set-cookie"] = response.headers["set-cookie"]
        .filter(
          (c) =>
            !c.startsWith(cookieName + "=") &&
            !c.startsWith("CF_Authorization="),
        )
        .map((c) => c.replace(/;\s*domain=[^;]*/gi, ""));
  });
  http.on("upgrade", (req, socket, head) => {
    (async () => {
      const record = manager.byHost(req.headers.host);
      const version = record && auth.version(record.pinHash);
      if (
        !record ||
        (req.headers.origin &&
          req.headers.origin !== manager.public(record).url) ||
        !(await auth.validSession(session(req), record.id, record.pinHash)) ||
        version !== auth.version(record.pinHash)
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      if (manager.byHost(req.headers.host) !== record) {
        socket.destroy();
        return;
      }
      track(record, socket);
      prepare(req, record, config);
      proxy.ws(req, socket, head, {
        target: `http://127.0.0.1:${record.port}`,
      });
    })().catch(() => socket.destroy());
  });
  const control = createServer((req, res) => {
    (async () => {
      if (req.method !== "POST" || req.url !== "/control")
        return send(res, 404, "Not found");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) return send(res, 413, "Request too large");
      }
      const result = await manager.execute(JSON.parse(body));
      send(res, 200, JSON.stringify(result), {
        "content-type": "application/json",
      });
    })().catch((error) =>
      send(res, 400, JSON.stringify({ error: error.message }), {
        "content-type": "application/json",
      }),
    );
  });
  for (const server of [http, control]) {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
  }
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await manager.close();
    await auth.queue;
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      [http, control].map(
        (server) => new Promise((resolve) => server.close(resolve)),
      ),
    );
    proxy.close();
  };
  try {
    // Binding fails if another daemon owns the socket: never unlink it here.
    control.listen(config.socketPath);
    await once(control, "listening");
    await chmod(config.socketPath, 0o600);
    http.listen(config.port, config.bindHost);
    await once(http, "listening");
    config.port = http.address().port;
    await manager.init();
  } catch (error) {
    await close();
    throw error;
  }
  return { config, auth, manager, http, control, close };
}

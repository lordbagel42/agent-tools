import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { fixture, thread, listen, httpRequest } from "./helpers.js";

test("unauthenticated proxy fails closed, one-use login sets secure cookie, and forwarding strips portal credentials", async (t) => {
  const { service } = await fixture(t);
  const backend = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        headers: req.headers,
        path: req.url,
        method: req.method,
        body,
      }),
    );
  });
  const port = await listen(backend);
  t.after(() => backend.close());
  const portal = await service.manager.execute({
    action: "expose",
    thread,
    name: "app",
    port,
  });
  const request = (opts) =>
    httpRequest({
      port: service.http.address().port,
      host: new URL(portal.url).host,
      ...opts,
    });
  const anonymous = await request({ path: "/a?x=1" });
  assert.equal(anonymous.status, 302);
  assert.equal(new URL(anonymous.headers.location).host, "portals.example.com");
  const forged = await request({
    headers: {
      cookie: "__Host-raygen-portal=forged",
      "cf-access-jwt-assertion": "forged",
    },
  });
  assert.equal(forged.status, 302);
  const login = await service.manager.execute({
    action: "login-url",
    thread,
    name: "app",
  });
  const ticketPath = new URL(login.url).pathname + new URL(login.url).search;
  const signedIn = await request({ path: ticketPath });
  assert.equal(signedIn.status, 303);
  assert.match(
    signedIn.headers["set-cookie"][0],
    /Secure; HttpOnly; SameSite=Lax/,
  );
  assert.doesNotMatch(signedIn.headers["set-cookie"][0], /Domain=/);
  assert.equal((await request({ path: ticketPath })).status, 403);
  const cookie = signedIn.headers["set-cookie"][0].split(";")[0];
  const response = await request({
    path: "/hello?q=42",
    method: "POST",
    body: "payload",
    headers: {
      cookie: cookie + "; app=keep; CF_Authorization=secret",
      "cf-access-jwt-assertion": "secret",
      "x-forwarded-host": "evil.test",
      "x-forwarded-proto": "http",
    },
  });
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(response.body);
  assert.equal(forwarded.path, "/hello?q=42");
  assert.equal(forwarded.body, "payload");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.cookie, "app=keep");
  assert.equal(forwarded.headers["cf-access-jwt-assertion"], undefined);
  assert.equal(forwarded.headers["x-forwarded-proto"], "https");
  assert.equal(forwarded.headers.host, new URL(portal.url).host);
  assert.equal(
    (await request({ path: "/__portal/control", method: "POST", body: "{}" }))
      .status,
    404,
  );
  assert.equal(
    (
      await httpRequest({
        port: service.http.address().port,
        host: "portals.example.com",
        path: "/login?portal=" + portal.id,
        headers: { "cf-access-jwt-assertion": "forged" },
      })
    ).status,
    200,
  );
  await service.manager.execute({ action: "stop", thread, name: "app" });
  assert.equal((await request({ headers: { cookie } })).status, 404);
});

for (const action of ["stop", "set-pin"])
  test(`WebSocket auth is enforced and ${action} revokes signed-in sockets`, async (t) => {
    const { service } = await fixture(t);
    const backend = createServer();
    const wss = new WebSocketServer({ server: backend });
    wss.on("connection", (ws) =>
      ws.on("message", (data) => ws.send("echo:" + data)),
    );
    const port = await listen(backend);
    t.after(() => {
      wss.close();
      backend.close();
    });
    const portal = await service.manager.execute({
      action: "expose",
      thread,
      name: "ws",
      port,
    });
    const host = new URL(portal.url).host;
    const url = `ws://127.0.0.1:${service.http.address().port}/socket`;
    const denied = new WebSocket(url, { headers: { host } });
    await assert.rejects(once(denied, "open"), /401/);
    const token = await service.auth.session(portal.id);
    const crossSite = new WebSocket(url, {
      headers: {
        host,
        origin: "https://evil.test",
        cookie: "__Host-raygen-portal=" + token,
      },
    });
    await assert.rejects(once(crossSite, "open"), /401/);
    const ws = new WebSocket(url, {
      headers: {
        host,
        origin: portal.url,
        cookie: "__Host-raygen-portal=" + token,
      },
    });
    await once(ws, "open");
    ws.send("ping");
    const [message] = await once(ws, "message");
    assert.equal(message.toString(), "echo:ping");
    const closed = once(ws, "close");
    await service.manager.execute({
      action,
      thread,
      name: "ws",
      ...(action === "set-pin" && { pin: "012345" }),
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ws.terminate();
    }, 500);
    await closed;
    clearTimeout(timeout);
    assert.equal(
      timedOut,
      false,
      `${action} should close existing authenticated connections`,
    );
  });

for (const transport of ["http", "ws"])
  test(
    `PIN rotation denies ${transport} authentication already in flight`,
    { timeout: 10_000 },
    async (t) => {
      const { service, config } = await fixture(t);
      const backend = createServer((_req, res) => res.end("private"));
      const wss = new WebSocketServer({ server: backend });
      const port = await listen(backend);
      t.after(() => {
        wss.close();
        backend.close();
      });
      const portal = await service.manager.execute({
        action: "expose",
        thread,
        name: "race",
        port,
      });
      const cookie =
        "__Host-raygen-portal=" + (await service.auth.session(portal.id));
      const headers = { host: new URL(portal.url).host, cookie };
      let validated, resume;
      const checked = new Promise((resolve) => {
        validated = resolve;
      });
      const paused = new Promise((resolve) => {
        resume = resolve;
      });
      const validSession = service.auth.validSession.bind(service.auth);
      // Delay the real verification result to force rotation while auth is pending.
      t.mock.method(service.auth, "validSession", async (...args) => {
        const valid = await validSession(...args);
        validated();
        await paused;
        return valid;
      });
      let response;
      if (transport === "http") {
        response = httpRequest({
          port: config.port,
          host: headers.host,
          headers,
        }).then((r) => r.status);
      } else {
        const ws = new WebSocket(`ws://127.0.0.1:${config.port}/socket`, {
          headers,
        });
        t.after(() => ws.terminate());
        response = once(ws, "open").then(
          () => 101,
          (error) => {
            assert.match(error.message, /401/);
            return 401;
          },
        );
      }
      await checked;
      try {
        await service.manager.execute({
          action: "set-pin",
          thread,
          name: "race",
          pin: "012345",
        });
      } finally {
        resume();
      }
      assert.equal(await response, transport === "http" ? 302 : 401);
    },
  );

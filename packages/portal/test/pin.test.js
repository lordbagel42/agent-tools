import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import {
  fixture,
  thread,
  otherThread,
  listen,
  httpRequest,
} from "./helpers.js";
import { createService } from "../src/server.js";
import { hashPin } from "../src/auth.js";
import { createHash } from "node:crypto";

test("shared PIN and custom override authorize only their own portals without exposing credentials", async (t) => {
  const { service, dir, config } = await fixture(t);
  const backend = createServer((_req, res) => res.end("private content"));
  const port = await listen(backend);
  t.after(() => backend.close());
  await service.manager.execute({ action: "set-pin", thread, pin: "012345" });
  const input = { action: "expose", thread, name: "pin", port };
  let portal = await service.manager.execute(input);
  const request = (options = {}) =>
    httpRequest({
      port: config.port,
      host: config.loginHost,
      path: `/login?portal=${portal.id}&returnTo=%2Fhello`,
      ...options,
    });
  const submit = (pin, extra = {}) =>
    request({
      method: "POST",
      body: new URLSearchParams({ pin }).toString(),
      headers: {
        origin: `https://${config.loginHost}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      ...extra,
    });
  const page = await request();
  assert.equal(page.status, 200);
  assert.match(page.body, /type="password"/);
  assert.equal((page.body.match(/data-digit/g) ?? []).length >= 6, true);
  const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "numeric input enhancement must be included");
  const scriptHash = createHash("sha256").update(script).digest("base64");
  assert.ok(
    page.headers["content-security-policy"].includes(
      `script-src 'sha256-${scriptHash}'`,
    ),
    "only the exact login script may execute",
  );
  assert.ok(
    page.headers["content-security-policy"].includes(
      `form-action 'self' ${portal.url};`,
    ),
    "CSP must permit the post-login redirect to exactly this preview",
  );
  assert.equal((await submit("99999999")).status, 401);
  assert.equal(
    (
      await submit("012345", {
        headers: {
          origin: "https://evil.test",
          "content-type": "application/x-www-form-urlencoded",
        },
      })
    ).status,
    403,
  );
  let login = await submit("012345");
  assert.equal(login.status, 303);
  const target = new URL(login.headers.location);
  const authenticated = await httpRequest({
    port: config.port,
    host: target.host,
    path: target.pathname + target.search,
  });
  assert.equal(authenticated.status, 303);
  const cookie = authenticated.headers["set-cookie"][0].split(";")[0];
  assert.equal(
    (
      await httpRequest({
        port: config.port,
        host: target.host,
        headers: { cookie },
      })
    ).body,
    "private content",
  );
  await service.manager.execute({ action: "set-pin", thread, pin: "76543210" });
  assert.equal(
    (
      await httpRequest({
        port: config.port,
        host: target.host,
        headers: { cookie },
      })
    ).status,
    302,
    "PIN rotation revokes sessions",
  );
  assert.equal((await submit("012345")).status, 401);
  assert.equal((await submit("76543210")).status, 303);
  const original = portal;
  portal = await service.manager.execute({
    action: "set-pin",
    thread,
    name: "pin",
    pin: "87654321",
  });
  assert.equal(portal.url, original.url);
  assert.equal(portal.expires, original.expires);
  assert.equal(portal.ready, true);
  assert.equal(portal.pinMode, "custom");
  assert.equal(
    (await submit("76543210")).status,
    401,
    "shared PIN must not bypass custom PIN",
  );
  assert.equal((await submit("87654321")).status, 303);
  const redirect = await submit("87654321", {
    path: `/login?portal=${portal.id}&returnTo=${encodeURIComponent("/\t/evil.example")}`,
  });
  assert.equal(
    new URL(redirect.headers.location).searchParams.get("returnTo"),
    "/",
  );
  const direct = await service.manager.execute({
    action: "login-url",
    name: "pin",
    thread,
  });
  const directUrl = new URL(direct.url);
  const directResult = await httpRequest({
    port: config.port,
    host: directUrl.host,
    path: directUrl.pathname + directUrl.search,
  });
  assert.equal(
    directResult.status,
    303,
    "custom PIN must not break agent tickets",
  );
  assert.equal(
    (await service.manager.execute({ ...input, pin: "87654321" })).id,
    portal.id,
  );
  await assert.rejects(
    service.manager.execute({ ...input, pin: "11111111" }),
    /already exists/,
  );
  for (const action of ["status", "logs", "list"]) {
    const result = JSON.stringify(
      await service.manager.execute({ action, thread, name: "pin" }),
    );
    assert.doesNotMatch(result, /87654321|pinHash|scrypt/);
  }
  assert.doesNotMatch(
    await readFile(dir + "/portals.json", "utf8"),
    /87654321/,
  );
  assert.doesNotMatch(
    await readFile(dir + "/shared-pin.json", "utf8"),
    /76543210/,
  );
  await service.close();
  const restored = await createService(config);
  t.after(() => restored.close());
  const restoredLogin = await httpRequest({
    port: config.port,
    host: config.loginHost,
    path: `/login?portal=${portal.id}`,
    method: "POST",
    headers: {
      origin: `https://${config.loginHost}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "pin=87654321",
  });
  assert.equal(restoredLogin.status, 303);
});

test("named PIN changes revoke only the target portal credentials and reject invalid or unowned updates", async (t) => {
  const { service, dir } = await fixture(t);
  const portals = [];
  for (const name of ["target", "untouched"]) {
    const backend = createServer((_req, res) => res.end("ok"));
    const port = await listen(backend);
    t.after(() => backend.close());
    portals.push(
      await service.manager.execute({
        action: "expose",
        thread,
        name,
        port,
        pin: "23456789",
      }),
    );
  }
  const [target, untouched] = portals;
  const record = service.manager.records.get(target.id);
  const otherRecord = service.manager.records.get(untouched.id);
  const oldHash = record.pinHash;
  const oldSession = await service.auth.session(target.id, oldHash);
  const oldTicket = service.auth.ticket(target.id, oldHash);
  const otherSession = await service.auth.session(
    untouched.id,
    otherRecord.pinHash,
  );
  const otherTicket = service.auth.ticket(untouched.id, otherRecord.pinHash);
  const sharedHash = service.auth.sharedPinHash;
  const update = { action: "set-pin", thread, name: "target", pin: "34567890" };
  await assert.rejects(
    service.manager.execute({ ...update, thread: otherThread }),
    /not found/,
  );
  await assert.rejects(
    service.manager.execute({ ...update, name: "missing" }),
    /not found/,
  );
  await assert.rejects(
    service.manager.execute({ ...update, name: "" }),
    /name/,
  );
  for (const pin of [undefined, "12345", "1234567890123", "abcdef", 34567890])
    await assert.rejects(
      service.manager.execute({ ...update, pin }),
      /6–12 digits/,
    );
  assert.equal(record.pinHash, oldHash);

  const saved = await readFile(dir + "/portals.json", "utf8");
  await mkdir(dir + "/portals.json.tmp");
  await assert.rejects(service.manager.execute(update), { code: "EISDIR" });
  assert.equal(
    record.pinHash,
    oldHash,
    "a failed save must not change the live PIN",
  );
  assert.equal(
    await service.auth.validSession(oldSession, target.id, record.pinHash),
    true,
  );
  assert.equal(await readFile(dir + "/portals.json", "utf8"), saved);
  await rm(dir + "/portals.json.tmp", { recursive: true });

  const changed = await service.manager.execute(update);
  assert.equal(changed.url, target.url);
  assert.equal(changed.ready, true);
  assert.doesNotMatch(JSON.stringify(changed), /34567890|pinHash/);
  assert.doesNotMatch(
    await readFile(dir + "/portals.json", "utf8"),
    /34567890/,
  );
  assert.equal(
    (await service.auth.checkPin("23456789", record.pinHash)).status,
    401,
  );
  assert.equal(
    (await service.auth.checkPin("34567890", record.pinHash)).status,
    200,
  );
  assert.equal(
    await service.auth.validSession(oldSession, target.id, record.pinHash),
    false,
  );
  assert.equal(
    service.auth.consume(oldTicket, target.id, record.pinHash),
    false,
  );
  assert.equal(
    await service.auth.validSession(
      otherSession,
      untouched.id,
      otherRecord.pinHash,
    ),
    true,
  );
  assert.equal(
    service.auth.consume(otherTicket, untouched.id, otherRecord.pinHash),
    true,
  );
  assert.equal(service.auth.sharedPinHash, sharedHash);
});

test("PIN guessing is bounded across concurrent requests, spoofed IPs, and daemon restarts", async (t) => {
  let now = Date.now();
  const { service, config } = await fixture(t, { now: () => now });
  const backend = createServer((_req, res) => res.end("private"));
  const port = await listen(backend);
  t.after(() => backend.close());
  const portal = await service.manager.execute({
    action: "expose",
    name: "limit",
    thread,
    port,
    pin: "12345678",
  });
  const attempt = (pin = "00000000") =>
    httpRequest({
      port: config.port,
      host: config.loginHost,
      path: `/login?portal=${portal.id}`,
      method: "POST",
      body: `pin=${pin}`,
      headers: {
        origin: `https://${config.loginHost}`,
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": String(Math.random()),
      },
    });
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => attempt()),
  );
  assert.equal(responses.filter((r) => r.status === 401).length, 8);
  assert.equal(responses.filter((r) => r.status === 429).length, 2);
  assert.equal((await attempt("12345678")).status, 429);
  await service.close();
  const restored = await createService(config);
  t.after(() => restored.close());
  assert.equal((await attempt("12345678")).status, 429);
  now += 15 * 60_000 + 1;
  assert.equal((await attempt("12345678")).status, 303);
});

test("rotating among custom portals cannot bypass the global guessing limit", async (t) => {
  const { service } = await fixture(t);
  const hashes = await Promise.all(
    Array.from({ length: 9 }, () => hashPin("12345678")),
  );
  for (let n = 0; n < 60; n++)
    assert.equal(
      (await service.auth.checkPin("invalid", hashes[Math.floor(n / 8)]))
        .status,
      401,
    );
  assert.equal(
    (await service.auth.checkPin("12345678", hashes[8])).status,
    429,
  );
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  buildNativePairingApp,
  type NativePairingClient,
  type PairingStatus,
} from "../src/native-pairing.js";

const portalHeaders = {
  host: "pair.example",
  origin: "https://pair.example",
  "content-type": "application/json",
};
const requiredCookies = () => ({
  SID: "synthetic-sid",
  HSID: "synthetic-hsid",
  SSID: "synthetic-ssid",
  OSID: "synthetic-osid",
  APISID: "synthetic-apisid",
  SAPISID: "synthetic-sapisid",
});

function fixture(
  t: TestContext,
  initialStatus: PairingStatus = { state: "needs_login" },
  begin?: (cookies: Record<string, string>) => Promise<void>,
  options?: { helperArchivePath?: string; now?: () => number },
) {
  let status = initialStatus;
  const received: Record<string, string>[] = [];
  const client: NativePairingClient = {
    pairingStatus: () => status,
    beginPairing: async (cookies) => {
      received.push(cookies);
      if (begin) await begin(cookies);
      status = { state: "connecting" };
    },
  };
  const app = buildNativePairingApp(
    client,
    "https://pair.example/setup",
    options,
  );
  t.after(() => app.close());
  return {
    app,
    client,
    received,
    setStatus(next: PairingStatus) {
      status = next;
    },
  };
}

async function start(
  app: ReturnType<typeof buildNativePairingApp>,
  headers: Record<string, string> = portalHeaders,
) {
  return app.inject({
    method: "POST",
    url: "/connect/start",
    headers,
    payload: {},
  });
}

async function complete(
  app: ReturnType<typeof buildNativePairingApp>,
  token: string,
  cookies: unknown = requiredCookies(),
) {
  return app.inject({
    method: "POST",
    url: "/connect/complete",
    headers: { ...portalHeaders, "x-setup-token": token },
    payload: { cookies },
  });
}

test("every setup POST requires an exact same-origin request with JSON", async (t) => {
  const { app } = fixture(t);
  for (const headers of [
    { host: "pair.example", "content-type": "application/json" },
    {
      host: "pair.example",
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    {
      host: "pair.example",
      origin: "null",
      "content-type": "application/json",
    },
    {
      host: "pair.example",
      origin: "http://pair.example",
      "content-type": "application/json",
    },
    {
      host: "pair.example",
      origin: "https://pair.example:444",
      "content-type": "application/json",
    },
    {
      host: "evil.example",
      origin: "https://pair.example",
      "content-type": "application/json",
    },
    {
      ...portalHeaders,
      "sec-fetch-site": "cross-site",
    },
  ]) {
    const response = await start(app, headers);
    assert.equal(response.statusCode, 403, JSON.stringify(headers));
  }

  for (const contentType of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/json-patch+json",
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/connect/start",
      headers: { ...portalHeaders, "content-type": contentType },
      payload: "{}",
    });
    assert.equal(response.statusCode, 415, contentType);
  }

  const malformed = await app.inject({
    method: "POST",
    url: "/connect/start",
    headers: portalHeaders,
    payload: '{"private-cookie":',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.includes("private-cookie"), false);

  for (const payload of [null, [], { unexpected: true }]) {
    const response = await app.inject({
      method: "POST",
      url: "/connect/start",
      headers: portalHeaders,
      payload: JSON.stringify(payload),
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((await start(app)).statusCode, 200);

  const localClient: NativePairingClient = {
    pairingStatus: () => ({ state: "needs_login" }),
    beginPairing: async () => undefined,
  };
  const local = buildNativePairingApp(localClient);
  t.after(() => local.close());
  const insecureLocal = (
    await local.inject({
      method: "POST",
      url: "/connect/start",
      headers: {
        host: "localhost",
        origin: "http://localhost",
        "content-type": "application/json",
      },
      payload: {},
    })
  ).statusCode;
  assert.equal(insecureLocal, 403);
});

test("setup capabilities expire, are single-use, and survive invalid cookie input", async (t) => {
  let now = 1_000_000;
  const first = fixture(t, { state: "needs_login" }, undefined, {
    now: () => now,
  });
  const lease = await start(first.app);
  assert.equal(lease.statusCode, 200, lease.body);
  assert.match(lease.json().token, /^[a-f0-9]{64}$/);
  assert.equal(lease.json().expiresAt, 1_900_000);

  const withoutOrigin = await first.app.inject({
    method: "POST",
    url: "/connect/complete",
    headers: {
      host: "pair.example",
      "content-type": "application/json",
      "x-setup-token": lease.json().token,
    },
    payload: { cookies: requiredCookies() },
  });
  assert.equal(withoutOrigin.statusCode, 403);
  const wrongMediaType = await first.app.inject({
    method: "POST",
    url: "/connect/complete",
    headers: {
      ...portalHeaders,
      "content-type": "text/plain",
      "x-setup-token": lease.json().token,
    },
    payload: JSON.stringify({ cookies: requiredCookies() }),
  });
  assert.equal(wrongMediaType.statusCode, 415);
  assert.equal(
    (
      await first.app.inject({
        method: "POST",
        url: "/connect/complete",
        headers: portalHeaders,
        payload: { cookies: requiredCookies() },
      })
    ).statusCode,
    401,
  );
  assert.equal((await complete(first.app, "0".repeat(64))).statusCode, 401);

  for (const payload of [
    {},
    { cookies: requiredCookies(), extra: true },
    { cookies: { ...requiredCookies(), unknown: "must-not-pass" } },
  ]) {
    const malformed = await first.app.inject({
      method: "POST",
      url: "/connect/complete",
      headers: { ...portalHeaders, "x-setup-token": lease.json().token },
      payload,
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
  }
  assert.equal(first.received.length, 0);

  const accepted = await complete(first.app, lease.json().token);
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.deepEqual(first.received, [requiredCookies()]);
  assert.equal((await complete(first.app, lease.json().token)).statusCode, 401);

  const expiring = fixture(t, { state: "needs_login" }, undefined, {
    now: () => now,
  });
  const expiringLease = await start(expiring.app);
  now = expiringLease.json().expiresAt;
  assert.equal(
    (await complete(expiring.app, expiringLease.json().token)).statusCode,
    401,
  );
  assert.equal(expiring.received.length, 0);
  const replacement = await start(expiring.app);
  assert.equal(replacement.statusCode, 200);
  assert.notEqual(replacement.json().token, expiringLease.json().token);
});

test("concurrent handoffs consume one capability before awaiting the backend", async (t) => {
  let enterPairing: (() => void) | undefined;
  let finishPairing: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enterPairing = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishPairing = resolve;
  });
  const { app, received } = fixture(t, { state: "needs_login" }, async () => {
    enterPairing?.();
    await finish;
  });
  const lease = await start(app);
  const first = complete(app, lease.json().token);
  await entered;

  assert.equal((await complete(app, lease.json().token)).statusCode, 401);
  assert.equal((await start(app)).statusCode, 409);
  assert.equal(received.length, 1);

  finishPairing?.();
  const accepted = await first;
  assert.equal(accepted.statusCode, 202, accepted.body);
});

test("multiple capability requests can authorize at most one handoff", async (t) => {
  const { app, received } = fixture(t);
  const first = await start(app);
  const second = await start(app);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);

  const results = await Promise.all([
    complete(app, first.json().token),
    complete(app, second.json().token),
  ]);
  assert.deepEqual(
    results.map((response) => response.statusCode).sort(),
    [202, 401],
  );
  assert.equal(received.length, 1);
});

test("an active or paired backend blocks new and previously issued handoffs", async (t) => {
  for (const status of [
    { state: "connecting" },
    { state: "awaiting_phone", emoji: "🌲 🥔" },
    { state: "paired" },
  ] satisfies PairingStatus[]) {
    const blocked = fixture(t, status);
    assert.equal((await start(blocked.app)).statusCode, 409, status.state);
    assert.equal(blocked.received.length, 0);
  }

  const pending = fixture(t);
  const lease = await start(pending.app);
  pending.setStatus({ state: "awaiting_phone", emoji: "🌲 🥔" });
  assert.equal(
    (await complete(pending.app, lease.json().token)).statusCode,
    409,
  );
  assert.equal(pending.received.length, 0);
  pending.setStatus({ state: "needs_login" });
  assert.equal(
    (await complete(pending.app, lease.json().token)).statusCode,
    401,
  );
});

test("status responses whitelist fields and redact backend failures", async (t) => {
  const { app, client, setStatus } = fixture(t);
  setStatus({
    state: "awaiting_phone",
    emoji: "🌲 🥔",
    error: "must-not-appear",
    cookies: { SID: "private" },
    token: "private-token",
  } as PairingStatus & Record<string, unknown>);
  const awaiting = await app.inject({
    url: "/status",
    headers: { host: "pair.example" },
  });
  assert.deepEqual(awaiting.json(), {
    state: "awaiting_phone",
    emoji: "🌲 🥔",
  });

  setStatus({
    state: "error",
    error: "SID=private-cookie at /private/server/path",
    diagnostic: { responseBody: "PRIVATE" },
  } as PairingStatus & Record<string, unknown>);
  const failed = await app.inject({
    url: "/status",
    headers: { host: "pair.example" },
  });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().state, "error");
  assert.equal(typeof failed.json().error, "string");
  assert.equal(failed.body.includes("private"), false);
  assert.deepEqual(Object.keys(failed.json()).sort(), ["error", "state"]);

  client.pairingStatus = () => {
    throw new Error("SAPISID=private and https://private.example");
  };
  const unavailable = await app.inject({
    url: "/status",
    headers: { host: "pair.example" },
  });
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.json().state, "error");
  assert.equal(unavailable.body.includes("private"), false);
});

test("backend rejection consumes the capability and exposes only a retryable sanitized error", async (t) => {
  const { app, received } = fixture(t, { state: "needs_login" }, async () => {
    throw new Error(
      "SID=private-cookie; response body PRIVATE at /private/server/path",
    );
  });
  const lease = await start(app);
  const rejected = await complete(app, lease.json().token);
  assert.equal(rejected.statusCode, 503);
  assert.equal(rejected.body.includes("private"), false);
  assert.equal(received.length, 1);
  assert.equal((await complete(app, lease.json().token)).statusCode, 401);

  const status = await app.inject({
    url: "/status",
    headers: { host: "pair.example" },
  });
  assert.equal(status.json().state, "error");
  assert.equal(status.body.includes("private"), false);
  assert.equal((await start(app)).statusCode, 200);
});

test("the pairing listener serves only setup assets and a fixed helper archive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gm-native-helper-"));
  const archivePath = join(directory, "fixture.zip");
  const archive = Buffer.from("PK synthetic credential-free helper fixture");
  await writeFile(archivePath, archive);
  t.after(() => rm(directory, { recursive: true }));
  const { app } = fixture(t, { state: "needs_login" }, undefined, {
    helperArchivePath: archivePath,
  });

  const helper = await app.inject({
    url: "/helper.zip?path=/private/other.zip",
    headers: { host: "pair.example" },
  });
  assert.equal(helper.statusCode, 200, helper.body);
  assert.deepEqual(helper.rawPayload, archive);
  assert.match(String(helper.headers["content-type"]), /application\/zip/);
  assert.equal(
    helper.headers["content-disposition"],
    'attachment; filename="messages-login-helper.zip"',
  );

  for (const url of [
    "/v1/conversations",
    "/v1/messages",
    "/messages",
    "/token",
    "/cookies",
    "/screenshot",
    "/eval",
    "/login/frame",
  ]) {
    assert.equal(
      (
        await app.inject({
          url,
          headers: { host: "pair.example" },
        })
      ).statusCode,
      404,
      url,
    );
  }
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: portalHeaders,
        payload: { text: "must-not-send" },
      })
    ).statusCode,
    404,
  );

  const html = await app.inject({
    url: "/",
    headers: { host: "pair.example" },
  });
  assert.equal(html.statusCode, 200);
  assert.equal(html.body.includes("synthetic-sid"), false);
  assert.equal(html.headers["cache-control"], "no-store");
  assert.match(
    String(html.headers["content-security-policy"]),
    /frame-ancestors 'none'/,
  );

  const absent = fixture(t);
  assert.equal(
    (
      await absent.app.inject({
        url: "/helper.zip",
        headers: { host: "pair.example" },
      })
    ).statusCode,
    404,
  );
  const broken = fixture(t, { state: "needs_login" }, undefined, {
    helperArchivePath: "/private/SID=secret/helper.zip",
  });
  const missing = await broken.app.inject({
    url: "/helper.zip",
    headers: { host: "pair.example" },
  });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.includes("SID=secret"), false);
});

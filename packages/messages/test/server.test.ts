import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { buildPairingApp } from "../src/pairing.js";
import { SendLedger } from "../src/send-ledger.js";
import { buildApi } from "../src/server.js";
import { browserFixture, type FixtureMode } from "./fixture.js";

const token = "a-private-test-token-with-at-least-32-characters";
const authorization = `Bearer ${token}`;
async function fixture(t: TestContext, mode: FixtureMode = "paired") {
  const browser = await browserFixture(mode);
  const directory = await mkdtemp(join(tmpdir(), "gm-http-"));
  const api = buildApi({
    client: browser.client,
    ledger: new SendLedger(directory),
    token,
  });
  t.after(async () => {
    await api.close();
    await browser.close();
    await rm(directory, { recursive: true });
  });
  return { ...browser, api };
}

test("API protects every data route, rejects browser origins and hostile Host headers", async (t) => {
  const { api } = await fixture(t);
  assert.equal((await api.inject("/health")).statusCode, 200);
  for (const url of [
    "/v1/status",
    "/v1/pairing/qr",
    "/v1/conversations",
    "/v1/conversations/384/messages",
  ]) {
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      assert.equal((await api.inject({ url, headers })).statusCode, 401, url);
    }
  }
  assert.equal(
    (
      await api.inject({
        url: "/v1/messages",
        method: "POST",
        payload: { text: "blocked" },
      })
    ).statusCode,
    401,
  );
  for (const headers of [
    { authorization, origin: "https://evil.example" },
    { authorization, host: "evil.example" },
    { authorization, "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      (await api.inject({ url: "/v1/status", headers })).statusCode,
      403,
    );
  const response = await api.inject({
    url: "/v1/status",
    headers: { authorization },
  });
  assert.deepEqual(response.json(), { state: "paired", transport: "browser" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});

test("HTTP list and read routes return actual extracted data and enforce query bounds", async (t) => {
  const { api } = await fixture(t);
  const list = await api.inject({
    url: "/v1/conversations?limit=1",
    headers: { authorization },
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().conversations.map((item: { id: string }) => item.id),
    ["384"],
  );
  const read = await api.inject({
    url: "/v1/conversations/384/messages?limit=1",
    headers: { authorization },
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().messages[0].text, "hello");
  for (const query of ["0", "201", "1.5", "NaN", "1&limit=2", "", "1e2"]) {
    assert.equal(
      (
        await api.inject({
          url: `/v1/conversations?limit=${query}`,
          headers: { authorization },
        })
      ).statusCode,
      400,
    );
  }
  assert.equal(
    (
      await api.inject({
        url: "/v1/conversations/new/messages",
        headers: { authorization },
      })
    ).statusCode,
    400,
  );
});

test("POST sends exactly once through Chromium and replays the same receipt", async (t) => {
  const { api, sent } = await fixture(t);
  const options = {
    url: "/v1/messages",
    method: "POST" as const,
    headers: { authorization, "idempotency-key": "integration-send-01" },
    payload: { conversationId: "901", text: "HTTP test\n🥔 & <not html>" },
  };
  const response = await api.inject(options);
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().status, "submitted");
  const replay = await api.inject(options);
  assert.deepEqual(replay.json(), response.json());
  assert.deepEqual(sent, [
    { conversationId: "901", text: "HTTP test\n🥔 & <not html>" },
  ]);
  const conflict = await api.inject({
    ...options,
    payload: { ...options.payload, text: "different" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
});

test("send validation rejects ambiguous requests without attempting a send", async (t) => {
  const { api, sent } = await fixture(t);
  const good = { conversationId: "384", text: "hello" };
  for (const payload of [
    {},
    { ...good, text: " \n " },
    { ...good, text: "x".repeat(10001) },
    { ...good, conversationId: "../logout" },
    { ...good, phone: "+12025550199" },
    { ...good, text: 123 },
    [good],
  ]) {
    const response = await api.inject({
      url: "/v1/messages",
      method: "POST",
      headers: { authorization, "idempotency-key": "invalid-body-test" },
      payload,
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  for (const key of [undefined, "tiny", "invalid key contains spaces"]) {
    const response = await api.inject({
      url: "/v1/messages",
      method: "POST",
      headers: { authorization, ...(key ? { "idempotency-key": key } : {}) },
      payload: good,
    });
    assert.equal(response.statusCode, 400);
  }
  assert.deepEqual(sent, []);
});

test("malformed JSON and upstream errors never echo message contents or browser diagnostics", async (t) => {
  const { api, client } = await fixture(t);
  const malformed = await api.inject({
    url: "/v1/messages",
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    payload: '{"secret-message": private-content',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.includes("private-content"), false);
  client.status = async () => {
    throw new Error(
      "SID=private-cookie; secret-message at https://private.example",
    );
  };
  const response = await api.inject({
    url: "/v1/status",
    headers: { authorization },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes("private"), false);
});

test("the pairing listener exposes QR/status but no messages, browser control or API token", async (t) => {
  const { client } = await fixture(t, "qr");
  const app = buildPairingApp(client, "https://pair.example");
  t.after(() => app.close());
  const image = await app.inject({
    url: "/qr",
    headers: { host: "pair.example" },
  });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  for (const url of [
    "/v1/conversations",
    "/v1/messages",
    "/token",
    "/screenshot",
    "/eval",
  ]) {
    assert.equal((await app.inject(url)).statusCode, 404);
  }
  assert.equal(
    (await app.inject({ url: "/qr", headers: { host: "other.example" } }))
      .statusCode,
    403,
  );
  const html = await app.inject("/");
  assert.equal(html.statusCode, 200);
  assert.equal(html.body.includes(token), false);
  assert.match(
    String(html.headers["content-security-policy"]),
    /frame-ancestors 'none'/,
  );
  assert.equal(html.headers["cache-control"], "no-store");
});

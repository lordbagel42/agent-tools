import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPairingApp } from "../src/pairing.js";
import { loginFixture } from "./login-fixture.js";

test("interactive login is opt-in and requires same-origin JSON before creating a control session", async (t) => {
  const fixture = await loginFixture();
  const disabled = buildPairingApp(fixture.client);
  const app = buildPairingApp(
    fixture.client,
    "https://pair.example",
    fixture.login,
  );
  t.after(async () => {
    await app.close();
    await disabled.close();
    await fixture.close();
  });
  assert.equal((await disabled.inject("/login/frame")).statusCode, 404);
  assert.equal(
    (
      await disabled.inject({
        method: "POST",
        url: "/login/start",
        payload: {},
      })
    ).statusCode,
    404,
  );
  for (const headers of [
    { host: "pair.example" },
    { host: "pair.example", origin: "https://evil.example" },
    { host: "pair.example", origin: "null" },
    { host: "pair.example", origin: "http://pair.example" },
    { host: "pair.example", origin: "https://pair.example:444" },
    { host: "evil.example", origin: "https://pair.example" },
    {
      host: "pair.example",
      origin: "https://pair.example",
      "sec-fetch-site": "cross-site",
    },
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/login/start",
          payload: {},
          headers,
        })
      ).statusCode,
      403,
    );
  }
  const headers = { host: "pair.example", origin: "https://pair.example" };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/login/start",
        payload: "{}",
        headers: { ...headers, "content-type": "text/plain" },
      })
    ).statusCode,
    415,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/login/start",
        payload: { url: "https://outside.invalid" },
        headers,
      })
    ).statusCode,
    400,
  );
  const start = await app.inject({
    method: "POST",
    url: "/login/start",
    payload: {},
    headers,
  });
  assert.equal(start.statusCode, 200, start.body);
  assert.match(start.json().token, /^[a-f0-9]{64}$/);
  const html = await app.inject("/");
  assert.equal(html.body.includes(start.json().token), false);
});

test("login frames and inputs require the lease, redact errors, and stop without exposing messaging routes", async (t) => {
  const fixture = await loginFixture();
  const app = buildPairingApp(
    fixture.client,
    "https://pair.example",
    fixture.login,
  );
  t.after(async () => {
    await app.close();
    await fixture.close();
  });
  const headers = { host: "pair.example", origin: "https://pair.example" };
  const start = await app.inject({
    method: "POST",
    url: "/login/start",
    payload: {},
    headers,
  });
  assert.equal(start.statusCode, 200, start.body);
  for (const token of ["", "wrong", "é".repeat(64)]) {
    assert.equal(
      (
        await app.inject({
          url: "/login/frame",
          headers: { ...headers, "x-login-token": token },
        })
      ).statusCode,
      401,
    );
  }
  const auth = { ...headers, "x-login-token": start.json().token };
  const frame = await app.inject({ url: "/login/frame", headers: auth });
  assert.equal(frame.statusCode, 200, frame.body.slice(0, 80));
  assert.equal(frame.headers["content-type"], "image/png");
  assert.equal(frame.headers["cache-control"], "no-store");
  assert.equal(frame.headers["x-login-origin"], "https://accounts.google.com");
  await fixture.page.locator("#email").focus();
  const version = Number(frame.headers["x-login-version"]);
  const typed = await app.inject({
    method: "POST",
    url: "/login/input",
    headers: auth,
    payload: { type: "text", version, text: "owned@example.test" },
  });
  assert.equal(typed.statusCode, 204, typed.body);
  assert.equal(
    await fixture.page.locator("#email").inputValue(),
    "owned@example.test",
  );
  const malformed = await app.inject({
    method: "POST",
    url: "/login/input",
    headers: { ...auth, "content-type": "application/json" },
    payload: '{"text":PRIVATE_PASSWORD',
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.includes("PRIVATE_PASSWORD"), false);
  for (const url of [
    "/v1/conversations",
    "/v1/messages",
    "/token",
    "/eval",
    "/screenshot",
  ])
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/login/stop",
        headers: auth,
        payload: {},
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (await app.inject({ url: "/login/frame", headers: auth })).statusCode,
    401,
  );
});

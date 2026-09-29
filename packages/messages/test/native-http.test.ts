import assert from "node:assert/strict";
import test from "node:test";
import { type Fetch, GoogleHttp } from "../src/native/http.js";

const publicKey = `AIza${"x".repeat(35)}`;
const welcome = `"A16fYe",[null,null,"${publicKey}"]`;
const device = "01234567-89ab-4cde-8fab-0123456789ab";
const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json+protobuf", ...headers },
  });

test("Google bootstrap signs only fixed authenticated origins and persists cookie rotation", async () => {
  const urls: string[] = [];
  let saved = 0;
  const cookies = { SAPISID: "test-sapisid", SID: "test-sid" };
  const transport: Fetch = async (url, init) => {
    urls.push(url);
    const headers = new Headers(init.headers);
    assert.equal(init.redirect, "error");
    if (url.endsWith("/web/welcome")) {
      assert.equal(headers.has("cookie"), false);
      return new Response(welcome);
    }
    assert.equal(
      headers.get("authorization"),
      "SAPISIDHASH 1700000000_93fa9e90e686ee80b1a24c37926cb5de15f9ba2b",
    );
    if (url.endsWith("/web/config")) {
      assert.equal(headers.get("cookie"), "SAPISID=test-sapisid; SID=test-sid");
      return json(
        [
          "20260924",
          null,
          null,
          null,
          [null, "private@example.test", "0", device],
        ],
        { "set-cookie": "SID=rotated; Secure; HttpOnly; Path=/" },
      );
    }
    assert.equal(saved, 1);
    assert.equal(headers.get("cookie"), "SAPISID=test-sapisid; SID=rotated");
    assert.equal(headers.get("x-goog-api-key"), publicKey);
    assert.deepEqual(JSON.parse(String(init.body)), [["request"]]);
    return json([null, ["token", "7200000000"]]);
  };
  const http = new GoogleHttp(
    cookies,
    async () => {
      saved++;
    },
    transport,
    () => 1_700_000_000_000,
  );
  assert.deepEqual(await http.prepare(), {
    deviceId: device,
    version: [null, null, 2026, 9, 24, null, 4, null, 6],
  });
  assert.deepEqual(await http.rpc("RegisterRefresh", [["request"]]), [
    null,
    ["token", "7200000000"],
  ]);
  assert.deepEqual(urls, [
    "https://messages.google.com/web/welcome",
    "https://messages.google.com/web/config",
    "https://instantmessaging-pa.clients6.google.com/$rpc/google.internal.communications.instantmessaging.v1.Registration/RegisterRefresh",
  ]);
});

test("relay errors are redacted and a failed POST is never automatically repeated", async () => {
  let posts = 0;
  const transport: Fetch = async (url) => {
    if (url.endsWith("/web/welcome")) return new Response(welcome);
    if (url.endsWith("/web/config"))
      return json(["20260924", null, null, null, [null, null, null, device]]);
    posts++;
    return new Response("sensitive-upstream-body", { status: 503 });
  };
  const http = new GoogleHttp({ SAPISID: "test" }, async () => {}, transport);
  await http.prepare();
  await assert.rejects(
    http.rpc("SendMessage", []),
    (error: Error) => !error.message.includes("sensitive"),
  );
  assert.equal(posts, 1);
});

test("missing account identity and cross-origin redirects cannot become paired sessions", async () => {
  const anonymous = new GoogleHttp(
    {},
    async () => {},
    async (url) =>
      url.endsWith("welcome") ? new Response(welcome) : json(["20260924"]),
  );
  await assert.rejects(anonymous.prepare(), { code: "GOOGLE_LOGIN_REQUIRED" });
  const redirect = new GoogleHttp(
    {},
    async () => {},
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.test/" },
      }),
  );
  await assert.rejects(redirect.prepare());
});

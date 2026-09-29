import assert from "node:assert/strict";
import test from "node:test";
import {
  type GoogleCookieLike,
  selectGoogleCredentials,
} from "../src/cookies.js";

function completeCookieSet(): GoogleCookieLike[] {
  return [
    { name: "SID", value: "sid-value", domain: ".google.com", path: "/" },
    {
      name: "HSID",
      value: "hsid-value",
      domain: ".google.com",
      path: "/",
    },
    {
      name: "SSID",
      value: "ssid-value",
      domain: ".google.com",
      path: "/",
    },
    {
      name: "OSID",
      value: "osid-value",
      domain: "messages.google.com",
      path: "/",
    },
    {
      name: "APISID",
      value: "apisid-value",
      domain: ".google.com",
      path: "/",
    },
    {
      name: "SAPISID",
      value: "sapisid-value",
      domain: ".google.com",
      path: "/",
    },
    {
      name: "__Secure-1PSIDTS",
      value: "timestamp-value",
      domain: ".google.com",
      path: "/",
    },
  ];
}

test("selects exactly the required Google credentials and optional timestamp", () => {
  const cookies = completeCookieSet();
  cookies.push(
    {
      name: "SIDCC",
      value: "must-not-leak",
      domain: ".google.com",
      path: "/",
    },
    {
      name: "__Secure-3PSID",
      value: "must-not-leak",
      domain: ".google.com",
      path: "/",
    },
  );

  assert.deepEqual(selectGoogleCredentials(cookies), {
    SID: "sid-value",
    HSID: "hsid-value",
    SSID: "ssid-value",
    OSID: "osid-value",
    APISID: "apisid-value",
    SAPISID: "sapisid-value",
    "__Secure-1PSIDTS": "timestamp-value",
  });
});

test("accepts OSID from the parent Google domain", () => {
  const cookies = completeCookieSet().map((cookie) =>
    cookie.name === "OSID" ? { ...cookie, domain: ".google.com" } : cookie,
  );

  assert.equal(selectGoogleCredentials(cookies).OSID, "osid-value");
});

test("does not require the optional timestamp cookie", () => {
  const cookies = completeCookieSet().filter(
    ({ name }) => name !== "__Secure-1PSIDTS",
  );

  assert.deepEqual(Object.keys(selectGoogleCredentials(cookies)), [
    "SID",
    "HSID",
    "SSID",
    "OSID",
    "APISID",
    "SAPISID",
  ]);
});

test("rejects a missing required credential without exposing cookie values", () => {
  for (const requiredName of [
    "SID",
    "HSID",
    "SSID",
    "OSID",
    "APISID",
    "SAPISID",
  ]) {
    const cookies = completeCookieSet().filter(
      ({ name }) => name !== requiredName,
    );
    assert.throws(
      () => selectGoogleCredentials(cookies),
      new RegExp(`Missing required Google cookie ${requiredName}`),
    );
  }
});

test("rejects conflicting candidate values rather than merging sessions", () => {
  const cookies = completeCookieSet();
  cookies.push({
    name: "OSID",
    value: "another-account-value",
    domain: ".google.com",
    path: "/",
  });

  assert.throws(
    () => selectGoogleCredentials(cookies),
    /Conflicting Google cookie OSID/,
  );
});

test("uses only cookies scoped to the least Google domains and config path", () => {
  const cookies = completeCookieSet().filter(({ name }) => name !== "SID");
  cookies.push(
    {
      name: "SID",
      value: "host-cookie",
      domain: "messages.google.com",
      path: "/",
    },
    {
      name: "SID",
      value: "account-cookie",
      domain: "accounts.google.com",
      path: "/",
    },
    {
      name: "SID",
      value: "lookalike-cookie",
      domain: "evilgoogle.com",
      path: "/",
    },
    {
      name: "SID",
      value: "wrong-path-cookie",
      domain: ".google.com",
      path: "/mail",
    },
  );

  assert.throws(
    () => selectGoogleCredentials(cookies),
    /Missing required Google cookie SID/,
  );
});

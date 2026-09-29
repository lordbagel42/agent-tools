import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGoogleCookies } from "../src/google-cookies.js";
import { ApiError } from "../src/types.js";

const requiredCookies = () => ({
  SID: "synthetic-sid",
  HSID: "synthetic-hsid",
  SSID: "synthetic-ssid",
  OSID: "synthetic-osid",
  APISID: "synthetic-apisid",
  SAPISID: "synthetic-sapisid",
});

const invalidCookies = (input: unknown) => {
  assert.throws(
    () => validateGoogleCookies(input),
    (error: unknown) =>
      error instanceof ApiError &&
      error.statusCode === 400 &&
      error.code === "INVALID_REQUEST",
  );
};

test("Google cookie validation returns a new record containing only the supported exact keys", () => {
  const input = {
    ...requiredCookies(),
    "__Secure-1PSIDTS": "synthetic-refresh-cookie",
  };

  const result = validateGoogleCookies(input);

  assert.notEqual(result, input);
  assert.deepEqual(result, input);
  input.SID = "changed-after-validation";
  assert.equal(result.SID, "synthetic-sid");
});

test("Google cookie validation rejects missing, unknown, non-string, and non-record input", () => {
  const required = requiredCookies();
  for (const key of Object.keys(required)) {
    const missing = { ...required } as Record<string, unknown>;
    delete missing[key];
    invalidCookies(missing);
  }
  for (const input of [
    null,
    undefined,
    [],
    "cookies",
    { ...required, SID: 123 },
    { ...required, unknown: "synthetic" },
    { ...required, "__secure-1PSIDTS": "wrong-case" },
  ])
    invalidCookies(input);
});

test("Google cookie validation rejects oversized and unsafe cookie values without echoing them", () => {
  for (const value of [
    "",
    "x".repeat(4097),
    "private;injected=value",
    "private\rvalue",
    "private\nvalue",
    "private\0value",
    "private\u007fvalue",
    "private\u0085value",
  ]) {
    const input = { ...requiredCookies(), SID: value };
    assert.throws(
      () => validateGoogleCookies(input),
      (error: unknown) =>
        error instanceof ApiError &&
        error.statusCode === 400 &&
        (value.length === 0 || !error.message.includes(value)),
    );
  }
  const boundary = "x".repeat(4096);
  assert.equal(
    validateGoogleCookies({ ...requiredCookies(), SID: boundary }).SID,
    boundary,
  );
});

test("Google cookie validation rejects inherited, accessor, symbol, and exotic records", () => {
  invalidCookies(
    Object.assign(Object.create({ SID: "inherited" }), requiredCookies()),
  );
  invalidCookies(Object.assign(Object.create(null), requiredCookies()));

  let reads = 0;
  const accessor = { ...requiredCookies() };
  Object.defineProperty(accessor, "SID", {
    enumerable: true,
    get() {
      reads++;
      return "must-not-be-read";
    },
  });
  invalidCookies(accessor);
  assert.equal(reads, 0);

  const symbol = { ...requiredCookies() } as Record<PropertyKey, unknown>;
  symbol[Symbol("hidden")] = "synthetic";
  invalidCookies(symbol);
});

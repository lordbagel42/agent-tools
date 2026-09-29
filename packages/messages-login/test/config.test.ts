import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_LOGIN_URL,
  isMessagesConfigUrl,
  parseLaunchArguments,
  parseServerOrigin,
} from "../src/config.js";

test("parseLaunchArguments requires exactly one server argument", () => {
  assert.equal(
    parseLaunchArguments(
      ["/usr/bin/electron", "/helper", "https://pairing.example.test"],
      false,
    ),
    "https://pairing.example.test",
  );
  assert.equal(
    parseLaunchArguments(
      ["/opt/Messages Helper", "https://pairing.example.test"],
      true,
    ),
    "https://pairing.example.test",
  );

  for (const argv of [
    ["/usr/bin/electron", "/helper"],
    [
      "/usr/bin/electron",
      "/helper",
      "https://pairing.example.test",
      "https://other.example.test",
    ],
  ]) {
    assert.throws(() => parseLaunchArguments(argv, false), /exactly one/);
  }
});

test("parseServerOrigin accepts only a root HTTPS origin", () => {
  assert.equal(
    parseServerOrigin("https://pairing.example.test"),
    "https://pairing.example.test",
  );
  assert.equal(
    parseServerOrigin("https://pairing.example.test:8443/"),
    "https://pairing.example.test:8443",
  );
});

test("parseServerOrigin rejects non-HTTPS and malformed values", () => {
  for (const value of [
    undefined,
    "",
    "http://pairing.example.test",
    "pairing.example.test",
    " https://pairing.example.test",
    "https://pairing.example.test ",
  ]) {
    assert.throws(() => parseServerOrigin(value), /HTTPS origin/);
  }
});

test("parseServerOrigin rejects paths, queries, fragments, and userinfo", () => {
  for (const value of [
    "https://pairing.example.test/connect",
    "https://pairing.example.test?mode=setup",
    "https://pairing.example.test/#setup",
    "https://owner@pairing.example.test",
    "https://owner:secret@pairing.example.test",
  ]) {
    assert.throws(() => parseServerOrigin(value), /bare HTTPS origin/);
  }
});

test("isMessagesConfigUrl recognizes only the fixed Messages config page", () => {
  assert.equal(
    isMessagesConfigUrl("https://messages.google.com/web/config"),
    true,
  );
  for (const value of [
    "http://messages.google.com/web/config",
    "https://messages.google.com/web/config/",
    "https://messages.google.com/web/config?account=1",
    "https://messages.google.com/web/config#done",
    "https://accounts.google.com/web/config",
    "not a URL",
  ]) {
    assert.equal(isMessagesConfigUrl(value), false);
  }
});

test("Google login starts at AccountChooser with the fixed config continuation", () => {
  const loginUrl = new URL(GOOGLE_LOGIN_URL);
  assert.equal(loginUrl.origin, "https://accounts.google.com");
  assert.equal(loginUrl.pathname, "/AccountChooser");
  assert.equal(
    loginUrl.searchParams.get("continue"),
    "https://messages.google.com/web/config",
  );
  assert.equal(loginUrl.searchParams.size, 1);
});

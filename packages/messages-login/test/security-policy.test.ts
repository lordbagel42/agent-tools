import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConsentCopy,
  ephemeralPartition,
} from "../src/security-policy.js";

test("native consent names the destination and discloses broad server-side credentials", () => {
  const origin = "https://pairing.example.test";
  const copy = buildConsentCopy(origin);
  const visibleText = [copy.title, copy.message, copy.detail].join(" ");

  assert.match(visibleText, /https:\/\/pairing\.example\.test/);
  assert.match(visibleText, /broad Google (Account )?session credentials/i);
  assert.match(visibleText, /not a Messages-only token/i);
  assert.match(visibleText, /stored server-side/i);
});

test("helper session partitions are unique, role-scoped, and nonpersistent", () => {
  const portal = ephemeralPartition("portal", "first-id");
  const google = ephemeralPartition("google", "second-id");

  assert.equal(portal, "messages-login-helper-portal-first-id");
  assert.equal(google, "messages-login-helper-google-second-id");
  assert.notEqual(portal, google);
  assert.equal(portal.startsWith("persist:"), false);
  assert.equal(google.startsWith("persist:"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { PortalAuth, hashPin, verifyPin } from "../src/auth.js";

const config = {
  signingKey: "ab".repeat(32),
};

test("tickets expire, are host-bound, and cannot be replayed; sessions stay host-bound", async () => {
  let now = Date.now();
  const auth = new PortalAuth({ ...config, now: () => now });
  const ticket = auth.ticket("p-first");
  assert.equal(auth.consume(ticket, "p-second"), false);
  assert.equal(auth.consume(ticket, "p-first"), true);
  assert.equal(auth.consume(ticket, "p-first"), false);
  const expired = auth.ticket("p-first");
  now += 60_001;
  assert.equal(auth.consume(expired, "p-first"), false);
  const cookie = await auth.session("p-first");
  assert.equal(await auth.validSession(cookie, "p-first"), true);
  assert.equal(await auth.validSession(cookie, "p-second"), false);
  assert.equal(await auth.validSession(cookie + "x", "p-first"), false);
  now += 8 * 3600_000 + 1;
  assert.equal(await auth.validSession(cookie, "p-first"), false);
});

test("PIN hashing preserves leading zeroes and rejects weak or non-string values", async () => {
  const encoded = await hashPin("012345");
  assert.notEqual(await hashPin("012345"), encoded, "salts must be unique");
  assert.equal(await verifyPin("012345", encoded), true);
  assert.equal(await verifyPin("012346", encoded), false);
  assert.equal(
    await verifyPin("123456789012", await hashPin("123456789012")),
    true,
  );
  for (const pin of [
    12345678,
    "12345",
    "1234567890123",
    "abcdefgh",
    "",
    null,
  ]) {
    await assert.rejects(hashPin(pin), /6–12 digits/);
    assert.equal(await verifyPin(pin, encoded), false);
  }
});

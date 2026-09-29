import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SendLedger } from "../src/send-ledger.js";
import { ApiError, type SendReceipt } from "../src/types.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gm-ledger-"));
  directories.push(directory);
  return { directory, ledger: new SendLedger(directory) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

const request = { conversationId: "384", text: "Private test message 🥔" };
const receipt: SendReceipt = {
  conversationId: "384",
  status: "submitted",
  delivery: "unconfirmed",
  submittedAt: "2026-09-25T14:01:00.000Z",
};
const code = (expected: string) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;

test("a completed key replays after restart without another send or plaintext text on disk", async () => {
  const { directory, ledger } = await fixture();
  assert.deepEqual(
    await ledger.execute("key-first-01", request, async () => receipt),
    receipt,
  );
  const restarted = new SendLedger(directory);
  assert.deepEqual(
    await restarted.execute("key-first-01", request, async () => {
      assert.fail("A replay must never send again");
    }),
    receipt,
  );
  const names = await readdir(directory);
  assert.equal(names.length, 1);
  const stored = await readFile(join(directory, names[0] ?? ""), "utf8");
  assert.equal(stored.includes(request.text), false);
  assert.equal(stored.includes("key-first-01"), false);
  assert.equal(
    (await stat(join(directory, names[0] ?? ""))).mode & 0o777,
    0o600,
  );
});

test("reusing a key for a different recipient or body is a conflict", async () => {
  const { ledger } = await fixture();
  await ledger.execute("key-second-2", request, async () => receipt);
  for (const other of [
    { ...request, conversationId: "385" },
    { ...request, text: `${request.text} ` },
  ]) {
    await assert.rejects(
      ledger.execute("key-second-2", other, async () =>
        assert.fail("must not send"),
      ),
      code("IDEMPOTENCY_CONFLICT"),
    );
  }
});

test("a failed or ambiguous send remains blocked across process restarts", async () => {
  const { directory, ledger } = await fixture();
  await assert.rejects(
    ledger.execute("key-unknown-3", request, async () => {
      throw new ApiError(504, "SEND_UNCERTAIN", "UI timed out after clicking");
    }),
    code("SEND_UNCERTAIN"),
  );
  await assert.rejects(
    new SendLedger(directory).execute("key-unknown-3", request, async () =>
      assert.fail("must not retry an uncertain send"),
    ),
    code("SEND_UNCERTAIN"),
  );
});

test("an in-flight key is reserved durably before the send starts", async () => {
  const { directory, ledger } = await fixture();
  await ledger.execute("key-parallel-4", request, async () => {
    const names = await readdir(directory);
    assert.equal(names.length, 1);
    assert.equal(
      JSON.parse(await readFile(join(directory, names[0] ?? ""), "utf8")).state,
      "pending",
    );
    await assert.rejects(
      new SendLedger(directory).execute("key-parallel-4", request, async () =>
        assert.fail("second writer must not send"),
      ),
      code("SEND_UNCERTAIN"),
    );
    return receipt;
  });
});

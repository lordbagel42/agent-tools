import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareState } from "../src/state.js";

test("state initialization preserves the token across restarts and restricts existing permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gm-state-"));
  t.after(() => rm(directory, { recursive: true }));
  await chmod(directory, 0o755);
  const first = await prepareState(directory);
  assert.match(first.token, /^[a-f0-9]{64}$/);
  assert.equal((await readFile(first.tokenPath, "utf8")).trim(), first.token);
  await chmod(first.tokenPath, 0o644);
  const second = await prepareState(directory);
  assert.equal(second.token, first.token);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(first.tokenPath)).mode & 0o777, 0o600);
});

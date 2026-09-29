import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionStore } from "../src/native/store.js";

test("session store persists encrypted private state, serializes writes and excludes another owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gm-native-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await SessionStore.open(directory);
  assert.equal(await store.load(), null);
  await assert.rejects(SessionStore.open(directory));
  const first = store.save({ cookie: "high-value-cookie", generation: 1 });
  const second = store.save({ cookie: "rotated-cookie", generation: 2 });
  await Promise.all([first, second]);
  await store.close();
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const contents = await readFile(path);
    assert.equal(contents.includes("cookie"), false);
    assert.equal(contents.includes("rotated"), false);
  }
  const reopened = await SessionStore.open(directory);
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.load(), {
    cookie: "rotated-cookie",
    generation: 2,
  });
  await assert.rejects(store.save({ generation: 3 }));
});

test("session store rejects modified ciphertext and never silently discards saved credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gm-native-tamper-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await SessionStore.open(directory);
  t.after(() => store.close());
  await store.save({ key: "sensitive-session-key" });
  const path = join(directory, "session.enc");
  const contents = await readFile(path);
  contents[contents.length - 1] = (contents.at(-1) ?? 0) ^ 1;
  await writeFile(path, contents);
  await assert.rejects(store.load());
});

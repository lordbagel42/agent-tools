import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, thread, listen, httpRequest } from "./helpers.js";
import { createService } from "../src/server.js";

test("default/custom prefixes generate namespaced IDs and reject wrong-prefix and cross-service hosts", async (t) => {
  const a = await fixture(t);
  const b = await fixture(t, { idPrefix: "custom9-" });
  const backend = createServer((_req, res) => res.end("ok"));
  const port = await listen(backend);
  t.after(() => backend.close());
  const input = { action: "expose", thread, name: "app", port };
  const first = await a.service.manager.execute(input);
  const second = await b.service.manager.execute(input);
  assert.match(first.id, /^p-[a-f0-9]{16}$/);
  assert.match(second.id, /^custom9-[a-f0-9]{16}$/);
  for (const [service, host] of [
    [a, `${second.id}.${a.config.domain}`],
    [b, `${first.id}.${b.config.domain}`],
    [b, `${second.id.replace("custom9-", "wrong-")}.${b.config.domain}`],
  ]) {
    assert.equal(
      (await httpRequest({ port: service.config.port, host })).status,
      404,
    );
  }
  await b.service.close();
  const restarted = await createService({ ...b.config, idPrefix: "next-" });
  t.after(() => restarted.close());
  assert.equal(
    restarted.manager.byHost(`${second.id}.${b.config.domain}`).id,
    second.id,
  );
});

test("invalid prefixes are rejected before authentication or state initialization", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "portal-prefix-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const idPrefix of [
    "",
    "UP-",
    "1-",
    "a_b-",
    "a.b-",
    "abcdefghijklmnopq-",
    "a",
    42,
    null,
  ]) {
    const stateDir = join(dir, "must-not-exist");
    await assert.rejects(
      createService({
        idPrefix,
        stateDir,
        domain: "example.com",
        loginHost: "login.example.com",
      }),
      /Invalid portal ID prefix/,
    );
    await assert.rejects(stat(stateDir), { code: "ENOENT" });
  }
});

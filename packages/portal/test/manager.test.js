import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createService } from "../src/server.js";
import {
  fixture,
  thread,
  otherThread,
  listen,
  httpRequest,
} from "./helpers.js";

test("registration is idempotent and thread-owned; targets cannot be arbitrary URLs", async (t) => {
  const { service, dir } = await fixture(t);
  const backend = createServer((_req, res) => res.end("hello"));
  const port = await listen(backend);
  t.after(() => backend.close());
  const input = { action: "expose", thread, name: "app", port };
  const a = await service.manager.execute(input);
  const b = await service.manager.execute(input);
  assert.equal(a.url, b.url);
  assert.equal(a.ready, true);
  assert.deepEqual(
    await service.manager.execute({ action: "list", thread: otherThread }),
    [],
  );
  await assert.rejects(
    service.manager.execute({
      action: "stop",
      thread: otherThread,
      name: "app",
    }),
    /not found/,
  );
  await assert.rejects(
    service.manager.execute({ ...input, port: port + 1 }),
    /already exists/,
  );
  await assert.rejects(
    service.manager.execute({
      ...input,
      name: "bad",
      port: "http://192.168.0.1",
    }),
    /port/,
  );
  await assert.rejects(
    service.manager.execute({ ...input, name: "../bad" }),
    /name/,
  );
  await assert.rejects(
    service.manager.execute({ ...input, name: "ssrf", host: "192.168.0.1" }),
    /Unknown/,
  );
  assert.equal((await stat(dir + "/portals.json")).mode & 0o777, 0o600);
  assert.equal((await stat(service.config.socketPath)).mode & 0o777, 0o600);
  await service.manager.execute({ action: "stop", thread, name: "app" });
  assert.equal((await httpRequest({ port, host: "localhost" })).body, "hello");
  assert.deepEqual(
    JSON.parse(await readFile(dir + "/portals.json", "utf8")),
    [],
  );
});

test("managed previews receive PORT/PUBLIC_URL, restart, and stop without leaking listeners", async (t) => {
  const { service, dir } = await fixture(t);
  const code =
    "require('http').createServer((q,s)=>{s.setHeader('x-process-id', process.pid);s.end(process.env.PUBLIC_URL)}).listen(process.env.PORT,'127.0.0.1'); console.log('ready-log')";
  const input = {
    action: "start",
    thread,
    name: "web",
    cwd: dir,
    command: `node -e ${JSON.stringify(code)}`,
  };
  const portal = await service.manager.execute(input);
  assert.equal(portal.ready, true);
  assert.equal(
    (await httpRequest({ port: portal.port, host: "localhost" })).body,
    portal.url,
  );
  assert.equal((await service.manager.execute(input)).url, portal.url);
  const logs = await service.manager.execute({
    action: "logs",
    thread,
    name: "web",
  });
  assert.match(logs.logs, /ready-log/);
  const before = await httpRequest({ port: portal.port, host: "localhost" });
  const changed = await service.manager.execute({
    action: "set-pin",
    thread,
    name: "web",
    pin: "87654321",
  });
  assert.equal(changed.url, portal.url);
  assert.equal(changed.port, portal.port);
  assert.equal(changed.ready, true);
  const after = await httpRequest({ port: portal.port, host: "localhost" });
  assert.equal(after.headers["x-process-id"], before.headers["x-process-id"]);
  const restarted = await service.manager.execute({
    action: "restart",
    thread,
    name: "web",
  });
  assert.equal(restarted.url, portal.url);
  assert.equal(restarted.ready, true);
  await service.manager.execute({ action: "stop", thread, name: "web" });
  await assert.rejects(
    httpRequest({ port: portal.port, host: "localhost" }),
    /ECONNREFUSED/,
  );
});

test("readiness failure is explicit, and command working directories must stay within the workspace", async (t) => {
  const { service, dir } = await fixture(t, { readinessMs: 200 });
  await assert.rejects(
    service.manager.execute({
      action: "start",
      thread,
      name: "escape",
      cwd: "/etc",
      command: "true",
    }),
    /workspace/,
  );
  const result = await service.manager.execute({
    action: "start",
    thread,
    name: "broken",
    cwd: dir,
    command: "exit 7",
  });
  assert.equal(result.ready, false);
  assert.match(result.error, /not responding/i);
});

test("managed previews recover after a crash and daemon restart, retaining their URL", async (t) => {
  const { service, config, dir } = await fixture(t, { readinessMs: 6000 });
  const code =
    "const fs=require('fs'); if(!fs.existsSync('started')){fs.writeFileSync('started','1');process.exit(9)} require('http').createServer((q,s)=>s.end('restored')).listen(process.env.PORT,'127.0.0.1')";
  const portal = await service.manager.execute({
    action: "start",
    thread,
    name: "recover",
    cwd: dir,
    command: `node -e ${JSON.stringify(code)}`,
  });
  assert.equal(portal.ready, true);
  assert.match(
    (await service.manager.execute({ action: "logs", thread, name: "recover" }))
      .logs,
    /Process exited: 9/,
  );
  await service.close();
  const restored = await createService(config);
  t.after(() => restored.close());
  for (let i = 0; i < 60; i++) {
    if (
      (
        await restored.manager.execute({
          action: "status",
          thread,
          name: "recover",
        })
      ).ready
    )
      break;
    await delay(50);
  }
  const status = await restored.manager.execute({
    action: "status",
    thread,
    name: "recover",
  });
  assert.equal(status.url, portal.url);
  assert.equal(status.ready, true);
  assert.equal(
    (await httpRequest({ port: status.port, host: "localhost" })).body,
    "restored",
  );
});

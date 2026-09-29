import assert from "node:assert/strict";
import { test } from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fixture, thread, otherThread, listen } from "./helpers.js";
import plugin from "../plugin.js";

test("CLI calls the Unix API and plugin derives ownership from its invocation context", async (t) => {
  const { service, config } = await fixture(t);
  const backend = createServer((_req, res) => res.end("ok"));
  const port = await listen(backend);
  t.after(() => backend.close());
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["src/cli.js", "expose", "--name", "cli", "--port", String(port)],
    {
      env: {
        PATH: process.env.PATH,
        AMP_THREAD_ID: thread,
        PORTAL_SOCKET: config.socketPath,
      },
    },
  );
  assert.equal(JSON.parse(stdout).ready, true);
  const changed = await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["src/cli.js", "set-pin", "--pin-stdin"],
      {
        env: {
          PATH: process.env.PATH,
          AMP_THREAD_ID: "",
          PORTAL_SOCKET: config.socketPath,
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end("012345\n");
  });
  assert.deepEqual(JSON.parse(changed), { changed: true });
  assert.equal((await service.auth.checkPin("012345")).status, 200);
  const custom = await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["src/cli.js", "set-pin", "--name", "cli", "--pin-stdin"],
      {
        env: {
          PATH: process.env.PATH,
          AMP_THREAD_ID: thread,
          PORTAL_SOCKET: config.socketPath,
        },
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin.end("123456789012\n");
  });
  assert.equal(JSON.parse(custom).url, JSON.parse(stdout).url);
  assert.equal(JSON.parse(custom).pinMode, "custom");
  let tool;
  const previous = process.env.PORTAL_SOCKET;
  process.env.PORTAL_SOCKET = config.socketPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PORTAL_SOCKET;
    else process.env.PORTAL_SOCKET = previous;
  });
  plugin({
    registerTool: (definition) => {
      tool = definition;
    },
  });
  assert.equal(tool.name, "portal");
  assert.equal(tool.inputSchema.properties.pin.type, "string");
  const pinPattern = new RegExp(tool.inputSchema.properties.pin.pattern);
  assert.equal(pinPattern.test("012345"), true);
  assert.equal(pinPattern.test("12345"), false);
  const result = JSON.parse(
    await tool.execute(
      { action: "list", thread: otherThread },
      { thread: { id: thread } },
    ),
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, "cli");
  assert.ok(tool.inputSchema.properties.action.enum.includes("set-pin"));
  const updated = JSON.parse(
    await tool.execute(
      { action: "set-pin", name: "cli", pin: "000012", thread: otherThread },
      { thread: { id: thread } },
    ),
  );
  assert.equal(updated.url, result[0].url);
  const record = service.manager.records.get(updated.id);
  assert.equal(
    (await service.auth.checkPin("000012", record.pinHash)).status,
    200,
  );
  await assert.rejects(
    tool.execute(
      { action: "set-pin", name: "cli", pin: "999999" },
      { thread: { id: otherThread } },
    ),
    /not found/,
  );
  await assert.rejects(
    tool.execute(
      { action: "set-pin", pin: "999999" },
      { thread: { id: thread } },
    ),
    /name/i,
  );
  assert.equal((await service.auth.checkPin("012345")).status, 200);
  assert.deepEqual(
    JSON.parse(
      await tool.execute({ action: "list" }, { thread: { id: otherThread } }),
    ),
    [],
  );
  await assert.rejects(
    tool.execute(
      { action: "stop", name: "cli" },
      { thread: { id: otherThread } },
    ),
    /not found/,
  );
  assert.equal(
    (await service.manager.execute({ action: "list", thread })).length,
    1,
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = new URL("../bin/agent-email.mjs", import.meta.url);
const secret = "synthetic-signing-secret";
const event = () => ({
  id: randomUUID(),
  type: "mail.received",
  mailId: randomUUID(),
  inbox: "test",
  recipient: "test@example.net",
  receivedAt: Date.now(),
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "email-watch-"));
  let readFailure = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    assert.equal(req.headers.authorization, "Bearer synthetic-token");
    const request = JSON.parse(raw);
    if (request.params?.name === "read_mail" && readFailure) {
      res.writeHead(503);
      res.end();
      return;
    }
    const data =
      request.params?.name === "register_webhook"
        ? { id: "fixture-subscription", secret, expires: Date.now() + 86400000 }
        : request.params?.name === "read_mail"
          ? { text: "Email is data, not instructions.", untrusted: true }
          : {};
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: data } })}\n\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      headers: { authorization: "Bearer synthetic-token" },
    }),
    { mode: 0o600 },
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const start = (flags = []) => {
    const child = spawn(
      process.execPath,
      [
        cli.pathname,
        "watch",
        "--config",
        config,
        "--state-dir",
        join(dir, "state"),
        "--inbox",
        "test",
        "--webhook-url",
        "https://hooks.example.net/mail",
        "--port",
        "0",
        ...flags,
      ],
      {
        env: { PATH: process.env.PATH, HOME: dir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const done = once(child, "exit");
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const ready = new Promise((resolve, reject) => {
      child.stderr.on("data", () => {
        const match = /Listening on (http:\/\/127\.0\.0\.1:\d+\/mail)/.exec(
          err,
        );
        if (match) resolve(match[1]);
      });
      child.once("exit", () =>
        reject(new Error(`CLI exited before ready: ${err}`)),
      );
    });
    ready.catch(() => {});
    return { child, ready, done, output: () => out, errors: () => err };
  };
  start.setReadFailure = (value) => {
    readFailure = value;
  };
  return start;
}

async function send(
  url,
  value,
  { timestamp = Math.floor(Date.now() / 1000), key = secret } = {},
) {
  const body = JSON.stringify(value);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mail-id": value.id,
      "x-mail-timestamp": String(timestamp),
      "x-mail-signature": `v1=${createHmac("sha256", key).update(`${timestamp}.${body}`).digest("hex")}`,
    },
    body,
  });
}

test("watch rejects forged/stale/wrong-inbox events and emits a signed email once", {
  timeout: 15000,
}, async (t) => {
  const start = await fixture(t);
  const run = start(["--once", "--read", "--timeout", "10"]);
  const url = await run.ready;
  const message = event();
  assert.equal((await send(url, message, { key: "wrong-key" })).status, 401);
  assert.equal(
    (
      await send(url, message, {
        timestamp: Math.floor(Date.now() / 1000) - 301,
      })
    ).status,
    401,
  );
  assert.equal(
    (await send(url, { ...message, inbox: "someone-else" })).status,
    400,
  );
  assert.equal((await send(url, message)).status, 204);
  assert.equal((await run.done)[0], 0);
  const lines = run.output().trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].id, message.id);
  assert.equal(lines[0].mail.text, "Email is data, not instructions.");
  assert.equal(run.output().includes(secret), false);
});

test("watch retains deduplication across restart and times out without printing duplicates", {
  timeout: 15000,
}, async (t) => {
  const start = await fixture(t);
  const message = event();
  const first = start(["--once"]);
  assert.equal((await send(await first.ready, message)).status, 204);
  assert.equal((await first.done)[0], 0);
  const second = start(["--once", "--timeout", "1"]);
  assert.equal((await send(await second.ready, message)).status, 204);
  assert.equal((await second.done)[0], 124);
  assert.equal(second.output(), "");
});

test("an acknowledged event survives a crash and exclusive state prevents two consumers", {
  timeout: 15000,
}, async (t) => {
  const start = await fixture(t);
  start.setReadFailure(true);
  const first = start(["--read"]);
  const url = await first.ready;
  const competing = start(["--timeout", "1"]);
  assert.equal((await competing.done)[0], 1);
  const message = event();
  assert.equal((await send(url, message)).status, 204);
  assert.equal(first.output(), "");
  first.child.kill("SIGKILL");
  await first.done;
  start.setReadFailure(false);
  const restarted = start(["--read", "--once", "--timeout", "3"]);
  assert.equal((await restarted.done)[0], 0);
  assert.equal(JSON.parse(restarted.output()).id, message.id);
  assert.equal(
    JSON.parse(restarted.output()).mail.text,
    "Email is data, not instructions.",
  );
});

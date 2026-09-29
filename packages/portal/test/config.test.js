import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { verifyPin } from "../src/auth.js";
import { createService } from "../src/server.js";
import { thread } from "./helpers.js";

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "portal-init-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
  };
  const run = (args, pin = "012345\n") =>
    new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        ["src/cli.js", ...args],
        { env },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      );
      child.stdin.end(pin);
    });
  return { dir, env, run, path: join(dir, "config/portal/config.json") };
}

test("init creates private user-local config, random signing key and hashed stdin PIN without a daemon", async (t) => {
  const { dir, run, path } = await setup(t);
  const args = [
    "init",
    "--domain",
    "preview.example.com",
    "--workspace",
    dir,
    "--pin-stdin",
  ];
  const result = await run(args);
  assert.equal(result.error, null, result.stderr);
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.match(config.signingKey, /^[a-f0-9]{64}$/);
  assert.equal(config.stateDir, join(dir, "state/portal"));
  assert.equal(config.socketPath, join(config.stateDir, "control.sock"));
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.loginHost, "login.preview.example.com");
  assert.equal(config.workspaceRoot, dir);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(config.stateDir)).mode & 0o777, 0o700);
  const pinFile = join(config.stateDir, "shared-pin.json");
  assert.equal((await stat(pinFile)).mode & 0o777, 0o600);
  assert.equal(
    await verifyPin("012345", JSON.parse(await readFile(pinFile, "utf8"))),
    true,
  );
  assert.ok(!JSON.stringify(config).includes("012345"));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(config.signingKey));
  assert.ok(!`${result.stdout}${result.stderr}`.includes("012345"));
  const repeated = await run(args, "654321");
  assert.ok(repeated.error);
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).signingKey,
    config.signingKey,
  );
  assert.equal(
    await verifyPin("012345", JSON.parse(await readFile(pinFile, "utf8"))),
    true,
  );
});

test("init rejects invalid PIN and prefix without creating config", async (t) => {
  const { dir, run, path } = await setup(t);
  for (const [extra, pin] of [
    [[], "bad"],
    [["--id-prefix", "BAD-"], "012345"],
  ]) {
    const result = await run(
      [
        "init",
        "--domain",
        "preview.example.com",
        "--workspace",
        dir,
        "--pin-stdin",
        ...extra,
      ],
      pin,
    );
    assert.ok(result.error);
    assert.match(
      result.stderr,
      pin === "bad" ? /PIN must contain/ : /Invalid portal ID prefix/,
    );
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
});

test("explicit config and custom local paths connect the CLI to the selected daemon", async (t) => {
  const { dir, run } = await setup(t);
  const path = join(dir, "custom.json");
  const stateDir = join(dir, "custom-state");
  const socketPath = join(dir, "custom.sock");
  const result = await run([
    "init",
    "--domain",
    "preview.example.com",
    "--workspace",
    dir,
    "--config",
    path,
    "--state-dir",
    stateDir,
    "--socket",
    socketPath,
    "--id-prefix",
    "custom-",
    "--pin-stdin",
  ]);
  assert.equal(result.error, null, result.stderr);
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.stateDir, stateDir);
  assert.equal(config.socketPath, socketPath);
  assert.equal(config.idPrefix, "custom-");
  const service = await createService({ ...config, port: 0 });
  t.after(() => service.close());
  const listed = await run(["list", "--config", path, "--thread", thread]);
  assert.equal(listed.error, null, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), []);
});

test("client rejects missing socket config instead of falling back to an HTTP request", async (t) => {
  const { dir, run } = await setup(t);
  const path = join(dir, "invalid.json");
  await writeFile(path, "{}");
  const result = await run(["list", "--config", path, "--thread", thread]);
  assert.ok(result.error);
  assert.match(result.stderr, /An absolute portal socketPath is required/);
});

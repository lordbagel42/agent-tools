import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

test("CLI help and invalid options do not start a browser or create credentials", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gm-cli-"));
  t.after(() => rm(directory, { recursive: true }));
  const cli = resolve("dist/src/cli.js");
  const help = spawnSync(process.execPath, [cli, "--help"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--pairing-port/);
  for (const args of [
    ["--port", "NaN"],
    ["--pairing-port", "80"],
    ["--port", "8787", "--pairing-port", "8787"],
    ["--unexpected"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
  }
  const invalidProxy = spawnSync(
    process.execPath,
    [cli, "--pairing-port", "8788"],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLIC_URL: "not a URL",
        CHROME_PATH: "/missing-browser",
      },
    },
  );
  assert.equal(invalidProxy.status, 1);
  assert.deepEqual(await readdir(directory), []);
});

test("CLI rejects web login without its listener or alongside legacy QR before starting a browser", async () => {
  for (const [args, message] of [
    [["--web-login"], "--web-login requires --pairing-port"],
    [
      ["--web-login", "--pairing-port", "8788", "--legacy-qr"],
      "--web-login cannot be combined with --legacy-qr",
    ],
  ] as const) {
    await assert.rejects(
      promisify(execFile)(process.execPath, ["dist/src/cli.js", ...args], {
        timeout: 8000,
      }),
      (error: unknown) => {
        const result = error as { code: number; stderr: string };
        assert.equal(result.code, 1);
        assert.ok(result.stderr.includes(message), result.stderr);
        return true;
      },
    );
  }
});

test("default server starts and restarts without a browser, with a separate pairing-only listener", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gm-native-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const freePort = async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const close = once(server, "close");
    server.close();
    await close;
    return address.port;
  };
  const apiPort = await freePort();
  let pairingPort = await freePort();
  while (pairingPort === apiPort) pairingPort = await freePort();
  let previousToken = "";
  for (let i = 0; i < 2; i++) {
    const child = spawn(
      process.execPath,
      [
        resolve("dist/src/cli.js"),
        "--state-dir",
        directory,
        "--port",
        String(apiPort),
        "--pairing-port",
        String(pairingPort),
      ],
      {
        env: {
          ...process.env,
          CHROME_PATH: "/does-not-exist",
          DISPLAY: "",
          PUBLIC_URL: "https://pair.test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    let output = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Native server did not start")),
          10_000,
        );
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("Session:")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Server exited before startup"));
        });
        child.once("error", reject);
      });
      const token = (
        await readFile(join(directory, "api-token"), "utf8")
      ).trim();
      if (previousToken) assert.equal(token, previousToken);
      previousToken = token;
      const status = await fetch(`http://127.0.0.1:${apiPort}/v1/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.deepEqual(await status.json(), {
        state: "pairing_required",
        transport: "native",
        connected: false,
      });
      assert.equal(
        (await fetch(`http://127.0.0.1:${apiPort}/v1/conversations`)).status,
        401,
      );
      assert.deepEqual(
        await (await fetch(`http://127.0.0.1:${pairingPort}/status`)).json(),
        { state: "needs_login" },
      );
      assert.equal(
        (await fetch(`http://127.0.0.1:${pairingPort}/v1/conversations`))
          .status,
        404,
      );
      assert.equal(output.includes(token), false);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { once } from "node:events";
import { Tunnels, validate, sshArgs } from "../src/tunnel.js";
import plugin from "../src/plugin.js";

const spec = {
  direction: "local",
  destination: "fixture",
  listenPort: 1455,
  targetPort: 1455,
};
const ssh = fileURLToPath(new URL("fixtures/ssh.js", import.meta.url));
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "tn-"));
  await chmod(ssh, 0o755);
  const tunnels = new Tunnels({ root, ssh, ...options });
  t.after(async () => {
    await chmod(root, 0o700);
    for (const owner of ["thread-a", "thread-b", "owner"]) {
      for (const record of await tunnels.list(owner))
        await tunnels.stop(owner, record.name);
    }
    await rm(root, { recursive: true, force: true });
  });
  return tunnels;
}
async function server(t) {
  const s = net.createServer((c) => c.pipe(c));
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(() => s.close());
  return s;
}

test("rejects injection, privileged listeners and unconfirmed reverse", () => {
  for (const destination of [
    "-oProxyCommand=bad",
    "a;bad",
    "a b",
    "ssh://host",
  ])
    assert.throws(() => validate({ ...spec, destination }));
  for (const listenPort of [22, 0, 65536, 1.5, "1455"])
    assert.throws(() => validate({ ...spec, listenPort }));
  assert.throws(
    () => validate({ ...spec, direction: "reverse" }),
    /GatewayPorts/,
  );
  const args = sshArgs(spec, "/tmp/private.sock");
  for (const flag of [
    "StrictHostKeyChecking=yes",
    "ExitOnForwardFailure=yes",
    "BatchMode=yes",
    "ClearAllForwardings=yes",
  ])
    assert.ok(args.includes(flag));
  assert.ok(args.includes("127.0.0.1:1455:127.0.0.1:1455"));
});

for (const direction of ["local", "reverse"])
  test(`${direction}: lifecycle, thread isolation and real TCP payload with fixture`, async (t) => {
    const tunnels = await setup(t);
    const echo = await server(t);
    const reservation = await server(t);
    const listenPort = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const input = {
      ...spec,
      direction,
      remoteLoopbackConfirmed: true,
      targetPort: echo.address().port,
      listenPort,
    };
    assert.equal(
      (await tunnels.start("thread-a", "oauth", input)).state,
      "running",
    );
    assert.equal((await tunnels.status("thread-a", "oauth")).state, "running");
    assert.deepEqual(await tunnels.list("thread-b"), []);
    assert.equal((await tunnels.status("thread-b", "oauth")).state, "missing");
    await tunnels.stop("thread-b", "oauth");
    assert.equal((await tunnels.list("thread-a")).length, 1);
    await assert.rejects(
      tunnels.start("thread-a", "oauth", input),
      /already running/,
    );
    const client = net.connect(listenPort, "127.0.0.1");
    await once(client, "connect");
    client.write("oauth callback");
    const [data] = await once(client, "data");
    assert.equal(data.toString(), "oauth callback");
    client.destroy();
    const paths = await tunnels.paths("thread-a", "oauth");
    assert.equal((await stat(paths.record)).mode & 0o777, 0o600);
    assert.equal((await stat(tunnels.root)).mode & 0o777, 0o700);
    assert.equal((await tunnels.stop("thread-a", "oauth")).state, "stopped");
  });

test("failed SSH, cancellation, readiness timeout, invalid owner and stale state", async (t) => {
  const tunnels = await setup(t, { timeoutMs: 5000 });
  await assert.rejects(
    tunnels.start("owner", "failed", { ...spec, destination: "fail" }),
    /SSH exited/,
  );
  tunnels.timeoutMs = 200;
  await assert.rejects(
    tunnels.start("owner", "timeout", { ...spec, destination: "hang" }),
    /timed out/,
  );
  await assert.rejects(
    tunnels.start(
      "owner",
      "cancel",
      { ...spec, destination: "hang" },
      AbortSignal.timeout(100),
    ),
    /abort/i,
  );
  await assert.rejects(tunnels.list(""), /owner/);
  await assert.rejects(tunnels.status("owner", "../escape"), /name/);
  const paths = await tunnels.paths("owner", "stale");
  await writeFile(
    paths.record,
    JSON.stringify({ name: "stale", pid: process.pid }),
  );
  assert.equal((await tunnels.status("owner", "stale")).state, "stale");
  assert.equal((await tunnels.stop("owner", "stale")).state, "stopped");
  assert.equal(await tunnels.alive(paths), false);
});

test("rejects insecure state directory", async (t) => {
  const tunnels = await setup(t);
  await chmod(tunnels.root, 0o755);
  await assert.rejects(tunnels.list("owner"), /0700/);
});

test("Amp registers current API tool and refuses invalid actions", async () => {
  let tool;
  plugin({
    registerTool(definition) {
      tool = definition;
    },
  });
  assert.equal(tool.name, "tunnel");
  assert.equal(tool.inputSchema.additionalProperties, false);
  await assert.rejects(
    tool.execute({ action: "toString" }, { thread: { id: "T-fixture" } }),
    /Invalid action/,
  );
});

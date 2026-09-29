import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bootstrapped executable opens existing SQLite data and serves health", async () => {
  const directory = await mkdtemp(join(tmpdir(), "artifacts-startup-"));
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop(true);
  const env = {
    ARTIFACTS_ORIGIN: `http://127.0.0.1:${port}`,
    ARTIFACTS_HOST_SUFFIX: "-artifact.localhost",
    ARTIFACTS_OWNER_EMAIL: "owner@example.test",
    ARTIFACTS_OWNER_PASSWORD: "sixsix",
    BETTER_AUTH_SECRET: "synthetic-startup-secret-thirty-two-characters",
    ARTIFACTS_DATA_DIR: directory,
    HOST: "127.0.0.1",
    PORT: String(port),
  };
  let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    const main = new URL("../src/main.ts", import.meta.url).pathname;
    const rejected = Bun.spawn([process.execPath, main, "--bootstrap"], {
      env: { ...env, ARTIFACTS_OWNER_PASSWORD: "short" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const rejectionError = new Response(rejected.stderr).text();
    expect(await rejected.exited).not.toBe(0);
    expect(await rejectionError).toContain("must contain at least");
    const bootstrap = Bun.spawn([process.execPath, main, "--bootstrap"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const bootstrapError = new Response(bootstrap.stderr).text();
    expect(await bootstrap.exited).toBe(0);
    await bootstrapError;
    const setup = Bun.spawn([process.execPath, main, "--setup-link"], {
      env: { ...env, ARTIFACTS_OWNER_PASSWORD: undefined },
      stdout: "pipe",
      stderr: "pipe",
    });
    const setupOutput = new Response(setup.stdout).text();
    const setupError = new Response(setup.stderr).text();
    expect(await setup.exited).toBe(0);
    await setupError;
    const setupLink = new URL((await setupOutput).trim());
    expect(setupLink.pathname).toBe("/signup");
    server = Bun.spawn([process.execPath, main], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = server.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    if (!first.includes('"event":"listening"'))
      throw new Error(await new Response(server.stderr).text());
    const response = await fetch(`${env.ARTIFACTS_ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    const reset = await fetch(
      `${env.ARTIFACTS_ORIGIN}/api/auth/reset-password`,
      {
        method: "POST",
        headers: {
          Origin: env.ARTIFACTS_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          token: new URLSearchParams(setupLink.hash.slice(1)).get("token"),
          newPassword: "synthetic-startup-replacement-password",
        }),
      },
    );
    expect(reset.status).toBe(200);
    server.kill("SIGTERM");
    expect(await server.exited).toBe(0);
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await server.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);

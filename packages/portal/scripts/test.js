import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

// Daemon lifecycle tests spawn real commands. Do not lend them the runner's
// credentials, home configuration, or production control-socket overrides.
const home = await mkdtemp(join(tmpdir(), "portal-tests-"));
try {
  const files = (await readdir("test")).filter((name) =>
    name.endsWith(".test.js"),
  );
  const child = spawn(
    process.execPath,
    ["--test", ...files.map((name) => join("test", name))],
    {
      stdio: "inherit",
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir() },
    },
  );
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} finally {
  await rm(home, { recursive: true, force: true });
}

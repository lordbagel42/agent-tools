import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { paint, cleanEnvironment, validatePNG } from "../src/paint.js";
import plugin from "../src/plugin.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/paint.js", import.meta.url));

// Synthetic 1x1 PNG; no account data or provider responses.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

async function fixture(t, mode = "ok") {
  const dir = await mkdtemp(join(tmpdir(), "paint-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  await mkdir(home);
  const executable = join(dir, "codex");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', b => input += b);
process.stdin.on('end', () => {
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (mode === 'overflow') { process.stdout.write('x'.repeat(2 * 1024 * 1024)); return; }
  if (mode === 'exit') { process.stderr.write('secret-provider-error'); process.exit(2); }
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'inspection.json'), JSON.stringify({args, input, env: process.env, cwd: process.cwd()}));
  console.log(JSON.stringify({type:'thread.started', thread_id:'fixture-thread'}));
  const tree = path.join(process.env.CODEX_HOME, 'generated_images', 'fixture-thread');
  fs.mkdirSync(tree, {recursive:true});
  let file = path.join(tree, 'call.png');
  const bytes = Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64');
  if (mode === 'outside') file = path.join(process.env.CODEX_HOME, 'outside.png');
  if (mode !== 'missing') fs.writeFileSync(file, mode === 'corrupt' ? 'not png' : bytes);
  if (mode === 'stale') fs.utimesSync(file, new Date(0), new Date(0));
  if (mode === 'symlink') { fs.renameSync(file, file+'.real'); fs.symlinkSync(file+'.real', file); }
  if (mode === 'hardlink') fs.linkSync(file, file+'.link');
  if (mode === 'directory-symlink') { fs.renameSync(tree, tree+'.real'); fs.symlinkSync(tree+'.real', tree); }
  if (mode === 'oversize') fs.truncateSync(file, 33 * 1024 * 1024);
  if (mode === 'multi') fs.writeFileSync(path.join(tree, 'extra.png'), bytes);
  if (mode === 'mismatch') file = path.join(tree, 'invented.png');
  fs.writeFileSync(args[args.indexOf('-o')+1], mode === 'prose' ? 'Saved '+file : JSON.stringify({image_path:file}));
});
`,
    { mode: 0o700 },
  );
  return { dir, home, executable, output: join(dir, "out.png") };
}

test("allowlist strips credentials and provider overrides", () => {
  const env = cleanEnvironment(
    {
      HOME: "/home/test",
      PATH: "/usr/bin",
      OPENAI_API_KEY: "secret",
      OPENAI_BASE_URL: "https://evil.test",
      NODE_OPTIONS: "--inspect",
      CODEX_HOME: "/bad",
    },
    "/safe",
    "/bin/codex",
  );
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CODEX_HOME, "/safe");
});

test("PNG validates signature and every CRC", () => {
  validatePNG(png);
  const bad = Buffer.from(png);
  bad[45] ^= 1;
  assert.throws(() => validatePNG(bad));
  assert.throws(() => validatePNG(png.subarray(0, -1)));
});

test("real subprocess uses stdin, isolated cwd, native flags and reference arguments", async (t) => {
  const f = await fixture(t);
  const reference = join(f.dir, "reference with spaces.png");
  await writeFile(reference, png);
  const result = await paint(
    { prompt: "draw a square", output: f.output, images: [reference] },
    { executable: f.executable, codexHome: f.home },
  );
  assert.equal(result.output, f.output);
  assert.deepEqual(await readFile(f.output), png);
  const observed = JSON.parse(await readFile(join(f.home, "inspection.json")));
  assert.ok(observed.input.includes("draw a square"));
  assert.ok(!observed.args.includes("draw a square"));
  assert.ok(observed.args.includes("--ignore-user-config"));
  assert.ok(observed.args.includes("--output-schema"));
  assert.equal(observed.args[observed.args.indexOf("--image") + 1], reference);
  assert.deepEqual(observed.args.slice(-2), ["--", "-"]);
  assert.notEqual(observed.cwd, process.cwd());
  await assert.rejects(readFile(join(observed.cwd, "final.json")));
});

for (const mode of [
  "missing",
  "outside",
  "corrupt",
  "stale",
  "symlink",
  "hardlink",
  "directory-symlink",
  "oversize",
  "mismatch",
  "multi",
  "prose",
  "exit",
  "overflow",
  "timeout",
]) {
  test(`rejects ${mode} without leaking provider output`, async (t) => {
    const f = await fixture(t, mode);
    await assert.rejects(
      paint(
        { prompt: "private prompt", output: f.output },
        {
          executable: f.executable,
          codexHome: f.home,
          timeoutMs: mode === "timeout" ? 100 : 5000,
        },
      ),
      (e) =>
        !e.message.includes("secret-provider-error") &&
        !e.message.includes("private prompt"),
    );
    await assert.rejects(readFile(f.output));
  });
}

test("does not overwrite outputs and accepts pre-aborted cancellation", async (t) => {
  const f = await fixture(t);
  await writeFile(f.output, "keep");
  await assert.rejects(
    paint(
      { prompt: "x", output: f.output },
      { executable: f.executable, codexHome: f.home },
    ),
  );
  assert.equal(await readFile(f.output, "utf8"), "keep");
  await assert.rejects(
    paint(
      { prompt: "x", output: join(f.dir, "other.png") },
      {
        executable: f.executable,
        codexHome: f.home,
        signal: AbortSignal.abort(),
      },
    ),
  );
});

test("CLI runs offline fixture with explicit configuration and no inherited credentials", async (t) => {
  const f = await fixture(t);
  const { stdout, stderr } = await exec(
    process.execPath,
    [
      cli,
      "--prompt",
      "fixture",
      "--output",
      f.output,
      "--executable",
      f.executable,
      "--codex-home",
      f.home,
    ],
    {
      env: {
        HOME: f.home,
        PATH: "/usr/bin:/bin",
        OPENAI_API_KEY: "must-not-pass",
        OPENAI_BASE_URL: "https://invalid.example",
      },
      timeout: 10000,
    },
  );
  assert.equal(JSON.parse(stdout).output, f.output);
  assert.equal(stderr, "");
  const observed = JSON.parse(await readFile(join(f.home, "inspection.json")));
  assert.equal(observed.env.OPENAI_API_KEY, undefined);
  assert.equal(observed.env.OPENAI_BASE_URL, undefined);
  assert.deepEqual(await readFile(f.output), png);
});

test("CLI invalid arguments do not echo sensitive strings", async () => {
  await assert.rejects(
    exec(process.execPath, [cli, "--private-secret"], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 10000,
    }),
    (e) => e.code === 1 && !e.stderr.includes("private-secret"),
  );
});

for (const entrypoint of ["CLI", "plugin"])
  test(`${entrypoint} uses persistent user configuration without custom launchers`, async (t) => {
    const f = await fixture(t);
    const configRoot = join(f.home, entrypoint === "CLI" ? "xdg" : ".config");
    await mkdir(join(configRoot, "paint"), { recursive: true });
    const settings = {
      executable: f.executable,
      codexHome: f.home,
      timeoutMs: 5000,
    };
    const configFile = join(configRoot, "paint/config.json");
    await writeFile(configFile, JSON.stringify(settings));
    const args =
      entrypoint === "CLI"
        ? [cli, "--prompt", "fixture", "--output", f.output]
        : [
            "--input-type=module",
            "-e",
            `
import register from ${JSON.stringify(new URL("../src/plugin.js", import.meta.url).href)};
const tools = []; register({ registerTool: tool => tools.push(tool) });
console.log(await tools[0].execute(${JSON.stringify({ prompt: "fixture", output: f.output })}));`,
          ];
    const { stdout } = await exec(process.execPath, args, {
      env: {
        HOME: f.home,
        PATH: "/nonexistent-fixture-path",
        CODEX_HOME: "/nonexistent-generic-codex-home",
        ...(entrypoint === "CLI" ? { XDG_CONFIG_HOME: configRoot } : {}),
      },
      timeout: 10000,
    });
    assert.equal(JSON.parse(stdout).output, f.output);
    assert.deepEqual(await readFile(f.output), png);
    assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), settings);
  });

test("CLI flags override environment, which overrides saved paint settings", async (t) => {
  const f = await fixture(t);
  const configFile = join(f.dir, "settings.json");
  await writeFile(
    configFile,
    JSON.stringify({
      executable: "/absent-saved-codex",
      codexHome: "/absent-saved-home",
    }),
  );
  const env = {
    HOME: f.home,
    PATH: "/nonexistent-fixture-path",
    PAINT_CONFIG: configFile,
    PAINT_CODEX_EXECUTABLE: f.executable,
    PAINT_CODEX_HOME: f.home,
  };
  await exec(
    process.execPath,
    [cli, "--prompt", "fixture", "--output", f.output],
    { env, timeout: 10000 },
  );
  assert.deepEqual(await readFile(f.output), png);
  env.PAINT_CODEX_EXECUTABLE = "/absent-environment-codex";
  env.PAINT_CODEX_HOME = "/absent-environment-home";
  const output = join(f.dir, "flags.png");
  await exec(
    process.execPath,
    [
      cli,
      "--prompt",
      "fixture",
      "--output",
      output,
      "--executable",
      f.executable,
      "--codex-home",
      f.home,
    ],
    { env, timeout: 10000 },
  );
  assert.deepEqual(await readFile(output), png);
});

for (const settings of [
  null,
  "{private-config-value",
  '{"codexHome":"relative"}',
  '{"executable":42}',
  '{"timeoutMs":0}',
  '{"apiKey":"private-config-value"}',
])
  test(`invalid or explicitly missing paint configuration fails before launching Codex: ${settings}`, async (t) => {
    const f = await fixture(t);
    const configFile = join(f.dir, "settings.json");
    if (settings !== null) await writeFile(configFile, settings);
    await assert.rejects(
      exec(
        process.execPath,
        [
          cli,
          "--prompt",
          "private prompt",
          "--output",
          f.output,
          "--executable",
          f.executable,
          "--codex-home",
          f.home,
        ],
        {
          env: {
            HOME: f.home,
            PATH: "/usr/bin:/bin",
            PAINT_CONFIG: configFile,
          },
          timeout: 10000,
        },
      ),
      (error) =>
        error.code === 1 && !error.stderr.includes("private-config-value"),
    );
    await assert.rejects(readFile(join(f.home, "inspection.json")), {
      code: "ENOENT",
    });
  });

test("plugin load only registers paint and rejects invalid execution before configuration", async () => {
  const tools = [];
  plugin({ registerTool: (tool) => tools.push(tool) });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "paint");
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  await assert.rejects(tools[0].execute({ prompt: "" }), /Prompt/);
});

test("running subprocess responds to cancellation", async (t) => {
  const f = await fixture(t, "timeout");
  const controller = new AbortController();
  const promise = paint(
    { prompt: "fixture", output: f.output },
    { executable: f.executable, codexHome: f.home, signal: controller.signal },
  );
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(promise, /cancelled/);
  } finally {
    clearTimeout(timer);
  }
  await assert.rejects(readFile(f.output));
});

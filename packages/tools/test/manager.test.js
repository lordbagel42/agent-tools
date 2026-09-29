import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { discover, manage, validateSource } from "../src/manager.js";
import plugin from "../src/plugin.js";

const exec = promisify(execFile);
const git = async (cwd, ...args) =>
  (
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-tools-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await git(source, "init", "-b", "main");
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "fixture-root",
      private: true,
      workspaces: ["packages/*"],
    }),
  );
  await writeFile(path.join(source, ".gitignore"), "node_modules/\ndist/\n");
  for (const id of ["alpha", "beta"]) {
    const dir = path.join(source, "packages", id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: `@fixture/${id}`,
        version: "1.0.0",
        type: "module",
        bin: id === "alpha" ? { alpha: "cli.js" } : "cli.js",
        agentTools: {
          plugin: id === "alpha" ? "dist/plugin.js" : "dist/plugin",
        },
        scripts: {
          build: "node build.js",
          prebuild: 'node -e "process.exit(99)"',
          postinstall: 'node -e "process.exit(99)"',
        },
      }),
    );
    await writeFile(
      path.join(dir, "cli.js"),
      '#!/usr/bin/env node\nconsole.log("fixture");\n',
    );
    await chmod(path.join(dir, "cli.js"), 0o755);
    await writeFile(
      path.join(dir, "build.js"),
      `import {mkdir, writeFile} from 'node:fs/promises'; await mkdir('dist/plugin', {recursive:true}); await writeFile('${id === "alpha" ? "dist/plugin.js" : "dist/plugin/index.js"}', 'export default function() {}');`,
    );
  }
  await exec(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: source },
  );
  await git(source, "add", ".");
  await git(source, "commit", "-m", "test: initial fixture");
  const options = {
    source,
    allowLocalSource: true,
    stateDir: path.join(root, "managed"),
    binDir: path.join(root, "bin"),
    pluginDir: path.join(root, "plugins"),
    tools: ["alpha"],
  };
  return {
    root,
    source,
    options,
    checkout: path.join(options.stateDir, "checkout"),
  };
}
async function advance(source) {
  await writeFile(path.join(source, "new.txt"), "upstream");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "test: upstream advance");
}

test("install/check/update preserve selection; directory plugin and uninstall work offline", async (t) => {
  const { source, options, checkout } = await fixture(t);
  assert.deepEqual((await manage("install", options)).selected, ["alpha"]);
  assert.equal(
    await readlink(path.join(options.binDir, "alpha")),
    path.join(checkout, "packages/alpha/cli.js"),
  );
  assert.equal(
    (await exec(path.join(options.binDir, "alpha"))).stdout.trim(),
    "fixture",
  );
  assert.equal((await manage("status", options)).problem, undefined);
  await advance(source);
  const old = await git(checkout, "rev-parse", "HEAD");
  assert.equal((await manage("check", options)).updateAvailable, true);
  assert.equal(await git(checkout, "rev-parse", "HEAD"), old);
  assert.deepEqual((await manage("update", options)).selected, ["alpha"]);
  await assert.rejects(lstat(path.join(options.binDir, "beta")), {
    code: "ENOENT",
  });
  await manage("install", { ...options, tools: ["@fixture/beta"] });
  assert.equal(
    (await lstat(path.join(options.pluginDir, "beta"))).isSymbolicLink(),
    true,
  );
  await manage("uninstall", { ...options, tools: ["alpha"] });
  await assert.rejects(lstat(path.join(options.binDir, "alpha")), {
    code: "ENOENT",
  });
  assert.deepEqual(
    (await manage("uninstall", { ...options, tools: [] })).selected,
    [],
  );
  assert.equal((await lstat(checkout)).isDirectory(), true);
});

test("dirty checkout refuses update before fetch and preserves changes", async (t) => {
  const { options, checkout } = await fixture(t);
  await manage("install", options);
  await writeFile(path.join(checkout, "local.txt"), "keep me");
  await assert.rejects(manage("update", options), /dirty/);
  assert.equal(
    await readFile(path.join(checkout, "local.txt"), "utf8"),
    "keep me",
  );
  await assert.rejects(lstat(path.join(checkout, ".git/FETCH_HEAD")), {
    code: "ENOENT",
  });
});

test("file plugins are loadable regular modules and follow updated builds", async (t) => {
  const { source, options } = await fixture(t);
  options.stateDir += " with 'quotes #";
  const buildFile = path.join(source, "packages/alpha/build.js");
  for (const version of ["before", "after"]) {
    await writeFile(
      buildFile,
      `import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await writeFile('dist/plugin.js', ${JSON.stringify('export const description = "fixture plugin"; export default amp => amp.registerTool({ execute: () => ' + JSON.stringify(version) + " });")});`,
    );
    await git(source, "add", ".");
    await git(source, "commit", "-m", `test: ${version} plugin build`);
    await manage(version === "before" ? "install" : "update", options);
    const entry = path.join(options.pluginDir, "alpha.js");
    assert.equal((await lstat(entry)).isFile(), true);
    const { stdout } = await exec(process.execPath, [
      "--input-type=module",
      "-e",
      `import { pathToFileURL } from 'node:url';
const plugin = await import(pathToFileURL(${JSON.stringify(entry)}));
const tools = []; plugin.default({ registerTool: tool => tools.push(tool) });
console.log(JSON.stringify({ description: plugin.description, value: tools[0].execute() }));`,
    ]);
    assert.deepEqual(JSON.parse(stdout), {
      description: "fixture plugin",
      value: version,
    });
  }
  assert.equal((await manage("status", options)).problem, undefined);
  await manage("uninstall", options);
  await assert.rejects(lstat(path.join(options.pluginDir, "alpha.js")), {
    code: "ENOENT",
  });
});

test("update migrates recorded legacy plugin symlinks without adopting unrelated files", async (t) => {
  const { options, checkout } = await fixture(t);
  await manage("install", options);
  const stateFile = path.join(options.stateDir, "state.json");
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const entry = path.join(options.pluginDir, "alpha.js");
  const link = state.links.find((item) => item.destination === entry);
  await unlink(entry);
  await symlink(link.target, entry);
  delete link.kind;
  await writeFile(stateFile, JSON.stringify(state));
  const unrelated = path.join(options.pluginDir, "personal.js");
  await writeFile(unrelated, "personal configuration");
  assert.equal((await manage("status", options)).problem, undefined);
  await manage("update", options);
  assert.equal((await lstat(entry)).isFile(), true);
  assert.equal(await readFile(unrelated, "utf8"), "personal configuration");
  assert.equal(
    await readlink(path.join(options.binDir, "alpha")),
    path.join(checkout, "packages/alpha/cli.js"),
  );
});

test("local divergent commits and rewritten upstream history are refused", async (t) => {
  const { source, options, checkout } = await fixture(t);
  await manage("install", options);
  await advance(source);
  await writeFile(path.join(checkout, "local.txt"), "local");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-m", "test: local commit");
  const local = await git(checkout, "rev-parse", "HEAD");
  await assert.rejects(manage("update", options), /unrecognized local commits/);
  assert.equal(await git(checkout, "rev-parse", "HEAD"), local);
});

test("upstream divergence refuses merge without changing checkout", async (t) => {
  const { source, options, checkout } = await fixture(t);
  await manage("install", options);
  await git(
    source,
    "commit",
    "--amend",
    "--allow-empty",
    "-m",
    "test: rewritten upstream",
  );
  const before = await git(checkout, "rev-parse", "HEAD");
  await assert.rejects(manage("update", options), /failed|diverged/);
  assert.equal(await git(checkout, "rev-parse", "HEAD"), before);
});

for (const kind of ["file", "symlink"])
  test(`unmanaged ${kind} collision is preserved`, async (t) => {
    const { options } = await fixture(t);
    await mkdir(options.binDir);
    const destination = path.join(options.binDir, "alpha");
    if (kind === "file") await writeFile(destination, "mine");
    else await symlink("/nonexistent-fixture-target", destination);
    await assert.rejects(manage("install", options), /collision/);
    assert.equal(
      kind === "file"
        ? await readFile(destination, "utf8")
        : await readlink(destination),
      kind === "file" ? "mine" : "/nonexistent-fixture-target",
    );
  });

test("overwritten owned links block update and uninstall", async (t) => {
  const { options } = await fixture(t);
  await manage("install", options);
  const destination = path.join(options.pluginDir, "alpha.js");
  await unlink(destination);
  await writeFile(destination, "replacement");
  await assert.rejects(manage("update", options), /overwritten/);
  await assert.rejects(manage("uninstall", options), /overwritten/);
  assert.equal(await readFile(destination, "utf8"), "replacement");
});

test("origin changes and local source use without opt-in are refused", async (t) => {
  const { options, checkout } = await fixture(t);
  await manage("install", options);
  await assert.rejects(
    manage("update", { ...options, allowLocalSource: false }),
    /Source must/,
  );
  await git(checkout, "remote", "set-url", "origin", "/different/local/repo");
  await assert.rejects(manage("update", options), /Unrecognized source/);
});

test("credential URLs and package traversal are rejected", async (t) => {
  for (const url of [
    "https://token@github.com/owner/repo",
    "https://github.com/owner/repo?token=secret",
    "file:///tmp/repo",
    "ext::evil",
  ])
    assert.throws(() => validateSource(url), /Source must/);
  const { source } = await fixture(t);
  const manifestFile = path.join(source, "packages/alpha/package.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.agentTools.plugin = "../../outside.js";
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(discover(source), /Unsafe package path/);
  manifest.agentTools.plugin = "escaped/plugin.js";
  await writeFile(manifestFile, JSON.stringify(manifest));
  await symlink(
    path.dirname(source),
    path.join(source, "packages/alpha/escaped"),
  );
  await assert.rejects(discover(source), /symlink escapes/);
});

test("status and plugin startup do not initialize installation or fetch", async (t) => {
  const { options } = await fixture(t);
  assert.equal((await manage("status", options)).installed, false);
  await assert.rejects(lstat(options.stateDir), { code: "ENOENT" });
  const tools = [];
  plugin({ registerTool: (tool) => tools.push(tool) });
  assert.equal(tools.length, 5);
  assert.equal(typeof tools[0].execute, "function");
  await assert.rejects(lstat(options.stateDir), { code: "ENOENT" });
});

test("CLI-only packages install without a fabricated plugin", async (t) => {
  const { source, options } = await fixture(t);
  const file = path.join(source, "packages/alpha/package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  delete manifest.agentTools;
  await writeFile(file, JSON.stringify(manifest));
  await git(source, "add", ".");
  await git(source, "commit", "-m", "test: CLI-only package");
  assert.deepEqual((await manage("install", options)).selected, ["alpha"]);
  assert.equal(
    (await exec(path.join(options.binDir, "alpha"))).stdout.trim(),
    "fixture",
  );
  await assert.rejects(lstat(path.join(options.pluginDir, "alpha.js")), {
    code: "ENOENT",
  });
  assert.equal((await manage("status", options)).problem, undefined);
  await manage("uninstall", options);
  await assert.rejects(lstat(path.join(options.binDir, "alpha")), {
    code: "ENOENT",
  });
});

test("operation lock and unrecognized checkout prevent adoption", async (t) => {
  const { options, checkout } = await fixture(t);
  await mkdir(checkout, { recursive: true });
  await assert.rejects(
    manage("install", options),
    /Unrecognized existing checkout/,
  );
  await mkdir(path.join(options.stateDir, "operation.lock"));
  await assert.rejects(manage("install", options), /Another tools operation/);
});

test("failed build reports separate checkout and built revisions and can be retried", async (t) => {
  const { source, options, checkout } = await fixture(t);
  await manage("install", options);
  const before = await git(checkout, "rev-parse", "HEAD");
  const buildFile = path.join(source, "packages/alpha/build.js");
  const goodBuild = await readFile(buildFile, "utf8");
  await writeFile(buildFile, "process.exit(13);");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "test: failing build");
  await assert.rejects(manage("update", options), /npm.*failed/);
  const status = await manage("status", options);
  assert.equal(status.builtRevision, before);
  assert.notEqual(status.revision, before);
  assert.deepEqual(status.selected, ["alpha"]);
  await writeFile(
    buildFile,
    goodBuild +
      "\nawait import('node:fs/promises').then(fs => fs.chmod('cli.js', 0o644));",
  );
  await git(source, "add", ".");
  await git(source, "commit", "-m", "test: repair build");
  await manage("update", options);
  assert.equal(
    (await exec(path.join(options.binDir, "alpha"))).stdout.trim(),
    "fixture",
  );
  const repaired = await manage("status", options);
  assert.equal(repaired.revision, repaired.builtRevision);
});

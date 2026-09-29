import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";

export const DEFAULT_SOURCE = "https://github.com/lordbagel42/agent-tools.git";
const exec = promisify(execFile);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const exists = async (file) => {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const inside = (root, file) =>
  file !== root &&
  !path.relative(root, file).startsWith(".." + path.sep) &&
  path.relative(root, file) !== ".." &&
  !path.isAbsolute(path.relative(root, file));
const safeName = (name) =>
  typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);

export function validateSource(source, allowLocalSource = false) {
  // eslint-disable-next-line no-control-regex -- Reject control characters in source URLs.
  if (typeof source !== "string" || /[\x00-\x20\x7f]/.test(source))
    throw new Error("Invalid source");
  if (allowLocalSource && path.isAbsolute(source)) return path.resolve(source);
  // Reject credentials, query tokens, URL helpers, SSH commands and URL rewrites.
  if (
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
      source,
    )
  ) {
    throw new Error(
      "Source must be a credential-free https://github.com/OWNER/REPO URL (or explicitly allowed absolute local fixture path)",
    );
  }
  return source;
}

function configuration(options) {
  const data =
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local/share");
  const config = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const stateDir = path.resolve(
    options.stateDir ||
      process.env.AGENT_TOOLS_HOME ||
      path.join(data, "agent-tools"),
  );
  return {
    stateDir,
    checkout: path.join(stateDir, "checkout"),
    stateFile: path.join(stateDir, "state.json"),
    binDir: path.resolve(options.binDir || path.join(homedir(), ".local/bin")),
    pluginDir: path.resolve(
      options.pluginDir || path.join(config, "amp/plugins"),
    ),
  };
}

async function run(command, args, cwd) {
  try {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    const { stdout } = await exec(command, args, {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
    return stdout.trim();
  } catch (error) {
    // Do not echo subprocess output: remotes/dependencies could include credentials.
    throw new Error(
      `${command} ${args[0]} failed (exit ${error.code}); inspect the managed checkout locally`,
    );
  }
}
const git = (cwd, ...args) =>
  run("git", ["-c", "core.hooksPath=/dev/null", ...args], cwd);

async function safePath(root, relative, requireExists = false) {
  if (
    typeof relative !== "string" ||
    !relative ||
    path.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.split("/").some((part) => part === "..") ||
    // eslint-disable-next-line no-control-regex -- Package paths cannot contain controls.
    /[\x00-\x1f]/.test(relative)
  )
    throw new Error("Unsafe package path");
  const target = path.resolve(root, relative);
  if (!inside(root, target))
    throw new Error("Package path escapes its workspace");
  // Check existing ancestors too, including missing build outputs below symlinks.
  let ancestor = target;
  while (!(await exists(ancestor))) ancestor = path.dirname(ancestor);
  const actual = await realpath(ancestor);
  const actualRoot = await realpath(root);
  if (actual !== actualRoot && !inside(actualRoot, actual))
    throw new Error("Package symlink escapes its workspace");
  if (requireExists && !(await exists(target)))
    throw new Error(`Missing built artifact: ${relative}`);
  return target;
}

export async function discover(checkout) {
  const root = await json(path.join(checkout, "package.json"));
  const workspaces = Array.isArray(root.workspaces)
    ? root.workspaces
    : root.workspaces?.packages;
  if (!Array.isArray(workspaces) || !workspaces.includes("packages/*"))
    throw new Error("Expected root workspaces packages/*");
  const packagesDir = await safePath(checkout, "packages", true);
  const result = [];
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!safeName(entry.name)) throw new Error("Unsafe workspace name");
    const directory = await safePath(checkout, `packages/${entry.name}`, true);
    const manifestFile = await safePath(directory, "package.json", true);
    const manifest = await json(manifestFile);
    if (!manifest.agentTools?.plugin && !manifest.bin) continue;
    if (
      typeof manifest.name !== "string" ||
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)
    )
      throw new Error("Unsafe package name");
    const bins =
      typeof manifest.bin === "string"
        ? { [manifest.name.split("/").at(-1)]: manifest.bin }
        : manifest.bin || {};
    if (typeof bins !== "object" || Array.isArray(bins))
      throw new Error("Invalid bin mapping");
    for (const [name, value] of Object.entries(bins)) {
      if (!safeName(name)) throw new Error("Unsafe bin name");
      await safePath(directory, value);
    }
    const plugin = manifest.agentTools?.plugin;
    if (plugin !== undefined) await safePath(directory, plugin);
    result.push({
      id: entry.name,
      name: manifest.name,
      directory,
      bins,
      plugin,
    });
  }
  return result;
}

async function plannedLinks(checkout, selected, dirs, built = false) {
  const packages = await discover(checkout);
  const links = [];
  for (const id of selected) {
    const pkg = packages.find((item) => item.id === id || item.name === id);
    if (!pkg) throw new Error(`Unknown selected tool: ${id}`);
    for (const [name, relative] of Object.entries(pkg.bins)) {
      const target = await safePath(pkg.directory, relative, built);
      if (built && !(await lstat(target)).isFile())
        throw new Error("CLI artifact must be a regular file");
      links.push({
        destination: path.join(dirs.binDir, name),
        target,
        executable: true,
      });
    }
    if (pkg.plugin === undefined) continue;
    const target = await safePath(pkg.directory, pkg.plugin, built);
    // Before build, infer file plugins by extension; verify shape after build.
    const filePlugin = /\.(?:[cm]?js|ts)$/.test(pkg.plugin);
    if (built) {
      const stat = await lstat(target);
      if (filePlugin ? !stat.isFile() : !stat.isDirectory())
        throw new Error("Plugin artifact has unexpected shape");
      if (
        !filePlugin &&
        !(await exists(path.join(target, "index.js"))) &&
        !(await exists(path.join(target, "index.ts")))
      )
        throw new Error("Directory plugin requires index.js or index.ts");
    }
    links.push({
      destination: path.join(
        dirs.pluginDir,
        pkg.id + (filePlugin ? path.extname(pkg.plugin) : ""),
      ),
      target,
      ...(filePlugin ? { kind: "module" } : {}),
    });
  }
  if (new Set(links.map((link) => link.destination)).size !== links.length)
    throw new Error("Selected tools have colliding links");
  return links;
}

function pluginEntry(target) {
  const url = JSON.stringify(pathToFileURL(target).href);
  return `// Managed by agent-tools; keep machine configuration outside this file.\nexport { default } from ${url};\nexport * from ${url};\n`;
}

async function ownedLinks(links) {
  for (const link of links) {
    const stat = await exists(link.destination);
    const owned =
      link.kind === "module"
        ? stat?.isFile() &&
          (await readFile(link.destination, "utf8")) ===
            pluginEntry(link.target)
        : stat?.isSymbolicLink() &&
          (await readlink(link.destination)) === link.target;
    if (!owned)
      throw new Error(
        `Managed link missing or overwritten: ${link.destination}`,
      );
  }
}
async function preflight(previous, next) {
  await ownedLinks(previous);
  for (const link of next) {
    if (
      !previous.some((old) => old.destination === link.destination) &&
      (await exists(link.destination))
    )
      throw new Error(`Link collision: ${link.destination}`);
  }
}

async function save(file, state) {
  const temp = file + ".tmp";
  await writeFile(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}

async function inspect(checkout, state, options) {
  validateSource(state.source, options.allowLocalSource);
  const raw = await git(checkout, "config", "--get-all", "remote.origin.url");
  const effective = await git(checkout, "remote", "get-url", "--all", "origin");
  if (raw !== state.source || effective !== state.source)
    throw new Error("Unrecognized source: origin changed or rewritten");
  if (
    (await git(checkout, "rev-parse", "--show-toplevel")) !==
    (await realpath(checkout))
  )
    throw new Error("Not the managed checkout");
  if ((await git(checkout, "symbolic-ref", "--short", "HEAD")) !== state.branch)
    throw new Error("Managed branch changed");
  if (await git(checkout, "status", "--porcelain", "--untracked-files=all"))
    throw new Error(
      "Managed checkout is dirty; preserve and resolve changes manually",
    );
  if ((await git(checkout, "rev-parse", "HEAD")) !== state.checkoutRevision)
    throw new Error(
      "Managed checkout has unrecognized local commits (possibly diverged)",
    );
  await ownedLinks(state.links);
}

async function reconcile(config, state, next) {
  await preflight(state.links, next);
  for (const old of [...state.links]) {
    if (
      next.some(
        (link) =>
          link.destination === old.destination &&
          link.target === old.target &&
          link.kind === old.kind,
      )
    )
      continue;
    await ownedLinks([old]);
    await unlink(old.destination);
    state.links = state.links.filter(
      (link) => link.destination !== old.destination,
    );
    await save(config.stateFile, state);
  }
  for (const link of next) {
    if (link.executable) {
      const stat = await lstat(link.target);
      await chmod(link.target, stat.mode | 0o111);
    }
    if (state.links.some((old) => old.destination === link.destination))
      continue;
    await mkdir(path.dirname(link.destination), { recursive: true });
    if (link.kind === "module")
      await writeFile(link.destination, pluginEntry(link.target), {
        flag: "wx",
        mode: 0o600,
      });
    else await symlink(link.target, link.destination);
    state.links.push(link);
    await save(config.stateFile, state);
  }
}

function applyState(config, state, options) {
  if (!state) return;
  if (
    state.version !== 1 ||
    !Array.isArray(state.links) ||
    !Array.isArray(state.selected) ||
    !state.selected.every(safeName) ||
    typeof state.branch !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(state.branch) ||
    state.branch.includes("..") ||
    !/^[a-f0-9]{40,64}$/.test(state.checkoutRevision)
  )
    throw new Error("Unrecognized managed state");
  validateSource(state.source, options.allowLocalSource);
  if (options.source && options.source !== state.source)
    throw new Error("Source does not match installed source");
  if (options.branch && options.branch !== state.branch)
    throw new Error("Branch does not match installed branch");
  for (const key of ["binDir", "pluginDir"]) {
    if (typeof state[key] !== "string" || !path.isAbsolute(state[key]))
      throw new Error("Unrecognized managed destinations");
    if (options[key] && path.resolve(options[key]) !== state[key])
      throw new Error("Destination differs from installed configuration");
    config[key] = state[key];
  }
  for (const link of state.links) {
    if (
      typeof link.destination !== "string" ||
      typeof link.target !== "string" ||
      (link.kind !== undefined && link.kind !== "module") ||
      (link.kind === "module" &&
        (path.dirname(link.destination) !== config.pluginDir ||
          link.executable)) ||
      ![config.binDir, config.pluginDir].includes(
        path.dirname(link.destination),
      ) ||
      !safeName(path.basename(link.destination)) ||
      !path.isAbsolute(link.target) ||
      !inside(path.join(config.checkout, "packages"), path.resolve(link.target))
    )
      throw new Error("Unrecognized managed link state");
  }
}

export async function manage(command, options = {}) {
  if (!["status", "check", "install", "update", "uninstall"].includes(command))
    throw new Error("Expected status, check, install, update or uninstall");
  const config = configuration(options);
  let state = (await exists(config.stateFile))
    ? await json(config.stateFile)
    : null;
  applyState(config, state, options);
  if (command === "status") {
    if (!state)
      return {
        installed: false,
        stateDir: config.stateDir,
        recommendation: "Run tools install explicitly to clone and build.",
      };
    let problem;
    try {
      await inspect(config.checkout, state, options);
    } catch (error) {
      problem = error.message;
    }
    return {
      installed: state.selected.length > 0,
      source: state.source,
      selected: state.selected,
      revision: state.checkoutRevision,
      builtRevision: state.builtRevision,
      problem,
      recommendation: "Run tools check explicitly to fetch update information.",
    };
  }
  await mkdir(config.stateDir, { recursive: true });
  const lock = path.join(config.stateDir, "operation.lock");
  try {
    await mkdir(lock);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another tools operation holds operation.lock; after a crash, inspect before removing this empty lock directory",
      );
    throw error;
  }
  try {
    // Reload under the lock, preventing concurrent callers from using stale state.
    state = (await exists(config.stateFile))
      ? await json(config.stateFile)
      : null;
    applyState(config, state, options);
    if (!state) {
      if (command !== "install")
        throw new Error("No managed installation; run tools install first");
      if (await exists(config.checkout))
        throw new Error("Unrecognized existing checkout; refusing to adopt it");
      const source = validateSource(
        options.source || DEFAULT_SOURCE,
        options.allowLocalSource,
      );
      const branch = options.branch || "main";
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
        branch.includes("..") ||
        branch.endsWith("/")
      )
        throw new Error("Unsafe branch");
      await git(
        config.stateDir,
        "clone",
        "--no-local",
        "--single-branch",
        "--branch",
        branch,
        "--",
        source,
        config.checkout,
      );
      state = {
        version: 1,
        source,
        branch,
        binDir: config.binDir,
        pluginDir: config.pluginDir,
        selected: [],
        links: [],
        checkoutRevision: await git(config.checkout, "rev-parse", "HEAD"),
        builtRevision: null,
      };
      await save(config.stateFile, state);
    }
    await inspect(config.checkout, state, options);
    if (command === "uninstall") {
      const remove = options.tools?.length ? options.tools : state.selected;
      const packages = await discover(config.checkout);
      const ids = remove.map(
        (name) =>
          packages.find((pkg) => pkg.id === name || pkg.name === name)?.id ||
          name,
      );
      const remaining = state.selected.filter((id) => !ids.includes(id));
      await reconcile(
        config,
        state,
        await plannedLinks(config.checkout, remaining, config, true),
      );
      state.selected = remaining;
      await save(config.stateFile, state);
      return { selected: remaining, retainedCheckout: config.checkout };
    }
    if (command === "check" || command === "update") {
      // Explicit source/ref avoids trusting arbitrary remote fetch refspecs.
      await git(
        config.checkout,
        "fetch",
        "--no-tags",
        "--",
        state.source,
        `refs/heads/${state.branch}`,
      );
      const remote = await git(config.checkout, "rev-parse", "FETCH_HEAD");
      const base = await git(config.checkout, "merge-base", "HEAD", remote);
      if (base !== state.checkoutRevision)
        throw new Error(
          "Upstream diverged or moved backwards; refusing non-fast-forward update",
        );
      if (command === "check")
        return {
          revision: state.checkoutRevision,
          availableRevision: remote,
          updateAvailable: remote !== state.checkoutRevision,
        };
      await git(config.checkout, "merge", "--ff-only", "--no-edit", remote);
      state.checkoutRevision = remote;
      await save(config.stateFile, state);
    }
    const packages = await discover(config.checkout);
    let selected = state.selected;
    if (command === "install") {
      const requested = options.tools?.length
        ? options.tools
        : packages.map((pkg) => pkg.id);
      const ids = requested.map((name) => {
        const pkg = packages.find(
          (item) => item.id === name || item.name === name,
        );
        if (!pkg) throw new Error(`Unknown selected tool: ${name}`);
        return pkg.id;
      });
      selected = [...new Set([...selected, ...ids])];
    }
    await preflight(
      state.links,
      await plannedLinks(config.checkout, selected, config),
    );
    await run(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      config.checkout,
    );
    // Build selected workspaces only; dependency lifecycle scripts remain disabled.
    for (const id of selected)
      await run(
        "npm",
        [
          "--ignore-scripts",
          "run",
          "build",
          "--if-present",
          "--workspace",
          `packages/${id}`,
        ],
        config.checkout,
      );
    const next = await plannedLinks(config.checkout, selected, config, true);
    await reconcile(config, state, next);
    state.selected = selected;
    state.builtRevision = state.checkoutRevision;
    await save(config.stateFile, state);
    return {
      selected,
      revision: state.checkoutRevision,
      binDir: config.binDir,
      pluginDir: config.pluginDir,
    };
  } finally {
    await rmdir(lock);
  }
}

import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { hashPin } from "./auth.js";

export function defaultPaths(env = process.env) {
  const home = env.HOME || homedir();
  const stateDir = join(
    env.XDG_STATE_HOME || join(home, ".local/state"),
    "portal",
  );
  return {
    configPath:
      env.PORTAL_CONFIG ||
      join(env.XDG_CONFIG_HOME || join(home, ".config"), "portal/config.json"),
    stateDir,
    socketPath: env.PORTAL_SOCKET || join(stateDir, "control.sock"),
  };
}

export function validatePrefix(config) {
  if (config.idPrefix === undefined) config.idPrefix = "p-";
  if (
    typeof config.idPrefix !== "string" ||
    !/^[a-z][a-z0-9]{0,15}-$/.test(config.idPrefix)
  )
    throw new Error("Invalid portal ID prefix");
}

export async function loadConfig(path = defaultPaths().configPath) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function initConfig(options, pin) {
  const defaults = defaultPaths();
  const configPath = options.config || defaults.configPath;
  const stateDir = options["state-dir"] || defaults.stateDir;
  const socketPath =
    options.socket ||
    process.env.PORTAL_SOCKET ||
    join(stateDir, "control.sock");
  const domain = options.domain;
  const config = {
    domain,
    loginHost: options["login-host"] || `login.${domain}`,
    idPrefix: options["id-prefix"],
    stateDir,
    socketPath,
    bindHost: "127.0.0.1",
    port: options.port === undefined ? 8787 : Number(options.port),
    workspaceRoot: options.workspace,
  };
  validatePrefix(config);
  if (
    !domain ||
    !/^[a-z0-9.-]+$/.test(domain) ||
    !/^[a-z0-9.-]+$/.test(config.loginHost)
  )
    throw new Error("Valid --domain and --login-host required");
  if (
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535
  )
    throw new Error("Port must be between 1024 and 65535");
  if (
    ![configPath, stateDir, socketPath, config.workspaceRoot].every(
      (path) => typeof path === "string" && isAbsolute(path),
    )
  )
    throw new Error(
      "Config, state, socket and workspace paths must be absolute",
    );
  config.workspaceRoot = await realpath(config.workspaceRoot);
  const pinHash = await hashPin(pin);
  config.signingKey = randomBytes(32).toString("hex");
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  // Exclusive creation: init must never rotate existing credentials or state.
  const file = await open(configPath, "wx", 0o600);
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(
      join(stateDir, "shared-pin.json"),
      JSON.stringify(pinHash) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await file.writeFile(JSON.stringify(config, null, 2) + "\n");
  } catch (error) {
    await unlink(configPath);
    throw error;
  } finally {
    await file.close();
  }
  return { initialized: true, configPath };
}

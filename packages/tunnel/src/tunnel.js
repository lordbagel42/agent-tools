import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  lstat,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const safeName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function validate(input) {
  if (!["local", "reverse"].includes(input.direction))
    throw new Error("direction must be local or reverse");
  if (
    typeof input.destination !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]{0,253}$/.test(input.destination)
  )
    throw new Error(
      "destination must be an SSH config alias or [user@]hostname",
    );
  for (const key of ["listenPort", "targetPort"]) {
    if (
      !Number.isInteger(input[key]) ||
      input[key] < (key === "listenPort" ? 1024 : 1) ||
      input[key] > 65535
    )
      throw new Error(
        `${key} is not a valid unprivileged listen port or target port`,
      );
  }
  if (input.direction === "reverse" && input.remoteLoopbackConfirmed !== true)
    throw new Error(
      "Reverse forwarding requires remoteLoopbackConfirmed: verify the SSH server has GatewayPorts no or clientspecified (not yes) first",
    );
  return {
    direction: input.direction,
    destination: input.destination,
    listenPort: input.listenPort,
    targetPort: input.targetPort,
  };
}

export function sshArgs(spec, socket) {
  return [
    "-N",
    "-T",
    "-M",
    "-S",
    socket,
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=no",
    "-o",
    "ForkAfterAuthentication=no",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ConnectionAttempts=1",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    "-o",
    "PermitLocalCommand=no",
    "-o",
    "ClearAllForwardings=yes",
    spec.direction === "local" ? "-L" : "-R",
    `127.0.0.1:${spec.listenPort}:127.0.0.1:${spec.targetPort}`,
    spec.destination,
  ];
}

// Each dedicated master starts WITHOUT forwards; -O forward adds exactly our
// requested listener. ClearAllForwardings suppresses unrelated SSH config forwards.
export class Tunnels {
  constructor({
    root = join(homedir(), ".agent-tools-tunnel"),
    ssh = "ssh",
    timeoutMs = 15000,
  } = {}) {
    this.root = root;
    this.ssh = ssh;
    this.timeoutMs = timeoutMs;
  }
  async privateDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o077
    )
      throw new Error(
        `State directory must be owned by you and mode 0700: ${path}`,
      );
  }
  async scope(owner) {
    if (typeof owner !== "string" || !owner.trim() || owner.length > 256)
      throw new Error("An explicit owner/thread is required");
    await this.privateDir(this.root);
    const path = join(this.root, hash(owner));
    await this.privateDir(path);
    return path;
  }
  async paths(owner, name) {
    if (!safeName.test(name ?? ""))
      throw new Error(
        "name must be 1–64 letters, digits, dots, underscores or hyphens",
      );
    const scope = await this.scope(owner);
    const base = join(scope, hash(name));
    if (Buffer.byteLength(`${base}.sock`) > 100)
      throw new Error(
        "State path too long for an OpenSSH control socket; use a shorter private TUNNEL_STATE_DIR",
      );
    return {
      base,
      socket: `${base}.sock`,
      record: `${base}.json`,
      lock: `${base}.lock`,
    };
  }
  async control(paths, command, extra = [], signal) {
    return exec(
      this.ssh,
      [
        "-F",
        "/dev/null",
        "-S",
        paths.socket,
        "-o",
        "BatchMode=yes",
        "-O",
        command,
        ...extra,
        "tunnel-control",
      ],
      {
        timeout: 2000,
        maxBuffer: 8192,
        signal,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
  }
  async alive(paths) {
    try {
      await lstat(paths.socket);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    try {
      await this.control(paths, "check");
      return true;
    } catch (error) {
      if (
        !error.killed &&
        /Control socket connect.*(?:No such file|Connection refused)/.test(
          error.stderr ?? "",
        )
      )
        return false;
      throw new Error(
        "Cannot verify SSH control socket; refusing to discard potentially live state",
        { cause: error },
      );
    }
  }
  async locked(paths, fn) {
    try {
      await mkdir(paths.lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error(
          "Tunnel operation locked; retry later. If interrupted, inspect and remove its .lock directory manually.",
        );
      throw error;
    }
    try {
      return await fn();
    } finally {
      await rm(paths.lock, { recursive: true, force: true });
    }
  }
  async start(owner, name, input, signal) {
    const spec = validate(input);
    const paths = await this.paths(owner, name);
    return this.locked(paths, async () => {
      signal?.throwIfAborted();
      if (await this.alive(paths))
        throw new Error(
          "Tunnel already running; stop it before changing its definition",
        );
      await rm(paths.socket, { force: true });
      const record = {
        name,
        owner,
        ...spec,
        createdAt: new Date().toISOString(),
      };
      await writeFile(paths.record, JSON.stringify(record), {
        mode: 0o600,
        flag: "w",
      });
      const args = sshArgs(spec, paths.socket);
      // -O forward is acknowledged by the server for reverse forwards, unlike
      // merely observing a local TCP port or a newly created control socket.
      args.splice(-3, 2);
      const child = spawn(this.ssh, args, { detached: true, stdio: "ignore" });
      let spawnError;
      child.on("error", (error) => {
        spawnError = error;
      });
      const deadline = Date.now() + this.timeoutMs;
      try {
        while (true) {
          signal?.throwIfAborted();
          if (spawnError) throw spawnError;
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(
              "SSH exited: check reachability, known_hosts and noninteractive SSH authentication",
            );
          if (Date.now() >= deadline)
            throw new Error("SSH readiness timed out");
          if (await this.alive(paths)) break;
          await delay(80, undefined, { signal });
        }
        signal?.throwIfAborted();
        await this.control(
          paths,
          "forward",
          [
            spec.direction === "local" ? "-L" : "-R",
            `127.0.0.1:${spec.listenPort}:127.0.0.1:${spec.targetPort}`,
          ],
          signal,
        );
        signal?.throwIfAborted();
        child.unref();
        return {
          ...record,
          state: "running",
          readiness: "SSH forwarding established; target service not probed",
        };
      } catch (error) {
        // Only a live child handle, never a PID read from disk (PID reuse safe).
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await rm(paths.record, { force: true });
        throw error;
      }
    });
  }
  async status(owner, name) {
    const paths = await this.paths(owner, name);
    let record;
    try {
      record = JSON.parse(await readFile(paths.record, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { name, state: "missing" };
      throw error;
    }
    return {
      ...record,
      state: (await this.alive(paths)) ? "running" : "stale",
    };
  }
  async list(owner) {
    const scope = await this.scope(owner);
    const results = [];
    for (const file of await readdir(scope)) {
      if (!file.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await readFile(join(scope, file), "utf8"));
        results.push(await this.status(owner, record.name));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return results;
  }
  async stop(owner, name) {
    const paths = await this.paths(owner, name);
    return this.locked(paths, async () => {
      if (await this.alive(paths)) {
        await this.control(paths, "exit");
        const deadline = Date.now() + 3000;
        while (await this.alive(paths)) {
          if (Date.now() > deadline)
            throw new Error("SSH stop not confirmed; state retained");
          await delay(50);
        }
      }
      await rm(paths.record, { force: true });
      await rm(paths.socket, { force: true });
      return { name, state: "stopped" };
    });
  }
}

import { mkdir, readFile, writeFile, rename, realpath } from "node:fs/promises";
import { join, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer, connect } from "node:net";
import { once, EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { hashPin, verifyPin } from "./auth.js";

const fields = new Set([
  "action",
  "thread",
  "name",
  "cwd",
  "command",
  "port",
  "pin",
]);
const leaseMs = 24 * 3600_000;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(200, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export class PortalManager extends EventEmitter {
  constructor(config, auth) {
    super();
    this.config = config;
    this.auth = auth;
    this.records = new Map();
    this.runtime = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
    this.stateFile = join(config.stateDir, "portals.json");
  }

  async init() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.config.workspaceRoot);
    let records;
    try {
      records = JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      records = [];
    }
    for (const record of records) {
      if (record.expires <= Date.now()) continue;
      this.records.set(record.id, record);
      if (record.command) this.launch(record);
    }
    this.reaper = setInterval(
      () =>
        this.enqueue(() => this.expire()).catch((error) =>
          console.error("Portal expiry failed:", error.message),
        ),
      30_000,
    );
    this.reaper.unref();
  }

  async save(records = this.records.values()) {
    await writeFile(this.stateFile + ".tmp", JSON.stringify([...records]), {
      mode: 0o600,
    });
    await rename(this.stateFile + ".tmp", this.stateFile);
  }

  enqueue(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  execute(input) {
    return this.enqueue(() => this.perform(input));
  }

  byHost(host) {
    return [...this.records.values()].find(
      (record) =>
        `${record.id}.${this.config.domain}` === host &&
        record.expires > Date.now(),
    );
  }

  public(record) {
    const { pinHash, ...publicRecord } = record;
    return {
      ...publicRecord,
      pinMode: pinHash ? "custom" : "shared",
      url: `https://${record.id}.${this.config.domain}`,
      managed: !!record.command,
    };
  }

  async status(record, wait = false) {
    const deadline =
      Date.now() + (wait ? (this.config.readinessMs ?? 30_000) : 0);
    let ready;
    do {
      const runtime = this.runtime.get(record.id);
      ready =
        (!record.command || !!runtime?.child) && (await listening(record.port));
      if (ready || Date.now() >= deadline) break;
      await delay(50);
    } while (!this.closed);
    return {
      ...this.public(record),
      ready,
      ...(!ready && {
        error:
          "Not responding on the assigned loopback port; inspect portal logs.",
      }),
    };
  }

  async perform(input) {
    if (this.closed) throw new Error("Service is shutting down");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected an object");
    for (const key of Object.keys(input))
      if (!fields.has(key)) throw new Error(`Unknown option: ${key}`);
    if (!/^T-[a-f0-9-]{36}$/i.test(input.thread ?? ""))
      throw new Error("Valid Amp thread ID required");
    await this.expire();
    if (input.action === "set-pin" && input.name === undefined) {
      await this.auth.setSharedPin(input.pin);
      for (const record of this.records.values())
        if (!record.pinHash) this.emit("removed", record.id);
      return { changed: true };
    }
    if (
      input.pin !== undefined &&
      !["start", "expose", "set-pin"].includes(input.action)
    )
      throw new Error("PIN is only accepted by start, expose or set-pin");
    if (input.action === "list")
      return Promise.all(
        [...this.records.values()]
          .filter((r) => r.thread === input.thread)
          .map((r) => this.status(r)),
      );
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.name ?? ""))
      throw new Error("Invalid portal name");
    let record = [...this.records.values()].find(
      (r) => r.thread === input.thread && r.name === input.name,
    );
    if (input.action === "start" || input.action === "expose") {
      if (
        input.port !== undefined &&
        (!Number.isInteger(input.port) ||
          input.port < 1024 ||
          input.port > 65535 ||
          input.port === this.config.port)
      )
        throw new Error("Invalid preview port");
      if (input.action === "expose" && input.port === undefined)
        throw new Error("expose requires a port");
      let cwd;
      if (input.action === "start") {
        if (
          typeof input.command !== "string" ||
          !input.command.trim() ||
          input.command.length > 8192
        )
          throw new Error("start requires a command");
        if (typeof input.cwd !== "string" || !isAbsolute(input.cwd))
          throw new Error("start requires an absolute workspace cwd");
        cwd = await realpath(input.cwd);
        if (cwd !== this.root && !cwd.startsWith(this.root + sep))
          throw new Error("cwd must be inside the workspace");
      } else if (input.command !== undefined || input.cwd !== undefined)
        throw new Error("expose accepts only a port");
      if (record) {
        if (
          (input.pin !== undefined &&
            !(
              record.pinHash && (await verifyPin(input.pin, record.pinHash))
            )) ||
          record.command !==
            (input.action === "start" ? input.command : undefined) ||
          record.cwd !== cwd ||
          (input.port !== undefined && input.port !== record.port)
        )
          throw new Error(
            "Portal already exists with another definition; stop it first",
          );
        record.expires = Date.now() + leaseMs;
      } else {
        if (this.records.size >= 100)
          throw new Error("Portal limit reached; stop unused portals");
        const port = input.port ?? (await freePort());
        if ([...this.records.values()].some((r) => r.port === port))
          throw new Error("Port is already registered by another portal");
        if (input.action === "start" && (await listening(port)))
          throw new Error("Requested port is already in use");
        record = {
          id: (this.config.idPrefix ?? "p-") + randomBytes(8).toString("hex"),
          thread: input.thread,
          name: input.name,
          port,
          expires: Date.now() + leaseMs,
          ...(input.pin !== undefined && { pinHash: await hashPin(input.pin) }),
          ...(cwd && { cwd, command: input.command }),
        };
        this.records.set(record.id, record);
        await this.save();
        if (record.command) this.launch(record);
      }
      await this.save();
      return this.status(record, true);
    }
    if (!record) throw new Error("Portal not found in this thread");
    switch (input.action) {
      case "set-pin": {
        const pinHash = await hashPin(input.pin);
        // Persist before changing live auth so a failed write leaves the old PIN usable.
        await this.save(
          [...this.records.values()].map((r) =>
            r === record ? { ...r, pinHash } : r,
          ),
        );
        record.pinHash = pinHash;
        this.emit("removed", record.id);
        return this.status(record);
      }
      case "status":
        return this.status(record);
      case "logs":
        return {
          ...this.public(record),
          logs: this.runtime.get(record.id)?.logs ?? "",
          note: "Last 64 KiB, since daemon startup. Exposed processes have no captured logs.",
        };
      case "login-url":
        return {
          url: `${this.public(record).url}/__portal/auth?ticket=${this.auth.ticket(record.id, record.pinHash)}`,
          expiresInSeconds: 60,
          sensitive: true,
        };
      case "restart":
        if (!record.command)
          throw new Error("Cannot restart a process this service does not own");
        await this.stopChild(record.id);
        this.launch(record);
        return this.status(record, true);
      case "stop":
        this.records.delete(record.id);
        this.emit("removed", record.id);
        await this.save();
        await this.stopChild(record.id);
        return { stopped: record.name };
      default:
        throw new Error("Unknown portal action");
    }
  }

  launch(record) {
    if (
      this.closed ||
      record.expires <= Date.now() ||
      !this.records.has(record.id)
    )
      return;
    const runtime = this.runtime.get(record.id) ?? { logs: "", failures: 0 };
    this.runtime.set(record.id, runtime);
    const child = spawn("/bin/bash", ["-lc", record.command], {
      cwd: record.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(record.port),
        PUBLIC_URL: this.public(record).url,
        AMP_THREAD_ID: record.thread,
        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `${record.id}.${this.config.domain}`,
      },
    });
    runtime.child = child;
    const log = (chunk) => {
      runtime.logs = (runtime.logs + chunk.toString()).slice(-65536);
    };
    child.stdout.on("data", log);
    child.stderr.on("data", log);
    child.once("error", (error) => log(`Process error: ${error.message}\n`));
    child.once("close", (code, signal) => {
      if (runtime.child !== child) return;
      signalGroup(child, "SIGKILL");
      runtime.child = undefined;
      log(`\nProcess exited: ${code ?? signal}\n`);
      if (!this.closed && this.records.has(record.id)) {
        runtime.timer = setTimeout(
          () => this.launch(record),
          Math.min(30_000, 1000 * 2 ** Math.min(runtime.failures++, 5)),
        );
      }
    });
  }

  async stopChild(id) {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    clearTimeout(runtime.timer);
    const child = runtime.child;
    runtime.child = undefined;
    if (child) {
      const exited = new Promise((resolve) => child.once("close", resolve));
      signalGroup(child, "SIGTERM");
      await Promise.race([exited, delay(1000)]);
      signalGroup(child, "SIGKILL");
      await exited;
    }
    this.runtime.delete(id);
  }

  async expire() {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.expires > Date.now()) continue;
      this.records.delete(record.id);
      changed = true;
      this.emit("removed", record.id);
      await this.stopChild(record.id);
    }
    if (changed) await this.save();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.reaper);
    await this.queue;
    await Promise.all([...this.runtime.keys()].map((id) => this.stopChild(id)));
  }
}

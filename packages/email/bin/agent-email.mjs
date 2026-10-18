#!/usr/bin/env node
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

const help = `agent-email watch --inbox NAME --webhook-url https://hooks.example.net/mail
  --config FILE     Private {url, headers: {authorization: "Bearer ..."}} JSON
                    Default: ~/.config/agent-tools/email.json (or XDG_CONFIG_HOME)
  --state-dir DIR   Private durable queue and subscription secrets
                    Default: ~/.local/state/agent-tools/email (or XDG_STATE_HOME)
  --port NUMBER    Loopback HTTP listener, default 8789
  --once           Exit after printing one mail event
  --timeout SEC    Exit 124 after this many seconds (otherwise wait indefinitely)
  --read           Include untrusted message contents via authenticated read_mail

Node 24+ required. Forward the approved public HTTPS URL to this loopback listener.
No tunnel, public exposure, allowlist change, forwarding, or OAuth login is automatic.
Subscriptions persist for restart recovery (up to 30 days); delete via MCP when done.
stdout is JSON lines only; diagnostics go to stderr. Deduplicate by event id across
crashes: output is at-least-once, not an exactly-once consumer acknowledgment.
`;

async function bytes(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw new RangeError("Body too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function main() {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      config: { type: "string" },
      inbox: { type: "string" },
      "webhook-url": { type: "string" },
      "state-dir": { type: "string" },
      port: { type: "string", default: "8789" },
      once: { type: "boolean" },
      timeout: { type: "string" },
      read: { type: "boolean" },
    },
  });
  if (args.help) {
    process.stdout.write(help);
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "watch")
    throw new Error("Use agent-email watch --help");
  const inbox = args.inbox?.toLowerCase();
  if (!inbox || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(inbox))
    throw new Error("Supply a valid --inbox local part");
  const target = new URL(args["webhook-url"] ?? "");
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.port
  )
    throw new Error(
      "Supply a plain approved HTTPS --webhook-url without credentials, port, query or fragment",
    );
  const port = Number(args.port),
    timeout = args.timeout === undefined ? 0 : Number(args.timeout);
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535 ||
    !Number.isInteger(timeout) ||
    timeout < 0 ||
    timeout > 86400
  )
    throw new Error("Invalid port or timeout (maximum 86400 seconds)");
  const configPath =
    args.config ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "agent-tools/email.json",
    );
  if ((await stat(configPath)).mode & 0o077)
    throw new Error(
      "Credential config must be private: chmod 600 the config file",
    );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const endpoint = new URL(config.url);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    (endpoint.protocol !== "https:" &&
      !(
        endpoint.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)
      ))
  )
    throw new Error(
      "MCP endpoint requires HTTPS (HTTP is allowed only for loopback development)",
    );
  const authorization = new Headers(config.headers).get("authorization");
  if (!authorization?.startsWith("Bearer "))
    throw new Error("Config requires a bearer authorization header");
  const stateDir =
    args["state-dir"] ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"),
      "agent-tools/email",
    );
  process.umask(0o077);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if ((await stat(stateDir)).mode & 0o077)
    throw new Error("State directory must be private: chmod 700 the directory");
  const key = createHash("sha256")
    .update(JSON.stringify([endpoint.href, inbox, target.href]))
    .digest("hex");
  const db = new DatabaseSync(join(stateDir, `${key}.sqlite`));
  let server,
    timer,
    retry,
    stopped = false,
    pumping = false,
    hook;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const requests = new AbortController();
  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    process.exitCode = code;
    requests.abort();
    finish();
  };
  const interrupt = () => stop(130);
  const terminate = () => stop(143);
  const outputError = () => stop(1);
  async function call(name, input) {
    const id = randomUUID();
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([requests.signal, AbortSignal.timeout(10000)]),
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: input },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`MCP HTTP ${response.status}`);
    }
    const raw = (await bytes(response.body, 4 * 1024 * 1024)).toString("utf8");
    const replies = response.headers
      .get("content-type")
      ?.includes("text/event-stream")
      ? raw
          .split(/\r?\n\r?\n/)
          .map((block) =>
            block
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n"),
          )
          .filter(Boolean)
          .map((text) => JSON.parse(text))
      : [JSON.parse(raw)];
    const reply = replies.find((value) => value.id === id);
    if (
      reply?.error ||
      reply?.result?.isError ||
      !reply?.result?.structuredContent
    )
      throw new Error(
        "MCP operation denied or unavailable; check grants and approved webhook URL",
      );
    return reply.result.structuredContent;
  }
  async function pump() {
    if (pumping || stopped) return;
    pumping = true;
    try {
      for (;;) {
        const row = db
          .prepare(
            "SELECT id, body FROM events WHERE printed=0 ORDER BY rowid LIMIT 1",
          )
          .get();
        if (!row || stopped) break;
        const event = JSON.parse(row.body);
        if (args.read)
          event.mail = await call("read_mail", { inbox, id: event.mailId });
        if (stopped) break;
        await new Promise((resolve, reject) =>
          process.stdout.write(
            `${JSON.stringify({ ...event, untrusted: true })}\n`,
            (error) => (error ? reject(error) : resolve()),
          ),
        );
        if (stopped) break;
        db.prepare("UPDATE events SET printed=1 WHERE id=?").run(row.id);
        if (args.once) {
          stop(0);
          break;
        }
      }
    } catch {
      if (!stopped)
        process.stderr.write(
          "Event retained; output or mail read failed. Retrying in 5 seconds.\n",
        );
    } finally {
      pumping = false;
    }
  }
  try {
    // SQLite owns the process lock; an OS-level crash releases it automatically.
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; COMMIT;",
    );
    db.exec(
      "CREATE TABLE IF NOT EXISTS subscription (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, body TEXT NOT NULL, received INTEGER NOT NULL, printed INTEGER NOT NULL DEFAULT 0);",
    );
    const saved = db.prepare("SELECT body FROM subscription WHERE id=1").get();
    hook = saved ? JSON.parse(saved.body) : undefined;
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    process.stdout.on("error", outputError);
    server = createServer(async (req, res) => {
      const respond = (code) => {
        res.writeHead(code);
        res.end();
      };
      if (req.method !== "POST" || req.url !== target.pathname)
        return respond(404);
      if (stopped || !hook || hook.expires <= Date.now()) return respond(503);
      try {
        const timestamp = req.headers["x-mail-timestamp"],
          signature = req.headers["x-mail-signature"];
        if (
          typeof timestamp !== "string" ||
          !/^\d{1,12}$/.test(timestamp) ||
          Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
          typeof signature !== "string" ||
          !/^v1=[0-9a-f]{64}$/.test(signature)
        )
          return respond(401);
        const raw = await bytes(req, 16384);
        const expected = createHmac("sha256", hook.secret)
          .update(`${timestamp}.`)
          .update(raw)
          .digest();
        if (!timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex")))
          return respond(401);
        const value = JSON.parse(raw.toString("utf8"));
        if (!value || typeof value !== "object") return respond(400);
        const uuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (
          value.type !== "mail.received" ||
          value.inbox !== inbox ||
          !uuid.test(value.id) ||
          !uuid.test(value.mailId) ||
          value.id !== req.headers["x-mail-id"] ||
          typeof value.recipient !== "string" ||
          value.recipient.length > 320 ||
          !Number.isSafeInteger(value.receivedAt)
        )
          return respond(400);
        const body = JSON.stringify({
          id: value.id,
          type: value.type,
          mailId: value.mailId,
          inbox,
          recipient: value.recipient,
          receivedAt: value.receivedAt,
        });
        db.prepare("DELETE FROM events WHERE printed=1 AND received < ?").run(
          Date.now() - 31 * 86400000,
        );
        const existing = db
          .prepare("SELECT body FROM events WHERE id=?")
          .get(value.id);
        if (existing && existing.body !== body) return respond(409);
        if (!existing) {
          if (db.prepare("SELECT count(*) AS n FROM events").get().n >= 10000)
            return respond(503);
          db.prepare(
            "INSERT INTO events (id,body,received) VALUES (?,?,?)",
          ).run(value.id, body, Date.now());
        }
        // Full synchronous commit precedes acknowledgement and stdout consumption.
        respond(204);
        void pump();
      } catch (error) {
        if (!res.headersSent)
          respond(
            error instanceof SyntaxError || error instanceof RangeError
              ? 400
              : 503,
          );
      }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    server.maxConnections = 32;
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    if (!hook || hook.expires <= Date.now()) {
      hook = await call("register_webhook", { inbox, url: target.href });
      if (
        typeof hook.id !== "string" ||
        typeof hook.secret !== "string" ||
        !Number.isSafeInteger(hook.expires)
      )
        throw new Error("Invalid subscription response");
      db.prepare("INSERT OR REPLACE INTO subscription VALUES (1,?)").run(
        JSON.stringify(hook),
      );
    }
    process.stderr.write(
      `Listening on http://127.0.0.1:${server.address().port}${target.pathname}\nSubscription ${JSON.stringify(hook.id)}; expires ${new Date(hook.expires).toISOString()}. Keep the approved HTTPS tunnel running.\n`,
    );
    if (timeout) timer = setTimeout(() => stop(124), timeout * 1000);
    retry = setInterval(() => {
      if (hook.expires <= Date.now()) {
        process.stderr.write(
          "Subscription expired. Restart to register a new subscription.\n",
        );
        stop(1);
      } else void pump();
    }, 5000);
    void pump();
    await finished;
  } finally {
    stopped = true;
    requests.abort();
    clearTimeout(timer);
    clearInterval(retry);
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.stdout.off("error", outputError);
    db.close();
  }
}

main().catch(() => {
  // Never echo remote responses, request URLs, headers, or credential parse errors.
  process.stderr.write(
    "Email watch failed. Check arguments (--help), private config/state permissions, exclusive state access, credentials, and the approved webhook URL.\n",
  );
  process.exitCode = 1;
});

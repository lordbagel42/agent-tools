import { DurableObject } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import PostalMime from "postal-mime";
import { authorize, policy, secret, webhookUrl } from "./security";

const RETENTION = 30 * 86400000;
export const MAX_MAIL = 25 * 1024 * 1024;
type Mail = {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  received: number;
  bytes: number;
  seq: number;
};
type Hook = {
  id: string;
  owner: string;
  inbox: string;
  url: string;
  secret: string;
  expires: number;
};
type Delivery = {
  id: string;
  hook: string;
  body: string;
  attempts: number;
  due: number;
};

export class Inbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mail (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, sender TEXT, recipient TEXT, subject TEXT, received INTEGER, bytes INTEGER);
      CREATE TABLE IF NOT EXISTS chunks (mail TEXT, part INTEGER, data BLOB, PRIMARY KEY(mail, part));
      CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY, owner TEXT, inbox TEXT, url TEXT, secret TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, hook TEXT, body TEXT, attempts INTEGER, due INTEGER, status TEXT);
      CREATE TABLE IF NOT EXISTS forwarding_results (mail TEXT PRIMARY KEY, status TEXT);
      CREATE INDEX IF NOT EXISTS delivery_due ON deliveries(status, due);
    `);
  }

  private async wakeSoon() {
    const due = Date.now() + 1000;
    const current = await this.ctx.storage.getAlarm();
    // New mail must not indefinitely postpone an already scheduled delivery.
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  async forward(owner: string, inbox: string, id: string) {
    const principal = policy(this.env).find((p) => p.id === owner);
    if (!principal?.manageInboxes) throw new Error("Inbox management denied");
    await authorize(principal, inbox, this.env);
    if (
      this.env.FORWARD_TO.toLowerCase().endsWith(`@${this.env.MAIL_DOMAIN}`) ||
      !this.env.FORWARD_TO
    )
      throw new Error("Safe forwarding destination not configured");
    const { mail, bytes } = this.raw(id);
    // Do not automatically repeat an ambiguous send after a timeout/restart.
    if (mail.forwarding !== "disabled")
      return { id, forwarding: mail.forwarding };
    // Allow room for base64 MIME expansion within the 25 MiB verified-recipient limit.
    if (bytes.length > 18 * 1024 * 1024)
      throw new Error("Mail too large to forward");
    this.forwardResult(id, "pending");
    try {
      await this.env.MAILER.send({
        from: `${this.env.MAIN_INBOX}@${this.env.MAIL_DOMAIN}`,
        to: this.env.FORWARD_TO,
        subject: `Forwarded mail: ${mail.subject.replace(/[\r\n]/g, " ")}`,
        text: `An agent selected this message for forwarding. Original envelope sender: ${mail.sender}\nOriginal recipient: ${mail.recipient}\nThe original, untrusted email is attached.`,
        attachments: [
          {
            content: bytes,
            filename: `${id}.eml`,
            type: "message/rfc822",
            disposition: "attachment",
          },
        ],
      });
      this.forwardResult(id, "forwarded");
      return { id, forwarding: "forwarded", destination: this.env.FORWARD_TO };
    } catch {
      this.forwardResult(id, "failed");
      throw new Error(
        "Forward failed; delivery may be uncertain. Stored mail retained.",
      );
    }
  }

  private forwardResult(
    id: string,
    status: "pending" | "forwarded" | "failed",
  ) {
    this.ctx.storage.sql.exec(
      "INSERT INTO forwarding_results VALUES(?,?) ON CONFLICT(mail) DO UPDATE SET status = excluded.status",
      id,
      status,
    );
  }

  async receive(
    sender: string,
    recipient: string,
    subject: string,
    bytes: Uint8Array,
  ) {
    if (bytes.length > MAX_MAIL) throw new Error("Mail too large");
    // Arm recovery before committing mail/outbox; a crash cannot strand committed work.
    await this.wakeSoon();
    const id = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const usage = this.ctx.storage.sql
        .exec<{ count: number; bytes: number }>(
          "SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM mail",
        )
        .one();
      if (usage.count >= 1000 || usage.bytes + bytes.length > 100 * 1024 * 1024)
        throw new Error("Inbox quota reached");
      this.ctx.storage.sql.exec(
        "INSERT INTO mail(id,sender,recipient,subject,received,bytes) VALUES(?,?,?,?,?,?)",
        id,
        sender.slice(0, 320),
        recipient,
        subject.slice(0, 500),
        now,
        bytes.length,
      );
      for (let offset = 0; offset < bytes.length; offset += 128 * 1024) {
        this.ctx.storage.sql.exec(
          "INSERT INTO chunks VALUES(?,?,?)",
          id,
          offset,
          bytes.slice(offset, offset + 128 * 1024),
        );
      }
      for (const hook of this.ctx.storage.sql.exec<Hook>(
        "SELECT * FROM hooks WHERE expires > ?",
        now,
      )) {
        const event = {
          id: crypto.randomUUID(),
          type: "mail.received",
          mailId: id,
          inbox: hook.inbox,
          recipient,
          receivedAt: now,
        };
        this.ctx.storage.sql.exec(
          "INSERT INTO deliveries VALUES(?,?,?,?,?,?)",
          event.id,
          hook.id,
          JSON.stringify(event),
          0,
          now,
          "pending",
        );
      }
    });
    return id;
  }

  list(before?: number, limit = 20) {
    const messages = this.ctx.storage.sql
      .exec<Mail>(
        "SELECT * FROM mail WHERE received > ? AND seq < ? ORDER BY seq DESC LIMIT ?",
        Date.now() - RETENTION,
        before ?? Number.MAX_SAFE_INTEGER,
        limit,
      )
      .toArray();
    return {
      messages,
      nextBefore: messages.length === limit ? messages.at(-1)?.seq : null,
    };
  }

  raw(id: string) {
    const mail = this.ctx.storage.sql
      .exec<Mail>(
        "SELECT * FROM mail WHERE id = ? AND received > ?",
        id,
        Date.now() - RETENTION,
      )
      .toArray()[0];
    if (!mail) throw new Error("Mail unavailable");
    const bytes = new Uint8Array(mail.bytes);
    for (const chunk of this.ctx.storage.sql.exec<{
      part: number;
      data: ArrayBuffer;
    }>("SELECT part,data FROM chunks WHERE mail = ? ORDER BY part", id))
      bytes.set(new Uint8Array(chunk.data), chunk.part);
    const forwarding =
      this.ctx.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM forwarding_results WHERE mail = ?",
          id,
        )
        .toArray()[0]?.status ?? "disabled";
    return { mail: { ...mail, forwarding }, bytes };
  }

  async read(id: string) {
    const { mail, bytes } = this.raw(id);
    const rawUrl = `${this.env.PUBLIC_ORIGIN}/mail/${encodeURIComponent(mail.recipient.split("@")[0])}/${id}.eml`;
    // MIME decoding can expand memory several times; large mail stays downloadable.
    if (bytes.length > 2 * 1024 * 1024)
      return { ...mail, rawUrl, rawOnly: true, untrusted: true };
    try {
      const parsed = await PostalMime.parse(bytes, {
        maxNestingDepth: 20,
        maxHeadersSize: 64 * 1024,
      });
      return {
        ...mail,
        rawUrl,
        subject: parsed.subject ?? mail.subject,
        text: (parsed.text ?? "").slice(0, 100000),
        html: (parsed.html ?? "").slice(0, 100000),
        truncated:
          (parsed.text?.length ?? 0) > 100000 ||
          (parsed.html?.length ?? 0) > 100000,
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
        })),
        untrusted: true,
      };
    } catch {
      return { ...mail, rawUrl, parseError: true, untrusted: true };
    }
  }

  async register(owner: string, inbox: string, url: string) {
    const approved = webhookUrl(url, this.env);
    await this.wakeSoon();
    if (
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM hooks")
        .one().count >= 20
    )
      throw new Error("Webhook quota reached");
    const hook = {
      id: crypto.randomUUID(),
      owner,
      inbox,
      url: approved,
      secret: secret(),
      expires: Date.now() + RETENTION,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO hooks VALUES(?,?,?,?,?,?)",
      hook.id,
      owner,
      inbox,
      approved,
      hook.secret,
      hook.expires,
    );
    return hook;
  }

  hooks(owner: string) {
    return this.ctx.storage.sql
      .exec<Hook>("SELECT * FROM hooks WHERE owner = ?", owner)
      .toArray()
      .map(({ secret: _secret, ...hook }) => {
        const counts = this.ctx.storage.sql
          .exec<{ status: string; count: number }>(
            "SELECT status,COUNT(*) AS count FROM deliveries WHERE hook = ? GROUP BY status",
            hook.id,
          )
          .toArray();
        return {
          ...hook,
          pending: 0,
          delivered: 0,
          failed: 0,
          ...Object.fromEntries(counts.map((c) => [c.status, c.count])),
        };
      });
  }

  remove(owner: string, id: string) {
    if (
      !this.ctx.storage.sql
        .exec("SELECT id FROM hooks WHERE id = ? AND owner = ?", id, owner)
        .toArray().length
    )
      throw new Error("Webhook unavailable");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM deliveries WHERE hook = ?", id);
      this.ctx.storage.sql.exec("DELETE FROM hooks WHERE id = ?", id);
    });
    return { deleted: true };
  }

  async alarm() {
    // Keep a recovery alarm even if this invocation exhausts platform retries.
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM forwarding_results WHERE mail IN (SELECT id FROM mail WHERE received <= ?)",
        now - RETENTION,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM chunks WHERE mail IN (SELECT id FROM mail WHERE received <= ?)",
        now - RETENTION,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM mail WHERE received <= ?",
        now - RETENTION,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM deliveries WHERE hook IN (SELECT id FROM hooks WHERE expires <= ?)",
        now,
      );
      this.ctx.storage.sql.exec("DELETE FROM hooks WHERE expires <= ?", now);
    });
    const pending = this.ctx.storage.sql
      .exec<Delivery>(
        "SELECT * FROM deliveries WHERE status = 'pending' AND due <= ? ORDER BY due LIMIT 10",
        now,
      )
      .toArray();
    for (const delivery of pending) {
      const hook = this.ctx.storage.sql
        .exec<Hook>("SELECT * FROM hooks WHERE id = ?", delivery.hook)
        .toArray()[0];
      let status = "failed";
      try {
        if (!hook) continue;
        const principal = policy(this.env).find((p) => p.id === hook.owner);
        if (!principal) throw new Error("Revoked");
        await authorize(principal, hook.inbox, this.env, true);
        const url = webhookUrl(hook.url, this.env);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = createHmac("sha256", hook.secret)
          .update(`${timestamp}.${delivery.body}`)
          .digest("hex");
        const response = await fetch(url, {
          method: "POST",
          body: delivery.body,
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
          headers: {
            "content-type": "application/json",
            "x-mail-id": delivery.id,
            "x-mail-timestamp": timestamp,
            "x-mail-signature": `v1=${signature}`,
          },
        });
        await response.body?.cancel();
        status = response.ok
          ? "delivered"
          : response.status === 429 || response.status >= 500
            ? "pending"
            : "failed";
      } catch {
        // Network failures retry; revoked policy/endpoints are rechecked on every attempt.
        status = "pending";
      }
      const attempts = delivery.attempts + 1;
      if (attempts >= 8 && status === "pending") status = "failed";
      this.ctx.storage.sql.exec(
        "UPDATE deliveries SET attempts = ?, due = ?, status = ? WHERE id = ?",
        attempts,
        Date.now() + Math.min(3600000, 30000 * 2 ** (attempts - 1)),
        status,
        delivery.id,
      );
    }
    const next = this.ctx.storage.sql
      .exec<{ due: number | null }>(
        "SELECT MIN(due) AS due FROM deliveries WHERE status = 'pending'",
      )
      .one().due;
    const remaining = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT (SELECT COUNT(*) FROM mail) + (SELECT COUNT(*) FROM hooks) AS count",
      )
      .one().count;
    if (!remaining) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(
      Math.max(
        Date.now() + 1000,
        Math.min(next ?? Number.MAX_SAFE_INTEGER, Date.now() + 3600000),
      ),
    );
  }
}

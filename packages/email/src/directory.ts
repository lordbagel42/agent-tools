import { DurableObject } from "cloudflare:workers";
import { inboxName, policy } from "./security";

// One small ownership index per mail domain, not one Cloudflare rule per alias.
export class Directory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS aliases (name TEXT PRIMARY KEY, owner TEXT NOT NULL)",
    );
  }

  owner(name: string) {
    return (
      this.ctx.storage.sql
        .exec<{ owner: string }>(
          "SELECT owner FROM aliases WHERE name = ?",
          name,
        )
        .toArray()[0]?.owner ?? null
    );
  }

  list(owner: string) {
    return this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM aliases WHERE owner = ? ORDER BY name",
        owner,
      )
      .toArray()
      .map((row) => row.name);
  }

  claim(owner: string, requested?: string) {
    const principal = policy(this.env).find((p) => p.id === owner);
    if (!principal?.manageInboxes) throw new Error("Inbox management denied");
    const name = inboxName(requested ?? `mail-${crypto.randomUUID()}`);
    if (
      name === this.env.MAIN_INBOX ||
      policy(this.env).some((p) => p.inboxes.includes(name))
    )
      throw new Error("Reserved inbox");
    const existing = this.owner(name);
    if (existing && existing !== owner)
      throw new Error("Inbox already claimed");
    if (!existing) {
      if (this.list(owner).length >= 100)
        throw new Error("Inbox quota reached");
      // Synchronous read/check/insert is atomic within this single object turn.
      this.ctx.storage.sql.exec("INSERT INTO aliases VALUES(?,?)", name, owner);
    }
    return {
      name,
      address: `${name}@${this.env.MAIL_DOMAIN}`,
      persistent: true,
    };
  }
}

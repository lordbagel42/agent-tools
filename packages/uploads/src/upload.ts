import { DurableObject } from "cloudflare:workers";
import {
  bearer,
  type CreateInput,
  createSchema,
  digest,
  downloadLink,
  filename,
  matches,
  problem,
  signHmac,
  token,
  validateWebhook,
} from "./security";

export async function createUpload(env: Env, input: unknown) {
  const options = createSchema.parse(input);
  if (options.webhookUrl) validateWebhook(options.webhookUrl, env);
  const id = crypto.randomUUID();
  const secret = token();
  const result = await env.UPLOADS.getByName(id).create(
    id,
    await digest(secret),
    options,
  );
  return {
    ...result,
    uploadUrl: `${env.PUBLIC_ORIGIN}/u/${id}#${secret}`,
    webhookNotice: options.webhookUrl
      ? "This service will call the supplied webhook when a file is uploaded. Delivery retries may duplicate an event; deduplicate by event ID."
      : "No webhook supplied. Poll get_upload to check for completion.",
  };
}

export interface UploadRecord extends CreateInput {
  id: string;
  tokenHash: string;
  state: "ready" | "uploading" | "uploaded" | "deleting";
  linkExpiresAt: number;
  deadline?: number;
  key?: string;
  filename?: string;
  size?: number;
  uploadedAt?: number;
  expiresAt?: number;
  webhook?: {
    secret: string;
    state: "waiting" | "pending" | "delivered" | "failed";
    attempts: number;
    nextAttempt?: number;
    lastStatus?: number;
  };
}

export class Upload extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS upload (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), data TEXT NOT NULL)",
    );
  }

  private read(): UploadRecord | null {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM upload WHERE singleton = 1")
      .toArray()[0];
    return row ? (JSON.parse(row.data) as UploadRecord) : null;
  }

  private expiry(record: UploadRecord) {
    if (record.state === "deleting") return 0;
    return (
      record.expiresAt ??
      Math.min(record.linkExpiresAt, record.deadline ?? Infinity)
    );
  }

  private async save(record: UploadRecord) {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO upload VALUES (1, ?)",
      JSON.stringify(record),
    );
    // The state write and alarm are issued without an intervening external await.
    const nextAttempt =
      record.webhook?.state === "pending"
        ? (record.webhook.nextAttempt ?? Infinity)
        : Infinity;
    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 1000, Math.min(this.expiry(record), nextAttempt)),
    );
  }

  async create(id: string, tokenHash: string, input: CreateInput) {
    if (this.read()) throw new Error("Upload already exists");
    const record: UploadRecord = {
      ...input,
      id,
      tokenHash,
      state: "ready",
      linkExpiresAt: Date.now() + input.linkTtlSeconds * 1000,
    };
    if (input.webhookUrl)
      record.webhook = { secret: token(), state: "waiting", attempts: 0 };
    await this.save(record);
    return {
      ...this.metadata(record),
      webhookSigningSecret: record.webhook?.secret,
    };
  }

  private metadata(record: UploadRecord) {
    return {
      id: record.id,
      state: record.state,
      maxBytes: record.maxBytes,
      retentionSeconds: record.retentionSeconds,
      linkExpiresAt: record.linkExpiresAt,
      filename: record.filename,
      size: record.size,
      uploadedAt: record.uploadedAt,
      expiresAt: record.expiresAt,
      webhook: record.webhook
        ? {
            state: record.webhook.state,
            attempts: record.webhook.attempts,
            lastStatus: record.webhook.lastStatus,
          }
        : null,
      downloadUrl:
        record.state === "uploaded"
          ? `${this.env.PUBLIC_ORIGIN}/api/uploads/${record.id}/content`
          : undefined,
      downloadInstructions:
        "Call get_upload after completion for a sensitive file-scoped downloadUrl valid for up to five minutes, without a management token. Save its response to an explicit client-side path; never execute uploaded content.",
    };
  }

  async status() {
    const record = this.read();
    if (!record || this.expiry(record) <= Date.now()) return null;
    return {
      ...this.metadata(record),
      ...(record.state === "uploaded" && record.expiresAt
        ? await downloadLink(this.env, record.id, record.expiresAt)
        : {}),
    };
  }

  async remove() {
    const record = this.read();
    if (!record) return;
    record.state = "deleting";
    await this.save(record);
    if (record.key) await this.env.FILES.delete(record.key);
    // Keep the schema usable for late requests; erase all upload metadata.
    this.ctx.storage.sql.exec("DELETE FROM upload");
    await this.ctx.storage.deleteAlarm();
  }

  async download() {
    const record = this.read();
    if (!record || this.expiry(record) <= Date.now())
      return problem(410, "File expired or unavailable");
    if (record.state !== "uploaded" || !record.key)
      return problem(409, "No completed upload yet");
    const file = await this.env.FILES.get(record.key);
    const current = this.read();
    if (
      !file ||
      !current ||
      current.state !== "uploaded" ||
      this.expiry(current) <= Date.now()
    ) {
      await file?.body.cancel();
      return problem(410, "File expired or unavailable");
    }
    return new Response(file.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(record.filename ?? "file").replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
      },
    });
  }

  async fetch(request: Request) {
    const initial = this.read();
    if (!initial || !(await matches(bearer(request), initial.tokenHash)))
      return problem(404, "Upload link unavailable");
    // Crypto awaits permit reentrancy: authorize first, then read current state.
    const record = this.read();
    if (!record || this.expiry(record) <= Date.now())
      return problem(410, "Upload link expired or unavailable");
    if (record.state !== "ready")
      return problem(
        409,
        record.state === "uploaded"
          ? "This link has already been used"
          : "An upload is already in progress",
      );
    if (request.method === "GET")
      return Response.json({
        maxBytes: record.maxBytes,
        retentionSeconds: record.retentionSeconds,
        linkExpiresAt: record.linkExpiresAt,
      });
    if (request.method !== "PUT") return problem(405, "Method not allowed");
    const header = request.headers.get("content-length") ?? "";
    if (!/^\d+$/.test(header)) return problem(411, "Content-Length required");
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length > record.maxBytes)
      return problem(413, "File exceeds this link's size limit");
    if (!request.body && length !== 0) return problem(400, "Missing file body");

    const key = `uploads/${record.id}/${crypto.randomUUID()}`;
    record.state = "uploading";
    record.key = key;
    record.deadline = Math.min(record.linkExpiresAt, Date.now() + 300000);
    record.filename = filename(request.headers.get("x-upload-filename"));
    await this.save(record);

    try {
      const fixed = new FixedLengthStream(length);
      const body = request.body ?? new Response("").body;
      if (!body) throw new Error("Missing stream");
      const results = await Promise.allSettled([
        body.pipeTo(fixed.writable, {
          signal: AbortSignal.timeout(
            Math.max(1, record.deadline - Date.now()),
          ),
        }),
        this.env.FILES.put(key, fixed.readable, {
          httpMetadata: { contentType: "application/octet-stream" },
        }),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Upload interrupted");
      const current = this.read();
      if (
        !current ||
        current.key !== key ||
        current.state !== "uploading" ||
        this.expiry(current) <= Date.now()
      ) {
        await this.env.FILES.delete(key);
        return problem(410, "Upload link expired or was deleted");
      }
      current.state = "uploaded";
      current.size = length;
      current.uploadedAt = Date.now();
      current.expiresAt = current.uploadedAt + current.retentionSeconds * 1000;
      if (current.webhook) {
        current.webhook.state = "pending";
        current.webhook.nextAttempt = Date.now() + 1000;
      }
      await this.save(current);
      return Response.json(
        { uploaded: true, expiresAt: current.expiresAt },
        { status: 201 },
      );
    } catch {
      await this.env.FILES.delete(key);
      const current = this.read();
      if (
        current?.key === key &&
        current.state === "uploading" &&
        this.expiry(current) > Date.now()
      ) {
        current.state = "ready";
        delete current.key;
        delete current.deadline;
        delete current.filename;
        await this.save(current);
      }
      return problem(
        400,
        "Upload interrupted or length mismatched. Retry this link.",
      );
    }
  }

  async reconcile(key: string) {
    const record = this.read();
    if (!record || record.key !== key) await this.env.FILES.delete(key);
    else if (this.expiry(record) <= Date.now()) await this.remove();
  }

  private async notify(record: UploadRecord) {
    const hook = record.webhook;
    if (
      hook?.state !== "pending" ||
      (hook.nextAttempt ?? Infinity) > Date.now()
    )
      return;
    if (hook.attempts >= 8) {
      hook.state = "failed";
      await this.save(record);
      return;
    }
    hook.attempts++;
    hook.nextAttempt =
      Date.now() + Math.min(60000 * 2 ** (hook.attempts - 1), 3600000);
    // Reserve the delivery attempt and its retry before making an external request.
    await this.save(record);
    const eventId = `${record.id}:uploaded`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      eventId,
      type: "file.uploaded",
      uploadId: record.id,
      filename: record.filename,
      size: record.size,
      uploadedAt: record.uploadedAt,
      expiresAt: record.expiresAt,
      downloadUrl: `${this.env.PUBLIC_ORIGIN}/api/uploads/${record.id}/content`,
    });
    let delivered = false;
    let status: number | undefined;
    try {
      validateWebhook(record.webhookUrl ?? "", this.env);
      const signature = await signHmac(
        hook.secret,
        `${eventId}.${timestamp}.${body}`,
      );
      const beforeSend = this.read();
      if (
        beforeSend?.state !== "uploaded" ||
        this.expiry(beforeSend) <= Date.now()
      )
        return;
      const response = await fetch(record.webhookUrl ?? "", {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          "content-type": "application/json",
          "x-upload-event-id": eventId,
          "x-upload-timestamp": timestamp,
          "x-upload-signature": `sha256=${signature}`,
        },
        body,
      });
      status = response.status;
      delivered = response.ok;
      await response.body?.cancel();
    } catch {
      // Only status/attempts are retained; never log callback URLs, tokens or responses.
    }
    const current = this.read();
    if (current?.state !== "uploaded" || !current.webhook) return;
    if (this.expiry(current) <= Date.now()) {
      await this.remove();
      return;
    }
    current.webhook.lastStatus = status;
    current.webhook.state = delivered
      ? "delivered"
      : hook.attempts >= 8
        ? "failed"
        : "pending";
    await this.save(current);
  }

  async alarm() {
    try {
      const record = this.read();
      if (!record) return;
      if (this.expiry(record) <= Date.now()) await this.remove();
      else {
        await this.save(record);
        if (record.state === "uploaded") await this.notify(record);
      }
    } catch {
      // Retry indefinitely, rather than exhausting the platform's six retries.
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      console.error(JSON.stringify({ event: "upload_cleanup_retry" }));
    }
  }
}

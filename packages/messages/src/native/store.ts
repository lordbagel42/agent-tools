import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const header = Buffer.from("GMSESSION1");

export class SessionStore {
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(
    private readonly directory: string,
    private readonly key: Buffer,
    private readonly release: () => Promise<void>,
  ) {}

  static async open(directory: string): Promise<SessionStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const release = await lockfile.lock(directory, {
      stale: 30_000,
      retries: 0,
    });
    try {
      const path = join(directory, "session.key");
      try {
        const fd = await open(path, "wx", 0o600);
        try {
          await fd.writeFile(randomBytes(32));
          await fd.sync();
        } finally {
          await fd.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await chmod(path, 0o600);
      const key = await readFile(path);
      if (key.length !== 32) throw new Error("Invalid session encryption key");
      return new SessionStore(directory, key, release);
    } catch (error) {
      await release();
      throw error;
    }
  }

  async load(): Promise<unknown | null> {
    if (this.closed) throw new Error("Session store closed");
    await this.pending;
    let bytes: Buffer;
    try {
      const path = join(this.directory, "session.enc");
      bytes = await readFile(path);
      await chmod(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      !bytes.subarray(0, header.length).equals(header) ||
      bytes.length < header.length + 28
    )
      throw new Error("Invalid saved session");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(header.length, header.length + 12),
    );
    cipher.setAAD(header);
    cipher.setAuthTag(bytes.subarray(-16));
    const plain = Buffer.concat([
      cipher.update(bytes.subarray(header.length + 12, -16)),
      cipher.final(),
    ]);
    return JSON.parse(plain.toString("utf8")) as unknown;
  }

  async save(value: unknown): Promise<void> {
    if (this.closed) throw new Error("Session store closed");
    const plain = Buffer.from(JSON.stringify(value));
    const work = this.pending.then(async () => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, iv);
      cipher.setAAD(header);
      const bytes = Buffer.concat([
        header,
        iv,
        cipher.update(plain),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      const temporary = join(this.directory, `.session-${randomUUID()}`);
      try {
        const fd = await open(temporary, "wx", 0o600);
        try {
          await fd.writeFile(bytes);
          await fd.sync();
        } finally {
          await fd.close();
        }
        await rename(temporary, join(this.directory, "session.enc"));
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(temporary, { force: true });
        plain.fill(0);
      }
    });
    // A failed durable write remains observable; do not quietly continue with stale credentials.
    this.pending = work;
    return work;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.pending;
    } finally {
      this.key.fill(0);
      await this.release();
    }
  }
}

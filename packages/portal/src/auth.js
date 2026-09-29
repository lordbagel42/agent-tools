import {
  createHash,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { jwtVerify, SignJWT } from "jose";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const derive = promisify(scrypt);

export async function hashPin(pin) {
  if (typeof pin !== "string" || !/^\d{6,12}$/.test(pin))
    throw new Error("PIN must contain 6–12 digits");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(pin, salt, 32)).toString("hex")}`;
}

export async function verifyPin(pin, encoded) {
  if (typeof pin !== "string" || !/^\d{6,12}$/.test(pin) || !encoded)
    return false;
  const [salt, expected] = encoded.split(":");
  return timingSafeEqual(
    await derive(pin, salt, 32),
    Buffer.from(expected, "hex"),
  );
}

export class PortalAuth {
  constructor(config) {
    if (!/^[a-f0-9]{64}$/i.test(config.signingKey ?? ""))
      throw new Error("A 32-byte hex signingKey is required");
    this.config = config;
    this.key = Buffer.from(config.signingKey, "hex");
    this.now = config.now ?? Date.now;
    this.tickets = new Map();
    this.queue = Promise.resolve();
    this.pending = 0;
    this.sharedPinHash = "";
  }

  async init() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    try {
      this.sharedPinHash = JSON.parse(
        await readFile(join(this.config.stateDir, "shared-pin.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Fail closed until the owner chooses a known PIN with the local CLI.
      await this.setSharedPin(String(randomInt(1_000_000)).padStart(6, "0"));
    }
    if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(this.sharedPinHash))
      throw new Error("Invalid shared PIN hash");
    try {
      this.attempts = JSON.parse(
        await readFile(join(this.config.stateDir, "pin-attempts.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.attempts = {};
    }
  }

  async persist(name, value) {
    const path = join(this.config.stateDir, name);
    await writeFile(path + ".tmp", JSON.stringify(value), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }

  async setSharedPin(pin) {
    const encoded = await hashPin(pin);
    await this.persist("shared-pin.json", encoded);
    this.sharedPinHash = encoded;
    this.tickets.clear();
  }

  version(pinHash) {
    return hash(pinHash ?? this.sharedPinHash);
  }

  async checkPin(pin, pinHash) {
    if (this.pending >= 32) return { status: 429, retryAfter: 60 };
    this.pending++;
    const attempt = this.queue.then(async () => {
      const now = this.now();
      for (const [key, value] of Object.entries(this.attempts))
        if (value.until <= now) delete this.attempts[key];
      const group = pinHash ? hash(pinHash) : "shared";
      const limits = [
        ["global", 60],
        [group, 8],
      ];
      for (const [key, limit] of limits) {
        const entry = this.attempts[key];
        if (entry?.count >= limit)
          return {
            status: 429,
            retryAfter: Math.ceil((entry.until - now) / 1000),
          };
      }
      for (const [key] of limits) {
        this.attempts[key] ??= { count: 0, until: now + 15 * 60_000 };
        this.attempts[key].count++;
      }
      // Reserve and persist before checking, so concurrency or restart cannot
      // reset the guessing budget. Caller-controlled IP headers are irrelevant.
      await this.persist("pin-attempts.json", this.attempts);
      const encoded = pinHash ?? this.sharedPinHash;
      const valid = await verifyPin(pin, encoded);
      return {
        status:
          valid && encoded === (pinHash ?? this.sharedPinHash) ? 200 : 401,
      };
    });
    this.queue = attempt.catch(() => {});
    try {
      return await attempt;
    } finally {
      this.pending--;
    }
  }

  ticket(id, pinHash) {
    for (const [key, value] of this.tickets)
      if (value.expires <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 1000)
      throw new Error("Too many pending login tickets");
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(hash(token), {
      id,
      version: this.version(pinHash),
      expires: this.now() + 60_000,
    });
    return token;
  }

  consume(token, id, pinHash) {
    if (typeof token !== "string") return false;
    const key = hash(token);
    const ticket = this.tickets.get(key);
    if (
      !ticket ||
      ticket.id !== id ||
      ticket.version !== this.version(pinHash) ||
      ticket.expires <= this.now()
    )
      return false;
    this.tickets.delete(key);
    return true;
  }

  session(id, pinHash) {
    const now = Math.floor(this.now() / 1000);
    return new SignJWT({ version: this.version(pinHash) })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("raygen-portals")
      .setAudience(id)
      .setIssuedAt(now)
      .setExpirationTime(now + 8 * 3600)
      .sign(this.key);
  }

  async validSession(token, id, pinHash) {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: "raygen-portals",
        audience: id,
        requiredClaims: ["exp", "iat"],
        currentDate: new Date(this.now()),
      });
      return payload.version === this.version(pinHash);
    } catch {
      return false;
    }
  }
}

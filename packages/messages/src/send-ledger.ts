import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { ApiError, type SendReceipt, type SendRequest } from "./types.js";

type Entry = {
  fingerprint: string;
  state: "pending" | "completed";
  receipt?: SendReceipt;
};

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uncertain = () =>
  new ApiError(
    409,
    "SEND_UNCERTAIN",
    "This key has an unresolved send attempt. Check the phone before using a new key; never retry automatically.",
  );

async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class SendLedger {
  constructor(readonly directory: string) {}

  async execute(
    key: string,
    request: SendRequest,
    send: () => Promise<SendReceipt>,
  ): Promise<SendReceipt> {
    const fingerprint = hash(
      JSON.stringify([request.conversationId, request.text]),
    );
    const path = join(this.directory, `${hash(key)}.json`);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const reservation = await open(path, "wx", 0o600).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        return null;
      },
    );
    if (!reservation) {
      // A simultaneous creator or interrupted write can leave an empty file. Fail closed.
      const entry: Entry | null = await readFile(path, "utf8")
        .then((raw) => JSON.parse(raw) as Entry)
        .catch(() => null);
      if (!entry?.fingerprint) throw uncertain();
      if (entry.fingerprint !== fingerprint) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This key was already used for a different request.",
        );
      }
      if (entry.state === "completed" && entry.receipt) return entry.receipt;
      throw uncertain();
    }

    try {
      await reservation.writeFile(
        JSON.stringify({ fingerprint, state: "pending" } satisfies Entry),
      );
      await reservation.sync();
    } finally {
      await reservation.close();
    }
    await syncDirectory(this.directory);

    // Never remove the reservation on failure: the click may already have reached Google.
    const receipt = await send();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const completed = await open(temporary, "wx", 0o600);
      try {
        await completed.writeFile(
          JSON.stringify({
            fingerprint,
            state: "completed",
            receipt,
          } satisfies Entry),
        );
        await completed.sync();
      } finally {
        await completed.close();
      }
      await rename(temporary, path);
      await syncDirectory(this.directory);
    } catch {
      throw uncertain();
    } finally {
      await rm(temporary, { force: true });
    }
    return receipt;
  }
}

type Scalar = string | number | bigint | Uint8Array;
export type Fields = Record<number, Scalar | Scalar[]>;

function varint(value: bigint): Buffer {
  if (value < -(1n << 63n) || value >= 1n << 64n)
    throw new Error("Invalid protobuf integer");
  let n = BigInt.asUintN(64, value);
  const result: number[] = [];
  do {
    result.push(Number(n & 127n) | (n > 127n ? 128 : 0));
    n >>= 7n;
  } while (n);
  return Buffer.from(result);
}

export function encode(fields: Fields): Buffer {
  const parts: Buffer[] = [];
  for (const [key, values] of Object.entries(fields)) {
    const field = Number(key);
    if (!Number.isInteger(field) || field < 1 || field >= 2 ** 29)
      throw new Error("Invalid protobuf field");
    for (const value of Array.isArray(values) ? values : [values]) {
      if (typeof value === "number" || typeof value === "bigint") {
        if (typeof value === "number" && !Number.isSafeInteger(value))
          throw new Error("Unsafe protobuf integer");
        parts.push(varint(BigInt(field) << 3n), varint(BigInt(value)));
      } else {
        const bytes = Buffer.from(value);
        parts.push(
          varint((BigInt(field) << 3n) | 2n),
          varint(BigInt(bytes.length)),
          bytes,
        );
      }
    }
  }
  return Buffer.concat(parts);
}

export function decode(buffer: Uint8Array): Proto {
  const bytes = Buffer.from(buffer);
  const fields = new Map<number, (bigint | Buffer)[]>();
  let offset = 0;
  const readVarint = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1))
        throw new Error("Invalid protobuf varint");
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return result;
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = readVarint();
    const field = Number(tag >> 3n);
    const type = Number(tag & 7n);
    if (!field || field >= 2 ** 29) throw new Error("Invalid protobuf field");
    let value: bigint | Buffer;
    if (type === 0) value = readVarint();
    else {
      const length =
        type === 2
          ? Number(readVarint())
          : type === 1
            ? 8
            : type === 5
              ? 4
              : -1;
      if (
        length < 0 ||
        !Number.isSafeInteger(length) ||
        length > bytes.length - offset
      )
        throw new Error("Invalid protobuf length");
      value = bytes.subarray(offset, offset + length);
      offset += length;
    }
    const previous = fields.get(field) ?? [];
    previous.push(value);
    fields.set(field, previous);
  }
  return new Proto(fields);
}

export class Proto {
  constructor(private readonly fields: Map<number, (bigint | Buffer)[]>) {}
  has(field: number): boolean {
    return this.fields.has(field);
  }
  int(field: number): bigint {
    const value = this.fields.get(field)?.at(-1) ?? 0n;
    if (typeof value !== "bigint") throw new Error("Expected protobuf integer");
    return value;
  }
  bytes(field: number): Buffer {
    return this.all(field).at(-1) ?? Buffer.alloc(0);
  }
  text(field: number): string {
    return this.bytes(field).toString("utf8");
  }
  message(field: number): Proto {
    return decode(this.bytes(field));
  }
  messages(field: number): Proto[] {
    return this.all(field).map(decode);
  }
  all(field: number): Buffer[] {
    return (this.fields.get(field) ?? []).map((value) => {
      if (typeof value === "bigint") throw new Error("Expected protobuf bytes");
      return value;
    });
  }
}

// Google's PBLite can encode int64 as numbers or strings. Do not silently round IDs.
export function parsePblite(text: string): unknown {
  return JSON.parse(
    text.replace(
      /"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (token, number: string | undefined) =>
        number &&
        /^-?\d+$/.test(number) &&
        !Number.isSafeInteger(Number(number))
          ? `"${number}"`
          : token,
    ),
  );
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected PBLite array");
  return value;
}

// ReceiveMessages is a streamed outer array containing one list of PBLite payloads.
// Frames can be split or coalesced at any byte, including inside UTF-8 characters.
export class PbliteStream {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private phase:
    | "open"
    | "list"
    | "first"
    | "next"
    | "frame"
    | "separator"
    | "close"
    | "done" = "open";
  private frame = "";
  private size = 0;
  private depth = 0;
  private quoted = false;
  private escaped = false;
  constructor(private readonly limit = 8 * 1024 * 1024) {}
  push(buffer: Uint8Array): unknown[][] {
    const frames: unknown[][] = [];
    for (const ch of this.decoder.decode(buffer, { stream: true })) {
      if (this.phase !== "frame") {
        if (/\s/.test(ch)) continue;
        if (this.phase === "open" && ch === "[") this.phase = "list";
        else if (this.phase === "list" && ch === "[") this.phase = "first";
        else if (
          (this.phase === "first" || this.phase === "next") &&
          ch === "["
        ) {
          this.phase = "frame";
          this.frame = "[";
          this.size = 1;
          this.depth = 1;
        } else if (this.phase === "separator" && ch === ",")
          this.phase = "next";
        else if (
          (this.phase === "first" || this.phase === "separator") &&
          ch === "]"
        )
          this.phase = "close";
        else if (this.phase === "close" && ch === "]") this.phase = "done";
        else throw new Error("Invalid Messages stream framing");
        continue;
      }
      this.frame += ch;
      this.size += Buffer.byteLength(ch);
      if (this.size > this.limit)
        throw new Error("Messages stream frame too large");
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.quoted = false;
      } else if (ch === '"') this.quoted = true;
      else if (ch === "[" || ch === "{") this.depth++;
      else if (ch === "]" || ch === "}") this.depth--;
      if (this.depth === 0) {
        frames.push(array(parsePblite(this.frame)));
        this.frame = "";
        this.phase = "separator";
      }
    }
    return frames;
  }
  finish(): void {
    if (this.decoder.decode() || this.phase !== "done")
      throw new Error("Truncated Messages stream");
  }
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  type ECDH,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { decode, encode } from "./wire.js";

export type RequestKeys = { aes: Buffer; hmac: Buffer };
export function seal(
  plain: Buffer,
  keys: RequestKeys,
  iv = randomBytes(16),
): Buffer {
  const cipher = createCipheriv("aes-256-ctr", keys.aes, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), iv]);
  return Buffer.concat([
    body,
    createHmac("sha256", keys.hmac).update(body).digest(),
  ]);
}

export function open(encrypted: Buffer, keys: RequestKeys): Buffer {
  if (encrypted.length < 48) throw new Error("Truncated encrypted message");
  const body = encrypted.subarray(0, -32);
  const expected = createHmac("sha256", keys.hmac).update(body).digest();
  if (!timingSafeEqual(expected, encrypted.subarray(-32)))
    throw new Error("Invalid message authenticator");
  const cipher = createDecipheriv("aes-256-ctr", keys.aes, body.subarray(-16));
  return Buffer.concat([cipher.update(body.subarray(0, -16)), cipher.final()]);
}

const keyInfo = Buffer.from(
  "82aa55a0d397f88346ca1cee8d3909b95f13fa7deb1d4ab38376b8256da85510",
  "hex",
);
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest();
const hkdf = (key: Buffer, salt: Buffer | string, info: Buffer | string) =>
  Buffer.from(hkdfSync("sha256", key, salt, info, 32));

// Java Arrays.hashCode(byte[]): signed bytes and signed 32-bit overflow are part of the protocol.
function byteHash(bytes: Buffer): number {
  let hash = 1;
  for (const byte of bytes)
    hash = (Math.imul(hash, 31) + (byte > 127 ? byte - 256 : byte)) | 0;
  return hash;
}

export function deriveKeys(key: Buffer, version: number): RequestKeys {
  const client = hkdf(key, keyInfo, "client");
  const server = hkdf(key, keyInfo, "server");
  if (version === 0) return { aes: client, hmac: server };
  if (version !== 1) throw new Error("Unsupported pairing key version");
  const ordered =
    byteHash(client) < byteHash(server) ? [client, server] : [server, client];
  const shared = sha256(Buffer.concat([keyInfo, ...ordered]));
  return {
    aes: hkdf(shared, "Ditto salt 1", "Ditto info 1"),
    hmac: hkdf(shared, "Ditto salt 2", "Ditto info 2"),
  };
}

export class Handshake {
  readonly init: Buffer;
  readonly finish: Buffer;
  constructor(
    private readonly key: ECDH,
    nonce: Buffer,
  ) {
    if (nonce.length !== 32) throw new Error("Invalid pairing nonce");
    const publicKey = key.getPublicKey(undefined, "uncompressed");
    const coordinates = encode({
      1: Buffer.concat([Buffer.from([0]), publicKey.subarray(1, 33)]),
      2: Buffer.concat([Buffer.from([0]), publicKey.subarray(33)]),
    });
    this.finish = encode({
      1: 4,
      2: encode({ 1: encode({ 1: 1, 2: coordinates }) }),
    });
    const commitment = createHash("sha512").update(this.finish).digest();
    this.init = encode({
      1: 2,
      2: encode({
        1: 1,
        2: nonce,
        3: encode({ 1: 100, 2: commitment }),
        4: "AES_256_CBC-HMAC_SHA256",
      }),
    });
  }
  receive(server: Buffer): { auth: Buffer; nextKey: Buffer } {
    const message = decode(server);
    const init = message.message(2);
    const key = init.message(4);
    if (
      message.int(1) !== 3n ||
      init.int(1) !== 1n ||
      init.int(3) !== 100n ||
      init.bytes(2).length !== 32 ||
      key.int(1) !== 1n
    )
      throw new Error("Unsupported UKEY2 server initialization");
    const coordinate = (bytes: Buffer) => {
      if (bytes.length === 33 && bytes[0] === 0) return bytes.subarray(1);
      if (bytes.length !== 32) throw new Error("Invalid P-256 coordinate");
      return bytes;
    };
    const point = key.message(2);
    const publicKey = Buffer.concat([
      Buffer.from([4]),
      coordinate(point.bytes(1)),
      coordinate(point.bytes(2)),
    ]);
    // OpenSSL validates that the peer point is on the expected P-256 curve.
    const secret = sha256(this.key.computeSecret(publicKey));
    const transcript = Buffer.concat([this.init, server]);
    return {
      auth: hkdf(secret, "UKEY2 v1 auth", transcript),
      nextKey: hkdf(secret, "UKEY2 v1 next", transcript),
    };
  }
}

// Protocol lookup data: ordering, the duplicate bread, and multi-codepoint emoji are significant.
// See docs/architecture.md for the protocol sources and revision.
const emojiV0 =
  "😁 😅 🤣 🫠 🥰 😇 🤩 😘 😜 🤗 🤔 🤐 😴 🥶 🤯 🤠 🥳 🥸 😎 🤓 🧐 🥹 😭 😱 😖 🥱 😮‍💨 🤡 💩 👻 👽 🤖 😻 💌 💘 💕 ❤ 💢 💥 💫 💬 🗯 💤 👋 🙌 🙏 ✍ 🦶 👂 🧠 🦴 👀 🧑 🧚 🧍 👣 🐵 🐶 🐺 🦊 🦁 🐯 🦓 🦄 🐑 🐮 🐷 🐿 🐰 🦇 🐻 🐨 🐼 🦥 🐾 🐔 🐥 🐦 🕊 🦆 🦉 🪶 🦩 🐸 🐢 🦎 🐍 🐳 🐬 🦭 🐠 🐡 🦈 🪸 🐌 🦋 🐛 🐝 🐞 🪱 💐 🌸 🌹 🌻 🌱 🌲 🌴 🌵 🌾 ☘ 🍁 🍂 🍄 🪺 🍇 🍈 🍉 🍋 🍌 🍍 🍎 🍐 🍒 🍓 🥝 🥥 🥑 🥕 🌽 🌶 🫑 🥦 🥜 🍞 🥐 🥨 🧀 🍗 🍔 🍟 🍕 🌭 🌮 🥗 🥣 🍿 🦀 🦑 🍦 🍩 🍪 🍫 🍰 🍬 🍭 ☕ 🫖 🍹 🥤 🧊 🥢 🍽 🥄 🧭 🏔 🌋 🏕 🏖 🪵 🏗 🏡 🏰 🛝 🚂 🛵 🛴 🛼 🚥 ⚓ 🛟 ⛵ ✈ 🚀 🛸 🧳 ⏰ 🌙 🌡 🌞 🪐 🌠 🌧 🌀 🌈 ☂ ⚡ ❄ ⛄ 🔥 🎇 🧨 ✨ 🎈 🎉 🎁 🏆 🏅 ⚽ ⚾ 🏀 🏐 🏈 🎾 🎳 🏓 🥊 ⛳ ⛸ 🎯 🪁 🔮 🎮 🧩 🧸 🪩 🖼 🎨 🧵 🧶 🦺 🧣 🧤 🧦 🎒 🩴 👟 👑 👒 🎩 🧢 💎 🔔 🎤 📻 🎷 🪗 🎸 🎺 🎻 🥁 📺 🔋 💻 💿 ☎ 🕯 💡 📖 📚 📬 ✏ ✒ 🖌 🖍 📝 💼 📋 📌 📎 🔑 🔧 🧲 🪜 🧬 🔭 🩹 🩺 🪞 🛋 🪑 🛁 🧹 🧺 🔱 🏁 🐪 🐘 🦃 🍞 🍜 🍠 🚘 🤿 🃏 👕 📸 🏷 ✂ 🧪 🚪 🧴 🧻 🪣 🧽 🚸".split(
    " ",
  );
const emojiRemovedV1 = new Set("💻 🤗 💬 👋 😁 😎 😇 🥰 🤓 🤩".split(" "));
const emojiV1 = [
  ...new Set(emojiV0),
  ..."🍋‍🟩 🐦‍🔥 🐲 🪅 🦜 🏺 🗿 🫐 ⛽ 🍱 🥡 🧋 🍼 📐".split(" "),
].filter((emoji) => !emojiRemovedV1.has(emoji));

export function verificationEmoji(auth: Buffer, version: number): string {
  if (version !== 0 && version !== 1)
    throw new Error("Unsupported verification code version");
  const table = version === 0 ? emojiV0 : emojiV1;
  return table[auth.readUInt32BE(0) % table.length] as string;
}

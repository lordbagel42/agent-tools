import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import test from "node:test";
import {
  deriveKeys,
  Handshake,
  open,
  seal,
  verificationEmoji,
} from "../src/native/crypto.js";

const hex = (s: string) => Buffer.from(s, "hex");
const keys = {
  aes: hex("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4"),
  hmac: Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
};

test("phone encryption matches NIST AES-256 CTR with ciphertext/IV/HMAC framing", () => {
  const plaintext = hex("6bc1bee22e409f96e93d7e117393172a");
  const iv = hex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
  // NIST ciphertext plus independently computed Python HMAC-SHA256.
  const expected = hex(
    "601ec313775789a5b7a7f504bbf3d228f0f1f2f3f4f5f6f7f8f9fafbfcfdfeffcb58dc4f6fbc9550be0520399de5334170da15501484533c71b40af163e92319",
  );
  assert.deepEqual(seal(plaintext, keys, iv), expected);
  assert.deepEqual(open(expected, keys), plaintext);
  for (const offset of [0, 16, 32, 63]) {
    const corrupted = Buffer.from(expected);
    corrupted[offset] = (corrupted[offset] ?? 0) ^ 1;
    assert.throws(() => open(corrupted, keys));
  }
  assert.throws(() => open(expected.subarray(0, 47), keys));
});

test("UKEY2 transcript and both key versions match independent P-256/Python vectors", () => {
  const key = createECDH("prime256v1");
  key.setPrivateKey(hex("01"));
  const handshake = new Handshake(
    key,
    Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
  );
  assert.equal(
    handshake.init.toString("hex"),
    "080212830108011220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f1a4408641240c1e9670eef7e7a002a01d4a44e4e67de0592bc3d3afb0518e79d0b522024f9eb8383b396bbf852c2a67c02cb0857be7aed097f9d2f82937ac036e69cc146675622174145535f3235365f4342432d484d41435f534841323536",
  );
  assert.equal(
    handshake.finish.toString("hex"),
    "0804124c0a4a080112460a21006b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2961221004fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
  );
  const server = hex(
    "0803127208011220202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f1864224a080112460a21007cf27b188d034f7e8a52380304b51ac3c08969e277f21b35a60b48fc4766997812210007775510db8ed040293d9ac69f7430dbba7dade63ce982299e04b79d227873d1",
  );
  const derived = handshake.receive(server);
  assert.equal(
    derived.auth.toString("hex"),
    "f9825abd0efe1c1091674d3af2fa58c04a55fc5cc2308451a335df05e4fa28c3",
  );
  assert.equal(
    derived.nextKey.toString("hex"),
    "52f20bfa3ba5c268f59a5618f9aa20b8ae8d5ae13096c8ed359af59057870268",
  );
  const v0 = deriveKeys(derived.nextKey, 0);
  assert.equal(
    v0.aes.toString("hex"),
    "5dc2cefef5d61b30895f3420020529327599f20921969e37baa42402b6247c34",
  );
  assert.equal(
    v0.hmac.toString("hex"),
    "a0f31c2217a5400048e96b969f428cfc02328e7b9cc101349470fd3dddcdc9e3",
  );
  const v1 = deriveKeys(derived.nextKey, 1);
  assert.equal(
    v1.aes.toString("hex"),
    "07947ee6d6f3aa5cc8ffdca68f76afa2c2861f66dc02937f3a24b36654f2e1a3",
  );
  assert.equal(
    v1.hmac.toString("hex"),
    "113639899d802e55a45b19b6ab1e8696667f1a60cdd41bb0706f4ba2c08a322a",
  );
  assert.throws(() => deriveKeys(derived.nextKey, 2));
  assert.throws(() => handshake.receive(handshake.init));
  assert.throws(() =>
    handshake.receive(
      Buffer.concat([server.subarray(0, -64), Buffer.alloc(64)]),
    ),
  );
});

test("verification emoji uses the unsigned big-endian transcript number and negotiated table", () => {
  assert.equal(verificationEmoji(hex("f9825abd"), 0), "🎉");
  assert.equal(verificationEmoji(hex("f9825abd"), 1), "🍒");
  assert.equal(verificationEmoji(hex("00000000"), 0), "😁");
  assert.equal(verificationEmoji(hex("00000000"), 1), "😅");
  assert.equal(verificationEmoji(hex("00000134"), 1), "😅");
  assert.equal(verificationEmoji(hex("ffffffff"), 0), "🧴");
  assert.throws(() => verificationEmoji(hex("00000000"), 2));
});

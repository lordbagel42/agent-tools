import assert from "node:assert/strict";
import test from "node:test";
import { decode, encode, PbliteStream } from "../src/native/wire.js";

test("protobuf preserves field gaps, repeated bytes and integers beyond JS precision", () => {
  // Independently encoded: field 1 varint 150, field 3 UTF-8, repeated field 5,
  // and field 9 uint64 9007199254740993 (not representable as a JS number).
  const expected = Buffer.from(
    "0896011a0268692a01782a0179488180808080808010",
    "hex",
  );
  const actual = encode({
    1: 150n,
    3: "hi",
    5: ["x", "y"],
    9: 9007199254740993n,
  });
  assert.deepEqual(actual, expected);
  const result = decode(expected);
  assert.equal(result.int(1), 150n);
  assert.equal(result.text(3), "hi");
  assert.deepEqual(
    result.all(5).map((b) => b.toString()),
    ["x", "y"],
  );
  assert.equal(result.int(9), 9007199254740993n);
  assert.equal(result.int(2), 0n);
});

test("protobuf rejects truncated lengths/varints, groups, and unsafe integers", () => {
  for (const hex of ["0a0578", "0880", "0b", "00", "088080808080808080808080"])
    assert.throws(() => decode(Buffer.from(hex, "hex")));
  assert.throws(() => encode({ 1: Number.MAX_SAFE_INTEGER + 1 }));
});

test("stream parser emits every payload across arbitrary UTF-8 and JSON boundaries", () => {
  const raw = Buffer.from(
    '[[[null,["one",["escaped \\" ] [","😀"]]],[null,null,[]],[null,null,null,[2]]]]',
  );
  for (const width of [1, 2, 7, raw.length]) {
    const stream = new PbliteStream();
    const payloads: unknown[] = [];
    for (let offset = 0; offset < raw.length; offset += width)
      payloads.push(...stream.push(raw.subarray(offset, offset + width)));
    stream.finish();
    assert.deepEqual(payloads, [
      [null, ["one", ['escaped " ] [', "😀"]]],
      [null, null, []],
      [null, null, null, [2]],
    ]);
  }
});

test("stream parser refuses malformed, truncated and oversized frames", () => {
  for (const value of ["{}", "[[[1],,[2]]]", "[[[1]]]trailing"]) {
    assert.throws(() => {
      const p = new PbliteStream();
      p.push(Buffer.from(value));
      p.finish();
    });
  }
  const truncated = new PbliteStream();
  truncated.push(Buffer.from("[[[null,"));
  assert.throws(() => truncated.finish());
  assert.throws(() =>
    new PbliteStream(16).push(
      Buffer.from('[[["abcdefghijklmnopqrstuvwxyz"]]]'),
    ),
  );
});

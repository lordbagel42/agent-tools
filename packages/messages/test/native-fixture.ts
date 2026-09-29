import assert from "node:assert/strict";
import {
  createECDH,
  createHash,
  createPublicKey,
  hkdfSync,
  verify,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  deriveKeys,
  open,
  type RequestKeys,
  seal,
} from "../src/native/crypto.js";
import type { Fetch } from "../src/native/http.js";
import { array, decode, encode, type Proto } from "../src/native/wire.js";

export const testCookies = {
  SID: "fixture-sid",
  HSID: "fixture-hsid",
  SSID: "fixture-ssid",
  OSID: "fixture-osid",
  APISID: "fixture-apisid",
  SAPISID: "fixture-sapisid",
};
const device = "01234567-89ab-4cde-8fab-0123456789ab";
const destination = "11234567-89ab-4cde-8fab-0123456789ab";
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json+protobuf" },
  });

export async function until(
  condition: () => boolean | Promise<boolean>,
  peer?: PhoneFixture,
): Promise<void> {
  const end = Date.now() + 5000;
  while (!(await condition())) {
    if (peer?.failure) throw peer.failure;
    if (Date.now() > end) throw new Error("Fixture condition timed out");
    await delay(10);
  }
}

export class PhoneFixture {
  failure: unknown;
  readonly actions: {
    action: number;
    id: string;
    data: Proto;
    type: number;
  }[] = [];
  readonly acked: string[] = [];
  requests = 0;
  refreshes = 0;
  signIns = 0;
  wrongConversation = false;
  rejectAuth = false;
  unavailableConfig = 0;
  streams = 0;
  sendRejected = false;
  finishId = "";
  sendId = "";
  keys: RequestKeys | undefined;
  private commitment: Buffer = Buffer.alloc(0);
  private clientInit: Buffer = Buffer.alloc(0);
  private refreshPublicKey: Buffer = Buffer.alloc(0);
  private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  private first = true;
  private sequence = 0;
  private pendingReads: { id: string; conversation: string }[] = [];
  holdReads = false;
  private readonly key = createECDH("prime256v1");
  constructor() {
    this.key.setPrivateKey(Buffer.from([2]));
  }

  readonly fetch: Fetch = async (url, init) => {
    try {
      return await this.respond(url, init);
    } catch (error) {
      this.failure = error;
      throw error;
    }
  };

  private async respond(url: string, init: RequestInit): Promise<Response> {
    this.requests++;
    if (url.endsWith("/web/welcome"))
      return new Response(`"A16fYe",[null,null,"AIza${"x".repeat(35)}"]`);
    if (this.rejectAuth)
      return new Response("private-cookie diagnostic", { status: 401 });
    if (url.endsWith("/web/config") && this.unavailableConfig-- > 0)
      return new Response("unavailable", { status: 503 });
    if (url.endsWith("/web/config"))
      return json([
        "20260924",
        null,
        null,
        null,
        [null, "test@example.test", "0", device],
      ]);
    const payload = array(JSON.parse(String(init.body)));
    if (url.endsWith("/SignInGaia")) {
      this.signIns++;
      assert.equal(array(payload[0])[2], "GDitto");
      const inner = array(payload[1]);
      assert.equal(
        array(inner[0])[1],
        "messages-web-0123456789ab4cde8fab0123456789ab",
      );
      this.refreshPublicKey = decode(
        Buffer.from(String(inner[35]), "base64"),
      ).bytes(3);
      createPublicKey({
        key: this.refreshPublicKey,
        format: "der",
        type: "spki",
      });
      return json([
        null,
        null,
        [
          [["9007199254740993", "BROWSER-ID", "GDitto"]],
          [
            [
              Buffer.from(destination).toString("base64"),
              null,
              null,
              1,
              "en",
              null,
              "42",
            ],
          ],
        ],
        [Buffer.from("test-token").toString("base64"), "7200000000"],
      ]);
    }
    if (url.endsWith("/RegisterRefresh")) {
      this.refreshes++;
      const auth = array(payload[0]);
      assert.equal(Number(payload[2]) % 1000, 0);
      assert.equal(
        verify(
          "sha256",
          Buffer.from(`${auth[0]}:${payload[2]}`),
          { key: this.refreshPublicKey, type: "spki", format: "der" },
          Buffer.from(String(payload[3]), "base64"),
        ),
        true,
      );
      return json([
        null,
        [Buffer.from("refreshed-token").toString("base64"), "7200000000"],
      ]);
    }
    if (url.endsWith("/ReceiveMessages")) {
      this.streams++;
      assert.equal(array(payload[0])[2], "GDitto");
      this.first = true;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
          controller.enqueue(Buffer.from("[["));
          const stop = () => {
            try {
              controller.error(new Error("Fixture stream aborted"));
            } catch {}
          };
          if (init.signal?.aborted) stop();
          else init.signal?.addEventListener("abort", stop, { once: true });
        },
      });
      this.frame([null, null, null, [0]]);
      return new Response(stream, {
        headers: { "content-type": "application/json+protobuf" },
      });
    }
    if (url.endsWith("/AckMessages")) {
      for (const ack of array(payload[3]))
        this.acked.push(String(array(ack)[0]));
      return json([]);
    }
    assert.ok(url.endsWith("/SendMessage"));
    assert.deepEqual(payload[8], [Buffer.from(destination).toString("base64")]);
    const wrapper = array(payload[1]);
    assert.equal(wrapper[1], 19);
    const outer = decode(Buffer.from(String(wrapper[11]), "base64"));
    const action = Number(outer.int(2));
    const id = outer.text(1);
    assert.equal(id, wrapper[0]);
    const body = outer.has(5)
      ? open(outer.bytes(5), this.keys as RequestKeys)
      : outer.bytes(3);
    const data = decode(body);
    const type = Number(array(wrapper[22])[1]);
    this.actions.push({ action, id, data, type });
    if (action === 44) {
      assert.equal(type, 20);
      assert.equal(data.int(5), 1n);
      assert.equal(data.int(6), 1n);
      this.clientInit = data.bytes(4);
      this.commitment = decode(this.clientInit).message(2).message(3).bytes(2);
      const point = this.key.getPublicKey();
      const serverInit = encode({
        1: 3,
        2: encode({
          1: 1,
          2: Buffer.alloc(32, 7),
          3: 100,
          4: encode({
            1: 1,
            2: encode({
              1: Buffer.concat([Buffer.from([0]), point.subarray(1, 33)]),
              2: Buffer.concat([Buffer.from([0]), point.subarray(33)]),
            }),
          }),
        }),
      });
      // Keep the exact transcript as the phone would; keys cannot be derived until client-finish.
      this.serverInit = serverInit;
      this.reply(
        id,
        action,
        encode({ 3: 1, 5: serverInit, 6: 1, 7: 1 }),
        false,
      );
    } else if (action === 45) {
      assert.equal(type, 2);
      const finish = data.bytes(4);
      assert.deepEqual(
        createHash("sha512").update(finish).digest(),
        this.commitment,
      );
      const point = decode(finish).message(2).message(1).message(2);
      const peer = Buffer.concat([
        Buffer.from([4]),
        point.bytes(1).subarray(-32),
        point.bytes(2).subarray(-32),
      ]);
      const secret = createHash("sha256")
        .update(this.key.computeSecret(peer))
        .digest();
      const next = Buffer.from(
        hkdfSync(
          "sha256",
          secret,
          "UKEY2 v1 next",
          Buffer.concat([this.clientInit, this.serverInit]),
          32,
        ),
      );
      this.keys = deriveKeys(next, 1);
      this.finishId = id;
    } else if (action === 16) {
      assert.equal(payload[4], null);
      assert.equal(outer.text(6), id);
      this.reply(id, 16, encode({ 6: encode({ 2: 2 }) }));
      const sim = encode({
        5: encode({ 1: encode({ 1: 2, 2: 1 }) }),
        7: encode({ 1: "self-55" }),
      });
      this.reply(id, 16, encode({ 5: encode({ 2: sim }) }));
    } else if (action === 1) {
      assert.equal(data.int(2), 2n);
      assert.equal(data.int(4), 1n);
      this.reply(
        id,
        action,
        encode({ 2: [this.conversation("7"), this.conversation("1001")] }),
      );
    } else if (action === 43) {
      this.reply(
        id,
        action,
        encode({
          1: this.conversation(
            this.wrongConversation ? "different-id" : data.text(1),
          ),
        }),
      );
    } else if (action === 2) {
      if (this.holdReads)
        this.pendingReads.push({ id, conversation: data.text(2) });
      else this.readReply(id, data.text(2));
    } else if (action === 3) {
      assert.equal(data.text(2), "7");
      const message = data.message(3);
      assert.equal(message.text(7), "7");
      assert.equal(message.text(9), "self-55");
      assert.deepEqual(data.bytes(4), Buffer.from([8, 2, 16, 1]));
      assert.equal(message.text(1), data.text(5));
      assert.equal(message.text(12), data.text(5));
      assert.equal(
        message.messages(10)[0]?.message(2).text(1),
        "Hello 🛰\nsecond line",
      );
      assert.equal(
        message.has(6),
        false,
        "do not duplicate content in the legacy field",
      );
      // Intermediate unencrypted relay messages must not resolve the phone waiter.
      this.reply(id, action, encode({ 3: 1 }), false);
      this.sendId = id;
    } else
      assert.ok([17, 22, 47].includes(action), `Unexpected action ${action}`);
    return json([[null, "relay-accepted"]]);
  }

  private serverInit: Buffer = Buffer.alloc(0);
  private conversation(id: string): Buffer {
    return encode({
      1: id,
      2: id === "7" ? "Ada" : "Grace",
      4: encode({ 1: id === "7" ? "First snippet" : "Other snippet" }),
      5: 1700000000123000n,
      6: id === "7" ? 1 : 0,
      11: "self-55",
    });
  }
  private readReply(id: string, conversation: string) {
    const message = (
      mid: string,
      status: number,
      timestamp: bigint,
      text: string,
    ) =>
      encode({
        1: mid,
        4: encode({ 2: status }),
        5: timestamp,
        7: conversation,
        10: encode({ 2: encode({ 1: text }) }),
      });
    this.reply(
      id,
      2,
      encode({
        2: [
          message("new", 1, 1700000002000000n, `Sent in ${conversation}`),
          message("old", 100, 1700000001000000n, `Received in ${conversation}`),
        ],
        4: 2,
      }),
    );
  }
  releaseReads() {
    for (const request of this.pendingReads.splice(0).reverse())
      this.readReply(request.id, request.conversation);
  }
  confirmPairing(accepted = true) {
    this.reply(
      this.finishId,
      45,
      accepted ? Buffer.alloc(0) : encode({ 1: 1, 2: 5 }),
      false,
    );
  }
  confirmSend() {
    this.reply(this.sendId, 3, encode({ 3: this.sendRejected ? 2 : 1 }));
  }
  presenceCheck() {
    this.reply("unsolicited-presence", 16, encode({ 7: Buffer.alloc(0) }));
  }
  disconnect() {
    this.controller?.error(new Error("fixture network loss"));
  }
  revoke() {
    this.reply(
      "revoke",
      16,
      encode({ 15: encode({ 1: "test@example.test", 2: 0 }) }),
    );
  }
  private reply(id: string, action: number, data: Buffer, encrypted = true) {
    const packet = encode({
      1: id,
      4: action,
      [encrypted ? 8 : 5]: encrypted
        ? seal(data, this.keys as RequestKeys)
        : data,
    });
    const envelope = Array<unknown>(23).fill(null);
    envelope[0] = `response-${++this.sequence}`;
    envelope[1] = 19;
    envelope[11] = packet.toString("base64");
    this.frame([null, envelope]);
  }
  private frame(value: unknown[]) {
    const bytes = Buffer.from(
      `${this.first ? "" : ","}${JSON.stringify(value)}`,
    );
    this.first = false;
    // Exercise chunk boundaries within nested arrays and protobuf Base64 strings.
    this.controller?.enqueue(bytes.subarray(0, 3));
    this.controller?.enqueue(bytes.subarray(3));
  }
}

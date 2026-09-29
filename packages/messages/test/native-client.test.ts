import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeClient } from "../src/native/client.js";
import { SessionStore } from "../src/native/store.js";
import { SendLedger } from "../src/send-ledger.js";
import { PhoneFixture, testCookies, until } from "./native-fixture.js";

async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "native-client-"));
  const peer = new PhoneFixture();
  const client = await NativeClient.open(join(directory, "native"), {
    fetch: peer.fetch,
  });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, peer, client };
}
async function pair(client: NativeClient, peer: PhoneFixture) {
  await client.beginPairing(testCookies);
  await until(() => peer.finishId !== "", peer);
  assert.equal(client.pairingStatus().state, "awaiting_phone");
  assert.ok(client.pairingStatus().emoji);
  assert.notEqual((await client.status()).state, "paired");
  peer.confirmPairing();
  await until(() => client.pairingStatus().state === "paired", peer);
}

test("native login requires phone confirmation, then reads exact conversations without browser or read receipts", async (t) => {
  const { client, peer } = await setup(t);
  assert.deepEqual(await client.status(), {
    state: "pairing_required",
    transport: "native",
    connected: false,
  });
  assert.equal(peer.requests, 0);
  await pair(client, peer);
  await assert.rejects(client.beginPairing(testCookies), {
    code: "PAIRING_BUSY",
  });
  assert.deepEqual(await client.listConversations(2), {
    conversations: [
      {
        id: "7",
        name: "Ada",
        snippet: "First snippet",
        timestamp: "2023-11-14T22:13:20.123Z",
        unread: true,
      },
      {
        id: "1001",
        name: "Grace",
        snippet: "Other snippet",
        timestamp: "2023-11-14T22:13:20.123Z",
        unread: false,
      },
    ],
    limited: true,
  });
  assert.equal(peer.actions.find((a) => a.action === 1)?.type, 16);
  const messages = await client.readMessages("7", 2);
  assert.equal(messages.coverage, "recent");
  assert.deepEqual(messages.messages, [
    {
      id: "old",
      direction: "incoming",
      text: "Received in 7",
      timestamp: "2023-11-14T22:13:21.000Z",
    },
    {
      id: "new",
      direction: "outgoing",
      text: "Sent in 7",
      timestamp: "2023-11-14T22:13:22.000Z",
    },
  ]);
  assert.equal(
    peer.actions.some((a) => a.action === 10),
    false,
  );
  peer.presenceCheck();
  await until(() => peer.actions.some((a) => a.action === 17), peer);
  await until(() => peer.acked.length >= 2, peer);
});

test("native action replies are correlated even when the phone returns concurrent reads in reverse order", async (t) => {
  const { client, peer } = await setup(t);
  await pair(client, peer);
  peer.holdReads = true;
  const first = client.readMessages("7", 2);
  const second = client.readMessages("1001", 2);
  await until(
    () => peer.actions.filter((a) => a.action === 2).length === 2,
    peer,
  );
  peer.releaseReads();
  assert.equal((await first).messages[0]?.text, "Received in 7");
  assert.equal((await second).messages[0]?.text, "Received in 1001");
});

test("native sending waits for the encrypted phone result and uses the exact self participant/SIM", async (t) => {
  const { client, peer } = await setup(t);
  await pair(client, peer);
  let settled = false;
  const send = client
    .sendText({ conversationId: "7", text: "Hello 🛰\nsecond line" })
    .then((result) => {
      settled = true;
      return result;
    });
  await until(() => !!peer.sendId, peer);
  assert.equal(
    settled,
    false,
    "relay acceptance or plaintext intermediate packet is not phone acceptance",
  );
  peer.confirmSend();
  assert.deepEqual(
    { ...(await send), submittedAt: "time" },
    {
      conversationId: "7",
      status: "submitted",
      delivery: "unconfirmed",
      submittedAt: "time",
    },
  );
  peer.wrongConversation = true;
  await assert.rejects(
    client.sendText({ conversationId: "7", text: "Do not send" }),
    { code: "CONVERSATION_NOT_FOUND" },
  );
  assert.equal(peer.actions.filter((a) => a.action === 3).length, 1);
});

test("an encrypted phone rejection is not a successful send and is never retried", async (t) => {
  const { client, peer } = await setup(t);
  await pair(client, peer);
  peer.sendRejected = true;
  const rejected = assert.rejects(
    client.sendText({ conversationId: "7", text: "Hello 🛰\nsecond line" }),
    { code: "SEND_REJECTED" },
  );
  await until(() => !!peer.sendId, peer);
  peer.confirmSend();
  await rejected;
  assert.equal(peer.actions.filter((a) => a.action === 3).length, 1);
});

test("uncertain phone sends stay reserved rather than being retried after disconnect", async (t) => {
  const { client, peer, directory } = await setup(t);
  await pair(client, peer);
  const ledger = new SendLedger(join(directory, "sends"));
  const request = { conversationId: "7", text: "Hello 🛰\nsecond line" };
  const result = ledger.execute("test-native-uncertain", request, () =>
    client.sendText(request),
  );
  const rejected = assert.rejects(result);
  await until(() => !!peer.sendId, peer);
  await client.close();
  await rejected;
  await assert.rejects(
    new SendLedger(join(directory, "sends")).execute(
      "test-native-uncertain",
      request,
      async () => {
        assert.fail("must not send twice");
      },
    ),
    { code: "SEND_UNCERTAIN" },
  );
});

test("server restart refreshes signed relay credentials and reconnects without repeating desktop login", async (t) => {
  const { client, peer, directory } = await setup(t);
  await pair(client, peer);
  await client.close();
  const store = await SessionStore.open(join(directory, "native"));
  const saved = (await store.load()) as Record<string, unknown>;
  saved.expiresAt = Date.now() - 1000;
  await store.save(saved);
  await store.close();
  const resumed = await NativeClient.open(join(directory, "native"), {
    fetch: peer.fetch,
  });
  try {
    await until(() => resumed.pairingStatus().state === "paired", peer);
    assert.equal(peer.signIns, 1);
    assert.equal(peer.refreshes, 1);
    assert.equal(
      (await resumed.listConversations(2)).conversations[1]?.name,
      "Grace",
    );
  } finally {
    await resumed.close();
  }
});

test("Google authentication failure leaves setup retryable with no credential text in status", async (t) => {
  const { client, peer } = await setup(t);
  peer.rejectAuth = true;
  await client.beginPairing(testCookies);
  await until(() => client.pairingStatus().state === "error", peer);
  assert.equal(
    JSON.stringify(client.pairingStatus()).includes("private-cookie"),
    false,
  );
  assert.equal((await client.status()).state, "pairing_required");
});

test("restart retries a temporary config outage without losing the paired session", async (t) => {
  const { client, peer, directory } = await setup(t);
  await pair(client, peer);
  await client.close();
  peer.unavailableConfig = 1;
  const resumed = await NativeClient.open(join(directory, "native"), {
    fetch: peer.fetch,
  });
  try {
    await until(() => resumed.pairingStatus().state === "paired", peer);
    assert.equal(peer.signIns, 1);
  } finally {
    await resumed.close();
  }
});

test("stream loss reconnects read transport, while revoked pairing is erased and never resumed", async (t) => {
  const { client, peer, directory } = await setup(t);
  await pair(client, peer);
  peer.disconnect();
  await until(
    () => peer.streams === 2 && client.pairingStatus().state === "paired",
    peer,
  );
  assert.equal((await client.listConversations(2)).conversations.length, 2);
  peer.holdReads = true;
  const pending = assert.rejects(client.readMessages("7", 2), {
    code: "PHONE_DISCONNECTED",
  });
  peer.revoke();
  await pending;
  await until(() => client.pairingStatus().state === "error", peer);
  await client.close();
  const resumed = await NativeClient.open(join(directory, "native"), {
    fetch: peer.fetch,
  });
  try {
    assert.equal(resumed.pairingStatus().state, "needs_login");
    assert.equal(peer.streams, 2);
  } finally {
    await resumed.close();
  }
});

test("a rejected emoji does not persist usable pairing keys", async (t) => {
  const { client, peer, directory } = await setup(t);
  await client.beginPairing(testCookies);
  await until(() => !!peer.finishId, peer);
  peer.confirmPairing(false);
  await until(() => client.pairingStatus().state === "error", peer);
  await client.close();
  const store = await SessionStore.open(join(directory, "native"));
  try {
    assert.equal(
      ((await store.load()) as Record<string, unknown>).keys,
      undefined,
    );
  } finally {
    await store.close();
  }
});

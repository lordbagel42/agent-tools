import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/types.js";
import { browserFixture } from "./fixture.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof ApiError && error.code === expected;

test("QR state returns only the QR image and enables remembered pairing", async (t) => {
  const fixture = await browserFixture("qr");
  t.after(fixture.close);
  assert.equal((await fixture.client.status()).state, "qr_ready");
  const image = await fixture.client.pairingQr();
  assert.equal(image?.subarray(1, 4).toString(), "PNG");
  assert.equal(
    await fixture.page.getByRole("switch").getAttribute("aria-checked"),
    "true",
  );
  await assert.rejects(
    fixture.client.listConversations(3),
    code("PAIRING_REQUIRED"),
  );
});

test("conversation collection traverses virtual rows, deduplicates and resets to the newest row", async (t) => {
  const fixture = await browserFixture();
  t.after(fixture.close);
  const result = await fixture.client.listConversations(10);
  assert.deepEqual(
    result.conversations.map((item) => item.id),
    ["384", "901", "1702"],
  );
  assert.deepEqual(result.conversations[0], {
    id: "384",
    name: "Contact 384",
    snippet: "preview 384",
    timestamp: "2026-09-25T12:00:00Z",
    unread: true,
  });
  assert.equal(result.conversations[1]?.unread, false);
  const limited = await fixture.client.listConversations(1);
  assert.deepEqual(
    limited.conversations.map((item) => item.id),
    ["384"],
  );
  assert.equal(limited.limited, true);
});

test("reading preserves direction, Unicode and line breaks without duplicating nested text", async (t) => {
  const fixture = await browserFixture();
  t.after(fixture.close);
  const result = await fixture.client.readMessages("384", 4);
  assert.deepEqual(result, {
    conversationId: "384",
    coverage: "visible",
    order: "oldest-first",
    messages: [
      {
        id: "in-1",
        direction: "incoming",
        text: "coffee & tea",
        timestamp: "2026-09-25T13:20:00Z",
      },
      {
        id: "out-2",
        direction: "outgoing",
        text: "first line\n🥔 second",
        timestamp: null,
      },
      { id: null, direction: "unknown", text: "unclassified", timestamp: null },
      { id: null, direction: "outgoing", text: "hello", timestamp: null },
    ],
  });
  const limited = await fixture.client.readMessages("384", 1);
  assert.deepEqual(
    limited.messages.map((message) => message.text),
    ["hello"],
  );
});

test("send requires a fresh outgoing bubble even if identical text is already in history", async (t) => {
  const fixture = await browserFixture();
  t.after(fixture.close);
  const receipt = await fixture.client.sendText({
    conversationId: "384",
    text: "hello",
  });
  assert.equal(receipt.status, "submitted");
  assert.equal(receipt.delivery, "unconfirmed");
  assert.equal(Number.isFinite(Date.parse(receipt.submittedAt)), true);
  assert.deepEqual(fixture.sent, [{ conversationId: "384", text: "hello" }]);
});

for (const mode of ["clear-only", "incoming-only"] as const) {
  test(`${mode} cannot be mistaken for a confirmed outgoing submission`, async (t) => {
    const fixture = await browserFixture(mode);
    t.after(fixture.close);
    await assert.rejects(
      fixture.client.sendText({ conversationId: "384", text: "hello" }),
      code("SEND_UNCERTAIN"),
    );
    assert.equal(fixture.sent.length, 1);
  });
}

test("an existing message gaining an ID is not evidence of a new send", async (t) => {
  const fixture = await browserFixture("clear-only");
  t.after(fixture.close);
  await fixture.client.readMessages("384", 1);
  await fixture.page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>(
      "mws-message-send-button button",
    );
    if (!button?.onclick) throw new Error("Missing fixture send handler");
    const original = button.onclick;
    button.onclick = async function (event) {
      await original.call(this, event);
      document
        .querySelector("mws-message-wrapper:last-child")
        ?.setAttribute("data-e2e-message-id", "late-assigned-id");
    };
  });
  await assert.rejects(
    fixture.client.sendText({ conversationId: "384", text: "hello" }),
    code("SEND_UNCERTAIN"),
  );
});

test("existing drafts are preserved without clicking Send", async (t) => {
  const fixture = await browserFixture("draft");
  t.after(fixture.close);
  await assert.rejects(
    fixture.client.sendText({ conversationId: "384", text: "replacement" }),
    code("DRAFT_PRESENT"),
  );
  assert.equal(
    await fixture.page.locator("textarea").inputValue(),
    "my unfinished draft",
  );
  assert.deepEqual(fixture.sent, []);
});

test("a redirect to another conversation must not read or send to that conversation", async (t) => {
  const fixture = await browserFixture("redirect");
  t.after(fixture.close);
  await assert.rejects(
    fixture.client.readMessages("999", 10),
    code("CONVERSATION_NOT_FOUND"),
  );
  await assert.rejects(
    fixture.client.sendText({ conversationId: "999", text: "never send" }),
    code("CONVERSATION_NOT_FOUND"),
  );
  assert.deepEqual(fixture.sent, []);
});

test("concurrent sends to different conversations keep their destinations and bodies", async (t) => {
  const fixture = await browserFixture();
  t.after(fixture.close);
  await Promise.all([
    fixture.client.sendText({ conversationId: "384", text: "first\n🥔" }),
    fixture.client.sendText({ conversationId: "901", text: "second & final" }),
  ]);
  assert.deepEqual(fixture.sent, [
    { conversationId: "384", text: "first\n🥔" },
    { conversationId: "901", text: "second & final" },
  ]);
});

test("unsafe IDs, blank messages and out-of-range limits fail before navigation", async (t) => {
  const fixture = await browserFixture();
  t.after(fixture.close);
  const originalUrl = fixture.page.url();
  for (const id of ["../logout", "new", "a/b", "https://example.com"]) {
    await assert.rejects(
      fixture.client.readMessages(id, 5),
      code("INVALID_REQUEST"),
    );
  }
  await assert.rejects(
    fixture.client.sendText({ conversationId: "384", text: " \n" }),
    code("INVALID_REQUEST"),
  );
  for (const limit of [0, -1, 201, 1.5, Number.NaN]) {
    await assert.rejects(
      fixture.client.listConversations(limit),
      code("INVALID_REQUEST"),
    );
  }
  assert.equal(fixture.page.url(), originalUrl);
  assert.deepEqual(fixture.sent, []);
});

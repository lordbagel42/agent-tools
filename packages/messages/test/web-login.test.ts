import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../src/types.js";
import { loginFixture } from "./login-fixture.js";

const code = (value: string) => (error: unknown) =>
  error instanceof ApiError && error.code === value;

test("login waits for the welcome app to render its sign-in button after reload", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  await fixture.page
    .context()
    .route("https://messages.google.com/web/welcome", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<mw-welcome-page-container></mw-welcome-page-container><script>
      setTimeout(() => {
        const button = document.createElement('button');
        button.textContent = 'Sign In';
        button.onclick = () => location.href = 'https://accounts.google.com/signin';
        document.querySelector('mw-welcome-page-container').append(button);
      }, 100);
    </script>`,
      }),
    );
  const lease = await fixture.login.start();
  assert.equal(
    (await fixture.login.frame(lease.token)).origin,
    "https://accounts.google.com",
  );
});

test("opening a new login view recovers from a blocked external navigation", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  await fixture.login.start();
  await assert.rejects(fixture.page.goto("https://outside.invalid/"));
  const lease = await fixture.login.start();
  assert.equal(
    (await fixture.login.frame(lease.token)).origin,
    "https://accounts.google.com",
  );
});

test("web login inserts exact text into the clicked Google field and supports keyboard navigation", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  const lease = await fixture.login.start();
  const frame = await fixture.login.frame(lease.token);
  assert.equal(frame.origin, "https://accounts.google.com");
  assert.equal(frame.image.subarray(1, 4).toString(), "PNG");
  const box = await fixture.page.locator("#email").boundingBox();
  assert.ok(box);
  await fixture.login.input(lease.token, {
    type: "click",
    version: frame.version,
    x: box.x + 12,
    y: box.y + 12,
  });
  await fixture.login.input(lease.token, {
    type: "text",
    version: frame.version,
    text: "person+api@example.test",
  });
  await fixture.login.input(lease.token, {
    type: "key",
    version: frame.version,
    key: "Tab",
  });
  await fixture.login.input(lease.token, {
    type: "text",
    version: frame.version,
    text: "synthetic & <password> 🥔",
  });
  assert.equal(
    await fixture.page.locator("#email").inputValue(),
    "person+api@example.test",
  );
  assert.equal(
    await fixture.page.locator("#password").inputValue(),
    "synthetic & <password> 🥔",
  );
});

test("login rejects unknown commands, navigation shortcuts, malformed versions and out-of-bounds clicks", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  const { token } = await fixture.login.start();
  const { version } = await fixture.login.frame(token);
  for (const body of [
    null,
    [],
    {},
    { type: "eval", version, script: "location.href='file:///etc/passwd'" },
    { type: "key", version, key: "Control+L" },
    { type: "text", version, text: "x", url: "https://outside.invalid" },
    { type: "text", version: -1, text: "x" },
    { type: "text", version, text: "x".repeat(4097) },
    { type: "click", version, x: -1, y: 3 },
    { type: "click", version, x: 1280, y: 3 },
    { type: "click", version, x: 3, y: 720 },
    { type: "scroll", version, deltaY: 10000 },
  ])
    await assert.rejects(
      fixture.login.input(token, body),
      code("INVALID_REQUEST"),
    );
  assert.equal(await fixture.page.locator("#email").inputValue(), "");
});

test("control tokens are required and expire on replacement, stop, or the 15-minute deadline", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  const first = await fixture.login.start();
  await assert.rejects(fixture.login.frame("wrong"), code("LOGIN_EXPIRED"));
  const second = await fixture.login.start();
  assert.notEqual(first.token, second.token);
  await assert.rejects(fixture.login.frame(first.token), code("LOGIN_EXPIRED"));
  fixture.login.stop(second.token);
  await assert.rejects(
    fixture.login.frame(second.token),
    code("LOGIN_EXPIRED"),
  );
  const third = await fixture.login.start();
  t.mock.method(Date, "now", () => third.expiresAt);
  await assert.rejects(fixture.login.frame(third.token), code("LOGIN_EXPIRED"));
});

test("stale screenshots cannot drive a new document and paired conversations cannot be viewed or controlled", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  const { token } = await fixture.login.start();
  const { version } = await fixture.login.frame(token);
  await fixture.page.goto("https://messages.google.com/web/pair");
  assert.equal((await fixture.client.status()).state, "pairing_required");
  await assert.rejects(
    fixture.login.input(token, { type: "key", version, key: "Enter" }),
    code("LOGIN_SCREEN_CHANGED"),
  );
  const emoji = await fixture.login.frame(token);
  assert.equal(emoji.origin, "https://messages.google.com");
  await fixture.page.goto("https://messages.google.com/web/conversations");
  await assert.rejects(fixture.login.frame(token), code("ALREADY_PAIRED"));
  await assert.rejects(
    fixture.login.input(token, {
      type: "text",
      version: emoji.version,
      text: "must not become a message",
    }),
  );
  assert.equal(await fixture.page.locator("textarea").inputValue(), "");
  await assert.rejects(fixture.login.start(), code("ALREADY_PAIRED"));
});

test("a frame captured during pairing is discarded instead of returning private pixels", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  const { token } = await fixture.login.start();
  const screenshot = fixture.page.screenshot.bind(fixture.page);
  t.mock.method(
    fixture.page,
    "screenshot",
    async (...args: Parameters<typeof screenshot>) => {
      await fixture.page.goto("https://messages.google.com/web/conversations");
      return screenshot(...args);
    },
  );
  await assert.rejects(fixture.login.frame(token), code("ALREADY_PAIRED"));
});

test("unknown conversation markup and non-Google top-level navigation do not open a general browser", async (t) => {
  const fixture = await loginFixture();
  t.after(fixture.close);
  const { token } = await fixture.login.start();
  await fixture.page.goto(
    "https://messages.google.com/web/conversations?unknown=1",
  );
  await assert.rejects(
    fixture.login.frame(token),
    code("LOGIN_PAGE_UNAVAILABLE"),
  );
  await assert.rejects(fixture.page.goto("https://outside.invalid/"));
});

for (const transition of ["navigation", "same-document"] as const) {
  for (const kind of ["text", "enter", "click"] as const) {
    test(`${kind} cannot reach the composer if pairing completes during native input (${transition})`, async (t) => {
      const fixture = await loginFixture();
      t.after(fixture.close);
      const { token } = await fixture.login.start();
      await fixture.page.goto("https://messages.google.com/web/pair");
      const { version } = await fixture.login.frame(token);
      const completePairing = async () => {
        if (transition === "navigation")
          await fixture.page.goto(
            "https://messages.google.com/web/conversations",
          );
        await fixture.page.evaluate(() => {
          // Include stale auth/QR nodes: paired evidence must take precedence.
          if (!document.querySelector("mws-conversations-list")) {
            document.body.insertAdjacentHTML(
              "beforeend",
              '<mws-conversations-list>Private conversations</mws-conversations-list><textarea aria-label="Text message"></textarea><button id="send">Send</button><div data-e2e-qr-code>stale QR</div>',
            );
          }
          const input = document.querySelector("textarea");
          if (!input) throw new Error("Fixture composer missing");
          input.focus();
          window.addEventListener("keydown", (event) => {
            if (event.key === "Enter") document.body.dataset.sent = "true";
          });
          const button = document.querySelector<HTMLButtonElement>(
            "#send, mws-message-send-button button",
          );
          if (!button) throw new Error("Fixture send button missing");
          button.style.cssText =
            "position:fixed;left:20px;top:20px;width:150px;height:60px";
          button.onclick = () => {
            document.body.dataset.sent = "true";
          };
        });
      };
      if (kind === "text") {
        const insertText = fixture.page.keyboard.insertText.bind(
          fixture.page.keyboard,
        );
        t.mock.method(
          fixture.page.keyboard,
          "insertText",
          async (text: string) => {
            await completePairing();
            return insertText(text);
          },
        );
      } else if (kind === "enter") {
        const press = fixture.page.keyboard.press.bind(fixture.page.keyboard);
        t.mock.method(fixture.page.keyboard, "press", async (key: string) => {
          await completePairing();
          return press(key);
        });
      } else {
        const click = fixture.page.mouse.click.bind(fixture.page.mouse);
        t.mock.method(
          fixture.page.mouse,
          "click",
          async (x: number, y: number) => {
            await completePairing();
            return click(x, y);
          },
        );
      }
      const action =
        kind === "text"
          ? { type: "text", text: "must never reach composer" }
          : kind === "enter"
            ? { type: "key", key: "Enter" }
            : { type: "click", x: 30, y: 30 };
      await assert.rejects(
        fixture.login.input(token, { ...action, version }),
        code("ALREADY_PAIRED"),
      );
      assert.equal(await fixture.page.locator("textarea").inputValue(), "");
      assert.equal(
        await fixture.page.locator("body").getAttribute("data-sent"),
        null,
      );
      t.mock.restoreAll();
      if (transition === "navigation" && kind === "text") {
        const receipt = await fixture.client.sendText({
          conversationId: "384",
          text: "Authorized fixture API send after login",
        });
        assert.equal(receipt.status, "submitted");
      }
    });
  }
}

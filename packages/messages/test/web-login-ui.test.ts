import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { Locator } from "playwright";
import { buildPairingApp } from "../src/pairing.js";
import { loginFixture } from "./login-fixture.js";

test("web GUI controls the dedicated login at desktop/mobile sizes and clears it on close or pairing", async (t) => {
  const fixture = await loginFixture();
  const app = buildPairingApp(fixture.client, undefined, fixture.login);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = fixture.page.context().browser();
  assert.ok(browser);
  // The viewer is a separate browser context, not a page in the controlled context.
  const view = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  view.setDefaultTimeout(6000);
  const errors: string[] = [];
  view.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => {
    await view.close();
    await app.close();
    await fixture.close();
  });
  const capture = async (name: string) => {
    if (!process.env.CAPTURE_DIR) return;
    await mkdir(process.env.CAPTURE_DIR, { recursive: true });
    await view.screenshot({
      path: join(process.env.CAPTURE_DIR, `${name}.png`),
      fullPage: true,
    });
  };
  const screen = view.getByRole("application", {
    name: "Interactive Google sign-in screen",
  });
  const clickRemote = async (target: Locator) => {
    const box = await target.boundingBox();
    assert.ok(box);
    const size = await screen.evaluate((node) => {
      const image = node as HTMLImageElement;
      return {
        width: image.clientWidth,
        height: image.clientHeight,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      };
    });
    await screen.click({
      position: {
        x: ((box.x + 15) * size.width) / size.naturalWidth,
        y: ((box.y + 15) * size.height) / size.naturalHeight,
      },
    });
  };
  const ready = () =>
    view.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#login-screen");
      return image?.complete && image.naturalWidth > 0;
    });
  await view.goto(address);
  await view
    .getByRole("button", { name: "Open Google sign-in", exact: true })
    .click();
  await screen.waitFor();
  await ready();
  assert.equal(
    await view.locator("#login-origin").innerText(),
    "https://accounts.google.com",
  );
  // Keep a subsequent PNG decode in flight: refreshing the same document must not drop typing.
  await view.evaluate(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      HTMLImageElement.prototype.decode = decode;
      document.body.dataset.decoding = "true";
      return new Promise<void>((resolve) =>
        window.addEventListener("finish-frame-decode", () => resolve(), {
          once: true,
        }),
      ).then(() => decode.call(this));
    };
  });
  await view.waitForFunction(() => document.body.dataset.decoding === "true");
  await clickRemote(fixture.page.getByLabel("Email", { exact: true }));
  await screen.pressSequentially("person+web@example.test");
  await fixture.page
    .waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>("#email")?.value ===
        "person+web@example.test",
      undefined,
      { timeout: 5000 },
    )
    .catch(async () => {
      assert.equal(
        await fixture.page.locator("#email").inputValue(),
        "person+web@example.test",
        await view.locator("#login-note").innerText(),
      );
    });
  await view.evaluate(() =>
    window.dispatchEvent(new Event("finish-frame-decode")),
  );

  await view.setViewportSize({ width: 390, height: 844 });
  await view
    .getByRole("button", { name: "Full-size view", exact: true })
    .click();
  assert.equal(
    await screen.evaluate(
      (node) => node.clientWidth === (node as HTMLImageElement).naturalWidth,
    ),
    true,
  );
  assert.equal(
    await view.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await clickRemote(fixture.page.getByLabel("Password", { exact: true }));
  const helper = view.getByLabel("Text for the selected Google field");
  assert.equal(await helper.getAttribute("type"), "password");
  await helper.fill("synthetic & <password> 🥔");
  await view.getByRole("button", { name: "Type text", exact: true }).click();
  await fixture.page.waitForFunction(
    () =>
      document.querySelector<HTMLInputElement>("#password")?.value ===
      "synthetic & <password> 🥔",
  );
  assert.equal(await helper.inputValue(), "");
  assert.equal(
    await view.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await capture("web-login-mobile-full-size-fixture");
  await view.getByRole("button", { name: "Fit screen", exact: true }).click();
  await capture("web-login-mobile-fixture");
  await view.setViewportSize({ width: 1280, height: 1000 });
  await capture("web-login-desktop-fixture");

  await view
    .getByRole("button", { name: "Close login view", exact: true })
    .click();
  assert.equal(await view.locator("#login-screen").getAttribute("src"), null);
  assert.equal(await screen.isVisible(), false);
  await view
    .getByRole("button", { name: "Open Google sign-in", exact: true })
    .click();
  await ready();
  await clickRemote(
    fixture.page.getByRole("button", { name: "Next", exact: true }),
  );
  await view
    .locator("#login-origin")
    .filter({ hasText: "https://messages.google.com" })
    .waitFor();
  await capture("web-login-emoji-fixture");

  await fixture.page.goto("https://messages.google.com/web/conversations");
  await view
    .getByRole("status")
    .filter({ hasText: "Paired successfully" })
    .waitFor();
  assert.equal(await view.locator("#login-screen").getAttribute("src"), null);
  assert.equal(await screen.isVisible(), false);
  assert.equal(await helper.inputValue(), "");
  assert.doesNotMatch(await view.locator("body").innerText(), /PRIVATE TEXTS/);
  assert.equal(
    await view.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  await capture("web-login-paired-fixture");
  assert.deepEqual(errors, []);
});

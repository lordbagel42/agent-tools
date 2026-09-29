import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildPairingApp } from "../src/pairing.js";
import type { SessionStatus } from "../src/types.js";
import { browserFixture } from "./fixture.js";

test("pairing UI distinguishes account pairing, legacy QR, paired and closed states", async (t) => {
  const fixture = await browserFixture("qr");
  let state: SessionStatus["state"] = "paired";
  let qrAvailable = false;
  const qr = await fixture.client.pairingQr();
  fixture.client.status = async () => ({ state, transport: "browser" });
  fixture.client.pairingQr = async () => (qrAvailable ? qr : null);
  const app = buildPairingApp(fixture.client);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const view = await fixture.page.context().newPage();
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
  await view.goto(address);
  await view
    .getByRole("status")
    .filter({ hasText: "Paired successfully" })
    .waitFor();
  assert.equal(await view.locator("#qr").isVisible(), false);
  assert.equal(await view.locator("#qr").getAttribute("src"), null);
  await capture("pairing-paired-fixture");

  state = "closed";
  await view
    .getByRole("status")
    .filter({ hasText: "browser session closed" })
    .waitFor();
  assert.doesNotMatch(await view.locator("h1").innerText(), /connected/i);
  await capture("pairing-closed-fixture");

  state = "pairing_required";
  await view
    .getByRole("status")
    .filter({ hasText: /Google-account pairing|not provided a QR code/ })
    .waitFor();
  assert.equal(await view.locator("#account-pairing").isVisible(), true);
  assert.equal(await view.locator("#qr-pairing").isVisible(), false);
  await capture("pairing-account-desktop-fixture");
  await view.setViewportSize({ width: 390, height: 844 });
  await capture("pairing-account-mobile-fixture");
  assert.equal(await view.locator("#qr").isVisible(), false);
  assert.equal(
    await view.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );

  state = "qr_ready";
  qrAvailable = true;
  await view.getByRole("status").filter({ hasText: "Ready to scan" }).waitFor();
  assert.equal(await view.locator("#account-pairing").isVisible(), false);
  assert.equal(await view.locator("#qr-pairing").isVisible(), true);
  assert.equal(await view.locator("#qr").isVisible(), true);
  await capture("pairing-legacy-qr-fixture");

  // An expired legacy QR reports pairing_required until /qr renews it.
  state = "pairing_required";
  await view.reload();
  await view
    .getByRole("status")
    .filter({ hasText: /Google-account pairing|Ready to scan/ })
    .waitFor();
  assert.equal(await view.locator("#qr").isVisible(), true);
  assert.equal(await view.locator("#account-pairing").isVisible(), false);

  state = "paired";
  qrAvailable = false;
  await view
    .getByRole("status")
    .filter({ hasText: "Paired successfully" })
    .waitFor();
  assert.equal(await view.locator("#qr").getAttribute("src"), null);
  assert.equal(await view.locator("#account-pairing").isVisible(), false);
  assert.equal(await view.locator("#qr-pairing").isVisible(), false);
  assert.deepEqual(errors, []);
});

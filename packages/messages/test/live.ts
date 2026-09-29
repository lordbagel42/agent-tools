import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { openBrowser } from "../src/browser.js";
import { ApiError } from "../src/types.js";
import { WebLogin } from "../src/web-login.js";

// Explicit opt-in: connects to Google, but never pairs a phone, reads texts, or sends.
test("live default startup reaches Google-account sign-in without forcing a QR", async (t) => {
  const profileDir = await mkdtemp(join(tmpdir(), "gm-account-live-"));
  t.after(() => rm(profileDir, { recursive: true }));
  const browser = await openBrowser({
    profileDir,
    headless: process.env.HEADED !== "1",
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  });
  try {
    assert.equal((await browser.client.status()).state, "pairing_required");
    assert.equal(await browser.client.pairingQr(), null);
    const login = new WebLogin(browser.client);
    const lease = await login.start();
    await browser.client.page
      .getByRole("textbox", { name: "Email or phone", exact: true })
      .waitFor();
    assert.equal(
      new URL(browser.client.page.url()).hostname,
      "accounts.google.com",
    );
    assert.equal((await browser.client.status()).state, "pairing_required");
    let frame: Awaited<ReturnType<WebLogin["frame"]>> | undefined;
    // Like the GUI, poll again when Google's challenge iframes navigate during capture.
    // Only screenshots retry; input and authentication attempts are never replayed.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        frame = await login.frame(lease.token);
        break;
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== "LOGIN_SCREEN_CHANGED" ||
          attempt === 9
        )
          throw error;
        await setTimeout(500);
      }
    }
    assert.ok(frame);
    assert.equal(frame.origin, "https://accounts.google.com");
    assert.equal(frame.image.subarray(1, 4).toString(), "PNG");
    login.stop(lease.token);
  } finally {
    await browser.close();
  }
});

test("live Google issues a QR and the dedicated profile survives a browser restart", async (t) => {
  const profileDir = await mkdtemp(join(tmpdir(), "gm-live-"));
  t.after(() => rm(profileDir, { recursive: true }));
  const options = {
    profileDir,
    legacyQr: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
  };
  const first = await openBrowser(options);
  try {
    assert.equal((await first.client.status()).state, "qr_ready");
    const qr = await first.client.pairingQr();
    assert.ok(qr && qr.length > 1000);
    assert.equal(qr.subarray(1, 4).toString(), "PNG");
    assert.equal(
      await first.client.page
        .getByRole("switch", { name: "Remember this computer" })
        .getAttribute("aria-checked"),
      "true",
    );
    await first.client.page.evaluate(() =>
      localStorage.setItem("gm-api-smoke-marker", "persistent"),
    );
  } finally {
    await first.close();
  }
  const second = await openBrowser(options);
  try {
    assert.equal(
      await second.client.page.evaluate(() =>
        localStorage.getItem("gm-api-smoke-marker"),
      ),
      "persistent",
    );
    assert.equal((await second.client.status()).state, "qr_ready");
  } finally {
    await second.close();
  }
});

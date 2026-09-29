import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  buildNativePairingApp,
  type NativePairingClient,
  type PairingStatus,
} from "../src/native-pairing.js";

test("native pairing GUI presents safe desktop/mobile states without putting credentials in the page", async (t) => {
  let status = {
    state: "needs_login",
    cookies: { SID: "private-cookie-must-not-render" },
    token: "private-token-must-not-render",
  } as PairingStatus & Record<string, unknown>;
  const client: NativePairingClient = {
    pairingStatus: () => status,
    beginPairing: async () => undefined,
  };
  const app = buildNativePairingApp(client);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const pageErrors: string[] = [];
  const consoleMessages: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => consoleMessages.push(message.text()));
  t.after(async () => {
    await browser.close();
    await app.close();
  });

  const capture = async (name: string) => {
    if (!process.env.CAPTURE_DIR) return;
    await mkdir(process.env.CAPTURE_DIR, { recursive: true });
    await page.screenshot({
      path: join(process.env.CAPTURE_DIR, `native-pairing-${name}.png`),
      fullPage: true,
    });
  };
  const setStatus = (next: PairingStatus & Record<string, unknown>) => {
    status = next;
  };

  await page.goto(address);
  await page
    .getByRole("heading", { name: "Connect Google Messages." })
    .waitFor();
  assert.equal(await page.locator("#browser-setup").isVisible(), true);
  assert.equal(await page.locator("#helper-action").isVisible(), false);
  assert.equal(
    await page
      .getByRole("link", { name: "Download the local login helper" })
      .getAttribute("href"),
    "/helper.zip",
  );
  assert.match(await page.locator("#browser-setup").innerText(), /npm install/);
  assert.match(
    await page.locator("#helper-command").innerText(),
    new RegExp(`npm start -- ${address.replaceAll(".", "\\.")}`),
  );
  assert.equal(await page.locator("input, textarea").count(), 0);
  assert.equal(
    await page
      .locator("body")
      .innerText()
      .then((text) => text.includes("private-")),
    false,
  );
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
  await capture("needs-login-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await capture("needs-login-mobile");

  setStatus({ state: "connecting" });
  await page
    .getByRole("status")
    .filter({ hasText: "Starting a private pairing session" })
    .waitFor();
  assert.equal(await page.locator("#browser-setup").isVisible(), false);

  setStatus({ state: "awaiting_phone", emoji: "🌲 🥔" });
  await page.locator("#emoji").filter({ hasText: "🌲 🥔" }).waitFor();
  assert.match(
    await page.locator("#phone-instructions").innerText(),
    /Device pairing/i,
  );
  assert.match(await page.locator("#phone-instructions").innerText(), /match/i);
  await page.setViewportSize({ width: 1280, height: 900 });
  await capture("awaiting-phone-desktop");

  setStatus({ state: "paired" });
  await page
    .getByRole("heading", { name: "Your phone is connected." })
    .waitFor();
  assert.match(
    await page.getByRole("status").innerText(),
    /close this laptop/i,
  );
  assert.match(
    await page.getByRole("status").innerText(),
    /phone stays online/i,
  );
  await capture("paired-desktop");

  setStatus({
    state: "error",
    error: "SID=private-cookie at /private/server/path",
  });
  await page
    .getByRole("heading", { name: "Pairing needs attention." })
    .waitFor();
  const errorPage = await page.locator("body").innerText();
  assert.equal(errorPage.includes("private-cookie"), false);
  assert.equal(errorPage.includes("/private/server/path"), false);
  assert.equal(await page.locator("#browser-setup").isVisible(), true);

  await page.route("**/status", (route) => route.abort());
  await page
    .getByRole("heading", { name: "Pairing service unavailable." })
    .waitFor();
  assert.match(await page.getByRole("status").innerText(), /private portal/i);
  await capture("unavailable-desktop");

  assert.deepEqual(pageErrors, []);
  assert.equal(
    consoleMessages.some((message) => message.includes("private-")),
    false,
  );
});

test("the local helper bridge is the only interactive sign-in control and renders its result as text", async (t) => {
  const client: NativePairingClient = {
    pairingStatus: () => ({ state: "needs_login" }),
    beginPairing: async () => undefined,
  };
  const app = buildNativePairingApp(client);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    headless: true,
  });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const state = window as typeof window & { helperCalls?: number };
    Object.defineProperty(window, "messagesHelper", {
      configurable: false,
      value: Object.freeze({
        connect: async () => {
          state.helperCalls = (state.helperCalls ?? 0) + 1;
          return {
            ok: false,
            message: '<img id="helper-injection">Local sign-in was cancelled.',
          };
        },
      }),
    });
  });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") requests.push(request.url());
  });
  t.after(async () => {
    await browser.close();
    await app.close();
  });

  await page.goto(address);
  assert.equal(await page.locator("#browser-setup").isVisible(), false);
  assert.equal(await page.locator("#helper-action").isVisible(), true);
  assert.equal(await page.locator("input, textarea").count(), 0);
  await page
    .getByRole("button", { name: "Sign in locally with Google" })
    .click();
  await page
    .locator("#helper-message")
    .filter({ hasText: "Local sign-in was cancelled." })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => (window as typeof window & { helperCalls?: number }).helperCalls,
    ),
    1,
  );
  assert.equal(await page.locator("#helper-injection").count(), 0);
  assert.match(await page.locator("#helper-message").innerText(), /^<img/);
  assert.deepEqual(requests, []);
  assert.equal(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
    0,
  );
});

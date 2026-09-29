import { chmod, mkdir } from "node:fs/promises";
import { type BrowserContext, chromium } from "playwright";
import { MessagesPage } from "./messages-page.js";
import { ApiError } from "./types.js";

export type BrowserOptions = {
  profileDir: string;
  headless?: boolean;
  executablePath?: string;
  legacyQr?: boolean;
};

export async function openBrowser(options: BrowserOptions): Promise<{
  context: BrowserContext;
  client: MessagesPage;
  close: () => Promise<void>;
}> {
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  await chmod(options.profileDir, 0o700);
  const context = await chromium
    .launchPersistentContext(options.profileDir, {
      headless: options.headless ?? true,
      ...(options.executablePath
        ? { executablePath: options.executablePath }
        : {}),
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      acceptDownloads: false,
    })
    .catch(() => {
      throw new ApiError(
        503,
        "BROWSER_START_FAILED",
        "Could not start Chromium. Install Playwright Chromium or set CHROME_PATH, and ensure the dedicated profile is not already in use. Headed mode needs a desktop display.",
      );
    });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const client = new MessagesPage(page);
    await page.goto("https://messages.google.com/web/conversations", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForFunction(
      () =>
        location.origin === "https://accounts.google.com" ||
        document.querySelector(
          "mws-conversations-list, mws-conversation-list, mw-authentication-container, mw-welcome-page-container, mw-gaia-pairing-container, mw-pair-page-container",
        ),
      undefined,
      { timeout: 45_000 },
    );
    if (
      options.legacyQr &&
      (await page.locator("mw-welcome-page-container").count())
    ) {
      await page.goto("https://messages.google.com/web/authentication", {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
    }
    // Leave Google's normal account flow available. QR is no longer supported on many phones.
    if (options.legacyQr) {
      await page
        .locator(
          "mws-conversations-list, mws-conversation-list, [data-e2e-qr-code]",
        )
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined);
      await client.pairingQr();
    }
    return { context, client, close: () => context.close() };
  } catch (error) {
    await context.close();
    throw error;
  }
}

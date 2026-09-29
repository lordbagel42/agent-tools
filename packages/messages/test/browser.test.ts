import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { openBrowser } from "../src/browser.js";

for (const scenario of [
  {
    name: "default startup keeps Google-account sign-in available instead of forcing QR",
    legacyQr: false,
    paired: false,
    path: "/web/welcome",
    state: "pairing_required",
  },
  {
    name: "legacy QR startup is explicit",
    legacyQr: true,
    paired: false,
    path: "/web/authentication",
    state: "qr_ready",
  },
  {
    name: "startup preserves an already paired session even with the legacy QR option",
    legacyQr: true,
    paired: true,
    path: "/web/conversations",
    state: "paired",
  },
  {
    name: "startup resumes phone confirmation after Google-account sign-in",
    legacyQr: false,
    paired: false,
    path: "/web/pair",
    state: "pairing_required",
  },
  {
    name: "startup resumes an outstanding Google-account challenge",
    legacyQr: false,
    paired: false,
    path: "/signin/v2/challenge",
    state: "pairing_required",
  },
]) {
  test(scenario.name, async (t) => {
    const profileDir = await mkdtemp(join(tmpdir(), "gm-startup-"));
    t.after(() => rm(profileDir, { recursive: true }));
    // Launch real Chromium; intercept only Google's external responses before navigation.
    const launch = chromium.launchPersistentContext.bind(chromium);
    t.mock.method(
      chromium,
      "launchPersistentContext",
      async (...args: Parameters<typeof launch>) => {
        const context = await launch(...args);
        await context.route(
          /^https:\/\/(?:messages|accounts)\.google\.com\//,
          async (route) => {
            const path = new URL(route.request().url()).pathname;
            if (path === "/web/conversations" && !scenario.paired) {
              const target = scenario.legacyQr ? "/web/welcome" : scenario.path;
              const origin = target.startsWith("/signin")
                ? "https://accounts.google.com"
                : "https://messages.google.com";
              await route.fulfill({
                contentType: "text/html",
                body: `<script>location.replace(${JSON.stringify(origin + target)})</script>`,
              });
              return;
            }
            const body =
              path === "/web/welcome"
                ? "<mw-welcome-page-container><button>Sign In</button></mw-welcome-page-container>"
                : path === "/web/pair"
                  ? "<mw-gaia-pairing-container>Confirm emoji on your phone</mw-gaia-pairing-container>"
                  : path.startsWith("/signin")
                    ? '<input aria-label="Google challenge">'
                    : path === "/web/authentication"
                      ? '<mw-authentication-container><div data-e2e-qr-code style="width:100px;height:100px">Synthetic QR</div></mw-authentication-container>'
                      : '<mws-conversations-list style="display:block">Conversations</mws-conversations-list>';
            await route.fulfill({ contentType: "text/html", body });
          },
        );
        return context;
      },
    );
    const options = {
      profileDir,
      ...(scenario.legacyQr ? { legacyQr: true } : {}),
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : {}),
    };
    const browser = await openBrowser(options);
    try {
      assert.equal(new URL(browser.client.page.url()).pathname, scenario.path);
      assert.equal((await browser.client.status()).state, scenario.state);
      if (scenario.path === "/web/welcome") {
        assert.equal(
          await browser.client.page
            .getByRole("button", { name: "Sign In" })
            .isVisible(),
          true,
        );
        assert.equal(await browser.client.pairingQr(), null);
      }
    } finally {
      await browser.close();
    }
  });
}

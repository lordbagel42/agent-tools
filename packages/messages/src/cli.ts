#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openBrowser } from "./browser.js";
import { NativeClient } from "./native/client.js";
import { buildNativePairingApp } from "./native-pairing.js";
import { buildPairingApp } from "./pairing.js";
import { SendLedger } from "./send-ledger.js";
import { buildApi } from "./server.js";
import { prepareState } from "./state.js";
import { ApiError } from "./types.js";
import { WebLogin } from "./web-login.js";

function port(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
    throw new ApiError(
      400,
      "INVALID_OPTIONS",
      "Ports must be integers from 1024 to 65535.",
    );
  }
  return Number(value);
}

async function main() {
  const { values } = parseArgs({
    options: {
      browser: { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      "legacy-qr": { type: "boolean", default: false },
      "web-login": { type: "boolean", default: false },
      port: { type: "string" },
      "pairing-port": { type: "string" },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.info(`Google Messages API
Usage: messages [--port 8787] [--pairing-port 8788] [--state-dir .local]

The default native transport runs entirely on this server, without Chromium or a desktop.
Use the one-time local login helper and phone emoji approval to pair.
The bearer API binds to 127.0.0.1; its token is in STATE_DIR/api-token.
--pairing-port    Separate pairing-only GUI. Put behind a private authenticated HTTPS proxy.
--state-dir       Encrypted session, API token and send ledger (default: STATE_DIR or .local).
--port            API port (default: API_PORT or 8787).
PUBLIC_URL        Private HTTPS pairing origin; required for the helper's same-origin handoff.

Legacy browser transport (opt-in; not needed for native mode):
--browser         Run the older browser-driven API with a dedicated profile.
--headed          Implies --browser; open its browser on a desktop.
--legacy-qr       Implies --browser; only for phones which still have a QR scanner.
--web-login       Implies --browser and --headed; requires --pairing-port and a display.
CHROME_PATH       Browser mode only: optional existing Chromium executable.
Never use your personal browser profile as STATE_DIR/profile. Google may reject browser-mode login.`);
    return;
  }
  if (values["web-login"] && !values["pairing-port"])
    throw new ApiError(
      400,
      "INVALID_OPTIONS",
      "--web-login requires --pairing-port.",
    );
  if (values["web-login"] && values["legacy-qr"])
    throw new ApiError(
      400,
      "INVALID_OPTIONS",
      "--web-login cannot be combined with --legacy-qr.",
    );
  const browserMode =
    values.browser ||
    values.headed ||
    values["legacy-qr"] ||
    values["web-login"];
  const apiPort = port(values.port ?? process.env.API_PORT ?? "8787");
  const pairingPort = values["pairing-port"]
    ? port(values["pairing-port"])
    : undefined;
  if (pairingPort === apiPort)
    throw new ApiError(
      400,
      "INVALID_OPTIONS",
      "API and pairing ports must differ.",
    );
  const publicUrl =
    pairingPort && process.env.PUBLIC_URL
      ? new URL(process.env.PUBLIC_URL)
      : undefined;
  if (
    publicUrl &&
    ((!browserMode && publicUrl.protocol !== "https:") ||
      !/^https?:$/.test(publicUrl.protocol) ||
      publicUrl.username ||
      publicUrl.password)
  ) {
    throw new ApiError(
      400,
      "INVALID_OPTIONS",
      "PUBLIC_URL must be an HTTPS URL without credentials (HTTP is allowed only in legacy browser mode).",
    );
  }
  const stateDir = resolve(
    values["state-dir"] ?? process.env.STATE_DIR ?? ".local",
  );
  process.umask(0o077);
  const state = await prepareState(stateDir);
  const browser = browserMode
    ? await openBrowser({
        profileDir: state.profileDir,
        headless: !values.headed && !values["web-login"],
        legacyQr: values["legacy-qr"],
        ...(process.env.CHROME_PATH
          ? { executablePath: process.env.CHROME_PATH }
          : {}),
      })
    : undefined;
  const client =
    browser?.client ?? (await NativeClient.open(join(stateDir, "native")));
  const api = buildApi({
    client,
    ledger: new SendLedger(join(stateDir, "sends")),
    token: state.token,
  });
  const pairing = pairingPort
    ? client instanceof NativeClient
      ? buildNativePairingApp(client, publicUrl?.origin, {
          helperArchivePath: fileURLToPath(
            new URL(
              "../../../messages-login/dist/messages-login-helper.zip",
              import.meta.url,
            ),
          ),
        })
      : buildPairingApp(
          client,
          publicUrl?.origin,
          values["web-login"] ? new WebLogin(client) : undefined,
        )
    : undefined;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await Promise.all([
      api.close(),
      pairing?.close(),
      client instanceof NativeClient ? client.close() : browser?.close(),
    ]);
  };
  try {
    await api.listen({ host: "127.0.0.1", port: apiPort });
    if (pairing && pairingPort)
      await pairing.listen({ host: "127.0.0.1", port: pairingPort });
  } catch (error) {
    await close();
    throw error;
  }
  const stop = () => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  browser?.context.on("close", stop);
  console.info(
    `API listening on loopback port ${apiPort}. Token file: ${state.tokenPath}`,
  );
  if (pairingPort)
    console.info(
      `Pairing-only page on loopback port ${pairingPort}. Use a private portal or SSH tunnel for remote access.`,
    );
  const session = await client.status();
  console.info(
    `Session: ${session.state}. No live test messages are sent automatically.`,
  );
  if (session.state === "pairing_required" && !values["legacy-qr"])
    console.info(
      client instanceof NativeClient
        ? "Open the private pairing page and run its one-time login helper on your computer. After phone approval the server runs independently."
        : values["web-login"]
          ? "Open the private pairing GUI and choose Open Google sign-in. Confirm the matching emoji on your phone."
          : values.headed
            ? "Click Sign In in the dedicated browser, use the Google account on your phone, then confirm the matching emoji in Google Messages."
            : "Account pairing needs an interactive browser. Use npm start -- --headed on a desktop, or --web-login --pairing-port behind a private proxy with a display or xvfb-run.",
    );
}

main().catch((error: unknown) => {
  // Never dump browser errors, network payloads, or credentials into logs.
  if (error instanceof ApiError)
    console.error(`${error.code}: ${error.message}`);
  else
    console.error(
      "Startup failed. Check --help, port availability, profile permissions, and connectivity to Google Messages.",
    );
  process.exitCode = 1;
});

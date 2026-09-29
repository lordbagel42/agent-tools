import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateGoogleCookies } from "./google-cookies.js";
import { localServer } from "./server.js";
import { ApiError } from "./types.js";

export type PairingStatus = {
  state: "needs_login" | "connecting" | "awaiting_phone" | "paired" | "error";
  emoji?: string;
  error?: string;
};

export interface NativePairingClient {
  pairingStatus(): PairingStatus;
  beginPairing(cookies: Record<string, string>): Promise<void>;
}

const capabilityLifetime = 15 * 60_000;
const pairingError =
  "Pairing could not be completed. Revoke the Google session if needed, then try again.";
const busyStates = new Set<PairingStatus["state"]>([
  "connecting",
  "awaiting_phone",
  "paired",
]);

function hasUnsafeDisplayCharacter(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function invalidRequest(message: string) {
  return new ApiError(400, "INVALID_REQUEST", message);
}

function plainRecord(input: unknown): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  try {
    return Object.getPrototypeOf(input) === Object.prototype;
  } catch {
    return false;
  }
}

function parseStartBody(body: unknown) {
  if (!plainRecord(body) || Reflect.ownKeys(body).length !== 0)
    throw invalidRequest("Start setup with an empty JSON object.");
}

function parseCompleteBody(body: unknown): Record<string, string> {
  if (!plainRecord(body))
    throw invalidRequest("Expected one Google cookie handoff.");
  let keys: PropertyKey[];
  let descriptor: PropertyDescriptor | undefined;
  try {
    keys = Reflect.ownKeys(body);
    descriptor = Object.getOwnPropertyDescriptor(body, "cookies");
  } catch {
    throw invalidRequest("Expected one Google cookie handoff.");
  }
  if (
    keys.length !== 1 ||
    keys[0] !== "cookies" ||
    !descriptor ||
    !("value" in descriptor) ||
    !descriptor.enumerable
  )
    throw invalidRequest("Expected one Google cookie handoff.");
  return validateGoogleCookies(descriptor.value);
}

function sanitizedStatus(value: unknown): PairingStatus {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { state: "error", error: pairingError };
    const status = value as Record<string, unknown>;
    switch (status.state) {
      case "needs_login":
        return { state: "needs_login" };
      case "connecting":
        return { state: "connecting" };
      case "awaiting_phone":
        if (
          typeof status.emoji === "string" &&
          status.emoji.length > 0 &&
          status.emoji.length <= 64 &&
          !hasUnsafeDisplayCharacter(status.emoji)
        )
          return { state: "awaiting_phone", emoji: status.emoji };
        return { state: "awaiting_phone" };
      case "paired":
        return { state: "paired" };
      case "error":
        return { state: "error", error: pairingError };
      default:
        return { state: "error", error: pairingError };
    }
  } catch {
    return { state: "error", error: pairingError };
  }
}

function matchesCapability(
  candidate: string | string[] | undefined,
  token: string,
) {
  if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/.test(candidate))
    return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

export function buildNativePairingApp(
  client: NativePairingClient,
  publicUrl?: string,
  options: { helperArchivePath?: string; now?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  let capability: { token: string; expiresAt: number } | undefined;
  let pairingActive = false;
  let localFailure = false;
  const app = localServer(publicUrl, true);

  const status = (): PairingStatus => {
    let backend: PairingStatus;
    try {
      backend = sanitizedStatus(client.pairingStatus());
    } catch {
      backend = { state: "error", error: pairingError };
    }
    if (busyStates.has(backend.state)) {
      capability = undefined;
      localFailure = false;
      return backend;
    }
    if (localFailure) return { state: "error", error: pairingError };
    if (backend.state === "error") {
      pairingActive = false;
      return backend;
    }
    if (pairingActive) return { state: "connecting" };
    return backend;
  };

  app.addHook("onRequest", async (request, reply) => {
    reply.header(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
    );
    reply.header("x-frame-options", "DENY");
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=()",
    );
    if (request.method !== "POST") return;
    const origin = request.headers.origin;
    let secureOrigin = false;
    try {
      secureOrigin = Boolean(origin && new URL(origin).protocol === "https:");
    } catch {
      secureOrigin = false;
    }
    if (!secureOrigin)
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Setup requires a same-origin HTTPS request.",
      );
    if (
      request.headers["content-type"]
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      throw new ApiError(
        415,
        "INVALID_REQUEST",
        "Setup requests require application/json.",
      );
  });

  app.get("/", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(html),
  );
  app.get("/pairing.css", async (_request, reply) =>
    reply.type("text/css; charset=utf-8").send(css),
  );
  app.get("/pairing.js", async (_request, reply) =>
    reply.type("application/javascript; charset=utf-8").send(script),
  );
  app.get("/status", () => status());

  app.post("/connect/start", (request) => {
    parseStartBody(request.body);
    const current = status();
    if (busyStates.has(current.state))
      throw new ApiError(
        409,
        "PAIRING_BUSY",
        "A pairing session is already active or this phone is paired.",
      );
    const currentTime = now();
    if (capability && currentTime < capability.expiresAt)
      return { ...capability };
    capability = {
      token: randomBytes(32).toString("hex"),
      expiresAt: currentTime + capabilityLifetime,
    };
    return { ...capability };
  });

  app.post("/connect/complete", async (request, reply) => {
    const cookies = parseCompleteBody(request.body);
    const activeCapability = capability;
    const currentTime = now();
    if (
      !activeCapability ||
      currentTime >= activeCapability.expiresAt ||
      !matchesCapability(
        request.headers["x-setup-token"],
        activeCapability.token,
      )
    ) {
      if (activeCapability && currentTime >= activeCapability.expiresAt)
        capability = undefined;
      throw new ApiError(
        401,
        "SETUP_CAPABILITY_INVALID",
        "The setup capability is invalid or expired. Start setup again.",
      );
    }
    if (busyStates.has(status().state)) {
      capability = undefined;
      throw new ApiError(
        409,
        "PAIRING_BUSY",
        "A pairing session is already active or this phone is paired.",
      );
    }

    // Consume before crossing the backend boundary. A rejected or ambiguous call cannot be replayed.
    capability = undefined;
    pairingActive = true;
    localFailure = false;
    try {
      await client.beginPairing(cookies);
    } catch {
      pairingActive = false;
      localFailure = true;
      throw new ApiError(
        503,
        "PAIRING_UNAVAILABLE",
        "Pairing could not be started. Try again.",
      );
    }
    return reply.code(202).send({ accepted: true });
  });

  if (options.helperArchivePath) {
    const helperArchivePath = options.helperArchivePath;
    app.get("/helper.zip", async (_request, reply) => {
      let archive: Buffer;
      try {
        archive = await readFile(helperArchivePath);
      } catch {
        throw new ApiError(
          503,
          "HELPER_UNAVAILABLE",
          "The local login helper is unavailable. Try again later.",
        );
      }
      return reply
        .type("application/zip")
        .header(
          "content-disposition",
          'attachment; filename="messages-login-helper.zip"',
        )
        .send(archive);
    });
  }

  return app;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair your phone · Messages API</title><link rel="stylesheet" href="/pairing.css"><script src="/pairing.js" defer></script></head>
<body><main>
<header><span class="mark" aria-hidden="true">M</span><span>Messages API <small>PRIVATE DEVICE PAIRING</small></span></header>
<section class="card">
<p class="eyebrow">CONNECT YOUR ANDROID PHONE</p>
<h1 id="title">Connect Google Messages.</h1>
<p class="intro">Create a dedicated server session for Google Messages. Pairing setup cannot read texts, send messages, or reveal the API token.</p>

<div id="browser-setup" class="setup-panel">
<h2>Use the one-time local login helper</h2>
<p>Use a desktop computer with Node.js 22.12 or newer. Google sign-in opens locally; there is no password or cookie box on this page.</p>
<ol>
<li><a href="/helper.zip" download>Download the local login helper</a> and unzip it on your computer.</li>
<li>In that folder, run <code>npm install</code>.</li>
<li>Then run <code id="helper-command">npm start -- CURRENT_ORIGIN</code>.</li>
</ol>
<p class="note">The helper will open this private portal, then ask you to sign in on Google's real site and approve a one-time credential transfer to <span id="current-origin">this server</span>.</p>
</div>

<div id="helper-action" class="setup-panel" hidden>
<h2>Sign in on this computer</h2>
<p>The helper opens Google's real sign-in locally. Your password stays on Google's page and is never entered into this GUI.</p>
<button id="helper-connect" type="button">Sign in locally with Google</button>
<p id="helper-message" class="helper-message" aria-live="polite"></p>
</div>

<div id="connecting-panel" class="state-panel" hidden>
<span class="spinner" aria-hidden="true"></span><div><h2>Opening a private session</h2><p>The server is preparing Google Messages pairing. Keep this page open.</p></div>
</div>

<div id="phone-instructions" class="phone-panel" hidden>
<p id="emoji" class="emoji" aria-label="Matching emoji"></p>
<div><h2>Match this emoji on your phone</h2><ol>
<li>Open <strong>Google Messages</strong> on your Android phone.</li>
<li>Open your profile menu, then <strong>Device pairing</strong>.</li>
<li>Approve the request only when the emoji match.</li>
</ol></div>
</div>

<div id="paired-panel" class="state-panel success" hidden>
<span class="check" aria-hidden="true">✓</span><div><h2>Pairing complete</h2><p>The server now maintains its own session. This setup page never displays message content.</p></div>
</div>

<p id="status" role="status" aria-live="polite">Checking the pairing service…</p>
<details><summary>Google session credentials and revocation</summary>
<p>The required Google session cookies are transferred once and stored on the server as session credentials. They are broad Google-account credentials, not a Messages-only OAuth grant. This GUI never asks for or receives your Google password.</p>
<p>To revoke access, remove the session in your Google Account security settings and remove the paired device in Google Messages. The phone must remain online while the server uses Messages.</p>
</details>
</section>
<footer>This pairing-only page has no messaging data, send controls, browser controls, or API tokens.</footer>
</main></body></html>`;

const css = `
:root { color-scheme:light; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#172b27; background:#f2f5f1; }
* { box-sizing:border-box; } body { margin:0; } [hidden] { display:none!important; }
main { width:min(850px,100%); margin:0 auto; padding:42px 22px; }
header { display:flex; gap:12px; align-items:center; margin-bottom:28px; font-weight:650; }
header small { display:block; margin-top:3px; color:#566b61; font-size:10px; letter-spacing:1.6px; }
.mark { display:grid; place-items:center; width:40px; height:40px; border-radius:12px; background:#174d3a; color:white; font-weight:700; }
.card { background:white; border:1px solid #dce4dc; border-radius:22px; padding:38px; }
.eyebrow { color:#3b7561; font-size:11px; font-weight:750; letter-spacing:1.5px; margin:0 0 14px; }
h1 { font-size:40px; line-height:1.1; letter-spacing:-1.3px; margin:0; font-weight:700; }
.intro { color:#56675f; max-width:620px; line-height:1.6; margin:18px 0 28px; }
h2 { font-size:17px; margin:0 0 10px; }
.setup-panel, .state-panel, .phone-panel { padding:24px; background:#f4f7f3; border-radius:14px; color:#425b50; }
.setup-panel p, .state-panel p { margin:0 0 14px; font-size:14px; line-height:1.55; }
.setup-panel ol, .phone-panel ol { padding-left:23px; margin:16px 0 0; font-size:14px; line-height:1.55; }
li { margin-bottom:11px; padding-left:4px; }
a { color:#176542; font-weight:650; text-underline-offset:2px; }
code { background:#e8eee8; padding:3px 6px; border-radius:4px; overflow-wrap:anywhere; }
.note { border-top:1px solid #dce5dd; padding-top:14px; margin-top:18px!important; color:#64766d; font-size:12px!important; }
button { appearance:none; border:0; border-radius:9px; background:#174d3a; color:white; padding:11px 16px; font:inherit; font-size:14px; font-weight:650; cursor:pointer; }
button:hover { background:#20634b; } button:focus-visible { outline:3px solid #9ccab6; outline-offset:2px; } button:disabled { cursor:wait; opacity:.65; }
.helper-message { min-height:1.5em; margin:13px 0 0!important; color:#365f4d; overflow-wrap:anywhere; }
.state-panel { display:flex; gap:16px; align-items:center; }
.state-panel h2, .state-panel p { margin:0; }
.spinner { width:28px; height:28px; flex:0 0 auto; border:3px solid #bdd0c4; border-top-color:#286c50; border-radius:50%; animation:spin 1s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.phone-panel { display:grid; grid-template-columns:180px 1fr; gap:28px; align-items:center; }
.emoji { display:grid; place-items:center; min-height:145px; margin:0; border-radius:12px; background:white; border:1px solid #dce5dd; font-size:54px; line-height:1.15; letter-spacing:6px; text-align:center; overflow-wrap:anywhere; }
.phone-panel ol { margin-bottom:0; }
.check { display:grid; place-items:center; width:34px; height:34px; flex:0 0 auto; border-radius:50%; background:#dcefe3; color:#16603d; font-size:20px; font-weight:750; }
#status { margin:25px 0 18px; padding:13px 16px; border-radius:10px; background:#edf4ee; color:#22583d; font-size:13px; line-height:1.5; }
details { border-top:1px solid #e2e9e2; padding-top:16px; font-size:13px; color:#526b5e; line-height:1.6; }
summary { cursor:pointer; color:#244c39; font-weight:600; }
footer { margin-top:20px; color:#62766a; font-size:11px; text-align:center; line-height:1.6; }
@media(max-width:650px) {
  main { padding:22px 14px; } .card { padding:25px 20px; } h1 { font-size:34px; }
  .setup-panel, .state-panel, .phone-panel { padding:20px; }
  .phone-panel { grid-template-columns:1fr; gap:18px; } .emoji { min-height:120px; font-size:46px; }
  button { width:100%; } code { display:inline; }
}
@media(prefers-reduced-motion:reduce) { .spinner { animation:none; } }
`;

const script = `
const title = document.querySelector('#title');
const statusLine = document.querySelector('#status');
const browserSetup = document.querySelector('#browser-setup');
const helperAction = document.querySelector('#helper-action');
const helperButton = document.querySelector('#helper-connect');
const helperMessage = document.querySelector('#helper-message');
const connectingPanel = document.querySelector('#connecting-panel');
const phoneInstructions = document.querySelector('#phone-instructions');
const pairedPanel = document.querySelector('#paired-panel');
const emoji = document.querySelector('#emoji');
const helperCommand = document.querySelector('#helper-command');
const currentOrigin = document.querySelector('#current-origin');
let helper;
try {
  helper = window.messagesHelper && typeof window.messagesHelper.connect === 'function'
    ? window.messagesHelper : undefined;
} catch {
  helper = undefined;
}
helperCommand.textContent = 'npm start -- ' + window.location.origin;
currentOrigin.textContent = window.location.origin;

function showSetup(show, retry) {
  browserSetup.hidden = !show || Boolean(helper);
  helperAction.hidden = !show || !helper;
  helperButton.textContent = retry ? 'Try local sign-in again' : 'Sign in locally with Google';
}

function hideStatePanels() {
  connectingPanel.hidden = true;
  phoneInstructions.hidden = true;
  pairedPanel.hidden = true;
  emoji.textContent = '';
}

function render(pairing) {
  hideStatePanels();
  if (!pairing || typeof pairing !== 'object') {
    renderUnavailable();
    return;
  }
  if (pairing.state === 'needs_login') {
    title.textContent = 'Connect Google Messages.';
    statusLine.textContent = 'Ready for a one-time local Google sign-in. This page never asks for your password.';
    showSetup(true, false);
  } else if (pairing.state === 'connecting') {
    title.textContent = 'Connecting to Google Messages.';
    statusLine.textContent = 'Starting a private pairing session. Waiting for Google Messages…';
    showSetup(false, false);
    connectingPanel.hidden = false;
  } else if (pairing.state === 'awaiting_phone') {
    title.textContent = 'Match the emoji on your phone.';
    statusLine.textContent = 'Waiting for approval on your phone. No messages are available on this page.';
    showSetup(false, false);
    phoneInstructions.hidden = false;
    emoji.textContent = typeof pairing.emoji === 'string' ? pairing.emoji : '…';
  } else if (pairing.state === 'paired') {
    title.textContent = 'Your phone is connected.';
    statusLine.textContent = 'Paired successfully. You can close this laptop; the Android phone stays online for the server session.';
    showSetup(false, false);
    pairedPanel.hidden = false;
  } else if (pairing.state === 'error') {
    title.textContent = 'Pairing needs attention.';
    statusLine.textContent = typeof pairing.error === 'string'
      ? pairing.error : 'Pairing could not be completed. Try again.';
    showSetup(true, true);
  } else {
    renderUnavailable();
  }
}

function renderUnavailable() {
  hideStatePanels();
  showSetup(false, false);
  title.textContent = 'Pairing service unavailable.';
  statusLine.textContent = 'Could not reach the pairing service. Reopen the private portal if its session expired. Retrying…';
}

if (helper) {
  helperButton.addEventListener('click', async () => {
    helperButton.disabled = true;
    helperMessage.textContent = 'Opening Google sign-in on this computer…';
    try {
      const result = await helper.connect();
      if (result && result.ok) {
        helperMessage.textContent = typeof result.message === 'string'
          ? result.message : 'The sign-in handoff was accepted. Connecting…';
      } else {
        helperMessage.textContent = result && typeof result.message === 'string'
          ? result.message : 'Local sign-in did not complete. Try again.';
      }
    } catch {
      helperMessage.textContent = 'The local sign-in helper could not start. Try again.';
    } finally {
      helperButton.disabled = false;
    }
  });
}

async function refresh() {
  try {
    const response = await fetch('/status', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {accept: 'application/json'}
    });
    if (!response.ok) throw new Error('status unavailable');
    render(await response.json());
  } catch {
    renderUnavailable();
  } finally {
    window.setTimeout(refresh, 1200);
  }
}
refresh();
`;

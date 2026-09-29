import { loginCss, loginHtml, loginScript } from "./login-view.js";
import { localServer } from "./server.js";
import { ApiError, type MessagesClient } from "./types.js";
import type { WebLogin } from "./web-login.js";

// Separate from the authenticated API: no texts, send controls, or API tokens.
// The CLI binds this to loopback. Remote access requires an authenticated private proxy.
export function buildPairingApp(
  client: MessagesClient,
  publicUrl?: string,
  webLogin?: WebLogin,
) {
  const app = localServer(publicUrl, Boolean(webLogin));
  app.addHook("onRequest", async (request, reply) => {
    reply.header(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    reply.header("x-frame-options", "DENY");
    if (
      webLogin &&
      request.method === "POST" &&
      request.routeOptions.url?.startsWith("/login/")
    ) {
      if (!request.headers.origin)
        throw new ApiError(
          403,
          "FORBIDDEN",
          "Login controls require a same-origin browser request.",
        );
      if (
        request.headers["content-type"]?.split(";", 1)[0]?.trim() !==
        "application/json"
      )
        throw new ApiError(
          415,
          "INVALID_REQUEST",
          "Login controls require application/json.",
        );
    }
  });
  app.get("/", async (_request, reply) =>
    reply.type("text/html").send(html(Boolean(webLogin))),
  );
  app.get("/pairing.css", async (_request, reply) =>
    reply.type("text/css").send(css + (webLogin ? loginCss : "")),
  );
  app.get("/pairing.js", async (_request, reply) =>
    reply.type("application/javascript").send(script),
  );
  app.get("/status", () => client.status());
  app.get("/qr", async (_request, reply) => {
    const qr = await client.pairingQr();
    if (!qr)
      throw new ApiError(
        409,
        "QR_UNAVAILABLE",
        "No QR code is currently available.",
      );
    return reply.type("image/png").send(qr);
  });
  if (webLogin) {
    app.get("/login.js", async (_request, reply) =>
      reply.type("application/javascript").send(loginScript),
    );
    const token = (value: string | string[] | undefined) =>
      typeof value === "string" ? value : "";
    app.post("/login/start", (request) => {
      if (
        !request.body ||
        typeof request.body !== "object" ||
        Array.isArray(request.body) ||
        Object.keys(request.body).length
      )
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "Start login with an empty JSON object.",
        );
      return webLogin.start();
    });
    app.get("/login/frame", async (request, reply) => {
      const frame = await webLogin.frame(
        token(request.headers["x-login-token"]),
      );
      return reply
        .type("image/png")
        .header("x-login-origin", frame.origin)
        .header("x-login-version", frame.version)
        .send(frame.image);
    });
    app.post("/login/input", async (request, reply) => {
      await webLogin.input(
        token(request.headers["x-login-token"]),
        request.body,
      );
      return reply.code(204).send();
    });
    app.post("/login/stop", (request, reply) => {
      webLogin.stop(token(request.headers["x-login-token"]));
      return reply.code(204).send();
    });
  }
  return app;
}

const html = (interactive: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair your phone · Messages API</title><link rel="stylesheet" href="/pairing.css"><script src="/pairing.js" defer></script>${interactive ? '<script src="/login.js" defer></script>' : ""}</head>
<body class="${interactive ? "login-enabled" : ""}"><main>
<header><span class="mark" aria-hidden="true">M</span><span>Messages API <small>PRIVATE DEVICE PAIRING</small></span></header>
<section class="card">
<p class="eyebrow">CONNECT YOUR ANDROID PHONE</p>
<h1 id="title">Pair with your Google account.</h1>
<p class="intro">Pair a dedicated Google Messages session. Your phone stays in control of sending and receiving.</p>
${
  interactive
    ? loginHtml
    : `<div id="account-pairing" class="instructions account-panel"><h2>Sign in, then match the emoji</h2><ol>
<li>On the computer that will run the API, open a terminal in this project and run <code>npm run pair</code>. It needs a desktop display.</li>
<li>In the dedicated browser window, click <strong>Sign In</strong> and use the same Google account as Google Messages on your phone.</li>
<li>On your phone, open <strong>Google Messages → Device pairing</strong> and confirm the emoji that matches the browser.</li>
</ol><p class="note">This page is a status page, not a Google sign-in window. For an interactive view on a remote runner, restart with <code>--web-login</code> behind a private authenticated proxy. Signing into an unrelated browser tab will not pair this API session.</p></div>`
}
<div id="qr-pairing" class="pairing-grid" hidden>
<div class="qr-panel"><div class="qr-box"><img id="qr" alt="Google Messages device pairing QR code" width="240" height="240" hidden><p id="placeholder">Loading pairing code…</p></div><p class="caption">Code refreshes automatically</p></div>
<div class="instructions"><h2>Legacy QR pairing</h2><ol>
<li>Open <strong>Google Messages</strong> on your Android phone.</li>
<li>Tap your profile picture, then <strong>Device pairing</strong>.</li>
<li>Choose <strong>QR code scanner</strong> and scan this code.</li>
</ol><p class="note">Only use this if your phone still has a QR scanner. Google no longer supports QR pairing in the US. Pairing grants this API access to your messages.</p></div>
</div>
<p id="status" role="status" aria-live="polite">Connecting to Google Messages…</p>
<details><summary>Pairing and privacy</summary><p>Google-account pairing is the default. Legacy QR pairing requires <code>--legacy-qr</code> and a phone that still offers a QR scanner.</p><p>${interactive ? "This optional login view can control only Google sign-in and phone pairing. It cannot read texts or send messages. Access ends after 15 minutes, when you close the view, or when pairing finishes. Use Google’s on-page account choices for any additional verification; local passkeys and browser extensions are not available inside this remote view." : "The signed-in profile stays on the computer running the API. This status-only page cannot control that browser, capture a login, read texts, or send messages. Never paste Google passwords or cookies into chat."}</p></details>
</section><footer>The API is accessible only on the computer running it. Keep its token and browser profile private.</footer>
</main></body></html>`;

const css = `
:root { color-scheme:light; font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#172b27; background:#f2f5f1; }
* { box-sizing:border-box; } body { margin:0; } main { width:min(850px,100%); margin:0 auto; padding:42px 22px; }
header { display:flex; gap:12px; align-items:center; margin-bottom:28px; font-weight:650; } header small { display:block; margin-top:3px; color:#566b61; font-size:10px; letter-spacing:1.6px; }
.mark { display:grid; place-items:center; width:40px; height:40px; border-radius:12px; background:#174d3a; color:white; font-weight:700; }
.card { background:white; border:1px solid #dce4dc; border-radius:22px; padding:38px; }
.eyebrow { color:#3b7561; font-size:11px; font-weight:750; letter-spacing:1.5px; margin:0 0 14px; }
h1 { font-size:40px; line-height:1.1; letter-spacing:-1.3px; margin:0; font-weight:700; } .intro { color:#56675f; max-width:580px; line-height:1.6; margin:18px 0 28px; }
.pairing-grid { display:grid; grid-template-columns:280px 1fr; gap:30px; align-items:center; }
.qr-panel { padding:16px 12px 10px; background:#f4f7f3; border-radius:14px; text-align:center; } .qr-box { background:white; width:256px; height:256px; padding:8px; display:grid; place-items:center; border-radius:8px; }
#qr { image-rendering:pixelated; object-fit:contain; max-width:100%; } [hidden] { display:none!important; } #placeholder { color:#5e6e66; font-size:14px; }
.caption { font-size:11px; color:#5e6e66; margin:12px 0 3px; } h2 { font-size:17px; margin-top:0; } ol { padding-left:23px; color:#425b50; font-size:14px; line-height:1.55; } li { margin-bottom:13px; padding-left:4px; }
.note { font-size:12px; color:#667970; line-height:1.5; border-top:1px solid #e2e9e2; padding-top:13px; }
.account-panel { padding:24px; background:#f4f7f3; border-radius:14px; } .account-panel ol { margin-bottom:0; } .account-panel .note { margin-bottom:0; }
#status { margin:25px 0 18px; padding:13px 16px; border-radius:10px; background:#edf4ee; color:#22583d; font-size:13px; line-height:1.5; }
details { border-top:1px solid #e2e9e2; padding-top:16px; font-size:13px; color:#526b5e; line-height:1.6; } summary { cursor:pointer; color:#244c39; font-weight:600; } code { background:#f0f4ef; padding:2px 5px; border-radius:4px; }
footer { margin-top:20px; color:#62766a; font-size:11px; text-align:center; line-height:1.6; }
@media(max-width:650px) { main { padding:22px 14px; } .card { padding:25px 20px; } h1 { font-size:34px; } .pairing-grid { grid-template-columns:1fr; gap:24px; } .qr-panel { width:280px; max-width:100%; margin:auto; } .qr-box { width:100%; } }
`;

const script = `
const qr = document.querySelector('#qr');
const placeholder = document.querySelector('#placeholder');
const status = document.querySelector('#status');
const accountPairing = document.querySelector('#account-pairing');
const qrPairing = document.querySelector('#qr-pairing');
let imageUrl;
function hideQr(message) {
  qr.hidden = true;
  qr.removeAttribute('src');
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = undefined;
  placeholder.hidden = false;
  placeholder.textContent = message;
}
async function refresh() {
  try {
    const response = await fetch('/status', {cache:'no-store'});
    if (!response.ok) throw new Error('status unavailable');
    const session = await response.json();
    // /qr also renews an expired legacy code; that screen reports pairing_required until renewed.
    const image = session.state === 'pairing_required' || session.state === 'qr_ready'
      ? await fetch('/qr', {cache:'no-store'}) : null;
    if (image?.ok) session.state = 'qr_ready';
    window.dispatchEvent(new CustomEvent('pairing-state', {detail:session.state}));
    accountPairing.hidden = session.state !== 'pairing_required';
    qrPairing.hidden = session.state !== 'qr_ready';
    if (session.state === 'paired') {
      hideQr('Phone paired ✓');
      document.querySelector('#title').textContent = 'Your phone is connected.';
      status.textContent = 'Paired successfully. You can now use the local API. This page will never display your texts.';
    } else if (session.state === 'closed') {
      hideQr('Browser closed');
      document.querySelector('#title').textContent = 'Browser session closed.';
      status.textContent = 'The browser session closed. Restart the API to reconnect.';
    } else if (session.state === 'pairing_required') {
      hideQr('Google-account pairing');
      document.querySelector('#title').textContent = 'Pair with your Google account.';
      status.textContent = document.querySelector('#login-start')
        ? 'Google-account pairing required · Sign in using the view above, then match the emoji on your phone.'
        : 'Google-account pairing required · Complete sign-in in the API’s dedicated browser. This page cannot sign you in.';
    } else if (session.state === 'qr_ready') {
      document.querySelector('#title').textContent = 'Legacy QR pairing.';
      if (!image?.ok) {
        hideQr('Waiting for a pairing code…');
        status.textContent = 'The QR code is unavailable. Retrying… If your phone has no scanner, restart without --legacy-qr and use Google-account pairing.';
      } else {
        const next = URL.createObjectURL(await image.blob());
        const previous = imageUrl;
        qr.src = next;
        imageUrl = next;
        qr.hidden = false;
        placeholder.hidden = true;
        if (previous) URL.revokeObjectURL(previous);
        status.textContent = 'Ready to scan · Waiting for your phone. No messages have been read or sent by this pairing page.';
      }
    } else {
      hideQr('Connecting…');
      document.querySelector('#title').textContent = 'Connecting to Google Messages.';
      status.textContent = 'Waiting for Google Messages to show a pairing screen or your conversations.';
    }
  } catch {
    window.dispatchEvent(new CustomEvent('pairing-state', {detail:'unavailable'}));
    hideQr('Connection unavailable');
    accountPairing.hidden = true;
    qrPairing.hidden = true;
    document.querySelector('#title').textContent = 'Pairing service unavailable.';
    status.textContent = 'Could not reach the pairing service. Reopen the private portal if your session expired. Retrying…';
  } finally {
    setTimeout(refresh, 4000);
  }
}
refresh();
`;

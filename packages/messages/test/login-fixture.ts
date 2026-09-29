import { WebLogin } from "../src/web-login.js";
import { browserFixture } from "./fixture.js";

export async function loginFixture() {
  const fixture = await browserFixture("qr");
  await fixture.page.context().route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "outside.invalid") {
      await route.fulfill({
        contentType: "text/html",
        body: "External fixture that the navigation guard must block",
      });
      return;
    }
    if (
      !["messages.google.com", "accounts.google.com"].includes(url.hostname)
    ) {
      await route.fallback();
      return;
    }
    const body =
      url.hostname === "accounts.google.com"
        ? signIn
        : url.pathname === "/web/welcome"
          ? welcome
          : url.pathname === "/web/pair"
            ? emoji
            : url.searchParams.has("unknown")
              ? "<p>PRIVATE CONTENT WITH UNKNOWN MARKUP</p>"
              : conversations;
    await route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  await fixture.page.goto("https://messages.google.com/web/welcome");
  const login = new WebLogin(fixture.client);
  return { ...fixture, login };
}

const welcome = `<!doctype html><html><body><mw-welcome-page-container>
<button onclick="location.href='https://accounts.google.com/signin/v2/identifier'">Sign In</button>
</mw-welcome-page-container></body></html>`;

const signIn = `<!doctype html><html lang="en"><head><style>
body{font:20px system-ui;background:#f5f7fb;color:#222;margin:0;padding:64px}
main{background:white;border-radius:24px;padding:40px;width:680px;box-sizing:border-box}
label{display:block;margin:24px 0}input{display:block;font:20px system-ui;padding:12px;width:400px}
button{font:18px system-ui;padding:12px 24px}a{display:block;margin-top:24px}
</style></head><body><main><p>SYNTHETIC LOGIN FIXTURE — NOT GOOGLE</p><h1>Sign in</h1>
<label>Email<input id="email" autocomplete="off"></label>
<label>Password<input id="password" type="password" autocomplete="off"></label>
<button onclick="location.href='https://messages.google.com/web/pair'">Next</button>
<a href="https://outside.invalid/">Blocked external link</a>
</main></body></html>`;

const emoji = `<!doctype html><html><body><mw-gaia-pairing-container style="display:block;font:24px system-ui;padding:50px">
<h1>Match this emoji on your phone</h1><p style="font-size:96px">🥔</p><p>Synthetic phone confirmation</p>
<button onclick="location.href='https://messages.google.com/web/conversations'">Simulate phone confirmation</button>
</mw-gaia-pairing-container></body></html>`;

const conversations = `<!doctype html><html><body>
<mws-conversations-list>PRIVATE TEXTS MUST NEVER STREAM</mws-conversations-list>
<textarea data-e2e-message-input-box aria-label="Text message"></textarea>
<mws-message-send-button><button onclick="
document.body.dataset.sent='true';
const input=document.querySelector('textarea');
const message=document.createElement('mws-message-wrapper');
message.setAttribute('is-outgoing','true');
const part=document.createElement('mws-text-message-part');part.textContent=input.value;message.append(part);document.body.append(message);input.value='';
">Send</button></mws-message-send-button>
</body></html>`;

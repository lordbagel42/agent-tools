import { createServer } from "node:http";
import { chromium } from "playwright";
import { MessagesPage } from "../src/messages-page.js";

export type FixtureMode =
  | "paired"
  | "qr"
  | "draft"
  | "clear-only"
  | "incoming-only"
  | "redirect";

// Synthetic contracts, not a captured Google session. Live phone verification is separate.
export async function browserFixture(mode: FixtureMode = "paired") {
  const sent: { conversationId: string; text: string }[] = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/_send" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200).end("{}");
      return;
    }
    if (mode === "redirect" && request.url?.endsWith("/999")) {
      response.writeHead(302, { location: "/web/conversations/384" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(mode === "qr" ? pairingHtml : messagesHtml(mode));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await chromium
    .launch({
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : {}),
      headless: true,
    })
    .catch(async (error: unknown) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseUrl}/web/conversations`);
  return {
    page,
    sent,
    baseUrl,
    client: new MessagesPage(page, 800),
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const pairingHtml = `<!doctype html><html lang="en"><body>
<mw-authentication-container>
<button role="switch" aria-label="Remember this computer" aria-checked="false"
onclick="this.setAttribute('aria-checked','true')">Remember this computer</button>
<mw-qr-code data-e2e-qr-code style="display:block;width:214px;height:214px;background:white">
<svg width="214" height="214" aria-label="Test QR placeholder"><rect x="10" y="10" width="70" height="70" fill="black"/></svg>
</mw-qr-code></mw-authentication-container></body></html>`;

function messagesHtml(mode: FixtureMode) {
  return `<!doctype html><html lang="en"><head><style>
  mws-conversations-list { display:block; height:100px; width:280px; overflow:auto; }
  mws-conversation-list-item { display:block; height:45px; }
  mws-message-wrapper { display:block; margin:12px; }
  .name, .snippet-text { display:inline; } .name {font-size:16px;}
  </style></head><body>
  <mws-conversations-list><div style="height:300px;position:relative"><div id="rows" style="position:absolute"></div></div></mws-conversations-list>
  <div id="messages">
    <mws-message-wrapper data-e2e-message-id="in-1" is-outgoing="false">
      <mws-text-message-part><span class="text-msg">coffee &amp; tea</span></mws-text-message-part>
      <time datetime="2026-09-25T13:20:00Z">7:20 AM</time>
    </mws-message-wrapper>
    <mws-message-wrapper data-e2e-message-id="out-2" is-outgoing="true">
      <mws-text-message-part><span class="text-msg">first line\n🥔 second</span></mws-text-message-part>
    </mws-message-wrapper>
    <mws-message-wrapper><span class="text-msg">unclassified</span></mws-message-wrapper>
    <mws-message-wrapper is-outgoing="true"><mws-text-message-part>hello</mws-text-message-part></mws-message-wrapper>
  </div>
  <textarea data-e2e-message-input-box aria-label="Text message">${mode === "draft" ? "my unfinished draft" : ""}</textarea>
  <mws-message-send-button><button type="button" aria-label="Send SMS">Send SMS</button></mws-message-send-button>
  <script>
  const mode = ${JSON.stringify(mode)};
  const list = document.querySelector('mws-conversations-list');
  const rows = document.querySelector('#rows');
  function renderRows() {
    const ids = list.scrollTop > 0 ? ['901', '1702'] : ['384', '901'];
    rows.style.top = list.scrollTop + 'px';
    rows.innerHTML = ids.map(id => '<mws-conversation-list-item '+(id==='384'?'class="unread"':'')+'><a class="list-item" href="/web/conversations/'+id+'"><h2 class="name">Contact '+id+'</h2><span class="snippet-text">preview '+id+'</span><time datetime="2026-09-25T12:00:00Z">6 AM</time></a></mws-conversation-list-item>').join('');
  }
  list.addEventListener('scroll',renderRows); renderRows();
  document.querySelector('mws-message-send-button button').onclick = async () => {
    const input = document.querySelector('textarea');
    const text = input.value;
    const conversationId = location.pathname.split('/').pop();
    await fetch('/_send', {method:'POST', body:JSON.stringify({conversationId,text})});
    input.value = '';
    if (mode !== 'clear-only') {
      const wrapper = document.createElement('mws-message-wrapper');
      wrapper.setAttribute('is-outgoing', mode === 'incoming-only' ? 'false' : 'true');
      const part = document.createElement('mws-text-message-part');
      part.textContent = text;
      wrapper.append(part);
      document.querySelector('#messages').append(wrapper);
    }
  };
  </script></body></html>`;
}

import type { Metadata } from "./store";

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

const css = `
:root{color-scheme:light;--ink:#232521;--muted:#71766e;--line:#e2e4dc;--paper:#f6f7f2;--green:#dce8c8;--accent:#46652b}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}a{color:inherit;text-decoration:none}button,input{font:inherit}button,.button{cursor:pointer;border:1px solid var(--line);background:white;border-radius:7px;padding:9px 15px;color:var(--ink);display:inline-block}button:hover,.button:hover{border-color:#96a68a;background:#fafbf7}button:disabled{opacity:.5;cursor:wait}.primary{background:var(--ink);color:white;border-color:var(--ink)}.primary:hover{background:#3a4033;color:white}header{border-bottom:1px solid var(--line);height:76px;padding:0 5vw;display:flex;align-items:center;justify-content:space-between;background:#fafbf7}.brand{display:flex;align-items:center;gap:12px;font-weight:650;font-size:18px;letter-spacing:-.5px}.mark{width:29px;height:29px;display:grid;place-items:center;background:var(--ink);color:var(--green);border-radius:6px;font-size:20px}.meta,.eyebrow,code{font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted)}.eyebrow{text-transform:uppercase;letter-spacing:1.8px}.muted{color:var(--muted)}main{max-width:1190px;margin:0 auto;padding:58px 32px}.intro{display:flex;align-items:end;justify-content:space-between;gap:32px;margin-bottom:38px}h1{font-size:clamp(30px,4vw,45px);font-weight:550;line-height:1.15;letter-spacing:-1.8px;margin:12px 0 16px}h2{font-size:18px;letter-spacing:-.4px;margin:0 0 8px}p{margin:0 0 16px}.connect{border:1px solid var(--line);border-radius:10px;background:#fff;padding:16px 18px;max-width:410px}.connect code{display:block;font-size:11px;overflow-wrap:anywhere;margin:7px 0 10px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.card{border:1px solid var(--line);border-radius:11px;background:#fff;overflow:hidden;transition:box-shadow .15s,transform .15s}.card:hover{box-shadow:0 5px 20px #2325210a;transform:translateY(-2px)}.cover{height:150px;padding:27px;background:#e9eedf;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--line)}.cover span{font:38px ui-monospace,monospace;letter-spacing:-3px;color:#718159}.cover.alt{background:#ece8df}.cover.alt span{color:#9d8b6a}.cover.blue{background:#e2e9eb}.cover.blue span{color:#698590}.card-body{padding:21px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px}.badge{font:11px ui-monospace,monospace;border:1px solid var(--line);border-radius:100px;padding:4px 9px;background:#f5f6f1;white-space:nowrap}.badge.live{background:#edf4e5;border-color:#d4e3c1;color:#46652b}.revisions{margin:17px 0 0;padding-top:13px;border-top:1px solid #eef0e9}.empty{border:1px dashed #c6cdbb;border-radius:12px;padding:65px 24px;text-align:center;background:#fafbf7}.empty h2{font-size:22px}.empty code{background:#edf1e7;padding:8px 12px;display:inline-block;border-radius:6px;margin-top:6px}footer{display:flex;justify-content:space-between;gap:16px;margin-top:32px;border-top:1px solid var(--line);padding-top:16px}.auth{max-width:465px;margin:7vh auto;padding:35px;border:1px solid var(--line);border-radius:12px;background:white}.auth h1{font-size:32px;letter-spacing:-1px}.auth label{display:block;margin:18px 0 6px;font-size:13px;font-weight:600}.auth input{display:block;width:100%;padding:11px 12px;border:1px solid #ccd2c4;border-radius:6px;background:#fcfdf9}.auth .primary{width:100%;margin-top:24px}#error{color:#a03924;font-size:13px;margin-top:12px;min-height:20px;overflow-wrap:anywhere}.permissions{padding:18px;border-radius:8px;background:#f3f5ed;margin:20px 0}.permissions li{margin:7px 0}.viewer-head{height:auto;min-height:68px;padding:13px 24px;gap:18px;flex-wrap:wrap}.viewer-title{font-size:15px;font-weight:600}.viewer-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.frame{display:block;width:100%;height:calc(100dvh - 80px);border:0;background:white}.history{margin-top:25px}.history summary{cursor:pointer}.history a{display:inline-block;margin:10px 10px 0 0;text-decoration:underline}.notice{padding:12px 24px;background:#eef2e7;border-bottom:1px solid var(--line);font-size:13px}.status-dot{display:inline-block;width:6px;height:6px;background:#63824c;border-radius:100%;margin-right:7px}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.intro{align-items:start;flex-direction:column}.connect{max-width:100%;width:100%}}@media(max-width:540px){header{height:64px;padding:0 20px}main{padding:32px 20px}.grid{grid-template-columns:1fr}.intro{gap:20px;margin-bottom:25px}h1{letter-spacing:-1px}.cover{height:120px}.auth{margin:5vh 16px;padding:25px}.viewer-head{padding:12px 16px}.viewer-actions{gap:6px}.viewer-actions button,.viewer-actions .button{font-size:12px;padding:7px 9px}footer{flex-direction:column;gap:5px}}
`;

function page(
  title: string,
  body: string,
  script = "",
  frame = false,
): Response {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · Artifacts</title><style nonce="${nonce}">${css}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-src ${frame ? "'self'" : "'none'"}; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      },
    },
  );
}

const brand = `<a class="brand" href="/"><span class="mark" aria-hidden="true">▧</span>Artifacts</a>`;
const browserHelpers = `
const errorBox=document.querySelector('#error');
function showError(error){if(errorBox)errorBox.textContent=error.message||'Request failed';}
async function post(path,body){const res=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.message||data.error||'Request failed');return data;}
function signedQuery(){const params=new URLSearchParams(location.search);const names=new Set(params.getAll('ba_param'));const result=new URLSearchParams();if(params.has('sig')&&names.size)for(const [key,value] of params)if(key==='sig'||key==='ba_param'||names.has(key))result.append(key,value);return result.toString();}
`;

export function loginPage(): Response {
  return page(
    "Sign in",
    `<header>${brand}<span class="meta">YOUR AGENT'S PUBLISHING DESK</span></header><section class="auth"><span class="eyebrow">Owner access</span><h1>A place for your work.</h1><p class="muted">Sign in to manage artifacts and connect your agent.</p><form id="login"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button class="primary" type="submit">Sign in →</button></form><div id="error" role="alert"></div><span class="meta">Private drafts. Deliberate publishing.</span></section>`,
    `${browserHelpers}
document.querySelector('#login').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;errorBox.textContent='';try{const body={email:document.querySelector('#email').value,password:document.querySelector('#password').value};const query=signedQuery();if(query)body.oauth_query=query;const result=await post('/api/auth/sign-in/email',body);location.assign(result.redirect&&result.url?result.url:'/');}catch(error){showError(error);button.disabled=false;}});`,
  );
}

export function signupPage(): Response {
  return page(
    "Set up owner access",
    `<header>${brand}<span class="meta">OWNER SETUP</span></header><section class="auth"><span class="eyebrow">Private invitation</span><h1>Choose your password.</h1><p class="muted">Finish setting up your owner account. This link works once and expires after 30 minutes.</p><form id="signup" hidden><label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="6" maxlength="128" required><span class="meta">Use 6–128 characters.</span><label for="confirm">Confirm password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="6" maxlength="128" required><button class="primary" type="submit">Save password →</button></form><div id="error" role="alert"></div><p id="success" role="status" hidden>Password saved. Sign in with your owner email and new password.</p><a class="button" href="/login">Go to sign in</a></section>`,
    `${browserHelpers}
let token=new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null,'','/signup');
const form=document.querySelector('#signup');
if(token)form.hidden=false;else errorBox.textContent='A private setup link is required. Ask your operator to generate a new one.';
form.addEventListener('submit',async event=>{event.preventDefault();errorBox.textContent='';const password=document.querySelector('#password').value;if(password!==document.querySelector('#confirm').value){errorBox.textContent='The passwords do not match.';return;}const button=form.querySelector('button');button.disabled=true;try{await post('/api/auth/reset-password',{token,newPassword:password});token=null;form.reset();form.hidden=true;document.querySelector('#success').hidden=false;}catch{errorBox.textContent='Could not save the password. The link may be expired or already used. Ask your operator for a new link, or retry if the connection failed.';button.disabled=false;}});`,
  );
}

export function consentPage(
  clientName: string,
  clientId: string,
  scopes: string,
  resource: string,
): Response {
  return page(
    "Connect your agent",
    `<header>${brand}<span class="meta">CONNECTION REQUEST</span></header><section class="auth"><span class="eyebrow">MCP authorization</span><h1>Connect ${escapeHtml(clientName)}?</h1><p class="muted">This client is asking to act as you. Its name is supplied by the client and is not verified.</p><div class="permissions"><strong>Artifact access</strong><ul><li>Read private documents and revision history</li><li>Create and update drafts</li><li>Publish documents to the internet</li><li>Unpublish existing public pages</li></ul><span class="meta">Requested scopes: ${escapeHtml(scopes)}</span></div><p class="meta">Client: ${escapeHtml(clientId)}<br>Resource: ${escapeHtml(resource)}</p><button id="allow" class="primary">Allow access</button><button id="deny">Deny</button><div id="error" role="alert"></div></section>`,
    `${browserHelpers}
for(const [id,accept] of [['allow',true],['deny',false]])document.getElementById(id).addEventListener('click',async()=>{try{const result=await post('/api/auth/oauth2/consent',{accept,oauth_query:signedQuery()});location.assign(result.url);}catch(error){showError(error);}});`,
  );
}

export function galleryPage(items: Metadata[], origin: string): Response {
  const cards = items
    .map(
      (item, i) =>
        `<a class="card" href="/a/${escapeHtml(item.slug)}"><div class="cover ${["", "alt", "blue"][i % 3]}"><span aria-hidden="true">${item.format === "html" ? "&lt;/&gt;" : "Aa"}</span></div><div class="card-body"><div class="row"><span class="eyebrow">${item.format}</span><span class="badge ${item.publishedRevision ? "live" : ""}">${item.publishedRevision ? "● Published" : "Private"}</span></div><h2>${escapeHtml(item.title)}</h2><span class="meta">${escapeHtml(item.slug)}</span><div class="row revisions"><span class="meta">Draft v${item.revision}${item.publishedRevision ? ` · Live v${item.publishedRevision}` : ""}</span><span aria-hidden="true">↗</span></div></div></a>`,
    )
    .join("");
  return page(
    "Your library",
    `<header>${brand}<button id="logout">Sign out</button></header><main><div class="intro"><div><span class="eyebrow">Your publishing desk</span><h1>Work, made visible.</h1><p class="muted">Reports, prototypes, and ideas — made with your agent.</p></div><aside class="connect"><span class="eyebrow">Connect via MCP</span><code id="endpoint">${escapeHtml(origin)}/mcp</code><button id="copy">Copy endpoint ↗</button></aside></div><div class="row"><p class="eyebrow">Your artifacts <span class="muted">/ ${items.length.toString().padStart(2, "0")}</span></p><p class="meta">Latest activity first</p></div>${items.length ? `<div class="grid">${cards}</div>` : `<section class="empty"><h2>Your next idea belongs here.</h2><p class="muted">Connect the MCP server, then ask your agent to make an artifact.</p><code>“Make an artifact that explains this change.”</code></section>`}<div id="error" role="alert"></div><footer><span class="meta">Drafts are private until you publish a revision.</span><span class="meta"><span class="status-dot"></span>Ready for your next idea</span></footer></main>`,
    `${browserHelpers}
document.querySelector('#copy').addEventListener('click',async event=>{try{await navigator.clipboard.writeText(document.querySelector('#endpoint').textContent);event.target.textContent='Copied';}catch(error){showError(error);}});
document.querySelector('#logout').addEventListener('click',async()=>{try{await post('/api/auth/sign-out',{});location.assign('/login');}catch(error){showError(error);}});`,
  );
}

export function viewerPage(
  item: Metadata,
  options: {
    private: boolean;
    publicUrl: string;
    history?: Metadata[];
    pinned?: boolean;
  },
): Response {
  const base = options.private ? `/a/${item.slug}` : "";
  const contentUrl = `${base}/content${options.pinned ? `?revision=${item.revision}` : ""}`;
  const buttons = options.private
    ? `<a class="button" href="/">Library</a>${item.publishedRevision ? `<a class="button" target="_blank" rel="noopener noreferrer" href="${escapeHtml(options.publicUrl)}">Public link ↗</a><button id="unpublish">Unpublish</button>` : ""}<button id="publish" class="primary">Publish v${item.revision}</button>`
    : `<span class="meta">User-generated content</span>`;
  return page(
    item.title,
    `<header class="viewer-head"><div><span class="viewer-title">${escapeHtml(item.title)}</span><br><span class="meta" id="revision">${options.private ? "Private preview" : "Published"} · v${item.revision}</span></div><div class="viewer-actions">${buttons}</div></header>${options.private ? `<div class="notice">Draft changes stay private. Publishing makes this revision readable by anyone with the link.${options.history ? `<details class="history"><summary>Revision history (${options.history.length})</summary>${options.history.map((r) => `<a href="/a/${r.slug}?revision=${r.revision}">v${r.revision} · ${escapeHtml(r.title)}</a>`).join("")}</details>` : ""}<div id="error" role="alert"></div></div>` : ""}<iframe class="frame" title="Artifact content" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${contentUrl}"></iframe>`,
    `${browserHelpers}
const frame=document.querySelector('iframe');let revision=${item.revision};
${!options.pinned ? `const events=new EventSource('${base}/events');events.addEventListener('revision',event=>{const data=JSON.parse(event.data);if(data.revision!==revision){revision=data.revision;location.reload();}});events.addEventListener('unavailable',()=>{events.close();frame.remove();document.querySelector('#revision').textContent='This artifact is no longer available.';});` : ""}
${options.private ? `const slug='${item.slug}';document.querySelector('#publish').addEventListener('click',async()=>{if(!confirm('Publish this revision to the public internet? Anyone will be able to read its content and source.'))return;try{const current=await fetch('/api/artifacts/'+slug,{credentials:'same-origin'}).then(r=>r.json());await post('/api/artifacts/'+slug+'/publish',{revision,expectedRevision:current.artifact.revision});location.assign('/a/'+slug);}catch(error){showError(error);}});document.querySelector('#unpublish')?.addEventListener('click',async()=>{try{await post('/api/artifacts/'+slug+'/unpublish',{});location.reload();}catch(error){showError(error);}});` : ""}`,
    true,
  );
}

export function markdownPage(content: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{max-width:850px;margin:60px auto;padding:0 24px;font:17px/1.7 system-ui,sans-serif;color:#252923;background:#fff}h1,h2,h3{line-height:1.2;letter-spacing:-.025em}pre{overflow:auto;background:#f3f5ef;padding:20px;border-radius:8px}code{font-size:.87em}img,svg{max-width:100%}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:9px;text-align:left}blockquote{border-left:3px solid #acc28b;margin-left:0;padding-left:20px;color:#59654d}</style></head><body>${content}</body></html>`;
}

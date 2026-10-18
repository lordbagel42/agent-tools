function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}

function page(title: string, body: string, script: string) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Email</title><style nonce="${nonce}">
  :root{color-scheme:light;font:16px/1.55 system-ui,sans-serif;color:#232521;background:#f6f7f2}*{box-sizing:border-box}body{margin:0}header{padding:24px;border-bottom:1px solid #d2d6cb;font-weight:650}main{max-width:480px;margin:8vh auto;padding:32px;background:white;border:1px solid #d2d6cb;border-radius:12px}h1{font-size:30px;line-height:1.2;margin:0 0 16px}p{color:#50564a}label{display:block;margin:20px 0 6px;font-weight:600}input,button{font:inherit;border:1px solid #a2ab98;border-radius:6px;min-height:48px;padding:10px 12px}input{width:100%;background:#fcfdf9;color:inherit}button{cursor:pointer;background:#232521;color:white;margin-top:24px;width:100%}button.secondary{background:white;color:#232521;margin-top:12px}button:hover{background:#405330;color:white}button:disabled{opacity:.6;cursor:wait}:focus-visible{outline:3px solid #46652b;outline-offset:3px}a{color:#365120;text-underline-offset:3px}#error{color:#9e3020;overflow-wrap:anywhere}code{overflow-wrap:anywhere;font-size:14px}li{margin:8px 0}::selection{background:#dce8c8}@media(max-width:540px){main{margin:24px 16px;padding:24px}header{padding:20px}}
  </style></head><body><header>Email · Agent inboxes</header><main>${body}<p id="error" role="alert"></p></main><script nonce="${nonce}">
  const errorBox=document.querySelector('#error');
  async function post(path,body){const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.message||d.error||'Request failed. Please try again.');return d;}
  function signedQuery(){const p=new URLSearchParams(location.search),names=new Set(p.getAll('ba_param')),q=new URLSearchParams();if(p.has('sig')&&names.size)for(const [k,v] of p)if(k==='sig'||k==='ba_param'||names.has(k))q.append(k,v);return q.toString();}
  ${script}</script></body></html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      },
    },
  );
}

export function loginPage() {
  return page(
    "Sign in",
    `<h1>Sign in to your inboxes</h1><p>Use your owner account to connect an agent. Public signup is disabled.</p><form id="login"><label for="email">Email address</label><input id="email" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required><button>Sign in</button></form><p>Need a password? Use your private setup link.</p>`,
    `document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;errorBox.textContent='';try{const d=await post('/api/auth/sign-in/email',{email:document.querySelector('#email').value,password:document.querySelector('#password').value,oauth_query:signedQuery()||undefined});if(d.redirect&&d.url)location.assign(d.url);else{errorBox.textContent='Signed in. Return to Amp to authorize the connection.';}}catch(e){errorBox.textContent=e.message;}finally{b.disabled=false;}};`,
  );
}

export function setupPage() {
  return page(
    "Choose a password",
    `<h1>Choose your password</h1><p>This private link expires after 30 minutes and works once. Use a separate password for this service.</p><form id="setup" hidden><label for="password">New password</label><input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><label for="confirm">Confirm password</label><input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><p>Use at least 12 characters.</p><button>Save password</button></form><p id="success" role="status" hidden>Password saved. You can now authorize Amp.</p><a href="/login">Go to sign in</a>`,
    `let token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'','/setup');const form=document.querySelector('#setup');if(token)form.hidden=false;else errorBox.textContent='A private setup link is required. Ask your operator for a new link.';form.onsubmit=async e=>{e.preventDefault();errorBox.textContent='';const password=document.querySelector('#password').value;if(password!==document.querySelector('#confirm').value){errorBox.textContent='Passwords do not match.';return;}const b=form.querySelector('button');b.disabled=true;try{await post('/api/auth/reset-password',{token,newPassword:password});token=null;form.reset();form.hidden=true;document.querySelector('#success').hidden=false;}catch{errorBox.textContent='Could not save the password. The link may be expired or already used. Request a new link.';}finally{b.disabled=false;}};`,
  );
}

export function consentPage(name: string, id: string) {
  return page(
    "Approve connection",
    `<h1>Connect ${escapeHtml(name)}?</h1><p>This client name is supplied by the application, not independently verified.</p><p>Approving gives this client owner access to:</p><ul><li>Read shared and owned inboxes, including attachments.</li><li>Create persistent email addresses.</li><li>Forward selected messages to your configured destination.</li><li>Manage its signed webhook subscriptions.</li></ul><p>Forwarding is never automatic.</p><p>Client ID: <code>${escapeHtml(id)}</code></p><button id="allow">Allow access</button><button id="deny" class="secondary">Deny</button>`,
    `for(const [id,accept] of [['allow',true],['deny',false]])document.getElementById(id).onclick=async()=>{document.querySelectorAll('button').forEach(b=>b.disabled=true);try{const d=await post('/api/auth/oauth2/consent',{accept,oauth_query:signedQuery()});location.assign(d.url);}catch(e){errorBox.textContent=e.message;document.querySelectorAll('button').forEach(b=>b.disabled=false);}};`,
  );
}

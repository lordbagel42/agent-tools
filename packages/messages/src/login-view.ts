// Only served by the explicitly enabled, private pairing listener. No persistent browser storage.
export const loginHtml = `
<div id="account-pairing" class="account-panel">
<h2>Sign in here. Confirm on your phone.</h2>
<p class="login-description">Use the same Google account as Google Messages on your phone. When prompted, match the emoji in <strong>Google Messages → Device pairing</strong>.</p>
<div class="login-actions"><button id="login-start" type="button" class="primary">Open Google sign-in</button><button id="login-stop" type="button" hidden>Close login view</button><span>Private view · 15-minute session</span></div>
<p id="login-note" aria-live="polite">This controls the API’s dedicated browser on the runner, not your personal browser.</p>
<div id="login-view" hidden>
<div class="login-browser"><div class="login-origin-bar"><span>GOOGLE LOGIN</span><strong id="login-origin">Loading…</strong><button id="login-zoom" type="button" aria-pressed="false">Full-size view</button></div>
<div class="login-canvas"><img id="login-screen" alt="" role="application" aria-label="Interactive Google sign-in screen" aria-describedby="login-help" tabindex="0" draggable="false" hidden></div></div>
<p id="login-help">Click a field above, then type or paste. For small text, choose Full-size view and scroll within the screen. Press Escape to leave keyboard control. On a phone, use the text helper below.</p>
<div class="login-keys" aria-label="Remote keyboard"><button type="button" data-login-key="Tab">Tab</button><button type="button" data-login-key="Enter">Enter</button><button type="button" data-login-key="Backspace">Backspace</button><button type="button" data-login-key="ControlOrMeta+A">Select all</button><button type="button" data-login-scroll="-500" aria-label="Scroll Google screen up">↑ Scroll</button><button type="button" data-login-scroll="500" aria-label="Scroll Google screen down">↓ Scroll</button></div>
<form id="login-text-form"><label for="login-text">Text for the selected Google field</label><div class="login-text-row"><input id="login-text" type="password" autocomplete="off" maxlength="4096" placeholder="Enter text…"><button type="submit">Type text</button></div><small>Masked here and cleared after sending to Google’s field. Never shared in chat or written to application logs.</small></form>
</div>
<p class="note">Sign-in input passes through this private connection to the runner. Google keeps the signed-in session in the dedicated profile. The view closes when pairing finishes; your texts are not shown here.</p>
</div>`;

export const loginCss = `
.login-enabled main { width:min(1160px,100%); }
.login-description { color:#425b50; font-size:14px; line-height:1.6; margin:0 0 18px; max-width:690px; }
.login-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; }
.login-actions span { font-size:12px; color:#5e6e66; }
.login-enabled button { border:1px solid #b9cbbf; background:white; color:#244c39; border-radius:8px; padding:10px 14px; font:600 13px system-ui; cursor:pointer; }
.login-enabled button.primary { background:#174d3a; color:white; border-color:#174d3a; }
.login-enabled button:hover { background:#e6eee7; } .login-enabled button.primary:hover { background:#226246; }
.login-enabled button:disabled { opacity:.55; cursor:wait; }
.login-enabled :focus-visible { outline:3px solid #6a9ce8; outline-offset:3px; }
#login-note, #login-help { font-size:12px; line-height:1.6; color:#526b5e; }
.login-browser { border:1px solid #cad8ce; border-radius:12px; overflow:hidden; background:white; }
.login-origin-bar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid #dce4dc; background:#edf3ee; }
.login-origin-bar span { font-size:9px; font-weight:700; letter-spacing:1px; color:#526b5e; }
.login-origin-bar strong { font-size:12px; font-weight:600; overflow-wrap:anywhere; }
#login-zoom { margin-left:auto; }
.login-canvas { min-height:60px; } #login-screen { display:block; width:100%; height:auto; cursor:crosshair; }
.login-canvas.full-size { overflow:auto; max-height:65vh; overscroll-behavior:contain; }
.login-canvas.full-size #login-screen { width:auto; }
#login-screen:focus-visible { outline-offset:-3px; }
.login-keys { display:flex; gap:8px; flex-wrap:wrap; margin:14px 0 20px; }
.login-keys button { padding:8px 12px; }
#login-text-form label { display:block; font-size:13px; font-weight:600; margin-bottom:8px; }
.login-text-row { display:flex; gap:8px; } .login-text-row input { min-width:0; flex:1; border:1px solid #b9cbbf; border-radius:8px; padding:10px 12px; font:16px system-ui; background:white; color:#172b27; }
.login-text-row button { flex-shrink:0; } #login-text-form small { display:block; font-size:11px; line-height:1.6; color:#526b5e; margin-top:8px; }
@media(max-width:650px) { .login-enabled .card { padding:25px 14px; } .login-enabled .account-panel { padding:16px 12px; } .login-origin-bar { padding:10px; gap:5px; } .login-actions { align-items:flex-start; flex-direction:column; } }
`;

export const loginScript = `
(() => {
  const start = document.querySelector('#login-start');
  const stop = document.querySelector('#login-stop');
  const view = document.querySelector('#login-view');
  const screen = document.querySelector('#login-screen');
  const canvas = document.querySelector('.login-canvas');
  const zoom = document.querySelector('#login-zoom');
  const origin = document.querySelector('#login-origin');
  const note = document.querySelector('#login-note');
  const helper = document.querySelector('#login-text');
  let token, version, imageUrl, timer;
  let tail = Promise.resolve();
  let pending = 0;

  async function failure(response) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error?.message || 'The private login connection is unavailable. Reopen the portal and try again.');
    error.code = data.error?.code;
    return error;
  }
  async function post(path, body, activeToken) {
    const response = await fetch(path, { method:'POST', cache:'no-store', headers:{'Content-Type':'application/json', ...(activeToken ? {'X-Login-Token':activeToken} : {})}, body:JSON.stringify(body) });
    if (!response.ok) throw await failure(response);
    return response.status === 204 ? null : response.json();
  }
  function clearFrame() {
    screen.hidden = true;
    screen.removeAttribute('src');
    version = undefined;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = undefined;
  }
  function close(message) {
    const previous = token;
    token = undefined;
    clearTimeout(timer);
    clearFrame();
    helper.value = '';
    view.hidden = true;
    stop.hidden = true;
    start.hidden = false;
    note.textContent = message;
    if (previous) void post('/login/stop', {}, previous).catch(() => {});
  }
  async function refreshFrame(activeToken) {
    let next;
    try {
      const response = await fetch('/login/frame', {cache:'no-store', headers:{'X-Login-Token':activeToken}});
      if (!response.ok || response.headers.get('content-type') !== 'image/png') throw await failure(response);
      const blob = await response.blob();
      if (token !== activeToken) return;
      next = URL.createObjectURL(blob);
      const decoded = new Image();
      decoded.src = next;
      await decoded.decode();
      if (token !== activeToken) { URL.revokeObjectURL(next); return; }
      const previous = imageUrl;
      imageUrl = next;
      screen.src = next;
      if (previous) URL.revokeObjectURL(previous);
      version = Number(response.headers.get('x-login-version'));
      origin.textContent = response.headers.get('x-login-origin');
      screen.hidden = false;
    } catch (error) {
      if (next && next !== imageUrl) URL.revokeObjectURL(next);
      if (token !== activeToken) return;
      if (error.code === 'LOGIN_SCREEN_CHANGED') clearFrame();
      else { close(error.message || 'Login connection lost. Open a new login view to continue.'); return; }
    }
    if (token === activeToken) timer = setTimeout(() => refreshFrame(activeToken), 800);
  }
  function input(command) {
    if (!token || version === undefined) { note.textContent = 'Wait for the Google screen to finish loading, then try again.'; return; }
    if (pending >= 128) { note.textContent = 'Input is still catching up. Wait before typing more.'; return; }
    const activeToken = token;
    const body = {...command, version};
    pending++;
    tail = tail.then(async () => {
      if (token !== activeToken) return;
      try {
        await post('/login/input', body, activeToken);
      } catch (error) {
        if (token !== activeToken) return;
        if (error.code === 'LOGIN_SCREEN_CHANGED') {
          clearFrame();
          note.textContent = 'The Google screen changed. Wait for the new screen and check your last input; it was not retried.';
        } else close(error.message || 'Input could not be confirmed. Check the Google screen before trying again.');
      }
    }).finally(() => { pending--; });
  }
  start.addEventListener('click', async () => {
    start.disabled = true;
    note.textContent = 'Opening Google sign-in…';
    try {
      const lease = await post('/login/start', {});
      token = lease.token;
      start.hidden = true;
      stop.hidden = false;
      view.hidden = false;
      note.textContent = 'You are controlling the dedicated Google browser. Complete sign-in, then confirm on your phone.';
      void refreshFrame(token);
    } catch (error) { close(error.message || 'Could not open Google sign-in. Try again.'); }
    finally { start.disabled = false; }
  });
  stop.addEventListener('click', () => close('Login view closed. The dedicated browser keeps your sign-in progress.'));
  zoom.addEventListener('click', () => {
    const fullSize = canvas.classList.toggle('full-size');
    zoom.setAttribute('aria-pressed', String(fullSize));
    zoom.textContent = fullSize ? 'Fit screen' : 'Full-size view';
  });
  screen.addEventListener('click', event => {
    screen.focus({preventScroll:true});
    const box = screen.getBoundingClientRect();
    input({type:'click', x:(event.clientX-box.left)*screen.naturalWidth/box.width, y:(event.clientY-box.top)*screen.naturalHeight/box.height});
  });
  screen.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { screen.blur(); event.preventDefault(); return; }
    const modified = event.ctrlKey || event.metaKey;
    if (modified && event.key.toLowerCase() === 'v') return;
    let command;
    if (modified && event.key.toLowerCase() === 'a') command = {type:'key', key:'ControlOrMeta+A'};
    else if (modified || event.altKey) return;
    else if (['Tab','Enter','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) command = {type:'key', key:event.key === 'Tab' && event.shiftKey ? 'Shift+Tab' : event.key};
    else if (event.key.length === 1) command = {type:'text', text:event.key};
    else return;
    event.preventDefault();
    input(command);
  });
  screen.addEventListener('paste', event => {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain');
    if (text) input({type:'text', text});
  });
  screen.addEventListener('wheel', event => {
    if (canvas.classList.contains('full-size')) return;
    event.preventDefault();
    input({type:'scroll', deltaY:Math.max(-800, Math.min(800, event.deltaY * (event.deltaMode === 1 ? 20 : 1)))});
  }, {passive:false});
  for (const button of document.querySelectorAll('[data-login-key]')) button.addEventListener('click', () => input({type:'key', key:button.dataset.loginKey}));
  for (const button of document.querySelectorAll('[data-login-scroll]')) button.addEventListener('click', () => input({type:'scroll', deltaY:Number(button.dataset.loginScroll)}));
  document.querySelector('#login-text-form').addEventListener('submit', event => {
    event.preventDefault();
    const text = helper.value;
    helper.value = '';
    if (text) input({type:'text', text});
  });
  window.addEventListener('pairing-state', event => {
    if (event.detail === 'paired' || event.detail === 'closed' || event.detail === 'unavailable') close('Login view closed. Check the pairing status below.');
  });
  window.addEventListener('pagehide', () => close('Login view closed.'));
})();
`;

/* global document */
import { createHash } from "node:crypto";

// One real password input preserves keyboard editing, paste, autofill and
// screen-reader semantics. The individual boxes are a visual representation.
function enhancePin() {
  const input = document.querySelector("#pin");
  const boxes = [...document.querySelectorAll("[data-digit]")];
  const button = document.querySelector("button");
  function render() {
    const before = input.value;
    const caret = before
      .slice(0, input.selectionStart)
      .replace(/[^0-9]/g, "").length;
    const numeric = before.replace(/[^0-9]/g, "").slice(0, 12);
    if (before !== numeric) {
      input.value = numeric;
      input.setSelectionRange(Math.min(caret, 12), Math.min(caret, 12));
    }
    // Existing longer custom PINs retain a second row rather than being cut off.
    const count = input.value.length > 6 ? 12 : 6;
    const active = Math.min(input.selectionStart, count - 1);
    boxes.forEach((box, index) => {
      box.hidden = index >= count;
      box.textContent = index < input.value.length ? "•" : "";
      box.classList.toggle(
        "active",
        document.activeElement === input && index === active,
      );
      box.classList.toggle("filled", index < input.value.length);
    });
    button.disabled = input.value.length < 6;
  }
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("blur", render);
  input.addEventListener("keyup", render);
  input.addEventListener("select", render);
  input.addEventListener("keydown", (event) => {
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.length === 1 &&
      !/^[0-9]$/.test(event.key)
    )
      event.preventDefault();
  });
  input.addEventListener("paste", (event) => {
    event.preventDefault();
    const text = event.clipboardData.getData("text").replace(/[^0-9]/g, "");
    const available =
      12 - input.value.length + input.selectionEnd - input.selectionStart;
    input.setRangeText(
      text.slice(0, available),
      input.selectionStart,
      input.selectionEnd,
      "end",
    );
    render();
  });
  input.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const index = boxes.findIndex((box) => {
      const rect = box.getBoundingClientRect();
      return (
        !box.hidden &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    });
    input.focus();
    const caret =
      index < 0 ? input.value.length : Math.min(index, input.value.length);
    input.setSelectionRange(caret, caret);
    render();
  });
  document.documentElement.classList.add("enhanced");
  render();
}

const script = `(${enhancePin.toString()})();`;
const scriptHash = createHash("sha256").update(script).digest("base64");

export function loginPage(
  res,
  portalUrl,
  status = 200,
  message = "",
  headers = {},
) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; form-action 'self' ${portalUrl}; base-uri 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    ...headers,
  });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Protected portal</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;background:#000;color:#ededed;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(360px,calc(100% - 48px));padding:40px 0}
h1{margin:0 0 12px;font-size:24px;line-height:1.25;letter-spacing:-.7px;font-weight:600}
.description{margin:0 0 28px;color:#a1a1a1;max-width:330px}
.label{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.pin-entry{position:relative}
input,button{font:inherit;border-radius:6px;width:100%;appearance:none}
input{height:52px;padding:12px;border:1px solid #333;background:#0a0a0a;color:#ededed;font-size:22px;letter-spacing:.3em}
.digits{display:none;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
[data-digit]{display:grid;place-items:center;height:52px;border:1px solid #333;border-radius:6px;background:#0a0a0a;font:24px/1 ui-monospace,SFMono-Regular,Consolas,monospace}
[data-digit][hidden]{display:none}
[data-digit].filled{border-color:#666}
[data-digit].active{border-color:#ededed;box-shadow:0 0 0 1px #ededed}
.enhanced .digits{display:grid}
.enhanced input{position:absolute;inset:0;height:100%;opacity:0;cursor:text}
button{margin-top:24px;min-height:44px;padding:10px 16px;border:1px solid #ededed;background:#ededed;color:#000;font-weight:500;cursor:pointer}
button:hover:not(:disabled){background:#fff;border-color:#fff}
button:disabled{cursor:not-allowed;opacity:.45}
button:focus-visible,input:focus-visible{outline:2px solid #ededed;outline-offset:4px}
.error{margin:16px 0 0;color:#ededed;font-size:13px}
</style></head><body><main>
<h1>Protected portal</h1><p class="description" id="description">This portal is protected, enter the pin to gain access.</p>
<form method="post"><label class="label" for="pin">PIN</label><div class="pin-entry">
<div class="digits" aria-hidden="true">${Array.from({ length: 12 }, (_, index) => `<span data-digit${index >= 6 ? " hidden" : ""}></span>`).join("")}</div>
<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" autocomplete="current-password" aria-describedby="description${message ? " error" : ""}"${status === 401 ? ' aria-invalid="true"' : ""} required autofocus>
</div><button type="submit">Continue</button>${message ? `<p class="error" id="error" role="status">${message}</p>` : ""}</form>
</main><script>${script}</script></body></html>`);
}

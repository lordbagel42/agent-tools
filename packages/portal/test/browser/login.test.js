import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loginPage } from "../../src/login.js";
import { listen } from "../helpers.js";

test("segmented PIN supports numeric editing, paste, longer PINs and native form submission", async (t) => {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") return loginPage(res, "http://127.0.0.1");
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(new URLSearchParams(body).get("pin"), "012345");
    res.end("Signed in");
  });
  const port = await listen(server);
  const session = `pin-ui-test-${process.pid}`;
  async function browser(...args) {
    const { stdout } = await promisify(execFile)("agent-browser", [
      "--session",
      session,
      "--json",
      ...args,
    ]);
    const result = JSON.parse(stdout);
    assert.equal(result.success, true, result.error);
    return result.data;
  }
  t.after(async () => {
    await browser("close");
    await new Promise((resolve) => server.close(resolve));
  });
  await browser("open", `http://127.0.0.1:${port}`);
  const state = async () =>
    (
      await browser(
        "eval",
        `JSON.stringify({value:document.querySelector('#pin').value,boxes:document.querySelectorAll('[data-digit]:not([hidden])').length,filled:document.querySelectorAll('[data-digit].filled').length,disabled:document.querySelector('button').disabled})`,
      )
    ).result;
  assert.deepEqual(JSON.parse(await state()), {
    value: "",
    boxes: 6,
    filled: 0,
    disabled: true,
  });
  await browser("fill", "#pin", "a0b1-2 x3");
  assert.equal(JSON.parse(await state()).value, "0123");
  await browser("press", "A");
  assert.equal(JSON.parse(await state()).value, "0123");
  await browser("press", "Backspace");
  assert.equal(JSON.parse(await state()).value, "012");
  await browser("press", "ArrowLeft");
  await browser("press", "9");
  assert.equal(JSON.parse(await state()).value, "0192");
  await browser("fill", "#pin", "");
  await browser(
    "eval",
    `(() => { const data = new DataTransfer(); data.setData('text','0a1 2-3b45'); document.querySelector('#pin').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true})); })()`,
  );
  assert.deepEqual(JSON.parse(await state()), {
    value: "012345",
    boxes: 6,
    filled: 6,
    disabled: false,
  });
  await browser("fill", "#pin", "012345678901");
  assert.deepEqual(JSON.parse(await state()), {
    value: "012345678901",
    boxes: 12,
    filled: 12,
    disabled: false,
  });
  await browser("fill", "#pin", "012345");
  await browser("click", "button");
  await browser("wait", "--text", "Signed in");
});

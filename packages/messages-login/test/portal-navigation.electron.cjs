// Run with Electron, not node:test: this checks the actual sandboxed helper window.
const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { app } = require("electron");

const origin = "https://pairing.example.test";
const login = "https://login.example.test/login?returnTo=%2F";
let authenticated = false;
let posts = 0;
let setupRequests = 0;
let setupStatus = 200;
let completionRequests = 0;
let googleRequests = 0;
let foreignRequests = 0;
let stage = "startup";

const deadline = setTimeout(() => {
  console.error(`FAIL: timed out during ${stage}`);
  app.exit(1);
}, 15_000);

async function until(condition, message) {
  const end = Date.now() + 2500;
  while (!(await condition())) {
    assert.ok(Date.now() < end, message);
    await delay(20);
  }
}

// Intercept only the network. The real preload, IPC authorization, navigation
// guards, form submission, redirects, and BrowserWindow run unchanged.
app.on("session-created", (session) => {
  session.protocol.handle("https", async (request) => {
    const url = new URL(request.url);
    if (url.origin === origin) {
      if (url.pathname === "/connect/start") setupRequests++;
      if (url.pathname === "/connect/complete") completionRequests++;
      if (!authenticated) return Response.redirect(login, 302);
      if (url.pathname === "/connect/start") {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.get("origin"), origin);
        assert.equal(await request.text(), "{}");
        if (setupStatus === 302) return Response.redirect(login, 302);
        if (setupStatus !== 200) {
          return new Response("private upstream diagnostic", {
            status: setupStatus,
          });
        }
        // A valid server lease must work even with a different desktop clock.
        const serverNow = Date.now() + 120_000;
        return Response.json(
          { token: "fixture-setup-token", expiresAt: serverNow + 900_000 },
          { headers: { Date: new Date(serverNow).toUTCString() } },
        );
      }
      if (url.pathname === "/connect/complete") {
        return new Response(null, { status: 403 });
      }
      return new Response("<h1>Private pairing page</h1>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (request.url === login) {
      if (request.method === "POST") {
        posts++;
        authenticated = true;
        return Response.redirect(origin, 303);
      }
      return new Response(
        '<form method="post"><input name="pin" type="password" required><button>Continue</button></form><a id="foreign" href="https://unrelated.example.test/">Leave</a>',
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.origin === "https://accounts.google.com") {
      googleRequests++;
      return new Response("<h1>Offline Google sign-in fixture</h1>", {
        headers: { "content-type": "text/html" },
      });
    }
    foreignRequests++;
    return new Response("Unexpected destination", { status: 403 });
  });
});

const created = new Promise((resolve) => {
  app.once("browser-window-created", (_event, window) => resolve(window));
});
process.argv = [process.argv[0], path.resolve(__dirname, ".."), origin];

async function run() {
  await import(pathToFileURL(path.resolve(__dirname, "../dist/src/main.js")));
  const window = await created;
  for (const method of ["click", "Enter"]) {
    stage = `${method} PIN form`;
    if (method === "Enter") {
      authenticated = false;
      await window.loadURL(origin);
    }
    await until(
      () =>
        window.webContents.getURL() === login &&
        !window.webContents.isLoading(),
      "The configured portal should redirect to its separate login origin",
    );
    const denied = await window.webContents.executeJavaScript(
      "window.messagesHelper.connect()",
    );
    assert.equal(
      denied.ok,
      false,
      "The login origin must not invoke Google sign-in",
    );
    assert.equal(setupRequests, 0);

    await window.webContents.executeJavaScript(
      "document.querySelector('#foreign').click()",
    );
    await delay(100);
    assert.equal(window.webContents.getURL(), login);
    assert.equal(
      foreignRequests,
      0,
      "Unrelated navigation must remain blocked",
    );

    // Synthetic fixture input only; no real portal PIN or account is used.
    await window.webContents.executeJavaScript(
      "document.querySelector('input').value = 'fixture'; document.querySelector('input').focus()",
    );
    if (method === "click") {
      await window.webContents.executeJavaScript(
        "document.querySelector('button').click()",
      );
    } else {
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }
    await until(
      () =>
        authenticated &&
        new URL(window.webContents.getURL()).origin === origin &&
        !window.webContents.isLoading(),
      `${method} must submit the login form and return to the private portal`,
    );
    assert.equal(posts, method === "click" ? 1 : 2);
  }

  stage = "authenticated setup with clock skew";
  const googleCreated = new Promise((resolve) => {
    app.once("browser-window-created", (_event, window) => resolve(window));
  });
  const connecting = window.webContents.executeJavaScript(
    "window.messagesHelper.connect()",
  );
  const googleWindow = await googleCreated;
  await until(
    () => googleRequests === 1 && !googleWindow.webContents.isLoading(),
    "Authenticated setup should reach Google sign-in",
  );
  assert.equal(setupRequests, 1);
  assert.notEqual(googleWindow.webContents.session, window.webContents.session);
  assert.equal(
    await googleWindow.webContents.executeJavaScript(
      "typeof window.messagesHelper",
    ),
    "undefined",
    "Google's window must not receive the portal IPC bridge",
  );
  googleWindow.close();
  const cancelled = await connecting;
  assert.equal(cancelled.ok, false);
  assert.match(cancelled.message, /cancelled.*No credentials were sent/i);

  for (const [status, expected] of [
    [401, /HTTP 401.*portal.*session.*expired.*PIN/i],
    [403, /HTTP 403/],
    [502, /HTTP 502/],
    [302, /portal.*session.*expired.*PIN/i],
  ]) {
    stage = `setup failure HTTP ${status}`;
    setupStatus = status;
    const failure = await window.webContents.executeJavaScript(
      "window.messagesHelper.connect()",
    );
    assert.equal(failure.ok, false);
    assert.match(failure.message, expected);
    assert.doesNotMatch(failure.message, /private upstream diagnostic/);
  }
  assert.equal(setupRequests, 5);
  assert.equal(googleRequests, 1, "Failed setup must not start Google sign-in");
  assert.equal(
    completionRequests,
    0,
    "Cancellation must not transfer credentials",
  );
  console.log(
    "PASS: PIN click/Enter, authenticated setup with clock skew, isolated Google window, cancellation, safe setup errors, and navigation/IPC guards.",
  );
}

void run().then(
  () => {
    clearTimeout(deadline);
    app.exit(0);
  },
  (error) => {
    clearTimeout(deadline);
    console.error(`FAIL during ${stage}: ${error.message}`);
    app.exit(1);
  },
);

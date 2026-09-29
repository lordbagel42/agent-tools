import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizedConnectIpc } from "../src/ipc-authorization.js";

function authorizedFixture(frameUrl = "https://pairing.example.test/setup") {
  const mainFrame = { url: frameUrl };
  const webContents = { mainFrame };
  return {
    event: { sender: webContents, senderFrame: mainFrame },
    portalWindow: { webContents },
  };
}

test("authorizes the exact portal window's top-level frame at the configured origin", () => {
  const { event, portalWindow } = authorizedFixture(
    "https://pairing.example.test/connect?view=helper#status",
  );

  assert.equal(
    isAuthorizedConnectIpc(event, portalWindow, "https://pairing.example.test"),
    true,
  );
});

test("rejects IPC from another window even when its URL has the right origin", () => {
  const { event, portalWindow } = authorizedFixture();
  event.sender = { mainFrame: event.senderFrame };

  assert.equal(
    isAuthorizedConnectIpc(event, portalWindow, "https://pairing.example.test"),
    false,
  );
});

test("rejects IPC from a child frame even when its URL has the right origin", () => {
  const { event, portalWindow } = authorizedFixture();
  event.senderFrame = { url: "https://pairing.example.test/embedded" };

  assert.equal(
    isAuthorizedConnectIpc(event, portalWindow, "https://pairing.example.test"),
    false,
  );
});

test("rejects IPC when the top-level frame is not at the exact configured origin", () => {
  for (const frameUrl of [
    "https://pairing.example.test.evil.invalid/",
    "https://pairing.example.test:8443/",
    "http://pairing.example.test/",
    "not a URL",
  ]) {
    const { event, portalWindow } = authorizedFixture(frameUrl);
    assert.equal(
      isAuthorizedConnectIpc(
        event,
        portalWindow,
        "https://pairing.example.test",
      ),
      false,
    );
  }
});

test("rejects IPC without a live top-level sender frame", () => {
  const { event, portalWindow } = authorizedFixture();
  const missingFrame = { ...event, senderFrame: null };

  assert.equal(
    isAuthorizedConnectIpc(
      missingFrame,
      portalWindow,
      "https://pairing.example.test",
    ),
    false,
  );
});

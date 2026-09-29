import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { parseLaunchArguments } from "./config.js";
import { ConnectCoordinator, type ConnectResult } from "./coordinator.js";
import { acquireGoogleCredentials } from "./google-login.js";
import { isAuthorizedConnectIpc } from "./ipc-authorization.js";
import { PairingProtocol, type SessionFetch } from "./protocol.js";
import { ephemeralPartition } from "./security-policy.js";

const CONNECT_CHANNEL = "messages-helper:connect";
const UNAUTHORIZED: ConnectResult = Object.freeze({
  ok: false,
  message: "The portal did not authorize this request.",
});

function configurePortalWindow(serverOrigin: string): {
  window: BrowserWindow;
  coordinator: ConnectCoordinator;
} {
  const portalSession = session.fromPartition(
    ephemeralPartition("portal", randomUUID()),
    { cache: false },
  );
  portalSession.setPermissionCheckHandler(() => false);
  portalSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => {
      callback(false);
    },
  );
  portalSession.on("will-download", (event) => event.preventDefault());

  const portalWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: "Messages login helper",
    autoHideMenuBar: true,
    webPreferences: {
      session: portalSession,
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    },
  });
  portalWindow.setMenu(null);
  portalWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  portalWindow.webContents.on("will-navigate", (event, targetUrl) => {
    try {
      const target = new URL(targetUrl);
      const current = new URL(portalWindow.webContents.getURL());
      // A private proxy can redirect to a separate PIN/login origin. Let that
      // page submit its own HTTPS form; IPC still requires serverOrigin below.
      if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        (target.origin !== serverOrigin && target.origin !== current.origin)
      ) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

  const portalFetch: SessionFetch = (input, init) =>
    portalWindow.webContents.session.fetch(input, init);
  const protocol = new PairingProtocol(serverOrigin, portalFetch);
  const coordinator = new ConnectCoordinator(protocol, (lease) =>
    acquireGoogleCredentials(portalWindow, serverOrigin, lease),
  );

  return { window: portalWindow, coordinator };
}

async function run(): Promise<void> {
  app.setName("Messages Login Helper");

  let serverOrigin: string;
  try {
    serverOrigin = parseLaunchArguments(process.argv, app.isPackaged);
  } catch {
    await app.whenReady();
    dialog.showErrorBox(
      "Invalid server origin",
      "Usage: npm start -- https://SERVER_ORIGIN\n\nThe value must be one HTTPS origin with no path, query, fragment, or userinfo.",
    );
    app.exit(2);
    return;
  }

  await app.whenReady();
  const { window: portalWindow, coordinator } =
    configurePortalWindow(serverOrigin);

  ipcMain.handle(CONNECT_CHANNEL, async (event): Promise<ConnectResult> => {
    if (
      portalWindow.isDestroyed() ||
      !isAuthorizedConnectIpc(event, portalWindow, serverOrigin)
    ) {
      return UNAUTHORIZED;
    }
    return await coordinator.connect();
  });

  portalWindow.on("closed", () => {
    ipcMain.removeHandler(CONNECT_CHANNEL);
  });

  try {
    await portalWindow.loadURL(serverOrigin);
  } catch {
    if (!portalWindow.isDestroyed()) {
      portalWindow.destroy();
    }
    dialog.showErrorBox(
      "Could not load the pairing portal",
      "The HTTPS portal could not be loaded. Check the address, network, and TLS certificate, then try again.",
    );
    app.exit(1);
  }
}

app.on("window-all-closed", () => app.quit());

void run().catch(async () => {
  await app.whenReady();
  dialog.showErrorBox(
    "Messages login helper failed",
    "The helper stopped before setup could begin. No credentials were transferred.",
  );
  app.exit(1);
});

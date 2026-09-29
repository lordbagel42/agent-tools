import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, type Session, session } from "electron";
import {
  GOOGLE_LOGIN_URL,
  isMessagesConfigUrl,
  MESSAGES_CONFIG_URL,
} from "./config.js";
import { selectGoogleCredentials } from "./cookies.js";
import type { CredentialAcquisition } from "./coordinator.js";
import type { SetupLease } from "./protocol.js";
import { buildConsentCopy, ephemeralPartition } from "./security-policy.js";

async function clearGoogleSession(
  googleWindow: BrowserWindow,
  googleSession: Session,
): Promise<void> {
  if (!googleWindow.isDestroyed()) {
    googleWindow.destroy();
  }
  await Promise.allSettled([
    googleSession.clearStorageData(),
    googleSession.clearCache(),
    googleSession.clearAuthCache(),
  ]);
}

export async function acquireGoogleCredentials(
  parent: BrowserWindow,
  serverOrigin: string,
  lease: SetupLease,
): Promise<CredentialAcquisition> {
  if (lease.expiresAt <= Date.now()) {
    return { kind: "expired" };
  }

  const googleSession = session.fromPartition(
    ephemeralPartition("google", randomUUID()),
    { cache: false },
  );
  googleSession.on("will-download", (event) => event.preventDefault());

  const googleWindow = new BrowserWindow({
    parent,
    width: 560,
    height: 760,
    minWidth: 440,
    minHeight: 600,
    title: "Google sign-in — Messages login helper",
    autoHideMenuBar: true,
    webPreferences: {
      session: googleSession,
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
  googleWindow.setMenu(null);
  googleWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return await new Promise<CredentialAcquisition>((resolve) => {
    let settled = false;
    let inspectingConfig = false;
    const expirationTimer = setTimeout(
      () => settle({ kind: "expired" }),
      Math.max(0, lease.expiresAt - Date.now()),
    );

    const settle = (outcome: CredentialAcquisition): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(expirationTimer);
      void clearGoogleSession(googleWindow, googleSession).then(() => {
        resolve(outcome);
      });
    };

    const inspectConfigPage = async (): Promise<void> => {
      if (
        settled ||
        inspectingConfig ||
        !isMessagesConfigUrl(googleWindow.webContents.getURL())
      ) {
        return;
      }
      inspectingConfig = true;

      try {
        if (lease.expiresAt <= Date.now()) {
          settle({ kind: "expired" });
          return;
        }

        const availableCookies = await googleSession.cookies.get({
          url: MESSAGES_CONFIG_URL,
        });
        const cookies = selectGoogleCredentials(availableCookies);
        const copy = buildConsentCopy(serverOrigin);
        const consent = await dialog.showMessageBox(googleWindow, {
          type: "warning",
          title: copy.title,
          message: copy.message,
          detail: copy.detail,
          buttons: ["Cancel", "Transfer credentials"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });

        if (settled) {
          return;
        }
        if (consent.response !== 1) {
          settle({ kind: "cancelled" });
          return;
        }
        if (lease.expiresAt <= Date.now()) {
          settle({ kind: "expired" });
          return;
        }
        settle({ kind: "ready", cookies });
      } catch {
        settle({ kind: "error" });
      } finally {
        inspectingConfig = false;
      }
    };

    googleWindow.on("closed", () => settle({ kind: "cancelled" }));
    googleWindow.webContents.on("did-finish-load", () => {
      void inspectConfigPage();
    });
    googleWindow.webContents.on("did-navigate-in-page", () => {
      void inspectConfigPage();
    });

    void googleWindow.loadURL(GOOGLE_LOGIN_URL).catch(() => {
      settle({ kind: "error" });
    });
  });
}

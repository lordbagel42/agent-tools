import { contextBridge, ipcRenderer } from "electron";

const CONNECT_CHANNEL = "messages-helper:connect";

interface ConnectResult {
  readonly ok: boolean;
  readonly message?: string;
}

function sanitizeResult(value: unknown): ConnectResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, message: "The helper returned an invalid response." };
  }

  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") {
    return { ok: false, message: "The helper returned an invalid response." };
  }

  if (typeof record.message === "string") {
    return Object.freeze({ ok: record.ok, message: record.message });
  }
  return Object.freeze({ ok: record.ok });
}

const messagesHelper = Object.freeze({
  connect: async (): Promise<ConnectResult> =>
    sanitizeResult(await ipcRenderer.invoke(CONNECT_CHANNEL)),
});

contextBridge.exposeInMainWorld("messagesHelper", messagesHelper);

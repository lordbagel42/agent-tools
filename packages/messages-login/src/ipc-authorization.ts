export interface ConnectIpcEventLike {
  readonly sender: unknown;
  readonly senderFrame: unknown | null;
}

export interface PortalWindowLike {
  readonly webContents: {
    readonly mainFrame: unknown;
  };
}

export function isAuthorizedConnectIpc(
  event: ConnectIpcEventLike,
  portalWindow: PortalWindowLike,
  serverOrigin: string,
): boolean {
  const { webContents } = portalWindow;
  if (
    event.sender !== webContents ||
    event.senderFrame === null ||
    event.senderFrame !== webContents.mainFrame
  ) {
    return false;
  }

  const frameUrl = (event.senderFrame as { readonly url?: unknown }).url;
  if (typeof frameUrl !== "string") {
    return false;
  }

  try {
    const allowed = new URL(serverOrigin);
    const sender = new URL(frameUrl);
    return (
      allowed.origin === serverOrigin &&
      sender.origin === serverOrigin &&
      sender.username === "" &&
      sender.password === ""
    );
  } catch {
    return false;
  }
}

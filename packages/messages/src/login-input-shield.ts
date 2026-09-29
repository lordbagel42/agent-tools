import { randomUUID } from "node:crypto";
import type { Page } from "playwright";

type ShieldState = {
  operation: string | null;
  url: string | null;
  arm(operation: string, url: string | null): void;
  disarm(operation: string): void;
};

declare global {
  interface Window {
    __gmApiLoginShield?: ShieldState;
  }
}

// Serialized into each document before site scripts. A new document never inherits an input grant.
function installShield(operation: string | null) {
  if (window.__gmApiLoginShield) {
    if (operation) window.__gmApiLoginShield.arm(operation, null);
    return;
  }
  const state: ShieldState = {
    operation,
    url: null,
    arm(id, url) {
      this.operation = id;
      this.url = url === location.href ? url : null;
    },
    disarm(id) {
      if (this.operation === id) {
        this.operation = null;
        this.url = null;
      }
    },
  };
  Object.defineProperty(window, "__gmApiLoginShield", { value: state });
  const guard = (event: Event) => {
    if (!state.operation) return;
    let allowed = state.url === location.href;
    if (location.hostname === "messages.google.com") {
      const auth =
        "mw-welcome-page-container, mw-authentication-container, mw-gaia-pairing-container, mw-pair-page-container";
      const paired =
        "mws-conversations-list, mws-conversation-list, mws-message-wrapper, mws-message-send-button, textarea[data-e2e-message-input-box]";
      const target =
        event.target instanceof Element ? event.target : document.activeElement;
      const tabFromBody =
        target === document.body &&
        event instanceof KeyboardEvent &&
        event.key === "Tab" &&
        document.querySelector(auth);
      allowed =
        allowed &&
        /^\/web\/(?:u\/\d+\/)?(?:welcome|authentication|pair)\/?$/.test(
          location.pathname,
        ) &&
        !document.querySelector(paired) &&
        Boolean(target?.closest(auth) || tabFromBody);
    }
    if (!allowed) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  for (const event of [
    "pointerdown",
    "pointerup",
    "pointermove",
    "mousedown",
    "mouseup",
    "mousemove",
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
    "keypress",
    "keyup",
    "beforeinput",
    "input",
    "wheel",
    "submit",
    "touchstart",
    "touchend",
  ])
    window.addEventListener(event, guard, { capture: true, passive: false });
}

export class LoginInputShield {
  private prepared = false;

  constructor(private readonly page: Page) {}

  async prepare(): Promise<void> {
    if (this.prepared) return;
    await this.page.addInitScript(installShield, null);
    this.prepared = true;
    // The existing page predates the bootstrap. Reload once so capture listeners precede Google's.
    await this.page.reload({ waitUntil: "domcontentloaded" });
  }

  // Caller holds MessagesPage's operation queue until all native input and shield cleanup finish.
  async run(
    authorize: () => void,
    dispatch: () => Promise<void>,
  ): Promise<void> {
    const id = randomUUID();
    const registration = await this.page.addInitScript(installShield, id);
    let dispatched = false;
    let completed = false;
    try {
      for (const frame of this.page.frames()) {
        const url = frame.url();
        const origin = new URL(url).origin;
        const permitted = [
          "https://accounts.google.com",
          "https://messages.google.com",
          "https://www.google.com",
          "https://www.recaptcha.net",
          "https://recaptcha.google.com",
        ].includes(origin);
        await frame.evaluate(
          ({ id, url }) => {
            if (!window.__gmApiLoginShield)
              throw new Error("Login input shield unavailable");
            window.__gmApiLoginShield.arm(id, url);
          },
          { id, url: permitted ? url : null },
        );
      }
      authorize();
      dispatched = true;
      await dispatch();
      completed = true;
    } catch (error) {
      // A rejected native dispatch can be ambiguous. Close this dedicated page before removing protection.
      if (dispatched && !completed)
        await this.page.close().catch(() => undefined);
      throw error;
    } finally {
      if (!dispatched || completed || this.page.isClosed()) {
        await registration.dispose();
        await Promise.all(
          this.page.frames().map((frame) =>
            frame
              .evaluate((id) => {
                window.__gmApiLoginShield?.disarm(id);
              }, id)
              .catch(() => undefined),
          ),
        );
      }
    }
  }
}

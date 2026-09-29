import type { Page } from "playwright";
import {
  ApiError,
  type Conversation,
  type ConversationList,
  type Message,
  type MessageList,
  type MessagesClient,
  type SendReceipt,
  type SendRequest,
  type SessionStatus,
} from "./types.js";
import {
  parseConversationId,
  parseLimit,
  parseSendRequest,
} from "./validation.js";

// Google's DOM is not a supported API. Keep the observed contracts in one place.
const selectors = {
  list: "mws-conversations-list, mws-conversation-list",
  row: "mws-conversation-list-item",
  qr: "[data-e2e-qr-code]",
  message: "mws-message-wrapper",
  compose:
    "textarea[data-e2e-message-input-box], textarea[aria-label*='message' i]",
  send: "mws-message-send-button button",
};

function conversationId(url: string): string | null {
  return (
    new URL(url).pathname.match(
      /\/web\/(?:u\/\d+\/)?conversations\/([A-Za-z0-9_-]+)\/?$/,
    )?.[1] ?? null
  );
}

export class MessagesPage implements MessagesClient {
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;

  constructor(
    readonly page: Page,
    readonly timeoutMs = 15_000,
  ) {
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queued >= 20) {
      return Promise.reject(
        new ApiError(
          429,
          "BUSY",
          "The browser queue is full. Try again later.",
        ),
      );
    }
    this.queued++;
    const result = this.tail
      .then(operation)
      .catch((error: unknown) => {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          503,
          "BROWSER_UNAVAILABLE",
          "The browser or Google Messages UI is unavailable. Check pairing and connectivity.",
        );
      })
      .finally(() => {
        this.queued--;
      });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async currentStatus(): Promise<SessionStatus> {
    let state: SessionStatus["state"] = "starting";
    if (this.page.isClosed()) state = "closed";
    else if (await this.page.locator(selectors.list).count()) state = "paired";
    else if (await this.page.locator(selectors.qr).first().isVisible())
      state = "qr_ready";
    else if (
      /authentication|welcome|accounts\.google\.com|signin|\/pair(?:[/?#]|$)/i.test(
        this.page.url(),
      ) ||
      (await this.page
        .locator("mw-authentication-container, mw-welcome-page-container")
        .count())
    )
      state = "pairing_required";
    return { state, transport: "browser" };
  }

  status(): Promise<SessionStatus> {
    return this.run(() => this.currentStatus());
  }

  duringPairing<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    return this.run(async () => {
      const check = async () => {
        if ((await this.currentStatus()).state === "paired")
          throw new ApiError(
            409,
            "ALREADY_PAIRED",
            "Phone paired. The login view is closed to protect your texts.",
          );
      };
      await check();
      try {
        const result = await operation(this.page);
        await check();
        return result;
      } catch (error) {
        await check();
        throw error;
      }
    });
  }

  pairingQr(): Promise<Buffer | null> {
    return this.run(async () => {
      if ((await this.currentStatus()).state === "paired") return null;
      const remember = this.page.getByRole("switch", {
        name: "Remember this computer",
      });
      if (
        (await remember.isVisible()) &&
        (await remember.getAttribute("aria-checked")) === "false"
      ) {
        await remember.click();
      }
      const qr = this.page.locator(selectors.qr).first();
      if (!(await qr.isVisible())) {
        const refresh = this.page
          .getByRole("button", { name: /(?:reload|refresh).*QR/i })
          .first();
        if (await refresh.isVisible()) await refresh.click();
      }
      if (!(await qr.isVisible())) return null;
      return qr.screenshot({ type: "png", animations: "disabled" });
    });
  }

  private async requirePaired() {
    if ((await this.currentStatus()).state !== "paired") {
      throw new ApiError(
        409,
        "PAIRING_REQUIRED",
        "Pair Google Messages with your phone first.",
      );
    }
  }

  private async scrollConversations(reset: boolean): Promise<boolean> {
    return this.page
      .locator(selectors.list)
      .first()
      .evaluate(async (root, reset) => {
        const elements = [root, ...root.querySelectorAll("*")];
        const viewport = elements.find(
          (element) =>
            element.scrollHeight > element.clientHeight &&
            /auto|scroll/.test(getComputedStyle(element).overflowY),
        );
        if (!viewport) return false;
        const previous = viewport.scrollTop;
        viewport.scrollTop = reset ? 0 : previous + viewport.clientHeight * 0.8;
        // Wait for the virtual list to process its scroll event and render a frame.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return viewport.scrollTop !== previous;
      }, reset);
  }

  listConversations(limit = 50): Promise<ConversationList> {
    return this.run(async () => {
      parseLimit(limit);
      await this.requirePaired();
      await this.scrollConversations(true);
      const collected = new Map<string, Conversation>();
      let stationary = 0;
      for (let step = 0; step < 100 && stationary < 2; step++) {
        const rows = await this.page
          .locator(selectors.row)
          .evaluateAll((rows) =>
            rows.flatMap((row) => {
              const link = row.querySelector<HTMLAnchorElement>(
                "a.list-item, a[href*='/conversations/']",
              );
              if (!link || link.origin !== location.origin) return [];
              const id = link.pathname.match(
                /\/web\/(?:u\/\d+\/)?conversations\/([A-Za-z0-9_-]+)\/?$/,
              )?.[1];
              if (!id || id === "new") return [];
              const timestamp = row.querySelector(
                "time, [data-e2e-conversation-timestamp], .timestamp",
              );
              return [
                {
                  id,
                  name:
                    row
                      .querySelector(
                        "[data-e2e-conversation-name], h2.name, .name",
                      )
                      ?.textContent?.trim() ?? "",
                  snippet:
                    row
                      .querySelector(
                        "mws-conversation-snippet, .snippet-text, .snippet",
                      )
                      ?.textContent?.trim() ?? "",
                  timestamp:
                    timestamp?.getAttribute("datetime") ||
                    timestamp?.getAttribute("title") ||
                    timestamp?.textContent?.trim() ||
                    null,
                  unread:
                    row.matches(".unread, [data-e2e-is-unread='true']") ||
                    Boolean(row.querySelector(".unread, .unread-indicator")),
                },
              ];
            }),
          );
        for (const row of rows) collected.set(row.id, row);
        if (collected.size >= limit) break;
        const moved = await this.scrollConversations(false);
        stationary = moved ? 0 : stationary + 1;
        // Lazy-loaded batches can arrive after the scroll frame.
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return {
        conversations: [...collected.values()].slice(0, limit),
        limited: collected.size >= limit || stationary < 2,
      };
    });
  }

  private async openConversation(id: string) {
    await this.requirePaired();
    const current = new URL(this.page.url());
    const prefix =
      current.pathname.match(/^\/web\/(?:u\/\d+\/)?/)?.[0] ?? "/web/";
    if (conversationId(current.href) !== id) {
      await this.page.goto(
        new URL(`${prefix}conversations/${id}`, current.origin).href,
        { waitUntil: "domcontentloaded" },
      );
    }
    const composer = this.page
      .locator(selectors.compose)
      .filter({ visible: true });
    try {
      await composer.first().waitFor({ state: "visible" });
    } catch {
      if ((await this.currentStatus()).state !== "paired")
        await this.requirePaired();
      throw new ApiError(
        404,
        "CONVERSATION_NOT_FOUND",
        "The requested conversation did not open.",
      );
    }
    if (
      conversationId(this.page.url()) !== id ||
      (await composer.count()) !== 1
    ) {
      throw new ApiError(
        404,
        "CONVERSATION_NOT_FOUND",
        "The requested conversation did not open unambiguously.",
      );
    }
    return composer;
  }

  private async visibleMessages(): Promise<Message[]> {
    return this.page.locator(selectors.message).evaluateAll((rows) =>
      rows.map((row) => {
        const primary = row.querySelectorAll("mws-text-message-part");
        const parts = primary.length
          ? primary
          : row.querySelectorAll(".text-msg");
        const outgoing = row.getAttribute("is-outgoing");
        const timestamp = row.querySelector(
          "time, [data-e2e-message-timestamp], .timestamp",
        );
        return {
          id: row.getAttribute("data-e2e-message-id"),
          direction:
            outgoing === "true"
              ? "outgoing"
              : outgoing === "false"
                ? "incoming"
                : "unknown",
          text: [...parts]
            .map((part) => part.textContent ?? "")
            .join("\n")
            .trim(),
          timestamp:
            timestamp?.getAttribute("datetime") ||
            timestamp?.getAttribute("title") ||
            timestamp?.textContent?.trim() ||
            null,
        };
      }),
    );
  }

  readMessages(id: string, limit = 50): Promise<MessageList> {
    return this.run(async () => {
      parseConversationId(id);
      parseLimit(limit);
      await this.openConversation(id);
      return {
        conversationId: id,
        messages: (await this.visibleMessages()).slice(-limit),
        coverage: "visible",
        order: "oldest-first",
      };
    });
  }

  sendText(request: SendRequest): Promise<SendReceipt> {
    return this.run(async () => {
      const { conversationId: id, text } = parseSendRequest(request);
      const composer = await this.openConversation(id);
      if (await composer.inputValue()) {
        throw new ApiError(
          409,
          "DRAFT_PRESENT",
          "The conversation has a draft. Clear or send it manually first.",
        );
      }
      const send = this.page.locator(selectors.send).filter({ visible: true });
      if ((await send.count()) !== 1) {
        throw new ApiError(
          503,
          "UI_CHANGED",
          "A unique Google Messages send button was not found.",
        );
      }
      const matches = (messages: Message[]) =>
        messages.filter(
          (message) =>
            message.direction === "outgoing" && message.text === text.trim(),
        );
      const before = matches(await this.visibleMessages());
      await composer.fill(text);
      if (conversationId(this.page.url()) !== id) {
        throw new ApiError(
          409,
          "CONVERSATION_CHANGED",
          "The active conversation changed before sending. No send was attempted.",
        );
      }
      try {
        // No Enter fallback and no retries: either can silently send an extra message.
        await send.click();
        const deadline = Date.now() + this.timeoutMs;
        while (Date.now() < deadline) {
          if (conversationId(this.page.url()) !== id) break;
          const after = matches(await this.visibleMessages());
          // IDs can be assigned or changed after render. Count only additional bubbles.
          const hasNew = after.length > before.length;
          if ((await composer.inputValue()) === "" && hasNew) {
            return {
              conversationId: id,
              status: "submitted",
              delivery: "unconfirmed",
              submittedAt: new Date().toISOString(),
            };
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch {
        // A click timeout can still mean the click was delivered. Do not attempt another.
      }
      throw new ApiError(
        504,
        "SEND_UNCERTAIN",
        "Submission could not be confirmed. Check the phone before trying any new send.",
      );
    });
  }
}

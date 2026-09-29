import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Disposable, Page } from "playwright";
import { LoginInputShield } from "./login-input-shield.js";
import type { MessagesPage } from "./messages-page.js";
import { ApiError } from "./types.js";

const origins = new Set([
  "https://accounts.google.com",
  "https://messages.google.com",
]);
const keys = new Set([
  "Tab",
  "Shift+Tab",
  "Enter",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "Escape",
  "ControlOrMeta+A",
]);
type Input = { version: number } & (
  | { type: "click"; x: number; y: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; deltaY: number }
);

function allowedPage(page: Page): string {
  const url = new URL(page.url());
  if (
    !origins.has(url.origin) ||
    (url.hostname === "messages.google.com" &&
      !/^\/web\/(?:u\/\d+\/)?(?:welcome|authentication|pair)\/?$/.test(
        url.pathname,
      ))
  ) {
    throw new ApiError(
      409,
      "LOGIN_PAGE_UNAVAILABLE",
      "Only Google's sign-in and device-pairing screens can be viewed or controlled.",
    );
  }
  return url.origin;
}

function parseInput(body: unknown, page: Page): Input {
  const invalid = () =>
    new ApiError(
      400,
      "INVALID_REQUEST",
      "Expected a bounded login input and its current screen version.",
    );
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const fields = body as Record<string, unknown>;
  if (
    typeof fields.version !== "number" ||
    !Number.isSafeInteger(fields.version) ||
    fields.version < 0
  )
    throw invalid();
  const viewport = page.viewportSize();
  let accepted: string[];
  switch (fields.type) {
    case "click":
      accepted = ["x", "y"];
      if (
        !viewport ||
        typeof fields.x !== "number" ||
        typeof fields.y !== "number" ||
        !Number.isFinite(fields.x) ||
        !Number.isFinite(fields.y) ||
        fields.x < 0 ||
        fields.x >= viewport.width ||
        fields.y < 0 ||
        fields.y >= viewport.height
      )
        throw invalid();
      break;
    case "text":
      accepted = ["text"];
      if (
        typeof fields.text !== "string" ||
        !fields.text.length ||
        fields.text.length > 4096
      )
        throw invalid();
      break;
    case "key":
      accepted = ["key"];
      if (typeof fields.key !== "string" || !keys.has(fields.key))
        throw invalid();
      break;
    case "scroll":
      accepted = ["deltaY"];
      if (
        typeof fields.deltaY !== "number" ||
        !Number.isFinite(fields.deltaY) ||
        Math.abs(fields.deltaY) > 800
      )
        throw invalid();
      break;
    default:
      throw invalid();
  }
  if (
    Object.keys(fields).some(
      (key) => !["type", "version", ...accepted].includes(key),
    )
  )
    throw invalid();
  return fields as Input;
}

export class WebLogin {
  private lease: { token: string; expiresAt: number } | undefined;
  private version = 0;
  private readonly ready: Promise<Disposable>;
  private readonly shield: LoginInputShield;

  constructor(readonly client: MessagesPage) {
    const page = client.page;
    this.shield = new LoginInputShield(page);
    page.on("framenavigated", () => {
      this.version++;
    });
    page.on("popup", (popup) => {
      void popup.close().catch(() => undefined);
    });
    this.ready = page.context().route("**/*", async (route) => {
      const request = route.request();
      if (
        request.isNavigationRequest() &&
        !request.frame().parentFrame() &&
        (request.frame().page() !== page ||
          !origins.has(new URL(request.url()).origin))
      ) {
        await route.abort();
      } else {
        await route.fallback();
      }
    });
  }

  private check(token: string) {
    if (
      !this.lease ||
      Date.now() >= this.lease.expiresAt ||
      !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(this.lease.token))
    ) {
      throw new ApiError(
        401,
        "LOGIN_EXPIRED",
        "Login view expired or was closed. Open a new login view to continue.",
      );
    }
  }

  private run<T>(
    token: string,
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    return this.client
      .duringPairing(async (page) => {
        this.check(token);
        allowedPage(page);
        const result = await operation(page);
        this.check(token);
        allowedPage(page);
        return result;
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.code === "ALREADY_PAIRED")
          this.lease = undefined;
        throw error;
      });
  }

  async start(): Promise<{ token: string; expiresAt: number }> {
    await this.ready;
    return this.client.duringPairing(async (page) => {
      try {
        allowedPage(page);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== "LOGIN_PAGE_UNAVAILABLE"
        )
          throw error;
        // A blocked external link may leave Chrome on an error page. Reopen only this fixed URL.
        await page.goto("https://messages.google.com/web/welcome", {
          waitUntil: "domcontentloaded",
        });
      }
      await this.shield.prepare();
      const url = new URL(page.url());
      if (
        url.hostname === "messages.google.com" &&
        /\/(?:welcome|authentication)\/?$/.test(url.pathname)
      ) {
        const signIn = page.getByRole("button", {
          name: "Sign In",
          exact: true,
        });
        await signIn.waitFor({ state: "visible" });
        await this.shield.run(
          () => {
            allowedPage(page);
          },
          () => signIn.click(),
        );
      }
      this.lease = {
        token: randomBytes(32).toString("hex"),
        expiresAt: Date.now() + 15 * 60_000,
      };
      return { ...this.lease };
    });
  }

  frame(
    token: string,
  ): Promise<{ image: Buffer; origin: string; version: number }> {
    return this.run(token, async (page) => {
      const version = this.version;
      const origin = allowedPage(page);
      const image = await page.screenshot({
        type: "png",
        scale: "css",
        animations: "disabled",
      });
      if (version !== this.version)
        throw new ApiError(
          409,
          "LOGIN_SCREEN_CHANGED",
          "The login screen changed. Wait for the next frame.",
        );
      return { image, origin, version };
    });
  }

  input(token: string, body: unknown): Promise<void> {
    return this.run(token, async (page) => {
      const input = parseInput(body, page);
      if (input.version !== this.version)
        throw new ApiError(
          409,
          "LOGIN_SCREEN_CHANGED",
          "The login screen changed. Input was not sent; wait for the next frame.",
        );
      await this.shield.run(
        () => {
          this.check(token);
          allowedPage(page);
          if (input.version !== this.version)
            throw new ApiError(
              409,
              "LOGIN_SCREEN_CHANGED",
              "The login screen changed. Input was not sent; wait for the next frame.",
            );
        },
        async () => {
          switch (input.type) {
            case "click":
              await page.mouse.click(input.x, input.y);
              break;
            case "text":
              await page.keyboard.insertText(input.text);
              break;
            case "key":
              await page.keyboard.press(input.key);
              break;
            case "scroll":
              await page.mouse.wheel(0, input.deltaY);
              break;
          }
        },
      );
    });
  }

  stop(token: string): void {
    this.check(token);
    this.lease = undefined;
  }
}

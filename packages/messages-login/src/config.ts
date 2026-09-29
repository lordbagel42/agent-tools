export const MESSAGES_CONFIG_URL = "https://messages.google.com/web/config";
export const GOOGLE_LOGIN_URL =
  "https://accounts.google.com/AccountChooser?continue=https://messages.google.com/web/config";

const BARE_HTTPS_ORIGIN = /^https:\/\/[^/?#]+\/?$/;

export function parseLaunchArguments(
  argv: readonly string[],
  isPackaged: boolean,
): string {
  const argumentsAfterApp = argv.slice(isPackaged ? 1 : 2);
  if (argumentsAfterApp.length !== 1) {
    throw new Error("The helper requires exactly one server origin argument.");
  }
  return parseServerOrigin(argumentsAfterApp[0]);
}

export function parseServerOrigin(input: string | undefined): string {
  if (!input || input !== input.trim()) {
    throw new Error("Provide the server as an HTTPS origin.");
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Provide the server as an HTTPS origin.");
  }

  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error("Provide the server as an HTTPS origin.");
  }
  if (
    !BARE_HTTPS_ORIGIN.test(input) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Provide a bare HTTPS origin with no path, query, fragment, or userinfo.",
    );
  }

  return parsed.origin;
}

export function isMessagesConfigUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return (
      parsed.origin === "https://messages.google.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/web/config" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

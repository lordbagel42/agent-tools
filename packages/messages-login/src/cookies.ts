export const REQUIRED_GOOGLE_COOKIE_NAMES = [
  "SID",
  "HSID",
  "SSID",
  "OSID",
  "APISID",
  "SAPISID",
] as const;

export const OPTIONAL_GOOGLE_COOKIE_NAME = "__Secure-1PSIDTS" as const;

type RequiredGoogleCookieName = (typeof REQUIRED_GOOGLE_COOKIE_NAMES)[number];
type OptionalGoogleCookieName = typeof OPTIONAL_GOOGLE_COOKIE_NAME;

export type GoogleCredentials = Record<RequiredGoogleCookieName, string> &
  Partial<Record<OptionalGoogleCookieName, string>>;

export interface GoogleCookieLike {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
}

const CONFIG_PATH = "/web/config";
const GOOGLE_PARENT_DOMAIN = "google.com";
const MESSAGES_DOMAIN = "messages.google.com";

function normalizedDomain(domain: string): string {
  return domain.replace(/^\.+/, "").toLowerCase();
}

function appliesToConfigPath(cookiePath = "/"): boolean {
  if (!CONFIG_PATH.startsWith(cookiePath)) {
    return false;
  }
  return (
    cookiePath.endsWith("/") ||
    CONFIG_PATH.length === cookiePath.length ||
    CONFIG_PATH[cookiePath.length] === "/"
  );
}

function selectOne(
  cookies: readonly GoogleCookieLike[],
  name: RequiredGoogleCookieName | OptionalGoogleCookieName,
  allowedDomains: ReadonlySet<string>,
  required: boolean,
): string | undefined {
  const values = new Set(
    cookies
      .filter(
        (cookie) =>
          cookie.name === name &&
          cookie.domain !== undefined &&
          allowedDomains.has(normalizedDomain(cookie.domain)) &&
          appliesToConfigPath(cookie.path),
      )
      .map(({ value }) => value)
      .filter((value) => value.length > 0),
  );

  if (values.size > 1) {
    throw new Error(
      `Conflicting Google cookie ${name}; refusing to merge sessions.`,
    );
  }
  const value = values.values().next().value as string | undefined;
  if (required && value === undefined) {
    throw new Error(`Missing required Google cookie ${name}.`);
  }
  return value;
}

export function selectGoogleCredentials(
  cookies: readonly GoogleCookieLike[],
): GoogleCredentials {
  const parentDomain = new Set([GOOGLE_PARENT_DOMAIN]);
  const osidDomains = new Set([MESSAGES_DOMAIN, GOOGLE_PARENT_DOMAIN]);

  const credentials: GoogleCredentials = {
    SID: selectOne(cookies, "SID", parentDomain, true) as string,
    HSID: selectOne(cookies, "HSID", parentDomain, true) as string,
    SSID: selectOne(cookies, "SSID", parentDomain, true) as string,
    OSID: selectOne(cookies, "OSID", osidDomains, true) as string,
    APISID: selectOne(cookies, "APISID", parentDomain, true) as string,
    SAPISID: selectOne(cookies, "SAPISID", parentDomain, true) as string,
  };

  const timestamp = selectOne(
    cookies,
    OPTIONAL_GOOGLE_COOKIE_NAME,
    parentDomain,
    false,
  );
  if (timestamp !== undefined) {
    credentials[OPTIONAL_GOOGLE_COOKIE_NAME] = timestamp;
  }

  return credentials;
}

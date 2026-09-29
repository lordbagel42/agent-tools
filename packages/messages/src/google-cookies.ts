import { ApiError } from "./types.js";

const requiredCookieNames = [
  "SID",
  "HSID",
  "SSID",
  "OSID",
  "APISID",
  "SAPISID",
] as const;
const optionalCookieName = "__Secure-1PSIDTS";
const allowedCookieNames = new Set<string>([
  ...requiredCookieNames,
  optionalCookieName,
]);

function hasUnsafeCookieCharacter(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === ";" || code <= 0x1f || (code >= 0x7f && code <= 0x9f))
      return true;
  }
  return false;
}

function invalidCookies() {
  return new ApiError(
    400,
    "INVALID_REQUEST",
    "Expected the required Google session cookies.",
  );
}

export function validateGoogleCookies(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw invalidCookies();

  let keys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype)
      throw invalidCookies();
    keys = Reflect.ownKeys(input);
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw invalidCookies();
  }

  if (
    keys.some(
      (key) => typeof key !== "string" || !allowedCookieNames.has(key),
    ) ||
    requiredCookieNames.some((name) => !keys.includes(name))
  )
    throw invalidCookies();

  const result: Record<string, string> = {};
  for (const name of [...requiredCookieNames, optionalCookieName]) {
    const descriptor = descriptors[name];
    if (!descriptor) continue;
    const value = descriptor.value;
    if (
      !descriptor.enumerable ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4096 ||
      hasUnsafeCookieCharacter(value)
    )
      throw invalidCookies();
    result[name] = value;
  }
  return result;
}

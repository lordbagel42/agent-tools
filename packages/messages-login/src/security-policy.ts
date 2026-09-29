export interface ConsentCopy {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

export function buildConsentCopy(serverOrigin: string): ConsentCopy {
  return {
    title: "Transfer broad Google session credentials?",
    message: `Send broad Google Account session credentials to ${serverOrigin}?`,
    detail: `These credentials are not a Messages-only token. They will be stored server-side by ${serverOrigin} so the server can run independently after this helper closes. Transfer them only if you trust that server and its administrators.`,
  };
}

export function ephemeralPartition(
  role: "google" | "portal",
  uniqueId: string,
): string {
  if (!/^[a-zA-Z0-9-]+$/.test(uniqueId)) {
    throw new TypeError("The ephemeral partition ID is invalid.");
  }
  return `messages-login-helper-${role}-${uniqueId}`;
}

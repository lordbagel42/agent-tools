import { ApiError, type SendRequest } from "./types.js";

const invalid = (message: string) =>
  new ApiError(400, "INVALID_REQUEST", message);

export function parseConversationId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(value) ||
    value === "new"
  ) {
    throw invalid(
      "Use an existing conversation ID returned by /v1/conversations.",
    );
  }
  return value;
}

export function parseLimit(value: unknown = 50): number {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 200
  ) {
    throw invalid("limit must be an integer from 1 to 200.");
  }
  return value;
}

export function parseSendRequest(value: unknown): SendRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid("Expected a JSON object with conversationId and text.");
  }
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).some(
      (key) => key !== "conversationId" && key !== "text",
    )
  ) {
    throw invalid("Only conversationId and text are accepted.");
  }
  const conversationId = parseConversationId(fields.conversationId);
  if (
    typeof fields.text !== "string" ||
    !fields.text.trim() ||
    fields.text.length > 10_000
  ) {
    throw invalid("text must be nonblank and at most 10000 UTF-16 code units.");
  }
  return { conversationId, text: fields.text };
}

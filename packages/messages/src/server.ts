import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { SendLedger } from "./send-ledger.js";
import { ApiError, type MessagesClient } from "./types.js";
import {
  parseConversationId,
  parseLimit,
  parseSendRequest,
} from "./validation.js";

export function localServer(publicUrl?: string, allowSameOrigin = false) {
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const hosts = new Set(loopbackHosts);
  const publicOrigin = publicUrl ? new URL(publicUrl).origin : undefined;
  if (publicUrl) hosts.add(new URL(publicUrl).hostname);
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    const origin = request.headers.origin;
    const localOrigin = loopbackHosts.has(request.hostname)
      ? `${request.protocol}://${request.headers.host}`
      : undefined;
    const sameOrigin =
      allowSameOrigin &&
      origin &&
      (origin === publicOrigin || origin === localOrigin);
    if (
      !hosts.has(request.hostname) ||
      (origin && !sameOrigin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      throw new ApiError(
        403,
        "FORBIDDEN",
        "Cross-origin requests and unrecognized hosts are not allowed.",
      );
    }
  });
  app.setNotFoundHandler((_request, reply) =>
    reply
      .code(404)
      .send({ error: { code: "NOT_FOUND", message: "Route not found." } }),
  );
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: {
          code: "INVALID_REQUEST",
          message:
            "The request could not be parsed or exceeds the allowed size.",
        },
      });
    }
    // Playwright/parser errors can contain text, cookies, URLs, and filesystem paths.
    return reply.code(503).send({
      error: {
        code: "UNAVAILABLE",
        message:
          "The operation failed. Check the browser and phone connection.",
      },
    });
  });
  return app;
}

export function buildApi({
  client,
  ledger,
  token,
}: {
  client: MessagesClient;
  ledger: SendLedger;
  token: string;
}) {
  if (token.length < 32)
    throw new Error("The API token must have at least 32 characters.");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${token}`);
  const app = localServer();
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url === "/health") return;
    if (
      !timingSafeEqual(digest(request.headers.authorization ?? ""), expected)
    ) {
      reply.header("www-authenticate", "Bearer");
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "A valid bearer token is required.",
      );
    }
  });
  app.get("/health", async () => ({ ok: true }));
  app.get("/v1/status", () => client.status());
  app.get("/v1/pairing/qr", async (_request, reply) => {
    const qr = await client.pairingQr();
    if (!qr)
      throw new ApiError(
        409,
        "QR_UNAVAILABLE",
        "No QR code is available. Check /v1/status or use headed account pairing.",
      );
    return reply.type("image/png").send(qr);
  });
  app.get<{ Querystring: { limit?: unknown } }>(
    "/v1/conversations",
    (request) => client.listConversations(parseLimit(request.query.limit)),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: unknown } }>(
    "/v1/conversations/:id/messages",
    (request) =>
      client.readMessages(
        parseConversationId(request.params.id),
        parseLimit(request.query.limit),
      ),
  );
  app.post("/v1/messages", async (request, reply) => {
    const body = parseSendRequest(request.body);
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "Idempotency-Key must contain 8–128 letters, digits, dots, underscores, colons or hyphens.",
      );
    }
    const receipt = await ledger.execute(key, body, () =>
      client.sendText(body),
    );
    return reply.code(202).send(receipt);
  });
  return app;
}

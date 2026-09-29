import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweep } from "../src/index";

const origin = "https://uploads.example.com";
const authorization = "Bearer fixture-management-key-not-for-production-12345";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.reject(new Error("External network forbidden in tests")),
    ),
  );
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await reset();
  // Alarm tests can retain R2 state across the plugin's reset boundary.
  const remaining = await env.FILES.list();
  if (remaining.objects.length)
    await env.FILES.delete(remaining.objects.map((object) => object.key));
});

async function create(input = {}) {
  const response = await exports.default.fetch(`${origin}/api/uploads`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status).toBe(201);
  return response.json<{
    id: string;
    uploadUrl: string;
    retentionSeconds: number;
    linkExpiresAt: number;
    webhookSigningSecret?: string;
    webhookNotice: string;
  }>();
}

function put(link: string, body: string, filename = "sample.txt") {
  const url = new URL(link);
  return exports.default.fetch(
    `${origin}/api/uploads/${url.pathname.split("/").pop()}/content`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${url.hash.slice(1)}`,
        "content-length": String(new TextEncoder().encode(body).length),
        "x-upload-filename": encodeURIComponent(filename),
      },
      body,
    },
  );
}

describe("private single-use uploads", () => {
  it("requires management authentication to mint an upload link", async () => {
    const response = await exports.default.fetch(`${origin}/api/uploads`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("defaults to 24 hours and keeps upload credentials out of the request URL", async () => {
    const before = Date.now();
    const result = await create();
    expect(result.retentionSeconds).toBe(86400);
    expect(result.linkExpiresAt).toBeGreaterThanOrEqual(before + 86400000);
    expect(result.linkExpiresAt).toBeLessThanOrEqual(Date.now() + 86400000);
    expect(new URL(result.uploadUrl).hash).toMatch(/^#[a-f0-9]{64}$/);
    expect(new URL(result.uploadUrl).search).toBe("");
  });

  it("accepts only one concurrent file and never allows the upload token to read it", async () => {
    const result = await create();
    const [a, b] = await Promise.all([
      put(result.uploadUrl, "alpha payload"),
      put(result.uploadUrl, "different beta payload"),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const download = `${origin}/api/uploads/${result.id}/content`;
    const read = await exports.default.fetch(download, {
      headers: { authorization },
    });
    expect(read.status).toBe(200);
    expect(new TextDecoder().decode(await read.arrayBuffer())).toBe(
      a.status === 201 ? "alpha payload" : "different beta payload",
    );
    expect(read.headers.get("content-disposition")).toContain("attachment;");
    expect(read.headers.get("cache-control")).toBe("no-store");
    const denied = await exports.default.fetch(download, {
      headers: {
        authorization: `Bearer ${new URL(result.uploadUrl).hash.slice(1)}`,
      },
    });
    expect(denied.status).toBe(401);
    expect((await put(result.uploadUrl, "replacement")).status).toBe(409);
  });

  it("issues short-lived file-scoped downloads without revealing the management credential", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2100-09-28T10:00:00Z"));
    const first = await create();
    const second = await create();
    expect((await put(first.uploadUrl, "first private file")).status).toBe(201);
    expect((await put(second.uploadUrl, "second private file")).status).toBe(
      201,
    );
    const status = await env.UPLOADS.getByName(first.id).status();
    const link = status?.downloadUrl ?? "";
    expect(link).not.toContain(authorization.slice(7));
    const download = await exports.default.fetch(link);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("first private file");
    expect(
      (await exports.default.fetch(link.replace(first.id, second.id))).status,
    ).toBe(401);
    const modified = new URL(link);
    modified.searchParams.set("expires", String(Date.now() + 600000));
    expect((await exports.default.fetch(modified)).status).toBe(401);
    vi.setSystemTime(new Date("2100-09-28T10:04:59.999Z"));
    const valid = await exports.default.fetch(link);
    expect(valid.status).toBe(200);
    await valid.arrayBuffer();
    vi.setSystemTime(new Date("2100-09-28T10:05:00Z"));
    expect((await exports.default.fetch(link)).status).toBe(401);
    const renewed =
      (await env.UPLOADS.getByName(first.id).status())?.downloadUrl ?? "";
    await env.UPLOADS.getByName(first.id).remove();
    expect((await exports.default.fetch(renewed)).status).toBe(410);
  });

  it("deletes file bytes and credentials on early removal, even after instance eviction", async () => {
    const result = await create();
    expect((await put(result.uploadUrl, "private bytes")).status).toBe(201);
    await abortAllDurableObjects();
    expect((await put(result.uploadUrl, "replay")).status).toBe(409);
    const removed = await exports.default.fetch(
      `${origin}/api/uploads/${result.id}`,
      { method: "DELETE", headers: { authorization } },
    );
    expect(removed.status).toBe(200);
    expect((await env.FILES.list({ prefix: "uploads/" })).objects).toHaveLength(
      0,
    );
    expect(
      (
        await exports.default.fetch(
          `${origin}/api/uploads/${result.id}/content`,
          { headers: { authorization } },
        )
      ).status,
    ).toBe(410);
    expect((await put(result.uploadUrl, "late bytes")).status).toBe(404);
  });

  it("starts custom retention at completion and denies the exact expiry boundary before cleanup runs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2100-09-28T10:00:00Z"));
    const result = await create({ retentionSeconds: 90 });
    vi.setSystemTime(new Date("2100-09-28T10:07:00Z"));
    const uploaded = await put(result.uploadUrl, "expires soon");
    expect(uploaded.status).toBe(201);
    expect((await uploaded.json<{ expiresAt: number }>()).expiresAt).toBe(
      Date.parse("2100-09-28T10:08:30Z"),
    );
    const download = `${origin}/api/uploads/${result.id}/content`;
    vi.setSystemTime(new Date("2100-09-28T10:08:29.999Z"));
    const valid = await exports.default.fetch(download, {
      headers: { authorization },
    });
    expect(valid.status).toBe(200);
    await valid.arrayBuffer();
    vi.setSystemTime(new Date("2100-09-28T10:08:30Z"));
    expect(
      (await exports.default.fetch(download, { headers: { authorization } }))
        .status,
    ).toBe(410);
    await runDurableObjectAlarm(env.UPLOADS.getByName(result.id));
    expect((await env.FILES.list({ prefix: "uploads/" })).objects).toHaveLength(
      0,
    );
  });

  it("expires unused links and reconciles orphaned bytes without deleting live files", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2100-09-28T10:00:00Z"));
    const unused = await create({ linkTtlSeconds: 60 });
    const live = await create();
    expect((await put(live.uploadUrl, "keep me")).status).toBe(201);
    const orphanKey = `uploads/${crypto.randomUUID()}/orphan`;
    await env.FILES.put(orphanKey, "discard me");
    vi.setSystemTime(new Date("2100-09-28T10:01:00Z"));
    expect((await put(unused.uploadUrl, "too late")).status).toBe(410);
    await sweep(env);
    expect(await env.FILES.head(orphanKey)).toBeNull();
    expect((await env.FILES.list({ prefix: "uploads/" })).objects).toHaveLength(
      1,
    );
  });

  it("rejects oversized uploads without consuming the link and treats filenames only as metadata", async () => {
    const result = await create({ maxBytes: 4 });
    expect((await put(result.uploadUrl, "12345")).status).toBe(413);
    expect(
      (await put(result.uploadUrl, "1234", "../../report\r\n.txt")).status,
    ).toBe(201);
    const status = await exports.default.fetch(
      `${origin}/api/uploads/${result.id}`,
      { headers: { authorization } },
    );
    expect((await status.json<{ filename: string }>()).filename).toBe(
      "report.txt",
    );
    const files = await env.FILES.list({ prefix: "uploads/" });
    expect(files.objects[0].key).not.toContain("report");
  });

  it.each([2, 7])(
    "rejects a streamed length mismatch of %s bytes and permits retry",
    async (length) => {
      const result = await create();
      const response = await env.UPLOADS.getByName(result.id).fetch(
        new Request(`${origin}/api/uploads/${result.id}/content`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${new URL(result.uploadUrl).hash.slice(1)}`,
            "content-length": String(length),
          },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("four"));
              controller.close();
            },
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(
        (await env.FILES.list({ prefix: "uploads/" })).objects,
      ).toHaveLength(0);
      expect((await put(result.uploadUrl, "retry")).status).toBe(201);
    },
  );

  it("does not resurrect a file deleted while its upload is still streaming", async () => {
    const result = await create();
    const stub = env.UPLOADS.getByName(result.id);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const pending = stub.fetch(
      new Request(`${origin}/api/uploads/${result.id}/content`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${new URL(result.uploadUrl).hash.slice(1)}`,
          "content-length": "4",
        },
        body: new ReadableStream({
          start(value) {
            controller = value;
          },
        }),
      }),
    );
    try {
      await vi.waitFor(async () =>
        expect((await stub.status())?.state).toBe("uploading"),
      );
      await stub.remove();
    } finally {
      controller.enqueue(new TextEncoder().encode("late"));
      controller.close();
    }
    expect((await pending).status).toBe(410);
    expect(await stub.status()).toBeNull();
    expect((await env.FILES.list({ prefix: "uploads/" })).objects).toHaveLength(
      0,
    );
  });

  it("does not restore metadata or retry after deletion during webhook delivery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2100-09-28T10:00:00Z"));
    const result = await create({
      webhookUrl: "https://hooks.example.com/uploaded",
    });
    const stub = env.UPLOADS.getByName(result.id);
    let callbackError: unknown;
    const callback = vi.fn(async () => {
      try {
        // Acquire the stub in the callback's I/O context, not the test's context.
        await env.UPLOADS.getByName(result.id).remove();
      } catch (error) {
        callbackError = error;
        throw error;
      }
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", callback);
    expect((await put(result.uploadUrl, "private")).status).toBe(201);
    vi.setSystemTime(new Date("2100-09-28T10:00:01Z"));
    await runDurableObjectAlarm(stub);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callbackError).toBeUndefined();
    expect(await stub.status()).toBeNull();
    expect((await env.FILES.list({ prefix: "uploads/" })).objects).toHaveLength(
      0,
    );
    await runDurableObjectAlarm(stub);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("stops webhook retries at eight attempts or file expiry, whichever comes first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2100-09-28T10:00:00Z"));
    const callback = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", callback);
    const result = await create({
      webhookUrl: "https://hooks.example.com/uploaded",
    });
    const stub = env.UPLOADS.getByName(result.id);
    expect((await put(result.uploadUrl, "private")).status).toBe(201);
    for (let attempt = 0; attempt < 9; attempt++) {
      vi.setSystemTime(Date.now() + 3600000);
      await runDurableObjectAlarm(stub);
    }
    expect(callback).toHaveBeenCalledTimes(8);
    expect((await stub.status())?.webhook).toMatchObject({
      state: "failed",
      attempts: 8,
    });
    const short = await create({
      webhookUrl: "https://hooks.example.com/uploaded",
      retentionSeconds: 60,
    });
    expect((await put(short.uploadUrl, "expires")).status).toBe(201);
    vi.setSystemTime(Date.now() + 60000);
    await runDurableObjectAlarm(env.UPLOADS.getByName(short.id));
    expect(callback).toHaveBeenCalledTimes(8);
    expect(await env.UPLOADS.getByName(short.id).status()).toBeNull();
  });

  it("delivers a signed durable webhook after upload and retries with the same event ID", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2100-09-28T10:00:00Z"));
    const deliveries: { body: string; headers: Headers; redirect: string }[] =
      [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("https://hooks.example.com/uploaded");
      deliveries.push({
        body: String(init.body),
        headers: new Headers(init.headers),
        redirect: init.redirect ?? "follow",
      });
      return new Response(null, {
        status: deliveries.length === 1 ? 302 : 204,
        headers: { location: "https://forbidden.example.net/receiver" },
      });
    });
    const result = await create({
      webhookUrl: "https://hooks.example.com/uploaded",
    });
    expect(result.webhookNotice).toMatch(/will call.*when.*uploaded/i);
    let stub = env.UPLOADS.getByName(result.id);
    await runDurableObjectAlarm(stub);
    expect(deliveries).toHaveLength(0);
    expect(
      (await put(result.uploadUrl, "not included in event", "receipt.txt"))
        .status,
    ).toBe(201);
    await abortAllDurableObjects();
    stub = env.UPLOADS.getByName(result.id);
    vi.setSystemTime(new Date("2100-09-28T10:00:01Z"));
    await runDurableObjectAlarm(stub);
    expect(deliveries).toHaveLength(1);
    const first = deliveries[0];
    expect(first.redirect).toBe("manual");
    expect((await stub.status())?.webhook).toMatchObject({
      state: "pending",
      attempts: 1,
      lastStatus: 302,
    });
    expect(first.headers.has("authorization")).toBe(false);
    const eventId = first.headers.get("x-upload-event-id");
    const timestamp = first.headers.get("x-upload-timestamp");
    const expected = createHmac("sha256", result.webhookSigningSecret ?? "")
      .update(`${eventId}.${timestamp}.${first.body}`)
      .digest("hex");
    expect(first.headers.get("x-upload-signature")).toBe(`sha256=${expected}`);
    expect(JSON.parse(first.body)).toMatchObject({
      type: "file.uploaded",
      uploadId: result.id,
      filename: "receipt.txt",
      size: 21,
    });
    expect(first.body).not.toContain("not included in event");
    expect(first.body).not.toContain(new URL(result.uploadUrl).hash.slice(1));
    vi.setSystemTime(new Date("2100-09-28T10:01:01Z"));
    await runDurableObjectAlarm(stub);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1].body).toBe(first.body);
    expect(deliveries[1].headers.get("x-upload-event-id")).toBe(eventId);
    await runDurableObjectAlarm(stub);
    expect(deliveries).toHaveLength(2);
    const status = await stub.status();
    expect(status?.webhook).toMatchObject({ state: "delivered", attempts: 2 });
    expect(JSON.stringify(status)).not.toContain(result.webhookSigningSecret);
  });

  it.each([
    "http://hooks.example.com/uploaded",
    "https://hooks.example.com.evil.test/uploaded",
    "https://user:secret@hooks.example.com/uploaded",
    "https://127.0.0.1/uploaded",
    "https://hooks.example.com/uploaded#secret",
  ])(
    "refuses unapproved or ambiguous webhook destination %s",
    async (webhookUrl) => {
      const response = await exports.default.fetch(`${origin}/api/uploads`, {
        method: "POST",
        headers: { authorization },
        body: JSON.stringify({ webhookUrl }),
      });
      expect(response.status).toBe(400);
      expect(
        (await env.FILES.list({ prefix: "uploads/" })).objects,
      ).toHaveLength(0);
    },
  );

  it("exposes authenticated MCP tools with the webhook and retention contract", async () => {
    const response = await exports.default.fetch(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = text.startsWith("event:")
      ? JSON.parse(text.split("data: ")[1].split("\n")[0])
      : JSON.parse(text);
    const tools = payload.result.tools as {
      name: string;
      description: string;
      inputSchema: { properties: Record<string, { default?: number }> };
    }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_upload",
      "delete_upload",
      "get_upload",
    ]);
    const createTool = tools.find((tool) => tool.name === "create_upload");
    expect(createTool?.description).toMatch(
      /webhook.*will call.*when.*uploaded/i,
    );
    expect(createTool?.inputSchema.properties.retentionSeconds.default).toBe(
      86400,
    );
  });

  it("creates, retrieves and deletes files through MCP calls", async () => {
    async function call(name: string, args: Record<string, unknown>) {
      const response = await exports.default.fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const payload = text.startsWith("event:")
        ? JSON.parse(text.split("data: ")[1].split("\n")[0])
        : JSON.parse(text);
      expect(payload.error).toBeUndefined();
      expect(payload.result.isError).not.toBe(true);
      return payload.result.structuredContent;
    }
    const created = await call("create_upload", {
      retentionSeconds: 120,
      maxBytes: 123,
    });
    expect(created.retentionSeconds).toBe(120);
    expect(created.maxBytes).toBe(123);
    expect((await put(created.uploadUrl, "MCP bytes")).status).toBe(201);
    const { upload } = await call("get_upload", { id: created.id });
    expect(upload.state).toBe("uploaded");
    const downloaded = await exports.default.fetch(upload.downloadUrl);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("MCP bytes");
    expect(await call("delete_upload", { id: created.id })).toEqual({
      deleted: true,
    });
    expect(await call("get_upload", { id: created.id })).toEqual({
      upload: null,
    });
  });

  it("rejects foreign hosts, cross-origin requests and oversized control messages", async () => {
    expect(
      (await exports.default.fetch("https://wrong.example.com/healthz")).status,
    ).toBe(421);
    expect(
      (
        await exports.default.fetch(`${origin}/api/uploads`, {
          method: "POST",
          headers: { authorization, origin: "https://evil.example.com" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await exports.default.fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { authorization },
          body: " ".repeat(16385),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await exports.default.fetch(`${origin}/mcp`, {
          method: "POST",
          body: "{}",
        })
      ).status,
    ).toBe(401);
  });

  it("serves the upload form without exposing management data or permitting third-party scripts", async () => {
    const result = await create();
    const page = await exports.default.fetch(result.uploadUrl.split("#")[0]);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain('type="file"');
    expect(html).not.toContain(new URL(result.uploadUrl).hash.slice(1));
  });
});

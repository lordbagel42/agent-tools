import {
  abortAllDurableObjects,
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index";

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("No live network"))),
  ),
);
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await reset();
});

async function call(name: string, args: object = {}, who = "alice") {
  const r = await exports.default.fetch("https://mail-api.example.com/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer fixture-${who}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(r.status).toBe(200);
  const text = await r.text();
  const data = text.startsWith("event:")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  if (!data) throw new Error("Missing MCP response");
  expect(JSON.parse(data), text).toHaveProperty("result");
  return JSON.parse(data) as {
    result: {
      structuredContent: {
        id: string;
        secret: string;
        name: string;
        address: string;
        enabled: boolean;
        inboxes: string[];
        text: string;
        recipient: string;
        rawOnly: boolean;
        forwarding: string | null;
        nextBefore: number | null;
        messages: { id: string; seq: number }[];
        webhooks: {
          id: string;
          pending: number;
          failed: number;
          delivered: number;
          secret?: string;
        }[];
      };
      isError?: boolean;
    };
  };
}
async function receive(to: string, text = "hello") {
  const raw = `From: sender@example.net\r\nTo: spoofed@example.net\r\nSubject: fixture\r\nContent-Type: text/plain\r\n\r\n${text}`;
  const rejected: string[] = [];
  const forwarded: string[] = [];
  const body = new Response(raw).body;
  if (!body) throw new Error("Missing fixture body");
  await worker.email(
    {
      to,
      from: "sender@example.net",
      raw: body,
      rawSize: raw.length,
      headers: new Headers({ subject: "fixture" }),
      setReject(reason: string) {
        rejected.push(reason);
      },
      async forward(address: string) {
        forwarded.push(address);
        return { messageId: "fixture" };
      },
      async reply() {
        return { messageId: "fixture" };
      },
    },
    env,
  );
  return { rejected, forwarded };
}

it("requires authentication before exposing MCP", async () => {
  const r = await exports.default.fetch("https://mail-api.example.com/mcp", {
    method: "POST",
    body: "{}",
  });
  expect(r.status).toBe(401);
});

it("creates persistent arbitrary inboxes without allowing another client to claim them", async () => {
  const alias = (await call("create_inbox", { name: "instagram" })).result
    .structuredContent;
  expect(alias.address).toBe("instagram@example.com");
  expect(
    (await call("create_inbox", { name: "INSTAGRAM" })).result.structuredContent
      .address,
  ).toBe(alias.address);
  expect(
    (await call("create_inbox", { name: "instagram" }, "bob")).result.isError,
  ).toBe(true);
  await receive("instagram@example.com", "login code");
  await abortAllDurableObjects();
  expect(
    (await call("list_inboxes")).result.structuredContent.inboxes,
  ).toContain("instagram");
  expect(
    (await call("list_mail", { inbox: "instagram" })).result.structuredContent
      .messages,
  ).toHaveLength(1);
  expect(
    (await call("list_mail", { inbox: "instagram" }, "bob")).result.isError,
  ).toBe(true);
  const generated = (await call("create_inbox")).result.structuredContent;
  expect(generated.name).toMatch(/^mail-[a-f0-9-]+$/);
  expect((await call("create_inbox", { name: "inbox" })).result.isError).toBe(
    true,
  );
  expect(
    (await call("create_inbox", { name: "read-only" }, "reader")).result
      .isError,
  ).toBe(true);
});

it("forwards only agent-selected mail and never resends a completed selection", async () => {
  await receive("inbox@example.com", "shared default");
  expect(
    (await call("list_mail", {}, "bob")).result.structuredContent.messages,
  ).toHaveLength(1);
  await call("create_inbox", { name: "hca-test-828384" });
  expect(
    (await receive("hca-test-828384@example.com", "selected")).forwarded,
  ).toEqual([]);
  expect(
    (await receive("hca-test-828384@example.com", "not selected")).forwarded,
  ).toEqual([]);
  const messages = (await call("list_mail", { inbox: "hca-test-828384" }))
    .result.structuredContent.messages;
  const id = messages[1].id;
  const sent: EmailMessageBuilder[] = [];
  await runInDurableObject(
    env.INBOXES.getByName("hca-test-828384@example.com"),
    (instance) => {
      Object.defineProperty(instance, "env", {
        value: {
          ...env,
          MAILER: {
            send: async (message: EmailMessageBuilder) => {
              sent.push(message);
              return { messageId: "fixture" };
            },
          },
        },
      });
    },
  );
  expect(
    (await call("forward_mail", { inbox: "hca-test-828384", id }, "bob")).result
      .isError,
  ).toBe(true);
  expect(
    (await call("forward_mail", { inbox: "hca-test-828384", id })).result
      .structuredContent.forwarding,
  ).toBe("forwarded");
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toBe("owner@example.net");
  expect(
    new TextDecoder().decode(sent[0].attachments?.[0].content as Uint8Array),
  ).toContain("\r\n\r\nselected");
  await abortAllDurableObjects();
  expect(
    (await call("forward_mail", { inbox: "hca-test-828384", id })).result
      .structuredContent.forwarding,
  ).toBe("forwarded");
  expect(
    (await call("list_mail", { inbox: "hca-test-828384" })).result
      .structuredContent.messages,
  ).toHaveLength(2);
  expect((await receive("hca-test-828384@example.com")).forwarded).toEqual([]);
});

it("stores envelope-addressed mail durably and isolates aliases while sharing main", async () => {
  await receive("mcp@example.com", "shared");
  await receive("MCP-ALPHA@example.com", "private alpha");
  await abortAllDurableObjects();
  const main = await call("list_mail", { inbox: "mcp" }, "bob");
  expect(main.result.structuredContent.messages).toHaveLength(1);
  const list = await call("list_mail", { inbox: "mcp-alpha" });
  const id = list.result.structuredContent.messages[0].id;
  const mail = await call("read_mail", { inbox: "mcp-alpha", id });
  expect(mail.result.structuredContent.text).toBe("private alpha\n");
  expect(mail.result.structuredContent.recipient).toBe("mcp-alpha@example.com");
  expect(
    (await call("read_mail", { inbox: "mcp-alpha", id }, "bob")).result.isError,
  ).toBe(true);
  expect((await call("list_mail", { inbox: "mcp-beta" })).result.isError).toBe(
    true,
  );
});

it("rejects unclaimed addresses rather than creating readable historical mail", async () => {
  expect(await receive("someone@example.com")).toEqual({
    rejected: ["Unknown inbox; create the address before sending mail"],
    forwarded: [],
  });
  await call("create_inbox", { name: "someone" });
  expect(
    (await call("list_mail", { inbox: "someone" })).result.structuredContent
      .messages,
  ).toEqual([]);
});

it("retains mail when forwarding fails and denies read-only forwarding changes", async () => {
  await receive("inbox@example.com", "retained");
  const id = (await call("list_mail")).result.structuredContent.messages[0].id;
  let attempts = 0;
  await runInDurableObject(
    env.INBOXES.getByName("inbox@example.com"),
    (instance) => {
      Object.defineProperty(instance, "env", {
        value: {
          ...env,
          MAILER: {
            send: async () => {
              attempts++;
              throw new Error("unavailable");
            },
          },
        },
      });
    },
  );
  expect((await call("forward_mail", { id }, "reader")).result.isError).toBe(
    true,
  );
  expect((await call("forward_mail", { id })).result.isError).toBe(true);
  expect(
    (await call("forward_mail", { id })).result.structuredContent.forwarding,
  ).toBe("failed");
  expect(attempts).toBe(1);
  const mail = (await call("read_mail", { id })).result.structuredContent;
  expect(mail.text).toBe("retained\n");
  expect(mail.forwarding).toBe("failed");
});

it("restricts webhook ownership, permissions and exact approved destinations", async () => {
  for (const url of [
    "http://hooks.example.com/mail",
    "https://127.0.0.1/mail",
    "https://hooks.example.com/redirect",
    "https://hooks.example.com/mail?target=http://localhost",
    "https://hooks.example.com.evil.test/mail",
  ]) {
    expect(
      (await call("register_webhook", { inbox: "mcp", url })).result.isError,
    ).toBe(true);
  }
  expect(
    (
      await call(
        "register_webhook",
        { inbox: "mcp", url: "https://hooks.example.com/mail" },
        "reader",
      )
    ).result.isError,
  ).toBe(true);
  const hook = (
    await call("register_webhook", {
      inbox: "mcp",
      url: "https://hooks.example.com/mail",
    })
  ).result.structuredContent;
  expect(hook.secret).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (await call("list_webhooks", { inbox: "mcp" }, "bob")).result
      .structuredContent.webhooks,
  ).toEqual([]);
  expect(
    (await call("delete_webhook", { inbox: "mcp", id: hook.id }, "bob")).result
      .isError,
  ).toBe(true);
});

it("persists signed retries across restart and stops after success", async () => {
  await call("create_inbox", { name: "notifications" });
  const hook = (
    await call("register_webhook", {
      inbox: "notifications",
      url: "https://hooks.example.com/mail",
    })
  ).result.structuredContent;
  await receive("notifications@example.com");
  const requests: {
    body: string;
    headers: Headers;
    redirect: RequestInit["redirect"];
  }[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    requests.push({
      body: String(init.body),
      headers: new Headers(init.headers),
      redirect: init.redirect,
    });
    return new Response(null, { status: requests.length === 1 ? 503 : 204 });
  });
  const stub = env.INBOXES.getByName("notifications@example.com");
  await runDurableObjectAlarm(stub);
  await abortAllDurableObjects();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 3600000);
  await runDurableObjectAlarm(
    env.INBOXES.getByName("notifications@example.com"),
  );
  expect(requests).toHaveLength(2);
  expect(requests[0].redirect).toBe("manual");
  const timestamp = requests[0].headers.get("x-mail-timestamp");
  expect(requests[0].headers.get("x-mail-signature")).toBe(
    `v1=${createHmac("sha256", hook.secret).update(`${timestamp}.${requests[0].body}`).digest("hex")}`,
  );
  expect(JSON.parse(requests[0].body).id).toBe(JSON.parse(requests[1].body).id);
  const status = (await call("list_webhooks", { inbox: "notifications" }))
    .result.structuredContent.webhooks[0];
  expect(status.delivered).toBe(1);
  expect(status.pending).toBe(0);
  expect(status.secret).toBeUndefined();
});

it("paginates without leaking other inboxes and expires mail before cleanup", async () => {
  await receive("mcp@example.com", "first");
  await receive("mcp@example.com", "second");
  const page = (await call("list_mail", { inbox: "mcp", limit: 1 })).result
    .structuredContent;
  const older = (
    await call("list_mail", { inbox: "mcp", before: page.nextBefore, limit: 1 })
  ).result.structuredContent;
  expect(older.messages[0].id).not.toBe(page.messages[0].id);
  const url = `https://mail-api.example.com/mail/mcp/${older.messages[0].id}.eml`;
  const raw = await exports.default.fetch(url, {
    headers: { authorization: "Bearer fixture-reader" },
  });
  expect(raw.status).toBe(200);
  expect(new TextDecoder().decode(await raw.arrayBuffer())).toContain(
    "\r\n\r\nfirst",
  );
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 30 * 86400000);
  expect(
    (await call("list_mail", { inbox: "mcp" })).result.structuredContent
      .messages,
  ).toEqual([]);
  expect(
    (
      await exports.default.fetch(url, {
        headers: { authorization: "Bearer fixture-reader" },
      })
    ).status,
  ).toBe(403);
});

it("does not follow redirects and cancels deleted subscriptions", async () => {
  const first = (
    await call("register_webhook", {
      inbox: "mcp",
      url: "https://hooks.example.com/mail",
    })
  ).result.structuredContent;
  const second = (
    await call("register_webhook", {
      inbox: "mcp",
      url: "https://hooks.example.com/mail",
    })
  ).result.structuredContent;
  await receive("mcp@example.com");
  await call("delete_webhook", { inbox: "mcp", id: second.id });
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    requests.push(url);
    expect(init.redirect).toBe("manual");
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
    });
  });
  await runDurableObjectAlarm(env.INBOXES.getByName("mcp@example.com"));
  expect(requests).toEqual(["https://hooks.example.com/mail"]);
  const hooks = (await call("list_webhooks", { inbox: "mcp" })).result
    .structuredContent.webhooks;
  expect(hooks).toHaveLength(1);
  expect(hooks[0]).toMatchObject({ id: first.id, failed: 1, pending: 0 });
});

it("bounds failed webhook retries without losing the email", async () => {
  await call("register_webhook", {
    inbox: "mcp",
    url: "https://hooks.example.com/mail",
  });
  await receive("mcp@example.com");
  let sent = 0;
  vi.stubGlobal("fetch", async () => {
    sent++;
    throw new Error("network unavailable");
  });
  vi.useFakeTimers();
  const stub = env.INBOXES.getByName("mcp@example.com");
  for (let i = 0; i < 10; i++) {
    vi.setSystemTime(Date.now() + 3600000);
    await runDurableObjectAlarm(stub);
  }
  expect(sent).toBe(8);
  expect(
    (await call("list_webhooks", { inbox: "mcp" })).result.structuredContent
      .webhooks[0],
  ).toMatchObject({ failed: 1, pending: 0 });
  expect(
    (await call("list_mail", { inbox: "mcp" })).result.structuredContent
      .messages,
  ).toHaveLength(1);
});

it("round-trips large messages across SQLite chunks and bounds HTTP input", async () => {
  const text = `start${"x".repeat(2 * 1024 * 1024)}end`;
  await receive("mcp-alpha@example.com", text);
  const id = (await call("list_mail", { inbox: "mcp-alpha" })).result
    .structuredContent.messages[0].id;
  const url = `https://mail-api.example.com/mail/mcp-alpha/${id}.eml`;
  expect(
    (
      await exports.default.fetch(url, {
        headers: { authorization: "Bearer fixture-bob" },
      })
    ).status,
  ).toBe(403);
  const response = await exports.default.fetch(url, {
    headers: { authorization: "Bearer fixture-alice" },
  });
  expect(
    new TextDecoder().decode(await response.arrayBuffer()).split("\r\n\r\n")[1],
  ).toBe(text);
  expect(
    (await call("read_mail", { inbox: "mcp-alpha", id })).result
      .structuredContent.rawOnly,
  ).toBe(true);
  const tooBig = await exports.default.fetch(
    "https://mail-api.example.com/mcp",
    {
      method: "POST",
      headers: { authorization: "Bearer fixture-alice" },
      body: "x".repeat(16385),
    },
  );
  expect(tooBig.status).toBe(413);
});

it("rechecks revoked inbox grants before delivering queued mail", async () => {
  await call("register_webhook", {
    inbox: "mcp",
    url: "https://hooks.example.com/mail",
  });
  await receive("mcp@example.com");
  const stub = env.INBOXES.getByName("mcp@example.com");
  // Simulate a deployment replacing the secret policy on this object.
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, "env", {
      value: { ...env, ACCESS_POLICY: "[]" },
    });
  });
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    sent.push(url);
    return new Response(null, { status: 204 });
  });
  await runDurableObjectAlarm(stub);
  expect(sent).toEqual([]);
  expect(
    (await call("list_mail", { inbox: "mcp" })).result.structuredContent
      .messages,
  ).toHaveLength(1);
});

it("does not turn interrupted mail streams into permanent size rejections", async () => {
  const rejected: string[] = [];
  const message = {
    to: "mcp@example.com",
    from: "sender@example.net",
    rawSize: 10,
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("interrupted"));
      },
    }),
    setReject(reason: string) {
      rejected.push(reason);
    },
    async forward() {
      return { messageId: "fixture" };
    },
    async reply() {
      return { messageId: "fixture" };
    },
  };
  await expect(worker.email(message, env)).rejects.toThrow("interrupted");
  expect(rejected).toEqual([]);
});

it("rejects oversized streams even when the declared size lies", async () => {
  const rejected: string[] = [];
  let chunks = 0;
  const chunk = new Uint8Array(1024 * 1024);
  await worker.email(
    {
      to: "mcp@example.com",
      from: "sender@example.net",
      rawSize: 0,
      headers: new Headers(),
      raw: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunks++ < 26) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      setReject(reason: string) {
        rejected.push(reason);
      },
      async forward() {
        return { messageId: "fixture" };
      },
      async reply() {
        return { messageId: "fixture" };
      },
    },
    env,
  );
  expect(rejected).toEqual(["Mail exceeds 25 MiB limit"]);
  expect(
    (await call("list_mail", { inbox: "mcp" })).result.structuredContent
      .messages,
  ).toEqual([]);
});

it("enforces subscription quotas and expires old subscriptions", async () => {
  for (let i = 0; i < 20; i++) {
    expect(
      (
        await call("register_webhook", {
          inbox: "mcp",
          url: "https://hooks.example.com/mail",
        })
      ).result.isError,
    ).not.toBe(true);
  }
  expect(
    (
      await call("register_webhook", {
        inbox: "mcp",
        url: "https://hooks.example.com/mail",
      })
    ).result.isError,
  ).toBe(true);
  expect(
    (await call("list_webhooks", { inbox: "mcp" })).result.structuredContent
      .webhooks,
  ).toHaveLength(20);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 30 * 86400000);
  await runDurableObjectAlarm(env.INBOXES.getByName("mcp@example.com"));
  expect(
    (await call("list_webhooks", { inbox: "mcp" })).result.structuredContent
      .webhooks,
  ).toEqual([]);
});

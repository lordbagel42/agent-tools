import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { bootstrapOwner, createAuth } from "../src/auth";
import { ArtifactStore } from "../src/store";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  const config = {
    origin: "http://localhost:39481",
    hostSuffix: "-artifact.localhost",
    ownerEmail: "owner@example.test",
    secret: "synthetic-artifact-app-secret-with-thirty-two-characters",
    production: false,
  };
  const password = "synthetic-app-password";
  const ownerId = await bootstrapOwner(db, config, password);
  const auth = createAuth(db, config);
  const store = new ArtifactStore(db);
  const app = createApp({ config, auth, store, ownerId });
  const request = (path: string, init?: RequestInit) =>
    app.handle(new Request(new URL(path, config.origin), init));
  const login = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { Origin: config.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email: config.ownerEmail, password }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const first = {
    slug: "review",
    title: "Public report",
    format: "html" as const,
    content: '<h1>Public</h1><script>document.title="interactive"</script>',
  };
  store.create(ownerId, first);
  return { config, store, ownerId, request, cookie };
}

test("public hostname never dispatches management or OAuth and never exposes drafts", async () => {
  const { request, store, ownerId, cookie } = await fixture();
  const host = "http://review-artifact.localhost:39481";
  for (const path of [
    "/",
    "/content",
    "/api/artifacts",
    "/api/auth/get-session",
    "/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    expect(
      (await request(`${host}${path}`, { headers: { Cookie: cookie } })).status,
    ).toBe(404);
  }
  store.publish(ownerId, "review", 1, 1);
  store.update(ownerId, "review", {
    title: "Secret title",
    format: "html",
    content: "Secret source",
    expectedRevision: 1,
  });
  const page = await request(`${host}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).not.toContain("Secret");
  const source = await request(`${host}/content?revision=2`);
  expect(source.status).toBe(200);
  expect(await source.text()).toContain("<h1>Public</h1>");
  for (const path of [
    "/api/artifacts",
    "/api/auth/get-session",
    "/mcp",
    "/.well-known/oauth-protected-resource",
  ]) {
    expect(
      (await request(`${host}${path}`, { headers: { Cookie: cookie } })).status,
    ).toBe(404);
  }
  store.unpublish(ownerId, "review");
  expect((await request(`${host}/content`)).status).toBe(404);
  expect((await request(`${host}/`)).status).toBe(404);
});

test("content is sandboxed even when opened directly; host and origin checks fail closed", async () => {
  const { request, cookie, config, store, ownerId } = await fixture();
  const source = await request("/a/review/content", {
    headers: { Cookie: cookie },
  });
  expect(source.status).toBe(200);
  const csp = source.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("sandbox allow-scripts");
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).toContain("form-action 'none'");
  expect(source.headers.get("cache-control")).toBe("no-store");
  expect(
    (
      await request("http://evil.example.test/a/review", {
        headers: {
          Cookie: cookie,
          "X-Forwarded-Host": new URL(config.origin).host,
        },
      })
    ).status,
  ).toBe(404);
  for (const origin of ["null", "http://review-artifact.localhost:39481"]) {
    const response = await request("/api/artifacts/review/publish", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ revision: 1, expectedRevision: 1 }),
    });
    expect(response.status).toBe(403);
  }
  expect(store.publicRead("review")).toBeNull();
  expect(store.read(ownerId, "review").revision).toBe(1);
});

test("owner session is required for gallery, source, history, and mutation", async () => {
  const { request, cookie, config } = await fixture();
  expect((await request("/")).status).toBe(302);
  expect((await request("/a/review/content")).status).toBe(401);
  expect((await request("/api/artifacts")).status).toBe(401);
  const list = await request("/api/artifacts", { headers: { Cookie: cookie } });
  expect(list.status).toBe(200);
  expect((await list.json()).artifacts[0].slug).toBe("review");
  const publish = await request("/api/artifacts/review/publish", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: config.origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ revision: 1, expectedRevision: 1 }),
  });
  expect(publish.status).toBe(200);
  const remove = await request("/api/artifacts/review/unpublish", {
    method: "POST",
    headers: { Cookie: cookie, Origin: config.origin },
  });
  expect(remove.status).toBe(200);
});

test("unauthorized MCP challenges advertise discovery and do not trust browser cookies", async () => {
  const { request, cookie, config } = await fixture();
  const response = await request("/mcp", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toContain(
    "oauth-protected-resource",
  );
  const discovery = await request("/.well-known/oauth-protected-resource");
  expect(discovery.status).toBe(200);
  expect((await discovery.json()).resource).toBe(`${config.origin}/mcp`);
});

test("viewer event stream reports publication and revocation without private draft metadata", async () => {
  const { request, store, ownerId } = await fixture();
  store.publish(ownerId, "review", 1, 1);
  const controller = new AbortController();
  const response = await request(
    "http://review-artifact.localhost:39481/events",
    { signal: controller.signal },
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const initial = new TextDecoder().decode((await reader?.read())?.value);
  expect(initial).toContain('"revision":1');
  store.update(ownerId, "review", {
    title: "Secret",
    format: "html",
    content: "Secret",
    expectedRevision: 1,
  });
  store.unpublish(ownerId, "review");
  const gone = new TextDecoder().decode((await reader?.read())?.value);
  expect(gone).toContain("event: unavailable");
  expect(gone).not.toContain("Secret");
  controller.abort();
  await reader?.cancel();
});

test("disconnecting a live viewer releases its stream without closing twice", async () => {
  const { request, store, ownerId } = await fixture();
  store.publish(ownerId, "review", 1, 1);
  const response = await request(
    "http://review-artifact.localhost:39481/events",
  );
  if (!response.body) throw new Error("Missing event stream");
  const reader = response.body.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain(
    '"revision":1',
  );
  await expect(reader.cancel()).resolves.toBeUndefined();
});

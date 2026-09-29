import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import * as ownerAuth from "../src/auth";
import { ArtifactStore } from "../src/store";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  const config = {
    origin: "http://localhost:39482",
    hostSuffix: "-artifact.localhost",
    ownerEmail: "owner@example.test",
    secret: "synthetic-setup-secret-with-thirty-two-characters",
    production: false,
  };
  const password = "synthetic-original-password";
  const ownerId = await ownerAuth.bootstrapOwner(db, config, password);
  const auth = ownerAuth.createAuth(db, config);
  const store = new ArtifactStore(db);
  store.create(ownerId, {
    slug: "keep-me",
    title: "Existing private artifact",
    format: "html",
    content: "<p>Keep this content</p>",
  });
  const app = createApp({ config, auth, store, ownerId });
  const request = (path: string, init?: RequestInit) =>
    app.handle(new Request(new URL(path, config.origin), init));
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { Origin: config.origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const issue = async () => {
    expect(ownerAuth.issueSetupLink).toBeFunction();
    return new URL(await ownerAuth.issueSetupLink(db, config));
  };
  const reset = (link: URL, newPassword = "synthetic-replacement-password") =>
    post("/api/auth/reset-password", {
      token: new URLSearchParams(link.hash.slice(1)).get("token"),
      newPassword,
    });
  return {
    db,
    config,
    auth,
    ownerId,
    store,
    password,
    request,
    post,
    issue,
    reset,
  };
}

test("setup page is anonymous only on management; public issuance and signup stay disabled", async () => {
  const { request, post, db } = await fixture();
  const page = await request("/signup");
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await page.text()).toContain("Choose your password");
  expect(
    (await request("http://keep-me-artifact.localhost:39482/signup")).status,
  ).toBe(404);
  expect(
    (
      await post("/api/auth/request-password-reset", {
        email: "owner@example.test",
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await post("/api/auth/sign-up/email", {
        email: "stranger@example.test",
        name: "Stranger",
        password: "synthetic-stranger-password",
      })
    ).status,
  ).toBe(400);
  expect(
    db.query('SELECT count(*) AS count FROM "verification"').get(),
  ).toEqual({ count: 0 });
});

test("operator link sets a password once, revokes browser sessions, and preserves ownership", async () => {
  const { issue, reset, config, post, request, password, db, ownerId, store } =
    await fixture();
  const login = await post("/api/auth/sign-in/email", {
    email: config.ownerEmail,
    password,
  });
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const link = await issue();
  expect(link.origin).toBe(config.origin);
  expect(link.pathname).toBe("/signup");
  expect(link.search).toBe("");
  expect(
    new URLSearchParams(link.hash.slice(1)).get("token")?.length,
  ).toBeGreaterThanOrEqual(24);
  // A validation error must not burn an otherwise valid link.
  expect((await reset(link, "short")).status).toBe(400);
  expect((await reset(link, "sixsix")).status).toBe(200);
  expect((await reset(link, "synthetic-attacker-password")).status).toBe(400);
  expect(
    (await request("/api/artifacts", { headers: { Cookie: cookie } })).status,
  ).toBe(401);
  expect(
    (
      await post("/api/auth/sign-in/email", {
        email: config.ownerEmail,
        password,
      })
    ).status,
  ).toBe(401);
  const signedIn = await post("/api/auth/sign-in/email", {
    email: config.ownerEmail,
    password: "sixsix",
  });
  expect(signedIn.status).toBe(200);
  expect((await signedIn.json()).user.id).toBe(ownerId);
  expect(db.query('SELECT count(*) AS count FROM "user"').get()).toEqual({
    count: 1,
  });
  expect(store.read(ownerId, "keep-me").content).toBe(
    "<p>Keep this content</p>",
  );
});

test("issuing a new link invalidates earlier links; expired tokens fail", async () => {
  const { db, issue, reset } = await fixture();
  const first = await issue();
  const second = await issue();
  expect((await reset(first)).status).toBe(400);
  const row = db
    .query<{ expiresAt: string }, []>('SELECT "expiresAt" FROM "verification"')
    .get();
  const expiresAt = new Date(row?.expiresAt ?? "").getTime();
  expect(expiresAt - Date.now()).toBeGreaterThan(29 * 60_000);
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  db.run('UPDATE "verification" SET "expiresAt" = ?', [
    new Date(Date.now() - 1).toISOString(),
  ]);
  expect((await reset(second)).status).toBe(400);
});

test("competing submissions consume a setup link atomically", async () => {
  const { issue, reset, post, config } = await fixture();
  const link = await issue();
  const passwords = ["synthetic-competing-alpha", "synthetic-competing-beta"];
  const results = await Promise.all(
    passwords.map((password) => reset(link, password)),
  );
  expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
  for (const [index, password] of passwords.entries()) {
    expect(
      (
        await post("/api/auth/sign-in/email", {
          email: config.ownerEmail,
          password,
        })
      ).status,
    ).toBe(results[index]?.status === 200 ? 200 : 401);
  }
});

test("operator issuance fails closed when configured identity does not match", async () => {
  const { db, config } = await fixture();
  expect(ownerAuth.issueSetupLink).toBeFunction();
  await expect(
    ownerAuth.issueSetupLink(db, {
      ...config,
      ownerEmail: "wrong@example.test",
    }),
  ).rejects.toThrow();
  expect(
    db.query('SELECT count(*) AS count FROM "verification"').get(),
  ).toEqual({ count: 0 });
});

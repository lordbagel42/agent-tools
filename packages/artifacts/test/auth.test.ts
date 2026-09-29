import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import {
  bootstrapOwner,
  createAuth,
  migrateAuth,
  readOwner,
} from "../src/auth";
import { ArtifactStore } from "../src/store";

const config = {
  origin: "http://localhost:34567",
  secret: "synthetic-test-secret-with-at-least-thirty-two-characters",
  ownerEmail: "owner@example.test",
  production: false,
};
const password = "synthetic-owner-password";
const databases: Database[] = [];
function database() {
  const db = new Database(":memory:");
  databases.push(db);
  return db;
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

test("startup refuses missing or mismatched owner and bootstrap never resets credentials", async () => {
  const db = database();
  const auth = createAuth(db, config);
  await migrateAuth(auth);
  expect(() => readOwner(db, config.ownerEmail)).toThrow();
  const id = await bootstrapOwner(db, config, password);
  expect(readOwner(db, config.ownerEmail)).toBe(id);
  expect(await bootstrapOwner(db, config, "different-synthetic-password")).toBe(
    id,
  );
  expect(() => readOwner(db, "other@example.test")).toThrow();
  await expect(
    bootstrapOwner(
      db,
      { ...config, ownerEmail: "other@example.test" },
      password,
    ),
  ).rejects.toThrow();
  expect(
    (
      await auth.api.signInEmail({
        body: { email: config.ownerEmail, password },
      })
    ).user.id,
  ).toBe(id);
  await expect(
    auth.api.signInEmail({
      body: {
        email: config.ownerEmail,
        password: "different-synthetic-password",
      },
    }),
  ).rejects.toThrow();
});

test("mounted auth refuses public signup", async () => {
  const auth = createAuth(database(), config);
  await migrateAuth(auth);
  const response = await auth.handler(
    new Request(`${config.origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.origin },
      body: JSON.stringify({
        name: "Stranger",
        email: "stranger@example.test",
        password,
      }),
    }),
  );
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
});

test("production sessions use host-only secure cookies and durable rate limits", async () => {
  const db = database();
  const production = {
    ...config,
    origin: "https://manage.example.test",
    production: true,
  };
  await bootstrapOwner(db, production, password);
  const auth = createAuth(db, production);
  const response = await auth.handler(
    new Request(`${production.origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: production.origin,
        "x-forwarded-for": "192.0.2.1",
      },
      body: JSON.stringify({ email: config.ownerEmail, password }),
    }),
  );
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  expect(
    cookies.some(
      (cookie) =>
        cookie.startsWith("__Host-") &&
        cookie.includes("Secure") &&
        cookie.includes("HttpOnly") &&
        cookie.includes("Path=/"),
    ),
  ).toBe(true);
  expect(cookies.every((cookie) => !/domain=/i.test(cookie))).toBe(true);
  expect(
    db.query('SELECT count(*) AS count FROM "rateLimit"').get(),
  ).toMatchObject({ count: 1 });
  expect(auth.options.trustedOrigins).toEqual([production.origin]);
});

test("MCP discovery and public native PKCE flow preserve signed login and explicit consent", async () => {
  let auth: ReturnType<typeof createAuth>;
  let app: ReturnType<typeof createApp>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.handle(request),
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const db = database();
    const fixture = { ...config, origin, hostSuffix: "-artifact.localhost" };
    const ownerId = await bootstrapOwner(db, fixture, password);
    auth = createAuth(db, fixture);
    const store = new ArtifactStore(db);
    app = createApp({ config: fixture, auth, store, ownerId });
    const request = (path: string, init?: RequestInit) =>
      fetch(new URL(path, origin), { ...init, redirect: "manual" });
    const post = (path: string, body: unknown, cookie = "") =>
      request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      });
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: `${origin}/mcp`,
        authorization_servers: [`${origin}/api/auth`],
        scopes_supported: ["artifacts:manage"],
      });
    }
    const metadataResponse = await request(
      "/.well-known/oauth-authorization-server/api/auth",
    );
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json();
    expect(metadata.issuer).toBe(`${origin}/api/auth`);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    const redirectUri = "http://127.0.0.1:54321/callback";
    const registered = await post(metadata.registration_endpoint, {
      client_name: "Synthetic native client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid offline_access artifacts:manage",
    });
    expect(registered.status).toBe(201);
    const client = await registered.json();
    expect(client.client_secret).toBeUndefined();
    const verifier =
      "synthetic-pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const challenge = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ).toString("base64url");
    for (const flow of ["allow", "wrong-verifier", "deny"]) {
      const wrongVerifier = flow === "wrong-verifier";
      const authorize = new URL(metadata.authorization_endpoint);
      authorize.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid offline_access artifacts:manage",
        resource: `${origin}/mcp`,
        state: "synthetic-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "consent",
      }).toString();
      const withoutPkce = new URL(authorize);
      withoutPkce.searchParams.delete("code_challenge");
      withoutPkce.searchParams.delete("code_challenge_method");
      const rejected = await request(withoutPkce.toString());
      const rejectionUrl = new URL(
        rejected.headers.get("location") as string,
        origin,
      );
      expect(rejectionUrl.searchParams.get("error")).toBe("invalid_request");
      const start = await request(authorize.toString());
      expect(start.status).toBe(302);
      const login = new URL(start.headers.get("location") as string, origin);
      expect(login.pathname).toBe("/login");
      expect(login.searchParams.has("sig")).toBe(true);
      expect(login.searchParams.getAll("ba_param").length).toBeGreaterThan(0);
      const signedIn = await post("/api/auth/sign-in/email", {
        email: config.ownerEmail,
        password,
        oauth_query: login.search.slice(1),
      });
      expect(signedIn.status).toBe(200);
      const signInBody = await signedIn.json();
      expect(signInBody.redirect).toBe(true);
      const consent = new URL(signInBody.url, origin);
      expect(consent.pathname).toBe("/consent");
      expect(consent.searchParams.has("sig")).toBe(true);
      const cookie = signedIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const approved = await post(
        "/api/auth/oauth2/consent",
        { accept: flow !== "deny", oauth_query: consent.search.slice(1) },
        cookie,
      );
      expect(approved.status).toBe(200);
      const callback = new URL((await approved.json()).url);
      expect(callback.searchParams.get("state")).toBe("synthetic-state");
      if (flow === "deny") {
        expect(callback.searchParams.get("error")).toBe("access_denied");
        expect(callback.searchParams.has("code")).toBe(false);
        continue;
      }
      expect(callback.searchParams.has("code")).toBe(true);
      const token = await request(metadata.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code: callback.searchParams.get("code") as string,
          code_verifier: wrongVerifier
            ? "wrong-verifier-abcdefghijklmnopqrstuvwxyz0123456789"
            : verifier,
        }),
      });
      if (wrongVerifier) {
        expect(token.status).toBe(401);
        expect(await token.json()).toMatchObject({
          error: "invalid_request",
          error_description: "code verification failed",
        });
      } else {
        expect(token.status).toBe(200);
        const tokens = await token.json();
        expect(tokens.expires_in).toBeLessThanOrEqual(300);
        expect(tokens.refresh_token).toBeString();
        const claims = JSON.parse(
          Buffer.from(
            tokens.access_token.split(".")[1],
            "base64url",
          ).toString(),
        );
        expect(claims.aud).toContain(`${origin}/mcp`);
        expect(claims.iss).toBe(`${origin}/api/auth`);
        expect(claims.sub).toBe(ownerId);
        expect(claims.scope.split(" ")).toContain("artifacts:manage");
        expect(claims.azp).toBe(client.client_id);
        const rpc = (
          method: string,
          params: unknown,
          bearer = tokens.access_token,
        ) =>
          request("/mcp", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "MCP-Protocol-Version": "2025-03-26",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
        const decode = async (response: Response) => {
          expect(response.status).toBe(200);
          const text = await response.text();
          return JSON.parse(
            text.startsWith("event:")
              ? (text.split("data: ")[1]?.split("\n")[0] ?? "")
              : text,
          );
        };
        const initialized = await decode(
          await rpc("initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "integration", version: "1" },
          }),
        );
        expect(initialized.result.serverInfo.name).toBe("artifacts");
        const tools = await decode(await rpc("tools/list", {}));
        expect(
          tools.result.tools.map((tool: { name: string }) => tool.name),
        ).toContain("publish_artifact");
        const created = await decode(
          await rpc("tools/call", {
            name: "create_artifact",
            arguments: {
              slug: "oauth-report",
              title: "OAuth report",
              format: "html",
              content: "<h1>From MCP</h1>",
            },
          }),
        );
        expect(created.result.structuredContent.artifact).toMatchObject({
          revision: 1,
          publishedRevision: null,
        });
        expect(store.publicRead("oauth-report")).toBeNull();
        const published = await decode(
          await rpc("tools/call", {
            name: "publish_artifact",
            arguments: {
              slug: "oauth-report",
              revision: 1,
              expectedRevision: 1,
            },
          }),
        );
        expect(
          published.result.structuredContent.artifact.publishedRevision,
        ).toBe(1);
        expect(store.publicRead("oauth-report")?.content).toBe(
          "<h1>From MCP</h1>",
        );
        for (const mutation of [
          { sub: "another-user" },
          { aud: "https://wrong.example.test/mcp" },
          { scope: "openid" },
          { exp: Math.floor(Date.now() / 1000) - 60 },
          { azp: null },
        ]) {
          const { token: invalid } = await auth.api.signJWT({
            body: { payload: { ...claims, ...mutation } },
          });
          const rejected = await rpc("tools/list", {}, invalid);
          expect([401, 403]).toContain(rejected.status);
        }
      }
    }
  } finally {
    await server.stop(true);
  }
});

import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";

beforeAll(async () => {
  await applyD1Migrations(
    env.AUTH_DB,
    (env as Env & { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
  );
});

it("advertises OAuth discovery without requiring a bearer credential", async () => {
  const response = await exports.default.fetch(
    "https://mail-api.example.com/.well-known/oauth-protected-resource/mcp",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    resource: "https://mail-api.example.com/mcp",
    authorization_servers: ["https://mail-api.example.com/api/auth"],
  });
}, 60000);

it("does not allow public owner registration", async () => {
  const response = await exports.default.fetch(
    "https://mail-api.example.com/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://mail-api.example.com",
      },
      body: JSON.stringify({
        name: "Attacker",
        email: "other@example.net",
        password: "not-a-real-password",
      }),
    },
  );
  expect(response.ok).toBe(false);
});

afterEach(() => vi.unstubAllGlobals());

it("requires owner setup, explicit consent and PKCE before granting durable inbox access", async () => {
  const origin = env.PUBLIC_ORIGIN;
  const request = (path: string, init?: RequestInit) =>
    exports.default.fetch(new URL(path, origin).href, {
      ...init,
      redirect: "manual",
    });
  const post = (path: string, body: unknown, cookie = "") =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: JSON.stringify(body),
    });
  const auth = createAuth(env, { bootstrap: true });
  await expect(
    auth.api.signUpEmail({
      body: {
        name: "Other",
        email: "other@example.net",
        password: "synthetic-owner-password",
      },
    }),
  ).rejects.toThrow();
  const owner = await auth.api.signUpEmail({
    body: {
      name: "Owner",
      email: env.OWNER_EMAIL,
      password: "synthetic-random-initial-password",
    },
  });
  let setupToken = "";
  await createAuth(env, {
    setupToken: (token) => {
      setupToken = token;
    },
  }).api.requestPasswordReset({ body: { email: env.OWNER_EMAIL } });
  const password = "synthetic-chosen-owner-password";
  expect(
    (
      await post("/api/auth/reset-password", {
        token: setupToken,
        newPassword: password,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await post("/api/auth/reset-password", {
        token: setupToken,
        newPassword: "synthetic-replay-password",
      })
    ).ok,
  ).toBe(false);
  expect(
    (await post("/api/auth/request-password-reset", { email: env.OWNER_EMAIL }))
      .ok,
  ).toBe(false);
  expect(
    (
      await post("/api/auth/sign-in/email", {
        email: env.OWNER_EMAIL,
        password: "wrong-password",
      })
    ).ok,
  ).toBe(false);
  const metadata = (await (
    await request("/.well-known/oauth-authorization-server/api/auth")
  ).json()) as Record<string, string>;
  const redirectUri = "http://127.0.0.1:54321/callback";
  const registered = await post(metadata.registration_endpoint, {
    client_name: "Fixture",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    application_type: "native",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "openid offline_access email:manage",
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  const verifier =
    "synthetic-pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  // Only the Worker's own JWKS endpoint may be fetched; all other network is denied.
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | Request | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url !== `${origin}/api/auth/jwks`)
        throw new Error("Unexpected outbound request");
      return createAuth(env).handler(new Request(url));
    }),
  );
  for (const flow of ["allow", "wrong-verifier", "deny"]) {
    // Independent scenarios must not exhaust the shared fixture IP's login budget.
    await env.AUTH_DB.prepare('DELETE FROM "rateLimit"').run();
    const authorize = new URL(metadata.authorization_endpoint);
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid offline_access email:manage",
      resource: `${origin}/mcp`,
      state: "fixture-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "consent",
    }).toString();
    const withoutPkce = new URL(authorize);
    withoutPkce.searchParams.delete("code_challenge");
    withoutPkce.searchParams.delete("code_challenge_method");
    const denied = await request(withoutPkce.href);
    expect(
      new URL(denied.headers.get("location") ?? "", origin).searchParams.get(
        "error",
      ),
    ).toBe("invalid_request");
    const start = await request(authorize.href);
    expect(start.status).toBe(302);
    const login = new URL(start.headers.get("location") ?? "", origin);
    expect(login.pathname).toBe("/login");
    const signedIn = await post("/api/auth/sign-in/email", {
      email: env.OWNER_EMAIL,
      password,
      oauth_query: login.search.slice(1),
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("set-cookie")).toContain("__Host-email");
    const consent = new URL(
      ((await signedIn.json()) as { url: string }).url,
      origin,
    );
    expect(consent.pathname).toBe("/consent");
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(
      (
        await post(
          "/api/auth/oauth2/consent",
          { accept: true, oauth_query: "client_id=untrusted" },
          cookie,
        )
      ).ok,
    ).toBe(false);
    const approved = await post(
      "/api/auth/oauth2/consent",
      { accept: flow !== "deny", oauth_query: consent.search.slice(1) },
      cookie,
    );
    expect(approved.status).toBe(200);
    const callback = new URL(((await approved.json()) as { url: string }).url);
    expect(callback.searchParams.get("state")).toBe("fixture-state");
    if (flow === "deny") {
      expect(callback.searchParams.get("error")).toBe("access_denied");
      expect(callback.searchParams.has("code")).toBe(false);
      continue;
    }
    const exchange = (body: Record<string, string>) =>
      request(metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
      });
    const token = await exchange({
      grant_type: "authorization_code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code: callback.searchParams.get("code") ?? "",
      code_verifier:
        flow === "wrong-verifier"
          ? "wrong-verifier-abcdefghijklmnopqrstuvwxyz0123456789"
          : verifier,
    });
    if (flow === "wrong-verifier") {
      expect(token.ok).toBe(false);
      continue;
    }
    expect(token.status).toBe(200);
    const tokens = (await token.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(tokens.expires_in).toBeLessThanOrEqual(300);
    const rpc = (bearer: string) =>
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
    const tools = await rpc(tokens.access_token);
    expect(tools.status).toBe(200);
    expect(await tools.text()).toContain("forward_mail");
    const claims = JSON.parse(
      Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
    );
    expect(claims.sub).toBe(owner.user.id);
    for (const mutation of [
      { sub: "another-user" },
      { aud: "https://wrong.example.net/mcp" },
      { scope: "openid" },
      { exp: Math.floor(Date.now() / 1000) - 60 },
      { azp: null },
    ]) {
      const invalid = await auth.api.signJWT({
        body: { payload: { ...claims, ...mutation } },
      });
      expect([401, 403]).toContain((await rpc(invalid.token)).status);
    }
    const refreshed = await exchange({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    expect(
      (
        await rpc(
          ((await refreshed.json()) as { access_token: string }).access_token,
        )
      ).status,
    ).toBe(200);
  }
});

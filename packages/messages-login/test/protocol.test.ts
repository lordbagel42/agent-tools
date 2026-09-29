import assert from "node:assert/strict";
import test from "node:test";
import type { GoogleCredentials } from "../src/cookies.js";
import {
  PairingProtocol,
  PairingProtocolError,
  type SessionFetch,
  type SetupLease,
} from "../src/protocol.js";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://pairing.example.test";

const credentials: GoogleCredentials = {
  SID: "sid-value",
  HSID: "hsid-value",
  SSID: "ssid-value",
  OSID: "osid-value",
  APISID: "apisid-value",
  SAPISID: "sapisid-value",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

test("start posts an authenticated same-origin JSON request and validates the lease", async () => {
  let requestSnapshot:
    | {
        url: string;
        method: string;
        origin: string | null;
        contentType: string | null;
        body: string;
        credentials: RequestCredentials;
        redirect: RequestRedirect;
      }
    | undefined;
  const fetch: SessionFetch = async (input, init) => {
    const request = new Request(input, init);
    requestSnapshot = {
      url: request.url,
      method: request.method,
      origin: request.headers.get("Origin"),
      contentType: request.headers.get("Content-Type"),
      body: await request.text(),
      credentials: request.credentials,
      redirect: request.redirect,
    };
    return jsonResponse({ token: "one-time-token", expiresAt: NOW + 60_000 });
  };

  const protocol = new PairingProtocol(ORIGIN, fetch, () => NOW);

  assert.deepEqual(await protocol.start(), {
    token: "one-time-token",
    expiresAt: NOW + 60_000,
  });
  assert.deepEqual(requestSnapshot, {
    url: `${ORIGIN}/connect/start`,
    method: "POST",
    origin: ORIGIN,
    contentType: "application/json",
    body: "{}",
    credentials: "include",
    redirect: "manual",
  });
});

test("start accepts the server's 15-minute setup window", async () => {
  const protocol = new PairingProtocol(
    ORIGIN,
    async () =>
      jsonResponse({
        token: "a".repeat(64),
        expiresAt: NOW + 15 * 60_000,
      }),
    () => NOW,
  );
  const lease = await protocol.start();
  assert.equal(lease.expiresAt, NOW + 900_000);
});

test("start converts the server deadline to local time without requiring synchronized clocks", async () => {
  for (const [localStart, expectedDeadline] of [
    [1_799_999_940_000, 1_800_000_839_500],
    [1_800_000_120_000, 1_800_001_019_500],
  ]) {
    let now = localStart as number;
    const protocol = new PairingProtocol(
      ORIGIN,
      async () => {
        now += 325;
        const response = jsonResponse({
          token: "one-time-token",
          expiresAt: 1_800_000_900_500,
        });
        response.headers.set("Date", new Date(NOW).toUTCString());
        return response;
      },
      () => now,
    );
    const lease = await protocol.start();
    // HTTP Date rounds down to a second. Deduct that uncertainty and count
    // lifetime from the local request start, not after the network delay.
    assert.equal(lease.expiresAt, expectedDeadline);
  }
});

test("start rejects a server lease that expires during the request", async () => {
  let now = NOW + 120_000;
  const protocol = new PairingProtocol(
    ORIGIN,
    async () => {
      now += 600;
      const response = jsonResponse({
        token: "one-time-token",
        expiresAt: NOW + 1500,
      });
      response.headers.set("Date", new Date(NOW).toUTCString());
      return response;
    },
    () => now,
  );
  await assert.rejects(protocol.start(), PairingProtocolError);
});

test("start rejects redirects and status failures without reading their bodies", async () => {
  for (const status of [302, 401, 500]) {
    const response = {
      status,
      redirected: false,
      headers: new Headers(),
      get body(): never {
        throw new Error("response body must not be read");
      },
    } as unknown as Response;
    const protocol = new PairingProtocol(
      ORIGIN,
      async () => response,
      () => NOW,
    );

    await assert.rejects(() => protocol.start(), PairingProtocolError);
  }
});

test("start bounds and strictly validates the response body", async () => {
  const cases: Array<{ name: string; response: Response }> = [
    {
      name: "non-JSON content type",
      response: new Response("not JSON", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    },
    {
      name: "oversized body",
      response: new Response("x".repeat(16_385), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
    {
      name: "malformed JSON",
      response: new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
    {
      name: "extra response field",
      response: jsonResponse({
        token: "one-time-token",
        expiresAt: NOW + 60_000,
        extra: true,
      }),
    },
    {
      name: "empty token",
      response: jsonResponse({ token: "", expiresAt: NOW + 60_000 }),
    },
    {
      name: "header-breaking token",
      response: jsonResponse({
        token: "token\r\nInjected: yes",
        expiresAt: NOW + 60_000,
      }),
    },
    {
      name: "expired lease",
      response: jsonResponse({ token: "one-time-token", expiresAt: NOW }),
    },
    {
      name: "unreasonably long lease",
      response: jsonResponse({
        token: "one-time-token",
        expiresAt: NOW + 60 * 60_000,
      }),
    },
  ];

  for (const { name, response } of cases) {
    const protocol = new PairingProtocol(
      ORIGIN,
      async () => response,
      () => NOW,
    );
    await assert.rejects(() => protocol.start(), PairingProtocolError, name);
  }
});

test("complete sends the exact credential payload once and treats 202 as accepted, not paired", async () => {
  let requestSnapshot:
    | {
        url: string;
        method: string;
        origin: string | null;
        contentType: string | null;
        setupToken: string | null;
        body: unknown;
        credentials: RequestCredentials;
        redirect: RequestRedirect;
      }
    | undefined;
  const fetch: SessionFetch = async (input, init) => {
    const request = new Request(input, init);
    requestSnapshot = {
      url: request.url,
      method: request.method,
      origin: request.headers.get("Origin"),
      contentType: request.headers.get("Content-Type"),
      setupToken: request.headers.get("X-Setup-Token"),
      body: JSON.parse(await request.text()) as unknown,
      credentials: request.credentials,
      redirect: request.redirect,
    };
    return new Response(null, { status: 202 });
  };
  const protocol = new PairingProtocol(ORIGIN, fetch, () => NOW);
  const lease: SetupLease = {
    token: "one-time-token",
    expiresAt: NOW + 60_000,
  };

  assert.deepEqual(await protocol.complete(lease, credentials), {
    kind: "accepted",
    paired: false,
    retry: false,
  });
  assert.deepEqual(requestSnapshot, {
    url: `${ORIGIN}/connect/complete`,
    method: "POST",
    origin: ORIGIN,
    contentType: "application/json",
    setupToken: "one-time-token",
    body: { cookies: credentials },
    credentials: "include",
    redirect: "manual",
  });
});

test("complete never replays a lease after an accepted response", async () => {
  let requestCount = 0;
  const protocol = new PairingProtocol(
    ORIGIN,
    async () => {
      requestCount += 1;
      return new Response(null, { status: 202 });
    },
    () => NOW,
  );
  const lease: SetupLease = {
    token: "one-time-token",
    expiresAt: NOW + 60_000,
  };

  assert.equal((await protocol.complete(lease, credentials)).kind, "accepted");
  assert.deepEqual(await protocol.complete(lease, credentials), {
    kind: "replay",
    retry: false,
  });
  assert.equal(requestCount, 1);
});

test("complete marks a transport failure ambiguous and never retries it", async () => {
  let requestCount = 0;
  const protocol = new PairingProtocol(
    ORIGIN,
    async () => {
      requestCount += 1;
      throw new Error("a transport error whose details must stay private");
    },
    () => NOW,
  );
  const lease: SetupLease = {
    token: "one-time-token",
    expiresAt: NOW + 60_000,
  };

  assert.deepEqual(await protocol.complete(lease, credentials), {
    kind: "ambiguous",
    retry: false,
  });
  assert.deepEqual(await protocol.complete(lease, credentials), {
    kind: "replay",
    retry: false,
  });
  assert.equal(requestCount, 1);
});

test("complete treats redirects and non-202 statuses as terminal rejection", async () => {
  for (const status of [301, 200, 400, 500]) {
    let requestCount = 0;
    const protocol = new PairingProtocol(
      ORIGIN,
      async () => {
        requestCount += 1;
        return new Response(null, { status });
      },
      () => NOW,
    );
    const lease: SetupLease = {
      token: `one-time-token-${status}`,
      expiresAt: NOW + 60_000,
    };

    assert.deepEqual(await protocol.complete(lease, credentials), {
      kind: "rejected",
      retry: false,
    });
    assert.equal((await protocol.complete(lease, credentials)).kind, "replay");
    assert.equal(requestCount, 1);
  }
});

test("complete does not send an expired lease", async () => {
  let requestCount = 0;
  const protocol = new PairingProtocol(
    ORIGIN,
    async () => {
      requestCount += 1;
      return new Response(null, { status: 202 });
    },
    () => NOW,
  );
  const lease: SetupLease = {
    token: "expired-token",
    expiresAt: NOW,
  };

  assert.deepEqual(await protocol.complete(lease, credentials), {
    kind: "expired",
    retry: false,
  });
  assert.equal(requestCount, 0);
});

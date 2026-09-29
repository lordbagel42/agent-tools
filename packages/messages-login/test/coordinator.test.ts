import assert from "node:assert/strict";
import test from "node:test";
import type { GoogleCredentials } from "../src/cookies.js";
import {
  ConnectCoordinator,
  type CredentialAcquisition,
  type PairingOperations,
} from "../src/coordinator.js";
import { PairingProtocol, type SetupLease } from "../src/protocol.js";

const lease: SetupLease = {
  token: "one-time-token",
  expiresAt: 1_900_000_000_000,
};

const cookies: GoogleCredentials = {
  SID: "sid-value",
  HSID: "hsid-value",
  SSID: "ssid-value",
  OSID: "osid-value",
  APISID: "apisid-value",
  SAPISID: "sapisid-value",
};

test("reports a 202 handoff as accepted but not paired and cannot submit twice", async () => {
  let starts = 0;
  let completions = 0;
  const operations: PairingOperations = {
    start: async () => {
      starts += 1;
      return lease;
    },
    complete: async () => {
      completions += 1;
      return { kind: "accepted", paired: false, retry: false };
    },
  };
  const coordinator = new ConnectCoordinator(operations, async () => ({
    kind: "ready",
    cookies,
  }));

  const first = await coordinator.connect();
  assert.equal(first.ok, true);
  assert.match(first.message ?? "", /accepted/i);
  assert.match(first.message ?? "", /not.*paired|pairing.*continues/i);

  const second = await coordinator.connect();
  assert.deepEqual(second, first);
  assert.equal(starts, 1);
  assert.equal(completions, 1);
  assert.deepEqual(Object.keys(first).sort(), ["message", "ok"]);
});

test("does not retry or restart after an ambiguous completion", async () => {
  let starts = 0;
  let completions = 0;
  const operations: PairingOperations = {
    start: async () => {
      starts += 1;
      return lease;
    },
    complete: async () => {
      completions += 1;
      return { kind: "ambiguous", retry: false };
    },
  };
  const coordinator = new ConnectCoordinator(operations, async () => ({
    kind: "ready",
    cookies,
  }));

  const first = await coordinator.connect();
  assert.equal(first.ok, false);
  assert.match(first.message ?? "", /uncertain/i);
  assert.match(first.message ?? "", /not.*retried/i);
  assert.deepEqual(await coordinator.connect(), first);
  assert.equal(starts, 1);
  assert.equal(completions, 1);
});

test("does not replay a definitely rejected completion", async () => {
  let completions = 0;
  const operations: PairingOperations = {
    start: async () => lease,
    complete: async () => {
      completions += 1;
      return { kind: "rejected", retry: false };
    },
  };
  const coordinator = new ConnectCoordinator(operations, async () => ({
    kind: "ready",
    cookies,
  }));

  const first = await coordinator.connect();
  assert.equal(first.ok, false);
  assert.match(first.message ?? "", /rejected/i);
  assert.match(first.message ?? "", /not.*retried/i);
  assert.deepEqual(await coordinator.connect(), first);
  assert.equal(completions, 1);
});

test("allows a fresh start after start fails before a lease is issued", async () => {
  let starts = 0;
  const operations: PairingOperations = {
    start: async () => {
      starts += 1;
      if (starts === 1) {
        throw new Error("private server failure");
      }
      return lease;
    },
    complete: async () => ({ kind: "accepted", paired: false, retry: false }),
  };
  const coordinator = new ConnectCoordinator(operations, async () => ({
    kind: "ready",
    cookies,
  }));

  const first = await coordinator.connect();
  assert.equal(first.ok, false);
  assert.match(first.message ?? "", /start/i);
  assert.doesNotMatch(first.message ?? "", /private server failure/);
  assert.equal((await coordinator.connect()).ok, true);
  assert.equal(starts, 2);
});

test("setup failures expose the HTTP status but never the upstream body", async () => {
  for (const status of [401, 403, 502]) {
    let acquired = false;
    const protocol = new PairingProtocol(
      "https://pairing.example.test",
      async () => new Response("private-cookie server diagnostic", { status }),
    );
    const coordinator = new ConnectCoordinator(protocol, async () => {
      acquired = true;
      return { kind: "cancelled" };
    });
    const result = await coordinator.connect();
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(result.message ?? "", /private-cookie|diagnostic/);
    if (status === 401) {
      assert.match(result.message ?? "", /portal.*session.*expired.*PIN/i);
    } else {
      assert.doesNotMatch(result.message ?? "", /expired|PIN/);
    }
    assert.equal(acquired, false);
  }
});

test("a setup redirect tells the owner to sign back into the portal", async () => {
  for (const fetch of [
    async () => new Response(null, { status: 302 }),
    async () => {
      throw new Error("Redirect was cancelled");
    },
  ]) {
    const protocol = new PairingProtocol("https://pairing.example.test", fetch);
    const coordinator = new ConnectCoordinator(protocol, async () => ({
      kind: "cancelled",
    }));
    const result = await coordinator.connect();
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /portal.*session.*expired/i);
    assert.match(result.message ?? "", /PIN/);
  }
});

test("a network failure stays distinct from an expired portal and hides transport details", async () => {
  const protocol = new PairingProtocol(
    "https://pairing.example.test",
    async () => {
      throw new Error("private transport details");
    },
  );
  const coordinator = new ConnectCoordinator(protocol, async () => {
    assert.fail("Network failure must not start Google sign-in");
  });
  const result = await coordinator.connect();
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /reach.*server/i);
  assert.doesNotMatch(
    result.message ?? "",
    /private|transport details|expired|PIN/,
  );
});

test("allows a new lease after local cancellation or expiry before submission", async () => {
  for (const firstOutcome of [
    { kind: "cancelled" } as const,
    { kind: "expired" } as const,
  ]) {
    let starts = 0;
    let acquisitions = 0;
    let completions = 0;
    const operations: PairingOperations = {
      start: async () => {
        starts += 1;
        return { ...lease };
      },
      complete: async () => {
        completions += 1;
        return { kind: "accepted", paired: false, retry: false };
      },
    };
    const coordinator = new ConnectCoordinator(operations, async () => {
      acquisitions += 1;
      if (acquisitions === 1) {
        return firstOutcome;
      }
      return { kind: "ready", cookies };
    });

    assert.equal((await coordinator.connect()).ok, false);
    assert.equal((await coordinator.connect()).ok, true);
    assert.equal(starts, 2);
    assert.equal(completions, 1);
  }
});

test("rejects concurrent connect calls while one local login is active", async () => {
  let finishAcquisition: ((value: CredentialAcquisition) => void) | undefined;
  const acquisition = new Promise<CredentialAcquisition>((resolve) => {
    finishAcquisition = resolve;
  });
  const operations: PairingOperations = {
    start: async () => lease,
    complete: async () => ({ kind: "accepted", paired: false, retry: false }),
  };
  const coordinator = new ConnectCoordinator(
    operations,
    async () => acquisition,
  );

  const first = coordinator.connect();
  const concurrent = await coordinator.connect();
  assert.equal(concurrent.ok, false);
  assert.match(concurrent.message ?? "", /already.*progress/i);

  assert.ok(finishAcquisition);
  finishAcquisition({ kind: "cancelled" });
  assert.equal((await first).ok, false);
});

test("treats an unexpected completion throw as ambiguous and terminal", async () => {
  let completions = 0;
  const operations: PairingOperations = {
    start: async () => lease,
    complete: async () => {
      completions += 1;
      throw new Error("unknown transport state");
    },
  };
  const coordinator = new ConnectCoordinator(operations, async () => ({
    kind: "ready",
    cookies,
  }));

  const first = await coordinator.connect();
  assert.equal(first.ok, false);
  assert.match(first.message ?? "", /uncertain/i);
  assert.doesNotMatch(first.message ?? "", /unknown transport state/);
  assert.deepEqual(await coordinator.connect(), first);
  assert.equal(completions, 1);
});

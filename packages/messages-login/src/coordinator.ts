import type { GoogleCredentials } from "./cookies.js";
import {
  type HandoffDecision,
  PairingProtocolError,
  type SetupLease,
} from "./protocol.js";

export interface ConnectResult {
  readonly ok: boolean;
  readonly message?: string;
}

export type CredentialAcquisition =
  | { readonly kind: "ready"; readonly cookies: GoogleCredentials }
  | { readonly kind: "cancelled" | "error" | "expired" };

export interface PairingOperations {
  start(): Promise<SetupLease>;
  complete(
    lease: SetupLease,
    cookies: GoogleCredentials,
  ): Promise<HandoffDecision>;
}

export type CredentialAcquirer = (
  lease: SetupLease,
) => Promise<CredentialAcquisition>;

function result(ok: boolean, message: string): ConnectResult {
  return Object.freeze({ ok, message });
}

const BUSY = result(false, "A Google sign-in is already in progress.");
const START_FAILED = result(
  false,
  "Could not start setup. Check the server page and try again.",
);
const CANCELLED = result(
  false,
  "Google sign-in was cancelled. No credentials were sent.",
);
const LOCAL_EXPIRED = result(
  false,
  "The one-time setup token expired. Start a fresh setup from the server page.",
);
const LOGIN_FAILED = result(
  false,
  "Google credentials could not be collected. No credentials were sent.",
);
const ACCEPTED = result(
  true,
  "Credential handoff was accepted. Pairing continues on the server page; this does not mean the phone is paired yet. Approve the matching emoji on your phone.",
);
const AMBIGUOUS = result(
  false,
  "The credential handoff result is uncertain and will not be retried. Check the server page before restarting the helper.",
);
const REJECTED = result(
  false,
  "The server rejected the one-time credential handoff. It will not be retried; start fresh from the server page.",
);
const REPLAY = result(
  false,
  "The one-time credential handoff was already attempted and will not be replayed.",
);

export class ConnectCoordinator {
  readonly #operations: PairingOperations;
  readonly #acquireCredentials: CredentialAcquirer;
  #active = false;
  #terminalResult: ConnectResult | undefined;

  constructor(
    operations: PairingOperations,
    acquireCredentials: CredentialAcquirer,
  ) {
    this.#operations = operations;
    this.#acquireCredentials = acquireCredentials;
  }

  async connect(): Promise<ConnectResult> {
    if (this.#terminalResult !== undefined) {
      return this.#terminalResult;
    }
    if (this.#active) {
      return BUSY;
    }
    this.#active = true;

    try {
      let lease: SetupLease;
      try {
        lease = await this.#operations.start();
      } catch (error) {
        // Only our protocol errors contain safe, locally authored diagnostics.
        // Transport errors and upstream response bodies must stay private.
        return error instanceof PairingProtocolError
          ? result(false, error.message)
          : START_FAILED;
      }

      let acquisition: CredentialAcquisition;
      try {
        acquisition = await this.#acquireCredentials(lease);
      } catch {
        return LOGIN_FAILED;
      }

      switch (acquisition.kind) {
        case "cancelled":
          return CANCELLED;
        case "expired":
          return LOCAL_EXPIRED;
        case "error":
          return LOGIN_FAILED;
        case "ready":
          return await this.#finish(lease, acquisition.cookies);
      }
    } finally {
      this.#active = false;
    }
  }

  async #finish(
    lease: SetupLease,
    cookies: GoogleCredentials,
  ): Promise<ConnectResult> {
    let decision: HandoffDecision;
    try {
      decision = await this.#operations.complete(lease, cookies);
    } catch {
      this.#terminalResult = AMBIGUOUS;
      return AMBIGUOUS;
    }

    switch (decision.kind) {
      case "accepted":
        this.#terminalResult = ACCEPTED;
        return ACCEPTED;
      case "ambiguous":
        this.#terminalResult = AMBIGUOUS;
        return AMBIGUOUS;
      case "rejected":
        this.#terminalResult = REJECTED;
        return REJECTED;
      case "replay":
        this.#terminalResult = REPLAY;
        return REPLAY;
      case "expired":
        return LOCAL_EXPIRED;
    }
  }
}

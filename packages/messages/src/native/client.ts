import {
  createECDH,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateGoogleCookies } from "../google-cookies.js";
import type { NativePairingClient, PairingStatus } from "../native-pairing.js";
import {
  ApiError,
  type ConversationList,
  type MessageList,
  type MessagesClient,
  type SendReceipt,
  type SendRequest,
  type SessionStatus,
} from "../types.js";
import {
  parseConversationId,
  parseLimit,
  parseSendRequest,
} from "../validation.js";
import {
  deriveKeys,
  Handshake,
  open,
  type RequestKeys,
  seal,
  verificationEmoji,
} from "./crypto.js";
import { type Fetch, GoogleHttp, userAgent } from "./http.js";
import { SessionStore } from "./store.js";
import { array, decode, encode, PbliteStream, type Proto } from "./wire.js";

type SavedSession = {
  version: 1;
  cookies: Record<string, string>;
  refreshKey: string;
  deviceId: string;
  configVersion: unknown[];
  browser: unknown[];
  mobile: unknown[];
  destination: string;
  token: string;
  ttl: string;
  expiresAt: number;
  pairingId?: string;
  keys?: { aes: string; hmac: string };
};
type Pending = {
  action: number;
  resolve(value: Proto): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
};
const disconnected = () =>
  new ApiError(
    503,
    "PHONE_DISCONNECTED",
    "The phone connection was lost. Do not automatically retry a send.",
  );
const revoked = () =>
  new ApiError(
    401,
    "PAIRING_REVOKED",
    "The phone session was revoked. Sign in and pair again.",
  );
const uuid = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;
const timestamp = (microseconds: bigint): string | null => {
  const millis = Number(microseconds / 1000n);
  return microseconds > 0 && Number.isSafeInteger(millis) && millis <= 8.64e15
    ? new Date(millis).toISOString()
    : null;
};

/** One phone session, owned by one server process. No browser is used at runtime. */
export class NativeClient implements MessagesClient, NativePairingClient {
  private session: SavedSession | undefined;
  private http: GoogleHttp | undefined;
  private keys: RequestKeys | undefined;
  private view: PairingStatus = { state: "needs_login" };
  private connected = false;
  private closed = false;
  private readonly abort = new AbortController();
  private task: Promise<void> = Promise.resolve();
  private activeSession = randomUUID();
  private firstList = true;
  private lastActivity = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly acks = new Set<string>();
  private readonly seen = new Set<string>();
  private sims: Proto[] = [];

  private constructor(
    private readonly store: SessionStore,
    private readonly fetcher: Fetch | undefined,
  ) {}

  static async open(
    directory: string,
    options: { fetch?: Fetch } = {},
  ): Promise<NativeClient> {
    const store = await SessionStore.open(directory);
    try {
      const client = new NativeClient(store, options.fetch);
      const saved = (await store.load()) as SavedSession | null;
      if (saved && saved.version !== 1)
        throw new Error("Unsupported saved Messages session");
      if (saved?.keys) {
        client.keys = {
          aes: Buffer.from(saved.keys.aes, "base64"),
          hmac: Buffer.from(saved.keys.hmac, "base64"),
        };
        if (client.keys.aes.length !== 32 || client.keys.hmac.length !== 32)
          throw new Error("Invalid saved Messages keys");
        client.session = saved;
        client.start(false);
      }
      return client;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async status(): Promise<SessionStatus> {
    return {
      state: this.closed
        ? "closed"
        : this.keys
          ? this.connected
            ? "paired"
            : "starting"
          : "pairing_required",
      transport: "native",
      connected: this.connected,
    };
  }
  pairingStatus(): PairingStatus {
    return { ...this.view };
  }
  async pairingQr(): Promise<Buffer | null> {
    return null;
  }

  async beginPairing(cookies: Record<string, string>): Promise<void> {
    if (this.closed) throw disconnected();
    if (["connecting", "awaiting_phone", "paired"].includes(this.view.state))
      throw new ApiError(
        409,
        "PAIRING_BUSY",
        "This session is already connecting or paired.",
      );
    const validated = validateGoogleCookies(cookies);
    this.view = { state: "connecting" };
    await this.task;
    if (this.closed) throw disconnected();
    const refresh = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.keys = undefined;
    this.session = {
      version: 1,
      cookies: validated,
      refreshKey: refresh.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      deviceId: "",
      configVersion: [],
      browser: [],
      mobile: [],
      destination: "",
      token: "",
      ttl: "0",
      expiresAt: 0,
    };
    this.acks.clear();
    this.seen.clear();
    this.sims = [];
    this.firstList = true;
    this.start(true);
  }

  private start(pair: boolean) {
    this.view = { state: "connecting" };
    this.task = this.run(pair)
      .catch(async (error: unknown) => {
        this.connected = false;
        this.cancelRequests();
        if (
          error instanceof ApiError &&
          ["GOOGLE_LOGIN_REQUIRED", "PAIRING_REVOKED"].includes(error.code)
        ) {
          this.keys = undefined;
          this.session = undefined;
          await this.store.save(null);
        }
        if (!this.closed)
          this.view = {
            state: "error",
            error:
              error instanceof ApiError
                ? error.message
                : "The Messages connection could not be established. Try signing in again.",
          };
      })
      .catch(() => {
        if (!this.closed)
          this.view = {
            state: "error",
            error:
              "The encrypted session could not be saved. Check the server's private storage.",
          };
      });
  }

  private get context(): { session: SavedSession; http: GoogleHttp } {
    if (!this.session || !this.http) throw disconnected();
    return { session: this.session, http: this.http };
  }
  private auth(id: string = randomUUID(), network = true): unknown[] {
    const { session } = this.context;
    return [
      id,
      null,
      network ? "GDitto" : null,
      null,
      null,
      session.token || null,
      session.configVersion,
    ];
  }
  private updateToken(value: unknown) {
    const data = array(value);
    const ttl = String(data[1]);
    if (
      typeof data[0] !== "string" ||
      !data[0] ||
      !/^\d+$/.test(ttl) ||
      !Number.isSafeInteger(Number(ttl)) ||
      Number(ttl) < 1_000_000
    )
      throw new Error("Invalid relay token response");
    Object.assign(this.context.session, {
      token: data[0],
      ttl,
      expiresAt: Date.now() + Number(ttl) / 1000,
    });
  }

  private async signIn() {
    const { session, http } = this.context;
    const publicKey = createPublicKey(session.refreshKey).export({
      type: "spki",
      format: "der",
    });
    const inner = Array<unknown>(36).fill(null);
    inner[0] = [3, `messages-web-${session.deviceId.replaceAll("-", "")}`];
    inner[35] = encode({ 3: publicKey }).toString("base64");
    const response = await http.rpc(
      "SignInGaia",
      [this.auth(), inner, null, "GDitto"],
      this.abort.signal,
    );
    const devices = array(response[2]);
    const browser = array(array(devices[0])[0]);
    if (typeof browser[1] !== "string" || browser[2] !== "GDitto")
      throw new Error("Invalid relay device");
    const primary = array(devices[1] ?? [])
      .map(array)
      .filter((d) => Number(d[3]) === 1);
    if (primary.length !== 1)
      throw new ApiError(
        409,
        "PHONE_SELECTION_REQUIRED",
        "Google must report exactly one primary phone. Check the account and Device pairing on your phone.",
      );
    const destination = Buffer.from(String(primary[0]?.[0]), "base64").toString(
      "utf8",
    );
    if (!uuid.test(destination))
      throw new Error("Invalid phone registration ID");
    Object.assign(session, {
      browser,
      mobile: [browser[0], browser[1].toLowerCase(), browser[2]],
      destination: destination.toLowerCase(),
    });
    this.updateToken(response[3]);
    await this.store.save(session);
  }

  private async refresh(signal = this.abort.signal) {
    const { session, http } = this.context;
    if (session.expiresAt - Date.now() > 10 * 60_000) return;
    const id = randomUUID();
    const microseconds = Date.now() * 1000;
    const signature = sign(
      "sha256",
      Buffer.from(`${id}:${microseconds}`),
      session.refreshKey,
    ).toString("base64");
    const parameters = Array<unknown>(9).fill(null);
    parameters[8] = [];
    const request = Array<unknown>(16).fill(null);
    request[0] = this.auth(id);
    request[1] = session.browser;
    request[2] = microseconds;
    request[3] = signature;
    request[12] = parameters;
    request[15] = 2;
    const response = await http.rpc("RegisterRefresh", request, signal);
    this.updateToken(response[1]);
    await this.store.save(session);
  }

  private async pairPhone() {
    const key = createECDH("prime256v1");
    key.generateKeys();
    const handshake = new Handshake(key, randomBytes(32));
    const id = randomUUID();
    const started = Date.now();
    const common = {
      1: id,
      2: encode({ 1: userAgent, 2: 2, 3: "Linux", 6: 1 }),
      3: started,
    };
    const init = await this.request(
      44,
      encode({ ...common, 4: handshake.init, 5: 1, 6: 1 }),
      30_000,
    );
    if (init.int(1) !== 0n || init.int(2) !== 0n)
      throw new ApiError(
        409,
        "PHONE_PAIRING_REJECTED",
        "The phone rejected pairing. Open Device pairing and try again.",
      );
    const derived = handshake.receive(init.bytes(5));
    const keys = deriveKeys(derived.nextKey, Number(init.int(7)));
    const emoji = verificationEmoji(derived.auth, Number(init.int(6)));
    this.view = { state: "awaiting_phone", emoji };
    const confirmation =
      "This is an undocumented API. Use or access of undocumented Google APIs without express authorization is prohibited per the Google API Terms of Service (https://developers.google.com/terms).";
    const finish = await this.request(
      45,
      encode({ ...common, 4: handshake.finish, 8: confirmation }),
      180_000,
    );
    if (finish.int(1) !== 0n || finish.int(2) !== 0n)
      throw new ApiError(
        409,
        "PHONE_PAIRING_REJECTED",
        "The phone did not approve the matching emoji. Start pairing again.",
      );
    const { session } = this.context;
    session.pairingId = id;
    session.keys = {
      aes: keys.aes.toString("base64"),
      hmac: keys.hmac.toString("base64"),
    };
    await this.store.save(session);
    this.keys = keys;
    this.view = { state: "connecting" };
  }

  private async run(pair: boolean) {
    if (!this.session) throw disconnected();
    this.http = new GoogleHttp(
      this.session.cookies,
      () => this.store.save(this.session),
      this.fetcher,
    );
    let prepared = false;
    let backoff = 1000;
    while (!this.closed) {
      const connection = new AbortController();
      const signal = AbortSignal.any([this.abort.signal, connection.signal]);
      let stream: Promise<void> | undefined;
      let maintenance: Promise<void> | undefined;
      try {
        if (!prepared) {
          const config = await this.http.prepare(signal);
          Object.assign(this.session, {
            deviceId: config.deviceId,
            configVersion: config.version,
          });
          if (pair) await this.signIn();
          prepared = true;
        }
        await this.refresh(signal);
        const response = await this.http.receive(
          [this.auth(), null, null, [null, []]],
          signal,
        );
        if (!response.body) throw disconnected();
        stream = this.consume(response.body);
        void stream.catch(() => undefined);
        if (pair) {
          await Promise.race([
            this.pairPhone(),
            stream.then(() => {
              throw disconnected();
            }),
          ]);
          pair = false;
        }
        await this.activate();
        maintenance = this.maintain(signal);
        await Promise.race([stream, maintenance]);
      } catch (error) {
        if (this.closed) return;
        if (
          pair ||
          (error instanceof ApiError &&
            ["GOOGLE_LOGIN_REQUIRED", "PAIRING_REVOKED"].includes(error.code))
        )
          throw error;
        if (this.connected) backoff = 1000;
      } finally {
        connection.abort();
        this.connected = false;
        this.cancelRequests();
        await Promise.allSettled([stream, maintenance]);
      }
      this.view = { state: "connecting" };
      await delay(backoff, undefined, { signal: this.abort.signal });
      backoff = Math.min(backoff * 2, 30_000);
    }
  }

  private async activate() {
    this.activeSession = randomUUID();
    this.firstList = true;
    await this.transmit(16, undefined, this.activeSession);
  }
  private async maintain(signal: AbortSignal) {
    while (!signal.aborted) {
      await delay(30_000, undefined, { signal });
      await this.refresh(signal);
      if (Date.now() - this.lastActivity > 90_000) {
        this.connected = false;
        this.view = { state: "connecting" };
        await this.activate();
      } else await this.transmit(22, encode({ 2: 1 }));
    }
  }

  private async consume(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new PbliteStream();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          decoder.finish();
          return;
        }
        for (const frame of decoder.push(value))
          if (Array.isArray(frame[1])) await this.receive(frame[1]);
        await this.flushAcks();
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      this.cancelRequests();
    }
  }

  private async flushAcks() {
    if (!this.acks.size) return;
    const { session, http } = this.context;
    const ids = [...this.acks];
    await http.rpc(
      "AckMessages",
      [this.auth(), [], null, ids.map((id) => [id, session.browser])],
      this.abort.signal,
    );
    for (const id of ids) this.acks.delete(id);
  }
  private async receive(envelope: unknown[]) {
    const responseId = envelope[0];
    if (typeof responseId !== "string" || typeof envelope[11] !== "string")
      return;
    this.acks.add(responseId);
    if (this.acks.size > 1024)
      throw new Error("Too many unacknowledged relay messages");
    if (this.seen.has(responseId)) return;
    this.seen.add(responseId);
    if (this.seen.size > 1024)
      this.seen.delete(this.seen.values().next().value as string);
    const packet = decode(Buffer.from(envelope[11], "base64"));
    if (envelope[1] === 14 && packet.has(5)) throw revoked();
    if (envelope[1] !== 19) return;
    const id = packet.text(1);
    const action = Number(packet.int(4));
    const encrypted = packet.has(8) || packet.has(11);
    // Plaintext relay intermediates are not phone acceptance, even with the same request UUID.
    if (!encrypted && action !== 44 && action !== 45) return;
    if (encrypted && !this.keys) return;
    const data =
      encrypted && this.keys
        ? decode(open(packet.bytes(packet.has(8) ? 8 : 11), this.keys))
        : decode(packet.bytes(5));
    if (encrypted) this.lastActivity = Date.now();
    if (packet.has(11) && data.has(2) && data.message(2).int(2) === 0n)
      throw revoked();
    const pending = this.pending.get(id);
    if (pending && pending.action === action) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve(data);
    } else if (encrypted && action === 16) {
      if (data.has(15) && data.message(15).int(2) === 0n) throw revoked();
      if (data.has(5) && data.message(5).has(2))
        this.sims = data.message(5).messages(2);
      const alert = data.message(6).int(2);
      if (id === this.activeSession && alert === 2n) {
        this.connected = true;
        this.view = { state: "paired" };
      }
      if ([1n, 7n, 8n].includes(alert) && id === this.activeSession) {
        this.connected = false;
        this.view = { state: "connecting" };
      }
      if (data.has(7)) await this.transmit(17);
    }
  }

  private async transmit(
    action: number,
    data?: Buffer,
    id: string = randomUUID(),
    type = 2,
  ) {
    if (this.closed) throw disconnected();
    const { session, http } = this.context;
    const plain = action === 44 || action === 45;
    if (!plain && !this.keys) throw disconnected();
    const payload = data
      ? plain
        ? { 3: data }
        : { 5: seal(data, this.keys as RequestKeys) }
      : {};
    const packet = encode({
      1: id,
      2: action,
      ...payload,
      6: this.activeSession,
    });
    const wrapper = Array<unknown>(23).fill(null);
    wrapper[0] = id;
    wrapper[1] = 19;
    wrapper[11] = packet.toString("base64");
    wrapper[22] = [[], action === 44 ? 20 : type];
    await http.rpc(
      "SendMessage",
      [
        session.mobile,
        wrapper,
        this.auth(id, false),
        null,
        action === 16 ? null : plain ? 300_000_000 : session.ttl,
        null,
        null,
        null,
        [Buffer.from(session.destination).toString("base64")],
      ],
      this.abort.signal,
    );
  }
  private request(
    action: number,
    data: Buffer,
    timeout = 60_000,
    type = 2,
  ): Promise<Proto> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const rejectRequest = (error: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      };
      const timer = setTimeout(
        () =>
          rejectRequest(
            new ApiError(
              504,
              "PHONE_TIMEOUT",
              "The phone did not reply in time. A send may still be processed; do not retry automatically.",
            ),
          ),
        timeout,
      );
      this.pending.set(id, { action, resolve, reject, timer });
      void this.transmit(action, data, id, type).catch(rejectRequest);
    });
  }
  private cancelRequests() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(disconnected());
    }
    this.pending.clear();
  }
  private requirePhone() {
    if (!this.keys)
      throw new ApiError(
        409,
        "PAIRING_REQUIRED",
        "Use the private pairing page to connect your phone first.",
      );
    if (!this.connected || this.closed) throw disconnected();
  }

  async listConversations(limit: number): Promise<ConversationList> {
    this.requirePhone();
    parseLimit(limit);
    const type = this.firstList ? 16 : 2;
    this.firstList = false;
    const response = await this.request(
      1,
      encode({ 2: limit, 4: 1 }),
      60_000,
      type,
    );
    const conversations = response.messages(2).map((c) => ({
      id: c.text(1),
      name: c.text(2),
      snippet: c.message(4).text(1),
      timestamp: timestamp(c.int(5)),
      unread: c.int(6) !== 0n,
    }));
    return {
      conversations: conversations.slice(0, limit),
      limited: conversations.length >= limit,
    };
  }
  async readMessages(id: string, limit: number): Promise<MessageList> {
    this.requirePhone();
    parseConversationId(id);
    parseLimit(limit);
    const response = await this.request(2, encode({ 2: id, 3: limit }));
    const data = response.messages(2);
    if (data.some((m) => m.text(7) !== id))
      throw new Error("Phone returned messages for a different conversation");
    data.sort((a, b) =>
      a.int(5) < b.int(5) ? -1 : a.int(5) > b.int(5) ? 1 : 0,
    );
    return {
      conversationId: id,
      coverage: "recent",
      order: "oldest-first",
      messages: data.slice(-limit).map((m) => {
        const status = m.message(4).int(2);
        return {
          id: m.text(1) || null,
          direction:
            status >= 100n && status <= 118n
              ? "incoming"
              : status >= 1n && status <= 27n
                ? "outgoing"
                : "unknown",
          text: m
            .messages(10)
            .filter((info) => info.has(2))
            .map((info) => info.message(2).text(1))
            .join("\n"),
          timestamp: timestamp(m.int(5)),
        };
      }),
    };
  }
  async sendText(request: SendRequest): Promise<SendReceipt> {
    this.requirePhone();
    const { conversationId, text } = parseSendRequest(request);
    const conversation = (
      await this.request(43, encode({ 1: conversationId }))
    ).message(1);
    if (conversation.text(1) !== conversationId || conversation.int(13) !== 0n)
      throw new ApiError(
        404,
        "CONVERSATION_NOT_FOUND",
        "The exact writable conversation was not returned by the phone. Nothing was sent.",
      );
    const participant = conversation.text(11);
    const sims = this.sims.filter(
      (sim) => sim.message(7).text(1) === participant && sim.message(5).has(1),
    );
    if (!participant || sims.length !== 1)
      throw new ApiError(
        409,
        "SIM_UNAVAILABLE",
        "The phone has not supplied an unambiguous outgoing SIM for this conversation. Nothing was sent.",
      );
    const sim = sims[0]?.message(5).bytes(1) as Buffer;
    const temporary = randomUUID();
    const content = encode({ 1: text });
    const payload = encode({
      1: temporary,
      7: conversationId,
      9: participant,
      10: encode({ 2: content }),
      12: temporary,
    });
    const result = await this.request(
      3,
      encode({ 2: conversationId, 3: payload, 4: sim, 5: temporary }),
    );
    if (result.int(3) !== 1n)
      throw new ApiError(
        502,
        "SEND_REJECTED",
        "The phone did not confirm submission. Check it before sending again.",
      );
    return {
      conversationId,
      status: "submitted",
      delivery: "unconfirmed",
      submittedAt: new Date().toISOString(),
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.abort.abort();
    this.cancelRequests();
    await this.task;
    await this.store.close();
  }
}

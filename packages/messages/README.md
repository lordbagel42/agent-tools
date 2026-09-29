# @agent-tools/messages

A **server-side TypeScript API** for pairing an Android phone, listing conversations, reading recent texts, and sending text to an existing conversation. The default transport talks to Google's relay directly. It needs no Chromium, desktop, or always-on laptop after setup. The Android phone must stay online.

**Unofficial and experimental.** This uses Google's undocumented Messages protocol, not a supported SMS API or Messages-only OAuth grant. Google can change or restrict it, and its private-API terms apply. Use only your own account/phone and recipients who expect your messages. Normal carrier charges and SMS length limits apply.

**Verification:** offline tests cover cryptography, a simulated phone handshake, read/send envelopes, encrypted phone confirmation, reconnects, token renewal, session persistence, and the helper/HTTP boundaries. Server startup works without a browser. **Real Google login, phone pairing, reading, and sending are not yet verified.** Reaching a login form or passing a simulated-phone test does not prove those work with an account.

## Start the server

Node.js 20.19+ is required for the API. Node.js 22.12+ is required to build/run the one-time helper; use that version throughout for convenience.

```sh
# From the agent-tools repository root (one workspace lockfile):
npm ci
npm run build --workspace @agent-tools/messages
npm run bundle --workspace @agent-tools/messages-login
PUBLIC_URL=https://pairing.example.com npm start --workspace @agent-tools/messages -- --pairing-port 8788
```

The standard npm executable is `messages` (no Amp plugin manifest is required). The Electron companion is a separate workspace, not a CLI or plugin. Its generated archive must be built in the sibling `packages/messages-login` directory before the pairing page can offer the download. Commands below run from `packages/messages` unless stated otherwise; the default `.local` state directory is relative to the process working directory.

The bearer API listens on **127.0.0.1:8787**, and the separate pairing page on **127.0.0.1:8788**. Place only the pairing port behind an authenticated HTTPS proxy. `PUBLIC_URL` must match its origin. The pairing listener has **no built-in login**; the proxy must protect every route, including `/status`, `/helper.zip`, and `/connect/*`.

`localhost` on your laptop is not the server. Do not publicly expose the text API or a Chrome debugging port. Server tools can use the loopback API; remote API access needs a separately secured connection such as an SSH tunnel.

## Pair once from your computer

QR is not required. The phone must use the same Google account as the helper.

1. Open the private pairing page and download/unzip its **local login helper** on a desktop computer with Node.js 22.12+.
2. In the extracted `messages-login-helper` folder, run `npm install`, then `npm start -- https://pairing.example.com`.
3. Complete the portal's PIN login in the helper and choose **Sign in locally with Google**. Google sign-in opens in a separate local window, not a remote screenshot. The helper does not access your existing browser profile.
4. Verify the destination in the native consent dialog before transferring credentials. **These are broad Google Account session cookies, not Messages-only tokens.** The server retains them to maintain the connection. Only use a server you control and trust.
5. Open Google Messages → profile menu → **Device pairing** on the phone. Approve only the emoji matching the pairing page.
6. Wait for **Your phone is connected**. You can then close the helper and laptop. Leave the server running and the Android phone online.

Never send passwords, cookies, or API tokens in chat. If Google refuses the helper's sign-in, stop and report the displayed error; do not disable account protections. A successful credential handoff is not yet phone pairing.

After pairing, restart the server with the same state directory:

```sh
npm start
# Or keep the private setup/status page available:
npm start -- --pairing-port 8788
```

One process owns each native state directory. A second process is rejected by a renewable filesystem lock. After an unclean exit, the lock can take about 30 seconds to expire. The preview process is not an installed production service; use your own service manager for permanent operation.

## HTTP API

A random token is stored in `.local/api-token` with mode `0600`. Every `/v1/*` request needs `Authorization: Bearer <token>`. Browser-origin requests are rejected; use server tooling or a CLI. Never put the token in a URL or enable shell tracing around it.

| Method | Route | Native behavior |
| --- | --- | --- |
| GET | `/health` | Process liveness, not phone readiness |
| GET | `/v1/status` | State, `transport: "native"`, and `connected` |
| GET | `/v1/conversations?limit=50` | Inbox IDs, names, snippets, ISO timestamps, unread flags |
| GET | `/v1/conversations/:id/messages?limit=50` | Recent messages, oldest first; no read-receipt RPC |
| POST | `/v1/messages` | `{ "conversationId": "…", "text": "…" }`; `Idempotency-Key` required |
| GET | `/v1/pairing/qr` | 409 in native mode; retained for legacy browser mode |

Limits are integers from 1 to 200. Text must be nonblank and at most 10,000 UTF-16 code units. Sending requires an exact existing conversation and an unambiguous outgoing SIM reported by the phone. No fuzzy contact lookup or new-number destination guessing.

```bash
# Bash, on the server; do not run with set -x.
auth=(-H "Authorization: Bearer $(cat .local/api-token)")
curl --fail-with-body "${auth[@]}" http://127.0.0.1:8787/v1/status
curl --fail-with-body "${auth[@]}" 'http://127.0.0.1:8787/v1/conversations?limit=20'
# Replace 123 with the intended ID from that list.
curl --fail-with-body "${auth[@]}" 'http://127.0.0.1:8787/v1/conversations/123/messages?limit=20'

# This sends a real text. Choose the destination and exact text deliberately.
key=$(node -p 'crypto.randomUUID()')
curl --fail-with-body "${auth[@]}" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $key" \
  --data '{"conversationId":"123","text":"An owner-approved message"}' \
  http://127.0.0.1:8787/v1/messages
```

A successful send returns HTTP 202 with `{ "conversationId": "123", "status": "submitted", "delivery": "unconfirmed", "submittedAt": "…" }`. **Submitted means the phone returned an encrypted success response**, not just that Google's relay accepted the request. It is still not proof of carrier or recipient delivery.

### An uncertain send must not be retried with a new key

Persist the idempotency key with the request. Repeating a completed key/body replays its receipt without sending again; a changed body returns `IDEMPOTENCY_CONFLICT`. The ledger reserves the key **before** any attempt. A timeout, crash, or uncertain phone result remains reserved and returns `SEND_UNCERTAIN` on reuse. Even pre-send failures conservatively leave a reservation. **Never automatically generate a new key or delete ledger files after an error.** Check the phone before deliberately initiating another send.

Errors use `{ "error": { "code": "…", "message": "…" } }`. Common native errors include `PAIRING_REQUIRED`, `PHONE_DISCONNECTED`, `PHONE_TIMEOUT`, `CONVERSATION_NOT_FOUND`, and `SIM_UNAVAILABLE`. Diagnostics never include Google's response bodies, cookies, or message content.

## TypeScript and private state

`NativeClient.open('.local/native')` exposes typed `status`, `listConversations`, `readMessages`, `sendText`, and `close` methods. Startup reconnects asynchronously; wait for `status().connected` before reads/sends. Do not open it against an already-running server's state. Use the HTTP API or `SendLedger.execute(key, request, () => client.sendText(request))` for durable duplicate-attempt protection; the low-level client alone does not provide idempotency.

- `.local/native/session.enc` holds Google cookies, relay credentials, and pairing keys in an AES-256-GCM authenticated envelope. `.local/native/session.key` is the local encryption key. Private directories use mode `0700`; credential files use `0600`. **Encryption does not protect against server root or someone who can read both files.** Protect the host and backups.
- `.local/sends/` stores hashed keys/request fingerprints and receipts, not message bodies. Preserve it across restarts. The API does not maintain a separate message archive.
- To revoke access, remove this paired device in Google Messages and sign out the session in Google Account security settings. Stop the API before removing its local native state. Deleting only local files does not revoke Google's credentials.
- `paired`/`connected` reflects a recent authenticated phone event, not a delivery guarantee. Expired/revoked Google sessions require another local sign-in. Read transport reconnects with bounded backoff; sends are never automatically replayed.
- Results use `coverage: "recent"`, not a complete history export. Unknown timestamps/directions remain `null`/`unknown`. Attachment-only messages can have empty text; attachments are not downloaded. `limited: false` is not a completeness guarantee.
- Group sending, archives/spam, attachments, new-recipient creation, delivery receipts, Google Fi sync, and multi-account/multi-phone selection have no dedicated support. Another active Messages web session may interrupt this one.

## Legacy browser mode and checks

The old Playwright implementation is opt-in with `--browser`; `--headed`, `--legacy-qr`, and `--web-login` also select it. It needs Chromium (`CHROME_PATH` or `npx playwright install chromium`). It uses only `.local/profile`, never your personal profile. Google may reject remote-browser login, so it is not the recommended setup path. Browser reads can mark messages read and use `coverage: "visible"`; browser `submitted` means an additional matching outgoing bubble appeared, not phone acceptance.

```sh
npm run format
npm run lint
npm run check
npm test                         # Native fixtures + legacy browser fixtures; no real texts
npm run test --workspace @agent-tools/messages-login
npm run bundle --workspace @agent-tools/messages-login
npm run test:live                # Legacy public sign-in/QR smoke only; no account login
```

Browser tests honor `CHROME_PATH`. They never use the real `.local/profile`. See [protocol and security design](docs/architecture.md) and the [helper instructions](../messages-login/README.md).

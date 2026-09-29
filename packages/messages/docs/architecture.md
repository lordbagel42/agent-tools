# Google Messages API design

## The phone remains the messaging endpoint

Google Messages for Web is a paired client of the Android app, not a public SMS REST service. Google relays encrypted RPCs; the phone reads its message database and submits SMS/RCS. A successful relay request does not prove the phone accepted a send, and phone acceptance does not prove delivery.

The default implementation is a TypeScript native client. The previous Playwright transport remains opt-in for compatibility. A one-time local helper transfers the required Google session cookies with explicit consent and disclosure that these are broad account credentials. There is no ongoing desktop dependency.

```text
One-time setup:
Local helper → Google's sign-in → explicit consent → private HTTPS pairing listener
                                                          ↓
                                                Server ↔ phone emoji approval

Runtime:
Server tool → loopback bearer API → encrypted RPCs → Google relay ↔ Android phone
```

## Login and storage boundaries

The local Electron helper has two independent nonpersistent sessions. Its portal window handles the ordinary proxy/PIN login, including HTTPS form submission on a separate login origin reached through the proxy's redirect. It permits navigation within the current HTTPS origin or back to the configured server, not an unrelated site. A narrow sandboxed preload exposes only `messagesHelper.connect()`; the main process verifies the exact configured HTTPS origin, top frame, and window for every IPC request. The proxy's login page cannot invoke that operation. Google's sign-in window has no preload or Node access. Neither window attaches to the owner's existing browser profile or uses an automation driver.

The helper obtains a 15-minute setup capability, opens the fixed Google AccountChooser URL with a Messages config continuation, and reads only SID, HSID, SSID, OSID, APISID, SAPISID, and optional __Secure-1PSIDTS. A native consent dialog names the destination and broad-account risk. Cookies go directly from the main process to the exact server origin, never through portal JavaScript. API redirects and TLS failures are rejected. A possibly submitted handoff is not retried automatically. Google may still reject this login environment; account compatibility remains unverified.

The server's pairing listener serves only setup, status, and the helper package. It requires same-origin HTTPS JSON POSTs and consumes a random single-use capability before calling the backend. It exposes no texts, send actions, API token, arbitrary URLs, browser controls, or JavaScript execution. **An external authenticated HTTPS proxy must protect the entire listener.** Loopback binding and Host/Origin checks are not a replacement for proxy authentication.

Session cookies, relay tokens, the refresh signing key, and confirmed pairing keys are stored in an authenticated AES-256-GCM envelope. Writes are serialized, atomic, and fsynced. A renewable filesystem lock prevents two server processes from using one native session. The local key/file permissions protect against accidental disclosure, not host root or another process with equivalent filesystem access. No message archive is written. Runtime credentials may rotate and are saved before continuing.

Revoke both the Google Account session and the Messages paired device. Local file deletion alone does not revoke access. The earlier dedicated browser profile is separate and is not imported or deleted by native setup.

## Wire protocol and lifecycle

`GoogleHttp` uses fixed Messages and `instantmessaging-pa.clients6.google.com` HTTPS origins. It discovers Google's public relay API key from the welcome page's `A16fYe` configuration and the current client version/device UUID from `/web/config`. It signs cookie-authenticated requests with SAPISIDHASH, preserves rotated cookies, refuses redirects, bounds responses, and does not retry POSTs internally.

`Registration/SignInGaia` registers a P-256 refresh public key as SPKI inside binary protobuf field 36. The client requires exactly one primary phone registration rather than guessing among devices. It opens `Messaging/ReceiveMessages` before the unencrypted client-init/client-finished actions 44/45. UKEY2 binds the ephemeral P-256 keys to the SHA-512 finish commitment and handshake transcript. The server negotiates the verification-emoji table and key derivation version; an unknown version fails closed. **Only successful phone emoji confirmation permits saving final pairing keys.**

Messaging uses numeric-field protobuf inside PBLite envelopes. Int64 values remain BigInt or decimal strings; UUID destinations are Base64 of canonical UUID text. Requests use AES-256-CTR with a random IV followed by HMAC-SHA256; authentication is verified before decryption. The receive parser handles fragmented UTF-8/JSON frames with a size bound. Responses are correlated by request UUID and action. Plaintext relay intermediates are ignored except for pairing actions; outer response IDs are acknowledged separately and duplicate frames are bounded/deduplicated.

The server renews relay credentials using `RegisterRefresh`, a microsecond timestamp, and a P-256 ECDSA signature over `requestUUID:timestamp`. Receive failures reconnect with a 1–30 second backoff. Startup configuration outages also retry for an already paired session. A fresh GET_UPDATES session obtains the browser-active alert and SIM settings. Presence requests are answered and activity probes keep the phone session alive. Disconnects reject outstanding requests rather than replaying them. Revoked credentials/pairing invalidate saved state and require local sign-in again. `/health` only means the process is alive.

## Reads and sends

Inbox listing and recent-message reads are explicit phone RPCs. Reads do not issue MESSAGE_READ. Timestamps are decoded from microseconds to ISO strings; direction comes from the phone's status enum, not text matching. These are limited recent results, not a complete history export. Attachments are not downloaded.

Sending first fetches the exact conversation and refuses a mismatch or read-only thread. Its self participant must match one unambiguous SIM from phone settings. The send carries one temporary UUID in all three required fields. Only the correlated encrypted phone response with success status produces `submitted`; delivery remains `unconfirmed`.

The HTTP API retains its durable send ledger. Before any attempt it reserves a hashed idempotency key and body fingerprint. Completed requests replay their receipt; different bodies conflict. A lost/uncertain result keeps the reservation, including across server restarts. The native transport never automatically replays a send. This prevents duplicate attempts, not every possible duplicate in Google's or a carrier's network. Low-level SDK callers must use the ledger themselves.

## Research sources and verification limits

Protocol research on 2026-09-25 used:

- [Google's Messages pairing instructions](https://support.google.com/messages/answer/7611075?hl=en): same Google account and phone emoji confirmation; QR is no longer available in the US.
- Google's live `/web/welcome`, `/web/config`, and public web-client JavaScript: current configuration and relay behavior.
- [mautrix/gmessages protocol definitions and client](https://github.com/mautrix/gmessages/tree/caaeaa7d8d56b828c225cb1f1ad2d15c8a3f1d0d/pkg/libgm) (AGPL-licensed): field numbers, ordering, emoji lookup data, key versions, ACK/token/presence semantics, and phone actions. Per the original implementation documentation, no implementation code was copied and its Go runtime is not included. The TypeScript implementation is independent; the compatibility constants reflect the protocol. This provenance statement is not a license grant or a legal assessment.
- [mautrix account authentication documentation](https://docs.mau.fi/bridges/go/gmessages/authentication.html) and its local webview helper approach informed the one-time credential handoff.

Tests compare cryptography against independent NIST/Python/P-256 vectors and exercise actual encoded requests against a simulated phone. They cover confirmation gating, signed refresh, out-of-order replies, encrypted send acceptance versus plaintext intermediates, uncertain-send persistence, disconnect/restart/revocation, private storage, helper IPC/origin/capability boundaries, and a browser-free server startup. Synthetic UI checks cover desktop/mobile setup, helper, emoji, success, and failure states. Legacy browser tests continue using disposable fixtures, not the owner's profile.

These checks are not proof of live Google compatibility. Real sign-in, phone-backed pairing/reads, and an exact owner-approved text remain necessary before claiming the original goal is met. No real text is sent by setup or tests.

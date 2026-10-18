# Email inboxes and MCP

A separately deployed Cloudflare Email Worker for a dedicated domain, with a
shared `inbox@example.com`, persistent client-created addresses, authenticated
inbox-scoped MCP, optional forwarding, and signed incoming-mail webhooks.
It does not compose outbound mail, configure routing, change
DNS, provision credentials, or install itself when loaded or built.

## Routing: read this before deploying

Cloudflare Email Routing's current API supports **`literal` and `all` matchers**,
not prefix glob or regex rules. `mcp-*@example.com` is not a prefix rule.
Verified against the zone rule creation schema and account rules/plan schema on
2026-10-17. See [routing rules API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/)
and [catch-all documentation](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/).

For arbitrary aliases, route a dedicated apex domain's catch-all to this Worker.
Subdomain catch-all is currently unsupported ([Cloudflare documentation](https://developers.cloudflare.com/email-service/configuration/subdomains/)). The Worker
checks the **SMTP envelope recipient**, not the untrusted `To` header. Main and
alias inboxes are separate; names are lowercased. A name must be a nonempty
ASCII dot-atom local part within the email local-part length limit. Quoted and
internationalized local parts are not supported. Inspect the domain's existing
subaddress setting when testing addresses containing `+`.

**A catch-all cutover affects unrelated mail. Do not blindly enable routing or
replace MX records.** Before making changes:

1. Export the existing Email Routing status, all rules (including pagination),
   catch-all action, verified forwarding destinations, and domain/subdomain MX
   records. Keep this private, not in this public repository.
2. Confirm whether Cloudflare already receives mail. If another provider owns
   MX, stop: switching MX is a mail migration, not routine Worker setup.
3. Preserve existing literal rules and other email Workers. They continue to
   handle their explicit recipients. Check for literal rules that shadow any
   desired MCP address; resolve those individually with the owner.
4. This Worker rejects unclaimed addresses. If the existing catch-all handles
   real mail, stop and obtain an explicit migration decision; do not replace it
   with this Worker. Prefer a dedicated domain with no existing mail delivery.
5. Create aliases through MCP before using their addresses. The main inbox and
   static policy grants exist automatically. No per-alias routing rule is needed.
6. Get approval for replacing the catch-all. Safer staged validation: first
   add only a new literal test alias and the main address, leaving catch-all
   intact. Literal aliases alone do **not** receive arbitrary suffixes.
7. After testing, switch only the approved catch-all action to this Worker.
   Test the main inbox, a newly created alias, a rejected unclaimed address,
   and optional forwarding. Verify destinations, not just
   SMTP acceptance. Roll back by restoring the saved catch-all action; retain
   this Worker's durable data until explicitly approved for deletion.

The checked-in Wrangler config intentionally has no email routing or DNS rules.
Deploying it cannot take over a domain's catch-all. A new domain needs Cloudflare's
prescribed MX/TXT configuration; do not guess these records. No MX change is
needed when Cloudflare already receives the domain's mail.

## Storage and limits

Each normalized recipient has one SQLite-backed Durable Object. Raw MIME is
stored in 128 KiB chunks. Mail metadata, raw chunks, and all webhook outbox rows
are committed in one transaction before the email handler returns. Alarms are
armed before the transaction so an isolate restart cannot strand committed
notifications. No R2 bucket, Queue, cron, or external database is required.

- Maximum incoming mail: **25 MiB**, enforced on both declared size and stream.
- Per-inbox quota: **1,000 messages or 100 MiB**. A full inbox fails receipt;
  it never acknowledges and silently discards mail. SMTP retry/bounce behavior
  after a handler exception must be validated with the provider before cutover.
- Retention: **30 days**, including raw attachments. Reads deny expired mail
  immediately; alarms physically remove it within approximately an hour under
  normal operation. Cloudflare backup/Time Travel retention is separate.
- MIME previews: up to **2 MiB** input, with nesting/header limits. Larger mail
  returns `rawOnly: true` and an authenticated `rawUrl`; parse failures also
  preserve the raw message. Text and HTML previews each cap at 100,000 characters.
- Attachments are retained in raw MIME; MCP returns names/types, not executable
  content. Download the `.eml` to extract attachments locally.
- Subscriptions: at most **20 per inbox**, expire after **30 days**. Delete and
  re-register to renew or rotate the signing secret. Registration covers future
  mail only. Use `list_mail` to recover gaps or missed/failed notifications.
- Aliases are first-claim-owned and persist independently of mail retention,
  with at most 100 dynamically created aliases per principal. Unclaimed names
  reject mail, preventing a later claimant from reading historical messages.
  There is no automatic name recycling. Alias names are not secrets. Public
  ingress and directory lookups still incur costs; inbox limits do not cap
  account-wide spend. Configure
  provider abuse controls, billing alerts, and monitoring before public use.

This is a low-volume agent mailbox, not a bulk mail archive. Large messages are
buffered within the Workers memory limit; high concurrency needs load testing.
SMTP redeliveries may produce duplicate mail records. Webhook retries preserve
the event ID; there is no exactly-once claim.

## Authentication and permissions

`ACCESS_POLICY` is a Cloudflare secret containing a JSON array:

```json
[
  {
    "id": "project-agent",
    "tokenHash": "<64 lowercase hex characters: SHA-256 of a random bearer token>",
    "inboxes": [],
    "webhooks": true,
    "manageInboxes": true
  }
]
```

Generate independent 32-byte random tokens using your password manager or a
cryptographic generator, distribute them privately, and store only their SHA-256
hashes in the policy. Do not reuse the examples/test fixture credentials. Keep
principal IDs and token hashes unique. Principals cannot edit this policy through
MCP. Only operators with Cloudflare secret-management permission can grant or
revoke static inbox access. There is intentionally no wildcard inbox grant.

Every authenticated client can read the shared main inbox. Dynamic aliases are
private to their owning principal; optional `inboxes` grants share specific
aliases with other clients or reserve names before use. `manageInboxes: true`
permits creating aliases and selectively forwarding stored messages in accessible inboxes. Set both
`manageInboxes` and `webhooks` false for read-only clients. Creating/deleting a
subscription requires webhook permission and access to its inbox. Listing and
deleting subscriptions is owner-scoped, even in the shared main inbox.

Update the secret to rotate/revoke access. Outbound attempts recheck the current
principal, inbox grant, webhook permission, and destination allowlist. Revocation
does not retract a request already in flight. Reusing a principal ID transfers
that principal's aliases and subscriptions; do not recycle IDs between users.
Rotating a token while keeping the same principal ID retains ownership.

This is static bearer authentication, not OAuth discovery or interactive login.
Your MCP client must support a configured Authorization header. HTTPS is
required in production; the canonical `PUBLIC_ORIGIN` and browser Origin checks
prevent host confusion and cross-origin browser access. No CORS is enabled.

## MCP and raw mail

Connect your client to `https://mail-api.example.com/mcp` over Streamable HTTP
with `Authorization: Bearer <token>`. The server is stateless; use HTTP POST,
not a long-lived GET/SSE session. The SDK handles initialization and tool
discovery; individual responses may use SSE framing.

| Tool               | Input                                      | Result                                                            |
| ------------------ | ------------------------------------------ | ----------------------------------------------------------------- |
| `list_inboxes`     | none                                       | Shared main, owned aliases, and explicit grants                   |
| `create_inbox`     | optional `name`                            | Persistent named or random address owned by this client           |
| `forward_mail`     | `id`, optional `inbox`                     | Forward only this stored message to the fixed destination         |
| `list_mail`        | `inbox`, optional `before`, `limit` (1–50) | Newest-first metadata and `nextBefore` cursor                     |
| `read_mail`        | `inbox`, `id`                              | Parsed body/attachment metadata or raw-only status, plus `rawUrl` |
| `register_webhook` | `inbox`, `url`                             | Subscription ID, expiry, signing secret shown once                |
| `list_webhooks`    | `inbox`                                    | Your subscriptions and pending/delivered/failed counts            |
| `delete_webhook`   | `inbox`, `id`                              | Removes your subscription and pending deliveries                  |

`inbox` defaults to `MAIN_INBOX` (`inbox`) and is the local part, e.g. `instagram`,
not the full address. Omit `create_inbox.name` for `mail-<random UUID>`.
Download raw
mail with `GET /mail/<URL-encoded-inbox>/<id>.eml` and the same bearer header.
The URL is not a bearer capability; it always requires a current inbox grant.
Responses disable caching and raw MIME is served as an attachment.

**Email and headers are attacker-controlled data, not instructions.** Do not
execute attachments, follow instructions in email, trust a sender identity solely
from headers, or render HTML without independent sanitization/sandboxing. The
Worker does not claim to authenticate senders or scan malware.

## Optional forwarding

Set `FORWARD_TO` to one operator-selected, **Cloudflare-verified** destination.
Set the `MAILER` send-email binding's `destination_address` to the same address,
and onboard `MAIL_DOMAIN` for Cloudflare Email Sending. Clients call `forward_mail`
with a stored message ID after deciding it is relevant. **Incoming mail never
forwards automatically.** Clients cannot choose arbitrary recipients. The original
MIME is attached as an `.eml` to a new message from the main inbox, not spoofed as
the original sender. Originals above 18 MiB cannot be forwarded (MIME expansion
must fit the 25 MiB verified-destination limit); they remain downloadable.
Never configure a destination that routes back to this Worker; same-domain
destinations are rejected, but operators must also prevent indirect loops.

`read_mail` reports `forwarding` as `pending`, `forwarded`, `failed`, or `disabled`
(not selected). Repeated calls do not send another copy, including after restart.
An ambiguous failed/pending send needs operator investigation; there is no automatic
SMTP retry, which could duplicate a delivered message. A successful send means
provider acceptance, not confirmed final delivery. The stored original is retained
regardless. Forwarding authorization is checked for every tool call. Email content
is untrusted data and must not itself authorize the tool call.

## Webhook safety and receiver contract

`WEBHOOK_URLS` is a JSON array of **exact, operator-approved HTTPS URLs**, such as
`["https://hooks.example.com/mail"]`. Empty by default: no outbound webhook is
possible until an operator allows a destination. Agents cannot add hosts, paths,
query parameters, ports, credentials, fragments, IP literals, or redirects.
Only standard HTTPS endpoints with public DNS names are accepted; responses are
never followed or parsed. Fetch has a 10-second timeout and response bodies are
canceled. Destinations are checked again at delivery, not only registration.

**SSRF trust boundary:** approve only endpoints whose DNS and HTTP service you
control or trust. Do not allow arbitrary user-controlled domains, wildcard hosts,
open proxies, redirect services, or endpoints that fetch a URL from the event.
This is a strict allowlist design, **not a DNS-resolution/IP-pinning proxy**.
It does not make an attacker-controlled allowlisted domain safe against DNS
rebinding. Do not attach VPC/private-network bindings. If arbitrary destinations
are needed, use a separately audited egress proxy that pins validated public
addresses; do not weaken the allowlist. Test actual approved endpoints before use.

Events contain only notification metadata (no subject, sender, or body):

```json
{
  "id": "<stable event UUID>",
  "type": "mail.received",
  "mailId": "<mail UUID>",
  "inbox": "mcp-project",
  "recipient": "mcp-project@example.com",
  "receivedAt": 1790000000000
}
```

Headers: `X-Mail-Id`, `X-Mail-Timestamp` (Unix seconds), and
`X-Mail-Signature: v1=<hex HMAC-SHA256>`. The signed input is the exact UTF-8
string `timestamp + "." + rawRequestBody`; the HMAC key is the returned secret
**as a UTF-8 string**, not hex-decoded bytes. For a Node receiver:

```js
const expected = createHmac("sha256", secret)
  .update(`${timestamp}.${rawBody}`)
  .digest();
// First validate timestamp as an integer within ±300 seconds, and signature
// as exactly "v1=" plus 64 hex characters. Then:
const valid = timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
```

Verify before parsing or acting. Persist event-ID deduplication for at least the
subscription lifetime; acknowledge duplicates with 2xx. Return 2xx only after
durably accepting the event. Each retry has a new timestamp/signature but the
same event ID/body. Timeout/network errors, 429, and 5xx retry with exponential
delays starting at 30 seconds (up to one hour), with **8 total attempts**.
Other statuses, including all redirects, are terminal failures. Alarms process
bounded batches and persist status across restarts. Delivery is best-effort
at-least-once within that retry budget, not guaranteed indefinitely. Fetch mail
through authenticated MCP after notification; the signing secret is not an inbox
credential. Monitor failed counts and recover via `list_mail`.

## Owner OAuth and password setup

OAuth uses Better Auth with a dedicated **D1** database. Set `OWNER_EMAIL` to
the sole permitted email and `OAUTH_PRINCIPAL_ID` to an existing `ACCESS_POLICY`
principal. Approved OAuth clients share that principal's inboxes and webhook
ownership: they are **not isolated from each other**. Use separately scoped
bearer principals for less-trusted agents. OAuth never enables automatic forwarding.

Public signup and reset requests are disabled. The owner is provisioned offline
and receives a private, single-use, 30-minute setup link. Passwords use default
scrypt with a 12-character minimum. HTTPS sessions use host-only Secure/HttpOnly
cookies. D1-backed rate limits trust Cloudflare's `CF-Connecting-IP`, not arbitrary
forwarded headers; keep the Worker behind Cloudflare's edge.

1. Create a dedicated D1 database, configure the private `AUTH_DB` binding, and
   apply `migrations/0001_auth.sql` with Wrangler D1 migrations before deployment.
   Public HTTP requests never migrate databases.
2. On Node 24+, create a private JSON config with `OWNER_EMAIL` and `PUBLIC_ORIGIN`.
   From this package run:
   `node scripts/provision.ts /private/config.json /private/new-owner-output`.
   The output directory must not exist. This offline operation writes mode-0600
   `owner.sql` and `credentials.json` inside a mode-0700 directory.
3. Apply `owner.sql` to the new empty auth database using an approved operator
   connection. Never bootstrap over an existing owner. Set `BETTER_AUTH_SECRET`
   from `credentials.json` using a protected secret input. Never print, commit,
   or publicly host these files. Preserve the secret on routine redeployment.
4. Deploy and privately open the generated `setupUrl` within 30 minutes. Choose
   a password. The token is in the fragment and immediately removed from browser
   history; the page has no analytics or third-party resources.
5. Add the HTTPS `/mcp` endpoint in Amp or another agent client with OAuth.
   Discovery and dynamic registration are supported. Sign in and explicitly
   approve or deny the client after reviewing its ID and owner-level privileges.
   PKCE S256 is mandatory. Access tokens last five minutes; refresh is supported.

For recovery, supply the **existing** `BETTER_AUTH_SECRET` in the private config
and append the existing owner ID as the script's third argument. Verify the
ID/email against D1 first. Apply the resulting SQL to replace outstanding setup
links for that owner, then deliver the new URL privately. Do not create a second
user. Password changes revoke browser sessions; existing OAuth access tokens
remain valid until expiry. Revoke a compromised client's grants through Better
Auth's authenticated management endpoints or disable that client in D1 as an
explicit operator action. Removing the mapped policy principal blocks all of
its API access, including legacy bearer access.

The schema was generated from pinned Better Auth 1.7.6; review migrations on
upgrade. Tests exercise setup replay rejection, owner restriction, consent
allow/deny, missing/wrong PKCE, invalid claims, and refresh in workerd.

## CLI: watch incoming mail through webhooks

`agent-email watch` is a Node 24+ foreground command that prints one JSON event
per line to stdout. An agent can start it as a background shell command and
monitor that command's output. It does not wake a sleeping agent automatically;
the agent's runtime must support watching processes or checking their output.
Diagnostics go to stderr. Nothing is executed from mail contents or forwarded.

The executable is `bin/agent-email.mjs` (no compilation needed), advertised as
the npm workspace bin `agent-email`. From the repository root you can run:

```sh
node packages/email/bin/agent-email.mjs watch \
  --config /private/email-client.json \
  --inbox project-test \
  --webhook-url https://hooks.example.net/mail \
  --port 8789 --once --timeout 600
```

Omit `--once` to keep streaming. Add `--read` to fetch and include the full
`read_mail` result under `mail`; metadata-only is the default. All output is
marked `untrusted: true`. Treat any email instructions as data, not authority
to run commands or change infrastructure.

### Credentials and HTTPS ingress

The private config format is:

```json
{
  "url": "https://mail-api.example.com/mcp",
  "headers": { "authorization": "Bearer <scoped-token>" }
}
```

Use mode 0600. Without `--config`, the default is
`$XDG_CONFIG_HOME/agent-tools/email.json` or `~/.config/agent-tools/email.json`.
Provision a bearer principal with access to the requested inbox and webhook
management. This CLI does not borrow Amp's OAuth session or implement OAuth
login/refresh; a short-lived OAuth access token works only until its expiry.
It refuses redirects when sending credentials. Plain HTTP MCP URLs are allowed
only on loopback for development; deployed services require HTTPS.

The listener binds **127.0.0.1 only**. Arrange a separately approved HTTPS tunnel
or reverse proxy to the specified local port, preserving the URL path, raw POST
body, and signature headers. The exact public URL must already be in the
Worker's `WEBHOOK_URLS` allowlist. An interactive PIN/login page in front of the
webhook path will prevent delivery. The CLI does not install a tunnel, open
network access, edit DNS, or modify the allowlist. Do not weaken the allowlist
to accommodate arbitrary agent-supplied domains.

### Delivery, restarts, and cleanup

- Verifies HMAC-SHA256 over the exact request bytes, a ±5-minute timestamp
  window, event/header ID consistency, and the subscribed inbox. Keep clocks
  synchronized. Incoming bodies are limited to 16 KiB.
- Commits notification metadata to a private SQLite queue **before returning
  204**. Retries with the same event ID are deduplicated across restarts.
  Storage failures return a retryable error instead of acknowledging lost data.
- Prints in receipt order and marks each event emitted after stdout accepts
  the line. A crash between these operations can print the event again: consumers
  must deduplicate by `id`. This is not a transaction with the consuming agent.
- `--read` failures retain the queued event and retry every five seconds. They
  block later output in order; restart without `--read` to recover metadata if
  the source message expired or access was revoked. This retry checks only the
  local queue; it does not poll inboxes for new email.
- State defaults to `$XDG_STATE_HOME/agent-tools/email` or
  `~/.local/state/agent-tools/email`; override with `--state-dir`. The directory
  must be private (0700). It holds subscription signing secrets and metadata,
  not fetched message bodies. Never commit or share it. Use a local filesystem,
  not network-mounted storage. SQLite prevents simultaneous consumers of the
  same endpoint/inbox/webhook state and releases its lock on process death.
- Subscription state is reused across restarts and remains registered when
  `--once`, a timeout, or a signal stops the CLI. Subscriptions expire after
  30 days; an expired watcher exits and restart registers a replacement. Stop
  subscriptions permanently with MCP `delete_webhook`, using the ID printed
  on stderr, then remove that watcher's local state if it will be recreated.
  A registration whose response was lost may leave an orphan subscription;
  inspect `list_webhooks` rather than repeatedly retrying registration.
- The queue retains at most 10,000 events. Emitted deduplication records age out
  after 31 days; unprinted events are never automatically deleted. A full queue
  rejects new events with 503. Monitor stderr and server delivery failure counts.
- Events missed while the receiver is offline beyond the server's retry budget
  are not replayed automatically. Use `list_mail` to reconcile gaps. Subscription
  registration covers only future mail, not existing messages.

Exit codes: 0 after `--once`, 124 on timeout, 130/143 on SIGINT/SIGTERM, and 1 on
startup/output failure or subscription expiry. `--timeout` is in seconds (maximum
86400) starting once the receiver is ready; omit it or use 0 for no deadline.
The timeout closes the listener but intentionally preserves its durable queue.

Tests launch the real CLI against a local fixture MCP server and deliver signed
HTTP notifications, including invalid signatures, restart deduplication, and
forced-crash recovery. Live tunnel/provider webhook delivery still requires an
approved public URL and a controlled incoming message.

## Local setup and verification

Requires Node.js 24+ and npm. Tested on Linux with Node 24 and local workerd;
macOS and live SMTP have not been tested. This workspace follows the repository's
npm lockfile. The compatibility date is pinned to the newest date supported by
the repository's installed workerd (2026-10-03), not an untestable future date.

From the repository root:

```sh
npm ci --ignore-scripts
npm run types --workspace @agent-tools/email
npm run format --workspace @agent-tools/email
npm run check --workspace @agent-tools/email
npm test --workspace @agent-tools/email
npm run build --workspace @agent-tools/email
```

`build` is a local Wrangler dry run, never a deployment. Tests use disposable
SQLite state, synthetic credentials, and mocked outbound delivery; they do not
send email or call webhook services. Expected denied-RPC paths can emit workerd
exception diagnostics while tests assert the denial. No live credentials are
needed. For local manual use, put synthetic `ACCESS_POLICY` and
`BETTER_AUTH_SECRET` values in ignored `.dev.vars`, apply migrations to local D1,
and set a loopback `PUBLIC_ORIGIN` matching Wrangler's chosen port.
Never load production policy or forwarding credentials for local testing.

## Explicit deployment checklist

1. Complete the routing inspection and decisions above. Choose a unique Worker
   name so an existing email Worker cannot be replaced accidentally.
2. Set `MAIL_DOMAIN`, `MAIN_INBOX` (default `inbox`), canonical HTTPS
   `PUBLIC_ORIGIN`, and optional verified `FORWARD_TO` in an operator-local config. Keep private
   destinations/account details out of commits. Choose `WEBHOOK_URLS` and review
   their DNS/service ownership. A Workers.dev origin works; a custom API hostname
   requires a separate, approved HTTP custom-domain setup, not an MX change.
3. Use an existing authorized Wrangler login/API credential with Workers script,
   Durable Object deployment, and account-read permissions. Routing changes need
   zone Email Routing rules permissions; DNS writes are not needed if existing
   Cloudflare MX is healthy. Do not grant runtime code a Cloudflare API token.
4. After deployment approval, deploy from `packages/email` using the reviewed
   local config: `npx wrangler deploy --config <config-path>`. Set `ACCESS_POLICY`
   with `npx wrangler secret put ACCESS_POLICY --config <config-path>` using the
   interactive prompt (or a protected secret-management pipeline). The endpoint
   fails closed until the policy exists. Config paths must resolve the source and
   bindings correctly; run `deploy --dry-run` with that same config first.
5. Test HTTPS MCP initialization, anonymous rejection, authorized main/alias
   reads, cross-alias denial, and the approved receiver's signature verification.
   Register the remote MCP endpoint in the intended agent client explicitly.
6. Add the approved staged literal routes and send controlled test messages.
   Verify persistence, raw MIME, webhook retries, and sender-visible oversize/quota
   failures. Only then perform the separately approved catch-all cutover.
7. Monitor receipt errors, inbox quotas, delivery failures, provider billing, and
   subscription expiry. Keep the saved routing rollback available.

Nothing here is installed, published, routed, or made live by the local tests.

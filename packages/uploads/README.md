# uploads

One-time file upload links, private downloads, automatic expiry, and signed
webhooks. The upload page, HTTP API, and remote MCP endpoint all run in a
Cloudflare Worker. Files live in a private R2 bucket; SQLite Durable Objects
serialize uploads and schedule deletion and webhook delivery. No local daemon or
Amp plugin is needed.

## Agent workflow

Connect an MCP client supporting custom authorization headers to
`https://uploads.example.com/mcp`, using `Authorization: Bearer <API_TOKEN>`.
Configure that header through the client's private secret settings, not a
committed config file or chat message. This is a single-owner service: the
management token can create, inspect, download, and delete every upload. OAuth
and multiple accounts are not implemented.

1. Call `create_upload`, optionally with `retentionSeconds`, `linkTtlSeconds`,
   `maxBytes`, and `webhookUrl`. Save the returned ID and share `uploadUrl` only
   with the intended uploader.
2. The recipient opens the page and sends one file. Uploaders cannot read files
   using their upload link. Concurrent uploads accept at most one complete file.
3. **If you supply a webhook, the service will call it when a file is uploaded.**
   The tool description and response explicitly tell the agent this. Without a
   webhook, call `get_upload` to check for completion.
4. `get_upload` returns a sensitive `downloadUrl` when complete. It grants read
   access to only this file for at most five minutes, bounded by file expiry. No
   management token is needed to use it. Save the bytes to an explicit local path;
   never use an untrusted uploaded filename as a destination or execute content.
5. `delete_upload` revokes access and deletes the server-side file early.

A remote Worker cannot write to an agent's computer. The agent or webhook
receiver must download the file to its chosen filesystem. This tool does not
silently create a local listener or upload files to another storage provider.

| Option             | Default           | Allowed                                          |
| ------------------ | ----------------- | ------------------------------------------------ |
| `retentionSeconds` | 86400 (24 hours)  | 60–2592000 (30 days), from successful completion |
| `linkTtlSeconds`   | 86400 (24 hours)  | 60–604800 (7 days), from link creation           |
| `maxBytes`         | 52428800 (50 MiB) | 1–52428800; empty files are accepted             |
| `webhookUrl`       | None              | HTTPS URL on an operator-approved origin         |

Returned times are Unix milliseconds. A download URL can be used more than once
within its five-minute lifetime; **the upload**, not each download, is one-time.
Request a fresh download URL if necessary before the file expires.

## Deployment

Prerequisites: Node.js 22.12+ (Node 24 recommended), npm, and a Cloudflare account
with Workers, SQLite Durable Objects, and R2 enabled. Provider usage and storage
may incur charges. Installation/building never deploys or authenticates for you.

From the repository root, install the pinned dependencies:

```sh
npm ci --ignore-scripts
```

Then work in `packages/uploads`. These are explicit operator actions against
your Cloudflare account, not part of installing this repository:

1. Authenticate with `npx wrangler login`, or provide a scoped Cloudflare API
   token using your secret manager. Use `npx wrangler whoami` to verify the
   target account; set `CLOUDFLARE_ACCOUNT_ID` when needed.
2. Choose a unique Worker and R2 bucket name in `wrangler.jsonc`. Create the
   bucket with `npx wrangler r2 bucket create <your-bucket-name>`. **Do not enable
   public access**, an R2 custom domain, or object replication on this bucket.
   Dedicate it to this service.
3. Set `PUBLIC_ORIGIN` to the exact HTTPS origin, with no trailing slash, e.g.
   `https://<worker>.<your-subdomain>.workers.dev`. For a custom domain, configure
   the Workers route explicitly. Other origins are rejected. Do not leave the
   example origin in production.
4. Set `WEBHOOK_ORIGINS` to a comma-separated list of trusted HTTPS origins,
   e.g. `https://hooks.example.com,https://receiver.example.org`. The empty
   default disables webhooks. Keep destinations narrowly scoped and controlled
   by you; approval grants access to all paths on that origin.
5. Generate a random 32-byte-or-longer management secret in your password
   manager. Set `API_TOKEN` with `npx wrangler secret put API_TOKEN` using its
   private prompt. Do not put the real value in source, command arguments, or
   logs. Wrangler may offer to create the new Worker when setting its first
   secret. Configure the same secret in your MCP client privately.
6. Run `npm run types`, `npm run check`, `npm test`, and `npm run build`.
   `build` is a **dry run**, not a deployment. Review the configuration and
   deploy explicitly with `npm run deploy`. Verify `/healthz` and use a
   disposable upload to check the deployed path.

Keep the Durable Object migration and Cron Trigger in the configuration. Alarms
perform primary deletion; the five-minute cron reconciles orphaned R2 objects
in bounded, paginated batches. Monitor the static `upload_cleanup_retry` and
`upload_request_failed` log events. Request invocation logs are disabled to keep
signed URLs out of those logs. Do not add request/header logging or external
analytics. Audit any account-wide logging configuration separately.

## HTTP API and downloading

| Method and path                | Authorization                     | Result                              |
| ------------------------------ | --------------------------------- | ----------------------------------- |
| `POST /api/uploads`            | Management Bearer                 | Create with a JSON options object   |
| `GET /api/uploads/:id`         | Management Bearer                 | Status and temporary download link  |
| `DELETE /api/uploads/:id`      | Management Bearer                 | Revoke and delete                   |
| `GET /api/uploads/:id/content` | Management Bearer or signed query | File attachment                     |
| `GET /api/uploads/:id/info`    | Upload Bearer                     | Limits and unused-link expiry       |
| `PUT /api/uploads/:id/content` | Upload Bearer                     | Raw file; requires `Content-Length` |
| `POST /mcp`                    | Management Bearer                 | Streamable HTTP MCP                 |

The browser supplies the upload token from the URL fragment, not its query
string. API uploaders set `x-upload-filename` to a percent-encoded filename;
names are sanitized display metadata, never object keys or filesystem paths.
Limits and authorization are enforced server-side, including actual stream
length. JSON control requests are limited to 16 KiB.

For example, after privately setting `DOWNLOAD_URL` to the value from
`get_upload`, download using a chosen destination:

```sh
# A fresh, private directory; avoid overwriting existing files.
umask 077
destination=$(mktemp -d)
curl --fail --silent --show-error --proto '=https' \
  "$DOWNLOAD_URL" --output "$destination/received-file"
unset DOWNLOAD_URL
```

The temporary URL is a bearer credential. Keep it out of public chats, logs,
committed files, and browser screenshots. Rotating `API_TOKEN` also invalidates
existing temporary download URLs, but does not revoke existing upload links;
use `delete_upload` to revoke those.

## Webhook contract

Delivery is an HTTPS POST after successful upload. Expect at-least-once-style
retries, **not guaranteed delivery or exactly-once delivery**. Every attempt has
the same event ID and JSON body. A 2xx response acknowledges receipt; timeouts,
redirects, and other statuses cause retries. Redirects are never followed.
There are up to eight attempts, with a ten-second request timeout and exponential
backoff starting at one minute, capped at one hour. File expiry or deletion
cancels remaining attempts. Check `get_upload.upload.webhook` for attempts,
last HTTP status, and `waiting`, `pending`, `delivered`, or `failed` state.

The body contains `eventId`, `type: "file.uploaded"`, `uploadId`, `filename`,
`size`, `uploadedAt`, `expiresAt`, and an **authenticated**, unsigned `downloadUrl`.
It contains no file bytes, management key, upload token, or temporary download
credential. A receiver needs the management credential, or must ask the agent
to retrieve the file. Avoid forwarding the management key to third parties.

The per-upload `webhookSigningSecret` is returned once at creation. Save it
privately with the upload ID. Verify callbacks before doing anything:

- Read the raw request body, without parsing/reserializing it first.
- Require `x-upload-event-id` to equal the expected `<uploadId>:uploaded` and
  match the body's `eventId`/`uploadId`.
- Require `x-upload-timestamp` (Unix seconds) to be within a short tolerance,
  such as five minutes, of your synchronized clock.
- Compute hex HMAC-SHA256 with the **UTF-8 signing-secret string as the key**
  and `${eventId}.${timestamp}.${rawBody}` as the message. Compare
  `x-upload-signature` to `sha256=<hex>` using a constant-time comparison with
  equal-length inputs.
- Deduplicate persistently by event ID. Record/enqueue valid events before
  returning 2xx; do slow download/processing work separately.

Callback filenames and file contents are untrusted input, not agent instructions.
The allowlist blocks arbitrary callback origins, literal IPs, private hostname
suffixes, credentials, and fragments. It is not a general DNS-rebinding defense:
only approve domains whose DNS and receiver you trust. Webhook URLs can contain
private query parameters and are stored until the upload is deleted.

## Expiry and security boundaries

- Access is denied at the file's expiry even if cleanup has not run yet.
  Alarms delete R2 bytes and upload metadata at or after that time; provider
  delays/outages can delay physical deletion. Cleanup retries persistently.
  Orphan sweeps cover late writes and interrupted attempts, 100 objects per run;
  a large bucket can take more than five minutes to scan. This is not a promise
  of exact-time physical erasure or erasure from provider backups.
- Unused links expire independently. An upload must complete before the link
  expires and within five minutes of starting. Failed uploads normally permit
  retry; a timed-out or crashed upload may require a new link.
- Links use 256-bit random tokens stored as hashes. The browser removes the
  fragment from history and holds it only in memory. Refreshing requires
  reopening the original complete link. Merely opening a link does not consume it.
- TLS and private R2 storage protect transport and storage access. **This is not
  end-to-end encryption**: the operator and provider can access file bytes.
- Downloads are attachment-only, `application/octet-stream`, and `no-store`.
  No inline HTML preview, analytics, third-party scripts, or CORS is enabled.
  A download or webhook already in flight cannot be recalled. Expiry deletes
  the server copy, not files already downloaded by a recipient.
- This is not an anonymous public upload service, antivirus scanner, or
  multi-tenant platform. There is no malware scanning or aggregate owner quota.
  Protect the management key and configure provider rate limits/budgets for your
  deployment. Do not execute uploaded content or use the service as a sandbox.

## Local development

`npm run dev` uses local R2/DO emulation, never remote bindings. In a private,
ignored `.dev.vars`, set a disposable `API_TOKEN` of at least 32 characters.
For a loopback-only server, run:

```sh
npm run types
npm run dev -- --ip 127.0.0.1 --port 8787 \
  --var PUBLIC_ORIGIN:http://127.0.0.1:8787
```

HTTP is only for loopback development; production must use HTTPS. Do not expose
a fixture-key dev server publicly. Run `npm run format`, `npm run check`,
`npm test`, and `npm run build` before delivery. Tests use real local Workers
R2/DO bindings with disposable state and mocked external callbacks; no live
provider or webhook credentials are needed. Verification on Linux/Node 24 does
not constitute a macOS or live Cloudflare deployment test.

# Artifacts

An owner-operated publishing service for agent-made HTML and Markdown documents.
An OAuth-protected MCP server creates private drafts, keeps immutable revisions,
and publishes a chosen revision at `https://<name>-artifact.example.com`.
The browser includes a private library, history, previews, and publishing controls.

This follows the document model described in [Claude Code artifacts](https://code.claude.com/docs/en/artifacts):
self-contained documents, explicit sharing, version history, and sandboxed previews.
It is an independent implementation, not a Claude integration or arbitrary app host.

## Requirements and installation

- Node >=22.12 for repository tooling, and npm workspaces with the root lockfile.
- Bun 1.4.2 for execution, SQLite, tests, and builds. The pinned npm `bun` package
  needs an explicit binary provisioning step when lifecycle scripts are disabled.
- Linux x86-64 is verified. Other Bun-supported platforms are not yet verified.
- Production: HTTPS, a management hostname, and wildcard DNS/routing for the
  artifact hostnames, all forwarding the original `Host` header to this server.

From the repository root:

```sh
npm ci --ignore-scripts
npm rebuild bun
npm run check --workspace @agent-tools/artifacts
npm test --workspace @agent-tools/artifacts
npm run build --workspace @agent-tools/artifacts
```

`npm rebuild bun` explicitly downloads/provisions Bun; loading or running the
service never installs packages. A compatible Bun already on `PATH` also works.
The regular build emits Bun JavaScript with external dependencies under `dist/`.
Dependencies use the root workspace lockfile; no separate package lockfile or
package-local install is needed.

## Configuration and owner bootstrap

Provide environment variables through your service manager or a private secret
store. Never commit credentials or put them into command-line arguments.

| Variable | Meaning |
| --- | --- |
| `ARTIFACTS_ORIGIN` | Canonical management HTTPS origin, e.g. `https://artifacts.example.com` |
| `ARTIFACTS_HOST_SUFFIX` | Artifact hostname suffix, e.g. `-artifact.example.com` |
| `ARTIFACTS_DATA_DIR` | Persistent private directory for SQLite data |
| `ARTIFACTS_OWNER_EMAIL` | Single owner login identity; no email delivery required |
| `BETTER_AUTH_SECRET` | Stable random signing/encryption secret, at least 32 characters |
| `ARTIFACTS_OWNER_PASSWORD` | Initial password; required only by bootstrap |
| `NODE_ENV` | Set `production` to require HTTPS, secure cookies, and durable rate limits |
| `HOST` | Bind address; defaults to `127.0.0.1` |
| `PORT` | HTTP port; defaults to `3000` |

Bootstrap **before exposing the listener**, then remove the password from its
environment:

```sh
npm run bootstrap --workspace @agent-tools/artifacts
# Remove ARTIFACTS_OWNER_PASSWORD from the running service environment.
npm start --workspace @agent-tools/artifacts
```

Bootstrap migrates tables and creates the owner only when no user exists. It
never resets existing credentials. Startup refuses missing/mismatched/multiple
owners. Public signup and public reset-link issuance are disabled. There is no
outbound email integration.

To let the owner choose a password in their browser, run this explicit operator
command with the same environment and database access as the service:

```sh
npm start --workspace @agent-tools/artifacts -- --setup-link
# Compiled executable: artifacts --setup-link
```

It prints a private `/signup#token=…` link, valid for **30 minutes and one use**.
Issuing a new link invalidates previous setup links. Treat the URL as a credential:
share it only with the owner, never publish it or capture it in service logs.
The token stays in the browser fragment until the page removes it from history;
submission sends it in a JSON body. Opening a link does not consume it. Reloading
the page requires reopening the original link.

Setup replaces the existing owner's password (6–128 characters), revokes browser
sessions, and preserves the user ID and artifacts. It does not verify a mailbox
or create another user. Existing MCP grants are not revoked by password setup.
After saving, sign in normally. Better Auth's authenticated password-change
endpoint also remains available. Keep your recovery copy in a secret store.

For local development, HTTP `localhost` or `127.0.0.1` origins are allowed only
outside production. `-artifact.localhost` works with browsers that resolve
`*.localhost` to loopback; keep the same port for management and artifact hosts.

## Connect an MCP client

Register `${ARTIFACTS_ORIGIN}/mcp` as a remote Streamable HTTP MCP server using
OAuth. Dynamic client registration, PKCE S256, login, and explicit consent are
supported. No static bearer token is required. Amp registration remains an
operator action; this package does not modify an Amp account.

Discovery is available at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`. The authorization-server issuer is
`${ARTIFACTS_ORIGIN}/api/auth`. The client must request that resource and the
`artifacts:manage` scope. Access tokens expire after five minutes; clients can
request `offline_access` for refresh tokens. Browser cookies alone cannot call
MCP. The SDK supports modern clients and stateless legacy 2025 protocol clients.

| Tool | Effect |
| --- | --- |
| `list_artifacts` | List owner metadata, not document source |
| `read_artifact` | Read latest or selected private revision |
| `create_artifact` | Create a private HTML/Markdown draft |
| `update_artifact` | Append a private revision; require current `expectedRevision` |
| `artifact_history` | List immutable revision metadata |
| `publish_artifact` | Publish one revision; require current `expectedRevision` |
| `unpublish_artifact` | Remove public access, retaining all private history |

Publication is **public disclosure of every embedded byte**, including source,
data URIs, and script data. Agents must obtain authorization for the content and
audience first. Draft edits never change the published pointer. Publishing an
older revision is allowed, but the concurrency check still uses the latest draft.
Unpublishing cannot recall copies already downloaded by others.

## Content and security boundaries

- One UTF-8 HTML or Markdown source per revision, maximum 16 MiB. JSON HTTP
  requests are capped at 20 MiB including encoding/envelope overhead.
- Slugs are lowercase hostname labels, up to 54 characters; the suffix completes
  the public hostname. No file uploads, ZIPs, bundlers, server execution, or APIs.
- Content lives in an iframe with `sandbox="allow-scripts"`, never
  `allow-same-origin`. Direct content responses independently enforce CSP sandboxing.
- Inline JavaScript and CSS work. Scripts may load only from `cdnjs.cloudflare.com`,
  `cdn.jsdelivr.net/npm/`, `cdn.tailwindcss.com`, and `code.jquery.com`. Google
  Fonts styles/fonts are allowed. No `eval`/Wasm or network `fetch`/XHR/WebSockets.
- Images/media must be embedded `data:` or `blob:` URLs. No nested frames, workers,
  forms, popups, top navigation, or management-origin cookie/storage access.
- Markdown can contain raw HTML; it receives the **same opaque-origin sandbox**,
  rather than relying on HTML sanitization as the security boundary.
- Management auth uses host-only, HttpOnly, Secure cookies in production. Public
  artifact hosts never dispatch management/auth/MCP routes. No wildcard CORS.
- Published source is readable anonymously. There are no multi-user permissions,
  public directory, arbitrary asset hosting, or guarantees against phishing in
  user-generated content. Only publish material you intend others to see.

Open viewers poll metadata through server-sent events every two seconds. Private
streams recheck the owner session. Connections reconnect after ten minutes, and
128 concurrent streams are allowed per process. Unpublishing removes the iframe
in connected viewers. Responses are `no-store` and marked `noindex`.

## Deployment, data, and logs

For a single executable with dependencies included, build on the deployment
platform, or select a supported Bun target explicitly:

```sh
node_modules/.bin/bun build packages/artifacts/src/main.ts \
  --compile --target=bun-linux-x64-baseline --outfile=/private/release/artifacts
```

Bun may download the selected compilation runtime during this explicit build.
The executable supports `artifacts --bootstrap` followed by `artifacts`. Run as
an unprivileged service user with a private, persistent writable data directory.
No Bun/npm installation is needed on the target. `/healthz` returns JSON only
on the management hostname; the reverse proxy must preserve `Host`. The app
canonicalizes trusted management requests to the configured HTTPS origin.

`artifacts.sqlite` contains documents, revisions, login credentials, OAuth state,
and signing keys. Keep it private. Stop the service for a coherent backup of the
entire data directory (including SQLite WAL/SHM), or use SQLite's online backup
mechanism. Protect `BETTER_AUTH_SECRET` separately and test recovery. Never copy
a live database file alone or assume binary rollback reverses schema migrations.

JSON request logs contain route category, method, status and duration, never
source, cookies, bodies, tokens or OAuth query parameters. Minute process logs
include cumulative CPU time, memory and request totals. Container CPU, memory,
pressure, disk and retention policies belong to the infrastructure layer.

This package neither provisions machines nor changes DNS. Keep deployment-specific
credentials, provisioning instructions, and resource policies in your infrastructure
repository or operational documentation.

## Verification

Tests exercise real SQLite persistence/conflicts/ownership, host isolation,
public revocation, SSE disconnects, owner bootstrap, secure cookies, OAuth PKCE,
MCP tools and invalid-token rejection, and executable startup/shutdown. Desktop
and mobile rendering, hostile-script isolation, publishing confirmation, and
live update/unpublish behavior were also exercised in Chromium. Production
HTTPS OAuth and MCP publication were verified separately; Amp's account-side
registration is not part of these tests.

Better Auth 1.7.6 can print an asynchronous missing-schema diagnostic during
fresh bootstrap and SQLite `string[]`/`TEXT` warnings during repeated migrations.
These are not hidden by the tests; migration completion and real login/token
round trips are asserted. Investigate any such error during normal service
operation rather than treating it as a bootstrap warning.

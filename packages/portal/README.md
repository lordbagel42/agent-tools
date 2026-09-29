# portal

Thread-owned, PIN-protected web previews for a machine you control. The
`@agent-tools/portal` package provides the `portal` CLI, the foreground
`portal-server` daemon, and an Amp tool named `portal`. Loading the plugin only
registers the tool: it does not start a daemon, provision DNS, install services,
authenticate with a provider, or expose anything.

## Prerequisites and HTTPS

- Node.js 22.12 or newer, macOS or Linux, and `/bin/bash` for managed commands.
- A workspace directory whose applications you trust. Commands run as the daemon
  user with its environment and permissions; this is **not a sandbox**.
- Your own domain, wildcard DNS and an **external HTTPS ingress** with a valid
  certificate covering `*.preview.example.com`. Route that wildcard (including
  `login.preview.example.com`) to the daemon, preserving the original Host header
  and WebSocket upgrades. A different login host needs its own DNS/certificate.
  Block direct public access to the daemon's plain HTTP listener. Disable edge
  caching and honor `Cache-Control: no-store`; do not log login-ticket query strings.

There is no automatic tunnel, certificate issuance, DNS registration, or provider
integration. Ingress may be your own reverse proxy or a separately configured
tunnel. The default listener is `127.0.0.1:8787`. Configure ingress on the same
machine or arrange a trusted private connection explicitly. Public preview URLs
always use HTTPS; plain HTTP alone is not a complete deployment (session cookies
are Secure). DNS, TLS and any provider costs remain your responsibility.

## Build and initialize

From this repository, install dependencies using the root workspace workflow, then:

```sh
npm run build --workspace @agent-tools/portal
node packages/portal/dist/cli.mjs init \
  --domain preview.example.com --workspace "$HOME/workspaces"
node packages/portal/dist/daemon.mjs
```

With package binaries on PATH, these are `portal init ...` and `portal-server`.
The workspace must already exist. `init` asks for a 6–12 digit PIN through a hidden
terminal prompt, generates a random signing key, and writes private local files.
Automation can use `--pin-stdin` with input from a password manager or protected
file; never put the PIN in command arguments, shell history, logs, or URLs. There
is no `--pin` argument. `init` refuses to overwrite an existing configuration or
shared PIN. It does not start a server or alter external infrastructure.

The daemon stays in the foreground; Ctrl-C or SIGTERM shuts it down and stops its
managed process groups. No root, systemd, or service installation is required.
Use a supervisor of your choice if you need unattended operation.

### Configuration and storage

Defaults on both supported platforms are:

| Setting        | Default / override                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Config         | `$XDG_CONFIG_HOME/portal/config.json`, falling back to `$HOME/.config/portal/config.json`; `PORTAL_CONFIG` or `--config` |
| State          | `$XDG_STATE_HOME/portal`, falling back to `$HOME/.local/state/portal`; `init --state-dir`                                |
| Control socket | `<stateDir>/control.sock`; `init --socket` or `PORTAL_SOCKET`                                                            |
| HTTP listener  | `127.0.0.1:8787`; `init --port`, then edit `bindHost`/`port` in private config if needed                                 |
| Login host     | `login.<domain>`; `init --login-host`                                                                                    |
| New ID prefix  | `p-`; `init --id-prefix` or private config `idPrefix`                                                                    |

All configured paths must be absolute. The JSON config also holds `domain`,
`workspaceRoot`, `signingKey`, `stateDir`, and `socketPath`. Keep its mode 0600 and
state/socket directories 0700; newly created files/directories use those modes.
Existing parent directories are not chmodded. Keep socket paths short enough for
your platform's Unix socket limit (typically around 100 bytes); use a short private
directory with `--socket` if necessary.

`portal` and the plugin use `PORTAL_SOCKET` when set, otherwise the selected config's
socket, otherwise the default user-local socket. `portal-server --config PATH`
reads that config's socket; ensure clients select the same config or socket.
Environment variables must also be present in the Amp process if used by its plugin.

`idPrefix` must match `/^[a-z][a-z0-9]{0,15}-$/`; validation happens before auth/state
initialization. New IDs append eight random bytes as sixteen hex digits. Different
prefixes can help an external ingress route multiple services, but are **routing
namespaces, not security isolation**. Use separate state directories, sockets,
ports and credentials for separate daemons. Changing the prefix never renames or
filters persisted IDs: old URLs remain usable until expiry if still routed here.

## CLI and Amp

```sh
portal start --name web --cwd "$HOME/workspaces/site" --command 'npm run dev -- --host 127.0.0.1 --port $PORT'
portal expose --name existing --port 3000
portal status --name web
portal list
portal logs --name web
portal restart --name web
portal stop --name web
portal set-pin --name web
portal set-pin
```

CLI ownership comes from `AMP_THREAD_ID` or `--thread T-00000000-0000-0000-0000-000000000001`.
The Amp adapter derives it from the invocation context. Build output
`dist/portal.js` is the single-file plugin advertised by `agentTools.plugin`; load
or copy that built file using your Amp plugin workflow. No global plugin is
installed by this build.

Names are thread-local. Identical `start`/`expose` calls renew the 24-hour lease
and reuse the URL; changed definitions require `stop` followed by `start`.
To change only a running portal's PIN, use `portal set-pin --name web` (hidden
prompt), add `--pin-stdin` for automation, or use the Amp tool's `set-pin` action
with `name` and `pin`. This sets a custom PIN without changing the URL, port,
process, or lease. It revokes that portal's existing sessions and login links and
closes its open proxy connections; visitors must sign in again. Other portals
and the shared PIN are unaffected. The change is saved for daemon restarts.
`portal set-pin` without `--name` still rotates the shared PIN; the Amp tool
requires a name and cannot rotate the shared PIN.

Managed commands receive `$PORT`, `$PUBLIC_URL`, `AMP_THREAD_ID`, and the exact
Vite allowed host. They must stay in the foreground and listen on loopback.
`expose` accepts only a loopback port, never an arbitrary network target.
Check `ready` before sharing: readiness checks local TCP reachability, **not**
external DNS/TLS/HTTP application health. CLI results with `ready: false` exit 1.

Visitors use the ordinary URL and PIN screen. `portal login-url --name web` returns
a **sensitive single-use URL valid for 60 seconds** for authorized browser/curl
automation, not public sharing. Login sessions last eight hours. Shared PIN
rotation invalidates shared-PIN sessions; custom PINs can be supplied with
`start`/`expose --pin-stdin` (or the plugin's secret `pin` field). Avoid placing
secrets in agent-visible tool inputs when stdin is available. PIN hashes and
guessing limits persist privately; plaintext PINs do not. Application logs are
captured up to 64 KiB in memory and may contain application secrets—review before
sharing. This does not implement Amp's native Portal tab, annotations, or multiplayer.

The Unix socket is a trusted local control interface, protected with mode 0600.
Thread IDs prevent accidental cross-thread operations, not impersonation by the
same OS user. Anyone controlling that user can invoke commands and mint login
tickets. Do not use this to expose admin services or untrusted applications.

## Legacy migration and provenance

Migrated from the standalone `raygen-portals` source at revision
`1cfbf9a73df07bb10b9eaefccf7a436674270be1`. The public copy includes implementation,
tests and build configuration, not private runtime configuration, state, history,
or machine-specific operations documentation. The routing-prefix adaptation is
carried forward without changing persisted record IDs. Dependency license notices
are retained in generated bundles by esbuild.

This package does not replace or restart any existing installation. For a planned
migration, separately back up private config and the entire state directory
(`portals.json`, `shared-pin.json`, `pin-attempts.json`) outside Git. Coordinate an
explicit downtime/cutover: never run two daemons against the same state/socket.
Preserve the signing key, domain/login host and record IDs if retaining sessions
and links; update absolute workspace/state/socket paths for the destination.
Do **not** run `init` over migrated state. Unexpired managed commands are relaunched
on daemon startup, so review persisted commands before starting a migrated copy.
Expired records are not restored; ephemeral tickets and captured logs do not survive
restart. Legacy JWT issuer and session-cookie names intentionally remain compatible.

Update callers from `raygen_portal` to `portal`, CLI usage to `portal`/
`portal-server`, and `RAYGEN_PORTAL_SOCKET` to `PORTAL_SOCKET`. Legacy system config
and runtime paths are not consulted automatically. Keep the old installation and
its state separate until an authorized cutover, and keep all backups private.

## Verification

```sh
npm run format --workspace @agent-tools/portal
npm run check --workspace @agent-tools/portal
npm test --workspace @agent-tools/portal
npm run build --workspace @agent-tools/portal
npm run test:browser --workspace @agent-tools/portal
```

Browser checks additionally require `agent-browser` and an installed Chromium;
they use a unique session and disposable loopback server. Tests cover HTTP/WS auth,
PIN behavior, expiry, process lifecycle, readiness, ownership, persistence, init,
and routing prefixes without external accounts. Linux verification does not imply
macOS or a real external HTTPS ingress has been tested. The build uses JavaScript
filesystem APIs and esbuild, not GNU tar or system service tooling.

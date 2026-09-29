# tunnel

Userland, thread-owned OpenSSH forwarding for agents. Node >=20.19 and an existing
OpenSSH client are the only runtime dependencies. macOS ships an SSH client;
install Node separately. No root, daemon installation, cloud relay or public URL.

**SSH reachability is a prerequisite, not a feature this tool creates.** Configure
and verify an SSH alias, trusted host key and noninteractive authentication using
your normal SSH workflow first. Existing `~/.ssh/config` aliases, ports, jump hosts
and identities work. Unknown host keys fail closed; passwords are not collected.
The tool never reads or prints private keys or environment inventories.

## OAuth callback on a remote agent, browser on your Mac

Run this on the **Mac**, not on the remote agent:

```sh
tunnel start oauth --owner my-session --destination agent \
  --direction local --listen-port 1455 --target-port 1455
tunnel status oauth --owner my-session
# Complete the OAuth flow in the Mac browser, then:
tunnel stop oauth --owner my-session
```

`agent` is your existing SSH alias. This connects Mac `127.0.0.1:1455` to
agent `127.0.0.1:1455`. The remote callback server must be running there. The
listener is IPv4 loopback only; a callback using `localhost` must resolve/fall back
to IPv4 (an IPv6-only callback is not supported). Preserve the OAuth provider's
registered callback URL; do not rewrite redirect URLs arbitrarily.

`tunnel list --owner my-session` lists that owner's tunnels. CLI results are JSON.
`TUNNEL_OWNER` can supply the owner. The Amp tool always uses `ctx.thread.id`, not
an agent-supplied owner. Run CLI management with that thread ID to manage its tunnels.

For the opposite direction, use `--direction reverse`: the SSH destination gets
the listener and this executor supplies the target. **First verify the destination
SSH server uses `GatewayPorts no` or `clientspecified`, never `yes`.** A server
configured with `yes` can override even an explicit loopback request into a public
bind. Only after verification pass `--remote-loopback-confirmed` (tool field
`remoteLoopbackConfirmed: true`). The client cannot independently attest server
policy. No arbitrary bind/target hosts are accepted. Listen ports must be >=1024.

## Lifecycle and safety

- A private dedicated OpenSSH control master per owner/name; no global SSH master
  reuse. Configured extra forwards are cleared before adding exactly one forward.
- Strict host checking, batch authentication, `ExitOnForwardFailure`, connect and
  keepalive timeouts. Agent/X11 forwarding and local commands are disabled.
  SSH config remains trusted local executable configuration (e.g. ProxyCommand).
- State is under `~/.agent-tools-tunnel` (0700 directories, 0600 metadata). Override
  with `TUNNEL_STATE_DIR`, a short private user-owned path, if socket path limits
  require it. This is user isolation, not isolation from other processes of your UID.
- Start waits for a control-master acknowledgement and forwarding acknowledgement,
  not a speculative TCP probe that could consume an OAuth callback. It does not
  prove the target service is running. Startup is bounded at roughly 20 seconds;
  individual control operations have a 2-second timeout.
- CLI SIGINT/SIGTERM cancels startup and kills only its still-owned child handle.
  The installed Amp API has no tool AbortSignal; tool startup is deadline-bounded
  but UI cancellation cannot be observed directly. Inspect status/stop afterward.
- Stop uses the private control socket, **never a persisted PID**, avoiding stale
  PID reuse kills. Unverifiable control sockets fail closed. Metadata without a live
  socket is stale. Repeated stop is safe. Per-name mkdir locks prevent concurrent
  start/stop; a hard interruption can require manual inspection/removal of a stale
  `.lock` directory. Do not remove locks during a live operation.
- Tunnels outlive CLI/plugin reloads until explicitly stopped, SSH disconnects or
  the executor exits. There is no automatic reconnect or expiry; stop when done.

## Build and plugin

From the workspace root after `npm ci`:

```sh
npm run build --workspace @agent-tools/tunnel
npm run check --workspace @agent-tools/tunnel
npm test --workspace @agent-tools/tunnel
```

The npm `tunnel` bin is `dist/cli.js`. `agentTools.plugin` points to the standalone
ESM `dist/tunnel.js`; install/load that single file using your Amp plugin workflow.
Reload plugins after updating. It registers one tool, `tunnel`, with
`action: start|status|list|stop`. The implementation follows the actual API from
`amp plugins show-docs`; no runtime SDK dependency is needed.

## Verification scope

Offline tests use a control-master fixture and actual loopback TCP payloads to
exercise local/reverse lifecycle, isolation, strict argument construction, stale
state, failures, cancellation, timeout and permissions. The fixture is **not SSH**.
Linux checks passed on Node 20.19 and 24.21; macOS was not available. A separate
end-to-end smoke test used a disposable unprivileged OpenSSH server bound to
loopback, fresh fixture keys and an isolated known-hosts file. Both local and
reverse forwarding carried an HTTP callback path/query unchanged; status and stop
were verified. The fixture server and keys were removed afterward. No existing
SSH configuration or shared service was changed. Test your own SSH route before
depending on a real callback.

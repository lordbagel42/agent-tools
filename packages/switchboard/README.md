# switchboard

Amp adapter for an **existing Switchboard phone backend**. Provides
`phone_ask_user` and `phone_get_answer`, plus authenticated steering and acknowledged
stop requests for already-bound threads. This package does not provision phones,
start a backend, ring on startup, or create phone sessions.

Build with `npm run build --workspace @agent-tools/switchboard`, then install
`dist/switchboard.js` using `tools install switchboard`. It is disabled without
configuration. Use `AMP_SWITCHBOARD_CONFIG` to select a private JSON file, or the
default `~/.config/amp/switchboard.json`:

```json
{
  "url": "https://switchboard.example.com",
  "token_file": "/absolute/private/path/switchboard.token"
}
```

`PHONE_PLATFORM_URL` and `PHONE_PLATFORM_TOKEN_FILE` override those settings. Store
the bearer token privately (mode 0600); never commit it or pass it through agent
tool arguments. Use HTTPS except for a trusted local connection. Anyone with this
backend's authority can steer or stop bound threads: configure only a backend you
trust. Once configured, the plugin polls the backend for active threads. Pending
or missed phone answers are **not approval**.

The backend contract is JSON POST `/api/v1/phone/rpc` with `{method, params}` and
`{result}` or `{error}` replies. Required methods are `amp_poll` (thread/session
bindings and expiring commands), `amp_ack` (idempotent command acknowledgement),
`ask` (creates a question), and `question` (reads/waits for an answer).

The adapter was recovered from
[`pulumi-homelab/vms/phone-voice/source/amp_switchboard_plugin.ts`](https://github.com/lordbagel42/pulumi-homelab/tree/main/vms/phone-voice/source).
The complete phone platform remains an external dependency, not bundled here.
Its machine-specific SSH installer and infrastructure configuration were not
migrated; this repository's user-local installer replaces the staging mechanism.

`npm test --workspace @agent-tools/switchboard` uses a disposable loopback backend
and synthetic token. It checks disabled behavior, question mapping, pending
answers, and cross-session refusal. It does not exercise a real phone/backend or
establish live steering/cancellation compatibility.

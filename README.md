# agent-tools

Small tools for coding agents, with command-line interfaces and optional Amp
plugins, plus remote MCP services. Everything lives in user space;
installing a tool does not provision infrastructure, log into a provider, expose
ports, or replace a running service.

| Tool                                                | Purpose                                               | Prerequisites                                   |
| --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| [portal](packages/portal/README.md)                 | PIN-protected, thread-owned web previews              | Your HTTPS wildcard ingress/domain              |
| [paint](packages/paint/README.md)                   | Native Codex image generation                         | Full Codex bundle and eligible ChatGPT login    |
| [tunnel](packages/tunnel/README.md)                 | Loopback SSH forwards between devices                 | Existing SSH access and trusted host keys       |
| [tools](packages/tools/README.md)                   | Install, check, update, and uninstall this collection | Git, npm; explicit updates only                 |
| [honcho](packages/honcho/README.md)                 | Opt-in persistent memory for Amp                      | Your Honcho account/configuration               |
| [messages](packages/messages/README.md)             | Experimental paired Google Messages API               | Android phone, explicit account pairing         |
| [messages-login](packages/messages-login/README.md) | Local desktop pairing companion                       | Electron and a desktop session                  |
| [switchboard](packages/switchboard/README.md)       | Phone questions, steering, and stop acknowledgements  | An existing Switchboard backend                 |
| [artifacts](packages/artifacts/README.md)           | Versioned HTML/Markdown publishing through OAuth MCP  | Bun, persistent storage, HTTPS wildcard ingress |
| [uploads](packages/uploads/README.md)               | Single-use file uploads, expiry, and signed webhooks  | Cloudflare Workers, Durable Objects, and R2     |
| [email](packages/email/README.md)                   | Scoped inbox reads and signed incoming-mail webhooks  | Cloudflare Email Routing and Durable Objects    |

## Install and update

Install Node.js **22.12+**, npm, and Git on macOS or Linux. Review this repository,
then bootstrap from a checkout:

```sh
git clone https://github.com/lordbagel42/agent-tools.git
cd agent-tools
node packages/tools/bin/tools.js install tools tunnel paint portal
export PATH="$HOME/.local/bin:$PATH"
tools status
tools check
tools update
```

The bootstrap command uses a **separate managed checkout** of GitHub `main`, not
the checkout it was launched from. Add `~/.local/bin` to your shell's PATH
permanently. Select other tools with `tools install honcho`, etc. Installation
creates user-local CLI links and plugin entries and refuses collisions. Reload Amp
plugins explicitly after an update. Nothing updates in the background.

`tools check` fetches update information without merging/building. `tools update`
preserves your selected tools, refuses dirty or divergent checkouts, and only
fast-forwards. It runs trusted build code with your user permissions. **Updates
are not atomic:** a failed build can leave the checkout updated; status reports
the last successful build separately. See the [failure model](packages/tools/README.md).

Existing manual/global plugin installs are not adopted or overwritten. Plan any
cutover separately, especially for stateful `portal` and `honcho` installations.

`artifacts` is a separately operated server, not an installable local plugin or
CLI. Follow its [bootstrap and deployment instructions](packages/artifacts/README.md),
then register its remote MCP endpoint explicitly. `tools update` does not migrate
its database, restart its service, or deploy it.

`uploads` is a separately deployed Cloudflare Worker with a remote MCP endpoint,
not a local CLI/plugin. Follow its [deployment instructions](packages/uploads/README.md).
`email` is also a separately deployed Worker; its [routing setup](packages/email/README.md)
requires reviewing existing mail delivery before any catch-all changes.
These services are not deployed or updated by `tools update`.

## An OAuth callback on your Mac

With `agent` configured as an SSH alias for the machine running the callback
listener, run **on the Mac**:

```sh
tunnel start oauth --owner login --destination agent \
  --direction local --listen-port 1455 --target-port 1455
# Complete sign-in in your Mac browser.
tunnel stop oauth --owner login
```

This forwards Mac `127.0.0.1:1455` to the agent machine's loopback listener. It
requires working SSH connectivity; it is not a NAT-traversal service or public
URL provider. No administrator access or remote installation is needed beyond
the existing SSH server.

## Develop from source

```sh
npm ci --ignore-scripts
npm run build --workspace @agent-tools/tunnel
node packages/tunnel/dist/cli.js --help
```

Dependencies are pinned by the root lockfile. Automatic dependency install hooks
are disabled. To run Honcho's Bun-based tests (or other Bun workspaces), explicitly
provision the pinned runtime with `npm rebuild bun`. Browser fixture tests need
Chromium: `npx playwright install chromium`. The optional desktop helper needs
`npm rebuild electron` and a working display; neither download is part of normal
CLI/plugin installation. Python 3 is only needed for paint's optional legacy
callback helper.

```sh
npm run format
npm run types --workspace @agent-tools/uploads
npm run check
npm test
npm run build
```

Uploads' generated Worker types are ignored; regenerate them before `check` in
a fresh checkout. Its build is a local dry run and never deploys the Worker.

Use `--workspace @agent-tools/<name>` for scoped checks. Browser/Electron and live
account checks are separate commands documented by their packages. Core fixture
tests use disposable local state. The Messages API remains experimental: its
unsupported protocol and broad Google-session-cookie pairing are significant
trust/compatibility constraints. Read its security documentation first.

## Public source and privacy

[AGENTS.md](AGENTS.md) requires public, portable code and secret-free fixtures.
[PROVENANCE.md](PROVENANCE.md) records recovered sources and exclusions. Runtime
credentials, sessions, logs, private infrastructure, and generated images are not
part of this repository. This migration does not replace existing installations.

No project-wide license has been selected yet. Public visibility alone is not an
open-source license; do not publish packages or claim redistribution rights until
the owner selects one and reviews the retained third-party notices/provenance.

# Source provenance

The initial migration recovered source, tests, and build instructions from the
author's tool-building conversations and their authoritative local checkouts.
Sources were copied without Git histories, runtime state, credentials, or deployed
configuration. Original repositories/installations were left intact.

| Package                      | Source                                                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `portal`                     | [`lordbagel42/raygen-portals`](https://github.com/lordbagel42/raygen-portals/commit/1cfbf9a73df07bb10b9eaefccf7a436674270be1), plus the subsequent configurable routing-prefix adaptation              |
| `paint`                      | Authored Python callback helper from the DIY Painter experiment; the CLI/Amp wrapper was implemented here using an independently live-verified native Codex invocation                                 |
| `honcho`                     | Custom independent Amp implementation from the author's global plugin source; inspired by [`plastic-labs/claude-honcho`](https://github.com/plastic-labs/claude-honcho), not an official Honcho plugin |
| `messages`, `messages-login` | Latest local source from [`lordbagel42/google-messages-api`](https://github.com/lordbagel42/google-messages-api), including previously uncommitted native transport and desktop helper work            |
| `switchboard`                | Amp adapter from [`pulumi-homelab/vms/phone-voice/source`](https://github.com/lordbagel42/pulumi-homelab/tree/main/vms/phone-voice/source), including its existing SDK compatibility fix               |
| `tunnel`, `tools`            | New implementations for this collection                                                                                                                                                                |
| `artifacts`                  | Independently authored for this collection as a self-hosted remote MCP service; deployment and operator data remain outside this repository                                                            |
| `uploads`                    | Independently authored for this collection as a Cloudflare-hosted remote MCP service; deployment configuration and account credentials remain outside this repository                                  |

Messages protocol research used public Google material and the AGPL-licensed
[`mautrix/gmessages`](https://github.com/mautrix/gmessages) reference. The recovered
architecture document describes an independent TypeScript implementation without
copied Go implementation code. Preserve that attribution and review provenance
before redistribution; the migration is not a legal clearance. Other dependencies
retain their own licenses. No new project license is inferred from dependencies.

The inventory intentionally excludes:

- Third-party tools/plugins merely installed or used (Tavily, agent-browser,
  Cloudflare, upstream Superpowers), rather than vendoring their source.
- Personal preference hooks and private runner guidance.
- June application internals; those remain owned by its application repository.
- DIY-orb/Proxmox provisioning, phone backend infrastructure, SSH staging scripts,
  Pulumi stacks, and other machine-specific deployment machinery.
- Private account configuration, browser profiles, auth caches, real messages,
  images, traces, login URLs, and old deployment archives.

This inventory covers identified reusable tools, not a claim that every historical
thread or application script has become a standalone package. New tools should be
added as independently documented packages with explicit runtime requirements.

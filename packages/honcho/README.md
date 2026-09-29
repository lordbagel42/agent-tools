# Honcho for Amp

A native TypeScript port of the core [Claude Honcho integration](https://honcho.dev/docs/v3/guides/integrations/claude-code). It adds automatic context and opt-in conversation capture alongside your existing Honcho MCP. It does not reconfigure that MCP or obtain its credentials.

The plugin has **no runtime dependencies** beyond Amp's Bun runtime. Development dependencies in `package.json` are only for tests, linting, formatting, and type checking. Only documented, non-experimental Amp APIs are used.

## Setup

Build this workspace package and install its `dist/honcho` directory with the repository's plugin manager. The `agentTools.plugin` manifest field identifies that directory; the manager must link the entire directory as `honcho`, not just `index.js`, so Amp can resolve the bundled skill. Do not install both this copy and another Honcho plugin in the same scope. Installation does not enable memory or migrate private configuration.

Once Amp has loaded the plugin, run **Honcho: Setup** from its command palette, or ask Amp to load `honcho:using-memory` and call `honcho_setup`.

1. Select the Honcho API endpoint, workspace, user peer, and assistant peer.
2. Enter a key in Amp's **secret input dialog**, not in chat. Existing `HONCHO_API_KEY` or Honcho config credentials can be used instead.
3. Choose conversation capture or retrieval only.
4. Review the effective destination and explicitly approve enablement.

Setup writes only `hosts.amp` in `~/.honcho/config.json`, preserving other hosts. It uses an atomic replacement with mode 0600 and a lock between Amp writers. It makes no network requests and does not validate the live key; use `honcho_get_briefing` afterward to exercise the connection. The file is local to the executor: global plugin publication does not distribute credentials or configuration to other machines or orbs.

An existing Claude config with `enabled: true` **does not enable Amp**. Native memory requires `hosts.amp.enabled: true` or `HONCHO_AMP_ENABLED=true`. Root `enabled: false`, `HONCHO_ENABLED=false`, or `HONCHO_AMP_ENABLED=false` always disables it. `honcho_get_config` / **Honcho: Status** reports local settings without returning the API key or making a network call.

### Sharing memory with the connected MCP

Use the same Honcho endpoint, organization/key scope, workspace, user peer, and observation mode as the MCP. With `directional` observation, also match the assistant peer. Otherwise the plugin deliberately uses its own `amp` workspace and assistant identity. The user peer defaults to your Amp username, not the runner's shared Linux username.

This shares peer-level knowledge, not necessarily session history: Amp creates its own deterministic session IDs. It cannot inspect the MCP's remote credentials or infer its active identity. Avoid manually uploading the same turns through both integrations.

## Configuration

Example settings, initially disabled; credentials are deliberately omitted:

```json
{
  "hosts": {
    "amp": {
      "enabled": false,
      "workspace": "amp",
      "peerName": "example-user",
      "aiPeer": "amp",
      "endpoint": { "environment": "production" },
      "sessionStrategy": "per-directory",
      "sessionPeerPrefix": true,
      "observationMode": "unified",
      "saveMessages": true,
      "saveToolUse": false,
      "saveGitEvents": false,
      "timeoutMs": 4000,
      "maxContextChars": 12000,
      "redactPatterns": [],
      "injection": {
        "sessionStart": ["directives", "summary", "peerCard"],
        "perTurn": ["userContext"],
        "searchTopK": 10,
        "maxConclusions": 15,
        "searchMaxDistance": 0.6,
        "sessionContextTokens": 1500
      }
    }
  }
}
```

Non-routing fields inherit root Honcho settings and are overridden by `hosts.amp`. The API key resolves from `hosts.amp.apiKey`, then `HONCHO_API_KEY`, then root `apiKey`. Workspace and assistant defaults do not inherit Claude's legacy flat fields; `globalOverride: true` plus root `workspace` explicitly shares a workspace between hosts. Configuration is re-read for each turn/tool. Invalid JSON, identities, endpoints, or custom regexes fail closed rather than using stale settings.

`honcho_set_config` changes capture, injection, session strategy, observation mode, limits, and redaction patterns after human approval. Use setup for credentials and destination changes. Disabling capture takes effect for future callbacks, including completion of an already-started turn; a request already accepted by Honcho cannot be recalled. An in-flight turn stays pinned to the session/config where it began instead of being uploaded to a newly selected destination.

Supported environment bootstrap variables are `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_AI_PEER`, `HONCHO_WORKSPACE`, `HONCHO_ENDPOINT`, `HONCHO_AMP_ENABLED`, `HONCHO_ENABLED`, `HONCHO_SAVE_MESSAGES`, `HONCHO_SAVE_TOOL_USE`, and `HONCHO_SAVE_GIT_EVENTS`. `HONCHO_CONFIG_PATH` selects an alternate local config file. Boolean environment values are the literal strings `true` and `false`. Host settings generally override environment defaults; the explicit disable switches always win.

`endpoint.environment` accepts `production` or `local` (localhost:8000). `endpoint.baseUrl` accepts an HTTPS URL or loopback HTTP; a missing `/v3` suffix is added. Credentials, query strings and fragments in URLs are rejected. Redirects are not followed. Remote self-hosted endpoints must use HTTPS.

### Memory injection

Session-start choices: `directives`, `summary`, `peerCard`, `peerRepresentation`, `briefing`. Startup context is inserted on the first prompt after opening/resuming a session, because Amp's `session.start` callback cannot return context. `briefing` nudges the agent to call the briefing tool; normally use it instead of inline summary/card.

Per-turn choices: `userContext`, `assistantContext`, `sessionContext`, `dialectic`. Empty arrays disable a surface. User/assistant retrieval is prompt-scoped; raw session context has its own token budget. Optional dialectic uses low reasoning and the same short automatic deadline rather than blocking a prompt for two minutes. All injected content is bounded by `maxContextChars`, redacted, escaped and labeled untrusted background, never authorization.

Missing components are omitted independently, so a missing session summary does not suppress peer context. The startup peer card and summary are not repeatedly loaded within an open session. Per-turn context is fresh; there is no local memory-content cache.

### Sessions and git

- `per-directory`: the canonical repository directory, resolving nested directories and linked worktrees to the main checkout. Outside git it uses the directory path. Without a workspace it uses a shared `no-workspace` session; choose `chat-instance` to separate those conversations.
- `git-branch`: the same directory identity plus current branch (or commit when detached).
- `chat-instance`: the stable Amp thread ID, so reopening the same thread preserves its memory session.

Names include a readable directory/user prefix and a hash to prevent basename and truncation collisions. Absolute paths contribute to directory/branch identity: moving a checkout or using a different path on another machine creates a different session. Peer-level knowledge still carries across sessions in the same workspace. Amp's workspace root is authoritative; running a shell tool in another directory does not retarget the memory session.

Optional git capture records branch, HEAD and tracked dirty-state changes observed between prompts. It does not upload diffs, file bodies or commit messages, persist git snapshots across plugin restarts, or claim whether a change was external to Amp. Optional tool capture stores only tool name and terminal status, never arguments or output.

## Capture and privacy boundaries

User prompt text is saved before inference. At turn completion (including cancellation/error), the plugin saves assistant text blocks. It never uploads thinking blocks, image/file attachments, raw tool arguments/results, or the historical transcript. Other plugins' injected context is not re-uploaded from the final thread message: the original `agent.start` prompt is retained for the current turn only.

**Assistant text can contain code, and user prompts can contain private information.** Redaction recognizes the configured key, common tokens, private-key blocks, credential assignments and custom regexes; it is not a guarantee against sensitive disclosure. Prompt text is also sent in retrieval queries when `saveMessages` is false. Set `enabled: false` to disable native network access entirely; this does not disable the separate MCP.

The API does not expose per-message author identity in these lifecycle events. All captured user text is attributed to the configured user peer. Do not enable automatic capture for multiplayer or mixed-author threads unless that shared attribution and disclosure are intended. Enabling this global plugin's local config applies across projects on that executor.

No transcript spool or content log is written locally. Hooks warn once per opened thread session on setup/upload failure and let Amp continue. Automatic operations have a shared 4-second default network budget per lifecycle callback, plus bounded git commands. Explicit memory tools allow 30 seconds. Large transcripts or outages can exhaust the budget and leave messages unsaved; there is no offline backfill queue.

Uploads are serialized per thread/session client and identified by Amp thread ID, message ID, message kind and chunk index in Honcho metadata. The plugin checks metadata before each chunk, preserves Unicode boundaries, and disables HTTP retries. A successful-but-unacknowledged write can be discovered on replay. **This is not exactly-once delivery:** Honcho has no atomic client idempotency key, and simultaneous executors can race. A process crash/reload can lose an in-flight assistant response. Deleting a conclusion requires human approval and verifies the observation pair before deletion.

## Port scope

Included: automatic capture/context, three session strategies, unified/directional observations, opt-in git/tool summaries, search/chat/parallel recall, conclusion create/list/query/delete, briefing/context/representation, configuration/setup/status, and a bundled preference-interview workflow. Tools are gated behind `honcho:using-memory` so they do not crowd unrelated prompts.

Not included: historical Claude/Amp transcript import, pre-compaction hooks (Amp has none), Claude terminal art/statusline, automatic AGENTS.md edits, observation migration, assistant summarization/token upload limits, topic extraction, the upstream refresh cache, dialectic templates/reasoning-tier configuration, and per-component terminal visibility. Unsupported upstream fields are preserved on disk but are not implemented by this port.

## Development and verification

From the repository root (npm workspaces with a single root lockfile):

```sh
npm ci --ignore-scripts
npm run build --workspace @agent-tools/honcho
npm run check --workspace @agent-tools/honcho
npm run test --workspace @agent-tools/honcho
npm run format --workspace @agent-tools/honcho
```

Build uses Node.js and esbuild, not Bun, and emits `dist/honcho/index.js` plus `dist/honcho/skills/using-memory/SKILL.md`. Amp types are development-only imports; the bundle has no npm runtime dependencies. Keep npm optional dependencies enabled so esbuild's platform binary is available even with lifecycle scripts disabled. There are no install hooks that build, enable, or reload this plugin. Generated output and dependencies are ignored; do not create a package-local lockfile.

Tests require Bun 1.4.2 (listed as a development dependency). An `--ignore-scripts` install may leave the npm Bun launcher unprovisioned on some platforms. Explicitly run `npm rebuild bun` after reviewing its installer, or provision Bun separately on PATH and run `node packages/honcho/test.js` from the root. The latter avoids npm's unprovisioned local launcher taking precedence over PATH. Neither is needed for build or typecheck. Git is needed for temporary-worktree tests. Only this package's tests are run, not unrelated plugins' tests.

Tests exercise real fetch against loopback mock Honcho endpoints, real temporary config files/git worktrees, and the registered Amp handlers. `npm test` strips inherited `HONCHO_*` environment variables before starting Bun, so fixtures cannot accidentally use your live key or routing overrides. Use this wrapper rather than calling `bun test` directly. Tests do not use your connected MCP or production memory.

When `amp` is on PATH, the runtime test loads a temporary copy of this plugin and its bundled skill inside a real Amp plugin process, then verifies context retrieval and synthetic user/assistant capture against the loopback mock. The tested CLI dispatches `session.start` through `plugins exec` but does not invoke request hooks such as `agent.start`. The test therefore uses a temporary adapter to call the registered turn handlers from `session.start`; it does not prove real thread event delivery. It does not install/reload plugins in your configuration or run an agent. A live end-to-end check requires separate credentials and explicit approval to upload a synthetic conversation.

API contracts were checked against [Honcho SDK 2.5.1](https://github.com/plastic-labs/honcho/tree/main/sdks/typescript), the [upstream MIT-licensed integration](https://github.com/plastic-labs/claude-honcho), and `amp plugins show-docs` on 2026-09-25. This is an independent Amp implementation, not an official Honcho release.

## Attribution and provenance

This independently authored Amp implementation was based on the behavior of Plastic Labs' [MIT-licensed claude-honcho integration](https://github.com/plastic-labs/claude-honcho). The MIT attribution describes that upstream project, not a newly assigned license for this code. The recovered source supplied no license file; this migration does not invent one.

Recovered from the `honcho-native` source at revision `41cd104638beca8262272d4b79b94f9267cd266a`. Runtime source and privacy controls are preserved; package/build integration, development documentation, and synthetic example identities are adapted for this public workspace. No private Honcho configuration or memory state is included.

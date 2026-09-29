# paint

`@agent-tools/paint` supplies the `paint` CLI and an Amp tool named `paint`.
It asks **Codex's native image generator** for one PNG using your existing
ChatGPT login. It does not call Amp's built-in Painter, perform login, install
Codex, or fall back to a paid API key.

## Requirements and setup

- Node.js **20.19 or newer**, Linux or macOS. Offline checks were run on Linux;
  macOS has not been exercised.
- A **complete official Codex platform bundle**, including companion programs
  such as `codex-code-mode-host`. A standalone copied binary is insufficient.
  The invocation targets Codex **0.157.1**; older/different versions may lack
  the required flags or native image feature. Obtain the appropriate release
  from [openai/codex](https://github.com/openai/codex/releases).
- A user-owned Codex home with an existing **ChatGPT file-store login**. Authenticate
  separately using the official executable and its documented login flow. The
  wrapper never reads credentials itself: only that executable uses the login.

Native image access depends on the provider's current account eligibility,
subscription, regional availability, rollout, usage limits and remaining quota.
A ChatGPT subscription does **not** guarantee this feature is available, free,
or unlimited. A run can consume quota even when the wrapper subsequently rejects
its artifact, times out, or is cancelled. There are no automatic retries.

From this repository, install workspace dependencies and build:

```sh
npm install
npm run build --workspace @agent-tools/paint
node packages/paint/bin/paint.js --help
```

The CLI bin is `bin/paint.js`; the plugin metadata points to the self-contained
ESM bundle `dist/paint.js`. Use the repository's installer or explicitly install
that bundle in Amp. Loading the plugin only registers the tool: it makes no
network request, login attempt, or installation. No live installation is part
of the build.

## CLI

```sh
paint --prompt 'A red paper boat on a quiet lake' --output ./boat.png
paint --prompt 'Redraw this as a pencil sketch' --output ./sketch.png \
  --image ./reference.png --image './another reference.jpg'
```

Output must end in `.png`, have an existing writable parent directory, and **not
already exist**. Success prints JSON containing the absolute `output` path and
byte count. Failure exits nonzero without exposing subprocess logs or prompt
content. Reference paths are resolved before entering the disposable directory,
then supplied as repeated Codex `--image` arguments (not embedded as prompt
text). Up to eight regular files of at most 32 MiB each are accepted; Codex
decides supported reference image formats. Prompts are passed to Codex on stdin,
not in its process arguments; the CLI's own `--prompt` argument can still be
visible to local process inspection and shell history.

| Setting                 | CLI flag       | Environment                           | Default         |
| ----------------------- | -------------- | ------------------------------------- | --------------- |
| Codex executable        | `--executable` | `PAINT_CODEX_EXECUTABLE`              | `codex` on PATH |
| Codex home              | `--codex-home` | `PAINT_CODEX_HOME`, then `CODEX_HOME` | `~/.codex`      |
| Timeout in milliseconds | `--timeout-ms` | `PAINT_TIMEOUT_MS`                    | `300000`        |

Flags override environment settings. Timeout range is 1–900000 ms. CLI SIGINT
and SIGTERM cancel the child process group, escalating from TERM to KILL after
one second on Unix. The exported `paint(input, config)` function also accepts
`config.signal`. The current Amp plugin tool API exposes no cancellation signal;
its subprocess is bounded by the configured timeout.

### Persistent machine configuration

To keep a pinned bundle and login working across `tools update`, store paths in
`$XDG_CONFIG_HOME/paint/config.json` (default `~/.config/paint/config.json`),
not in a custom CLI or plugin wrapper. Both entrypoints read it when invoked:

```json
{
  "executable": "/home/example/.local/share/codex/bin/codex",
  "codexHome": "/home/example/.local/share/paint/codex-home",
  "timeoutMs": 300000
}
```

Use your actual absolute paths. All three fields are optional; unknown fields,
invalid JSON, relative paths and invalid timeouts fail before Codex starts.
`PAINT_CONFIG` can select another file; an explicitly selected missing file fails
rather than silently using a different login. A missing default file is allowed.

Precedence is explicit CLI/API options, then `PAINT_*` environment settings,
then this file, then the defaults above. A saved `codexHome` takes precedence
over the generic `CODEX_HOME` variable. Keep credentials in the chosen Codex home,
not this file or the repository. The updater does not modify this configuration,
install a Codex release, synchronize logins, or refresh credentials itself.

## Amp

Configure the executable and Codex home using the user configuration above or the
**plugin executor's environment**, not tool input; model-supplied executable
paths are deliberately not accepted. Loading the plugin does not read the file
or start Codex; configuration is read only when `paint` is invoked.

```json
{
  "prompt": "A red paper boat on a quiet lake",
  "output": "/absolute/path/to/boat.png",
  "images": ["/absolute/path/to/reference.png"]
}
```

The tool returns the local output path and size. It does not automatically upload
the image to Amp. Ask the agent to inspect/share the resulting file separately.
The tool sends the prompt and selected reference files to the configured Codex
provider; use it only with authorization to generate and share that content.

## Verification and safety boundaries

Each invocation runs in a new empty working directory, with shell tools disabled,
native image generation enabled, read-only sandboxing, ephemeral mode,
`--ignore-user-config`, `--ignore-rules`, and `project_doc_max_bytes=0`.
`forced_login_method="chatgpt"` and file credential storage select the existing
subscription login. The child environment is allowlisted; API keys, provider
URL/model overrides, proxy variables and Node loader hooks are not forwarded.
The executable's directory is prepended to a minimal system PATH for its bundled
helpers. This may require extra setup in environments that depend on proxies or
custom certificate variables; those are deliberately not passed through.

**Exit 0 is not success.** The wrapper requires a `thread.started` JSONL event,
a schema-constrained final `{ "image_path": "..." }` response, and independently
discovers exactly one PNG in `CODEX_HOME/generated_images/<thread>/`. The model's
path must match this discovery. It rejects symlink directories/files, hardlinks,
old or oversized files, invalid PNG signature/chunk boundaries/CRCs, missing
IEND, prose-only results and ambiguous multiple PNGs. Artifact reads are bounded
at 32 MiB, final JSON at 16 KiB, combined stdout/stderr at 1 MiB. The PNG check
is a structural integrity check, not a full pixel decoder or content-safety
scanner. Timestamp validation assumes a normally functioning local filesystem
clock. Treat the configured executable and Codex home as trusted user-owned
state; this is not isolation against another process actively mutating that
state or a malicious executable. The prompt requests exactly one native call;
the wrapper cannot independently audit provider-side call counts.

Temporary prompt-response/schema files are removed. Codex may retain its own
generated PNG and operational state in its home despite ephemeral session mode;
the wrapper does not delete or manage that state. Output copies are created
with mode 0600 and exclusive creation, without overwriting existing files.

The integrated CLI was live-verified on Linux against Codex 0.157.1 during
migration: structured output, JSONL thread matching, artifact discovery and PNG
validation produced an inspected 1536×1024 image. Reference-image generation,
live Amp invocation and macOS still need separate verification. Offline tests
cannot establish account eligibility or provider behavior.

## Optional legacy callback helper

`legacy/callback.py` and `legacy/test_callback.py` were recovered from the author's
DIY Codex Painter experiment; no authentication, log, or runtime files were
copied. This is **not** required by the CLI or plugin. Prefer the repository's
`tunnel` tool for a loopback OAuth callback flow where possible.

If a copy/paste bridge is necessary, independently start an official Codex login
and put just its current authorization URL into a private local file. Run:

```sh
python3 packages/paint/legacy/callback.py \
  --auth-url-file "$HOME/.local/state/paint/current-auth-url" \
  --public-url https://login.example.com --port 8765
```

Alternatives: `PAINT_AUTH_URL_FILE`, `PUBLIC_URL`, `PORT`. An **authenticated HTTPS
portal** must already protect the public origin and proxy to `127.0.0.1:8765`.
HTTPS alone is not authentication: the helper cannot verify the portal's access
policy, so do not expose it directly or on a public unauthenticated tunnel.
Disable proxy request-body/query logging for this endpoint. Callback URLs and
authorization URLs are credentials: never paste them in chat or source control.
Stop the helper, remove the private URL file and close the portal after use.

The helper checks exact loopback destination, current OAuth state, same-origin
POST and a CSRF token; it follows only the expected local success redirect and
never displays upstream tokens. The attempt expires after 30 minutes. It does
not start a browser or establish a tunnel automatically.

## Offline development checks

```sh
npm run format --workspace @agent-tools/paint
npm run check --workspace @agent-tools/paint
npm test --workspace @agent-tools/paint
npm run build --workspace @agent-tools/paint
npm run test:python --workspace @agent-tools/paint
# Optional: needs agent-browser and its Chrome installation, no account/network login.
npm run test:browser --workspace @agent-tools/paint
```

Node subprocess fixtures use disposable homes and synthetic PNGs. Python unit
tests require only the standard library; the opt-in browser regression uses a
unique session and local synthetic OAuth listeners, never actual login.

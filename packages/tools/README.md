# tools

`@agent-tools/tools` installs this repository's selected CLI tools and Amp plugins
into user-owned directories. Node **20.19+**, npm and Git are required. Linux and
macOS are supported; no sudo, system service, cron job or background updater is used.

## Bootstrap and everyday use

From a reviewed checkout of this repository (no npm release is assumed):

```sh
node packages/tools/bin/tools.js install tools
# Ensure ~/.local/bin is on PATH, then:
tools install                  # add every advertised workspace tool
tools install package-name     # or select workspace directory IDs / npm names
tools status                   # local-only, read-only health report
tools check                    # explicitly fetch and compare; no build or merge
tools update                   # fetch, fast-forward, install dependencies, build
tools uninstall package-name   # remove this tool's owned links
tools uninstall                # remove all owned links; retain checkout and state
```

The bootstrap CLI does not mutate the checkout it was launched from. It clones
`https://github.com/lordbagel42/agent-tools.git`, branch `main`, into an isolated
managed checkout. The repository must have a committed root npm lockfile.

| Setting        | Default / override                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Managed data   | `$XDG_DATA_HOME/agent-tools` or `~/.local/share/agent-tools`; `--state-dir`, or `AGENT_TOOLS_HOME` |
| CLI links      | `~/.local/bin`; `--bin-dir`                                                                        |
| Amp links      | `$XDG_CONFIG_HOME/amp/plugins` or `~/.config/amp/plugins`; `--plugin-dir`                          |
| Initial source | `--source https://github.com/OWNER/REPO.git`                                                       |
| Initial branch | `--branch main`                                                                                    |

Set these flags on first install. Destinations/source/branch are recorded, and
subsequent commands refuse conflicting overrides. Pass the same `--state-dir` on
later commands if not using the default. macOS uses the same XDG-style defaults.

The Amp plugin registers `tools_status`, `tools_check`, `tools_install`,
`tools_update`, and `tools_uninstall`. Loading it only registers tools: it never
downloads, fetches, builds or silently updates. Mutations require an explicit tool
invocation; existing Amp sessions may need a manual plugin reload after updating.

## Installation contract

Discovery reads root `workspaces: ["packages/*"]` (also the npm object form) and
each workspace's `package.json`. Plugins advertise `agentTools.plugin`, a relative
file (`.js`, `.mjs`, `.cjs`, `.ts`) or directory containing `index.js`/`index.ts`.
CLI entrypoints use npm's standard `bin` string or object; CLI-only packages need
no plugin metadata. Workspaces advertising neither are not installed. Package paths cannot
escape their workspace, including through existing symlinks. Plugin link names
use the workspace directory ID, with the extension for file plugins.

Install runs `npm ci --ignore-scripts --no-audit --no-fund`, then explicitly runs
each **selected** workspace's build script with `--ignore-scripts --if-present`.
This suppresses automatic lifecycle/pre/post hooks, not the requested build itself.
Selected builds must be self-contained (or build their required dependencies).
Build output and `node_modules` must be gitignored; tracked CLI files should have
their executable bit committed. CLI targets are made executable when linked.
An update preserves the installed selection, never opting into new tools.

CLI and directory-plugin links are absolute symlinks. File plugins use small
regular JS/TS entry files that re-export the built plugin from the managed
checkout, so Amp's `load_plugin` can reload them (it rejects symlink paths).
Existing recorded file-plugin symlinks migrate on the next install/update.
Reload plugins explicitly after updating; already-loaded code is not refreshed
by changing its files.

Existing files, directories and unmanaged symlinks (even dangling ones) are
never adopted or overwritten. Missing/replaced owned symlinks or edits to a
managed plugin entry stop mutations; restore the original before retrying.
Uninstall only removes recorded entries, not caches, checkout, configuration,
or unrelated files. Removing `tools` itself removes its CLI link too; the
bootstrap CLI remains available from a checkout.

## Migrating a manual installation

`tools update` only updates a recorded installation. It does not infer ownership
of copied plugins, custom launchers, or an uncommitted source snapshot. Before
cutting over, publish/review the desired source branch with its root lockfile;
an empty remote cannot supply updates. Keep the old snapshot and individually
back up the reviewed CLI/plugin destinations that would collide with installation.
Do not delete unrelated/global plugins or fabricate managed state.

Move machine settings outside the checkout and generated entrypoints:

- Paint supports `~/.config/paint/config.json` for the pinned executable and
  Codex home; see [paint configuration](../paint/README.md#persistent-machine-configuration).
  Keep the full Codex bundle and private login in their existing locations.
- To use an existing portal daemon, its client can read a JSON file containing
  just `socketPath` at `~/.config/portal/config.json` (or `PORTAL_CONFIG`). This
  does not initialize, migrate, restart or deploy the daemon. Retain its state
  and authentication separately. A socket-only client config cannot run a daemon.
- Preserve existing global plugins such as Honcho instead of also selecting a
  duplicate local package. Desktop companions and separately deployed services
  without CLI/plugin metadata are not managed by this updater.

Then run the reviewed bootstrap's `install` with the intended package selection,
verify `tools status`, `tools check`, and a first `tools update`, and reload the
installed plugins. Restore the backed-up manual entries if cutover fails; don't
use force deletion to bypass collisions. Subsequent updates preserve the chosen
packages and external configuration, but do not install/update Codex, pair
accounts, provision optional Electron/Bun runtimes, or restart services. Download
those runtimes explicitly where needed; dependency lifecycle hooks stay disabled.

## Source trust and failure model

**Installing/updating executes code from the chosen GitHub repository and its
dependencies with your user privileges.** Fast-forward validation is not a code
review, signature verification, sandbox or supply-chain guarantee. Review and
trust the source before invoking mutation commands. URLs with credentials,
query strings, SSH helpers or non-GitHub hosts are rejected. Global/system Git
configuration and inherited `GIT_*` overrides are excluded from subprocesses;
this also means custom global credential helpers/proxies are not supported.
There is no automatic authentication setup; the default public source needs none.

Updates refuse a dirty checkout, changed origin, unexpected branch/local commits,
rewritten/divergent upstream history, and missing or overwritten owned links.
They fetch a specific source branch and merge with `--ff-only`; there is no reset,
force push, arbitrary working-copy adoption or destructive cleanup.

**Updates are not atomic and do not roll back.** A merge can succeed before a
dependency install, build, or link operation fails; existing symlinks point into
that same checkout. State records the checkout revision separately from the last
successful build revision. Fix the failure and explicitly retry. A crash between
a filesystem action and state save may require manual reconciliation. The empty
`operation.lock` directory prevents concurrent mutations; after a crash, verify
no operation remains before manually removing that lock. Do not erase local work
to bypass safety checks. Keep the managed checkout dedicated to the installer.

## Development / offline tests

From the repository root after dependencies are installed:

```sh
npm run format --workspace @agent-tools/tools
npm run check --workspace @agent-tools/tools
npm test --workspace @agent-tools/tools
npm run build --workspace @agent-tools/tools
```

Build emits `dist/tools.js`, a single-file ESM Amp plugin containing only Node
built-in imports. CLI code uses the same manager. Tests use temporary local Git
repositories with dependency-free npm lockfiles and temporary bin/plugin paths;
they never install into your real Amp directory. `--allow-local-source` explicitly
permits an absolute local fixture repository and must be supplied again for later
commands. Local sources still get exact-origin, clean-checkout, and fast-forward
checks; the Amp plugin intentionally does not expose this fixture-only switch.

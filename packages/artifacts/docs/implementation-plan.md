# Artifact Publisher Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Keep implementation and verification in the checkout containing the work.

**Goal:** Publish versioned interactive documents through an owner-authorized remote MCP service.

**Architecture:** Bun/Elysia serves a trusted management/viewer shell and sandboxed content. SQLite persists drafts, public pointers, history, and Better Auth OAuth state. Operators manage hosting and infrastructure separately.

**Tech Stack:** Bun, Elysia, SQLite, Better Auth MCP, MCP TypeScript SDK v2, Zod, Biome.

**Spec:** [design.md](design.md)

## Global constraints

- Source size limit: 16 MiB. Private drafts, explicit publication, immutable history.
- One authorized owner; no public signup. Secrets and real data stay out of Git.
- HTTPS, configurable hostnames, and private persistent storage for production.
- Work only within this package; preserve concurrent changes.

## Task 1: Revision storage

Files: `src/store.ts`, `test/store.test.ts`.

- [ ] Write tests against a real temporary SQLite database: create returns revision 1,
  publishing revision 1 followed by draft revision 2 still publicly serves revision 1,
  stale `expectedRevision: 1` after revision 2 conflicts, another owner cannot read,
  unpublish removes public source, and reopening the database preserves both versions.
- [ ] Run `npm test --workspace @agent-tools/artifacts`; confirm the missing storage behavior fails.
- [ ] Implement `ArtifactStore` with `create(owner,input)`, `update(owner,slug,input)`,
  `read(owner,slug,revision?)`, `list(owner)`, `history(owner,slug)`,
  `publish(owner,slug,revision,expectedRevision)`, `unpublish(owner,slug)`, and
  `publicRead(slug)`. Use SQLite transactions and revision-checked SQL writes.
- [ ] Re-run tests, format, and typecheck.

## Task 2: Authentication, transport, and viewer

Files: `src/auth.ts`, `src/config.ts`, `src/mcp.ts`, `src/app.ts`, `src/pages.ts`,
`src/bootstrap.ts`, `src/main.ts`, `test/app.test.ts`, `test/oauth.test.ts`.

- [ ] Write HTTP tests for private/public host separation, missing token challenges,
  signed OAuth continuation, denied consent, expected owner identity, content CSP,
  and immediate removal of published source after unpublish.
- [ ] Confirm those tests fail before implementing routes.
- [ ] Configure Better Auth with `jwt()` and `mcp({ resource, loginPage: '/login',
  consentPage: '/consent', allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true, clientRegistrationRequirePKCE: true })`.
  Complete migrations before serving, and bootstrap through an unmounted signup-enabled
  instance. The mounted instance has `disableSignUp: true`.
- [ ] Implement SDK `createMcpHandler(factory, { legacy: 'stateless' })` behind
  `requireMcpAuth`, expected owner subject, and scope checks. Return schema-matching
  `structuredContent` and text from every successful tool.
- [ ] Implement management gallery and login/consent with signed `oauth_query`
  continuity. The viewer embeds content in `sandbox="allow-scripts"`; response CSP
  independently enforces sandboxing. Keep CSP for the trusted shell separate.
- [ ] Exercise a real OAuth authorization-code/PKCE exchange, SDK tool calls,
  unauthorized requests, hostile content, and public/private viewer updates.

## Task 3: Packaging and operational interfaces

Files: `src/bootstrap.ts`, `src/main.ts`, `test/startup.test.ts`, and `README.md`.

- [ ] Document workspace installation, explicit Bun provisioning, and builds without
  assuming a particular machine or deployment platform.
- [ ] Support pre-listener owner bootstrap and a private persistent SQLite directory.
  Test startup from bootstrapped data and graceful shutdown.
- [ ] Expose management-host health checks and credential-free request/process logs
  for an operator's service manager and monitoring system.
- [ ] Document HTTPS/Host forwarding, backup requirements, and executable deployment;
  leave machine provisioning and resource policies to infrastructure documentation.

## Task 4: End-to-end verification and delivery

- [ ] Run package format/check/test/build and inspect the final diff.
- [ ] Use a thread-specific browser session to exercise login, gallery, published
  interactive content, updating, and unpublishing; inspect desktop/mobile screenshots.
- [ ] Document setup, secret recovery, MCP URL, protocol compatibility, limits,
  backup/rollback considerations, and log formats using portable examples.
- [ ] Commit only owned files when repository coordination permits; do not push.
- [ ] Report registration instructions, verification limitations, and actual delivery
  state. Keep deployment-specific operations outside the package docs.

# Artifact publisher

Approved September 27, 2026. This package is portable; a separate infrastructure
repository owns its production hostname, credentials, and container deployment.

## Contract

An artifact is a single UTF-8 HTML or Markdown document, not a server application.
The agent creates private drafts, retrieves source, appends immutable revisions,
and explicitly publishes a selected revision at a stable named hostname. Publishing
updates open viewers. Draft updates never move the public revision. Unpublishing
removes public access, including old version/content URLs, without deleting history.
Optimistic revision checks prevent silent concurrent updates. Limit each source to
16 MiB and reject invalid slugs and invalid UTF-8 replacement characters.

## Service and authorization

Elysia runs on Bun; SQLite stores artifacts/revisions and Better Auth state.
The management origin is configured independently of the artifact hostname suffix.
Better Auth provides owner-only email/password login, JWT signing, and MCP OAuth.
A one-time local bootstrap provisions the owner before the listener starts; public
signup stays disabled. Credentials come from the operator's secret store, never Git.
Every management request checks the configured owner. MCP also requires an
audience-bound token and the artifact scope. DCR supports Amp's automatic client
setup; PKCE and explicit consent are required. Tokens are short-lived.

Artifacts render in an opaque-origin sandbox with no same-origin privilege, no
forms/top navigation, no backend access, and restrictive CSP. Content routes carry
the sandbox policy themselves, including direct navigation. Auth cookies are
host-only. Management endpoints never dispatch on an artifact hostname. No wildcard
CORS, host trust, token passthrough, or uploaded server-code execution.

## Interface

The browser has login, OAuth consent, a private gallery, and a viewer with revision
status. The MCP surface provides list, read, create, update, history, publish, and
unpublish. Tools return structured metadata and text. Tool descriptions state public
disclosure effects and authorization requirements. An SSE stream signals changes;
viewers reconnect and re-check revision after disconnects. No private content appears
in public streams or in response caches.

## Portable service requirements

Run the service as an unprivileged user with a private, persistent data directory.
Production requires HTTPS, a management hostname, and routing for named artifact
hosts that preserves the original Host header. The management host exposes a health
endpoint. Credentials come from the operator's secret store. Provisioning, resource
allocation, monitoring retention, and backup operations belong to the deployment's
infrastructure documentation, not this package.

Log request outcomes without bodies, credentials, authorization queries, or source
content. Emit minute process memory, cumulative CPU usage, and request statistics
for the operator's logging system without assuming a particular hosting platform.

## Verification and exclusions

Test persistence, independent draft/public revisions, conflicts, cross-owner access,
unpublishing, auth/discovery/PKCE/consent, hostile artifact containment, and live viewer
updates. Inspect desktop/mobile browser captures. Verify public deployment externally.
Comments, collaborative editing, multi-file builds, and browser MCP connectors are
excluded from this version.

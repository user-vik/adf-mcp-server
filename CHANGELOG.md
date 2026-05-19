# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0]

First stable release. The 0.x line was a series of breaking surface
expansions (auth modes, write tools, destructive tools); 1.0.0 marks the
point where the tool, env-var, and gating contracts are committed and
SemVer kicks in.

### Added
- GitHub Actions **CI workflow** (`.github/workflows/ci.yml`) running
  `npm run lint`, `npm run format:check`, `node --check index.js`, and
  `npm audit --omit=dev` on every push and PR.
- GitHub Actions **release workflow** (`.github/workflows/release.yml`)
  publishing to npm with provenance when a `v*` tag is pushed. Requires
  a `NPM_TOKEN` repository secret.
- **`Dockerfile`** (multi-stage, alpine, non-root) for hosting the server
  on Azure with managed identity. Companion `.dockerignore`.
- **`SECURITY.md`** with explicit disclosure process, in/out-of-scope
  items, and a list of known design limitations.
- README sections: "Install from npm", "Docker / managed identity",
  and a link to `SECURITY.md`.
- `package.json` gains `files`, `publishConfig`, and `keywords` for npm
  discoverability and to keep the published tarball minimal.
- Plan-store capacity cap (`PLAN_STORE_MAX = 100`) — when full,
  the oldest entry is evicted before insert. Prevents memory exhaustion
  if a buggy client floods plans faster than the TTL sweep runs.

### Changed
- Server version is now read from `package.json` at startup instead of
  being hard-coded in `new McpServer({ version })`. Single source of truth.

### Known limitations (intentional)
- No automated test suite — manual smoke tests only.
- `list_*` tools don't follow ARM `nextLink`; factories with hundreds of
  pipelines/datasets/etc. will see only the first ARM page.
- `AZURE_CLIENT_ID` is overloaded across auth modes (CLI public client /
  SP app reg / user-assigned MI). Documented in `.env.example`.
- Plan/apply tokens are in-memory only and do not survive a restart.

## [0.4.0]

### Added
- `ADF_MCP_ALLOW_DELETE=true` (requires `ADF_MCP_MODE=write`) enables 8 new
  destructive tools — 4 `create_or_update_*` and 4 `delete_*` for pipelines,
  triggers, linked services, and datasets. Off by default. Setting the flag
  without write mode logs a warning and is ignored.
- **Plan/apply confirmation pattern** for every destructive tool. First call
  (`dry_run: true`, default) returns a before/after diff plus a single-use
  `confirm_token` with a 10-minute TTL. Second call (`dry_run: false` +
  matching `confirm_token`) applies the change.
- **Optimistic concurrency** via ETag captured at plan time and passed as
  `If-Match` on apply. If the resource changed between plan and apply, ARM
  returns 412 and the server surfaces "Resource changed since the plan;
  request a new plan."
- Token-store hygiene: tokens are bound to `(tool, target, payload-hash)`,
  single-use, expire after 10 minutes, and are swept every minute.
- README "Destructive mode" section covering the plan/apply rationale, the
  ETag concurrency story, and why `create_or_update_*` is bundled with
  `delete_*` under the same flag.

### Changed
- `armAt()` now accepts `extraHeaders` so callers can pass `If-Match`.
- Errors from ARM responses now expose `.status` so downstream code (e.g.
  `fetchExistingOrNull`, 412 detection in apply) can branch on HTTP status.

## [0.3.0]

### Added
- Optional **write mode** opt-in via `ADF_MCP_MODE=write`. When unset (default)
  the server is read-only — write tools are not registered at all, so an LLM
  cannot call them regardless of prompt.
- Five write tools (registered only in write mode):
  - `create_pipeline_run` — kick off a new run, optionally with parameters.
  - `cancel_pipeline_run` — cancel an in-progress run; child runs too by default.
  - `rerun_pipeline_run` — re-execute a previous run; defaults to resuming from
    the failed activity.
  - `start_trigger` / `stop_trigger` — toggle a trigger's runtime state.
- Audit logging to stderr for every write tool call. Each invocation emits
  ATTEMPT + (SUCCESS | FAILURE) lines with timestamp, target, and caller
  identity parsed from the Entra token (`upn`/`preferred_username`/`appid`/`oid`).
- Startup log line when write mode is enabled, so the operator can see in the
  MCP server log whether mutations are possible.
- README "Write mode" section covering RBAC requirements, audit log format,
  recommended SP pairing, and the separation from destructive ops (Stage 6).

### Changed
- `armAt()` now builds URLs via the `URL` constructor and accepts an
  `extraQuery` argument, enabling endpoints that need query params beyond
  `api-version` (rerun's `referencePipelineRunId`, cancel's `isRecursive`).

## [0.2.0]

### Added
- Five new read tools:
  - `get_pipeline_run` — direct lookup of a single run by ID.
  - `list_linked_services` — linked services and their types.
  - `list_datasets` — datasets and their linked-service references.
  - `list_integration_runtimes` — IRs and their state (spot offline self-hosted
    IRs).
  - `list_factories` — discover other factories in the current subscription.
- Pagination on `query_pipeline_runs` via `continuation_token` input and
  `continuationToken` in the response.
- Automatic retry with `Retry-After`-aware backoff on ARM HTTP 429 (up to 3
  retries, capped at 60 s per attempt). Retries are logged to stderr.
- `safeTool` wrapper converting thrown errors into structured MCP tool errors
  (`isError: true`) so the LLM can see and react to the message.
- Startup validation that `ADF_FACTORY_RESOURCE_ID` parses as a valid ARM ID
  with a `/subscriptions/<id>` prefix.
- `ADF_AUTH_MODE` env var selecting from six credential types: `interactive`
  (default), `device-code`, `cli`, `service-principal`, `managed-identity`,
  `default`. Default preserves prior behavior.
- `AZURE_CLIENT_SECRET` env var (required only for `service-principal` mode).
- README "Authentication modes" section with per-mode requirements and notes.
- `.env.example` documenting supported environment variables.

### Changed
- `query_activity_runs` truncates each activity's `input` and `output` to ~4 KB
  by default to protect the LLM context window. Pass `full=true` to receive
  the untruncated payloads. **Breaking** for callers that depended on the full
  blob being returned by default.
- `.editorconfig` enforcing consistent indentation and line endings.
- `.gitattributes` enforcing LF line endings cross-platform.
- `ROADMAP.md` capturing the staged plan for upcoming work.
- README "Troubleshooting" section covering common auth and RBAC failures.
- ESLint (flat config) + Prettier with `lint`, `lint:fix`, `format`,
  `format:check` npm scripts.
- `CONTRIBUTING.md` with branching, Conventional Commits, and PR conventions.
- `.github/` issue and pull request templates.

### Changed
- `index.js` reformatted by Prettier to match the new project style (no
  behavior changes).

### Security
- Resolved 4 advisories (1 high, 3 moderate) in transitive dependencies of
  `@modelcontextprotocol/sdk` via `npm audit fix`: `fast-uri`,
  `hono`/`@hono/node-server`, `express-rate-limit`, `ip-address`. All affected
  packages are HTTP-transport code paths that are not loaded at runtime by
  this stdio-only server, so practical exposure was zero. Patch/minor bumps
  only; no `package.json` changes.

## [0.1.0] - 2026-04-27

### Added
- Initial MCP server with read-only tools: `list_pipelines`, `get_pipeline`,
  `query_pipeline_runs`, `query_activity_runs`, `list_triggers`.
- Interactive browser authentication via `@azure/identity`.
- MIT license and `package.json` metadata for distribution.

[Unreleased]: https://github.com/user-vik/adf-mcp-server/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/user-vik/adf-mcp-server/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/user-vik/adf-mcp-server/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/user-vik/adf-mcp-server/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/user-vik/adf-mcp-server/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/user-vik/adf-mcp-server/releases/tag/v0.1.0

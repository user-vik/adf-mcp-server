# Roadmap

Staged plan for evolving `adf-mcp-server` from a read-only troubleshooting tool
into a fully-featured ADF management surface for MCP clients. Stages are ordered
least-intrusive to most-intrusive — each stage is shippable on its own.

## Stage 1 — Low-touch docs

Pure additions. No code change.

- [x] `.env.example` for supported environment variables.
- [x] `.editorconfig` for consistent indentation and line endings.
- [x] `CHANGELOG.md` (Keep a Changelog format).
- [x] `ROADMAP.md` (this file).
- [x] README "Troubleshooting" section.

## Stage 2 — Contributor scaffolding

Configs and docs. A one-shot Prettier pass normalized `index.js` to the new
style; no behavior changes.

- [x] ESLint (flat config) + Prettier with `npm run lint` / `npm run format`.
- [x] `.gitattributes` for cross-platform LF line endings.
- [x] `CONTRIBUTING.md` describing branching, Conventional Commits, and PR checklist.
- [x] `.github/ISSUE_TEMPLATE/bug.md`, `feature.md`, `pull_request_template.md`.

## Stage 3 — Auth methods refactor _(done)_

Replaced the hard-coded `InteractiveBrowserCredential` with a credential
factory selected by `ADF_AUTH_MODE`:

| `ADF_AUTH_MODE`           | Credential                     | Use case                              |
| ------------------------- | ------------------------------ | ------------------------------------- |
| `interactive` _(default)_ | `InteractiveBrowserCredential` | Desktop devs                          |
| `device-code`             | `DeviceCodeCredential`         | SSH / WSL / no browser                |
| `cli`                     | `AzureCliCredential`           | Devs already signed in via `az login` |
| `service-principal`       | `ClientSecretCredential`       | CI, shared servers, automation        |
| `managed-identity`        | `ManagedIdentityCredential`    | MCP server hosted on Azure            |
| `default`                 | `DefaultAzureCredential`       | Chain that tries everything in turn   |

Default preserves prior behavior. README + `.env.example` updated. Invalid
modes or missing required env vars exit with a clear error at startup.

## Stage 4 — Quality-of-life read tools _(done — shipped in 0.2.0)_

Additive, low-risk:

- [x] `get_pipeline_run` — direct lookup for a single run.
- [x] `list_linked_services`, `list_datasets`, `list_integration_runtimes`.
- [x] `list_factories` — discover factories without knowing the full ARM ID.
- [x] Pagination for `query_pipeline_runs` (`continuationToken`).
- [x] Truncate large `output`/`input` blobs in `query_activity_runs` (default
      ~4 KB, opt-in `full=true`) to protect the LLM context window.
- [x] Retry with `Retry-After` backoff on ARM 429 throttling.
- [x] Structured tool errors (`{ isError: true, content: [...] }`) instead of
      throwing.

## Stage 5 — Gated write tools (non-destructive) _(done — shipped in 0.3.0)_

Surface is opt-in. Tools below are registered only when
`ADF_MCP_MODE=write`. Every call is audit-logged to stderr with timestamp,
caller identity (from the token), and target resource.

- [x] `create_pipeline_run` — kick off a run.
- [x] `cancel_pipeline_run` — stop a run (recursive by default).
- [x] `rerun_pipeline_run` — re-execute a previous run; defaults to resuming
      from the failed activity.
- [x] `start_trigger` / `stop_trigger` — toggle trigger state.

## Stage 6 — Destructive writes with plan/apply confirmation _(done — shipped in 0.4.0)_

Gated behind both `ADF_MCP_MODE=write` and `ADF_MCP_ALLOW_DELETE=true`.

- [x] `create_or_update_pipeline` / `_trigger` / `_linked_service` / `_dataset`.
- [x] `delete_pipeline` / `_trigger` / `_linked_service` / `_dataset`.
- [x] Two-step plan/apply: first call returns a diff plus a confirmation token;
      apply requires the token. Prevents an LLM from one-shot deleting things.
- [x] ETag concurrency via `If-Match` so a resource modified between plan and
      apply is rejected with HTTP 412.

## Stage 7 — Packaging & distribution _(done — shipped in 1.0.0)_

- [x] CI workflow (lint + format:check + audit on push/PR).
- [x] Release workflow (npm publish with provenance on `v*` tag push).
- [x] Dockerfile (multi-stage, non-root) for managed-identity hosting.
- [x] `SECURITY.md` with disclosure process and known limitations.
- [x] `package.json` `files` allowlist + `keywords` for npm discovery.
- [x] Server version read from `package.json` (single source of truth).
- [x] Plan-store size cap (100) to bound memory.
- [x] Cut `1.0.0` — first release with stable contract.

## Beyond 1.0 — deferred enhancements

These are documented in `SECURITY.md` as known limitations and revisited in
post-1.0 minors.

- **Test suite** — `vitest` + recorded HTTP fixtures (`nock`). Will exercise
  the auth-mode factory, gate logic, plan/apply state machine, and ARM
  response shape parsers.
- **`nextLink` pagination** for the `list_*` family. Today they return only
  the first ARM page (~50–100 items).
- **Type checking** via `// @ts-check` + JSDoc or a full TS conversion.
- **Split `AZURE_CLIENT_ID`** into mode-specific env vars
  (`ADF_SP_CLIENT_ID`, `ADF_MI_CLIENT_ID`) — breaking change, defer to 2.0.

## Permanently out of scope

- Debug-run support (`Debug` endpoint requires factory-level Contributor and
  carries different auditing semantics).
- Git-backed factory editing (collaboration branch commits via the ADF API).
- Cross-tenant scenarios — current design assumes a single tenant per process.

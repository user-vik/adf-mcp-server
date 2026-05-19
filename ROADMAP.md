# Roadmap

Staged plan for evolving `adf-mcp-server` from a read-only troubleshooting tool
into a fully-featured ADF management surface for MCP clients. Stages are ordered
least-intrusive to most-intrusive — each stage is shippable on its own.

## Stage 1 — Low-touch docs *(in progress)*

Pure additions. No code change.

- [x] `.env.example` for supported environment variables.
- [x] `.editorconfig` for consistent indentation and line endings.
- [x] `CHANGELOG.md` (Keep a Changelog format).
- [x] `ROADMAP.md` (this file).
- [x] README "Troubleshooting" section.

## Stage 2 — Contributor scaffolding

Configs and docs only; no source rewrites.

- ESLint (flat config) + Prettier with `npm run lint` / `npm run format`.
- `CONTRIBUTING.md` describing branching, Conventional Commits, and PR checklist.
- `.github/ISSUE_TEMPLATE/bug.md`, `feature.md`, `pull_request_template.md`.

## Stage 3 — Auth methods refactor

Replace the hard-coded `InteractiveBrowserCredential` with a credential chain
selected by `ADF_AUTH_MODE`:

| `ADF_AUTH_MODE`     | Credential                     | Use case                                  |
|---------------------|--------------------------------|-------------------------------------------|
| `interactive` *(default)* | `InteractiveBrowserCredential` | Desktop devs                              |
| `device-code`       | `DeviceCodeCredential`         | SSH / WSL / no browser                    |
| `cli`               | `AzureCliCredential`           | Devs already signed in via `az login`     |
| `service-principal` | `ClientSecretCredential`       | CI, shared servers, automation            |
| `managed-identity`  | `ManagedIdentityCredential`    | MCP server hosted on Azure                |
| `default`           | `DefaultAzureCredential`       | Chain that tries everything in turn       |

Default keeps current behavior. README + `.env.example` updated.

## Stage 4 — Quality-of-life read tools

Additive, low-risk:

- `get_pipeline_run` — direct lookup for a single run.
- `list_linked_services`, `list_datasets`, `list_integration_runtimes`.
- `list_factories` — discover factories without knowing the full ARM ID.
- Pagination for `query_pipeline_runs` (`continuationToken`).
- Truncate large `output`/`input` blobs in `query_activity_runs` (default
  ~4 KB, opt-in `full=true`) to protect the LLM context window.
- Retry with `Retry-After` backoff on ARM 429 throttling.
- Structured tool errors (`{ isError: true, content: [...] }`) instead of
  throwing.

## Stage 5 — Gated write tools (non-destructive)

Surface is opt-in. Tools below are registered only when
`ADF_MCP_MODE=write`. Every call is audit-logged to stderr with timestamp,
caller UPN (from the token), and target resource.

- `create_pipeline_run` — kick off a run.
- `cancel_pipeline_run` — stop a run.
- `rerun_pipeline_run` — re-execute a previous run.
- `start_trigger` / `stop_trigger` — toggle trigger state.

## Stage 6 — Destructive writes with plan/apply confirmation

Gated behind both `ADF_MCP_MODE=write` and `ADF_MCP_ALLOW_DELETE=true`.

- `create_or_update_pipeline` / `_trigger` / `_linked_service` / `_dataset`.
- `delete_pipeline` / `_trigger` / `_linked_service` / `_dataset`.
- Two-step plan/apply: first call returns a diff plus a confirmation token;
  apply requires the token. Prevents an LLM from one-shot deleting things.

## Stage 7 — Packaging & distribution

- Publish to npm so users can `npx adf-mcp-server`.
- Dockerfile for hosting on Azure Container Apps / AKS with managed identity.
- GitHub Actions release workflow tied to `CHANGELOG.md` entries.
- Cut `1.0.0` once write tools land.

## Out of scope (for now)

- Debug-run support (`Debug` endpoint requires factory-level Contributor and
  carries different auditing semantics).
- Git-backed factory editing (collaboration branch commits via the ADF API).
- Cross-tenant scenarios — current design assumes a single tenant per process.

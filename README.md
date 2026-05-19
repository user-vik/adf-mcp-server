# adf-mcp-server

MCP server for classic Azure Data Factory (V2) pipeline troubleshooting and operations. Exposes ARM tools for pipelines, pipeline runs, activity runs, triggers, linked services, datasets, and integration runtimes over stdio. Supports six Entra auth modes — interactive browser, device code, Azure CLI session, service principal, managed identity, or auto-detect. **Read-only by default**, with two opt-in tiers: `ADF_MCP_MODE=write` for runtime ops (run/cancel/start/stop), plus `ADF_MCP_ALLOW_DELETE=true` for definition-changing ops (`create_or_update_*` and `delete_*`) gated by a plan/apply confirmation pattern.

## What it does

Wraps the ADF REST API as MCP tools so an AI agent (Claude Code, Claude Desktop, Cursor, etc.) can investigate, run, and control a Data Factory. **Read-only by default** — write tools (kicking off pipeline runs, cancelling them, toggling triggers) are registered only when the operator sets `ADF_MCP_MODE=write` in the MCP client config. See **Write mode** below.

| Tool                        | Purpose                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `list_pipelines`            | All pipelines in the factory + activity counts, parameters, folder                                     |
| `get_pipeline`              | Full JSON definition of a specific pipeline                                                            |
| `query_pipeline_runs`       | Pipeline runs in a time window (default last 24h), filterable by pipeline/status, with pagination      |
| `get_pipeline_run`          | Full details for a single pipeline run by ID                                                           |
| `query_activity_runs`       | Activity runs for a pipeline run — input/output truncated by default; pass `full=true` to opt out      |
| `list_triggers`             | All triggers + runtime state and recurrence                                                            |
| `list_linked_services`      | Linked services (databases, storage, etc.) and their types                                             |
| `list_datasets`             | Datasets and the linked service each one belongs to                                                    |
| `list_integration_runtimes` | Integration runtimes and their state — useful for spotting offline self-hosted IRs                     |
| `list_factories`            | All ADF v2 instances in the current subscription — discover other factories without their full ARM IDs |

**Write tools** — only registered when `ADF_MCP_MODE=write`:

| Tool                  | Purpose                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| `create_pipeline_run` | Kick off a new run of a pipeline (optionally with parameters). Returns the new `runId`.         |
| `cancel_pipeline_run` | Cancel an in-progress pipeline run. Cancels child runs too by default.                          |
| `rerun_pipeline_run`  | Re-execute a previous run. Defaults to resuming from the failed activity (the common workflow). |
| `start_trigger`       | Start a trigger so it begins firing on its schedule.                                            |
| `stop_trigger`        | Stop a trigger so it stops firing.                                                              |

**Destructive tools** — only registered when `ADF_MCP_MODE=write` AND `ADF_MCP_ALLOW_DELETE=true`. Every call uses a two-step plan/apply confirmation pattern (see **Destructive mode** below):

| Tool                              | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `create_or_update_pipeline`       | Create a new pipeline or overwrite an existing one.                     |
| `create_or_update_trigger`        | Create or overwrite a trigger. New triggers start in Stopped state.     |
| `create_or_update_linked_service` | Create or overwrite a linked service (database / storage connection).   |
| `create_or_update_dataset`        | Create or overwrite a dataset.                                          |
| `delete_pipeline`                 | Delete a pipeline.                                                      |
| `delete_trigger`                  | Delete a trigger (must be stopped first via `stop_trigger`).            |
| `delete_linked_service`           | Delete a linked service. Datasets that reference it will start failing. |
| `delete_dataset`                  | Delete a dataset. Pipelines that reference it will start failing.       |

## Prerequisites

- **Node.js >= 20** on PATH (`node -v` to verify). The Node MSI install may be UAC-blocked on locked-down corp Windows boxes — ask IT if needed.
- **Git** to clone the repo.
- **Azure RBAC**: at minimum **Reader** role on the target Data Factory resource. Assigned in Azure Portal → the ADF resource → **Access control (IAM)** → Role assignments. Without this every tool call returns 403 even when auth succeeds.
- **An MCP-aware client** (Claude Code, Claude Desktop, Cursor, etc.) to wire it into.

## Install

```sh
git clone https://github.com/user-vik/adf-mcp-server
cd adf-mcp-server
npm install
```

## Configuration

The server reads everything from environment variables — typically set inside your MCP client config rather than the shell.

| Variable                  | Required                                                | Notes                                                                                                                                               |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADF_FACTORY_RESOURCE_ID` | always                                                  | Full ARM resource ID, e.g. `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DataFactory/factories/<factory>`                           |
| `ADF_AUTH_MODE`           | no                                                      | Auth credential to use. Defaults to `interactive`. See **Authentication modes** below.                                                              |
| `ADF_MCP_MODE`            | no                                                      | `read` (default) or `write`. `write` registers run/cancel/start/stop tools. See **Write mode** below.                                               |
| `ADF_MCP_ALLOW_DELETE`    | no                                                      | When `true` AND `ADF_MCP_MODE=write`, also registers the 8 `create_or_update_*` and `delete_*` tools. See **Destructive mode** below.               |
| `AZURE_TENANT_ID`         | for `interactive` / `device-code` / `service-principal` | Entra tenant ID.                                                                                                                                    |
| `AZURE_CLIENT_ID`         | for `service-principal`                                 | Optional for `interactive`/`device-code` (defaults to Azure CLI public client). For `managed-identity`, set only when targeting a user-assigned MI. |
| `AZURE_CLIENT_SECRET`     | for `service-principal`                                 | Treat as a secret. Never commit.                                                                                                                    |

## Wiring into an MCP client

Add an entry to your client's MCP config. Example (Claude Code / Claude Desktop format):

```json
{
  "mcpServers": {
    "ms-adf": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\adf-mcp-server\\index.js"],
      "env": {
        "AZURE_TENANT_ID": "<your-tenant-id>",
        "ADF_FACTORY_RESOURCE_ID": "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DataFactory/factories/<factory>"
      }
    }
  }
}
```

Restart the MCP client after editing the config.

## Authentication modes

Set `ADF_AUTH_MODE` to pick how the server obtains an Entra token. Default is `interactive`, which preserves prior behavior.

| Mode                      | Credential                     | Use case                                                                                        | Required env (beyond `ADF_FACTORY_RESOURCE_ID`)             |
| ------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `interactive` _(default)_ | `InteractiveBrowserCredential` | Desktop devs — opens a browser tab on first call.                                               | `AZURE_TENANT_ID`                                           |
| `device-code`             | `DeviceCodeCredential`         | SSH / WSL / headless — prints a code + URL to stderr (the MCP client's server log).             | `AZURE_TENANT_ID`                                           |
| `cli`                     | `AzureCliCredential`           | Devs already signed in via `az login`. Zero prompts.                                            | _(none — uses CLI session)_                                 |
| `service-principal`       | `ClientSecretCredential`       | CI, shared servers, automation.                                                                 | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` |
| `managed-identity`        | `ManagedIdentityCredential`    | MCP server hosted on an Azure VM, Container App, App Service, etc.                              | _(none — uses the host identity)_                           |
| `default`                 | `DefaultAzureCredential`       | Chain: env vars → managed identity → CLI → VS Code → interactive browser. Easiest "just works." | _(varies by what's available)_                              |

On the first tool call, the chosen credential acquires a token at the `https://management.azure.com/.default` scope. Tokens are cached in memory for the lifetime of the process; subsequent calls reuse them.

For all user-flow modes (`interactive`, `device-code`, `cli`), the effective ARM permissions are _your own_ personal RBAC on the factory. For `service-principal` and `managed-identity`, they are the SP's or MI's RBAC — grant that identity at least **Reader** on the factory.

### Mode-specific notes

- **`device-code`**: the message containing the verification URL and one-time code is written to **stderr**, which most MCP clients route to their server log rather than the chat. In Claude Code, view it via `/mcp` → server logs. The auth call blocks until you complete the flow in a browser.
- **`service-principal`**: `AZURE_CLIENT_ID` here is the SP's app registration, _not_ the Azure CLI public client default.
- **`managed-identity`**: omit `AZURE_CLIENT_ID` for a system-assigned MI; set it to the MI's client ID for a user-assigned MI.
- **`default`**: opaque when something fails. If `DefaultAzureCredential` errors with "no credential was found", switch to a specific mode to see which one is actually failing.

## Write mode

By default the server is **read-only** — no MCP tool it exposes can mutate the factory. An LLM literally cannot call write operations because they aren't registered.

To enable mutations, set `ADF_MCP_MODE=write` in the MCP client's `env` block. The server logs `[adf-mcp] write mode enabled — pipeline run + trigger control tools are exposed` at startup so it's visible in the server log.

### What write mode unlocks

`create_pipeline_run`, `cancel_pipeline_run`, `rerun_pipeline_run`, `start_trigger`, `stop_trigger`. See the tool table above.

### What it does NOT unlock

Definition-changing operations — `create_or_update_*` and `delete_*` — are gated separately behind `ADF_MCP_ALLOW_DELETE=true` and use a two-step plan/apply confirmation. See **Destructive mode** below.

### RBAC

`Reader` is no longer enough. Grant the identity used by `ADF_AUTH_MODE` at least **Data Factory Contributor** on the factory, or a narrower custom role that includes the action `Microsoft.DataFactory/factories/pipelineruns/*` and the trigger start/stop actions.

### Audit log

Every write call is logged to **stderr** with a line like:

```
[adf-mcp][AUDIT] 2026-05-19T15:42:01.123Z tool=create_pipeline_run target=pipeline=ETL_Daily caller=victor.perez@example.com status=ATTEMPT
[adf-mcp][AUDIT] 2026-05-19T15:42:01.987Z tool=create_pipeline_run target=pipeline=ETL_Daily caller=victor.perez@example.com status=SUCCESS
```

The caller is parsed from the `upn` / `preferred_username` / `appid` / `oid` claims of the Entra access token. Forward your MCP client's server log somewhere durable if you need a long-term audit trail.

### Recommended pairing for shared / CI deployments

`ADF_MCP_MODE=write` + `ADF_AUTH_MODE=service-principal`. The SP gets exactly the RBAC it needs, the audit log identifies it consistently, and individual users don't need factory-Contributor on their personal accounts.

## Destructive mode

Setting `ADF_MCP_ALLOW_DELETE=true` in addition to `ADF_MCP_MODE=write` registers the 8 tools that mutate the factory's definition (`create_or_update_*` for pipelines, triggers, linked services, datasets, plus their `delete_*` counterparts). The server logs `[adf-mcp] destructive mode enabled` at startup so it's visible in the MCP server log. Setting `ADF_MCP_ALLOW_DELETE=true` without `ADF_MCP_MODE=write` logs a warning and is ignored.

### Why "destructive" covers create_or_update too

`create_or_update_*` can silently overwrite an existing resource — the LLM might not realize it exists. Bundling it with `delete_*` under the same flag keeps "anything that changes the factory's definition" behind a single, conscious opt-in.

### Plan/apply confirmation

Every destructive tool uses a two-step pattern that forces the LLM (and the human reading the chat) to look at the diff before applying it.

1. **Plan step** — the LLM calls the tool with `dry_run: true` (the default). The server fetches the existing resource, returns a `before` / `after` diff, and issues a one-time `confirm_token` with a 10-minute TTL.

   ```jsonc
   {
     "plan_type": "DRY_RUN",
     "action": "create_or_update",
     "target": "pipeline=ETL_Daily",
     "before": {
       "properties": {
         /* current pipeline */
       },
     },
     "after": {
       "properties": {
         /* proposed pipeline */
       },
     },
     "confirm_token": "8c1f...e0a3",
     "expires_at": "2026-05-19T15:52:00.000Z",
     "hint": "To apply, call create_or_update_pipeline again with dry_run=false and confirm_token=\"8c1f...e0a3\".",
   }
   ```

2. **Apply step** — the LLM calls the same tool again with `dry_run: false` and the `confirm_token` from step 1. The token is single-use, bound to the exact `(tool, target, payload)` triple, and tied to the resource's ETag at plan time. If anything changed since the plan was computed, ARM returns HTTP 412 Precondition Failed and the server surfaces "Resource changed since the plan; request a new plan."

### Why tokens, not just `dry_run=false`?

Without the token, an LLM could skip the plan step entirely. Requiring a token means the LLM must have seen a plan in its own context (and surfaced it to you in the chat) before it can apply. The token store is in-memory; restarting the MCP server invalidates all pending plans.

### RBAC for destructive mode

The identity needs **Data Factory Contributor** on the factory (same role as write mode — no additional permissions, because ADF doesn't model "can create but not delete" separately at the RBAC level).

## Run standalone (for debugging)

```sh
ADF_FACTORY_RESOURCE_ID=... AZURE_TENANT_ID=... node index.js
```

The server speaks MCP over stdio, so running it directly will just block waiting for an MCP client to connect via stdin/stdout. Useful only to confirm it starts without crashing.

## Troubleshooting

| Symptom                                              | Likely cause                                                                           | Fix                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Missing required env vars` on startup               | `ADF_FACTORY_RESOURCE_ID` or `AZURE_TENANT_ID` not set in the MCP client's `env` block | Add them to the client config and restart the client.                                                                                                  |
| Tool call returns `403` from ARM                     | Your account lacks RBAC on the factory                                                 | Ask the resource owner to grant at least **Reader** on the Data Factory resource (Portal → ADF → Access control (IAM)).                                |
| Tool call returns `401` / token errors               | Conditional Access or MFA blocked the silent token                                     | Sign out of Azure CLI / browser sessions, then re-trigger any tool to force a fresh interactive sign-in.                                               |
| Browser tab never opens on first call                | Running over SSH / inside WSL / on a headless host                                     | Switch to `ADF_AUTH_MODE=device-code` and read the code/URL from the MCP server's stderr log.                                                          |
| `Invalid ADF_AUTH_MODE`                              | Typo in the mode name                                                                  | Use one of: `interactive`, `device-code`, `cli`, `service-principal`, `managed-identity`, `default`.                                                   |
| `ADF_AUTH_MODE=service-principal requires ...`       | Missing `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, or `AZURE_CLIENT_SECRET`                 | Set all three in the MCP client's `env` block.                                                                                                         |
| MCP client says "server failed to start"             | Wrong path in `args`, or Node not on PATH for the client's user                        | Verify the path with `node "C:\\path\\to\\index.js"` from a fresh shell. On Windows, the MCP client may inherit a different PATH than your terminal.   |
| Calls hang or time out                               | ARM is throttling (HTTP 429) and the server is auto-retrying with backoff              | Check the MCP server's stderr log — each retry is logged. Up to 3 retries honoring `Retry-After`; on exhaustion, the call fails with the original 429. |
| Activity output is `{ _truncated: true, ... }`       | Default 4 KB truncation kicked in to protect the LLM context window                    | Pass `full=true` to `query_activity_runs` for the untruncated payload.                                                                                 |
| LLM says "no tool to start a run / cancel"           | Server is in read-only mode (default)                                                  | Set `ADF_MCP_MODE=write` in the MCP client's `env` block and restart the client.                                                                       |
| Write tool returns `403 Authorization failed`        | The identity has Reader but not Contributor on the factory                             | Grant **Data Factory Contributor** (or a narrower custom role with the relevant pipelineruns/triggers actions) to the user / SP / MI.                  |
| Apply call returns "Resource changed since the plan" | Someone (or something) modified the resource between your plan and apply step          | Re-run with `dry_run=true` to fetch a fresh plan, then apply the new `confirm_token`.                                                                  |
| Apply call returns "Invalid confirm_token"           | Token expired (10-min TTL), already used, or server restarted                          | Re-run with `dry_run=true` to get a new token.                                                                                                         |
| Apply call returns "confirm_token does not match"    | The payload changed between plan and apply (e.g. the LLM edited the definition)        | Re-run the plan step with the current payload to get a token bound to it.                                                                              |
| `404` for a pipeline that exists                     | Wrong factory in `ADF_FACTORY_RESOURCE_ID`                                             | Confirm the ARM ID matches the factory you expect (subscription, resource group, and name all match).                                                  |

For everything else, check the project [issues](https://github.com/user-vik/adf-mcp-server/issues).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the staged plan — additional auth methods,
write-capable tools (run/cancel/start/stop), packaging, and more.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

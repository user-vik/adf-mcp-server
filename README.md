# adf-mcp-server

MCP server for classic Azure Data Factory (V2) pipeline troubleshooting. Exposes ARM read tools for pipelines, pipeline runs, activity runs, and triggers over stdio. Supports six Entra auth modes — interactive browser, device code, Azure CLI session, service principal, managed identity, or auto-detect.

## What it does

Wraps the ADF REST API as MCP tools so an AI agent (Claude Code, Claude Desktop, Cursor, etc.) can read the state of a Data Factory and help you investigate failures. Read-only — it cannot publish pipelines, start triggers, or kick off Debug runs.

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

## Run standalone (for debugging)

```sh
ADF_FACTORY_RESOURCE_ID=... AZURE_TENANT_ID=... node index.js
```

The server speaks MCP over stdio, so running it directly will just block waiting for an MCP client to connect via stdin/stdout. Useful only to confirm it starts without crashing.

## Troubleshooting

| Symptom                                        | Likely cause                                                                           | Fix                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Missing required env vars` on startup         | `ADF_FACTORY_RESOURCE_ID` or `AZURE_TENANT_ID` not set in the MCP client's `env` block | Add them to the client config and restart the client.                                                                                                  |
| Tool call returns `403` from ARM               | Your account lacks RBAC on the factory                                                 | Ask the resource owner to grant at least **Reader** on the Data Factory resource (Portal → ADF → Access control (IAM)).                                |
| Tool call returns `401` / token errors         | Conditional Access or MFA blocked the silent token                                     | Sign out of Azure CLI / browser sessions, then re-trigger any tool to force a fresh interactive sign-in.                                               |
| Browser tab never opens on first call          | Running over SSH / inside WSL / on a headless host                                     | Switch to `ADF_AUTH_MODE=device-code` and read the code/URL from the MCP server's stderr log.                                                          |
| `Invalid ADF_AUTH_MODE`                        | Typo in the mode name                                                                  | Use one of: `interactive`, `device-code`, `cli`, `service-principal`, `managed-identity`, `default`.                                                   |
| `ADF_AUTH_MODE=service-principal requires ...` | Missing `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, or `AZURE_CLIENT_SECRET`                 | Set all three in the MCP client's `env` block.                                                                                                         |
| MCP client says "server failed to start"       | Wrong path in `args`, or Node not on PATH for the client's user                        | Verify the path with `node "C:\\path\\to\\index.js"` from a fresh shell. On Windows, the MCP client may inherit a different PATH than your terminal.   |
| Calls hang or time out                         | ARM is throttling (HTTP 429) and the server is auto-retrying with backoff              | Check the MCP server's stderr log — each retry is logged. Up to 3 retries honoring `Retry-After`; on exhaustion, the call fails with the original 429. |
| Activity output is `{ _truncated: true, ... }` | Default 4 KB truncation kicked in to protect the LLM context window                    | Pass `full=true` to `query_activity_runs` for the untruncated payload.                                                                                 |
| `404` for a pipeline that exists               | Wrong factory in `ADF_FACTORY_RESOURCE_ID`                                             | Confirm the ARM ID matches the factory you expect (subscription, resource group, and name all match).                                                  |

For everything else, check the project [issues](https://github.com/user-vik/adf-mcp-server/issues).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the staged plan — additional auth methods,
write-capable tools (run/cancel/start/stop), packaging, and more.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

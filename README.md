# adf-mcp-server

MCP server for classic Azure Data Factory (V2) pipeline troubleshooting. Exposes ARM read tools for pipelines, pipeline runs, activity runs, and triggers over stdio, using interactive browser auth.

## What it does

Wraps the ADF REST API as MCP tools so an AI agent (Claude Code, Claude Desktop, Cursor, etc.) can read the state of a Data Factory and help you investigate failures. Read-only — it cannot publish pipelines, start triggers, or kick off Debug runs.

| Tool | Purpose |
|------|---------|
| `list_pipelines` | All pipelines in the factory + activity counts, parameters, folder |
| `get_pipeline` | Full JSON definition of a specific pipeline |
| `query_pipeline_runs` | Pipeline runs in a time window (default last 24h), filterable by pipeline and status |
| `query_activity_runs` | Activity runs for a specific pipeline run — the drill-down for "which activity failed and why" |
| `list_triggers` | All triggers + runtime state and recurrence |

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

| Variable | Required | Notes |
|----------|----------|-------|
| `ADF_FACTORY_RESOURCE_ID` | yes | Full ARM resource ID, e.g. `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DataFactory/factories/<factory>` |
| `AZURE_TENANT_ID` | yes | Entra tenant ID |
| `AZURE_CLIENT_ID` | no | Defaults to the Azure CLI public client (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) |

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

## First-run auth

On the first tool call the server uses `InteractiveBrowserCredential`. A browser tab opens asking you to sign in to Azure with your Entra account. The token is cached in memory for the lifetime of the process; subsequent calls reuse it.

Because this is interactive user auth, the effective permissions on ARM are your own personal RBAC on the factory — not a service principal's.

## Run standalone (for debugging)

```sh
ADF_FACTORY_RESOURCE_ID=... AZURE_TENANT_ID=... node index.js
```

The server speaks MCP over stdio, so running it directly will just block waiting for an MCP client to connect via stdin/stdout. Useful only to confirm it starts without crashing.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Missing required env vars` on startup | `ADF_FACTORY_RESOURCE_ID` or `AZURE_TENANT_ID` not set in the MCP client's `env` block | Add them to the client config and restart the client. |
| Tool call returns `403` from ARM | Your account lacks RBAC on the factory | Ask the resource owner to grant at least **Reader** on the Data Factory resource (Portal → ADF → Access control (IAM)). |
| Tool call returns `401` / token errors | Conditional Access or MFA blocked the silent token | Sign out of Azure CLI / browser sessions, then re-trigger any tool to force a fresh interactive sign-in. |
| Browser tab never opens on first call | Running over SSH / inside WSL / on a headless host | Interactive browser auth needs a desktop. See Roadmap → Stage 3 for the upcoming `device-code` mode; until then, run the client on a machine with a browser. |
| MCP client says "server failed to start" | Wrong path in `args`, or Node not on PATH for the client's user | Verify the path with `node "C:\\path\\to\\index.js"` from a fresh shell. On Windows, the MCP client may inherit a different PATH than your terminal. |
| Calls hang or time out | ARM is throttling (HTTP 429) — currently surfaced as a generic error | Retry after 30–60 s. Automatic backoff is on the Roadmap (Stage 4). |
| `404` for a pipeline that exists | Wrong factory in `ADF_FACTORY_RESOURCE_ID` | Confirm the ARM ID matches the factory you expect (subscription, resource group, and name all match). |

For everything else, check the project [issues](https://github.com/user-vik/adf-mcp-server/issues).

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the staged plan — additional auth methods,
write-capable tools (run/cancel/start/stop), packaging, and more.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).

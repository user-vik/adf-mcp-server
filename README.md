# adf-mcp-server

MCP server for classic Azure Data Factory (V2) pipeline troubleshooting. Exposes ARM read tools for pipelines, pipeline runs, activity runs, and triggers over stdio, using interactive browser auth.

## Requirements

- Node.js >= 20
- Reader (or higher) RBAC on the target Data Factory

## Environment variables

| Variable | Required | Notes |
|----------|----------|-------|
| `ADF_FACTORY_RESOURCE_ID` | yes | Full ARM resource ID, e.g. `/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.DataFactory/factories/<factory>` |
| `AZURE_TENANT_ID` | yes | Entra tenant ID |
| `AZURE_CLIENT_ID` | no | Defaults to the Azure CLI public client (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`) |

## Install

```sh
npm install
```

## Run

```sh
ADF_FACTORY_RESOURCE_ID=... AZURE_TENANT_ID=... node index.js
```

The server speaks MCP over stdio. Wire it into your MCP client (e.g. Claude Code) the same way as any other stdio MCP server.

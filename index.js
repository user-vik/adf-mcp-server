#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  AzureCliCredential,
  ClientSecretCredential,
  DefaultAzureCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import { z } from "zod";

const FACTORY_ID = process.env.ADF_FACTORY_RESOURCE_ID;
if (!FACTORY_ID) {
  console.error("Missing required env var: ADF_FACTORY_RESOURCE_ID");
  process.exit(1);
}

const AUTH_MODES = [
  "interactive",
  "device-code",
  "cli",
  "service-principal",
  "managed-identity",
  "default",
];
// Public Azure CLI client ID — safe default for user-flow modes only.
const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";

function requireEnv(value, name, mode) {
  if (!value) {
    console.error(`ADF_AUTH_MODE=${mode} requires ${name}`);
    process.exit(1);
  }
  return value;
}

function buildCredential() {
  const mode = (process.env.ADF_AUTH_MODE || "interactive").toLowerCase();
  if (!AUTH_MODES.includes(mode)) {
    console.error(`Invalid ADF_AUTH_MODE "${mode}". Valid: ${AUTH_MODES.join(", ")}`);
    process.exit(1);
  }
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;

  switch (mode) {
    case "interactive":
      return new InteractiveBrowserCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: clientId || AZURE_CLI_CLIENT_ID,
      });
    case "device-code":
      return new DeviceCodeCredential({
        tenantId: requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        clientId: clientId || AZURE_CLI_CLIENT_ID,
        // Default callback writes to stdout, which would corrupt the MCP
        // protocol stream. Redirect to stderr so the MCP client logs it.
        userPromptCallback: (info) => {
          console.error(`[adf-mcp] ${info.message}`);
        },
      });
    case "cli":
      return new AzureCliCredential(tenantId ? { tenantId } : undefined);
    case "service-principal":
      return new ClientSecretCredential(
        requireEnv(tenantId, "AZURE_TENANT_ID", mode),
        requireEnv(clientId, "AZURE_CLIENT_ID", mode),
        requireEnv(clientSecret, "AZURE_CLIENT_SECRET", mode),
      );
    case "managed-identity":
      return new ManagedIdentityCredential(clientId ? { clientId } : undefined);
    case "default":
      return new DefaultAzureCredential(tenantId ? { tenantId } : undefined);
  }
}

const credential = buildCredential();
const API_VERSION = "2018-06-01";
const ARM_BASE = "https://management.azure.com";

async function getToken() {
  const t = await credential.getToken("https://management.azure.com/.default");
  return t.token;
}

async function arm(method, path, body) {
  const token = await getToken();
  const url = `${ARM_BASE}${FACTORY_ID}${path}?api-version=${API_VERSION}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ADF ${method} ${path} -> ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

const server = new McpServer({ name: "adf-mcp", version: "0.1.0" });

server.registerTool(
  "list_pipelines",
  {
    description: "List all pipelines in the configured ADF factory.",
    inputSchema: {},
  },
  async () => {
    const data = await arm("GET", "/pipelines");
    const summary = (data.value ?? []).map((p) => ({
      name: p.name,
      activityCount: p.properties?.activities?.length ?? 0,
      parameters: Object.keys(p.properties?.parameters ?? {}),
      annotations: p.properties?.annotations ?? [],
      folder: p.properties?.folder?.name,
    }));
    return ok(summary);
  },
);

server.registerTool(
  "get_pipeline",
  {
    description: "Get the full JSON definition of a specific pipeline.",
    inputSchema: {
      name: z.string().describe("The pipeline name"),
    },
  },
  async ({ name }) => {
    const data = await arm("GET", `/pipelines/${encodeURIComponent(name)}`);
    return ok(data);
  },
);

server.registerTool(
  "query_pipeline_runs",
  {
    description:
      "Query pipeline runs in a time window. Default window is the last 24 hours, ordered most-recent first.",
    inputSchema: {
      last_updated_after: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp; defaults to now - 24h"),
      last_updated_before: z.string().optional().describe("ISO 8601 timestamp; defaults to now"),
      pipeline_name: z.string().optional().describe("Filter to a specific pipeline name"),
      status: z
        .enum(["Succeeded", "Failed", "InProgress", "Cancelled", "Queued"])
        .optional()
        .describe("Filter by run status"),
    },
  },
  async ({ last_updated_after, last_updated_before, pipeline_name, status }) => {
    const now = new Date();
    const before = last_updated_before ?? now.toISOString();
    const after = last_updated_after ?? new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const filters = [];
    if (pipeline_name)
      filters.push({
        operand: "PipelineName",
        operator: "Equals",
        values: [pipeline_name],
      });
    if (status) filters.push({ operand: "Status", operator: "Equals", values: [status] });
    const body = {
      lastUpdatedAfter: after,
      lastUpdatedBefore: before,
      orderBy: [{ orderBy: "RunStart", order: "DESC" }],
    };
    if (filters.length) body.filters = filters;
    const data = await arm("POST", "/queryPipelineRuns", body);
    const summary = (data.value ?? []).map((r) => ({
      runId: r.runId,
      pipelineName: r.pipelineName,
      status: r.status,
      runStart: r.runStart,
      runEnd: r.runEnd,
      durationInMs: r.durationInMs,
      message: r.message,
      invokedBy: r.invokedBy?.name,
      parameters: r.parameters,
    }));
    return ok(summary);
  },
);

server.registerTool(
  "query_activity_runs",
  {
    description:
      "Query activity runs for a specific pipeline run. Use this to drill into which activity failed and read the error message.",
    inputSchema: {
      pipeline_run_id: z.string().describe("The pipeline run ID (from query_pipeline_runs)"),
      last_updated_after: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp; defaults to now - 7d"),
      last_updated_before: z.string().optional().describe("ISO 8601 timestamp; defaults to now"),
      status: z.string().optional().describe("Filter by activity status (e.g., Failed, Succeeded)"),
    },
  },
  async ({ pipeline_run_id, last_updated_after, last_updated_before, status }) => {
    const now = new Date();
    const before = last_updated_before ?? now.toISOString();
    const after =
      last_updated_after ?? new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const filters = [];
    if (status) filters.push({ operand: "Status", operator: "Equals", values: [status] });
    const body = {
      lastUpdatedAfter: after,
      lastUpdatedBefore: before,
    };
    if (filters.length) body.filters = filters;
    const data = await arm(
      "POST",
      `/pipelineruns/${encodeURIComponent(pipeline_run_id)}/queryActivityruns`,
      body,
    );
    const summary = (data.value ?? []).map((a) => ({
      activityName: a.activityName,
      activityType: a.activityType,
      status: a.status,
      activityRunStart: a.activityRunStart,
      activityRunEnd: a.activityRunEnd,
      durationInMs: a.durationInMs,
      error: a.error,
      output: a.output,
      input: a.input,
    }));
    return ok(summary);
  },
);

server.registerTool(
  "list_triggers",
  {
    description: "List all triggers in the factory and their runtime state.",
    inputSchema: {},
  },
  async () => {
    const data = await arm("GET", "/triggers");
    const summary = (data.value ?? []).map((t) => ({
      name: t.name,
      type: t.properties?.type,
      runtimeState: t.properties?.runtimeState,
      pipelines: (t.properties?.pipelines ?? []).map((p) => p.pipelineReference?.referenceName),
      recurrence: t.properties?.typeProperties?.recurrence,
      annotations: t.properties?.annotations ?? [],
    }));
    return ok(summary);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

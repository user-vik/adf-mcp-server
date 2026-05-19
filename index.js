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

const SUBSCRIPTION_MATCH = /^\/subscriptions\/([^/]+)/.exec(FACTORY_ID);
if (!SUBSCRIPTION_MATCH) {
  console.error(
    `ADF_FACTORY_RESOURCE_ID does not look like a valid ARM ID (missing /subscriptions/<id>): ${FACTORY_ID}`,
  );
  process.exit(1);
}
const SUBSCRIPTION_ID = SUBSCRIPTION_MATCH[1];

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
const MAX_RETRIES = 3;
const RETRY_MAX_DELAY_MS = 60_000;

async function getToken() {
  const t = await credential.getToken("https://management.azure.com/.default");
  return t.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Calls an arbitrary ARM path (already including /subscriptions/...).
// `extraQuery` lets callers add query parameters beyond api-version (used by
// rerun / cancel endpoints). Retries on HTTP 429, honoring Retry-After.
async function armAt(method, fullArmPath, body, extraQuery = {}) {
  const token = await getToken();
  const url = new URL(`${ARM_BASE}${fullArmPath}`);
  url.searchParams.set("api-version", API_VERSION);
  for (const [k, v] of Object.entries(extraQuery)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "", 10);
      const backoffMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
        : Math.min(2 ** attempt * 500, RETRY_MAX_DELAY_MS);
      console.error(
        `[adf-mcp] ARM 429 throttled on ${method} ${fullArmPath}; retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(backoffMs);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ADF ${method} ${fullArmPath} -> ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }
}

// Factory-scoped convenience wrapper. `path` is relative to the factory ARM ID.
async function arm(method, path, body, extraQuery) {
  return armAt(method, `${FACTORY_ID}${path}`, body, extraQuery);
}

function ok(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// Wraps a tool handler so any thrown error is returned as a structured
// MCP tool error instead of escaping as a protocol-level failure. This lets
// the LLM see the error message and react to it.
function safeTool(handler) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      const message = e?.message ?? String(e);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

const TRUNCATE_CHARS = 4096;

// Truncate a value when its JSON representation exceeds `max` chars, returning
// a small envelope describing the truncation. Used on activity input/output
// blobs that can otherwise blow the LLM context window.
function maybeTruncate(value, max = TRUNCATE_CHARS) {
  if (value == null) return value;
  const json = JSON.stringify(value);
  if (json == null || json.length <= max) return value;
  return {
    _truncated: true,
    _totalChars: json.length,
    _preview: json.slice(0, max),
    _hint: "Pass full=true to query_activity_runs to receive the untruncated payload.",
  };
}

// Extracts a human-meaningful subject from an Entra access token's middle
// segment. Returns "unknown" on any parse failure — never throws, since this
// is only used for audit logging.
function parseTokenSubject(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return "unknown";
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return (
      payload.upn ||
      payload.preferred_username ||
      payload.unique_name ||
      payload.appid ||
      payload.oid ||
      "unknown"
    );
  } catch {
    return "unknown";
  }
}

// Wraps a mutating tool so each invocation is audit-logged to stderr with
// timestamp, tool name, target resource, caller identity, and outcome.
// Layered on top of safeTool — errors are still structured for the LLM.
function writeTool(toolName, getTarget, handler) {
  return safeTool(async (args) => {
    const target = getTarget(args);
    const token = await getToken();
    const caller = parseTokenSubject(token);
    const startedAt = new Date().toISOString();
    console.error(
      `[adf-mcp][AUDIT] ${startedAt} tool=${toolName} target=${target} caller=${caller} status=ATTEMPT`,
    );
    try {
      const result = await handler(args);
      console.error(
        `[adf-mcp][AUDIT] ${new Date().toISOString()} tool=${toolName} target=${target} caller=${caller} status=SUCCESS`,
      );
      return result;
    } catch (e) {
      const msg = (e?.message ?? String(e)).slice(0, 200);
      console.error(
        `[adf-mcp][AUDIT] ${new Date().toISOString()} tool=${toolName} target=${target} caller=${caller} status=FAILURE error=${msg}`,
      );
      throw e;
    }
  });
}

const WRITE_ENABLED = (process.env.ADF_MCP_MODE ?? "read").toLowerCase() === "write";
if (WRITE_ENABLED) {
  console.error("[adf-mcp] write mode enabled — pipeline run + trigger control tools are exposed");
}

const server = new McpServer({ name: "adf-mcp", version: "0.3.0" });

server.registerTool(
  "list_pipelines",
  {
    description: "List all pipelines in the configured ADF factory.",
    inputSchema: {},
  },
  safeTool(async () => {
    const data = await arm("GET", "/pipelines");
    const summary = (data.value ?? []).map((p) => ({
      name: p.name,
      activityCount: p.properties?.activities?.length ?? 0,
      parameters: Object.keys(p.properties?.parameters ?? {}),
      annotations: p.properties?.annotations ?? [],
      folder: p.properties?.folder?.name,
    }));
    return ok(summary);
  }),
);

server.registerTool(
  "get_pipeline",
  {
    description: "Get the full JSON definition of a specific pipeline.",
    inputSchema: {
      name: z.string().describe("The pipeline name"),
    },
  },
  safeTool(async ({ name }) => {
    const data = await arm("GET", `/pipelines/${encodeURIComponent(name)}`);
    return ok(data);
  }),
);

server.registerTool(
  "query_pipeline_runs",
  {
    description:
      "Query pipeline runs in a time window. Default window is the last 24 hours, ordered most-recent first. Returns a continuationToken when more results are available; pass it back as continuation_token to fetch the next page.",
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
      continuation_token: z
        .string()
        .optional()
        .describe("Continuation token from a previous response, for paging"),
    },
  },
  safeTool(
    async ({
      last_updated_after,
      last_updated_before,
      pipeline_name,
      status,
      continuation_token,
    }) => {
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
      if (continuation_token) body.continuationToken = continuation_token;
      const data = await arm("POST", "/queryPipelineRuns", body);
      const runs = (data.value ?? []).map((r) => ({
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
      return ok({ runs, continuationToken: data.continuationToken ?? null });
    },
  ),
);

server.registerTool(
  "get_pipeline_run",
  {
    description:
      "Get full details for a single pipeline run by ID. Use this when you already know the runId and want everything ARM returns about it.",
    inputSchema: {
      run_id: z.string().describe("The pipeline run ID"),
    },
  },
  safeTool(async ({ run_id }) => {
    const data = await arm("GET", `/pipelineruns/${encodeURIComponent(run_id)}`);
    return ok(data);
  }),
);

server.registerTool(
  "query_activity_runs",
  {
    description:
      "Query activity runs for a specific pipeline run. Use this to drill into which activity failed and read the error message. Activity input/output payloads are truncated by default to protect context; pass full=true to receive them untruncated.",
    inputSchema: {
      pipeline_run_id: z.string().describe("The pipeline run ID (from query_pipeline_runs)"),
      last_updated_after: z
        .string()
        .optional()
        .describe("ISO 8601 timestamp; defaults to now - 7d"),
      last_updated_before: z.string().optional().describe("ISO 8601 timestamp; defaults to now"),
      status: z.string().optional().describe("Filter by activity status (e.g., Failed, Succeeded)"),
      full: z
        .boolean()
        .optional()
        .describe("Return untruncated input/output blobs. Defaults to false."),
    },
  },
  safeTool(async ({ pipeline_run_id, last_updated_after, last_updated_before, status, full }) => {
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
      output: full ? a.output : maybeTruncate(a.output),
      input: full ? a.input : maybeTruncate(a.input),
    }));
    return ok(summary);
  }),
);

server.registerTool(
  "list_triggers",
  {
    description: "List all triggers in the factory and their runtime state.",
    inputSchema: {},
  },
  safeTool(async () => {
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
  }),
);

server.registerTool(
  "list_linked_services",
  {
    description: "List all linked services in the factory (databases, storage accounts, etc).",
    inputSchema: {},
  },
  safeTool(async () => {
    const data = await arm("GET", "/linkedservices");
    const summary = (data.value ?? []).map((ls) => ({
      name: ls.name,
      type: ls.properties?.type,
      parameters: Object.keys(ls.properties?.parameters ?? {}),
      annotations: ls.properties?.annotations ?? [],
      connectVia: ls.properties?.connectVia?.referenceName,
    }));
    return ok(summary);
  }),
);

server.registerTool(
  "list_datasets",
  {
    description: "List all datasets in the factory and the linked service each one belongs to.",
    inputSchema: {},
  },
  safeTool(async () => {
    const data = await arm("GET", "/datasets");
    const summary = (data.value ?? []).map((d) => ({
      name: d.name,
      type: d.properties?.type,
      linkedServiceName: d.properties?.linkedServiceName?.referenceName,
      parameters: Object.keys(d.properties?.parameters ?? {}),
      annotations: d.properties?.annotations ?? [],
      folder: d.properties?.folder?.name,
    }));
    return ok(summary);
  }),
);

server.registerTool(
  "list_integration_runtimes",
  {
    description:
      "List all integration runtimes (IRs) in the factory and their type/state. Useful for spotting offline self-hosted IRs that cause pipeline failures.",
    inputSchema: {},
  },
  safeTool(async () => {
    const data = await arm("GET", "/integrationRuntimes");
    const summary = (data.value ?? []).map((ir) => ({
      name: ir.name,
      type: ir.properties?.type,
      description: ir.properties?.description,
      state: ir.properties?.state,
    }));
    return ok(summary);
  }),
);

server.registerTool(
  "list_factories",
  {
    description:
      "List all Data Factory v2 instances visible in the current subscription (derived from ADF_FACTORY_RESOURCE_ID). Useful for discovering the ARM IDs of other factories.",
    inputSchema: {},
  },
  safeTool(async () => {
    const data = await armAt(
      "GET",
      `/subscriptions/${SUBSCRIPTION_ID}/providers/Microsoft.DataFactory/factories`,
    );
    const summary = (data.value ?? []).map((f) => ({
      name: f.name,
      id: f.id,
      location: f.location,
      resourceGroup: /resourceGroups\/([^/]+)/.exec(f.id ?? "")?.[1],
    }));
    return ok(summary);
  }),
);

// ─── Write tools — registered only when ADF_MCP_MODE=write ─────────────────

if (WRITE_ENABLED) {
  server.registerTool(
    "create_pipeline_run",
    {
      description:
        "Kick off a new run of a pipeline. Returns the new runId. WRITE OPERATION: this consumes ADF resources and may incur cost.",
      inputSchema: {
        pipeline_name: z.string().describe("The pipeline name"),
        parameters: z
          .record(z.unknown())
          .optional()
          .describe("Pipeline parameters, as a name→value object"),
      },
    },
    writeTool(
      "create_pipeline_run",
      ({ pipeline_name }) => `pipeline=${pipeline_name}`,
      async ({ pipeline_name, parameters }) => {
        const data = await arm(
          "POST",
          `/pipelines/${encodeURIComponent(pipeline_name)}/createRun`,
          parameters && Object.keys(parameters).length ? parameters : undefined,
        );
        return ok({ runId: data?.runId, pipelineName: pipeline_name });
      },
    ),
  );

  server.registerTool(
    "cancel_pipeline_run",
    {
      description: "Cancel an in-progress pipeline run. By default cancels child runs as well.",
      inputSchema: {
        run_id: z.string().describe("The pipeline run ID to cancel"),
        recursive: z
          .boolean()
          .optional()
          .describe("Cancel child pipeline runs too. Defaults to true."),
      },
    },
    writeTool(
      "cancel_pipeline_run",
      ({ run_id }) => `run=${run_id}`,
      async ({ run_id, recursive }) => {
        await arm("POST", `/pipelineruns/${encodeURIComponent(run_id)}/cancel`, undefined, {
          isRecursive: recursive ?? true,
        });
        return ok({ cancelled: true, runId: run_id });
      },
    ),
  );

  server.registerTool(
    "rerun_pipeline_run",
    {
      description:
        "Re-execute a previous pipeline run. By default resumes from the failed activity (the common 'fix and retry' workflow); set from_failed_activity=false to replay from the beginning.",
      inputSchema: {
        pipeline_name: z.string().describe("The original pipeline name"),
        reference_run_id: z.string().describe("The runId of the previous run to rerun"),
        from_failed_activity: z
          .boolean()
          .optional()
          .describe("Resume from the failed activity. Defaults to true."),
      },
    },
    writeTool(
      "rerun_pipeline_run",
      ({ pipeline_name, reference_run_id }) => `pipeline=${pipeline_name} ref=${reference_run_id}`,
      async ({ pipeline_name, reference_run_id, from_failed_activity }) => {
        const data = await arm(
          "POST",
          `/pipelines/${encodeURIComponent(pipeline_name)}/createRun`,
          undefined,
          {
            referencePipelineRunId: reference_run_id,
            startFromFailure: from_failed_activity ?? true,
          },
        );
        return ok({
          runId: data?.runId,
          pipelineName: pipeline_name,
          referenceRunId: reference_run_id,
        });
      },
    ),
  );

  server.registerTool(
    "start_trigger",
    {
      description:
        "Start a trigger so it begins firing per its schedule. Long-running; verify the resulting runtimeState with list_triggers.",
      inputSchema: {
        name: z.string().describe("The trigger name"),
      },
    },
    writeTool(
      "start_trigger",
      ({ name }) => `trigger=${name}`,
      async ({ name }) => {
        await arm("POST", `/triggers/${encodeURIComponent(name)}/start`);
        return ok({ started: true, trigger: name });
      },
    ),
  );

  server.registerTool(
    "stop_trigger",
    {
      description:
        "Stop a trigger so it stops firing. Long-running; verify the resulting runtimeState with list_triggers.",
      inputSchema: {
        name: z.string().describe("The trigger name"),
      },
    },
    writeTool(
      "stop_trigger",
      ({ name }) => `trigger=${name}`,
      async ({ name }) => {
        await arm("POST", `/triggers/${encodeURIComponent(name)}/stop`);
        return ok({ stopped: true, trigger: name });
      },
    ),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

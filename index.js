#!/usr/bin/env node
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
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

// Single source of truth for the server's version — keeps `package.json`
// and the MCP server identity in sync without manual edits.
const PACKAGE = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const VERSION = PACKAGE.version;

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
// `extraQuery` adds query parameters beyond api-version (rerun / cancel).
// `extraHeaders` adds request headers (used for If-Match ETag concurrency
// control on mutating ops). Retries on HTTP 429, honoring Retry-After.
async function armAt(method, fullArmPath, body, extraQuery = {}, extraHeaders = {}) {
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
        ...extraHeaders,
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
      const err = new Error(`ADF ${method} ${fullArmPath} -> ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }
}

// Factory-scoped convenience wrapper. `path` is relative to the factory ARM ID.
async function arm(method, path, body, extraQuery, extraHeaders) {
  return armAt(method, `${FACTORY_ID}${path}`, body, extraQuery, extraHeaders);
}

// GET a factory resource and return null on 404 instead of throwing.
// Used by mutating tools' plan step to detect create vs update.
async function fetchExistingOrNull(path) {
  try {
    return await arm("GET", path);
  } catch (e) {
    if (e?.status === 404) return null;
    throw e;
  }
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
const DESTRUCTIVE_REQUESTED = process.env.ADF_MCP_ALLOW_DELETE === "true";
const DESTRUCTIVE_ENABLED = WRITE_ENABLED && DESTRUCTIVE_REQUESTED;
if (WRITE_ENABLED) {
  console.error("[adf-mcp] write mode enabled — pipeline run + trigger control tools are exposed");
}
if (DESTRUCTIVE_ENABLED) {
  console.error(
    "[adf-mcp] destructive mode enabled — create_or_update_* and delete_* tools are exposed (plan/apply confirmation required)",
  );
} else if (DESTRUCTIVE_REQUESTED && !WRITE_ENABLED) {
  console.error(
    "[adf-mcp] WARNING: ADF_MCP_ALLOW_DELETE=true ignored because ADF_MCP_MODE is not 'write'.",
  );
}

// ─── Plan/apply token store for destructive mutations ───────────────────────
// Tokens bind a specific (tool, target, payload) to a confirmation call.
// The plan step returns a token; the apply step (dry_run=false) must echo it
// back. Tokens expire after PLAN_TTL_MS. Captured ETag enforces optimistic
// concurrency on the apply via If-Match.
const PLAN_TTL_MS = 10 * 60 * 1000;
const PLAN_STORE_MAX = 100;
const pendingPlans = new Map();

function hashPayload(payload) {
  return JSON.stringify(payload ?? null);
}

function createPlanToken(toolName, target, payload, etag) {
  // Bound the store: evict the oldest entry (Map preserves insertion order)
  // when at capacity. Prevents a buggy client from exhausting memory before
  // the periodic sweep runs.
  if (pendingPlans.size >= PLAN_STORE_MAX) {
    const oldest = pendingPlans.keys().next().value;
    if (oldest !== undefined) pendingPlans.delete(oldest);
  }
  const token = crypto.randomUUID();
  const expiresAt = Date.now() + PLAN_TTL_MS;
  pendingPlans.set(token, {
    toolName,
    target,
    payloadHash: hashPayload(payload),
    etag,
    expiresAt,
  });
  return { token, expiresAt: new Date(expiresAt).toISOString() };
}

function consumePlanToken(token, toolName, target, payload) {
  const entry = pendingPlans.get(token);
  if (!entry) {
    throw new Error(
      `Invalid confirm_token. Tokens expire after ${PLAN_TTL_MS / 60_000}m; request a new plan with dry_run=true.`,
    );
  }
  if (Date.now() > entry.expiresAt) {
    pendingPlans.delete(token);
    throw new Error(`confirm_token expired. Request a new plan with dry_run=true.`);
  }
  if (
    entry.toolName !== toolName ||
    entry.target !== target ||
    entry.payloadHash !== hashPayload(payload)
  ) {
    throw new Error(
      `confirm_token does not match the current call. If the payload changed since the plan, request a new plan.`,
    );
  }
  pendingPlans.delete(token);
  return entry;
}

// Sweep expired plans every minute. .unref() so the timer doesn't keep the
// Node event loop alive at shutdown.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of pendingPlans) {
    if (entry.expiresAt < now) pendingPlans.delete(token);
  }
}, 60_000).unref();

// Shared plan/apply executor used by every destructive tool. Splits the call
// into "compute plan + issue token" (dry_run, default) vs. "consume token +
// apply with If-Match" (dry_run=false).
async function executePlanApply({
  toolName,
  action,
  target,
  payload,
  dry_run,
  confirm_token,
  fetchBefore,
  buildAfter,
  apply,
}) {
  const isDryRun = dry_run !== false;
  if (isDryRun) {
    const before = await fetchBefore();
    const etag = before?.properties?.etag ?? before?.etag;
    const { token, expiresAt } = createPlanToken(toolName, target, payload, etag);
    return ok({
      plan_type: "DRY_RUN",
      action,
      target,
      before: before ?? null,
      after: buildAfter(),
      confirm_token: token,
      expires_at: expiresAt,
      hint: `To apply, call ${toolName} again with dry_run=false and confirm_token="${token}".`,
    });
  }
  if (!confirm_token) {
    throw new Error(
      "confirm_token is required when dry_run=false. Run with dry_run=true first to generate a plan.",
    );
  }
  const entry = consumePlanToken(confirm_token, toolName, target, payload);
  try {
    const result = await apply(entry.etag);
    return ok({ plan_type: "APPLIED", action, target, result });
  } catch (e) {
    if (e?.status === 412) {
      throw new Error(
        `Resource ${target} changed since the plan was computed (HTTP 412 Precondition Failed). Request a new plan with dry_run=true.`,
      );
    }
    throw e;
  }
}

const server = new McpServer({ name: "adf-mcp", version: VERSION });

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

// ─── Destructive tools — registered only when ──────────────────────────────
//      ADF_MCP_MODE=write AND ADF_MCP_ALLOW_DELETE=true
// Each tool uses the dry_run/confirm_token plan-apply pattern. The plan step
// fetches the existing resource (captures its ETag), shows before/after, and
// returns a single-use token. The apply step (dry_run=false) requires that
// token and uses If-Match for optimistic concurrency.

if (DESTRUCTIVE_ENABLED) {
  const planApplyInputs = {
    dry_run: z
      .boolean()
      .optional()
      .describe("If true (default), return the planned change without applying."),
    confirm_token: z
      .string()
      .optional()
      .describe("Token returned by a recent dry_run. Required when dry_run=false."),
  };

  // ── pipelines ──
  server.registerTool(
    "create_or_update_pipeline",
    {
      description:
        "Create a new pipeline or overwrite an existing one. Two-step: first call (dry_run=true, default) returns a diff and a confirm_token; second call (dry_run=false with that token) applies the change.",
      inputSchema: {
        name: z.string().describe("The pipeline name"),
        definition: z
          .record(z.unknown())
          .describe(
            "The pipeline body as the ADF REST API expects it, typically { properties: { activities: [...], parameters: {...} } }.",
          ),
        ...planApplyInputs,
      },
    },
    writeTool(
      "create_or_update_pipeline",
      ({ name }) => `pipeline=${name}`,
      async ({ name, definition, dry_run, confirm_token }) => {
        const path = `/pipelines/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "create_or_update_pipeline",
          action: "create_or_update",
          target: `pipeline=${name}`,
          payload: { definition },
          dry_run,
          confirm_token,
          fetchBefore: () => fetchExistingOrNull(path),
          buildAfter: () => definition,
          apply: (etag) =>
            arm("PUT", path, definition, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "delete_pipeline",
    {
      description:
        "Delete a pipeline. Two-step: first call (dry_run=true, default) returns the resource that will be removed and a confirm_token; second call (dry_run=false with that token) deletes it.",
      inputSchema: {
        name: z.string().describe("The pipeline name"),
        ...planApplyInputs,
      },
    },
    writeTool(
      "delete_pipeline",
      ({ name }) => `pipeline=${name}`,
      async ({ name, dry_run, confirm_token }) => {
        const path = `/pipelines/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "delete_pipeline",
          action: "delete",
          target: `pipeline=${name}`,
          payload: { name },
          dry_run,
          confirm_token,
          fetchBefore: async () => {
            const r = await fetchExistingOrNull(path);
            if (!r) throw new Error(`pipeline "${name}" does not exist; nothing to delete.`);
            return r;
          },
          buildAfter: () => null,
          apply: (etag) =>
            arm("DELETE", path, undefined, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );

  // ── triggers ──
  server.registerTool(
    "create_or_update_trigger",
    {
      description:
        "Create or overwrite a trigger. Same dry_run/confirm_token pattern as create_or_update_pipeline. NOTE: a newly-created trigger is in Stopped state — call start_trigger to activate it.",
      inputSchema: {
        name: z.string().describe("The trigger name"),
        definition: z
          .record(z.unknown())
          .describe("The trigger body, typically { properties: { type: '...', ... } }."),
        ...planApplyInputs,
      },
    },
    writeTool(
      "create_or_update_trigger",
      ({ name }) => `trigger=${name}`,
      async ({ name, definition, dry_run, confirm_token }) => {
        const path = `/triggers/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "create_or_update_trigger",
          action: "create_or_update",
          target: `trigger=${name}`,
          payload: { definition },
          dry_run,
          confirm_token,
          fetchBefore: () => fetchExistingOrNull(path),
          buildAfter: () => definition,
          apply: (etag) =>
            arm("PUT", path, definition, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "delete_trigger",
    {
      description:
        "Delete a trigger. Must be stopped first (use stop_trigger). Same dry_run/confirm_token pattern as delete_pipeline.",
      inputSchema: {
        name: z.string().describe("The trigger name"),
        ...planApplyInputs,
      },
    },
    writeTool(
      "delete_trigger",
      ({ name }) => `trigger=${name}`,
      async ({ name, dry_run, confirm_token }) => {
        const path = `/triggers/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "delete_trigger",
          action: "delete",
          target: `trigger=${name}`,
          payload: { name },
          dry_run,
          confirm_token,
          fetchBefore: async () => {
            const r = await fetchExistingOrNull(path);
            if (!r) throw new Error(`trigger "${name}" does not exist; nothing to delete.`);
            return r;
          },
          buildAfter: () => null,
          apply: (etag) =>
            arm("DELETE", path, undefined, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );

  // ── linked services ──
  server.registerTool(
    "create_or_update_linked_service",
    {
      description:
        "Create or overwrite a linked service (database / storage connection). Same dry_run/confirm_token pattern. Secrets in connection strings should be referenced from Key Vault, not inlined.",
      inputSchema: {
        name: z.string().describe("The linked service name"),
        definition: z
          .record(z.unknown())
          .describe(
            "The linked service body, typically { properties: { type: '...', typeProperties: {...} } }.",
          ),
        ...planApplyInputs,
      },
    },
    writeTool(
      "create_or_update_linked_service",
      ({ name }) => `linkedservice=${name}`,
      async ({ name, definition, dry_run, confirm_token }) => {
        const path = `/linkedservices/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "create_or_update_linked_service",
          action: "create_or_update",
          target: `linkedservice=${name}`,
          payload: { definition },
          dry_run,
          confirm_token,
          fetchBefore: () => fetchExistingOrNull(path),
          buildAfter: () => definition,
          apply: (etag) =>
            arm("PUT", path, definition, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "delete_linked_service",
    {
      description:
        "Delete a linked service. Any datasets that reference it will start failing — check with list_datasets first. Same dry_run/confirm_token pattern.",
      inputSchema: {
        name: z.string().describe("The linked service name"),
        ...planApplyInputs,
      },
    },
    writeTool(
      "delete_linked_service",
      ({ name }) => `linkedservice=${name}`,
      async ({ name, dry_run, confirm_token }) => {
        const path = `/linkedservices/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "delete_linked_service",
          action: "delete",
          target: `linkedservice=${name}`,
          payload: { name },
          dry_run,
          confirm_token,
          fetchBefore: async () => {
            const r = await fetchExistingOrNull(path);
            if (!r) throw new Error(`linked service "${name}" does not exist; nothing to delete.`);
            return r;
          },
          buildAfter: () => null,
          apply: (etag) =>
            arm("DELETE", path, undefined, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );

  // ── datasets ──
  server.registerTool(
    "create_or_update_dataset",
    {
      description: "Create or overwrite a dataset. Same dry_run/confirm_token pattern.",
      inputSchema: {
        name: z.string().describe("The dataset name"),
        definition: z
          .record(z.unknown())
          .describe(
            "The dataset body, typically { properties: { type: '...', linkedServiceName: {...} } }.",
          ),
        ...planApplyInputs,
      },
    },
    writeTool(
      "create_or_update_dataset",
      ({ name }) => `dataset=${name}`,
      async ({ name, definition, dry_run, confirm_token }) => {
        const path = `/datasets/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "create_or_update_dataset",
          action: "create_or_update",
          target: `dataset=${name}`,
          payload: { definition },
          dry_run,
          confirm_token,
          fetchBefore: () => fetchExistingOrNull(path),
          buildAfter: () => definition,
          apply: (etag) =>
            arm("PUT", path, definition, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "delete_dataset",
    {
      description:
        "Delete a dataset. Any pipelines that reference it will start failing — check with list_pipelines first. Same dry_run/confirm_token pattern.",
      inputSchema: {
        name: z.string().describe("The dataset name"),
        ...planApplyInputs,
      },
    },
    writeTool(
      "delete_dataset",
      ({ name }) => `dataset=${name}`,
      async ({ name, dry_run, confirm_token }) => {
        const path = `/datasets/${encodeURIComponent(name)}`;
        return executePlanApply({
          toolName: "delete_dataset",
          action: "delete",
          target: `dataset=${name}`,
          payload: { name },
          dry_run,
          confirm_token,
          fetchBefore: async () => {
            const r = await fetchExistingOrNull(path);
            if (!r) throw new Error(`dataset "${name}" does not exist; nothing to delete.`);
            return r;
          },
          buildAfter: () => null,
          apply: (etag) =>
            arm("DELETE", path, undefined, undefined, etag ? { "If-Match": etag } : {}),
        });
      },
    ),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

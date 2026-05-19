# Security Policy

## Reporting a vulnerability

If you find a security issue in `adf-mcp-server`, please **do not file a public GitHub issue**. Instead, email the maintainer listed in [`package.json`](package.json) with:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, ideally with a minimal example.
- Any suggested mitigation, if you have one in mind.

You should receive an acknowledgement within **5 business days**. A fix or formal response (including a decision not to fix) will follow within **30 days** for most issues.

## In scope

- Vulnerabilities in the server's own code (`index.js`).
- Vulnerabilities introduced by direct dependencies (`@azure/identity`, `@modelcontextprotocol/sdk`, `zod`) once they have a published advisory.
- Misuse of Azure tokens (e.g. logging the bearer token to stderr, leaking it to the LLM).
- Bypass of the read-only / write / destructive gates.
- Bypass of the plan/apply confirmation pattern for destructive tools.

## Out of scope

- Azure-side RBAC misconfiguration. The server enforces no permissions of its own — it acts with the privileges of whoever's token it holds.
- Vulnerabilities in MCP clients (Claude Code, Claude Desktop, Cursor, etc.).
- Vulnerabilities in transitive dependencies of MCP SDK HTTP transports — this server only uses the stdio transport, so HTTP-transport code is not loaded at runtime.
- Social engineering of an LLM into mis-using available tools. The gate model (read/write/destructive) and the plan/apply confirmation are designed to make this hard, but ultimately the operator must choose what to expose.

## Known limitations

Some things behave as designed but are worth knowing:

- The audit-log `caller` field is parsed from token claims and **not signature-verified**. If you can forge a token Azure trusted, you've already breached the boundary.
- The plan/apply token store is **in-memory**. Restarting the MCP server invalidates all in-flight plans. This is intentional — the safer failure mode.
- Activity output truncation in `query_activity_runs` counts JS string chars, not UTF-8 bytes.
- `list_*` tools do not follow ARM `nextLink` pagination — factories with hundreds of pipelines/datasets will see only the first page.

## Supported versions

The latest minor on the `1.x` line receives security fixes. Older `0.x` releases are not patched.

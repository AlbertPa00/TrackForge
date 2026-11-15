# Feature Specification: Agent-Ready API & MCP Server

**Source doc**: [`docs/sprints/007-agent-api-and-mcp.md`](../../docs/sprints/007-agent-api-and-mcp.md) — full user stories/FRs there.

## Scope decisions

- Idempotency: `IdempotencyRecord` table, per-principal key scope, sha256 body hash → 422 on mismatch, 24 h TTL, replay returns stored response.
- `dryRun=true` on all issue writes: validates, returns `{preview, changes[]}` in changelog-item shape, sets `X-TrackForge-DryRun`, persists nothing.
- Errors enumerate allowed values where the domain is finite (priority, issue type, status).
- MCP: first-party `apps/mcp` package, stdio + stateless Streamable HTTP; auth = `TRACKFORGE_TOKEN` (stdio) or per-request Bearer (HTTP); `X-TrackForge-Channel: mcp` on every call so History attributes the agent.
- Write tools omitted when the token lacks `write` scope (resolved via `whoami` at connect).
- Implemented: US1–US6 (OpenAPI+drift test, fields/expand, POST /search, /field+metas+serverInfo, idempotency, dryRun, allowed-values errors, bulk create, MCP server+tools+resources, eval set, compat harness → `docs/compatibility.md`).
- Deferred: webhook/event tools (011), copilot/approval tools (012).

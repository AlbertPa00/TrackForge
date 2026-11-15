# trackforge-mcp

MCP server exposing TrackForge's Jira-compatible REST API as agent tools.

> **Note:** the backend already serves Streamable HTTP at `{base}/mcp` — for
> most setups you don't need this package at all; see `docs/connect-agents.md`.
> Run it only for stdio clients or split deployments (separate port/host).
> Two transports: **stdio** (Claude Desktop / local agents) and
> **Streamable HTTP** (remote/shared agents).

## Setup

```bash
# 1. Create a PAT (scopes + optional project allow-list)
curl -X POST http://localhost:3000/api/internal/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"agent","scopes":["read","write"],"projectKeys":["TF"]}'
# → {"secret":"tfp_xxx..."}  shown once

# 2. Run over stdio (dev runs via tsx; `start` needs `pnpm --filter trackforge-mcp build` first)
TRACKFORGE_URL=http://localhost:3000 TRACKFORGE_TOKEN=tfp_xxx pnpm --filter trackforge-mcp dev

# or Streamable HTTP (stateless; each request may carry its own Bearer token)
TRACKFORGE_URL=http://localhost:3000 pnpm --filter trackforge-mcp dev -- --http --port 3001

# Read-only toolset: write tools are hidden from tools/list AND refused if
# called by name. stdio: --readonly flag or TRACKFORGE_MCP_READONLY=1.
# HTTP: append ?readonly or ?toolset=readonly to the URL.
TRACKFORGE_URL=http://localhost:3000 TRACKFORGE_TOKEN=tfp_xxx \
  pnpm --filter trackforge-mcp dev -- --readonly
```

Claude Desktop config:

```json
{ "mcpServers": { "trackforge": {
    "command": "node", "args": ["apps/mcp/dist/index.js"],
    "env": { "TRACKFORGE_URL": "http://localhost:3000", "TRACKFORGE_TOKEN": "tfp_..." } } } }
```

## Tools

| Tool | Purpose |
|---|---|
| `whoami` | Principal, scopes, project allow-list |
| `list_projects` / `get_project` | Project discovery |
| `get_create_meta` | Issue types + required fields + allowed values |
| `search_issues` | JQL-lite with `fields`, `expand`, `startAt`/`maxResults` paging |
| `find_ready_issues` | Ready work: unresolved, undelegated, no unresolved `blocks` links |
| `claim_issue` | Atomically claim the top-ranked ready issue (delegate + session, one tx) |
| `get_issue` | One issue; `fields`/`expand=changelog` |
| `create_issue` / `bulk_create_issues` | Create 1 or ≤50; `dry_run`, `idempotency_key` |
| `update_issue` / `assign_issue` / `transition_issue` | Writes with `dry_run` preview; `update_issue` also takes `transition_id`/`comment`/`worklog` for a composite one-call update |
| `get_transitions` / `find_users` | Workflow options / people resolution |

Every write tool supports `dry_run` (validate + preview, no persistence) and
`idempotency_key` (replay-safe). Errors surface Jira's
`{errorMessages[], errors{field:hint}}` shape with remediation hints.

## Resources

- `trackforge://project/{key}` — Jira project object
- `trackforge://issue/{key}` — Jira issue object

## Eval

`pnpm --filter trackforge-mcp eval` runs the full agent-contract suite through
the same client the tools use (needs `TRACKFORGE_TOKEN`). Exit 0 = agent surface
healthy — the suite is also a CI gate, so its count always reflects the shipped
surface rather than a number quoted here.

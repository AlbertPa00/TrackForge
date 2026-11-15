# TrackForge MCP server

`trackforge-mcp` exposes the Jira-compatible REST API as MCP tools. Same tool
surface, same safety rails — every write supports `dry_run` previews and
`idempotency_key` replay.

> **The simplest way to connect:** the backend itself serves Streamable HTTP
> at `{base}/mcp` — no second process. OAuth-capable clients (Claude, VS Code,
> Cursor, Windsurf) sign in via OAuth 2.1 + PKCE with zero config. See
> [connect-agents.md](connect-agents.md). The standalone transports below
> remain for repo-checkouts and split deployments.

## Quick start (stdio)

```bash
TRACKFORGE_URL=http://localhost:3000 TRACKFORGE_TOKEN=tfp_xxx \
  pnpm --filter trackforge-mcp start
```

Claude Desktop / `claude mcp add`:

```json
{ "mcpServers": { "trackforge": {
    "command": "node", "args": ["<repo>/apps/mcp/dist/index.js"],
    "env": { "TRACKFORGE_URL": "http://localhost:3000",
             "TRACKFORGE_TOKEN": "tfp_..." } } } }
```

## HTTP transport

**Same-origin (recommended):** the backend serves Streamable HTTP at
`{base}/mcp` — `GET /mcp` renders a landing page for humans; clients POST
JSON-RPC there. Bearer-only auth (session cookies are ignored); `GET
/.well-known/oauth-protected-resource/mcp` is the RFC 9728 metadata document
OAuth clients use to discover the authorization server, dynamic-register,
and sign the user in. `/mcp/readonly` is the pinned read-only alias.

**Standalone (split deployments):**

```bash
TRACKFORGE_URL=http://localhost:3000 pnpm --filter trackforge-mcp start -- --http --port 3001
```

Stateless per request: send `Authorization: Bearer <tfp_* PAT>` on each MCP
request; the server resolves identity + scopes from the token.
`GET /.well-known/oauth-protected-resource` advertises the `read`/`write`/`admin`
scope model.

## Read-only toolset

Give agents search/browse without any write path:

- stdio: `--readonly` flag or `TRACKFORGE_MCP_READONLY=1`
- HTTP: `?readonly` or `?toolset=readonly` query param

Write tools are **hidden from `tools/list` and refused at call time** — a
directly-addressed `create_issue` call against a readonly server returns an
"unknown tool" error, and even a registered write tool can't persist anything
because enforcement also happens per-request at the REST layer (token `write`
scope + project allow-list). This is the exact failure mode that shipped in
`mcp-atlassian` (filters enforced at list time only); TrackForge's tests assert
call-time rejection.

## Tool surface

Read tools (always registered): `whoami`, `list_projects`, `get_project`,
`get_create_meta`, `search_issues` (JQL — `key in ready()`, `key in blocked()`,
memberOf, linkedIssues…), `find_ready_issues`, `get_issue`, `get_transitions`,
`find_users`, `list_comments`, `list_worklogs`, `list_agent_sessions`,
`get_agent_session`, `get_agent_question`, attachments/download, agile helpers
(boards, sprints, backlog, reports).

Write tools (omitted entirely in readonly mode): `create_issue`,
`bulk_create_issues`, `update_issue` (composite: fields + `transition_id` +
`comment` + `worklog` in one call), `assign_issue`, `delegate_issue`,
`transition_issue`, `add_comment`, `edit_comment`, `log_work`, `link_issues`,
`claim_issue`, `emit_activity`, `ask_user`, `pick_issue`, plus the
project/sprint/version/field/admin `manage_*` mutations. Full list:
`apps/mcp/README.md`. Humans answer `ask_user` questions from the UI or
`POST /api/internal/agent-questions/{id}/answer` — there is no agent-side
answer tool by design.

## Working on issues — the intended loop

```
find_ready_issues(project_key)     → ranked list: unresolved, undelegated, unblocked
claim_issue(project_key | jql)     → atomic take: delegate + running session
emit_activity(type, text)          → thoughts/actions as you work
ask_user(issue_key, question)      → blocking question interrupt
update_issue(key, {transition_id}) → move through the workflow
```

Notes for agents:

- Status is transition-only. Use `get_transitions` → pick `id` →
  `transition_issue` (or `update_issue` with `transition_id`).
- `update_issue` composite ordering: fields → transition → comment → worklog.
- Errors use Jira's `{errorMessages[], errors{field:hint}}` — field errors list
  allowed values; self-correct and retry.
- `dry_run: true` on any write validates + previews without persisting.

## Token scopes

| Scope | Needed for |
|---|---|
| `read` | all read tools, `search_issues`, `find_ready_issues` |
| `write` | every mutation incl. `claim_issue`, `emit_activity`, `ask_user` |
| `admin` | admin surface (settings, users) |

Optional `projectKeys` allow-list on the PAT restricts all project-scoped
tools; a denied project returns 404 (no existence leak).

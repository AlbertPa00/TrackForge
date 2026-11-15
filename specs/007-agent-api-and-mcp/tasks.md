# Tasks — Sprint 007: Agent-Ready API & MCP

## Done

- [x] `IdempotencyRecord` + middleware: replay returns stored response, 422 on hash mismatch, 24 h TTL, per-principal scope
- [x] `fields=` selection + `expand=changelog|names|schema` on issue GET and search; `POST /rest/api/2/search`
- [x] `GET /field`, `createmeta` (project + issuetype forms), `editmeta`, Jira-shaped `serverInfo`, `GET /whoami` (internal auth)
- [x] `dryRun=true` on create/update/assignee/transition → `{preview, changes[]}` + `X-TrackForge-DryRun` header, nothing persisted
- [x] Allowed-values errors for finite-domain fields; assignee accepts `{accountId}` or `{name}`; `null`/`-1` unassigns
- [x] `POST /issue/bulk` — ≤50 items, Jira `{issues[], errors[]}` per-item results
- [x] `openapi.json` generated + Express-stack route-drift test (every mounted route documented)
- [x] `apps/mcp`: 13 tools, `trackforge://project|issue` resources, stdio + stateless HTTP, `X-TrackForge-Channel: mcp`, redacted logs, write tools omitted for read-only tokens
- [x] `eval/run.ts` — 14 scripted assertions via the same client (all green live); `eval/compat.ts` → `docs/compatibility.md` (16 full / 5 partial / 1 missing / 3 native)
- [x] Tests: `agent.test.ts` 15 tests incl. drift; full suite **75/75 green**

## Deferred

- [ ] Third-party Jira client harness in CI (compat.ts covers live surface; library TBD)
- [ ] Event/webhook + copilot MCP tools (sprints 011/012)

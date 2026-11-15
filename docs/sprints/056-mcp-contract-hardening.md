# Sprint 056 — MCP & Contract Surface Hardening

| | |
|---|---|
| **Status** | Done |
| **Milestone** | Post-GA (audit wave) |
| **Theme** | The agent surface must be as correct as the human surface — fix the broken tools, then make drift structurally impossible |
| **Depends on** | 007 (REST contracts), 012 (copilot/proposals), 016 (toolsets D21), 034 (automation tools), 048 (importer tools), 053 |
| **Unblocks** | Agents that can't 400 themselves on shipped tools; the generated contract registry (arch review) |
| **Spec-kit folder** | `specs/056-mcp-contract-hardening/` |

> **Origin**: deep audit of `apps/mcp/src/tools.ts`, `client.ts`, `index.ts`, `eval/run.ts`.
> Findings: 11 tools registered inside `registerResources` (including a *duplicate*
> `get_board` with a conflicting schema), two import tools that POST empty bodies, a
> group tool that lists project roles, an `update_issue` schema that guarantees a 400,
> read actions hidden from read-only tokens, and pagination that silently truncates.

## Goal

- **Every shipped tool works**: zero tools that 400/no-op on their documented happy path.
- **Registration is hygienic**: one tool, one name, one place — `registerResources` holds
  resources only; write gating applies to mutations, not reads.
- **Pagination is honest**: tools either page to `max_results` or report truncation.
- **Mutation parity**: `dry_run`/`idempotency_key`/`rationale` available on every write
  tool where the REST surface supports it.
- **Drift becomes a compile error**: the endpoint contract registry (arch review
  recommendation) lands far enough that tools can't silently diverge again.

## Scope

**In**: move the 11 misplaced tools out of `registerResources`; dedupe `get_board`;
fix `start_jira_import`/`start_jira_server_import` bodies; fix `manage_groups` list
target; `update_issue` schema (`status` removal or error-hint, `description` nullable,
full createmeta field coverage); ungate read actions in `manage_*` tools; paging in
`get_board_issues`/`get_backlog`/search tools with `truncated` flags; `move_card`
ambiguity (choose-by-transition or error with candidates + `dry_run`); `bulk_create_issues`
field coverage (labels/components/versions/CFs/parent/duedate); `dry_run`/`idempotency_key`
parity matrix across all write tools; eval additions for every fix; **contract registry
phase 1** — generate MCP tool→route mapping + zod schemas from a single declaration.

**Out**: new MCP capabilities beyond parity (058 owns UX-side agent features); SSE
subscription changes; stdio→HTTP transport changes; full codegen of `openapi.ts` +
`client.ts` (phase 2, later sprint).

## User stories

### US1 — Tools live where they belong (P0)

As an agent, I want every advertised tool to resolve to one handler.

1. **Given** `registerResources` at `tools.ts` ~2583–2799, **When** audited, **Then** it contains only `server.resource` calls — `list_boards`, `get_board`, `manage_board`, `manage_quick_filters`, `pick_issue`, `list_rules`, `get_rule`, `create_rule`, `run_rule`, `get_rule_runs`, `toggle_rule` move into `registerTools` with correct `write` gating.
2. **Given** the duplicate `get_board` (registered twice with different schemas), **When** deduplicated, **Then** one schema wins and eval asserts a single registration per tool name.

### US2 — No tool 400s on its happy path (P0)

1. **Given** `start_jira_import`/`start_jira_server_import`, **When** invoked, **Then** the arguments arrive as the request body — today `tf.call('POST', path, a)` sends `a` as *options*, body stays `undefined`, every call 400s (`tools.ts` ~1320–1356).
2. **Given** `manage_groups action=list`, **When** invoked, **Then** `GET /rest/api/2/groups/picker` — not `/rest/api/2/role` (`~1044–1047`).
3. **Given** `update_issue`, **When** an agent passes `status`, **Then** the tool either strips it with a hint to use `transition_issue` or the schema doesn't offer it — today it forwards `fields.status` into a guaranteed 400; `description` becomes `.nullable()` for clearing (`~163–205`).

### US3 — Read actions don't need write scope (P1)

As a read-only token holder, I want `manage_*` read actions to work.

1. **Given** a `read`-scoped token, **When** `manage_components action=list`, `manage_groups action=list`, `manage_versions action=list`, `manage_project_roles`/`manage_permission_scheme`/`manage_user` reads run, **Then** they execute — today the whole tool disappears when `write` is false.
2. **Given** the fix, **When** a read token calls a write action, **Then** the REST 403 is the error surfaced (scope enforcement stays server-side).

### US4 — Paging is honest (P1)

1. **Given** a board with >200 issues, **When** `get_board_issues`, **Then** it pages `startAt` to `total` (or up to a sane cap) instead of one `maxResults=200` call.
2. **Given** `get_backlog max_results=500` on a larger backlog, **When** invoked, **Then** it pages; any cap short of `total` returns `{truncated: true, total}` so agents can continue.
3. **Given** any list tool with a `total` field, **When** results truncate, **Then** the response says so — same pattern everywhere.

### US5 — Ambiguous and mutating tools are safe (P1)

1. **Given** `move_card` into a column reachable by >1 transition, **When** invoked, **Then** it errors listing candidates (or accepts `transition_id`) instead of silently picking `candidates[0]`; `dry_run` previews like the REST surface.
2. **Given** `bulk_create_issues`, **When** invoked with labels/components/versions/CFs/parent/due date, **Then** they map — matching REST `fields.*` coverage.
3. **Given** every write tool, **When** the parity matrix is applied, **Then** `dry_run`, `idempotency_key`, and `rationale` are present where the route supports them — matrix enforced by an eval check that diffs tool schemas against route capabilities.

### US6 — Contract registry phase 1 (P2)

As a maintainer, I want tool↔route drift to fail CI, not ship.

1. **Given** one declarative endpoint registry, **When** MCP tool generation runs, **Then** tool names, HTTP methods, paths, and zod schemas derive from it — starting with the mutation surface (highest drift cost), hand-registry for the rest.
2. **Given** a new endpoint, **When** it lands without a registry entry, **Then** the drift test fails (extending `agent.test.ts` patterns).

## Non-functional requirements

- **FR-001**: Read-only tokens must see every read capability — tool *visibility* is a scope property, tool *execution* stays permission-enforced server-side.
- **FR-002**: Tool descriptions keep the agent-hint style (valid values, next-step hints) — error-copy regressions are eval-checked.
- **FR-003**: No silent truncation anywhere an agent could assume completeness.

## MCP tools changed

Moved (11), deduplicated (`get_board`), fixed (`start_jira_import`,
`start_jira_server_import`, `manage_groups`, `update_issue`, `move_card`,
`bulk_create_issues`, `get_board_issues`, `get_backlog`), ungated reads
(`manage_*` family). No new surface area — this sprint is correctness.

## AI-native checklist

- [ ] Every fixed tool gets a deterministic `eval/run.ts` check.
- [ ] Write-tool `dry_run`/`idempotency_key`/`rationale` coverage is eval-asserted.
- [ ] Truncation flags are part of list-tool response contracts (A8).

## Success criteria

- **SC-001**: Eval suite exercises every previously-broken tool green.
- **SC-002**: A script asserts zero duplicate tool names and zero `server.tool` calls outside `registerTools`.
- **SC-003**: Read-scope token successfully lists components/versions/groups via MCP.
- **SC-004**: `get_board_issues` on a >200-issue board returns all (or flagged-truncated) issues.

## Implementation notes (landed)

- **US1** — all 10 misplaced tools moved out of `registerResources` into `registerTools` (resources now hold the 3 `trackforge://` resources only); duplicate `get_board` merged into a superset schema accepting `board`/`board_id`/`project_key` + `include_config`/`include_quick_filters`.
- **US2** — `start_jira_import`/`start_jira_server_import` send `{ body: a }` (were `tf.call('POST', path, a)` → args as CallOptions → guaranteed 400); `manage_groups list` hits `/rest/api/2/groups/picker`; `update_issue` drops `status` from the schema (stray status → agent-facing transition hint), `description` nullable.
- **US3** — `manage_*` read actions ungated; REST-side scope enforcement still 403s write actions on read tokens.
- **US4** — `get_board_issues` pages `startAt` (200/page, cap 1000→`max_issues`) with `{total, fetched, truncated}`; `get_backlog` same shape.
- **US5** — `move_card` accepts `transition_id`, returns candidate list on ambiguity, honors `dry_run`; `bulk_create_issues` maps labels/components/versions/duedate/parent/custom_fields + `idempotency_key`; `dry_run` added where routes support it (`estimate_issue`, `delegate_issue`, `set_issue_security`).
- **US6 — the structural change**: `WRITE_EXTRAS` (idempotency_key + rationale) is merged into every mutating tool's schema via `wtool()`; `withCallExtras` (AsyncLocalStorage in `client.ts`) injects the arg values into every `tf.call` the handler makes — declared flags can no longer silently no-op. All 75 mutating tools (56 write-gated + 19 read-visible `manage_*`/ops) route through `wtool`. `src/toolContract.ts` declares every mutation tool's routes + dryRun capability; `eval/run.ts` fails on unregistered tools, orphan entries, route drift, or false/missing `dry_run` flags.
- **Bonus fix** — `searchDocs` was literal-phrase `indexOf` only; now whole-phrase OR all-term coverage (query "API token scopes" finds security-model/user-guide whose prose never repeats the phrase).
- **Verified**: `pnpm --filter trackforge-mcp eval` → **115/115** (7 source-scan + 108 REST); `tsc --noEmit` + `eslint` clean on mcp + backend; `docs.test.ts` 10/10 (new searchDocs coverage).

## Risks

| Risk | Mitigation |
|---|---|
| Paging loops amplify backend load | Respect server `maxResults` cap; cap total pages; surface `truncated` |
| Registry phase-1 scope creep | Mutations only; read tools stay hand-mapped this sprint |
| Deduping `get_board` breaks callers of the weaker schema | Merge schemas superset; eval covers both call shapes |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `pnpm --filter trackforge-mcp eval` green against seeded backend.
- [ ] `docs/compatibility.md` + eval `compat.ts` notes updated where behavior changed.

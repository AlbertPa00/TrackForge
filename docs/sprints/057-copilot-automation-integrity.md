# Sprint 057 — Copilot, Automation & Data Integrity

| | |
|---|---|
| **Status** | Done |
| **Milestone** | Post-GA (audit wave) |
| **Theme** | AI features and cross-entity mutations must fail atomically, attribute correctly, and never corrupt denormalized state |
| **Depends on** | 012 (copilot), 022 (clone/move), 034 (automation), 047 (agent sessions), 010/032 (JQL), 009 (boards), 026 (dashboards), 053 |
| **Unblocks** | Trustworthy AI writes; 058's apply-diff and agent-presence UX |
| **Spec-kit folder** | `specs/057-copilot-automation-integrity/` |

> **Origin**: deep audit of `copilotService`, `automationService`, `issueOpsService`,
> `issueService`, `jql/compiler`, `boardService`, `dashboardService`, `notificationService`.
> Findings: delegation on create spawns no session, copilot can't unassign, automation
> can't assign to reporter/accountIds, clone desyncs watcher counts and mixes storage
> I/O into DB transactions, CF-date JQL shifts days by timezone, and a gadget matrix
> key collision that silently merges cells.

## Goal

- **Delegation is one contract**: `delegate` behaves identically on create and update —
  session spawned, event emitted.
- **AI write-paths compose safely**: copilot steps and automation actions resolve users
  and unassign correctly; multi-step creates are idempotent/atomic.
- **Clone/move leave consistent state**: counters, ranks, aliases, and storage objects
  can't desync.
- **JQL compares what users mean**: date equality isn't offset by the server's timezone.
- **Gadgets render the right data**: config defaults apply; matrix cells don't collide.

## Scope

**In**: `createIssue` delegate→session parity; copilot `assign_issue` null-handling;
automation `assign` action (reporter + accountId resolution); `cloneIssue` watcherCount
ordering, subtask `rank` collision, attachment I/O moved outside `tx` with orphan
cleanup; AI breakdown batch-idempotency/rollback; `compileCfCondition` date tz fix;
board `getBoardConfiguration` via `getProjectWorkflow` (workflowScheme-aware); vote/watch
counter mutation transactional consistency; notification outbox retry/duplicate
semantics audit; 2-D gadget key delimiter; `addGadget` default-config fallback +
`ConfigForm` initial state.

**Out**: new automation actions/conditions; copilot planner redesign (052 scope);
attachment-store port changes (D12 stays); JQL engine refactors beyond the tz fix.

## User stories

### US1 — Delegate on create = delegate on update (P1)

As an agent user, I want `fields.delegate` at creation to open a session.

1. **Given** `POST /rest/api/2/issue` with `fields.delegate`, **When** the issue is created, **Then** an `AgentSession` spawns and `agent_session.created` emits — today only `updateIssue` does this (`issueService.ts` ~539–608 vs ~1181–1191), contradicting `docs/agents.md`.
2. **Given** the session, **When** the agent queries its sessions, **Then** the created session is visible with issue context (A2).

### US2 — AI write resolvers handle every documented value (P1)

1. **Given** copilot step `assign_issue` with no assignee, **When** executed, **Then** it unassigns (`{accountId: null}`) — today it sends `{name: ""}` and 400s (`copilotService.ts` ~222–231).
2. **Given** automation action `assign` to `"reporter"` or an `accountId`, **When** run, **Then** it resolves — today only `'unassigned'`/`'lead'` are special-cased and everything else is looked up by *name* (`automationService.ts` ~250–263).

### US3 — Clone/move leave consistent state (P0)

1. **Given** clone with watchers, **When** cloned, **Then** `watcherCount` counts the caller-upsert too — today count is set before the upsert (`issueOpsService.ts` ~247–285).
2. **Given** clone with subtasks, **When** cloned, **Then** subtasks get distinct ranks — today they inherit the parent's rank repeatedly, colliding order semantics.
3. **Given** a DB failure after attachment bytes are copied, **When** clone aborts, **Then** no orphaned storage objects — storage copy moves outside `tx` with compensating delete (D12 port).
4. **Given** the copilot/AI breakdown creating N child issues, **When** child K fails, **Then** the operation is idempotent (retry-safe batch token) or rolls back — today the loop leaves a partial set.

### US4 — JQL and board config are timezone/workflow-scheme correct (P1)

1. **Given** server tz `Europe/Berlin` and JQL `cfDate = "2026-11-08"`, **When** compiled, **Then** it matches `2026-11-08` — today `.toISOString().slice(0,10)` slices the UTC day, matching `2026-11-07` for positive offsets (`jql/compiler.ts` ~484–504).
2. **Given** a project on a `workflowSchemeId` (not `workflowId`), **When** board configuration lists unmapped statuses, **Then** it consults the resolved scheme workflow — today it checks `board.project.workflowId` only (`boardService.ts` ~138–152).

### US5 — Counters, notifications, gadgets stay true (P1)

1. **Given** concurrent vote/watch mutations, **When** they land, **Then** denormalized counters update in the same transaction as the join-row write — today they're separate operations.
2. **Given** notification generation from the event outbox, **When** processing fails/retries, **Then** no duplicates and no drops — verify dedupe keys and retry semantics against `notificationService.ts` watcher fan-out.
3. **Given** a two-dimensional gadget, **When** cells `x1+y1` and `x2+y2` sum equal, **Then** they don't collide — add a delimiter to the matrix key (`dashboardService.ts` ~308–313, `DashboardsPage.tsx` ~498–505).
4. **Given** gadget config fields with defaults (pie `statType=status`), **When** added untouched, **Then** defaults apply instead of `400 Missing required config` (`DashboardsPage.tsx` ~99–103, ~213–232).

## Non-functional requirements

- **FR-001**: External I/O (attachment storage) never runs inside a DB transaction.
- **FR-002**: Denormalized counters mutate in the same transaction as their source rows, or are recomputed on read — pick per field, document the choice.
- **FR-003**: Multi-issue AI writes carry a batch idempotency key so retries can't double-create.

## Success criteria

- **SC-001**: Delegate-on-create spawns a visible session (integration test).
- **SC-002**: Copilot unassign + automation reporter/accountId assign green (tests).
- **SC-003**: Clone consistency: watcherCount, subtask ranks, no orphan on induced failure (tests).
- **SC-004**: CF-date equality test passes under `TZ=Europe/Berlin` and `TZ=America/New_York`.
- **SC-005**: Gadget adds with untouched default config succeed; colliding-sum matrix cells render separately.

## Risks

| Risk | Mitigation |
|---|---|
| Moving storage I/O out of `tx` widens the failure window | Compensating cleanup + reconciliation job for orphans |
| Batch idempotency for breakdown changes response shape | Keep shape; add `batchId` — agent tools surface it |
| Counter transaction contention on hot issues | Single-statement `UPDATE … SET count = (SELECT …)` per mutation |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] `docs/agents.md` delegation contract matches implementation (create + update) — doc already stated create-or-update; implementation now satisfies it.
- [x] Threat-model entry reviewed for AI batch writes (016 obligation) — batch writes now carry per-item idempotency records (`bulk:{batchId}:{index}`) under the caller's principal; replay revalidates request hash → a stolen/reused batch token cannot create with different fields (422 per item).

## Implementation notes (landed)

- **US1** — `createIssue` spawns `AgentSession` + emits `agent_session.created` on `fields.delegate`, matching `updateIssue` and `docs/agents.md`.
- **US2** — copilot `assign_issue` emits `{accountId: null}` for missing/explicit-null assignee (was `{name: ""}` → 400); automation `assign` resolves `reporter` from `ctx.issue.fields.reporter.accountId` and raw accountIds/emails/displayNames via a dual-key `AssigneeRef`.
- **US3** — `cloneIssue`: `watcherCount`/`voteCount` now computed from actual rows after the caller auto-watch; subtasks get chained `rankAfter` ranks (were all the parent's); attachment bytes copy **before** the tx against the pre-generated clone id with compensating `store.delete` on abort — no external I/O inside `$transaction` (FR-001); `POST /issue/bulk` accepts `batchId` — per-item `bulk:{batchId}:{index}` `IdempotencyRecord`s replay `{id,key,self,replayed:true}` or 422 on field mismatch (FR-003). Copilot `executePlan` injects `copilot-{planId}-{index}` as `batchId`; MCP `bulk_create_issues` exposes `batch_id`.
- **US4** — CF `date` JQL operands format the wall-clock day in `ctx.tz` via `zonedParts` (was UTC slice → off-by-one for positive offsets); `getBoardConfiguration` resolves the effective workflow via `getProjectWorkflow` (scheme→default→workflowId→Simple).
- **US5** — `addVote`/`removeVote`/`addWatcher`/`removeWatcher` write join row + counter in one tx (FR-002); notification fan-out audited — already dedupe-safe via `@@unique([userId,eventId,reason])` + `skipDuplicates` under at-least-once dispatch; 2-D matrix cells keyed `JSON.stringify([x,y])` in gadget + report + CSV + both frontends (fixes the invisible collision AND the `${x} ${y}` reader bug that rendered zeroes); `addGadget` merges declared defaults before required-check and persists them — untouched `pie-chart`/`two-dimensional` configs no longer 400; `ConfigForm` seeds defaults on type pick.
- **Verified**: `sprint057.test.ts` **9/9** (all five SCs incl. Berlin + New_York tz runs); regression suites agentSessions/automation/issueops/dashboards/bulk **37/37**; MCP eval **115/115**; `tsc` + `eslint` clean on backend/frontend/mcp.

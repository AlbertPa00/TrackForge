# Sprint 024 — Time Tracking & Worklogs

| | |
|---|---|
| **Status** | **Done** (implemented 2026-11: schema+migration `024_worklogs`, worklog CRUD + adjustEstimate + dryRun, `/worklog/updated|deleted|list` sync, timetracking fields + JQL, importer, MCP tools, Log Work UI; 14 tests green) |
| **Milestone** | M2 Daily-driver parity |
| **Theme** | Jira parity — estimation beyond story points (DESIGN P1) |
| **Depends on** | 008 (editable fields, activity feed), 013 (estimates vocabulary), 015 (`WORK_ON_ISSUES`/`EDIT_ALL_WORKLOGS`), 017 (importer contract) |
| **Unblocks** | Time-tracking/workload reports and timesheet (028), worklog notifications (029), worklog import |

> **Replan corrections (2026-11-07, verified against Jira Cloud REST v2):** `adjustEstimate`
> accepts **`new` | `leave` | `manual` | `auto`** (default `auto`), with `newEstimate` for `new`
> and `reduceBy` for `manual`; the draft below omitted `manual`/`reduceBy`. Jira also exposes
> `GET /rest/api/2/worklog/updated|deleted` and `POST /worklog/list` (incremental sync for
> integrations) — include them (cheap, importer- and agent-friendly). Worklog `visibility`
> restrictions belong to 031. Ships an `EntityImporter` for Jira worklogs + time-tracking fields.
| **Spec-kit folder** | `specs/024-time-tracking-worklogs/` |

## Goal

DESIGN §13 — real time tracking, separate from story points:

- **Estimate fields**: `originalEstimate`, `remainingEstimate`, `timeSpent` — Jira's
  `timetracking` object (`{originalEstimate:"1w 2d", originalEstimateSeconds:…, …}`),
  duration strings (`"3h 30m"`) parsed both directions.
- **Worklogs**: per-issue `POST/GET/PUT/DELETE /issue/{key}/worklog/{id}` records
  (author, seconds, started date, comment); activity tab shows worklogs; `issue_worklogged`
  event for 029.
- **UI**: Log Work dialog (§13.2 — time spent, date, auto-adjust remaining, comment);
  time-tracking panel on issue detail (progress bar §13.1); `aggregatetimespent`
  (parent+subtasks roll-up per Appendix B).
- **Config**: §13.3 workday/workweek settings + pretty-vs-hours format (admin, global).

## Why now

Worklogs feed the heaviest remaining reports (time tracking, workload, timesheet — 027) and
are part of migration fidelity (017/039). Placing it after versions keeps the report sprint
fully stocked; keeping it before dashboards lets a "time spent" gadget exist.

## Scope

**In**: three estimate fields (seconds storage, Jira duration-string surface);
`timetracking` in payload/createmeta/editmeta; worklog CRUD endpoints + entity;
log-work dialog with remaining-adjust options (`auto` | `leave` | `set X`);
worklog entries in Activity tab (own row type); JQL fields `workratio`,
`timeSpent`, `originalEstimate`, `remainingEstimate` (`>` `<` `=` duration compare);
`aggregate*` rollups for parents; worklog author/edit permissions; JQL `worklogDate`
range filter (P2); `Worklog.billable` boolean + JQL `billable` field (Tempo's core paid
flag, nearly free here); config page under admin (§13.3, global only — no per-project
overrides).

**Out**: timesheet UI (027 report), per-user calendars/capacity, overtime/flex rules,
tempo-style approvals — the 012 proposals mechanism is the review primitive for this;
schedule post-GA when pilots demand (reuses, never forks) —
`worklogAuthor`/`worklogComment` JQL fields beyond `worklogDate`.

---

## User stories

### US1 — Estimates (P1)

As a planner, I want original + remaining estimates so I can compare plan vs reality.

**Independent test**: set `originalEstimate: "1w"`, log `4h`, set remaining `"4d"`;
payload shows all three as strings+seconds; JQL `remainingEstimate > 1d` matches.

**Acceptance scenarios**

1. **Given** `PUT /issue` with `fields.timetracking: {originalEstimate:"2w 1d", remainingEstimate:"3d"}`, **When** parsed, **Then** duration grammar (`w d h m`, Jira) converts to seconds; invalid strings → Jira-style 400; display formats back per §13.3 config.
2. **Given** `timetracking` field in `createmeta`/`editmeta`, **When** rendered, **Then** the issue page shows the §13.1 progress panel (percent = spent/(spent+remaining)).
3. **Given** `fields.timetracking` in JQL, **When** `originalEstimate > 2w`, **Then** seconds comparison applies; duration literals `"2w"`/`"10d"` accepted as values.

### US2 — Worklogs (P1)

As a team member, I want to log work so effort is recorded where it happened.

**Acceptance scenarios**

1. **Given** `POST /issue/{key}/worklog {timeSpent:"3h", started, comment?}` with query `adjustEstimate=auto|leave|new|manual` (+ `newEstimate` / `reduceBy`), **When** logged, **Then** a worklog row exists, `timeSpent` accumulates, and remaining auto-adjusts per the flag (Jira `adjustEstimate` contract).
2. **Given** `GET/PUT/DELETE /issue/{key}/worklog/{id}`, **When** used, **Then** author or `EDIT_ALL_WORKLOGS` can edit (Jira returns 403 otherwise); `GET` supports `startAt`/`maxResults` + `startedAfter/Before` filters.
3. **Given** the Activity tab, **When** rendered, **Then** worklogs interleave with comments/history (own icon, "logged 3h — comment") and `issue_worklogged` events emit (A6).
4. **Given** an issue with subtasks, **When** `fields.aggregatetimespent` etc. render, **Then** parent+children sums appear per Appendix B.

### US3 — Configuration (P2)

As an admin, I want Jira's workday assumptions configurable.

**Acceptance scenarios**

1. **Given** `/admin/system` time-tracking section, **When** set (§13.3: default unit, format, 8h day, 5d week, auto-adjust default), **Then** duration parsing/formatting uses them instance-wide.
2. **Given** `GET /api/internal/system/info`, **When** agents query, **Then** workday assumptions are discoverable (A3).

---

## Edge cases

- Remaining hits 0 → progress shows 100% even if more is logged (over-budget shown as >100%, Jira behaviour).
- Editing a worklog doesn't auto-readjust remaining (Jira: manual; documented).
- `timeSpent` is derived from worklogs only — direct `fields.timeSpent` writes rejected (Jira parity).
- Duration `0` on a log rejected; `started` required (Jira requires).
- Worklog on hidden issue → same 404 path (015).
- `workratio` = spent/original % — only when original set.

## Functional requirements

- **FR-001**: Duration strings MUST round-trip (Jira grammar both directions) — no silent float hours.
- **FR-002**: Worklog writes MUST emit changelog + `issue_worklogged` event + audit (A2/A6).
- **FR-003**: `timeSpent`/`aggregates` MUST be computed fields — never stored drift-able values.
- **FR-004**: Edit/delete MUST honor author-or-`EDIT_ALL_WORKLOGS` (Jira semantics).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/rest/api/2/issue/{key}/worklog` | Jira; POST query params `adjustEstimate`/`newEstimate`/`reduceBy` |
| GET | `/rest/api/2/worklog/updated` · `/worklog/deleted` · POST `/worklog/list` | Jira incremental sync |
| GET/PUT/DELETE | `/rest/api/2/issue/{key}/worklog/{id}` | Jira |
| GET | `/rest/api/2/issue/{key}/worklog/{id}/list` | Optional — skip if unused |
| — | `fields.timetracking`, `aggregatetimespent`, `workratio` | Jira payload objects |

## Data model changes

- **Issue**: `originalEstimateSec Int?`, `remainingEstimateSec Int?` (`timeSpent` derived from worklog sum).
- **Worklog**: `id`, `issueId`, `authorId`, `timeSpentSec`, `started`, `comment?`, `channel`, `tokenId?`, `createdAt`, `updatedAt`.
- **Setting** table or env-backed config for §13.3 (global row).

## MCP tools added

`log_work` (adjust flag + dry-run preview of new estimates), `list_worklogs`,
`set_estimate` (original/remaining). (`get_timesheet` ships with the timesheet report in 027.)

## AI-native checklist

- [ ] `log_work` dry-run shows resulting estimate state before commit (A4).
- [ ] Duration grammar documented in `jql_help` + tool schemas (A3/A8).
- [ ] Worklog events emitted for reactive agents (A6).

## Success criteria

- **SC-001**: Estimate→log→auto-adjust→JQL round-trip matches Jira semantics end-to-end.
- **SC-002**: Worklog CRUD permission matrix (author/admin/other) enforced.
- **SC-003**: Parent issue aggregates subtask time correctly.
- **SC-004**: Agent eval: "log 2h to TF-4 and keep remaining at 1d" yields correct state.

## Risks

| Risk | Mitigation |
|---|---|
| Duration-parse edge cases ("1.5d" vs "1d 4h") | Jira grammar table-tested; ambiguous forms documented |
| Derived-vs-stored drift | Aggregates computed at read; single source = worklog rows |
| `remaining` confusion vs `original` | UI panel labels both clearly (§13.1 layout) |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `compat.ts` gains worklog family; timetracking shape verified vs Jira.
- [ ] Seed: project with estimated+logged issues for demo/report fixtures.

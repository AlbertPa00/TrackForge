# Sprint 013 — Scrum Completion

| | |
|---|---|
| **Status** | Done |
| **Theme** | Jira parity |
| **Depends on** | 004 (basic backlog & sprint lifecycle), 009 (persisted boards, LexoRank, workflows), 010 (JQL board filters); 006 changelog for reports |
| **Unblocks** | Reports/dashboards (Later), AI sprint planning |
| **Spec-kit folder** | `specs/013-scrum-completion/` |

## Goal

Finish the Scrum experience that Sprint 004 started. Sprint 004 delivered the basic loop: a backlog
view, creating/starting/completing sprints, dragging issues between backlog and sprints, and a board
that scopes to the active sprint. This sprint adds what Scrum teams need to plan and measure:

- a ranked, estimated backlog;
- full sprint planning (dates, duration, goal, carry-over to the next sprint);
- explicit Scrum boards instead of 004's implicit mode;
- sprint history, plus burndown and velocity reports;
- the Jira Agile endpoints 004 deferred.

## Baseline from Sprint 004

What 004 provides ([`specs/004-backlog-sprints`](../../specs/004-backlog-sprints/)), and what this sprint changes:

| 004 behaviour | Change in 013 |
|---|---|
| Sprint belongs to a project (`originBoardId` = project key) | Sprint belongs to a persisted board (009); migration maps each project's sprints to its board |
| `Issue.sprintId` (current sprint only) | Add sprint-membership history (`IssueSprint`) so past sprints and reports are accurate; `Issue.sprintId` becomes derived |
| "Scrum mode" is implicit: board scopes to the active sprint if one exists | Explicit board `type = scrum` vs `kanban`; Kanban boards never scope to sprints |
| Completing a sprint returns open issues to the backlog | Completion dialog lets users move open issues to the backlog, an existing future sprint, or a new sprint |
| Dates only settable via API; no reports; no ranking; no story points | Start-sprint dialog with duration/dates/goal; LexoRank ordering; story points; burndown and velocity |
| Sprint ids are UUIDs; no delete | Delete future sprints (issues return to backlog); ids follow D7 alongside board ids |

## Why now

Without ranking, estimates and reports, teams can't plan capacity or check progress. These features
depend on ranking and persisted boards (009) and on JQL-backed board filters (010).

## Scope

**In**: backlog ranking (drag and multi-select), story points, inline create in backlog, start-sprint
dialog, completion with carry-over choice, sprint edit/delete, explicit Scrum board type, sprint
membership history, burndown and velocity reports, remaining Agile endpoints, AI sprint planning (P3).

**Out**: parallel sprints, cross-project boards, Timeline/roadmap view, cumulative flow and control
charts, per-person capacity planning.

---

## User stories

### US1 — Ranked, estimated backlog (P1)

As a product owner, I want to order the backlog and estimate it in story points so that the team knows what's next and how big it is.

**Independent test**: in TF Backlog, drag issues to reorder (including a multi-select drag), set story points inline, add an issue with inline create; reload and order and estimates persist; sprint headers show point totals.

**Acceptance scenarios**

1. **Given** the backlog and sprint groups from 004, **When** a user drags an issue within or between groups, **Then** its rank updates via `PUT /rest/agile/1.0/issue/rank` (LexoRank from 009) and the order persists for everyone.
2. **Given** Shift/Ctrl multi-select, **When** several issues are dragged, **Then** they move together and keep their relative order.
3. **Given** the Story Points column, **When** edited inline, **Then** the value is saved and summed in each sprint/backlog header. The field is exposed with id `story_points` and name "Story Points" in `/field`, `createmeta` and `editmeta`. (Jira uses an instance-specific `customfield_NNNNN` id; this divergence is documented.)
4. **Given** "+ Create issue" at the bottom of a group, **When** a summary is entered, **Then** the issue is created in that group at the bottom rank.
5. **Given** `GET /rest/agile/1.0/board/{id}/backlog`, **When** called, **Then** issues not in an active or future sprint are returned in rank order.

### US2 — Full sprint planning and completion (P1)

As a Scrum master, I want to set sprint dates and goals, and choose where unfinished work goes, so that sprints match how the team actually works.

**Independent test**: start "TF Sprint 2" for two weeks with a goal; complete it with 2 open issues moved to a new "TF Sprint 3"; the closed sprint still lists everything it contained.

**Acceptance scenarios**

1. **Given** a future sprint at the top of the list and no active sprint on the board, **When** "Start sprint" is clicked, **Then** a dialog collects name, duration (1/2/3/4 weeks or custom), start/end dates and goal, then sets `state: "active"` through the existing 004 partial update (`POST /sprint/{id}`).
2. **Given** an active sprint, **When** "Complete sprint" is clicked, **Then** a dialog shows completed vs open counts and lets the user send open issues to the backlog, an existing future sprint, or a new sprint. Issues count as "completed" when their status maps to the board's right-most column (Jira semantics).
3. **Given** a closed sprint, **When** viewed (sprint picker or issue Sprint field), **Then** it lists every issue that was in it at completion, using membership history.
4. **Given** a future sprint, **When** deleted (`DELETE /rest/agile/1.0/sprint/{id}`), **Then** its issues return to the backlog. Active and closed sprints cannot be deleted.
5. **Given** `PUT /rest/agile/1.0/sprint/{id}` (full update, Jira), **When** called on a future or active sprint, **Then** name, goal and dates change. Closed sprints are read-only.

### US3 — Explicit Scrum boards (P1)

As a team, we want to choose whether our board is Scrum or Kanban so that behaviour is predictable.

**Acceptance scenarios**

1. **Given** the 009 persisted boards, **When** this sprint's migration runs, **Then** boards of projects that have ever had a sprint become `type = scrum`; all others stay `kanban`. Sprints are re-parented from project to board.
2. **Given** a Scrum board with an active sprint, **When** opened, **Then** the header shows sprint name, goal, days remaining and "Complete sprint". With no active sprint, an empty state links to the backlog.
3. **Given** a Kanban board, **When** opened, **Then** it never scopes to sprints and the sidebar hides Backlog (or shows Kanban backlog in a later sprint).
4. **Given** board settings, **When** an admin changes the board type, **Then** a confirmation explains the effect on sprints and the board updates.

### US4 — Burndown and velocity (P2)

As a Scrum master, I want burndown and velocity charts so that the team can track progress and plan realistically.

**Acceptance scenarios**

1. **Given** an active or closed sprint, **When** the user opens Reports → Burndown, **Then** a chart shows remaining story points per day against a guideline, with a scope-change table. The data comes from the changelog (006) and sprint membership history: estimate changes, issues added/removed, issues completed.
2. **Given** a board with closed sprints, **When** the user opens Reports → Velocity, **Then** a bar chart shows committed vs completed points for the last 7 sprints, plus the average.
3. **Given** `GET /api/internal/reports/burndown/{sprintId}` and `/reports/velocity/{boardId}`, **When** called, **Then** they return JSON series suitable for charting (DESIGN.md §18.5).
4. **Given** a Scrum board, **When** the sidebar renders, **Then** "Backlog", "Active sprint" and "Reports" are enabled.

### US5 — AI-assisted sprint planning (P3, requires 012)

As a product owner, I want the copilot to propose a sprint scope so that planning starts from a sensible draft.

**Acceptance scenarios**

1. **Given** AI is enabled and the board has at least 3 closed sprints, **When** the user clicks "Suggest sprint scope" on a future sprint, **Then** the copilot proposes top-ranked issues that fit average velocity and flags unestimated or blocked issues. The plan is shown as a preview; nothing moves until the user confirms.

---

## Edge cases

- Sprints created in 004 without dates get `startDate` = first activation time (if known from changelog) or `null`; reports skip sprints without dates and show a notice.
- An issue belongs to at most one open (active or future) sprint; closed-sprint memberships are kept as history.
- Completing a sprint where every issue is completed skips the carry-over choice.
- Changing story points mid-sprint shows as a scope change in burndown.
- Rank ties after migration are broken by issue key once, when LexoRank is first assigned.

## Functional requirements

- **FR-001**: Boards MUST have an explicit `type` (`scrum` | `kanban`); only Scrum boards have sprints and a sprint-scoped board.
- **FR-002**: Sprints MUST belong to a board; 004 project-scoped sprints MUST be migrated without data loss.
- **FR-003**: Sprint membership history MUST be recorded and used for closed-sprint views and reports.
- **FR-004**: Story points MUST be a numeric field available in `/field`, `createmeta`, `editmeta` and JQL (`"Story Points" > 3`, `sprint = <id>`, `sprint in openSprints()`, `sprint in closedSprints()`).
- **FR-005**: Backlog and sprint ordering MUST use LexoRank via the Agile rank endpoint.
- **FR-006**: Reports MUST be computed from changelog and membership history, not from snapshots that can drift.
- **FR-007**: The 004 contracts (`POST /sprint`, partial update, sprint issues, backlog move, board issue scoping) MUST remain backward compatible; any change is documented.

## API surface

Builds on the 004 contracts. New or changed endpoints only:

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/agile/1.0/board/{id}/backlog` | New, rank order |
| PUT | `/rest/agile/1.0/sprint/{id}` | New, full update |
| GET | `/rest/agile/1.0/sprint/{id}` | New, single sprint |
| DELETE | `/rest/agile/1.0/sprint/{id}` | New, future sprints only |
| PUT | `/rest/agile/1.0/issue/rank` | From 009; now used by backlog |
| GET | `/rest/agile/1.0/epic/{key}` · `/epic/{key}/issue` | New |
| GET | `/rest/agile/1.0/issue/{key}` | New: issue with sprint/epic/rank info |
| GET | `/api/internal/reports/burndown/{sprintId}` · `/reports/velocity/{boardId}` | Native |

DESIGN.md §18.3 lists `/sprint/{id}/start` and `/close`. They are not real Jira endpoints and won't be
built; sprints start and close through a `state` update, as in Jira and as 004 already does.

## Data model changes

- **Sprint**: add `boardId` (replaces project scoping), `completeDate?`, `sequence`; keep `goal`, dates.
- **IssueSprint**: `issueId`, `sprintId`, `addedAt`, `removedAt?`. Backfilled from `Issue.sprintId` and the changelog where available.
- **Issue.storyPoints?** (decimal). *(Amendment, 2026-11-07 replan — D19)*: this column stays the
  storage permanently. Sprint 014 registers it in the field registry as a system-managed custom
  field (Jira models Story Points as a CF) whose storage adapter reads/writes this column — **no
  data migration**. Keep all access behind a field accessor (no direct `issue.storyPoints` reads
  in route code) so the 014 facade is a registration, not a refactor.
- **Sprint ↔ board** *(amendment)*: sprints carry an origin `boardId`; because 009 FR-007 makes
  boards N:1 per project, a sprint must be visible on every board whose filter matches its issues
  (Jira semantics) — do not assume one board per project in queries.
- **Board.type**: `scrum` | `kanban`, now persisted and meaningful.

## MCP tools added

`get_backlog`, `create_sprint`, `start_sprint`, `complete_sprint` (with carry-over target),
`move_to_sprint`, `move_to_backlog`, `rank_issue` (multi-issue), `estimate_issue`,
`get_sprint_report` (burndown and velocity as compact text plus data), `suggest_sprint_scope` (P3,
when AI is configured). If 004's sprint operations reach this sprint without MCP tools (004 predates
the MCP server in 007), add them here.

## AI-native checklist

- [x] Sprint, backlog, rank and estimate operations are available as MCP tools with dry-run (A3, A4).
- [x] Sprint lifecycle changes emit events (`sprint_created`, `sprint_started`, `sprint_closed`) for webhooks and the feed (A6).
- [x] AI planning suggestions go through preview/confirm (A7).

## Success criteria

- **SC-001**: A team can rank, estimate, plan, start, run and complete a sprint with carry-over entirely in the UI (Playwright journey).
- **SC-002**: Burndown and velocity match a hand-computed fixture for a seeded history of 3 sprints.
- **SC-003**: Migration test: a database with 004-era project sprints migrates to board sprints with all memberships preserved.
- **SC-004**: The Agile endpoints pass the compatibility harness from 007, extended with sprint and backlog calls.
- **SC-005**: Agent eval: "plan next sprint for TF using last velocity and list the unestimated items" completes correctly.

## Risks

| Risk | Mitigation |
|---|---|
| Reports wrong for 004-era sprints (no membership history) | Backfill from the changelog where possible; flag sprints with incomplete history in reports |
| Migration from implicit to explicit Scrum mode surprises users | Rule-based type assignment (US3.1) + release note + board-type setting |
| Backlog drag performance with 1,000+ issues | Virtualised list; rank updates are single-row writes |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] Seed includes a Scrum project with 3 closed sprints and one active sprint for demos and report fixtures.
- [x] Contracts document every change relative to the 004 contracts.

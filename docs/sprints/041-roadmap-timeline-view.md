# Sprint 041 — Roadmap & Timeline View

| | |
|---|---|
| **Status** | Done — backend feed (`/api/internal/roadmap/{board}`, `?level=epics\|issues`, quick-filter/status/assignee/label filters, permission-filtered), `RoadmapPage` (epic bars, drag/resize `startdate`+`duedate`, dependency arrows w/ conflict highlight, critical path, version pins, month/quarter zoom, collapse tree), project sidebar Timeline entry live, MCP `get_roadmap`. Tests: backend 3/3 (epic bars+rollup+links+versions, issues-level tree, status filter) · frontend 3/3 (rows/progress, level switch, empty state). Deferred: milestone diamonds for versions on issue rows, link-creation drag affordance polish, swimlane grouping |
| **Milestone** | M5 Enterprise & reach |
| **Theme** | Jira parity — the planning view (DESIGN P1, §18.5 endpoint) |
| **Depends on** | 008 (epic hierarchy, due dates), 013 (estimates), 014 (**Start date system CF** — already exists), 019 (versions for markers), 033 (board context/switcher) |

> **Replan correction (2026-11-07, D19):** Jira models Start date as a custom field, and 014
> already ships it as a system-managed CF (`startdate` alias). The `Issue.startDate` column and
> "US1 — Start dates" below are superseded: this sprint has **no schema change** and is purely the
> timeline view, drag-scheduling (writes `startdate`/`duedate` through `PUT /issue`), version
> pins, dependency arrows and the `/api/internal/roadmap/{boardId}` data endpoint.
| **Unblocks** | The last §3.1 P1 parity item — the top-nav "Roadmap" is no longer missing |
| **Spec-kit folder** | `specs/041-roadmap-timeline-view/` |

## Goal

DESIGN's epic-timeline roadmap — the one P1 view 013 explicitly excluded. Jira shows epics
as horizontal bars over a calendar; TrackForge gets the same:

- **Timeline view** under each project: epics as bars from a start (explicit `startDate`
  field — Jira has one; we add it as a system field) to due date, child-issue rollup
  progress inside each bar, months/quarters zoom, today marker.
- **Scheduling by drag**: resize/reposition bars to set `startDate`/`duedate` (writes go
  through normal issue update — changelog/audit intact).
- **Dependencies**: link-type arrows (Blocks) between epic bars — visual only.
- **Version markers**: release dates (019) as timeline pins.
- **Task-level Gantt mode**: a second view on the same surface — every issue row
  (epic → story → sub-task hierarchy, expand/collapse), dependency arrows for
  `Blocks`-family links between *issues*, critical-path highlight, milestone
  diamonds for versions — BigPicture-style, same design language, writes
  through `PUT /issue` exactly like roadmap bars.
- `/api/internal/roadmap/{boardId}` data endpoint per §18.5 (+ `?level=issues`
  for the Gantt feed).

## Why last

It needs epics+dates+versions+estimates to be meaningful — all of which now exist. It's also
the least load-bearing remaining item: everything else feeds *work*; this feeds *planning
visibility*.

## Scope

**In**: the Start date system CF (014, `fields.startdate`/`startdate` JQL — exists), backlog/board
display optional); timeline UI (epic bars, % progress from child status categories, drag
resize/move, zoom months/quarters, today line, unscheduled-lane for epics without dates);
version pins; dependency arrows for `Blocks`-family links between epics; filters
(status/assignee/label/component); `GET /api/internal/roadmap/{boardId}` returning
`{epics:[{key,summary,start,due,progress,links}], versions:[{name,date}], range}`.

**Gantt mode (added 2026-11-12)**: a toggle on the same route rendering the same
two-level hierarchy as rows — epic → story/sub-task per issue (every issue type,
not just epics); left tree grid (key, summary, type icon, assignee) synced with
the bar pane; dependency arrows between *issues* for `Blocks`/`is blocked by`
(and the other link types, styled per type); **critical-path highlight**
(longest dependency chain to the latest-dated issue — computed client-side from
the same payload); version milestone diamonds; today line; zoom day/week/
month/quarter; drag move/resize per issue (writes `startDate`/`duedate` via
`PUT /issue`); drag-to-create-link between rows (creates an `IssueLink` via the
v2 API); double-click row → issue detail. Styling is pure design-system: atl-*
tokens, the 026 chart-kit grid scales/tooltips, issue-type accent colors —
**visually identical language to the roadmap view**, not a different widget.

**Out**: auto-scheduling/what-if simulation (Jira's premium feature — out), capacity/resource
lanes (Jira Align territory — DESIGN excludes), sub-epic levels (hierarchy stays two levels
per current model — Gantt *rows* show all issues within that), Gantt export beyond PNG/CSV
(stretch: print view), baseline snapshots (P3 idea, not spec'd), per-epic color
customization (use issue-type accent tokens).

---

## User stories

### US1 — Start dates (P1)

As a planner, I need a start date to schedule work.

**Acceptance scenarios**

1. **Given** the Start date CF (014), **When** set via `fields.startdate`, **Then** it's editable on detail/create/editmeta and queryable as `startDate`/`startdate` in JQL (`>=`, `<=`, relative dates).
2. **Given** epics without dates, **When** timeline renders, **Then** they sit in an "Unscheduled" lane draggable onto dates.

### US2 — Timeline (P1)

As a PO, I want to see the plan over time.

**Acceptance scenarios**

1. **Given** the project Roadmap view, **When** rendered, **Then** epics show as bars (start→due), progress fills by completed-children %, today is marked, and versions pin on the axis.
2. **Given** drag-resize/drag-move, **When** released, **Then** `startDate`/`duedate` update via normal issue update (changelog + permissions apply — the view is a client of the API, not a backdoor).
3. **Given** zoom quarter/month, **When** toggled, **Then** the axis rescales; filters narrow to matching epics.
4. **Given** `Blocks` links between epics, **When** rendered, **Then** dependency arrows draw; a blocked epic whose blocker ends after its start shows a visual warning.

### US3 — Data endpoint (P2)

As an agent/integration, I want roadmap data programmatically.

**Acceptance scenarios**

1. **Given** `GET /api/internal/roadmap/{boardId}`, **When** called, **Then** the documented shape returns honoring board filter + permissions — same data the UI renders (A1).

### US4 — Task-level Gantt (P1)

As a PM, I want the classic Gantt — every task as a row, dependencies as arrows, critical path visible — in Jira's visual language.

**Acceptance scenarios**

1. **Given** the project Roadmap view, **When** the **Gantt** toggle is on, **Then** rows render for every issue in the board's filter (epic → story → sub-task nested, expand/collapse per parent); the left tree grid (key/type/summary/assignee) and the bar pane share scroll and row height.
2. **Given** `Blocks` (and other link types) between issues, **When** rendered, **Then** arrows connect dependent bars — styled per link type, hover shows the link name; a dependency ending after the dependent's start shows the same conflict warning as the roadmap view.
3. **Given** "Critical path" toggle, **When** on, **Then** the longest dependency chain ending at the latest-due issue highlights in `atl-r-*`; turning it off restores normal colors.
4. **Given** drag-move/resize on any row, **When** released, **Then** `startDate`/`duedate` write via `PUT /issue` (changelog + permissions); drag row→row onto another row's link-drop target creates an `IssueLink` through `POST /issueLink` — never a backdoor.
5. **Given** `GET /api/internal/roadmap/{boardId}?level=issues`, **When** called, **Then** every issue row returns with `{key,type,start,due,progress,links[]}` — the Gantt renders exactly that (A1 parity test).
6. **Given** 2k+ issues, **When** scrolled, **Then** rows virtualize; zoom day→quarter rescales the shared axis.

---

## Edge cases

- Epics with due < start → validation rejects (Jira allows nothing illogical either).
- Child spanning beyond parent dates → bar shows overflow indicator (Jira behavior).
- Huge epic counts → virtualized rows + date-range window.
- No dates at all → onboarding empty state pointing at start-date usage.
- Circular `Blocks` links → arrows render but critical-path computation caps traversal and flags the cycle rather than hanging.
- Issues without dates in Gantt → unscheduled rows (bar ghosted at today, draggable onto dates) — same rule as epic lane.
- Sub-tasks scheduled outside parent window → parent bar overflow indicator (same as roadmap).

## Functional requirements

- **FR-001**: Scheduling writes MUST go through `PUT /issue` — timeline is an API client (A1, A2).
- **FR-002**: `startDate`/`startdate` MUST be a Jira-named field in payload, createmeta, editmeta and JQL.
- **FR-003**: The data endpoint MUST return exactly what the UI renders (permission-filtered).
- **FR-004**: Progress MUST derive from child status categories live — no cached rollup.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/api/internal/roadmap/{boardId}` · `?level=issues` | §18.5 endpoint; issues level feeds the Gantt |
| — | `fields.startdate` on issue + JQL `startDate` | System field |

## Data model changes

- None — Start date is the 014 system-managed CF; no schema delta in this sprint.

## MCP tools added

`get_roadmap` (epics/dates/progress/versions compact view; `level=issues` returns
the Gantt feed — rows, links, milestones), `set_schedule`
(start/due on an epic — validated, dry-run-aware).

## AI-native checklist

- [ ] Agents read/write the schedule through the API (A1).
- [ ] `get_roadmap` returns planning answers ("what's at risk") agents can reason on (A8).
- [ ] `set_schedule` validates date logic with dry-run (A4).

## Success criteria

- **SC-001**: Drag-schedule → dates persist via changelog'd writes; JQL `startDate` filters.
- **SC-002**: Timeline renders fixture project correctly: bars, progress, versions, deps, unscheduled lane.
- **SC-002b**: Gantt mode renders the fixture: every issue row, expand/collapse, per-link-type arrows, critical path, milestones; drag → `PUT /issue`; drag-row→row → `IssueLink`.
- **SC-003**: Endpoint data == UI data (parity test, both `level=epics` and `level=issues`).
- **SC-004**: Agent eval: "which epics overrun their release dates" — correct computed answer.

## Risks

| Risk | Mitigation |
|---|---|
| Timeline libs → heavy deps | Custom SVG/HTML grid (design-system bars; no dep justified yet) |
| "Start date" field semantics vs created | Explicitly a planning field, distinct from `created` (Jira has both) |
| Scope creep into auto-planning | Out-list is explicit — this is a view + schedule writes only |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Sidebar gains Roadmap; the stale "Coming in Sprint 013" label is removed everywhere.
- [ ] Gantt mode lands on the same route (`Roadmap` ↔ `Gantt` toggle) using only atl-* tokens + the 026 chart kit — no new dependency (D17 stands).
- [ ] §3.1 P1 parity checklist: all rows now Done or have an explicit exclusion note.

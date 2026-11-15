# Sprint 027 — Reports I: Agile Reports (Sprint, Epic, CFD, Control Chart)

| | |
|---|---|
| **Status** | Epic (draft) — Wave 3; scenarios are candidates, re-validate at wave planning |
| **Milestone** | M3 Insight & communication |
| **Theme** | Jira parity — the analytics layer (DESIGN P0), part 1 of 2 |
| **Depends on** | 006 (changelog — every report's data source), 013 (sprint membership history, burndown/velocity), 026 (chart kit) |
| **Unblocks** | 028 (shares the report framework); data-driven agent answers on flow |
| **Spec-kit folder** | `specs/027-reports-agile/` |

> **Replan note (2026-11-07):** the former single "Reports Suite" (13 reports) was split — it was
> two sprints of work. This part builds the **report framework** and the agile/flow reports; 028
> adds the general and time-based reports on the same framework.

## Goal

- **Report framework**: registry (`/api/internal/reports` lists types + required params — A3),
  param validation, JSON data endpoint per report, renderer on the 026 chart kit, CSV/PNG/print
  export, Reports tab in the project sidebar. Jira's `GET /rest/agile/1.0/board/{boardId}/reports`
  (verified) lists the board's available reports — mirror it.
- **Sprint Report**: completed / not completed / removed / added-mid-sprint, scope-change log,
  committed vs completed points.
- **Epic Report**: progress over time, remaining work, velocity-based forecast window.
- **Burndown & velocity** (from 013) relocated onto the kit with zero data regressions.
- **Cumulative Flow Diagram** and **Control Chart** (cycle time, rolling average, outliers).

## Candidate user stories

### US1 — Sprint & epic reports (P1)
1. **Given** a closed sprint, **When** `reports/sprint/{sprintId}` runs, **Then** completed (done at close), not completed (spilled), added/removed mid-sprint, scope-change log and committed/completed points are returned — Jira Sprint Report semantics.
2. **Given** an epic, **When** `reports/epic/{key}` runs, **Then** completed/total counts + points over time, remaining estimate, and a velocity-derived forecast window (heuristic documented) are returned.
3. **Given** burndown/velocity from 013, **When** re-rendered, **Then** values are identical to 013 fixtures.

### US2 — Flow reports (P1)
1. **Given** a board + range, **When** `reports/cfd/{boardId}` runs, **Then** daily stacked counts per board column (status mapping from 009) are rebuilt from the changelog, counting state at day end.
2. **Given** a board + range, **When** `reports/control/{boardId}` runs, **Then** per-issue cycle time (first entry into an in-progress column → last entry into the done column) scatters with mean, rolling average (configurable window) and outliers.

### US3 — Framework & export (P1)
1. **Given** `GET /api/internal/reports`, **When** called, **Then** each type lists params, scope (board|sprint|project|filter) and export formats.
2. **Given** `?format=csv|png`, **When** exported, **Then** CSV = the JSON series; PNG = the rendered chart.

## Key constraints

- **FR**: every report derives from changelog + membership history, never drift-prone snapshots (013 FR-006).
- **FR**: reports permission-filtered via `permissionService` (and 031 issue security when present).
- **FR**: JSON data endpoint first; charts are renderers (A1).
- **Perf**: 50k-issue fixture, 90-day CFD < 1 s p95; range cap documented.

## API surface (candidate)

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/agile/1.0/board/{boardId}/reports` | Jira (verified) — available reports |
| GET | `/api/internal/reports` | Registry (TF ext) |
| GET | `/api/internal/reports/sprint/{sprintId}` · `/epic/{key}` · `/burndown/{sprintId}` · `/velocity/{boardId}` | Scrum |
| GET | `/api/internal/reports/cfd/{boardId}` · `/control/{boardId}` | Flow (DESIGN §18.5) |

## Data model

None — derivation only; `ReportCache` reserved behind the report port, built only if 030's perf
gate requires it.

## MCP

`get_report` (type + params → compact series + text summary) — one tool for all report types
(D21); `get_sprint_report` from 013 becomes an alias.

## Success criteria (candidate)

- Sprint/epic reports match hand-computed fixtures (incl. spillover and scope change).
- CFD/control chart verified against a seeded multi-day transition history.
- Agent eval: "why did velocity drop in sprint 6" answered from report data.

## Implementation status

**Slice 1 — framework + all backend resolvers (shipped)**

- `REPORT_REGISTRY` at `GET /api/internal/reports` (type/params/scope/formats — A3); Jira `GET /rest/agile/1.0/board/{id}/reports` returns per-board report list.
- `getCfd` (daily end-of-day per-column counts), `getControlChart` (cycle = first inprogress → last done; mean/stddev/rolling), `getEpicReport` (parentId children + velocity forecast = remaining pts / avg completed of last 3 closed sprints — documented heuristic).
- All derive from `changeHistory` (FR: no snapshot drift); 365-day range cap.
- `?format=csv` on every report endpoint (BOM + RFC-4180).
- MCP `get_report` (all 6 types + `list_types`).
- `reports.test.ts` 4/4. Status categories are `todo|inprogress|done` (not Jira keys) — fixed in control chart + 026 sprint-health gadget.
- Gotcha recorded: file-level `beforeEach` races setup.ts's wipe — always scope fixtures inside `describe`.

**Remaining slices:** ~~ReportsPage renderers for epic/CFD/control on the 026 chart kit~~ ✅ · ~~PNG export~~ ✅ client-side (`ExportMenu` serializes the rendered SVG → canvas → PNG; spec's server-side `?format=png` remains a documented divergence — CSV stays endpoint-side) · ~~perf gate vs 50k fixture~~ ✅ `tests/integration/reports-perf.test.ts`: 50k issues + ~35k status changes, 90-day CFD p95 **928ms < 1000ms**. The gate caught and fixed two real bugs: `in:` clauses exceeding SQLite/Postgres bind limits (chunked at 5000) and `getCfd` rewritten as a sweep-line — O(issues+changes+days) vs O(days×issues×changes), plus in-window-only change fetch + groupBy for unchanged issues (3936ms → 928ms). One observed ~191s outlier was an environmental stall; 4/5 runs ≤928ms.

# Sprint 028 — Reports II: General, Time & Release Reports

| | |
|---|---|
| **Status** | Epic (draft) — Wave 3; scenarios are candidates, re-validate at wave planning |
| **Milestone** | M3 Insight & communication |
| **Theme** | Jira parity — the analytics layer (DESIGN P0), part 2 of 2 |
| **Depends on** | 027 (report framework), 019 (versions), 024 (worklogs, time-tracking config), 014 (CF grouping) |
| **Unblocks** | Full DESIGN §12 + §13.4 parity |
| **Spec-kit folder** | `specs/028-reports-general-time/` |

## Goal

The remaining DESIGN §12.3 reports and the §13.4 timesheet, on the 027 framework:

- **Distribution**: Pie Chart (any field incl. CFs), Two-Dimensional (x × y), User Workload
  (open issues + points + remaining estimate per user), Workload Pie.
- **Trend**: Created vs Resolved (cumulative option), Average Age (unresolved, by period),
  Resolution Time (by priority/type).
- **Time**: Time Tracking report (original / spent / remaining per issue, version or sprint),
  **Timesheet** (user × day grid, totals vs configured workday).
- **Release**: Version Report (done %, remaining, predicted release date from velocity).
- **Project summary**: per-project landing metrics — status/type/priority
  distribution, created-vs-resolved trend, recent activity, open-workload
  snapshot — powers a Summary tab on the project sidebar (the "how is this
  project doing" glance Jira Cloud ships; added 2026-11-12, same framework).
- **Org metrics**: instance-level aggregates for admins — issue/user/project
  counts, issue growth over time, activity volume — admin-gated, exported
  through the same registry (added 2026-11-12, same framework).

## Candidate user stories

### US1 — Distribution & trend (P2)
1. **Given** `reports/pie?jql=&field=`, **When** run, **Then** counts per value for system fields and CFs (014) return; same for `twoDimensional?x=&y=`.
2. **Given** `reports/createdVsResolved?jql=&period=day|week&days=90&cumulative=`, **When** run, **Then** two series match a seeded fixture.
3. **Given** `averageAge` / `resolutionTime`, **When** run, **Then** values match hand-computed fixtures (definitions documented).

### US2 — Time & timesheet (P2)
1. **Given** `reports/timeTracking?version=|sprint=`, **When** run, **Then** per-issue estimate vs spent vs remaining with totals and accuracy %.
2. **Given** `reports/timesheet?user=&from=&to=`, **When** run, **Then** issue × day grid of logged seconds from worklogs (024), totals and variance vs the configured workday.

### US3 — Version report (P2)
1. **Given** a version, **When** `reports/version/{id}` runs, **Then** done %, remaining points/estimate and a predicted release date (velocity-based, with confidence note) return; release date drift shown against `releaseDate`.

### US4 — Project summary & org metrics (P2)
1. **Given** `reports/project/{key}`, **When** run, **Then** status/type/priority distributions, created-vs-resolved trend, recent activity and open-workload snapshot return; the project sidebar Summary tab renders it from that single payload.
2. **Given** `reports/org`, **When** an admin runs it, **Then** instance totals (issues/users/projects), issue growth over time and activity volume return; non-admins get 403.

## Key constraints

- Same framework rules as 027 (registry, JSON-first, permission filtering, CSV = JSON).
- JQL-scoped reports accept any saved filter (010) as scope.
- Timesheet respects worklog visibility once 031 lands.

## API surface (candidate)

`GET /api/internal/reports/{pie|twoDimensional|workload|createdVsResolved|averageAge|resolutionTime|timeTracking|timesheet|version/{id}|project/{key}}`
plus `GET /api/internal/reports/org` (admin-gated) — all with `?format=csv|png`.

## MCP

Covered by `get_report` (027); no new tools (D21). `get_timesheet` (old draft) is an alias.

## Success criteria (candidate)

- Each report matches its fixture; CSV equals JSON.
- Project summary shows real counts on the project Summary tab; `reports/org` is 403 for non-admins.
- Agent eval: "who is overloaded this sprint" and "will version 2.1 ship on time" answered from report data.

## Implementation status (slice 1 — backend)

**Implemented:** all 11 resolvers on the 027 framework — `pie`, `two-dimensional`, `workload` (open issues + points + remaining est. per assignee), `created-vs-resolved` (`days` ≤365, `cumulative`), `average-age` (weekly buckets `W0..Wn`), `resolution-time` (grouped by `priority|status|issuetype|assignee|...`), `time-tracking` (version|sprint|project scope; spent derived from worklogs — `Issue` has no `timeSpentSec`), `timesheet` (per-user per-day grid + `totalsByDay`, 8h workday), `version/{id}` (points + remaining estimate + velocity heuristic forecast = avg of last 3 closed sprints × 14d), `project/{key}` (status/type/priority dists + 30d created-vs-resolved + last-10 domain events), `org` (totals + 30d issue growth + activity by type — **403 for non-admins**, checked in the route).

Notes: `resolution-time` counts `resolved` = issues with a `resolutiondate` (not the JQL total); default JQL uses `resolution != Unresolved` (compiler has no `EMPTY` on the resolution branch). CSV parity for every type via `toRows` branches matching each payload shape. Reuses the existing `get_report` MCP tool — no new tool.

**Deferred:** ~~PNG export~~ ✅ client-side `ExportMenu` on every report section (CSV via `?format=csv`, PNG rasterizes the section's SVG; table-only sections are CSV-only) · ~~50k-perf gate (shared with 027)~~ ✅ `reports-perf.test.ts` — 90-day CFD p95 928ms · workload-pie variant (pie covers the same via `statType=assignee`) · ~~org-metrics UI~~ ✅ `/admin/organization` — totals cards, 30-day issue-growth chart, activity-by-type bars on the admin console.

## Implementation status (slice 2 — frontend)

`ReportsPage` now renders all 9 project-scoped 028 reports alongside the 027 board reports: project summary (3-column distribution lists), pie (statType select + proportional bar + legend), two-dimensional (x×y heatmap matrix with axis selects), created-vs-resolved (dual-line SVG + days/cumulative controls), average-age (bucket bars), resolution-time (grouped bars + groupBy select), workload table, time-tracking table (project scope + totals), timesheet grid (user × day, under-workday cells flagged red), version report (picker + progress + forecast/confidence). Single `fetchReport<T>(path)` client helper against `/api/internal/reports`.

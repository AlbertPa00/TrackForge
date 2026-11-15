# Sprint 026 — Dashboards & Gadgets

| | |
|---|---|
| **Status** | Epic (draft) — Wave 3; scenarios are candidates, re-validate at wave planning |
| **Milestone** | M3 Insight & communication |
| **Theme** | Jira parity — the home page (DESIGN P0) |
| **Depends on** | 010 (saved filters power gadgets), 011 (activity feed), 013 (burndown/velocity data), 015 (groups/roles for sharing), 024 (time gadgets) |
| **Unblocks** | Chart kit reuse (027/028), "system dashboard" landing |

> **Replan corrections (2026-11-07, verified against Jira Cloud REST v2):** Jira's dashboard API
> is richer than the draft assumed and covers sharing natively — use it instead of TF extensions:
> `GET/POST /rest/api/2/dashboard` (POST body requires `name`, `sharePermissions[]`,
> `editPermissions[]`), `GET/PUT/DELETE /dashboard/{id}`, `POST /dashboard/{id}/copy`,
> `GET /dashboard/search`, `GET /dashboard/gadgets` (available gadget types — the A3 registry),
> `GET/POST /dashboard/{dashboardId}/gadget`, `PUT/DELETE /dashboard/{dashboardId}/gadget/{gadgetId}`,
> and `…/items/{itemId}/properties/{key}` for gadget config. Share-permission types follow Jira
> (`global`, `loggedin`, `group`, `project`, `project-role`, `user`). The
> `POST /api/internal/dashboards/{id}/share` row and `sharedScope/sharedTarget` columns below are
> superseded by `DashboardSharePermission` rows; the aggregate data endpoint stays a TF extension.
> Wallboard mode is out (P3 backlog). Ships an `EntityImporter` for dashboards (best-effort; gadget
> types without a TF equivalent reported).
| **Spec-kit folder** | `specs/026-dashboards-gadgets/` |

## Goal

Jira's landing experience — DESIGN §11 and a P0 checklist item:

- **Dashboards**: named, ordered collections of gadgets in a 2-3 column grid; private or
  shared (group / project role / open).
- **Gadget framework**: each gadget = `{type, position, config}` rendering a self-contained
  widget that refreshes on an interval.
- **Core gadget set** from §11.1 (the ten highest-value first; the rest tagged P3).
- Top-nav **Dashboards** menu enabled (replacing the disabled stub).

## Why now

All gadget data sources now exist (filters, activity, reports, worklogs). Dashboards give the
platform a "home" — and the chart/gadget primitives are reused by the reports sprint (027).

## Scope

**In**: `Dashboard` + `DashboardGadget` entities; grid layout (add/remove/move gadgets,
2 or 3 columns); gadget config forms (filter picker, field picker, refresh interval);
ten gadgets: **Assigned to Me, Filter Results, Two-Dimensional Filter Stats, Pie Chart,
Created vs Resolved, Sprint Health, Burndown, Velocity, Recently Updated, Activity Stream,
Watched Issues** (eleven — pick by effort, rest P3); sharing (private/group/role/public per
§11.3); "dashboards" nav + dashboard picker + default dashboard per user + system default.

**Out**: the remaining §11.1 gadgets (Average Age, Statistics/Heat Map, Favourite Filters —
trivially added once framework exists; P3), wallboard/TV auto-cycle mode (P3), iframe/embed
gadgets (not a core need), gadget marketplace.

---

## User stories

### US1 — Dashboards (P1)

As a user, I want my own dashboard so the tool opens on what matters to me.

**Independent test**: create "My Board" with Assigned-to-Me + Activity Stream; share to
group; another user in the group sees it; grid edits persist.

**Acceptance scenarios**

1. **Given** `POST /api/internal/dashboards {name}`, **When** created, **Then** an empty dashboard exists; `GET /dashboards` lists mine + shared-with-me; `PUT` renames/reorders; `DELETE` owner-only.
2. **Given** sharing `{scope: group|role|public, target?}`, **When** set, **Then** 015 resolution governs visibility; private dashboards stay invisible (existence-protected).
3. **Given** "star/default", **When** chosen, **Then** it lands on `/dashboards/{id}` at login and is remembered per user.

### US2 — Gadget framework (P1)

As a user, I want gadgets I can add, place, configure and refresh.

**Acceptance scenarios**

1. **Given** `POST /dashboards/{id}/gadgets {type, config, position}`, **When** added, **Then** the gadget renders; `PUT` moves/resizes; config dialog edits its settings; auto-refresh honors the per-gadget interval (default 15min).
2. **Given** each core gadget, **When** configured, **Then** it works: Assigned-to-Me (live query), Filter Results (saved filter + column set), 2D Stats (xField×yField counts), Pie (field grouping), Created-vs-Resolved (line chart), Sprint Health (active sprint progress donut), Burndown/Velocity (013 charts as widgets), Recently Updated, Activity Stream (011 feed), Watched Issues.
3. **Given** an empty/error state (filter deleted, no data), **When** rendered, **Then** the gadget shows a Jira-style empty card, not a crash.

### US3 — Chart primitives (P1, architecture)

As a maintainer, I want one chart kit reused by gadgets and 027 reports.

**Acceptance scenarios**

1. **Given** `components/charts/*` (line, bar, pie/donut, stacked-area, scatter) as SVG primitives with shared scales/tooltips/legend, **When** dashboards and reports render, **Then** both consume the same kit — no duplicated chart code (V: simplest consistent abstraction).
2. **Given** dark/light or density variants, **When** rendered, **Then** existing atl-* tokens drive styling; no new palette.

---

## Edge cases

- Gadget referencing a deleted filter/CF → "configure me" state, dashboard unaffected.
- Sharing to a group the sharer leaves → share persists (Jira), admin editable.
- >20 gadgets on one dashboard → pagination/scroll, documented cap.
- Wallboard refresh cadence vs rate limits → server aggregates gadget data into one call (`/dashboards/{id}/data`) — no N-parallel hammering.
- Shared-dashboard gadget shows data the *viewer* can't see (private filter) → gadget renders what viewer is allowed (permission-checked per viewer).

## Functional requirements

- **FR-001**: Gadget data MUST come from existing APIs/JQL — gadgets never query tables directly (A1).
- **FR-002**: Sharing MUST evaluate through the 015 permission service.
- **FR-003**: Dashboard layout MUST persist server-side (not localStorage) so agents can render dashboards (VI).
- **FR-004**: One aggregate data endpoint per dashboard MUST exist to keep refresh cheap.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/rest/api/2/dashboard` | Jira list/create (subset) |
| GET/PUT/DELETE | `/rest/api/2/dashboard/{id}` | Jira |
| GET/POST/PUT/DELETE | `/rest/api/2/dashboard/{id}/gadget` · `/{gadgetId}` | Shape follows Jira Cloud's gadget API (v3-only in Jira; mirrored in 040) |
| GET | `/api/internal/dashboards/{id}/data` | Aggregate refresh (TF ext) |
| GET | `/api/internal/dashboards/{id}/gadgets/{gadgetId}/data` | Per-gadget data (TF ext) |
| POST | `/api/internal/dashboards/{id}/share` | TF ext (Jira: share permissions) |

## Data model changes

- **Dashboard**: `id`, `ownerId`, `name`, `description?`, `layout Jsonb` (columns/gadget positions), `sharedScope`, `sharedTarget?`, `isSystemDefault?`.
- **DashboardGadget**: `id`, `dashboardId`, `type`, `config Jsonb`, `position`.
- **UserPreference**: `defaultDashboardId` (or on User).

## MCP tools added

`list_dashboards`, `get_dashboard` (renders to text summary — gadget states), `create_gadget`,
`update_dashboard`, `share_dashboard`, `get_dashboard_data` (agent snapshot of a board).

## AI-native checklist

- [ ] Agents can enumerate gadget types and required configs via a registry endpoint (A3).
- [ ] `get_dashboard_data` gives agents the same view users get — no UI-only insights (A1).
- [ ] Config validation errors name the bad field (A8).

## Success criteria

- **SC-001**: Build → share → view-as-other-user → gadgets render correct per-viewer data.
- **SC-002**: All ten core gadgets render live data; empty states handled.
- **SC-003**: Chart kit reused by at least one 027 report (code-shared, not forked).
- **SC-004**: Agent eval: "what's on my dashboard" returns an accurate gadget-by-gadget summary.

## Risks

| Risk | Mitigation |
|---|---|
| Gadget-type explosion → framework bloat | Type registry + config schema per gadget; only listed types ship |
| Per-viewer permission on shared gadgets is subtle | Gadget queries run **as the viewer**, never as the owner (documented divergence from Jira's owner-context quirk — more correct) |
| Refresh storms | Aggregate data endpoint + per-gadget interval caps |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Top-nav "Dashboards" stub replaced by working menu.
- [ ] `compat.ts` gains the dashboard family (documented subset).

## Implementation status

**Slice 1 — schema + Jira-shaped CRUD + registry + first resolvers (shipped)**

- `Dashboard` / `DashboardGadget` / `DashboardPermission` models + migration `20261113000000_026_dashboards`.
- Jira surface: `GET/POST /rest/api/2/dashboard`, `GET/PUT/DELETE /{id}`, `POST /{id}/copy` (private-to-copier), `GET /search` (dashboardName/owner + pagination), `GET /gadgets` (type registry), `POST/PUT/DELETE /{id}/gadget[/{gid}]`.
- TF extensions: `GET /api/internal/dashboards/{id}/data` (aggregate — one call, per-gadget error cards) + `/gadgets/{gid}/data`.
- Share semantics: kinds `view`/`edit` × types `global|loggedin|group|project|project-role|user`; delete = owner/admin; invisible dashboards 404 (existence-hiding, consistent with issues).
- Gadget registry ships 8 resolvers — assigned-to-me, filter-results, recently-updated, watched-issues, pie-chart, two-dimensional, created-vs-resolved, sprint-health. All run **as the viewer** via `executeSearch`/service paths (FR-001/FR-002); per-gadget cap 500 issues with honest `truncated` flags; bad config resolves to an error card, never a 500.
- `dashboards.test.ts` 6/6; OpenAPI + compat (+2 partial, +1 native).
- Notes: JQL `resolution = EMPTY` unsupported → `Unresolved` literal used (Jira-equivalent). Default share on create = `loggedin`; copies start private.

**Slice 2 — remaining resolvers + MCP tools (shipped)**

- 3 more registry entries: `burndown-chart` + `velocity-chart` (delegating to `getBurndown`/`getVelocity` from sprint-013 `reportService`), `activity-stream` (DomainEvent feed scoped like `/api/internal/events` — token allow-list ∩ requested project).
- MCP tools: `list_dashboards`, `get_dashboard`, `get_dashboard_data` (read); `update_dashboard` (create/update/delete), `share_dashboard`, `create_gadget` (add/update/remove) — writes gated by the standard `write` flag.
- 11 gadget types total. `dashboards.test.ts` 7/7.

**Slice 3 — dashboard UI (shipped)**

- `DashboardsPage` at `/dashboards[/:id]`: left-rail picker + create dialog; header actions (1–3 column layout toggle, Add gadget, Copy, Delete); column grid of gadget cards.
- Per-type renderers (no chart lib — CSS/SVG): issue lists for assigned-to-me/filter-results/recently-updated/watched-issues; horizontal bars for pie-chart; x×y table for two-dimensional; day-pair columns for created-vs-resolved; stacked progress bar for sprint-health; SVG polyline for burndown; paired bars for velocity; event list for activity-stream; error-card states.
- Gadget config forms are registry-driven (`configFields` → inputs; `jql` type uses `JqlEditor`).
- TopNav: "Dashboards" stub replaced by a working dropdown (up to 8 dashboards + Manage dashboards); routes registered in `App.tsx`.
- Aggregate endpoint feeds the whole grid — one `/data` call per dashboard, 60s refetch.
- Frontend typecheck + `vite build` clean.

**Remaining:** drag-and-drop repositioning (position/column updates exist in the API but UI only appends), share/edit-permission dialog UI, favourite/starred dashboards, SC-003 chart-kit extraction with 027.

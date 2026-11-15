# Sprint 033 — Boards & Navigator Polish

| | |
|---|---|
| **Status** | **Done** — 2026-11-16. Schema/API/UI/MCP/tests all landed (`557604a`, `afff39a`, `0ed3c94`, `cca4590`, `c786624`, `54277bc`); see *Implemented* notes. |
| **Milestone** | M4 Configurability & power |
| **Theme** | Jira parity — the last mile of the two most-used views |
| **Depends on** | 009 (persisted boards — **already N:1 per project**, FR-007), 010 (column chooser, saved filters), 013 (scrum boards), 014 (CFs for swimlanes/columns), 015 (board permissions), 018/022 (attachment/flag/vote indicators), 023 (bulk bar), 032 (quick-filter JQL vocabulary) |
| **Unblocks** | Near-full Jira UI parity on the daily-driver surfaces |
| **Spec-kit folder** | `specs/033-boards-navigator-polish/` |

> **Replan corrections (2026-11-07, verified against Jira Software Cloud REST):** (1) ~~No schema
> migration needed — 009 FR-007 made boards N:1 with `isDefault`~~ **stale**: `projectId @unique`
> was still present at implementation time — migration `20261116040000_033_multi_board` dropped it
> and added `isDefault`/`filterId`/`cardConfig`/`createdBy`/`BoardQuickFilter`. (2) Jira creates
> boards with `POST /rest/agile/1.0/board {name, type, filterId, location:{type:"project",
> projectKeyOrId}}` and deletes with `DELETE /board/{boardId}`; there is **no Jira `PUT /board`** —
> renames/settings are native (`/api/internal/boards/{id}`). A board's filter is a saved filter
> (010), so board sharing follows filter sharing (032). (3) Quick filters are read-only in Jira
> (`GET /board/{boardId}/quickfilter[/{id}]`); writes are native. (4) The column chooser exists
> since 010 — this sprint adds CF columns, group-by, subtask nesting and quick toggles.
> (5) "Starred" toggle removed (not Jira) → "Watching" toggle.

## Goal

After 023 sprints the two daily surfaces still have Jira-shaped gaps. This sprint closes
them in one UI-focused pass:

- **Multiple boards per project** (Jira allows N; our schema forced 1:1) — plus board
  switcher + "create board" flow (name, type, JQL filter).
- **Board quick filters** — JQL snippets that toggle (e.g. "Only bugs", "Only mine",
  "Recently updated") — a signature Jira board feature.
- **Card options**: card colors (by priority/status/type), "days in column" dots,
  statistics footer, card indicator counts (comments/attachments/links/flag per §8.7),
  board "hide done" toggle.
- **Swimlane criteria** expansion: priority, labels, version, CF single-select (014) —
  beyond 009's assignee/epic.
- **Navigator**: column chooser (incl. CF columns), group-by, subtask expand toggle,
  "Only my issues / Recently updated / Watching" quick toggles, print view (023 export),
  saved-view per filter.
- **Issue picker** component (Jira `/issue/picker` endpoint + UI widget) reused by link,
  epic-link, move dialogs.

## Why now

Each piece is small and surface-level, but they're the difference between "Jira-like" and
"Jira". They all need the underlying systems (CFs, flags, JQL functions, multi-board schema
change) that only now exist — which is why they couldn't have landed earlier.

## Scope

**In**: multi-board **CRUD + UI** (schema already N:1 — 009 FR-007): `POST/DELETE /rest/agile/1.0/board`
subset + `/api/internal/boards`); board switcher in sidebar + board-aware routes
(`/projects/{key}/board/{boardId?}`); quick filters (`BoardQuickFilter` rows: name+jql,
editable on board settings, chips over the board); card config (colors by rule, days-in-column,
statistics, indicator counts); swimlane criteria: none|assignee|epic|priority|label|version|
CF-select; navigator column chooser (persist per user/filter) + group-by + subtask toggle +
quick toggles + saved views; `/rest/api/2/issue/picker` + shared picker component;
"hide done" board toggle (statusCategory=done filtered client-side, persisted per user).

**Out**: card layout field-picker beyond the fixed indicator set (defer — CF-card-fields
is a rabbit hole), cross-project boards (still Out — needs row-level board filters done
right; revisit post-015 adoption), Kanban backlog column (Jira's kanban-backlog feature —
stretch), board "estimate" statistics beyond point totals.

---

## User stories

### US1 — Multiple boards (P1)

As a team, I want separate boards per squad/view inside one project.

**Independent test**: create "Team A" and "Team B" boards on TF with different filters;
each shows its slice; switcher navigates.

**Acceptance scenarios**

1. **Given** boards are N:1 per project (009 FR-007), **When** `POST /rest/agile/1.0/board {name, type, filterId, location:{type:"project", projectKeyOrId}}` runs (Jira create shape), **Then** a second board exists; `GET /board?projectKeyOrId=` lists all; legacy project-key lookups still resolve to the *default* board (back-compat).
2. **Given** board settings, **When** the filter edits, **Then** membership re-evaluates through JQL (010/032); columns/statuses per board independent.
3. **Given** sidebar, **When** a project has N boards, **Then** board switcher lists them; last-used board remembered per user.

### US2 — Quick filters & swimlanes (P1)

As a user, I want instant focus filters and more lane options.

**Acceptance scenarios**

1. **Given** board settings → Quick filters, **When** `{name:"Only mine", jql:"assignee = currentUser()"}`, **Then** chips render over the board; toggling composes with the board filter (AND) and URL state shares the view.
2. **Given** swimlane setting, **When** set to priority/label/version/CF-select, **Then** cards group into lanes with collapse-all (Jira behavior); CF lanes list options from the field's context.

### US3 — Card options (P2)

**Acceptance scenarios**

1. Card colors by priority/status/type rules (§8.1); "days in column" via changelog (dots 1-4+); statistics footer (issue count + points per column — Jira's column totals); indicator icons for comments/attachments/links/flagged per §8.7.
2. "Hide completed" toggle filters done-category cards client-side, persisted per user per board.

### US4 — Navigator finish (P1)

**Acceptance scenarios**

1. **Column chooser**: add/remove/reorder columns incl. CFs (014) + `watches`/`votes`/`worklog` fields; per-user persistence + filter-saved layouts.
2. **Group by** (status/assignee/epic/priority/component/version): rows group with counts; ordering inside groups preserved.
3. **Subtask toggle**: flat vs nested display (indent subtasks under parents).
4. **Quick toggles**: Only-my-issues / Recently-updated / Watching / Flagged chips over the navigator.
5. **Issue picker**: `GET /issue/picker?query=` returns matching issues (key + summary + type icon); shared component used by link/move/parent dialogs.

---

## Edge cases

- Board with no matching issues → onboarding empty state.
- Quick-filter JQL errors → chip shows warning, doesn't break the board.
- Group-by on huge sets → group pagination.
- Deleting the *default* board → requires picking a new default (project always has ≥1).
- Board filter edited to exclude an open sprint → sprint-scoped scrum board still wins (documented precedence).

## Functional requirements

- **FR-001**: Board membership MUST derive from board JQL filter + project — never a stored list (single source of truth).
- **FR-002**: Legacy board lookups (project key as board id) MUST keep working — 003/004 contract preserved.
- **FR-003**: Quick filters MUST compose (`AND`) with board filter + sprint scope, never replace it.
- **FR-004**: Column layout MUST persist per user+filter server-side (VI — agents share user state).
- **FR-005**: Group-by/quick-toggles MUST be JQL-equivalent — results identical to hand-written JQL.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST/PUT/DELETE | `/rest/agile/1.0/board` subset + `/api/internal/boards` | Multi-board CRUD |
| GET | `/rest/agile/1.0/board/{id}/quickfilter` · `/{qfId}` | Jira (read-only in Jira) |
| POST/PUT/DELETE | `/api/internal/boards/{id}/quickfilters` | Writes — TF ext (Jira has no public write API) |
| GET/PUT | `/api/internal/boards/{id}/cardconfig` | Colors/indicators/stats |
| GET | `/rest/api/2/issue/picker?query=` | Jira picker |
| GET/PUT | `/api/internal/me/views/{context}` | Per-user column/group prefs |

## Data model changes

- **Board**: add `filterId`, `cardConfig Jsonb`, `createdBy` (projectId already non-unique with `isDefault` — 009 FR-007).
- **BoardQuickFilter**: `boardId`, `name`, `jql`, `position`.
- **UserViewPreference**: `userId`, `context` (navigator|filterId), `layout Jsonb`.

## MCP tools added

`manage_board`, `list_boards`, `get_board` (gains quick filters/card config), `manage_quick_filters`,
`pick_issue` (picker results for agents building dialogs/links), `update_issue` gains nothing
new — board ops ride existing move/rank tools.

## AI-native checklist

- [ ] Board config fully API-readable/writable (A1).
- [ ] Quick-filter JQL validated server-side on save — no silent broken chips (A8).
- [ ] `list_boards` exposes default + filters so agents pick the right board (A3).

## Success criteria

- **SC-001**: Two boards per project coexist, independent filters+columns; legacy deep links work.
- **SC-002**: Quick filter + swimlane + card colors + hide-done compose without state bugs.
- **SC-003**: Navigator: group-by + column chooser + subtasks + quick toggles all persist per user.
- **SC-004**: Agent eval: "create a board showing only TF bugs" → board exists, filter correct.

## Risks

| Risk | Mitigation |
|---|---|
| Multi-board touches every board call site | Migration keeps `isDefault` board = the old 1:1 board; aliases preserved; compat suite |
| Card-config sprawl | Fixed indicator set only this sprint |
| Group-by + JQL interplay edge cases | Toggles documented as JQL-rewrites, not post-filters |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Migration: existing boards become `isDefault` on their project; zero broken routes.
- [ ] compat.ts: board/multi-board + quickfilter + picker endpoints marked.

---

## Implemented (2026-11-16)

- **US1 multi-board** — migration `20261116040000_033_multi_board` (the replan note was stale:
  `projectId @unique` still existed; dropped as index, `isDefault`/`filterId`/`cardConfig`/
  `createdBy`/`BoardQuickFilter` added, earliest board per project marked default).
  `POST/DELETE /rest/agile/1.0/board` (Jira shape incl. `?promoteTo=` for default-delete);
  `PUT /api/internal/boards/{id}` (rename/filter), `POST .../default`. Legacy project-key
  lookups resolve the default board (FR-002). `listBoardIssues`/`listBacklog` compose
  project + board JQL (saved filter or direct `filter` text) + quick filters + sprint +
  visibility (FR-001/FR-003). Switcher + create-board modal on BoardPage; `?board=<id>`
  deep links; BoardSettingsPage is board-aware.
- **US2 quick filters & swimlanes** — `BoardQuickFilter` rows + Jira read routes
  (`GET /board/{id}/quickfilter[/{qfId}]`) + internal writes; JQL validated on save (A8);
  chips AND-compose onto the board query; settings editor. Swimlanes none|assignee|
  priority|epic|subtasks with collapse toggles (label/version/CF-select deferred —
  needs option-source plumbing for CF lanes).
- **US3 card options** — `Issue.statusChangedAt` denorm (backfilled; maintained on
  create/transition/move/clone) → days-in-column dots (1–4+); `_count` aggregates feed
  comment/attachment/link indicator counts; `fields.flagged` alias key; card-color edge
  rules (`field:value`, first match); per-column story-point totals; hide-done per-user
  toggle (`boardview.{boardId}` pref). CardConfigSection editor in board settings.
- **US4 navigator** — quick toggles (`?qt=`: mine/recent/watching/flagged, JQL-composed
  — FR-005), group-by (status/assignee/priority/issuetype/epic), subtask nesting
  (indent under parent), all persisted via `issueTable.*` prefs; column chooser +
  print view already existed (010/023). `GET /rest/api/2/issue/picker` + shared
  `IssuePicker` combobox (wired into the link dialog).
- **MCP** — `list_boards`, `get_board` (config+quickfilters), `manage_board`
  (create/update/set_default/delete/set_card_config), `manage_quick_filters`,
  `pick_issue`. SC-004 flow: `manage_board create` + `filter_jql`.
- **Tests** — `boardsMulti.test.ts` 9/9 (coexistence, default-alias, independent filters,
  QF composition+JQL validation, delete guard, cardconfig round-trip, picker);
  board 6/6 + sprint 7/7 + agilePerms 2/2 + issues 6/6 + leak 7/7 regressions green.

## Deferred / notes

- Swimlane criteria **label/version/CF-select** — lane values need option sources
  (CF options per context); the `cardConfig.swimlaneBy` enum accepts only the
  implemented set.
- Per-filter column layouts (FR-004 is satisfied per-user globally; Jira saves
  layouts per filter — follow-up).
- Group-by is page-scoped (Jira parity — it groups the visible page).
- `fields.comment.total`/`issuelinkCount`/`attachmentCount`/`statuschangedate` are
  additive response fields (Jira-shaped where Jira has a counterpart).
- `attachment` array stays empty on board issues — `attachmentCount` is the count.

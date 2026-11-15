# Sprint 062 — Backlog & Settings QA Sweep: Truthful Payloads, Validation, Picker Restraint

| | |
|---|---|
| **Status** | Planned |
| **Milestone** | Post-GA (hardening-flavored follow-up, same wave as 061) |
| **Theme** | Close the gaps a page-by-page QA of backlog + board settings + project settings found: the epic rail is dead code (agile payloads omit `parent`), sprint rows drop assignees, WIP limits accept inverted values, and pickers collapse at imported-data scale — all while *removing* ambiguity rather than adding UI |
| **Depends on** | 033 (multi-board + card config), 054 (board/backlog correctness), 058 (better-than-Jira UX), 052 (copilot trust), 060 (admin parity), 031 (schemes) |
| **Unblocks** | A working epic rail (UB-013 features exist but are invisible); trustworthy sprint rows; honest validation; pickers that survive Jira imports |
| **Spec-kit folder** | `specs/062-backlog-settings-qa/` |

> **Origin**: page-by-page user-perspective QA of the backlog page, board
> settings, and project settings on a populated instance (TF scrum board,
> 166-issue backlog, 413 workflows, ~115 issue types), cross-checked against
> live API responses and service-layer code. Result: the scrum loop is
> genuinely solid — lifecycle, bulk ops, context menu, drawers, destructive
> confirms all work. The failures are concentrated in two places: **list
> payloads that silently drop fields the UI depends on**, and **pickers/forms
> that assume demo-scale data**.
>
> **Governing principle — no saturation**: this sprint adds **zero new pages,
> zero new nav items, zero new persistent UI rows**. The dominant move is
> making existing UI truthful. Where a fix would add chrome, prefer unifying
> what exists (one "quick filters" concept, not two) or filtering what is
> already shown (bounded pickers) over inventing a control.

## Goal

- **The epic rail works or it doesn't ship**: child counts, click-to-filter, and row epic pills all depend on `fields.parent` — which agile list endpoints never return. Either populate it or delete the rail.
- **Sprint sections show the same truth as backlog rows**: `fields.assignee` must reach `/sprint/{id}/issue`.
- **Settings validate what they accept**: WIP min ≤ max and non-empty column names, enforced client + server side.
- **Pickers stay usable at migrated scale**: workflow switcher filters empty imports; issue-type inline create is scoped; lead pickers don't list every eval agent ever seeded.
- **One meaning per label**: "Quick filters" means board-configured JQL chips everywhere it appears — the backlog's local status pills either become that feature or get renamed.
- **Console stays clean**: no `useQuery` without `queryFn`; no guaranteed-400 fetches on kanban boards.

## Scope

**In**: `parent`/`assignee` in the two slim `issueInclude`s (`boardService`, `sprintService`); WIP/column-name validation client + server; filtered-count display in the backlog section header; epic filter extended to sprint sections; board quick-filter chips applied to the backlog query (the route already accepts `quickFilterIds`) **replacing** the local pills row — one concept, one row; workflow picker filtered to non-empty workflows (opt-in "show all"); inline-create issue types scoped to the project's issue-type scheme; "Move to backlog" context item for sprint issues; quick-filter delete confirm; kanban-backlog fetch gating; `ai-progress` `queryFn` fix; type-switch upfront hint when open sprints exist.

**Out — explicitly, to protect against saturation**: column drag-reorder UI; a backlog board picker (latent multi-board gap — revisit when a second board type exists on a real project); new settings pages/sections; per-viewer saved filters; epic rail redesign; a *second* chip row on the backlog toolbar (unify, don't duplicate); workflow-scheme vs workflow-section merge (document the distinction instead); role-directory cleanup tooling (data problem); suggest-scope reason quality beyond a one-line honest fallback ("heuristic grouping" label).

## Candidate user stories

### US1 — Truthful agile payloads (P1 — the epic rail fix)

As a planner, I want the epic rail and row badges to reflect reality.

1. **Given** an issue with a parent epic in the backlog, **When**
   `GET /rest/agile/1.0/board/{id}/backlog` returns, **Then** every issue
   carries `fields.parent` — add `parent` to `boardService.issueInclude`
   (and verify `children`/`epicLink` equivalents if the epic-pill needs
   them).
2. **Given** `GET /rest/agile/1.0/sprint/{id}/issue`, **Then** issues carry
   `fields.parent` **and** `fields.assignee` — extend
   `sprintService.issueInclude` (verified missing today: assigned issues
   render "Unassigned" in sprint sections).
3. **Given** the payloads fixed, **Then** existing UI works unmodified:
   epic rail child counts show real numbers (verified: TF-110 shows 0
   despite child TF-172), epic click-to-filter shows children instead of
   "No issues match", row epic pills render.
4. **Given** `/board/{id}/issue` (Board page), **Then** `fields.parent`
   is present too — board cards share the include and gain the epic
   badge the card config already supports.
5. **Given** an epic filter is active, **Then** it applies to **all**
   visible sections (sprints + backlog) — today it silently filters only
   the backlog group while sprint rows stay put.

### US2 — Validation that refuses invalid config (P1)

As a board admin, I want impossible settings rejected at input time.

1. **Given** a column draft with `min > max` (verified: Min 10 / Max 5
   saves cleanly today), **Then** the client flags it inline and
   `updateBoardConfiguration` returns `errors['columns[i].max']` —
   "Max must be ≥ Min" — per the error-shape invariant.
2. **Given** an empty column name, **Then** same treatment — both layers.
3. **Given** the type-switch with open sprints, **Then** the Kanban
   button shows *why* before the click (tooltip/disabled state with the
   constraint text) instead of failing after the fact — the 400 message
   already exists, surface it earlier.

### US3 — One meaning for "Quick filters" (P2 — unify, don't add)

As a board user, I want the label to mean one thing on every page.

1. **Given** board-configured JQL quick filters, **Then** they render as
   chips on the backlog toolbar (same component/styling as the Board
   page) and are passed as `quickFilterIds` to the backlog query —
   `GET /board/{id}/backlog` already accepts the param; this is frontend
   wiring, not a new endpoint.
2. **Given** the local status pills (All/Open/In progress/Done), **Then**
   they merge into the same row as board chips (status pills are a subset
   of what JQL chips express) or are relabelled to something that isn't
   "Quick filters" — decide in plan; the outcome is one labelled row, not
   two stacked rows.
3. **Given** a filtered view, **Then** the section header reads
   "N of 167 issues" (filtered of total) instead of the unfiltered total
   next to an empty list — verified contradictory today.
4. **Given** deleting a quick filter, **Then** a `ConfirmDialog` names
   the filter before DELETE fires — matching the destructive consistency
   established in 061 US2.

### US4 — Pickers that survive imported scale (P2 — restraint, not chrome)

As an admin on a migrated instance, I want selection lists bounded to
meaningful choices.

1. **Given** the Switch-workflow select (verified: 413 options, 411 with
   0 statuses), **Then** it lists only workflows with ≥1 status, with a
   "show all N workflows" expander for edge cases — picking an empty
   workflow today dead-ends on an un-mappable status remap with no
   explanation.
2. **Given** the inline-create type dropdown (verified: ~115 global
   types incl. " HCS", "Pangea", "Subtarea-Ejecución"), **Then** options
   come from the project's issue-type scheme (or a standard-issue
   subset) — the type selector exists; only its *source* changes.
3. **Given** the project-lead picker (verified: ~40 entries incl. ~15
   eval-agent accounts), **Then** agents/service accounts are grouped
   after humans or the picker gains the existing `UserPicker` typeahead
   — reuse the component, don't restyle.
4. **Given** "Suggest scope" results, **Then** reasons read honestly —
   the templated "Supports a focused bulk-2 workstream" on all 20 picks
   gets either real per-issue reasoning or a plain "heuristic grouping"
   label (052 trust goal: fake specificity is worse than honest generic).

### US5 — Friction removal batch (P3 — independent diffs)

As a user, I want controls to do what their shape promises.

- **Context menu**: add "Move to backlog" for sprint-section issues
  (today only "Send to top/bottom of backlog" exists — the action is
  there, the expected label isn't).
- **Sprint "⋯"**: rename title/affordance or convert to the menu it
  impersonates (Edit/Delete are already inside the dialog).
- **Kanban backlog**: gate the backlog query on `board.type === 'scrum'`
  — the page currently fires a guaranteed 400 on every mount (console
  noise on top of the correct banner).
- **`ai-progress` console spam**: `CommandPalette.tsx` `useQuery` without
  `queryFn` throws in TanStack v5 even with `enabled: false` — add
  `queryFn: () => Promise.resolve(null)` or `skipToken`.
- **Sprint numbering**: document (tooltip or copy) that auto-names count
  closed sprints — "Sprint 15" after "Sprint 11" reads as a bug.
- **Board settings save semantics**: pick one — either card-layout/
  schemes get a Save bar like Columns, or Columns gains auto-save;
  document the choice. (No new chrome either way.)

## Non-functional requirements

- **FR-001**: Payload additions stay within `issueInclude` patterns — no
  per-request field negotiation; verify sprint/backlog payloads keep
  Jira v2/agile shapes (the fields are Jira-standard, inclusion is the
  parity fix).
- **FR-002**: Validation errors use `{errorMessages, errors:{field:msg}}`
  with the offending column index — agents must be able to self-correct.
- **FR-003**: No new dependencies; no new routes except *none expected* —
  the backlog `quickFilterIds` param already exists, validation lives in
  `updateBoardConfiguration`, pickers reuse `UserPicker`/scheme data.
- **FR-004**: Every fix ships with the regression the QA found encoded
  as a test — backlog payload includes `fields.parent` (integration),
  sprint issues include `assignee`, min>max 400s, workflow picker hides
  empty workflows (component/unit).
- **FR-005**: `pnpm typecheck && pnpm lint` at zero warnings; no new
  console errors on backlog/board/settings pages (assert via existing
  playwright a11y harness pattern).
- **FR-006**: **The saturation budget** — net new interactive elements
  on the three audited pages: ≤ 1 ("Move to backlog" ctx item). Every
  other change is correction, unification, or subtraction.

## API surface (candidates)

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/agile/1.0/board/{id}/backlog` | `fields.parent` now populated (US1) |
| GET | `/rest/agile/1.0/sprint/{id}/issue` | `fields.parent` + `fields.assignee` (US1) |
| GET | `/rest/agile/1.0/board/{id}/issue` | `fields.parent` (US1) |
| GET | `/rest/agile/1.0/board/{id}/backlog?quickFilterIds=` | Param exists — frontend consumes it (US3) |
| PUT | `/board/{id}/configuration` (agile) | New validation errors: min>max, empty name (US2) |
| GET | `/rest/agile/1.0/board/{id}/quickfilter` | Exists — backlog page consumes (US3) |

No new endpoints. This sprint is intentionally light on API surface —
the backends are right; the payloads and wiring are wrong.

## Success criteria

- **SC-001**: Epic rail shows real child counts (TF-110 → 1), epic filter
  lists children (TF-110 → TF-172 visible), row epic pills render, and
  sprint rows show assignee avatars — all live-verifiable.
- **SC-002**: Min>max and empty-name column configs are rejected client-
  side and by API 400 with a field error.
- **SC-003**: Exactly one "quick filters" row exists on the backlog; board
  JQL chips filter its contents; header shows "N of M issues" under filter.
- **SC-004**: Workflow picker defaults to ≤ a screenful of valid options;
  inline-create types ≤ the project's scheme size; no picker lists eval
  agents as primary options.
- **SC-005**: Zero `No queryFn` errors and zero kanban-backlog 400s in a
  console walk of all three pages.
- **SC-006**: Diffstat shows the sprint's net addition to the three pages
  is removal-or-rename outside the single new context-menu item (FR-006).

## Risks

| Risk | Mitigation |
|---|---|
| `parent` include fans out queries (N+1 on 166-row pages) | `issueInclude` is a single `include`, not a per-row fetch — Prisma batches it; measure payload size on the perf suite before/after |
| Quick-filter unification removes status pills users like | Keep the four pills as built-in chips rendered identically — one row, both chip kinds |
| Filtering empty workflows hides one an admin legitimately wants | "Show all" expander preserves reach; count label makes the hiding honest |
| Issue-type scoping breaks create on projects without schemes | Fallback to the standard hierarchy (Epic/Story/Task/Bug + subtasks) when scheme is unset |
| `assignee` include raises sprint-issue payload size | It's one joined row per issue — the backlog include already pays it; parity is the point |

## Slice plan (each ships runnable)

1. US1 payload fix (backend include lines + integration tests) — unblocks everything
2. US2 validation (client + server, one PR)
3. US3 quick-filter unification + filtered counts (frontend-only)
4. US4 picker restraint (workflow/issue-type/lead + suggest-scope honesty)
5. US5 friction batch (independent diffs, land opportunistically)

## Implementation status

### Slice 1 — US1 truthful payloads (landed)

- `boardService.issueInclude` + `sprintService.issueInclude` now include
  `parent: { include: { project, issueType } }`; sprint include also gains
  `assignee`. Backlog/board/sprint payloads all carry `fields.parent` +
  `fields.assignee` — verified live: TF-172→TF-110, epic rail shows
  "1 issue" for TF-110, epic filter lists TF-172, sprint rows show the
  Eval Agent avatar (was "Unassigned").
- `epicFilter` folded into the shared `matches` predicate — applies to
  sprint sections too; epic `childCount` counts backlog + sprint issues.
- Integration test: `sprint.test.ts` "agile list payloads expose
  fields.parent and fields.assignee".

### Slice 2 — US2 validation (landed)

- `columnSchema` zod refine (`columns.N.max`) + service guard
  (`columns[i].max` / `columns[i].name` keyed errors) — min>max and blank
  names 400 server-side; client flags inline and disables Save.
- Type-switch: kanban button disabled with a tooltip naming the open
  sprint count when open sprints exist.
- Integration test: `board.test.ts` "rejects inverted WIP limits and
  blank column names".

### Slice 3 — US3 quick-filter unification (landed)

- Backlog query + sprint-issue queries now pass `activeQf`; board JQL
  chips render in the existing "Quick filters:" row after the status
  pills (one row, one meaning). `/sprint/{id}/issue` gained the same
  `quickFilterIds` param — `quickFilterWhere` exported from boardService.
- Header shows "N of M issues" under local filters; no-match empty state
  fires on server-side empty results too; Clear clears chips.
- Quick-filter delete uses `ConfirmDialog` (061 US2 convention).
- Verified live: chip JQL `statusCategory = Done` filtered 166→28 on the
  backlog and 3→0 on a sprint section.

### Slice 4 — US4 picker restraint (landed)

- Workflow switch select hides 0-status workflows behind a "Show all N
  workflows" expander (413 → usable subset).
- `GET /project/{key}` now returns Jira-parity `issueTypes` resolved from
  the project's `issueTypeScheme` (all types when unbound) — the
  inline-create picker consumes it instead of the ~115-entry global list.
- Project lead select partitions humans / Agents optgroup.
- Suggest-scope: prompt requires issue-specific reasons + dialog labelled
  "Heuristic grouping — review before moving."

### Slice 5 — US5 friction batch (landed)

- Ctx menu: "Move to backlog" for sprint-section issues (the one allowed
  new interactive element, FR-006).
- Sprint `⋯` → labelled "Edit" (title names the three actions).
- Backlog + sprint-issue queries gated on `board.type === 'scrum'` — no
  more guaranteed 400 on kanban boards.
- `ai-progress` cache-only query got `queryFn: () => Promise.resolve(null)`
  — console spam eliminated (verified: zero errors on page load).
- "Create sprint" tooltip explains instant create + closed-sprint
  numbering; Card layout header now says "saves automatically".

### Cross-cutting

- `pnpm`-equivalent `tsc --noEmit` clean both apps; ESLint clean on all
  touched files; 88 integration tests green (sprint/board/boardsMulti/
  projects/agent/scrum/sprint057/sprint058/search).
- Fixed pre-existing openapi drift for 061's new admin routes
  (`/admin/tokens`, `/audit/actions`, `/system/backups/{id}/restore`,
  `/system/restore-status`) — the drift gate is green again.

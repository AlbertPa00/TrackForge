# Sprint 054 — Board & Backlog Drag Correctness

| | |
|---|---|
| **Status** | Done |
| **Milestone** | Post-GA (audit wave) |
| **Theme** | Make drag-and-drop do what the gesture says — the two planning surfaces users touch all day |
| **Depends on** | 009 (boards), 033 (boards polish), 019 (sprints/backlog), 053 (safe base) |
| **Unblocks** | Trustworthy daily triage; 058's optimistic-UI wave builds on correct mutations |
| **Spec-kit folder** | `specs/054-board-backlog-correctness/` |

> **Origin**: deep audit of `BoardPage.tsx` / `BacklogPage.tsx`. Three gestures silently
> no-op or do the wrong thing: the bottom card can't move up, dropping a sprint issue on a
> backlog row only re-ranks it, and the backlog fires one request per *closed* sprint on
> mount.

## Goal

- **Every legal drop works**: any card can move to any position in any column — including
  the bottom card moving upward within its own column.
- **Cross-list drops are semantic**: dragging a sprint issue into the backlog *moves* it
  to the backlog, not just re-ranks it in place.
- **Sprints are reorderable**: drag reorder within a sprint works like the backlog's.
- **The backlog doesn't storm the API**: closed sprints are never fetched/rendered.

## Scope

**In**: `handleDrop` bottom-card guard; backlog row drop → `moveToBacklog` when the source
is a sprint; per-row drop handlers inside sprint groups; `useQueries` sprint fetch scoping
to rendered sprints only; Playwright regression coverage for all four.

**Out**: board redraw/virtualization (UB entry); optimistic UI (sprint 058); swimlane or
epic-panel redesign; sprint report changes.

## User stories

### US1 — Any card can reach any slot (P0)

As a board user, I want to drag the last card in a column upward.

1. **Given** a column with cards A(top)…Z(bottom), **When** I drag Z above B, **Then** `rankMutation` fires and Z lands between A and B — today `handleDrop` early-returns on `last?.key === issueKey` (`BoardPage.tsx` ~285–292), so the bottom card can never move within its column.
2. **Given** the keyboard DnD flow (Space → arrows → Enter), **When** the same reorder is attempted, **Then** it works identically (share the drop-path fix).
3. **Given** Z dragged to the *bottom* of another column, **When** dropped, **Then** it still appends correctly (guard removal must not break the real no-op case: drop where it already is).

### US2 — Sprint → backlog drop moves, not just re-ranks (P0)

As a planner, I want dragging a sprint issue onto a backlog row to remove it from the sprint.

1. **Given** issue in sprint S1, **When** I drop it on a row in the backlog section, **Then** `moveToBacklog` runs (remove sprint) *and* it lands at the dropped rank — today the row's `onDrop` only calls `rank.mutate` (`BacklogPage.tsx` ~662–716), leaving the issue in S1.
2. **Given** a multi-drag selection (023), **When** the same drop happens, **Then** all selected issues leave the sprint and order correctly.

### US3 — In-sprint drag reorder (P1)

As a planner, I want to reorder issues inside a sprint like Jira's backlog.

1. **Given** a sprint section, **When** I drag an issue between two sprint rows, **Then** a per-row drop handler calls `rankMutation` scoped to the sprint — today sprint rows have no drop handlers, so intra-sprint ordering is impossible.
2. **Given** a drop on the sprint's first row, **When** released, **Then** the issue ranks before it (consistent `before:` semantics with the backlog section).

### US4 — Backlog stops the closed-sprint N+1 (P1)

As a user on a mature project, I want the backlog to load in one round trip, not 1+N.

1. **Given** 40 closed sprints, **When** the backlog opens, **Then** zero `fetchSprintIssues` calls fire for closed sprints — today the query fan-out includes `state: 'closed'` results that aren't even rendered (`BacklogPage.tsx` ~258–274, ~718–720).
2. **Given** only active+future sprints fetch, **When** a sprint is started/completed, **Then** its issue list lazily loads on first render of that section.

## Non-functional requirements

- **FR-001**: Drop semantics live in one shared helper — board and backlog must not fork drop-position logic again.
- **FR-002**: Cross-section drops compose operations in the right order (move first, then rank against the destination list).

## Success criteria

- **SC-001**: Playwright: bottom card drags to second position in its column.
- **SC-002**: Playwright: sprint issue dropped on a backlog row leaves the sprint and holds rank after reload.
- **SC-003**: Playwright: issue reorders within a sprint via drag.
- **SC-004**: Network trace on backlog open shows no closed-sprint issue fetches.

## Risks

| Risk | Mitigation |
|---|---|
| Removing the `last?.key` guard regresses drop-on-self no-ops | Keep the position-equality check; drop the *identity* check |
| move+rank ordering races | Single mutation performing both server-side, or sequenced `mutateAsync` |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] All four Playwright regressions committed and green (`apps/frontend/tests/e2e/sprint054.spec.js`).
- [x] Keyboard DnD parity verified for every fixed gesture (037 a11y obligation).

## Implementation notes (landed)

Beyond the four planned fixes, e2e verification surfaced three deeper bugs that
were the *actual* root cause of the reported symptoms:

- **`handleDrop` sent both rank anchors.** `PUT /issue/rank` rejects
  `rankBeforeIssue` + `rankAfterIssue` together (400), so *every* mid-column drop
  failed — the `last?.key` guard was only the visible edge. `pos` now sends a
  single anchor (`rankBeforeIssue` on card drops, `rankAfterIssue` for the
  column-body append).
- **`GET /board/{boardId}/sprint` 404'd on UUIDs.** `sprints.ts` uppercased
  `boardId` before `resolveBoard` — fine for project keys, fatal for UUID board
  ids (Jira clients pass those).
- **`GET /sprint/{id}/issue` ordered by `issueNumber`, not `rank`.** Made
  in-sprint reordering unobservable even when the rank write succeeded. Now
  `[{ rank: 'asc' }, { issueNumber: 'asc' }]` like the backlog/board endpoints.

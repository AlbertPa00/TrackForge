# Plan — Sprint 013: Scrum Completion

## Architecture

```
┌────────────────────────── apps/backend ──────────────────────────┐
│  prisma/schema  Sprint.boardId/completeDate/sequence,             │
│                 IssueSprint history, Issue.storyPoints            │
│  services/sprintService   board-scoped CRUD, one-active-sprint,   │
│                 membership stamps, carry-over on close            │
│  services/boardService    scrum↔kanban semantics, listBacklog,    │
│                 type change guard                                 │
│  services/epicService     epic GET/issue ops via parentId         │
│  services/reportService   velocity + burndown from IssueSprint    │
│                 intervals + changelog items                       │
│  jql/fields + compiler    storypoints, sprint, openSprints(),     │
│                 closedSprints(), ORDER BY storypoints             │
│  routes/sprints.ts  agile surface incl. epics + agile issue GET   │
│  routes/reports.ts /api/internal/reports/*                        │
└───────────────────────────────────────────────────────────────────┘
┌──────────── apps/frontend ────────────┐  ┌──────── apps/mcp ────────┐
│ BacklogPage  ranked groups, drag,     │  │ scrum tools: backlog,    │
│   multi-select, points chip, inline   │  │ sprints, rank, estimate, │
│   create, start/complete/edit dialogs │  │ epic, reports, AI scope  │
│ BoardPage    scrum header + complete  │  └──────────────────────────┘
│   sprint, empty state                 │
│ Sidebar gated Backlog/Reports,        │
│ ReportsPage (velocity/burndown),      │
│ board-type setting                    │
└───────────────────────────────────────┘
```

## Key decisions

- **Sprints belong to boards**, not projects. The migration creates boards for
  sprint-owning projects that lack one, backfills `boardId`, assigns
  per-board `sequence` via `ROW_NUMBER()`, flips boards with sprint history
  to `scrum`, and seeds `IssueSprint` from `Issue.sprintId`.
- **`IssueSprint` is the source of truth for history** — `Issue.sprintId`
  remains the current membership. Reports reconstruct committed points at
  sprint close from open intervals (`addedAt`/`removedAt`) and completion from
  `story_points`/`status` changelog items, so 004-era sprints without intervals
  fall back to current membership.
- **Completed issues stay in the closed sprint**; only carried-over issues get
  `removedAt`. Velocity commitment boundary uses `<=` so issues removed at the
  exact close instant still count.
- **Board type is explicit** and guarded: switching scrum→kanban is blocked
  while an active sprint exists; kanban boards never scope to sprints.
- **`GET /rest/agile/1.0/issue/{key}`** shares the `/rest/api/2/issue` response
  shape; `/sprint/{id}/start|close` from DESIGN §18.3 are intentionally not
  built (not real Jira endpoints — state update covers both).
- **AI scope suggestions are advisory** — the endpoint only reads; applying
  scope is always a human action in the backlog UI (A7 checklist).

## Post-mortems

- `closedSprints()` → empty result compiled to `sprintId IS NULL`, matching all
  unsprinted issues — empty resolved function results now compile to
  always-false.
- Burndown emitted no bucket at the close instant for sub-day sprints — the
  last sample predated Done transitions; a terminal bucket was added.
- Backlog drag/rank reuse surfaced a rank-index bug in seed (`ranks[n-1]`
  evaluated pre-increment → duplicate ranks); fixed to `ranks[n]`.

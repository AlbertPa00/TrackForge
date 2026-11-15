# Implementation Plan: Kanban Board View

**Branch**: `003-kanban-board` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

## Summary

Add Jira's signature board: a per-project kanban view with status-derived columns, Jira-faithful card/column styling, and HTML5 drag-and-drop that drives the existing transitions endpoint. Backend exposes Jira Agile-compatible read endpoints (`/rest/agile/1.0/board*`) backed by a virtual (non-persisted) board per project. Zero new dependencies.

## Technical Context

- Stack unchanged: React+Vite+Tailwind+TanStack Query; Express+Prisma+SQLite.
- **No schema changes, no new dependencies.** DnD via native HTML5 API (`draggable`, `dragover`, `drop`) — justifiable under Explicit Simplicity: single-direction column moves don't need `@dnd-kit` until rank/swimlanes arrive (documented decision).
- Board is virtual: `id` = project key, columns = statuses 1:1. Persisted boards come with the real workflow engine phase.

## Constitution Check

- [x] Sprint-First: shippable board slice — view, drag, transition, persist.
- [x] API-First: Jira Agile-shaped endpoints before UI; UI consumes them verbatim.
- [x] Test-First: integration tests for all three endpoints before/alongside UI.
- [x] Jira Compatibility: `/rest/agile/1.0/*` paths, `columnConfig` shape, documented `boardId=projectKey` divergence.
- [x] Explicit Simplicity: no board persistence, no dnd lib, no swimlanes.

## Structure

```text
apps/backend/src/
├── routes/boards.ts        # NEW: /rest/agile/1.0/board endpoints
└── services/boardService.ts # NEW: virtual board + columnConfig + issues

apps/frontend/src/
├── api/client.ts            # + fetchBoard, fetchBoardConfiguration, fetchBoardIssues
├── components/
│   ├── BoardColumn.tsx      # NEW: column + drop target
│   └── BoardCard.tsx        # NEW: draggable card
├── pages/BoardPage.tsx      # NEW
└── ProjectSidebar.tsx       # Board link enabled
apps/backend/tests/integration/board.test.ts  # NEW
```

## Route Map

| Path | Page |
|---|---|
| `/projects/:key/board` | Kanban board |
| `/projects/:key` | List (unchanged) |

## Data Flow

1. `GET /board?projectKeyOrId=K` → board descriptor (`id`, `name`, `type: 'kanban'`)
2. `GET /board/K/configuration` → `columnConfig.columns[]` (name + mapped status w/ category)
3. `GET /board/K/issue?maxResults=200` → all project issues (Jira issue shape)
4. UI groups issues by `status.id` into columns.
5. Drop on column `status.id` → `POST /issue/:key/transitions {transition:{id: statusId}}` → invalidate board query.

## Complexity Tracking

| Decision | Why | Revisit when |
|---|---|---|
| Native HTML5 DnD | Zero deps, sufficient for column moves | Rank, swimlanes, touch |
| Virtual board | Statuses already model columns 1:1 | Custom column config, multiple boards |

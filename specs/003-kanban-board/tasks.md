# Tasks: Kanban Board View

**Input**: Design documents from `/specs/003-kanban-board/`

## Phase 1: Backend — Agile Board Endpoints

- [x] T001 Create `src/services/boardService.ts` — `getBoard(projectKey)`, `getBoardConfiguration(projectKey)`, `listBoardIssues(projectKey, page)`
- [x] T002 Create `src/routes/boards.ts` — `GET /board?projectKeyOrId`, `GET /board/:id/configuration`, `GET /board/:id/issue`; wire into `main.ts` at `/rest/agile/1.0`
- [x] T003 [P] Integration tests `tests/integration/board.test.ts` (board lookup, config columns 1:1 with statuses, issue page, 404s)

## Phase 2: Frontend — Board View

- [x] T004 `api/client.ts` — Board types + `fetchBoard`, `fetchBoardConfiguration`, `fetchBoardIssues`
- [x] T005 [P] `components/BoardCard.tsx` — draggable card (type icon, summary, key, priority icon, avatar)
- [x] T006 [P] `components/BoardColumn.tsx` — column surface, header + count, drop target w/ highlight
- [x] T007 `pages/BoardPage.tsx` — compose columns, group issues by status id, HTML5 DnD → transitions mutation + invalidation + error banner
- [x] T008 `ProjectSidebar.tsx` — enable Board link; `App.tsx` — route `/projects/:key/board`

## Phase 3: Polish

- [x] T009 Run `pnpm lint` + `pnpm test` + e2e green; visual check vs Jira board
- [x] T010 Commit sprint 003

# Tasks: Backlog & Sprint Management

**Input**: Design documents from `/specs/004-backlog-sprints/`

## Phase 1: Schema & Sprint Service

- [x] T001 Prisma: `Sprint` model + `Issue.sprintId` relation; `prisma migrate dev --name sprints`
- [x] T002 `src/services/sprintService.ts` — create (auto-name), list by board+state filter, partialUpdate with lifecycle rules (one-active, closed→backlog spillover), moveIssuesToSprint, moveIssuesToBacklog
- [x] T003 `src/routes/sprints.ts` — `POST /sprint`, `GET /board/:id/sprint`, `POST /sprint/:id`, `GET|POST /sprint/:id/issue`, `POST /backlog/issue`; wire under `/rest/agile/1.0`
- [x] T004 `issueService.ts` — include sprint in response fields; `boardService.ts` — active-sprint scope in `listBoardIssues`
- [x] T005 [P] `tests/integration/sprint.test.ts` — lifecycle, one-active rule, spillover, moves, board scope

## Phase 2: Frontend — Backlog Page

- [x] T006 `api/client.ts` — Sprint types + fetchers
- [x] T007 `pages/BacklogPage.tsx` — Backlog + sprint group sections, row styling, DnD between groups, Start/Complete/Create-sprint actions
- [x] T008 `ProjectSidebar.tsx` — enable Backlog link; `App.tsx` — route `/projects/:key/backlog`
- [x] T009 `BoardPage.tsx` — show active sprint name in header when scoped; `IssueDetailPage.tsx` — Sprint row in Details

## Phase 3: Polish

- [x] T010 `pnpm lint` + `pnpm test` + e2e green; visual pass vs Jira backlog
- [x] T011 Commit sprint 004

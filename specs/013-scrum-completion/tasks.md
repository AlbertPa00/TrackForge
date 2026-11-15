# Tasks — Sprint 013

- [x] T1 Schema+migration: `Sprint.boardId/completeDate/sequence`,
      `IssueSprint`, `Issue.storyPoints`, board→scrum flip, board backfill,
      `IssueSprint` seeding (dev + test DBs)
- [x] T2 sprintService: board-scoped create/get/update/delete, sequence naming,
      one-active-per-board, `IssueSprint` stamps on add/remove/close,
      carry-over to backlog/future/new sprint
- [x] T3 boardService: scrum-only sprint scoping, `listBacklog`, board-type
      change with active-sprint guard
- [x] T4 Fields/JQL: `story_points` in field/createmeta/editmeta/responses;
      `storypoints` comparisons + `IS EMPTY` + ORDER BY; `sprint` field,
      `openSprints()`, `closedSprints()`, equality/in-list, empty checks
- [x] T5 Agile routes: GET/PUT/POST/DELETE `/sprint/{id}`,
      `/board/{id}/backlog`, `/epic/{key}` + `/epic/{key}/issue` +
      `/epic/none/issue` (before `:key`), `/issue/{key}`, `/issue/rank`
- [x] T6 reportService + `/api/internal/reports/*`: velocity, burndown
      (terminal bucket at close), sprint report with scope-change flags
- [x] T7 Backend tests — 14-test scrum suite + sprint/JQL regression fixes
- [x] T8 BacklogPage rework: server backlog + sprint groups, LexoRank drag,
      multi-select, points chip, inline create, start/complete/edit/delete
- [x] T9 BoardPage scrum header (goal/days/Complete sprint + dialog), scrum
      empty state, sidebar gating, ReportsPage charts, board-type setting
- [x] T10 MCP tools: get_backlog, create/start/complete_sprint,
      move_to_sprint/backlog, rank_issue, estimate_issue, get_sprint_report,
      get_velocity, move_to_epic, suggest_sprint_scope
- [x] T11 AI scope endpoint + backlog "Suggest scope" (advisory)
- [x] T12 Seed: SCRUM project — 3 closed + 1 active sprint, story points,
      membership history (idempotent, verified twice)
- [x] T13 `GET /rest/agile/1.0/issue/{key}` + OpenAPI for agile issue/reports/
      AI scope; CompleteSprintDialog extracted for board+backlog reuse

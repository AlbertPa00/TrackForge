# Spec — Sprint 013: Scrum Completion

> Mirrors `docs/sprints/013-scrum-completion.md`. Records implementation decisions.

## Goal

Finish the Scrum experience Sprint 004 started: ranked estimated backlog, full
sprint planning/completion with carry-over, explicit board types, sprint
membership history, burndown/velocity reports, and the remaining Jira Agile
endpoints.

## Implemented user stories

- **US1 Ranked, estimated backlog** — `GET /rest/agile/1.0/board/{id}/backlog`
  returns rank-ordered issues not in an active/future sprint; LexoRank drag
  (incl. multi-select) via `PUT /issue/rank`; `story_points` field in `/field`,
  createmeta, editmeta, issue responses and JQL (`"Story Points" > 3`,
  `story_points is empty`); inline create at group bottom.
- **US2 Sprint planning & completion** — `PUT /sprint/{id}` full update
  (name/goal/dates/state); start-sprint dialog (duration, goal); complete-sprint
  dialog (completed vs open counts; carry open issues to backlog, a future
  sprint, or a new sprint); `GET`/`DELETE /sprint/{id}` (future only); at most
  one active sprint per board.
- **US3 Explicit Scrum boards** — `Board.type` (`scrum`|`kanban`); migration
  re-parents sprints project→board and flips sprint-owning boards to `scrum`;
  scrum boards scope to their active sprint, kanban boards never do; board-type
  switch in settings (`PUT /board/{id}/type`); Backlog/Reports sidebar links
  gated on scrum; scrum board header shows sprint name/goal/days remaining +
  Complete sprint; empty state links to backlog.
- **US4 Burndown & velocity** — `IssueSprint` membership history
  (`addedAt`/`removedAt`) drives closed-sprint views and reports computed from
  history + changelog (never snapshots): `/api/internal/reports/board/{id}/
  velocity`, `/burndown`, `/sprint/{id}/report`; Reports page with charts.
- **US5 AI sprint scope (P3)** — `POST /api/internal/ai/sprints/{boardId}/scope`
  suggests issues by rank vs average velocity, flags unestimated/blocked;
  advisory only (Backlog "Suggest scope" button + `suggest_sprint_scope` MCP
  tool); nothing moves without user action.

## API surface added/changed

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/agile/1.0/board/{id}/backlog` | rank order |
| GET/PUT/POST/DELETE | `/rest/agile/1.0/sprint/{id}` | full update; delete future only |
| PUT | `/rest/agile/1.0/board/{id}/type` | TF extension |
| GET | `/rest/agile/1.0/epic/{key}` · `/epic/{key}/issue` | `key=none` removes epic |
| GET | `/rest/agile/1.0/issue/{key}` | agile issue view |
| GET | `/api/internal/reports/board/{id}/velocity` · `/burndown` · `/sprint/{sid}/report` | native |
| POST | `/api/internal/ai/sprints/{id}/scope` | advisory |

## Data model changes

- `Sprint.boardId` (re-parented from project), `completeDate`, `sequence`
- `Issue.storyPoints` (Float, nullable — JQL `storypoints`)
- `IssueSprint(issueId, sprintId, addedAt, removedAt)` — membership history
- `Board.type` now persisted/meaningful; boards with sprint history → `scrum`

## MCP tools

`get_backlog`, `create_sprint`, `start_sprint`, `complete_sprint`
(carry-over target), `move_to_sprint`, `move_to_backlog`, `rank_issue`
(multi-issue), `estimate_issue`, `get_sprint_report`, `get_velocity`,
`move_to_epic`, `suggest_sprint_scope` (advisory).

## Edge cases handled

- `closedSprints()` with no matches compiles to always-false, not
  `sprintId IS NULL` (was matching every unsprinted issue).
- Completing a sprint stamps `removedAt` only on carried-over issues; completed
  issues keep membership so velocity/burndown stay accurate.
- `POST /epic/none/issue` precedes `/epic/:key/issue` (route order).
- Issues added mid-sprint flagged as scope change in sprint report/burndown.
- Migration backfills `IssueSprint` from current `Issue.sprintId` and boards
  for sprint-owning projects that lack one.

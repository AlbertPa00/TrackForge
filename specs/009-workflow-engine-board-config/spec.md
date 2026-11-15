# Sprint 009 spec — Workflow Engine & Board Configuration

Source: `docs/sprints/009-workflow-engine-board-config.md`. Status: **Done**.

## Delivered

| US | Deliverable |
|---|---|
| US1 | `Workflow`/`WorkflowStatus`/`WorkflowTransition`/`TransitionRule` schema; `Project.workflowId`; seeded **Simple** + **Software Simplified** workflows; `GET /issue/{key}/transitions` lists workflow transitions (condition-filtered, stable ids, `hasScreen`, `fields`); `GET /project/{key}/statuses`; `PUT fields.status` → `400` |
| US2 | Rule pipeline in `workflowService`: conditions (`onlyAssignee`/`onlyReporter`/`onlyAdmin`/`onlyProjectLead`) filter listing + block execution; validators (`resolutionRequired`, `fieldRequired`) → Jira field errors; post-functions (`setResolution`, `clearResolution`, `assignToCurrentUser`) in the same transaction + changelog; transition screens collect `fields` + `update.comment`; dry-run previews preserved |
| US3 | Table-based workflow editor at `/settings/workflows/:id` (admin); `GET/POST/PUT /api/internal/workflows`; version bump on save; reachability + outgoing-transition validation server-side; project settings workflow switcher with status-mapping step (`POST /api/internal/projects/{key}/workflow`, admin or project lead) |
| US4 | Persisted `Board`/`BoardColumn`/`BoardColumnStatus`; `GET/PUT /board/{id}/configuration` incl. `unmapped` statuses; WIP `min`/`max` with `count / max` red headers (advisory); `PUT /rest/agile/1.0/issue/rank` (LexoRank `rankBeforeIssue`/`rankAfterIssue`); `Issue.rank` indexed, assigned on create, backfilled on migrate; legacy `/board/{projectKey}` alias kept |

## Frontend

- `StatusTransitionMenu` lists named transitions and opens `TransitionScreenModal` for `hasScreen` transitions (resolution select + comment).
- Board drop resolves a transition into the column's mapped statuses; multiple candidates → chooser modal; screen → form modal; none → inline error.
- In-column drag → `PUT /issue/rank`; order persists (rank-sorted board feed).
- `BoardSettingsPage` (`/projects/:key/board/settings`): rename/add/remove columns, map/unmap statuses, WIP min/max — reachable from the board header.

## MCP tools

`get_transitions` (documents `hasScreen`/`fields`), `transition_issue` (`fields`, `comment`, name or id), `get_workflow`, `get_board`, `get_board_issues` (grouped by column), `rank_issue`, `move_card`.

## Out of scope (per sprint doc)

Visual graph designer, per-issue-type workflow schemes, swimlanes (P3), scrum board type (013).

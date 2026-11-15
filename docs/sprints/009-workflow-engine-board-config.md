# Sprint 009 — Workflow Engine & Board Configuration

| | |
|---|---|
| **Status** | Done |
| **Theme** | Jira parity |
| **Depends on** | 003 (virtual Kanban board), 004 (sprints, implicit Scrum mode), 008 (resolution, editable fields) |
| **Unblocks** | 013 (Scrum boards, ranking) |
| **Spec-kit folder** | `specs/009-workflow-engine-board-config/` |
| **Open decisions** | D7 (board identifiers) |
| **New dependencies (to justify in plan)** | `@dnd-kit/*` — needed now for in-column ranking and multi-list drag (Sprint 003 deliberately deferred it) |

## Goal

Replace "any status to any status" with real, per-project workflows — named transitions, rules about
who may move an issue and what must be true, and automatic side effects — and turn Sprint 003's
virtual board into persisted, configurable boards with column mapping, WIP limits and ranking.

## Why now

A tracker without enforced workflows can't represent a team's process, and agents can put issues into
nonsensical states. Sprint 003 delivered the board interaction; this sprint gives it real rules and
configuration. Ranking is also a prerequisite for the Scrum backlog (013).

## Scope

**In**: workflow model and default workflows, per-project workflow assignment, transitions with
conditions/validators/post-functions, transition screens, removal of status edits via `PUT`, a
table-based workflow editor, persisted boards with column↔status mapping, WIP limits, swimlanes (P3),
LexoRank ranking.

**Out**: visual graph workflow designer, per-issue-type workflow schemes (P3 at most), explicit Scrum
board type and the rest of Scrum (013), custom post-function plugins. Sprint 004's implicit Scrum mode
(board scopes to the active sprint when one exists) MUST keep working on persisted boards.

---

## User stories

### US1 — Projects have real workflows (P1)

As an admin or project lead, I want each project to follow a defined workflow so that issues only move through valid states. (Project roles arrive later; until then "admin" = global admin from 006 and "project lead" = `Project.leadId` from 008.)

**Independent test**: assign the "Software Simplified" workflow to TF; from To Do, only "Start progress" is offered; Done cannot be reached directly from To Do.

**Acceptance scenarios**

1. **Given** seed data, **When** the system starts, **Then** two workflows exist: **Simple** (To Do ⇄ In Progress ⇄ Done, plus any → To Do) and **Software** (Backlog → Selected for Development → In Progress → In Review → Done, per DESIGN.md §7.1/7.2).
2. **Given** a project, **When** created, **Then** it uses the Simple workflow by default; an admin or the project lead can switch workflows in Project settings with a status-mapping step for existing issues.
3. **Given** `GET /issue/{key}/transitions`, **When** called, **Then** only transitions allowed from the current status *and* passing conditions for the caller are returned, each with a stable transition `id` and a name (e.g. "Start progress"), not the status id.
4. **Given** `GET /rest/api/2/project/{key}/statuses`, **When** called, **Then** statuses valid for that project are returned per issue type (Jira shape).
5. **Given** `PUT /issue/{key}` with `fields.status`, **When** called, **Then** it is rejected with `400` ("Field 'status' cannot be set. Use transitions."), matching Jira. Existing tests that change status via `PUT` are migrated to transitions.

### US2 — Transitions have rules and side effects (P1)

As an admin, I want transitions to enforce rules and update fields automatically so that data stays consistent.

**Acceptance scenarios**

1. **Given** a transition with condition **Only assignee** or **Only admins**, **When** another user asks for transitions, **Then** that transition is not listed and executing it returns `400`.
2. **Given** a transition to a `done`-category status with validator **Resolution required**, **When** executed without `fields.resolution`, **Then** it fails with a field error.
3. **Given** a transition with a **transition screen** (fields: resolution, comment), **When** a user triggers it in the UI (menu or board drop), **Then** a modal collects the fields; `POST /transitions` accepts `{ transition, fields, update: { comment: [{ add: { body } }] } }`.
4. **Given** post-functions **Set resolution**, **Clear resolution** (on leaving done) and **Assign to current user**, **When** the transition executes, **Then** the side effects apply in the same transaction and are recorded in the changelog.

### US3 — Admins can edit workflows (P2)

As an admin, I want a workflow editor so that I can model my team's process without code.

**Acceptance scenarios**

1. **Given** Settings → Workflows, **When** an admin opens a workflow, **Then** they see a statuses table (name, category) and a transitions table (name, from, to, conditions, validators, post-functions, screen).
2. **Given** the editor, **When** an admin adds a status, transition or rule and saves, **Then** a new workflow version is stored; projects using it pick it up immediately.
3. **Given** a status in use by issues, **When** an admin tries to remove it, **Then** removal is blocked with the count of affected issues.
4. **Given** a workflow, **When** saved, **Then** validation ensures every status is reachable from the initial status and has at least one outgoing transition unless it is in the `done` category.

### US4 — Boards are configurable and rankable (P1)

As a team, we want to configure board columns and order cards by priority so that the board reflects how we work.

**Independent test**: map "Selected for Development" and "In Progress" into one column "Doing" with WIP limit 3; drag a card above another inside a column; reload and the order persists.

**Acceptance scenarios**

1. **Given** a project, **When** migrated from Sprint 003, **Then** a persisted Kanban board exists for it, preserving the 003 URL; board ids follow D7 (`GET /rest/agile/1.0/board/{id}` works for both numeric id and legacy key for one release).
2. **Given** Board settings → Columns, **When** an admin maps one or more statuses to each column, **Then** `GET|PUT /rest/agile/1.0/board/{id}/configuration` reflects the mapping; unmapped statuses appear in an "Unmapped" area.
3. **Given** a column with a WIP limit (min/max), **When** the count exceeds max, **Then** the column header turns red and shows "n / max"; limits are advisory, not blocking.
4. **Given** a card, **When** dropped into a column mapped to several statuses, **Then** the first status reachable by a valid transition is used; if none, the drop is rejected with an explanation.
5. **Given** cards within a column, **When** a user drags a card above/below another, **Then** `PUT /rest/agile/1.0/issue/rank` (`{ issues, rankBeforeIssue | rankAfterIssue }`) updates its LexoRank and order persists for everyone.
6. **Given** swimlanes setting (P3), **When** set to Assignee or Epic, **Then** cards group into horizontal lanes.

---

## Edge cases

- Switching a project's workflow when issues are in statuses that don't exist in the new workflow requires an explicit mapping; no issue may be left in an invalid status.
- Transition executed concurrently by two users from the same source status: the second gets `409`/`400` because the issue is no longer in the source status.
- LexoRank rebalancing when ranks get too long happens in the background without changing visible order.
- Board drop that triggers a transition screen must not move the card until the modal is submitted; cancel restores position.

## Functional requirements

- **FR-001**: Each project MUST be associated with exactly one workflow (per-issue-type mapping P3).
- **FR-002**: Transitions MUST have stable ids independent of status ids; the API contract change from 002/003 MUST be documented.
- **FR-003**: Conditions, validators and post-functions MUST be implemented as a pipeline (DESIGN.md §21.6), evaluated server-side for UI, REST and MCP alike.
- **FR-004**: `PUT /issue/{key}` MUST reject `status` changes.
- **FR-005**: Boards MUST be persisted with column↔status mapping, optional WIP limits and a JQL-like filter (project only until 010).
- **FR-007** *(amendment, 2026-11-07 replan)*: The board↔project relation MUST be **N:1** from the start (no unique constraint on `projectId`); each project has exactly one board flagged `isDefault`, which the legacy project-key alias resolves to. Only the default board is created in this sprint — multi-board CRUD and UI land in 033 — but the schema must not need a breaking migration then. Jira creates boards from `{name, type, filterId, location}`; storing `filter` now keeps that shape reachable.
- **FR-006**: Issue rank MUST be stored as LexoRank and exposed via the Agile rank endpoint.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/rest/api/2/issue/{key}/transitions` | Real transitions; POST accepts `fields`, `update` |
| GET | `/rest/api/2/project/{key}/statuses` | Jira |
| GET | `/rest/api/2/workflow` | Jira (read) |
| GET/POST/PUT | `/api/internal/workflows[/{id}]` | Native editor API |
| GET | `/rest/agile/1.0/board` · `/board/{id}` | Persisted boards |
| GET/PUT | `/rest/agile/1.0/board/{id}/configuration` | Column config, WIP |
| PUT | `/rest/agile/1.0/issue/rank` | LexoRank |

## Data model changes

- **Workflow** (`id`, `name`, `version`), **WorkflowStatus** (workflow ↔ status, `isInitial`), **WorkflowTransition** (`id`, `workflowId`, `name`, `fromStatusId?` (null = global), `toStatusId`, `screenFields[]`), **TransitionRule** (`transitionId`, `kind` = condition|validator|postFunction, `type`, `config` JSON).
- **Project.workflowId**.
- **Board** (`id`, `name`, `type` kanban|scrum, `projectId` — **not unique** (FR-007), `isDefault`, `filter`), **BoardColumn** (`boardId`, `name`, `position`, `minIssues?`, `maxIssues?`), **BoardColumnStatus**.
- **Issue.rank** (string, indexed).

## MCP tools added

`get_transitions` (now includes required fields per transition), `transition_issue` (accepts
`fields`, `comment`), `get_workflow`, `get_board`, `get_board_issues` (grouped by column),
`rank_issue`, `move_card` (column-level move that picks the valid transition).

## AI-native checklist

- [ ] Agents receive only valid transitions plus required fields — no trial-and-error (A3).
- [ ] Workflow rules apply identically to UI, REST and MCP (A1).
- [ ] Transitions and rank changes recorded with channel (A2); transitions support dry-run (A4).

## Success criteria

- **SC-001**: No API path can place an issue in a status unreachable under its project's workflow (property-based test over random transition sequences).
- **SC-002**: Board with 200 issues: drag-to-rank persists and re-renders in < 300 ms perceived latency (optimistic update).
- **SC-003**: Agent eval: "close TF-7 as duplicate" succeeds by discovering the transition and the required resolution field without an invalid call.

## Risks

| Risk | Mitigation |
|---|---|
| Breaking the transition-id contract shipped in 002/003 | Version note in contracts; UI already reads ids from GET; integration tests updated in the same PR |
| Workflow engine over-engineered | Fixed set of built-in rule types; no plugin system (DESIGN.md §21.13 stays in "Later") |
| Data migration for 003 boards | One-off migration creating a board per project; legacy key alias for one release |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Contract change (transition ids, `PUT` status rejection) documented in `contracts/api.md`.
- [ ] Sidebar "Board" reflects persisted boards; board settings reachable from the board header.

# Feature Specification: Kanban Board View

**Feature Branch**: `003-kanban-board`

**Created**: 2026-11-07

**Status**: Draft

**Input**: User description: "Continue implementation toward Jira parity — the board view (DESIGN.md Phase 2, lightweight slice)."

## User Scenarios & Testing

### User Story 1 - Jira-Style Board with Status Columns (Priority: P1)

As a user, I want to see project issues as cards in status columns like Jira's board so that I can visualize workflow state at a glance.

**Why this priority**: The board is Jira's signature view. Without it the product doesn't feel like Jira Software.

**Independent Test**: Open a project's Board view; issues appear as cards in columns named after statuses, matching Jira board styling.

**Acceptance Scenarios**:

1. **Given** a project has issues in mixed statuses, **When** a user opens `/projects/:key/board`, **Then** they see one column per status (sequence order) with the count in the header, and cards showing type icon, summary, key, priority icon, and assignee avatar.
2. **Given** a column has no issues, **When** the board renders, **Then** the column still shows with an empty state.
3. **Given** a user clicks a card, **When** navigation occurs, **Then** they land on `/browse/:issueKey`.

---

### User Story 2 - Drag-and-Drop Status Transitions (Priority: P1)

As a user, I want to drag a card between columns to change its status so that the board doubles as a workflow tool.

**Why this priority**: Drag-to-transition is the board's core interaction; read-only boards feel like toys.

**Independent Test**: Drag a card from "To Do" to "In Progress"; the issue's status changes server-side and persists on reload.

**Acceptance Scenarios**:

1. **Given** a card in "To Do", **When** a user drags it onto "In Progress", **Then** the app calls `POST /issue/:key/transitions`, the card moves, and status persists after refresh.
2. **Given** a transition fails, **When** the drop completes, **Then** the board refetches and the user sees a non-blocking error message.

---

### User Story 3 - Agile-API-Compatible Board Endpoints (Priority: P2)

As an API consumer, I want Jira Agile-style board endpoints so that integrations can read boards predictably.

**Why this priority**: API-first constitution; boards should be consumable without the UI.

**Independent Test**: `GET /rest/agile/1.0/board?projectKeyOrId=TF` returns a board; `/board/{id}/configuration` returns columns; `/board/{id}/issue` returns all project issues.

**Acceptance Scenarios**:

1. **Given** a project exists, **When** the board endpoints are called, **Then** they return Jira Agile-shaped responses (board, columnConfig, issue page).
2. **Given** an unknown project, **When** board endpoints are called, **Then** a Jira-shaped 404 is returned.

---

### Edge Cases

- Column count equals status count (1:1 mapping this sprint — no custom column config, no swimlanes, no WIP limits).
- Issues beyond 200 → paginated later; sprint caps `maxResults` at 200 with a documented limit.
- Rank/ordering within a column is by issue key; drag-to-rank is deferred.
- Simultaneous drags from two sessions → last write wins (no real-time sync this sprint).

## Requirements

### Functional Requirements

- **FR-001**: The backend MUST expose `GET /rest/agile/1.0/board?projectKeyOrId=`, `GET /rest/agile/1.0/board/:id/configuration`, and `GET /rest/agile/1.0/board/:id/issue` with Jira Agile-shaped responses; board id = project key (documented divergence from numeric Jira ids).
- **FR-002**: Board columns MUST derive 1:1 from statuses ordered by `sequence`, each tagged with its `statusCategory`.
- **FR-003**: The UI MUST render a horizontal board with Jira styling: gray column surfaces, uppercase headers with counts, white cards (type icon, summary, key, priority icon, avatar).
- **FR-004**: Cards MUST be draggable between columns; a successful drop executes the matching transition via the existing transitions endpoint.
- **FR-005**: The project sidebar "Board" item MUST become an active link; Board and List are peer views under `/projects/:key`.
- **FR-006**: All new endpoints MUST have integration tests; the e2e smoke stays green.

### Key Entities

- **Board** (virtual): derived from a project, `id` = project key, `type` = `kanban`. Not persisted.
- **Column** (virtual): derived from a `Status`; `statuses` = the single mapped status.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A user can move an issue between all statuses using only drag-and-drop, verified visually and by refetch.
- **SC-002**: Board loads all project issues in a single request and renders columns in under 2s for 200 issues.
- **SC-003**: Test suite stays green with board endpoint coverage (≥ 30 tests total).
- **SC-004**: Zero new runtime dependencies — drag-and-drop uses native HTML5 DnD (documented in plan; `@dnd-kit` deferred until multi-list rank support is needed).

## Assumptions

- One implicit board per project (no board CRUD, no filters, no swimlanes/WIP limits — deferred).
- Column↔status mapping is fixed 1:1 until workflow/column configuration arrives in a later phase.
- Card ranking within a column is not draggable this sprint.
- No WebSocket/board sync — manual refresh or refetch shows other users' changes.

# Feature Specification: Backlog & Sprint Management

**Feature Branch**: `004-backlog-sprints`

**Created**: 2026-11-07

**Status**: Draft

**Input**: User description: "Continue implementation — backlog view with sprint lifecycle, scrum workflow basics."

## User Scenarios & Testing

### User Story 1 - Jira-Style Backlog View (Priority: P1)

As a user, I want a backlog page that groups unsprinted issues and planned/active sprints like Jira so that I can organize upcoming work.

**Why this priority**: Backlog+sprints is the remaining core scrum surface; the sidebar item already exists disabled.

**Independent Test**: Open `/projects/:key/backlog`; see a Backlog section plus sprint sections, each listing its issues in Jira's row style.

**Acceptance Scenarios**:

1. **Given** issues exist with and without sprints, **When** the backlog opens, **Then** unsprinted issues appear in the Backlog group and each sprint renders as a collapsible-looking group with name, issue count, and its issues.
2. **Given** an empty backlog, **When** rendered, **Then** the section shows a Jira-style empty state ("Your backlog is empty").

---

### User Story 2 - Sprint Lifecycle (Priority: P1)

As a user, I want to create sprints, start one, and complete it so that the scrum cadence works.

**Why this priority**: Without lifecycle actions sprints are static labels.

**Independent Test**: Create sprint → issues appear in a section → Start sprint → only one can be active → Complete sprint → non-done issues return to backlog.

**Acceptance Scenarios**:

1. **Given** a future sprint exists, **When** a user clicks "Start sprint", **Then** its state becomes `active`; starting a second sprint while one is active is rejected with a clear error.
2. **Given** an active sprint has done and open issues, **When** a user clicks "Complete sprint", **Then** the sprint closes and only the open issues move back to the backlog.

---

### User Story 3 - Move Issues Between Backlog and Sprints (Priority: P1)

As a user, I want to drag backlog issues into a sprint section (and back) so that planning is tactile like Jira.

**Why this priority**: Drag-to-plan is what makes the backlog view feel like Jira rather than a report.

**Independent Test**: Drag a backlog row onto a sprint group; the issue's sprint changes via API and persists.

**Acceptance Scenarios**:

1. **Given** a future sprint, **When** a user drops an issue onto its group, **Then** `POST /sprint/{id}/issue` runs and the row moves.
2. **Given** an issue inside a sprint, **When** dropped on the Backlog group, **Then** `POST /backlog/issue` runs and `sprintId` clears.

---

### User Story 4 - Board Shows the Active Sprint (Priority: P2)

As a user, I want the board to show only the active sprint's issues once a sprint is running so that it behaves like a Jira scrum board.

**Why this priority**: Sprint-scoped board is how scrum teams use the tool daily.

**Independent Test**: Start a sprint; the board shows only that sprint's issues; complete it; the board shows all project issues again (kanban mode).

**Acceptance Scenarios**:

1. **Given** an active sprint, **When** the board loads, **Then** `GET /board/{id}/issue` returns only issues in the active sprint and the header shows the sprint name.
2. **Given** no sprints at all, **When** the board loads, **Then** all project issues show (unchanged kanban behavior).

---

### Edge Cases

- Sprint names auto-generate as `{PROJECTKEY} Sprint {n}` if not provided.
- Completing a sprint with zero done issues → all issues return to backlog.
- Issues may be moved to future or active sprints; closed sprints reject additions (404/400).
- Deleting sprints is out of scope; closed sprints stay hidden from the backlog list.

## Requirements

### Functional Requirements

- **FR-001**: Persist `Sprint {id, projectId, name, state(future|active|closed), goal?, startDate?, endDate?, createdAt}` and `Issue.sprintId` (nullable).
- **FR-002**: Expose Jira Agile endpoints: `POST /rest/agile/1.0/sprint`, `GET /board/{id}/sprint?state=`, `POST /sprint/{id}` (state/name/goal), `GET|POST /sprint/{id}/issue`, `POST /rest/agile/1.0/backlog/issue`.
- **FR-003**: At most one `active` sprint per project; violations rejected with a Jira-shaped 400.
- **FR-004**: Completing a sprint MUST return non-`done`-category issues to the backlog.
- **FR-005**: `GET /board/{id}/issue` MUST return active-sprint issues when an active sprint exists, all project issues otherwise.
- **FR-006**: Issue responses MUST include `fields.sprint {id,name}` or `null`.
- **FR-007**: UI backlog rows MUST use Jira row styling (type icon, key link, summary, lozenge, priority icon, avatar) and support drag between groups.
- **FR-008**: Integration tests for sprint lifecycle and board sprint filtering.

### Key Entities

- **Sprint**: time-boxed iteration within a project; state machine future→active→closed (irreversible).
- **Issue.sprint**: optional membership; at most one sprint at a time.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Full scrum loop works in UI: create sprint → drag issues in → start → board scopes → complete → spillover returns.
- **SC-002**: One-active-sprint invariant holds under concurrent requests (enforced in service layer).
- **SC-003**: ≥ 40 total tests green.
- **SC-004**: Still zero new runtime dependencies (DnD stays native).

## Assumptions

- No sprint duration/date pickers in this sprint — `startDate`/`endDate` optional via API only.
- No sprint report/burndown (Phase 5), no rank reordering within backlog rows, no velocity.
- Parallel sprints not supported (Jira's optional "parallel sprints" setting).
- Board "scrum mode" is implicit: presence of an active sprint switches the board to sprint scope; documented divergence from Jira's separate scrum/kanban board types.

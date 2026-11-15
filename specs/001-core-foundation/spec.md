# Feature Specification: Core Foundation

**Feature Branch**: `001-core-foundation`

**Created**: 2026-06-20

**Status**: Draft

**Input**: User description: "Implement Jira DOCS sprint step by step"

## User Scenarios & Testing

### User Story 1 - Create and View Projects (Priority: P1)

As an internal team lead, I want to create a project with a short key and name so that my team has a container for tracking work.

**Why this priority**: Without projects, there is no place to organize issues. This is the smallest prerequisite for any Jira-like value.

**Independent Test**: A user can create a project through the API and see it in a project list UI without any other features being implemented.

**Acceptance Scenarios**:

1. **Given** a user provides a project key and name, **When** they create a project, **Then** the project is stored and can be retrieved by key.
2. **Given** multiple projects exist, **When** a user lists projects, **Then** they see all projects with their keys and names.

---

### User Story 2 - Create and View Issues (Priority: P1)

As a team member, I want to create issues inside a project with summary, type, status, and priority so that work can be tracked.

**Why this priority**: Issues are the atomic unit of Jira. Creating and viewing them is the minimum viable feature for the platform.

**Independent Test**: A user can create an issue in a project through the API and see it in an issue list UI.

**Acceptance Scenarios**:

1. **Given** a project exists, **When** a user creates an issue with summary and type, **Then** the issue is assigned a project-specific key (e.g., PROJ-1) and stored.
2. **Given** issues exist in a project, **When** a user lists issues, **Then** they see keys, summaries, types, statuses, and priorities.
3. **Given** an issue exists, **When** a user retrieves it by key, **Then** they see all stored fields and a link back to its project.

---

### User Story 3 - Update Issue Status (Priority: P2)

As a team member, I want to move an issue through a simple workflow so that progress is visible.

**Why this priority**: Status transitions are core to Jira. A minimal two- or three-step workflow demonstrates the workflow engine concept without building a full designer.

**Independent Test**: A user can change an issue status from "To Do" to "In Progress" to "Done" through the API.

**Acceptance Scenarios**:

1. **Given** an issue is in "To Do", **When** a user transitions it to "In Progress", **Then** the issue reflects the new status and records the transition.
2. **Given** an issue is in "Done", **When** a user tries to transition it to a non-existent next status, **Then** the system rejects the transition with a clear error.

---

### User Story 4 - Simple Web UI for Projects and Issues (Priority: P2)

As a user, I want a web interface to view projects and their issues so that I can interact with the platform without using the API directly.

**Why this priority**: A UI makes the sprint demonstrable to stakeholders and validates the API usability.

**Independent Test**: A user can open a browser, see a project list, navigate to a project, and see its issues.

**Acceptance Scenarios**:

1. **Given** projects exist, **When** a user opens the home page, **Then** they see a list of projects.
2. **Given** a project has issues, **When** a user clicks the project, **Then** they see the project's issues with key, summary, status, and priority.

---

### Edge Cases

- What happens when a project key is duplicated? The system rejects the creation with a clear error.
- What happens when an issue is created in a project that does not exist? The system returns a 404 or validation error.
- What happens when an issue status is set to an invalid value? The system rejects the update and preserves the previous status.
- What happens when the project has no issues? The issue list UI shows an empty state.
- What happens when the issue key sequence reaches a large number? Keys remain unique per project and continue incrementing.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST allow users to create projects with a unique uppercase key (up to 10 characters) and a name.
- **FR-002**: The system MUST allow users to list all projects.
- **FR-003**: The system MUST allow users to retrieve a project by its key.
- **FR-004**: The system MUST allow users to create issues within a project with a summary, issue type, status, and priority.
- **FR-005**: The system MUST auto-assign project-specific keys to issues (e.g., `PROJ-1`, `PROJ-2`).
- **FR-006**: The system MUST allow users to list issues by project.
- **FR-007**: The system MUST allow users to retrieve an issue by its project-specific key.
- **FR-008**: The system MUST allow users to update an issue's summary, description, status, and priority.
- **FR-009**: The system MUST enforce a minimal workflow: issues may transition between To Do, In Progress, and Done in any direction for this sprint.
- **FR-010**: The system MUST seed default issue types (Epic, Story, Task, Bug, Subtask) and default statuses (To Do, In Progress, Done) and priorities (Highest, High, Medium, Low, Lowest) on first run.
- **FR-011**: The system MUST expose a REST API matching Jira-style endpoints and JSON shapes where possible.
- **FR-012**: The system MUST provide a web UI that lists projects and shows project issues.

### Key Entities

- **Project**: Represents a container of work. Key attributes: key, name, description, project type, created/updated timestamps.
- **Issue**: Represents an atomic work unit. Key attributes: project key, issue number, issue key (e.g., PROJ-1), summary, description, issue type, status, priority, assignee, reporter, created/updated timestamps.
- **Issue Type**: System-defined category such as Epic, Story, Task, Bug, Subtask.
- **Status**: System-defined workflow state such as To Do, In Progress, Done.
- **Priority**: System-defined urgency level such as Highest, High, Medium, Low, Lowest.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A user can create a project and retrieve it in under 2 seconds through the API.
- **SC-002**: A user can create, list, and view issues for a project with 100% success rate in automated API tests.
- **SC-003**: Issue status transitions complete in under 1 second and reject invalid statuses with a clear error message.
- **SC-004**: The web UI renders the project list and issue list without errors on the latest stable Chrome and Edge browsers.
- **SC-005**: The API responses use Jira-compatible field names and shapes where applicable (e.g., `key`, `summary`, `issuetype`, `status`, `priority`).

## Assumptions

- Authentication and authorization are out of scope for this sprint; all users are treated as system administrators.
- The Jira REST API compatibility layer is partial; only endpoints needed by the sprint's features are implemented.
- Rich text descriptions are stored as plain text or simple Markdown; Atlassian Document Format (ADF) support is deferred.
- Attachments, comments, subtasks, epics, components, versions, and custom fields are out of scope for this sprint.
- Local development uses SQLite for simplicity; PostgreSQL support is verified but optional.
- The web UI is intentionally minimal; styling and advanced interactions are deferred to later sprints.

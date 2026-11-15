# Feature Specification: Jira-Style UI & Core Issue Workflow

**Feature Branch**: `002-jira-style-ui`

**Created**: 2026-11-07

**Status**: Draft

**Input**: User description: "Reach a very similar functional app to Jira and exactly the same style. Lightweight first version without plugins."

## User Scenarios & Testing

### User Story 1 - Jira-Style App Shell & Projects Page (Priority: P1)

As a user, I want the app to look and navigate like Jira — dark top navigation, project sidebar, and a project directory — so that the product feels like Jira, not a generic demo.

**Why this priority**: Visual parity is the stated goal of this sprint. The shell is the frame every other page renders inside.

**Independent Test**: Open the app; the page shows a dark Atlassian-style top bar, a "Projects" page styled like Jira's project directory, and clicking a project reveals a Jira-style project sidebar.

**Acceptance Scenarios**:

1. **Given** the app loads, **When** a user views the home page, **Then** they see a dark navy top bar with TrackForge branding, navigation links, a search field, and a user avatar — styled like Jira's navigation.
2. **Given** projects exist, **When** a user opens the Projects page, **Then** they see a table with Name (with project avatar), Key, Type, and Lead columns like Jira's project directory.
3. **Given** a user is inside a project, **When** they view the left sidebar, **Then** they see the project avatar, project name, and navigation entries (List active; Board, Backlog, Timeline disabled placeholders).

---

### User Story 2 - Issue Navigator Table (Priority: P1)

As a user, I want to see project issues in Jira's list-view table with filters so that I can scan and search work items.

**Why this priority**: The issue table is Jira's most-used view and the primary way users interact with issues.

**Independent Test**: Navigate to a project and see the issue table with Jira columns, status lozenges, priority/type icons, and working filters.

**Acceptance Scenarios**:

1. **Given** issues exist, **When** a user opens a project's Issues view, **Then** they see a table with columns: Type, Key, Summary, Status, Priority, Assignee, Reporter, Created, Updated.
2. **Given** issues exist with varied statuses, **When** a user picks a status from the filter dropdown, **Then** only matching issues show.
3. **Given** many issues, **When** a user types in the summary search box, **Then** the table filters by summary text.

---

### User Story 3 - Issue Detail View (Priority: P1)

As a user, I want a Jira-style issue detail page (`/browse/KEY-1`) with a details panel and a status transition dropdown so that I can inspect and update an issue like in Jira.

**Why this priority**: The issue view is the heart of Jira. Status transitions via the details panel are the core interaction.

**Independent Test**: Open an issue directly at `/browse/PROJ-1`; see summary, description, and details panel; change status via dropdown.

**Acceptance Scenarios**:

1. **Given** an issue exists, **When** a user navigates to `/browse/:key`, **Then** they see breadcrumb, summary as the title, description, and a Details panel (Status, Assignee, Reporter, Priority, Type, Created, Updated) styled like Jira.
2. **Given** an issue is open, **When** a user clicks the status lozenge and picks a new status, **Then** the issue transitions via `POST /rest/api/2/issue/:key/transitions` and the UI reflects the change.

---

### User Story 4 - Create Project & Create Issue Dialogs (Priority: P2)

As a user, I want Jira-style create dialogs so that I can add projects and issues without leaving the UI.

**Why this priority**: Creation completes the core CRUD loop; without it the UI is read-only.

**Independent Test**: Click "Create" in the top nav or on the Projects page; fill the modal; the new entity appears.

**Acceptance Scenarios**:

1. **Given** a user clicks "Create", **When** they select a project, issue type, priority, enter a summary, and submit, **Then** the issue is created and they land on its detail page.
2. **Given** a user is on the Projects page, **When** they click "Create project" and enter name/key, **Then** the project is created and they land on its Issues view. The key field auto-suggests from the name like Jira.

---

### Edge Cases

- Empty project list → Projects page shows a Jira-style empty state with a Create project CTA.
- Project with no issues → Issue table shows an empty state ("No issues found").
- Invalid transition id → API rejects with Jira-shaped error; UI shows it non-blocking.
- Issue key typed wrong in URL → detail page shows a "Issue not found" state.
- Create issue with missing summary → dialog shows inline validation.

## Requirements

### Functional Requirements

- **FR-001**: The UI MUST replicate Jira's visual language: dark navy top bar, white content surface, Atlassian navy/blue palette, status lozenges (To Do gray, In Progress blue, Done green), priority chevron icons, colored issue-type icons, initial avatars.
- **FR-002**: The backend MUST expose metadata endpoints: `GET /rest/api/2/status`, `GET /rest/api/2/priority`, `GET /rest/api/2/issuetype`, `GET /rest/api/2/myself` with Jira-shaped responses.
- **FR-003**: The backend MUST support `GET /rest/api/2/issue/:key/transitions` and `POST /rest/api/2/issue/:key/transitions` per Jira v2 shapes (transition id, `to` object with statusCategory).
- **FR-004**: The search endpoint MUST support a documented JQL-lite grammar: `project = KEY [AND status = "Name" | issuetype = "Name" | priority = "Name"]* [ORDER BY created|updated|key ASC|DESC]`, plus `startAt`/`maxResults` pagination.
- **FR-005**: Issues MUST report `assignee` (null when unset) and `reporter` (stub admin user) in the Jira `fields` shape.
- **FR-006**: Routes MUST use Jira-style URLs: `/` projects directory, `/projects/:key` issue list, `/browse/:issueKey` issue detail.
- **FR-007**: All new endpoints MUST have integration tests; UI must keep the Playwright smoke test green (updated for the new shell).

### Key Entities

- No new persisted entities. `User` is represented as a single stub admin (`GET /myself`); a real User model is deferred. `assignee`/`reporter` remain nullable fields rendered from the stub.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A first-time viewer identifies the UI as "Jira-style" — dark top nav, sidebar, lozenges, table, detail panel all present.
- **SC-002**: Full create → list → view → transition flow works end-to-end in the browser with zero API calls outside the documented contract.
- **SC-003**: Backend test suite stays green with new endpoint coverage (target ≥ 18 tests total).
- **SC-004**: No plugin/module architecture introduced; stack stays React+Vite+Tailwind+TanStack Query / Express+Prisma+SQLite per constitution V.

## Assumptions

- Single-user stub (no auth): reporter is always the admin stub; assignee remains unassigned unless future sprints add users.
- Board/Backlog/Timeline sidebar items are visible but disabled placeholders — real boards are a later phase.
- Comments, attachments, worklogs, and issue links remain out of scope.
- `PUT /issue/:key` keeps Jira's real behavior (204 No Content); the UI refetches after mutation.

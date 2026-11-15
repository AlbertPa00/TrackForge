# Sprint 008 — Editable Issues & Collaboration

| | |
|---|---|
| **Status** | Done |
| **Theme** | Jira parity |
| **Depends on** | 006 (actors, changelog), 007 (MCP, idempotency, metadata) |
| **Unblocks** | 009 (resolution, transition screens), 010 (labels, parent in JQL), 011 (comment events, mentions) |
| **Spec-kit folder** | `specs/008-editable-issues-collaboration/` |
| **Open decisions** | D6 (rich-text storage) |

## Goal

Turn the issue view from a read-only page into the place where work happens: every field is editable
in place, issues gain the fields teams rely on (labels, due date, resolution, hierarchy), people
discuss work in comments with @mentions, and issues and projects can be deleted and managed.

## Why now

Without inline editing and comments the product cannot replace Jira for a single day of real work.
Identity (006) makes comments attributable; the MCP layer (007) means each capability ships to agents
at the same time.

## Scope

**In**: inline editing, markdown description editor, labels, due date, resolution, parent/subtasks/
epic children, comments with @mentions, delete issue, project update/delete, project settings page,
issue links (P3).

**Out**: attachments, worklogs, watchers/votes (011), components/versions, custom fields, ADF/v3.

---

## User stories

### US1 — Edit any field in place (P1)

As a user, I want to click a field on the issue page and change it so that updating work is fast.

**Independent test**: on `/browse/TF-1`, change summary, description, priority, type, assignee, labels and due date without leaving the page; reload and all changes persist; History shows each change.

**Acceptance scenarios**

1. **Given** the summary, **When** a user clicks it, **Then** it becomes an input; Enter or blur saves, Esc cancels; empty summary is rejected inline.
2. **Given** the description, **When** a user clicks it, **Then** a markdown editor with preview opens; Save/Cancel buttons; rendered markdown is sanitised.
3. **Given** priority, type, assignee, labels and due date in the details panel, **When** a user edits them, **Then** changes save immediately with optimistic UI and roll back with an error toast on failure.
4. **Given** keyboard users, **When** they press `e` on the issue page, **Then** the summary enters edit mode; all editors are reachable by Tab.
5. **Given** `PUT /issue/{key}` with `update: { labels: [{ add: "x" }, { remove: "y" }] }`, **When** called, **Then** Jira `update` operations are applied alongside `fields`.

### US2 — Issues have the fields teams need (P1)

As a user, I want labels, due dates, resolution and a parent/child hierarchy so that I can organise work.

**Acceptance scenarios**

1. **Given** labels, **When** a user types in the labels field, **Then** existing labels are suggested (`GET /rest/api/2/label`) and new labels can be created inline.
2. **Given** `GET /rest/api/2/resolution`, **When** called, **Then** seeded resolutions (Done, Won't Do, Duplicate, Cannot Reproduce) are returned; `fields.resolution` and `resolutiondate` appear on issues.
3. **Given** a Subtask, **When** created, **Then** `fields.parent` is required and must reference a non-subtask issue in the same project.
4. **Given** a Story/Task/Bug, **When** `fields.parent` references an Epic, **Then** it becomes the epic's child; hierarchy is validated by `hierarchyLevel` (child level = parent level − 1).
5. **Given** an issue with children, **When** its page is viewed, **Then** a "Child issues" panel lists them with status and a progress bar, and allows "Create child".
6. **Given** a child issue, **When** viewed, **Then** the breadcrumb shows the parent key.

### US3 — Discuss work in comments (P1)

As a user, I want to comment on issues and mention colleagues so that discussion lives with the work.

**Independent test**: post a comment mentioning `@Ana`; edit it; delete it as its author; an admin can delete anyone's comment; another user cannot edit it.

**Acceptance scenarios**

1. **Given** `GET|POST /rest/api/2/issue/{key}/comment` and `PUT|DELETE /comment/{id}`, **When** called, **Then** they behave per Jira v2 (paged list with `startAt`, `maxResults`, `total`, `comments[]` with `author`, `body`, `created`, `updated`).
2. **Given** the Activity section, **When** a user selects Comments, **Then** comments show newest-first with author avatar (agent badge if applicable), relative time, "edited" marker, and a markdown composer.
3. **Given** a comment body containing `@` followed by a name, **When** typing, **Then** a user picker suggests users; the stored body encodes mentions as `[~accountId:<id>]` (Jira-style) and renders as the user's name.
4. **Given** a non-author non-admin, **When** they try to edit/delete a comment, **Then** the API returns `403`.
5. **Given** the Activity section, **When** the user selects All, **Then** comments and history entries are interleaved chronologically.

### US4 — Delete issues and manage projects (P2)

As a user, I want to delete issues and update or delete projects so that I can keep the workspace clean.

**Acceptance scenarios**

1. **Given** `DELETE /rest/api/2/issue/{key}`, **When** the issue has subtasks and `deleteSubtasks` is not `true`, **Then** the response is `400`; otherwise the issue (and subtasks) are deleted and `204` is returned.
2. **Given** the issue page "…" menu, **When** a user chooses Delete, **Then** a confirmation dialog appears and, on confirm, they return to the list.
3. **Given** `PUT /rest/api/2/project/{key}`, **When** called, **Then** name, description and lead can be changed (key change is out of scope).
4. **Given** `DELETE /rest/api/2/project/{key}`, **When** called by an admin, **Then** the project and its issues are deleted; the UI requires typing the project key to confirm.
5. **Given** the sidebar "Project settings", **When** enabled, **Then** it opens a Details page (name, description, lead, avatar colour) and a Danger zone (delete).

### US5 — Link related issues (P3)

As a user, I want to link issues (blocks, relates to, duplicates) so that dependencies are visible to people and agents.

**Acceptance scenarios**

1. **Given** `GET /rest/api/2/issueLinkType`, **When** called, **Then** seeded types Blocks, Relates, Duplicate, Cloners are returned with inward/outward names.
2. **Given** `POST /rest/api/2/issueLink` and `DELETE /issueLink/{id}`, **When** called, **Then** links are created/removed and appear in `fields.issuelinks` on both issues.
3. **Given** the issue page, **When** links exist, **Then** a "Linked issues" panel groups them by relationship.

---

## Edge cases

- Concurrent edits: last write wins, but the UI refetches after save and shows a non-blocking notice if the server value differs from what the user saw.
- Deleting a parent epic does not delete its children; children's `parent` is cleared (changelog entry written).
- Mention of a deactivated user renders as plain text with an inactive marker.
- Labels: no spaces (Jira rule); max 255 chars; case-sensitive.
- Markdown rendering must be sanitised (no raw HTML, no `javascript:` links).

## Functional requirements

- **FR-001**: Summary, description, priority, type, assignee, labels, due date and parent MUST be editable via UI and `PUT /issue/{key}` (`fields` and `update` forms).
- **FR-002**: Resolution, labels, due date, parent and resolution date MUST appear in issue responses, `/field`, `createmeta` and `editmeta`.
- **FR-003**: Hierarchy MUST be validated by issue-type `hierarchyLevel`.
- **FR-004**: Comments MUST be Jira v2 compatible, attributed, and recorded in the activity stream.
- **FR-005**: Mentions MUST be stored as `[~accountId:<id>]` and resolved at render time.
- **FR-006**: Issue and project deletion MUST follow Jira semantics and be audit-logged.
- **FR-007**: Every change MUST write changelog entries (labels, parent, resolution, due date included).

## API surface

| Method | Path | Notes |
|---|---|---|
| PUT | `/rest/api/2/issue/{key}` | + `update` operations, new fields |
| DELETE | `/rest/api/2/issue/{key}?deleteSubtasks=` | Jira |
| GET/POST | `/rest/api/2/issue/{key}/comment` | Jira |
| GET/PUT/DELETE | `/rest/api/2/issue/{key}/comment/{id}` | Jira |
| GET | `/rest/api/2/resolution` | Jira |
| GET | `/rest/api/2/label` | Jira (paged) |
| PUT/DELETE | `/rest/api/2/project/{key}` | Jira |
| GET | `/rest/api/2/issueLinkType` · POST `/issueLink` · DELETE `/issueLink/{id}` | Jira (P3) |

## Data model changes

- **Issue**: `labels` (relation or string array), `dueDate?`, `resolutionId?`, `resolutionDate?`, `parentId?` (self-relation).
- **Resolution**: `id`, `name`, `description`.
- **Comment**: `id`, `issueId`, `authorId`, `body` (markdown), `createdAt`, `updatedAt`, `channel`.
- **Mention** (derived index): `commentId`, `userId` — used by notifications in 011.
- **IssueLinkType** / **IssueLink** (P3).
- **Project**: `leadId`, `avatarColor`.

## MCP tools added

`update_issue` (new fields + label add/remove), `add_comment`, `list_comments`, `edit_comment`,
`create_subtask`, `get_children`, `delete_issue` (requires `write` scope and a prior `dry_run` preview
token, so agents cannot delete in one blind step), `link_issues` (P3), `list_link_types` (P3).

## AI-native checklist

- [ ] New fields appear in metadata (A3).
- [ ] All writes idempotent + dry-run (A4).
- [ ] Comments and changes attributed with channel (A2).
- [ ] Destructive agent actions require a preview step (A7 groundwork).

## Success criteria

- **SC-001**: A user can update all editable fields of an issue without a page navigation (Playwright journey).
- **SC-002**: Comment CRUD, mentions and permission rules covered by integration tests; e2e covers posting a comment.
- **SC-003**: Agent eval set (from 007) extended with 5 tasks using comments, labels and subtasks; ≥ 90% pass.

## Risks

| Risk | Mitigation |
|---|---|
| Rich-text scope explodes | D6: markdown only; ADF deferred to v3 work |
| Inline editors become inconsistent | Build one `InlineEdit` primitive used by all fields |
| Delete cascades surprise users | Confirmation dialogs; Jira `deleteSubtasks` semantics; audit log |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Seed data includes an epic with children, labels and comments for demo.

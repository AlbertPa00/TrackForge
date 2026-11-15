# Feature Specification: Editable Issues & Collaboration

**Source doc**: [`docs/sprints/008-editable-issues-collaboration.md`](../../docs/sprints/008-editable-issues-collaboration.md) — full user stories/FRs there.

## Scope decisions

- `PUT /issue/{key}` accepts both `fields` (set) and `update` (add/remove/set ops) in one call; `update` ops are applied after `fields`.
- Labels: case-sensitive, no spaces, ≤255 chars; `GET /rest/api/2/label` paginated for suggestions.
- Hierarchy validated by `IssueType.hierarchyLevel`: subtasks require `fields.parent` → non-subtask issue in the same project; story/task/bug may parent to an Epic. `GET /issue/{key}/children` (native) lists children either way.
- Resolution: seeded Done / Won't Do / Duplicate / Cannot Reproduce; `resolution` + `resolutiondate` in responses, `/field`, createmeta, editmeta.
- Comments: Jira v2 paged list, author/created/updated/channel, markdown body. Mentions stored as `[~accountId:<id>]`, resolved at render time; unknown ids render as "inactive user". Only author or admin can edit/delete (403 otherwise).
- Issue delete: `DELETE /issue/{key}?deleteSubtasks=` — 400 if subtasks exist without the flag. All deletes require a `confirmToken` obtained from a `?dryRun=true` preview of the same delete (agent-safe destructive ops; MCP `delete_issue` is a two-step tool).
- Epic delete clears children's `parent` (children survive); subtask delete is direct.
- Project: `PUT /project/{key}` (name, description, lead, avatarColor — key immutable); `DELETE /project/{key}` admin-only, cascades issues/sprints/history/links, audit-logged.
- Issue links: seeded Blocks / Relates / Duplicate / Cloners; `fields.issuelinks` on both sides.
- Markdown (descriptions + comments) is rendered via `marked` + `DOMPurify` — no raw HTML, no `javascript:` links.
- Frontend: one `InlineEdit` primitive (click → edit, Enter/blur saves, Esc cancels, `e` shortcut for summary) reused across fields; `ActivitySection` tabs All/Comments/History interleaving comments and changelog entries.
- MCP: `update_issue` extended (labels set + add/remove ops, due date, resolution, issue type, parent); new tools `add_comment`, `list_comments`, `edit_comment`, `create_subtask`, `get_children`, `delete_issue` (two-step confirm token), `link_issues`, `list_link_types`.
- Implemented: US1–US5 (inline editing, fields, hierarchy, comments/mentions, deletes, project settings, issue links).
- Deferred: attachments, worklogs, watchers/votes (011), components/versions, custom fields, ADF/v3.

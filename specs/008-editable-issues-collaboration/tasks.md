# Tasks — Sprint 008: Editable Issues & Collaboration

## Done

- [x] Schema + migration `collaboration`: Resolution, Comment, Mention, IssueLinkType, IssueLink; Issue.labels/dueDate/resolution/resolutionDate/parentId; Project.leadId/avatarColor; seeded resolutions + link types
- [x] `PUT /issue/{key}` — new fields (labels, duedate, resolution, parent, issuetype) + Jira `update` ops (`labels` add/remove)
- [x] Hierarchy validation — subtask requires parent, same project, `hierarchyLevel` rules; `GET /issue/{key}/children`
- [x] `GET /resolution`, `GET /label` (paged), `GET|POST /issue/{key}/comment`, `GET|PUT|DELETE .../comment/{id}` — author-or-admin guard, channel attribution, `[~accountId:]` mentions + `Mention` index
- [x] `DELETE /issue/{key}` — `deleteSubtasks` semantics + `confirmToken` two-step (dry-run preview bound to key+params+principal); epic delete clears children's parent
- [x] `PUT|DELETE /project/{key}` — name/description/lead/avatarColor update; admin-only cascade delete; both audit-logged
- [x] `GET /issueLinkType`, `POST /issueLink`, `DELETE /issueLink/{id}` + `fields.issuelinks` on both issues
- [x] `/field`, createmeta, editmeta updated; OpenAPI paths for all new routes — drift test green
- [x] Changelog entries for every new field (labels, parent, resolution, duedate, links)
- [x] MCP: `update_issue` extended; `add_comment`/`list_comments`/`edit_comment`, `create_subtask`, `get_children`, `delete_issue` (two-step), `link_issues`, `list_link_types`
- [x] Frontend: `InlineEdit` primitive (click/Enter/blur/Esc, `e` shortcut, `startEditing` re-trigger), `Markdown` + `MarkdownEditor` (sanitised), `LabelsEditor`, `ActivitySection` (interleaved tabs + mention composer), `ChildIssuesPanel` (progress + inline create), `LinkedIssuesPanel` (grouped + add/remove), `IssueActionsMenu` (preview → confirm → navigate back), `ProjectSettingsPage` + sidebar route enabled
- [x] Tests: `collaboration.test.ts` 9 tests (comments/permissions, mentions, hierarchy, deletes, labels, update ops, links, project mgmt); full suite **84/84 green**
- [x] `eval/run.ts` extended — **25/25 scripted assertions green** against live API (labels ops, duedate+resolution, comment CRUD, subtask+children, links, two-step delete)

## Deferred

- [ ] Watchers/votes, attachments, worklogs (sprint 011 scope)
- [ ] Components/versions, custom fields, ADF (v3 API)
- [ ] Admin user/token/audit UIs (API-complete since 006)

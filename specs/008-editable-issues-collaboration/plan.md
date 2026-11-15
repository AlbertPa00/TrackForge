# Plan — Sprint 008: Editable Issues & Collaboration

## Architecture

- Prisma additions: `Resolution`, `Comment`, `Mention`, `IssueLinkType`, `IssueLink`; `Issue.labels` (String[]), `dueDate`, `resolutionId`, `resolutionDate`, `parentId` (self-FK); `Project.leadId`, `avatarColor`.
- `commentService` — CRUD + mention extraction (`[~accountId:<id>]` → `Mention` rows); author-or-admin guard (403).
- `linkService` — link types seeded; create/delete links, both sides surface in `fields.issuelinks`.
- `issueService` — new fields in `planCreate`/`planUpdate`, `update` ops engine (`add`/`remove`/`set`), hierarchy validation via `hierarchyLevel`, `deleteIssue` with confirmToken (dry-run preview → sha256 token bound to key+params+principal), `getChildren`.
- `projectService` — `updateProject` (name/description/lead/avatarColor), `deleteProject` with ordered cascade (change items → history → links → parent refs → issues → sprints → project).
- OpenAPI paths added for every new route; Express-stack drift test stays green.
- Frontend: `InlineEdit` (input/select/textarea), `Markdown`/`MarkdownEditor` (marked + DOMPurify), `LabelsEditor` (chips + `/label` suggestions), `ActivitySection` (All/Comments/History tabs + mention composer), `ChildIssuesPanel`, `LinkedIssuesPanel`, `IssueActionsMenu` (delete via preview → confirm modal), `ProjectSettingsPage` (details + admin-only danger zone).
- `toUserResponse` gains `isAdmin` (additive) so the UI can gate admin actions.

## New dependencies

- `marked`, `dompurify` (frontend) — markdown render + sanitize. DOMPurify ships its own types (no `@types/` needed).

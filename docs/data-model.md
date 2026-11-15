# Data Model Plan

Maps DESIGN.md §17 (~55 tables) to the Prisma schema and the sprint roadmap
(`docs/sprints/`). Each entity lands exactly once, in the sprint that needs it.

**Current schema** (`apps/backend/prisma/schema.prisma`): 112 models as of
sprint 065 — the 17 core Jira-parity entities below (`Project`, `Sprint`,
`Issue`, `IssueType`, `Status`, `Priority`, `User`, `ApiToken`, `ChangeHistory`,
`ChangeItem`, `AuditEvent`, `IdempotencyRecord`, `Resolution`, `Comment`,
`Mention`, `IssueLinkType`, `IssueLink`) plus later sprints' permissions,
workflow, screens, dev-integrations, AI, automation, backup and ops tables.
The per-sprint sections are delivery history, not a current-state mirror —
schema.prisma is the source of truth.

## Implemented

| Prisma model | DESIGN.md table | Since | Notes |
|---|---|---|---|
| `Project` | `project` (subset) | 001 | key, name, projectType; +`issueCounter` in 005 |
| `Issue` | `issue` (subset) | 001 | summary/description; `sprintId` in 004; user FKs in 006 |
| `IssueType` | `issue_type` | 001 | seeded Epic/Story/Task/Bug/Subtask |
| `Status` | `status` | 001 | category → Jira statusCategory key |
| `Priority` | `priority` | 001 | seeded 5 levels |
| `Sprint` | `sprint` | 004 | lifecycle: future→active→closed |
| `User` | `app_user` | 006 | type human/agent, owner, admin, active, scrypt passwordHash |
| `ApiToken` | `api_token` | 006 | `tfp_` sha256, scopes, projectKeys allow-list, expiry, revokedAt, lastUsedAt |
| `ChangeHistory` + `ChangeItem` | `issue_change` (split) | 006 | Jira changelog: author, channel, tokenId + field-level items |
| `AuditEvent` | `audit_log` | 006 | auth/user/token/issue writes: actor, action, entity, details, ip, UA |
| `IdempotencyRecord` | — (TF-native) | 007 | per-principal key, sha256 body hash, stored response, 24 h TTL |
| `Resolution` | `resolution` | 008 | seeded Done/Won't Do/Duplicate/Cannot Reproduce |
| `Comment` | `comment` | 008 | markdown body, author, channel; `Mention` index for `[~accountId:]` |
| `IssueLinkType` + `IssueLink` | `link_type`/`issue_link` (approx) | 008 | Blocks/Relates/Duplicate/Cloners, inward/outward names |

## Sprint 006 — delivered

Delivered as specced in `specs/006-identity-tokens-audit/`: `Issue.assigneeId`/
`reporterId` are real FK→`User.id`. Change history shipped as
`ChangeHistory`/`ChangeItem` (planned for 008 as `IssueChange` — landed early
because attribution required it). `UserGroup*` deferred (no teams yet).

## Sprint 007 — delivered

`IdempotencyRecord` (TF-native, no DESIGN.md table): `key`, `actorId`,
`method`, `path`, `bodyHash` (sha256), `status`, `responseJson`, `expiresAt`
(24 h). Metadata endpoints describe existing models (A3); no domain tables
added beyond this.

## Sprint 008 — delivered

Delivered as specced in `specs/008-editable-issues-collaboration/`:

- `Resolution` (pulled forward from 009 — Jira-correct Done semantics now live),
  `Comment` + `Mention` (mention index, `[~accountId:<id>]` per FR-005),
  `IssueLinkType` + `IssueLink` (P3, shipped with the sprint).
- `Issue`: `labels` as `String[]` (Postgres array — simpler than `Label`+
  `IssueLabel` join tables; `GET /label` aggregates distinct values),
  `dueDate`, `resolutionId`, `resolutionDate`, `parentId` (self-FK for
  subtasks and epic children).
- `Project`: `leadId`, `avatarColor`.
- Deferred to 011+: `IssueWatcher`, `IssueVote`, `Attachment`, `Worklog`
  (watchers/votes belong with events/notifications; attachments need file
  storage; worklogs need estimate fields from 013).

## Sprint 009 — Workflow engine & board config

| Entity | DESIGN.md | Purpose | Status |
|---|---|---|---|
| `Workflow` | `workflow` | named workflows + `version` | ✅ shipped |
| `WorkflowStatus` | `workflow_status` | workflow→status ordering + `isInitial` | ✅ shipped |
| `WorkflowTransition` | `workflow_transition` | named transitions, `fromStatusId` null=global, `screenFields[]` | ✅ shipped |
| `TransitionRule` | matching tables | conditions/validators/post-functions as `kind`+`type`+`config` on one table | ✅ shipped (unified) |
| `WorkflowScheme` + `WorkflowSchemeMapping` | matching | project→workflow binding | Simplified: `Project.workflowId` (per-type schemes deferred) |
| `Board` + `BoardColumn` + `BoardColumnStatus` | `board` | persisted board: type, column→status mapping, `minIssues`/`maxIssues` WIP | ✅ shipped |
| `Issue.rank` | `issue.rank` | LexoRank (fixed-width base36), indexed, `spreadRanks` rebalancing | ✅ shipped |
| `Resolution` | `resolution` | needed for Jira-correct Done semantics (unresolved vs resolved) | ✅ shipped in 008 |

Also `issue_type_scheme*` — defer (nice-to-have, not blocking).

## Sprint 010 — JQL engine & search

| Entity | DESIGN.md | Purpose | Status |
|---|---|---|---|
| `Filter` | `saved_filter` | UUID id, owner, `jql`, `visibility` (private/all) | ✅ shipped |
| `FilterFavourite` | favourites join | `@@unique([filterId, userId])` | ✅ shipped |
| `UserPreference` | — | per-user `key`/`value` (`issueTable.columns`…) | ✅ shipped (TF-native) |
| `Dashboard` + `DashboardGadget` | matching | defer to a reporting sprint unless spec promotes | deferred |

Search indexes: generated `searchVector tsvector` on `Issue` (summary+description,
weighted) and `Comment` (body), each with a GIN index — `plainto_tsquery`
serves `~`/`!~` (supersedes the `pg_trgm` idea; FTS + stemming covers it).

## Sprint 011 — Events, webhooks, realtime

| Entity | DESIGN.md | Purpose | Status |
|---|---|---|---|
| `DomainEvent` | (not in DESIGN) | transactional outbox: BigInt id, type, occurredAt, actorId, channel, projectId, issueId (nullable — survives deletes), payload (snapshot+changelog), dispatchedAt | ✅ shipped |
| `Webhook` | `webhook` | url, `events[]` filter, `jqlFilter`, `secret`, `enabled`, `failureCount`, `excludeActorIds` | ✅ shipped |
| `WebhookDelivery` | delivery log | per-attempt queue: `attempt`, `nextAttemptAt`, `responseCode`, `latencyMs`, `error` | ✅ shipped |
| `Watcher` | `issue_watcher` | `@@unique([issueId, userId])` | ✅ shipped |
| `Notification` | `notification` | userId, eventId→`DomainEvent`, reason (assigned/mentioned/watching), `readAt` | ✅ shipped |
| `RecentView` | — | `@@unique([userId, issueId])`, `viewedAt` — server-side recents | ✅ shipped (TF-native) |

The outbox supersedes the earlier "derive events from `IssueChange`" idea —
changelog rows describe *what changed on an issue*; `DomainEvent` additionally
covers non-issue mutations (boards, sprints, workflows), carries the actor's
channel, and is the dispatch cursor for webhooks/notifications/SSE.

## Sprint 012 — AI copilot & human-in-the-loop

| Entity | DESIGN.md | Purpose | Status |
|---|---|---|---|
| `AiSettings` | — | singleton provider config (provider, baseUrl, AES-256-GCM `apiKey`, chat/embed models, promptLogging, daily/monthly budgets) | ✅ shipped (TF-native) |
| `AiUsage` | — | per-user daily request counters + global monthly token usage — budget enforcement | ✅ shipped (TF-native) |
| `AiPromptLog` | — | opt-in prompt audit, secrets redacted | ✅ shipped (TF-native) |
| `Proposal` | new (not in DESIGN) | parked gated write: method/path/body/diff/rationale/channel/principal/token/linkage/expiresAt → approve=revalidate+replay, reject, bulk — A7 | ✅ shipped |
| `IssueEmbedding` | — | `Float[]` vector + app-code cosine (lightweight; pgvector swap deferred to 016) | ✅ shipped (TF-native) |
| `Project.aiEnabled` | — | per-project AI exclusion — retrieval, context, copilot tools | ✅ shipped |
| `User.requireApproval` / `ApiToken.requireApproval` | — | marks a principal's public writes as approval-gated | ✅ shipped |
| `ChangeHistory.approvedById` | — | human approver recorded beside the agent author on replayed writes | ✅ shipped |

The parked-write design supersedes the earlier "`AgentAction` + `AuditLog`" sketch:
`Proposal` stores the original request verbatim and replays it through the real
route stack on approval, so revalidation is the normal validators — not a stored
diff that could drift while the proposal sat in the inbox.

## Sprint 013 — Scrum completion — delivered

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Issue.rank` (LexoRank `String`) | sprint/board ordering | delivered in 009 — backlog+board drag now use it |
| `Issue.storyPoints` (`Float?`) | `custom_field_value` alternative | scalar column — explicit-simplicity choice vs EAV; 014 registers it as a system-managed custom field (D19) |
| `Issue.parentId` (`String?` self-FK) | epic/subtask link | delivered in 008 — Epic→Story + Subtask↔Task |
| `IssueSprint(issueId, sprintId, addedAt, removedAt)` | sprint history | membership intervals; source of truth for closed-sprint views + reports |
| `Sprint.boardId` + `completeDate` + `sequence` | `sprint` cols | sprints re-parented project→board; per-board `N` in auto-names |
| `Board.type` (`scrum`\|`kanban`) | `board` col | explicit board type; migration flips sprint-owning boards to `scrum` |
| ~~`Issue.originalEstimate/remainingEstimate`~~ | `issue` cols | **moved to 024** (013 ships story points only) |
| `SprintReport` | derived | velocity/burndown computed from `IssueSprint` intervals + `ChangeItem` — no table needed |

## Sprint 014 — Custom fields core

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `CustomField` | `custom_field` | `customfield_NNNNN` ids, per-type JQL/searcher, `systemManaged` + `alias` for Jira-modeled CFs (Story Points→013 column, Flagged, Start date) (D19) |
| `CustomFieldContext` + `CustomFieldOption` | `custom_field_context/option` | per-project option sets incl. cascading |
| `CustomFieldValue` | `custom_field_value` | JSONB join table (D10) |
| Field registry (no table) | — | system + CF metadata for serializer/`/field`/meta/JQL |

## Sprint 015 — Permissions core

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Group` + `GroupMember` | `user_group`, `group_member` | membership incl. agents |
| `ProjectRole` + `ProjectRoleActor` | `project_role*` | per-project users/groups |
| `PermissionScheme` + `PermissionGrant` | `permission_scheme`, `permission_grant` | §15.1 grants to role/group/user/logged-in/reporter/assignee/lead |

## Sprint 016 — Platform reliability

No Postgres tables (BullMQ state in Redis); optional `JobRecord` mirror decided in 017.

## Sprint 017 — Jira Cloud importer

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `MigrationJob` | `migration_job` | staged resumable import (runner jobs) |
| `ExternalIdMap` | — (D15) | Jira↔TF id provenance, idempotent re-import |
| `IssueKeyAlias` | — (TF ext) | old-key resolution after key-preserving/conflicting imports |

## Sprint 018 — Attachments

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Attachment` | `attachment` | file metadata + storage path + thumbnail; bytes behind `AttachmentStore` port (D12) |

## Sprint 019 — Components & versions

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Component` | `component` | lead + default assignee |
| `Version` | `version` | released/archived/dates/sequence |
| `IssueComponent` · `IssueVersion` | `issue_component`, `issue_version` | `fix`/`affects` kinds |

## Sprint 021 — Admin console

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `ProjectCategory` + `Project.categoryId` | `project_category` | project grouping |
| `Project.archivedAt`/`archive` flag | `project` ext | Jira project archive/restore |
| `User.active` (exists since 006) | `app_user.active` | now enforced everywhere: deactivate, never delete |

## Sprint 022 — Issue operations

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `IssueVote` | `issue_vote` | one vote per user |
| `RemoteIssueLink` | `remote_issue_link` | external URL links |
| `Issue.environment` | `issue` col | env field (Jira system field → column, D19) |
| (Flagged) | `custom_field` | system-managed CF from 014 — **no column** |
| (Stars) | — | **dropped** — not a Jira feature |

## Sprint 023 — Bulk operations & export

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `BulkJob` | — (TF ext) | user-facing record: results, retry-failures (execution via 016 runner) |

## Sprint 024 — Time tracking & worklogs

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Issue.originalEstimateSec/remainingEstimateSec` | `issue` cols | `timetracking` fields (timeSpent derived) |
| `Worklog` | `worklog` | author/seconds/started/comment |

## Sprint 026 — Dashboards & gadgets

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Dashboard` + `DashboardGadget` | `dashboard`, `dashboard_gadget` | layout; sharing via `DashboardSharePermission` rows (Jira share permissions, not scope columns) |

## Sprints 027–028 — Reports

No new tables — derived from `ChangeItem`, `IssueSprint`, `Worklog`, `Version`
(`ReportCache` reserved behind the report port if profiling demands it).

## Sprint 029 — Email & notification schemes

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `NotificationScheme` + `NotificationSchemeEntry` | `notification_scheme`, `notification_event` | event→channel→recipients |
| `NotificationPreference` | — | per-user channel toggles + auto-watch |
| `FilterSubscription` | `filter_subscription` | scheduled filter emails |
| `EmailOutbox` | — | send log + retries (016 scheduler) |

## Sprint 031 — Scheme layer & issue security

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Screen` + `ScreenTab` + `ScreenTabField` | `screen*` | create/edit/view field sets |
| `ScreenScheme` + `IssueTypeScreenScheme(+Entry)` | `screen_scheme*` | screen per operation per type |
| `FieldConfiguration(+Item)` + `FieldConfigurationScheme(+Entry)` | `field_configuration*` | required/hidden/default per field |
| `IssueTypeScheme(+Item)` | `issue_type_scheme*` | project→allowed types |
| `WorkflowScheme` + `WorkflowSchemeMapping` | `workflow_scheme*` | issue type → workflow |
| `IssueSecurityScheme` + `SecurityLevel(+Member)` + `Issue.securityLevelId` | `issue_security*` | issue-level visibility |
| `Comment.visibility` · `Worklog.visibility` | `visibility` cols | role/group restriction |

## Sprint 032 — JQL completion

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `FilterSharePermission` + favorites join | `saved_filter` extension | Jira share permissions + `filter =` subqueries |

## Sprint 033 — Boards & navigator polish

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `Board` gains `filterId`/`cardConfig`/`createdBy` (`projectId` already non-unique + `isDefault` from 009 FR-007) | `board` ext | multi-board per project |
| `BoardQuickFilter` | `board_quick_filter` | name+JQL chips |
| `UserViewPreference` | — | column/group layouts per user |

## Sprint 034 — Automation & agent triage

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `AutomationRule` | — (TF/Jira-Automation) | trigger/conditions/actions, scoped, versioned |
| `AutomationRun` | — | step-level run log incl. agent-proposal provenance |

## Sprint 036 — Identity

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `User.locale/timezone/prefs/totp*/mustChangePassword` | `app_user` cols | §15.5 + prefs |
| `OidcIdentity` + `IdentityProvider` | — | SSO account linking |
| `Session` | — | enumerate/revoke |

## Sprint 038 — Git integration & dev panel

| Entity | DESIGN.md | Purpose |
|---|---|---|
| `DevRepository` | — | provider + webhook secret + project map |
| `DevelopmentItem` + `DevelopmentItemIssue` | — | branch/commit/PR/build/deploy linked to issues |
| `DevDelivery` | — | webhook receipt log (dedupe/debug) |

## Deferred (post-046 / Phase 8)

`plugin*`, portfolio/initiative hierarchy, `report_template` (custom report
builder), `mail_queue` beyond `EmailOutbox`, SCIM/directory sync tables,
cross-project board tables (if 033's multi-board model proves insufficient).


## Documented divergences

| DESIGN.md | Implemented | Rationale |
|---|---|---|
| `sprint_issue` join table | `Issue.sprintId` | Jira allows one sprint per issue; join adds nothing |
| `custom_field_value` EAV | `CustomFieldValue` JSONB join (D10); `storyPoints` keeps its column via a storage adapter (D19) | Jira API shapes; storage chosen per explicit-simplicity |
| `app_user` | `User` (Prisma naming) | Prisma model names match existing style |
| `board` table required | implicit per-project board | Board config lands in 009 |

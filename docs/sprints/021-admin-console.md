# Sprint 021 — Admin Console & Metadata Management

| | |
|---|---|
| **Status** | **Implemented** — backend + `/admin` console UI + project settings complete; backend 802 + frontend 37 tests green. |

> **Implementation state (2026-11):** ✅ migration `021_admin` (`ProjectCategory`, `Project.categoryId`, `Project.archived`) · `PATCH /api/internal/users/:accountId` + email-dup fix · audit filters + `format=csv` · `/api/internal/projectcategories` CRUD · `/api/internal/system/modules` toggles · `POST /project/{k}/archive|restore` + archived write-blocking · `/api/internal/metadata/{entity}` CRUD · `/rest/api/2/groups/picker` · `POST /permissionscheme/{id}/permission/preview` (grant impact) · OpenAPI + MCP tools. **Admin console UI:** `RequireAdmin` (non-admin → 404) + `AdminLayout` sidebar · `/admin/users` (create/edit/deactivate, last-admin protected) · `/admin/groups` (+picker) · `/admin/tokens` (per-user fan-out, revoke, audit deep-link) · `/admin/audit` (actor/action/entity/date filters, paging, JSON detail, CSV export, deep-link params) · `/admin/metadata` (5 vocab tabs, server integrity errors) · `/admin/schemes` (grant tables, add/remove, impact preview, security levels) · project settings: People/Schemes tabs + permission scheme + category select · Projects page category filter. Frontend tests: admin.test (5) + projects.test (1); backend: permissions.test preview (18/18). Deferred: Playwright admin-onboarding e2e; SC-4 agent-eval wiring exists via `query_audit`. **If `main.ts` is rewritten, re-add mounts: `worklogRouter` (`/rest/api/2/worklog`), `systemRouter` + `metadataRouter` (`/api/internal`).**
| **Milestone** | M2 Daily-driver parity |
| **Theme** | Operability — the missing back office (single owner of all admin UI) |
| **Depends on** | 006 (users/tokens/audit APIs), 009 (workflow admin APIs), 014 (CF admin APIs), 015 (roles, groups, schemes), 016 (job inspection API), 017 (migration wizard to host) |
| **Unblocks** | Self-serve administration; 031 project-centric scheme editors; 029 mail settings page |
| **Spec-kit folder** | `specs/021-admin-console/` |

> **Replan corrections (2026-11-07):** (1) **Ownership**: 021 is the single owner of the `/admin`
> shell and admin UX patterns; 014/015/017 ship only minimal functional tables that 021
> consolidates; later sprints (029 mail, 031 schemes, 034 automation, 038 repos) add pages into
> this shell rather than building their own. (2) **Added scope** — gaps nobody owned:
> **project templates & types** at creation (Jira `projectTypeKey: software|business`,
> `projectTemplateKey` for Scrum / Kanban / basic — seeds board type, workflow, issue types;
> today's create dialog ignores `projectTypeKey`) and **project archive/restore** (Jira
> `POST /rest/api/2/project/{key}/archive` · `/restore`; archived projects read-only and hidden
> from pickers). (3) **Jobs page** — UI for 016's `/admin/jobs`. (4) `User.active` already exists
> (006); this sprint enforces it everywhere.

## Goal

The backend can already do almost everything an admin needs — through raw API calls only.
This sprint builds the `/admin` surface Jira calls "System administration" + project-level
admin, so nothing requires `curl` or DB access:

- **User management**: create/edit/deactivate/reactivate, reset password, group membership.
- **Group management**: CRUD + members.
- **Token management**: list/revoke PATs, create scoped tokens, per-token audit drill-down.
- **Audit log viewer**: filterable by actor/action/entity/date, exportable.
- **Metadata editors**: issue types, statuses, priorities, resolutions, link types, workflows
  (009 backend), custom fields (014), permission/security schemes (015).
- **Project admin tab** in project settings: category, roles, schemes, components/versions
  tabs (stubs that light up in 019).
- **System page**: version, storage, seed/health, rate-limit config — plus **module toggles**
  (instance feature flags: `ai`, `automation`, `devPanel`, `importers` on/off; the per-project
  `aiEnabled` precedent generalised; this is the mechanism future feature packs hang off).

## Why now

Six sprints of admin-capable backend have accrued (006 users/tokens/audit, 009 workflows,
014 fields, 015 schemes) with zero management UI. Building one console now is far cheaper
than bolting admin screens onto each later feature.

## Scope

**In**: `/admin` route tree behind `ADMINISTER` (site admin) with the sections above;
project settings gains Roles/Schemes/Category tabs (`ADMINISTER_PROJECT`); every editor is
a functional table + dialog (no designer polish); audit export CSV; user deactivation
(replaces delete — Jira semantics: referenced users can't be deleted); global "System" page.

**Out**: visual workflow designer (009 ships table-based editor; visual graph is stretch),
mail/SMTP config UI (029 adds the sending — form lives here), backup UI (017/039), license/quota
concepts (not applicable).

---

## User stories

### US1 — User & group management (P1)

As an admin, I want to manage people without API calls.

**Independent test**: create a user, add to a group, deactivate, confirm the user cannot log
in or be assigned, reactivate.

**Acceptance scenarios**

1. **Given** `/admin/users`, **When** "Create user", **Then** displayName/email/username/password + optional groups are collected; duplicate email returns a field error (not 500 — closes the 008 `updateUser` gap).
2. **Given** a referenced user, **When** "Deactivate", **Then** `active=false`: login, PATs, assignable search and pickers exclude them; mentions render as `inactive user` (008 marker); history/audit stay attributed.
3. **Given** `/admin/groups`, **When** managing members, **Then** additions/removals reflect in 015 permission resolution immediately.

### US2 — Tokens & audit (P1)

As an admin, I want to see and revoke credentials and answer "who did what".

**Acceptance scenarios**

1. **Given** `/admin/tokens`, **When** listed, **Then** PATs show owner, scopes, project allow-list, last-used; revoke is one click with confirm.
2. **Given** `/admin/audit`, **When** filtered by actor/action/entity/date range, **Then** matching audit events render with JSON detail; "Export CSV" downloads the filtered set (respects `maxResults` paging internally).
3. **Given** a token row, **When** "activity", **Then** audit filters to that token id.

### US3 — Metadata editors (P1)

As an admin, I want to maintain the vocabularies (types, statuses, priorities, resolutions,
link types) and schemes Jira admins maintain.

**Acceptance scenarios**

1. **Given** `/admin/metadata`, **When** editing each entity, **Then** CRUD dialogs enforce integrity: can't delete a status referenced by a workflow or issue type in use (Jira blocks too); reordering statuses updates `sequence` and board column defaults.
2. **Given** the 009 workflow admin API, **When** `/admin/workflows`, **Then** list/create/copy/assign workflows and edit status sets/transitions/rules in the table editor; assigning a workflow remaps issues via the 009 mapping API.
3. **Given** 015 schemes, **When** `/admin/schemes`, **Then** permission/security schemes are editable grant tables; dry-run shows "n users gain / n lose each permission" before save (A7).

### US4 — Project settings completion (P2)

As a project admin, I want project-scoped administration inside the project.

**Acceptance scenarios**

1. **Given** project settings, **When** Roles tab, **Then** role membership (users+groups) is editable for that project only (015 API).
2. **Given** settings tabs, **When** Schemes, **Then** permission/issue-type/screen/security scheme assignments are pickable from existing schemes.
3. **Given** settings, **When** Category field, **Then** projects can be grouped (`projectCategory`, Jira field on `GET /project`) and the Projects page can filter by it.

---

## Edge cases

- Deactivating the last site admin is blocked.
- Metadata delete in use → clear error listing referencing objects (Jira behaviour); link-type delete is allowed (links drop) with count warning.
- Non-admin hitting `/admin/*` → 404 (existence protection, §015 FR-005).
- Project admin sees only project tabs for their project (015 `ADMINISTER_PROJECT`), not site `/admin`.

## Functional requirements

- **FR-001**: Every admin action MUST be audit-logged with actor/channel (A2) — config changes are §15.6 audit events.
- **FR-002**: All console mutations MUST have an API equivalent already tested — the console is a client, never a second backend (Principle II).
- **FR-003**: Dangerous ops (deactivate, revoke, scheme reassign, workflow swap) MUST use preview→confirm (A4/A7).
- **FR-004**: User delete MUST NOT exist — deactivate only (referential integrity + Jira parity).

## API surface

Nearly all reuse: `/api/internal/users*`, `/tokens*`, `/audit`, 009 `/workflows*`, 014
`/customfields*`, 015 `/groups`/`projectroles`/`permissionschemes`/`securityschemes`.
New only:

| Method | Path | Notes |
|---|---|---|
| PATCH | `/api/internal/users/{id}` | `active` flag, password reset |
| GET | `/api/internal/audit?format=csv` | Export |
| GET/POST/PUT/DELETE | `/api/internal/projectcategories` | New entity |
| GET | `/api/internal/system/info` | Version/health/limits |

## Data model changes

- **User.active** already exists (006) — this sprint *enforces* it consistently: login, PAT
  auth, assignable search, pickers and mention rendering all filter/flag inactive users.
- **ProjectCategory** (`name`, `description?`); `Project.categoryId?`.
- No other tables — this sprint is UI over existing APIs.

## MCP tools added

`manage_user` (create/update/deactivate — admin-scoped), `revoke_token`,
`query_audit` (paginated, compact fields), `update_project` gains `categoryId`.
(`manage_groups` ships in 015.)
Admin tools are `admin`-scoped and hidden from non-admin tokens (007 registry pattern).

## AI-native checklist

- [ ] Every admin op reachable via MCP/API before UI (A1).
- [ ] Destructive admin ops offer `dryRun` impact summaries (A4, A7).
- [ ] Audit events for all config writes (A2, §15.6).

## Success criteria

- **SC-001**: A new admin can onboard a team — create users/groups, assign roles, tune a scheme — entirely in the UI (Playwright journey).
- **SC-002**: Audit viewer answers "who deleted TF-9 and when" in ≤3 clicks; CSV matches filtered view.
- **SC-003**: Deactivated user fails login, PAT calls, and assignable-search; all previously authored content still renders.
- **SC-004**: Agent eval: "deactivate bot2 and show its last 10 audit events" completes.

## Risks

| Risk | Mitigation |
|---|---|
| Scope creep — console is unbounded | Constrained to listed sections; scheme/field/workflow editors reuse table patterns, no designers |
| Metadata delete cascades break data | In-use checks everywhere; delete only when unreferenced |
| User deactivation edge leaks (mentions, assignee) | Explicit render rules for inactive users across all components |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `compat.ts` updated: `/mypermissions`, group/role endpoints marked.
- [ ] The 008 `updateUser` email→500 defect is closed here.

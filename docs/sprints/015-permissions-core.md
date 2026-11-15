# Sprint 015 — Permissions Core (Groups, Roles, Permission Schemes)

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M1 Parity MVP |
| **Theme** | Trust boundary (P0), cut to one shippable slice |
| **Depends on** | 006 (users, tokens, audit), 009 (workflow conditions call the permission service), 014 (group-picker CF type), **pre-flight** (the 008 token-scope bypasses are already fixed — this sprint generalizes, it does not first-fix) |
| **Unblocks** | 017 (role/group import), 021 (admin console), 022 (move permission), 026 (sharing), 031 (issue security builds on the service), 034 (rule actors) |
| **Spec-kit folder** | `specs/015-permissions-core/` |

## Goal

Replace "site admin vs everyone + token allow-lists" with Jira's authorization model, at the
data/API level (D18), with a simple UX:

- **Groups** and membership (agents can be members).
- **Project roles** (Administrators, Developers, Users + custom) with per-project actors.
- **Permission schemes** as Jira objects (grants of §15.1 permissions to grantee types), one
  default scheme seeded; projects use the default unless reassigned. **UX is per-project role
  membership** — scheme *editing* is API + a functional table; polished scheme UI is 021/031.
- **One `permissionService`** that every route/service calls, enforced by an architecture test.

Issue security levels (who can *see* an issue) are deliberately split into **031** — they
require query-layer filtering everywhere and deserve their own regression budget.

## Why now

Every multi-team deployment and the importer (017) need roles/groups. The pre-flight fixes
closed the known bypasses ad hoc; this sprint makes such bypasses structurally impossible.

## Scope

**In**: groups CRUD + membership (Jira `/group`, `/group/member`, `/group/user`); project roles
+ actors (Jira `/project/{key}/role[/{id}]`, `/role`); permission schemes CRUD + grants (Jira
`/permissionscheme[/{id}[/permission]]`), project↔scheme assignment
(`/project/{key}/permissionscheme`); `/mypermissions`; `permissionService.require(actor,
permission, {project, issue?})` replacing every `requireAdmin`/`projectAllowed`/ad-hoc check
(PAT project allow-lists still intersect); workflow condition types `userInRole`,
`userInGroup`, `hasPermission` (009 pipeline); group-picker CF type (014); project settings →
"People" tab (role membership); seeded default scheme reproducing today's effective access.

**Out** (with owner): issue security schemes/levels → **031**; comment/worklog visibility
restrictions → **031**; scheme editor polish + global admin pages → **021**; LDAP/SCIM → Later.

---

## User stories

### US1 — Groups and roles (P1)

As an admin, I want groups and project roles so access is granted to sets of people.

**Independent test**: create group "agents", add bot user, make "agents" a Developer on TF;
bot edits TF issues, gets 403 on QA edits, and `mypermissions` reflects both.

**Acceptance scenarios**

1. **Given** `POST /rest/api/2/group {name}` and `POST /group/user?groupname= {accountId}`, **When** called by a site admin, **Then** the group/membership exists; `GET /group/member?groupname=` pages members (Jira shape).
2. **Given** `POST /rest/api/2/project/{key}/role/{id} {user:[accountId], group:[name]}`, **When** called by a project admin, **Then** actors are added; `GET` lists actors with `type: atlassian-user-role-actor | atlassian-group-role-actor`.
3. **Given** a user who holds a role only through a group, **When** permissions evaluate, **Then** group-derived membership counts.
4. **Given** a `group_picker` CF (014 framework), **When** set, **Then** it validates against existing groups.

### US2 — Permission schemes (P1)

As an admin, I want the §15.1 permissions configurable so teams control their projects.

**Acceptance scenarios**

1. **Given** the seeded "Default Permission Scheme", **When** inspected via `GET /permissionscheme/{id}?expand=permissions`, **Then** grants use Jira holder types: `projectRole`, `group`, `user`, `applicationRole` (= any logged-in), `reporter`, `assignee`, `projectLead`.
2. **Given** a project without `EDIT_ISSUES` for user X, **When** X edits via REST, MCP, board drag, inline edit, bulk create or transition post-function, **Then** each returns the same Jira 403 naming the missing permission (A8).
3. **Given** `GET /rest/api/2/mypermissions?projectKey=TF&permissions=EDIT_ISSUES,DELETE_ISSUES` (Jira requires `permissions`), **When** called, **Then** `havePermission` flags are accurate; the UI hides/disables controls from this response.
4. **Given** migration, **When** existing data upgrades, **Then** every project uses the default scheme; all current users are in the "Users" role, admins in "Administrators", project leads in "Administrators" of their project — and **the full pre-existing test suite passes unchanged** (FR-002).

### US3 — One enforcement path (P1)

As a maintainer, I want it impossible to add a route that forgets authorization.

**Acceptance scenarios**

1. **Given** an architecture test, **When** any route handler under `routes/` resolves a project/issue without calling `permissionService` (or a service that does), **Then** CI fails.
2. **Given** a PAT with a project allow-list, **When** its user has the permission but the token lacks the project, **Then** 404 (existence protection) — both layers must pass.
3. **Given** workflow conditions `userInRole: Developers`, **When** evaluating transitions, **Then** `GET /transitions` hides unavailable ones and `POST` rejects them (009 pipeline).

### US4 — Project people UI (P2)

As a project admin, I want to manage who's in my project without schemes knowledge.

**Acceptance scenarios**

1. **Given** project settings → People, **When** adding a user/group to a role, **Then** role actors update; the page shows effective members per role.
2. **Given** I remove the last project Administrator, **When** saving, **Then** it's blocked with a clear message (site admins always retain access).

---

## Edge cases

- `applicationRole` ("any logged-in user") excludes deactivated users; agents count as logged-in only if they have a role or group grant — documented (Jira has no agent concept).
- Group deleted while used in grants/roles → dry-run lists dependents; confirm removes grants.
- Site admin bypasses project permissions (Jira "Jira administrators" semantics) but is still audited.
- Permission evaluation is cached per request only — no cross-request cache until profiled.

## Functional requirements

- **FR-001**: Every read/write of project or issue data MUST go through `permissionService`; architecture test enforces it.
- **FR-002**: The default scheme MUST reproduce pre-sprint effective access (existing suite green without edits).
- **FR-003**: Permission failures MUST return Jira-shaped 403 naming the permission; inaccessible resources MUST 404 (no existence oracle).
- **FR-004**: Role/group/scheme changes MUST be audited (A2) and support `dryRun` with an impact summary ("n users gain/lose X") (A4/A7).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST/DELETE | `/rest/api/2/group` · `/group/member` · `/group/user` | Jira |
| GET | `/rest/api/2/role` · `/role/{id}` | Jira role definitions |
| GET/POST/PUT/DELETE | `/rest/api/2/project/{key}/role` · `/{id}` | Jira role actors |
| GET/POST/PUT/DELETE | `/rest/api/2/permissionscheme` · `/{id}` · `/{id}/permission[/{permissionId}]` | Jira |
| GET/PUT | `/rest/api/2/project/{key}/permissionscheme` | Jira assignment |
| GET | `/rest/api/2/mypermissions` | Jira (`permissions` param required) |

## Data model changes

- **Group**, **GroupMember**.
- **ProjectRole** (`name`, `description`), **ProjectRoleActor** (`roleId`, `projectId`, `userId?`, `groupId?`).
- **PermissionScheme**, **PermissionGrant** (`schemeId`, `permission`, `holderType`, `holderParam?`); `Project.permissionSchemeId`.
- `User.isAdmin` remains the site-admin flag.

## MCP tools

Core toolset: `get_my_permissions`. Admin toolset (D21): `manage_groups`, `manage_project_roles`,
`manage_permission_scheme` (dry-run first). Permission errors in every tool name the missing
permission.

## AI-native checklist

- [x] Agents can self-check with `get_my_permissions` before writing (A3).
- [x] Every denial is actionable (A8).
- [x] Scheme/role changes previewable (A4/A7).

## Success criteria

- **SC-001**: Pre-existing suite passes on the default scheme with zero test edits.
- **SC-002**: Matrix test: each §15.1 permission × each write path (REST, MCP, UI action, post-function) enforces identically.
- **SC-003**: Architecture test fails on a deliberately unprotected route (meta-test).
- **SC-004**: Agent eval: a bot with Developer role creates in TF; the same call on QA fails naming `CREATE_ISSUES`.

## Risks

| Risk | Mitigation |
|---|---|
| Refactor of every route regresses behaviour | Equivalence suite first (FR-002), then migrate routes one router at a time |
| Performance of per-request evaluation | Request-scoped memo; profile in 020 hardening |
| Users confused by schemes | UX exposes roles only; schemes are an admin/API concept |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] `docs/security-model.md`: holder types, evaluation order, token intersection, site-admin bypass.
- [x] Importer contract for groups/roles/schemes documented for 017.

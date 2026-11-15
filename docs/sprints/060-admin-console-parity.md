# Sprint 060 — Jira Admin-Console Parity: Scheme Management, User/Project Admin Depth & Issue Archiving

| | |
|---|---|
| **Status** | Implemented — all 8 slices landed; stretch: announcement banner done, status-category guard already enforced, priority schemes deferred |
| **Milestone** | Post-GA (continues the deferred-admin work of 021/031) |
| **Theme** | Close the "backend exists, no console" gap — admins manage every Jira configuration object from the UI, and the remaining DC admin surfaces (invite, anonymize, archived issues) exist at all |
| **Depends on** | 021 (admin shell + `/admin` routing), 031 (scheme backends + MCP `manage_screens`/`manage_field_configuration`), 029 (EmailOutbox for invite mail), 036 (reset-token infra for invite tokens), 053 (ARCHIVE_*/RESTORE_* keys catalogued), 015 (permission service) |
| **Unblocks** | An honest "Jira DC admin parity" claim; lossless import of priority schemes + archived issues (039/048); GDPR erasure requests |
| **Spec-kit folder** | `specs/060-admin-console-parity/` |

> **Origin**: panel-by-panel comparison against Jira DC 10.3.26 admin screenshots
> (User management, Applications, Ver proyectos, Tipos de incidencias, Projects
> nav menu). Result: backend parity is high — the gap is almost entirely the
> console layer. Six scheme types are editable only via REST or as
> bind-dropdowns in project settings; three admin capabilities (invite,
> anonymization, issue archiving) have no backend at all.

## Goal

- **Every scheme object is UI-manageable**: screens, screen schemes,
  issue-type screen schemes, field configurations + schemes, issue-type
  schemes, workflow schemes — full CRUD plus "which projects use this"
  visibility, without dropping to `curl`.
- **Project & user admin reach DC depth**: category CRUD, archived-projects
  view, issue-count columns; user table gains last-login/groups/directory
  columns, Jira-style filters, and an invite-by-email flow.
- **The three missing primitives land**: user anonymization (GDPR), issue-level
  archiving (enforcing the already-catalogued ARCHIVE_* permissions), and —
  stretch — priority schemes.

## Scope

**In**: scheme-management pages in the 021 admin shell (screens stack, field
configs, issue-type + workflow schemes); `DELETE /api/internal/workflows/:id`
+ `GET /api/internal/workflowschemes/:id` (both absent today — needed by the
editors); project-category admin UI + archived-projects view + project table
columns; user-admin columns/filters + invite flow; user anonymization;
issue-level archive/restore end to end; Projects nav dropdown with current +
recent projects; stretch: priority schemes, announcement banner,
`Status.category` write-constrained to Jira category keys.

**Out**: licensing/seats, application roles/links/navigator — documented
divergences (`docs/capability-matrix.md`; OAuth2.1 from 049 supersedes app
links). Metadata translation — no i18n substrate exists; revisit when UI
localization lands. VCS connectors beyond GitLab (each is its own sprint, 051
pattern). Jira's drag-drop screen designer — already scoped out in 031,
functional ordering lists stand. Incoming-mail handlers, JSM, team-managed
projects — roadmap Later.

## Candidate user stories

### US1 — Scheme hub: issue-type & workflow schemes (P1)

As an admin, I want to edit which issue types a scheme offers and which
workflow each type maps to, from `/admin/schemes` — not just bind a scheme in
project settings.

1. **Given** `/admin/schemes`, **When** opened, **Then** tabs for *Issue type
   schemes* and *Workflow schemes* sit alongside the existing Permission and
   Issue security tabs — same tab pattern as `AdminSchemesPage`.
2. **Given** an issue-type scheme, **When** editing, **Then** an ordered
   issue-type picker + default-type selector writes `IssueTypeSchemeItem`s
   via the existing `/api/internal/issuetypeschemes` CRUD.
3. **Given** a workflow scheme, **When** editing, **Then** a default-workflow
   selector + per-issue-type mapping rows are editable (needs
   `GET /api/internal/workflowschemes/:id` — missing today).
4. **Given** a scheme bound to projects, **When** viewing it, **Then** the
   bound projects are listed (in-use list — mirror the permission-scheme
   delete preview) and delete is refused while bound.
5. **Given** `DELETE /api/internal/workflows/:id`, **When** the workflow is
   bound to a scheme or project, **Then** 409 naming the bindings; unbound →
   deleted. (Endpoint absent today — `routes/workflows.ts`.)

### US2 — Screens console (P1)

As an admin, I want to manage screens and the two scheme layers above them
from one page.

1. **Given** `/admin/screens` with three tabs, **Then**: *Screens* (CRUD +
   tabs + ordered field lists — functional ordering, no drag-drop per 031),
   *Screen schemes* (CRUD + default/create/edit/view operation items),
   *Issue-type screen schemes* (CRUD + issue-type → screen-scheme mappings +
   project bind/unbind).
2. **Given** a screen editor, **When** adding fields, **Then** the field list
   comes from `GET /rest/api/2/field` and ordering writes `ScreenTabField`
   rows via the existing `/api/internal/screens` endpoints.
3. **Given** an ITSS with a bound project, **When** a user opens createmeta
   for a mapped type, **Then** the UI-resolved screen matches
   `GET /api/internal/issuetypescreenschemes/{id}/resolved` (031 slice 3
   enforcement is already live — this slice is console only).

### US3 — Field-configuration console (P1)

As an admin, I want to set required/hidden/default/description and
conditional rules per field without writing JSON by hand.

1. **Given** `/admin/field-config` with two tabs, **Then**: *Field
   configurations* (item table per field: required / hidden / description /
   defaultValue + conditional-rules editor rendering `required-if` /
   `hidden-if` / `default-by` rows as field+operator+value, serialized to the
   031 `rules` JSON shape) and *Field configuration schemes* (default config
   + per-issue-type mappings + project binding).
2. **Given** a conditional rule `required when priority = High`, **When**
   created through the rule editor, **Then** the stored `FieldConfigurationItem`
   matches what `manage_field_configuration` (MCP, already shipped) produces —
   verified by an integration test creating via UI payload and asserting the
   031 enforcement fires.

### US4 — Project admin depth (P1)

As an admin, I want Jira's *Ver proyectos* surface: manageable categories, an
archived view, and activity columns.

1. **Given** `/admin/projects` (new sidebar group "Projects": *Projects*,
   *Categories*, *Archived*), **Then** the project table gains **Issues**
   (count) and **Last issue update** columns — `GET /rest/api/2/project`
   extended or an internal endpoint supplies the aggregates.
2. **Given** `/admin/projects/categories`, **When** CRUDing a category,
   **Then** the existing `/api/internal/projectcategories` endpoints are used
   (they have zero UI today — categories are assignable but cannot be created
   from the frontend).
3. **Given** `/admin/projects/archived`, **When** opened, **Then** archived
   projects list via `GET /rest/api/2/project?includeArchived` with a
   *Restore* action; non-archived rows gain an *Archive* action
   (`POST /project/{k}/archive` — shipped, UI-less today).

### US5 — User admin depth + invite (P1)

As an admin, I want Jira's *Usuarios* table: real columns, real filters, and
invite-by-email.

1. **Given** `/admin/users`, **Then** columns show *Last login*
   (`User.lastLoginAt` — already tracked since 032 for JQL `currentLogin()`),
   *Groups*, *Directory* (`ExternalIdentity` → `DirectoryConnection` name, or
   "Internal"), alongside Type/Status — backend extends
   `GET /api/internal/users` with `include=groups,directory` or embeds them.
2. **Given** the filter bar, **Then** text (existing) + group picker +
   status (all/active/inactive) + type (human/agent) filters apply
   server-side, plus a page-size selector — Jira's filter row.
3. **Given** *Invite users*, **When** submitting `{email, displayName?,
   groups[]}`, **Then** `POST /api/internal/users/invite` creates an inactive
   user + single-use invite token (reuse the 036 reset-token model),
   enqueues mail via EmailOutbox (029), and a public `/invite/:token` page
   sets the password and activates the account.
4. **Given** an expired/consumed token, **When** opened, **Then** the page
   states it and offers "request a new invite" (re-invite revokes the old
   token).

### US6 — User anonymization (P2)

As an admin, I want to honor erasure requests without breaking attribution
integrity.

1. **Given** `POST /api/internal/users/{accountId}/anonymize` with
   `?dryRun=true`, **When** called, **Then** the preview reports what will be
   scrubbed (profile fields, external identities, tokens/sessions) and a
   `confirmToken` is returned — two-step, irreversible.
2. **Given** confirmation, **Then** displayName/email become
   `user-<short-hash>` / tombstoned, `ExternalIdentity`/`OidcIdentity` rows
   are deleted, all PATs and sessions revoked, the account deactivated —
   authored content (comments, changelog, reporter/assignee refs) keeps the
   anonymized principal, Jira's "Former user" semantics.
3. **Given** the last active site admin, **When** anonymization is attempted,
   **Then** refused (same guard as deactivate).
4. **Given** the op completes, **Then** an `AuditEvent` records actor +
   target + timestamp (the audit trail itself is *not* scrubbed — document in
   `docs/compatibility.md`).

### US7 — Issue-level archiving (P2 — largest backend slice)

As a project admin, I want to archive stale issues so they disappear from
search/boards but stay recoverable — Jira DC's *Incidencias archivadas*.

1. **Given** `Issue.archived`/`archivedAt`/`archivedById`, **When**
   `PUT /rest/api/2/issue/{key}/archive` (DC wire shape — verify exact verb in
   plan; record in `docs/compatibility.md`), **Then** the issue is archived:
   permission `ARCHIVE_ISSUES` enforced (catalogued by 053, unenforced today),
   changelog + audit entries written, `?dryRun=true` preview supported.
2. **Given** an archived issue, **When** any mutation is attempted, **Then**
   rejected with a single read-only gate (same choke-point style as the
   archived-project write block in `issueService`).
3. **Given** archived issues, **When** JQL search, boards, backlog, children,
   links, dashboards, reports, exports, webhooks/SSE, or MCP reads run,
   **Then** they're excluded by one composed predicate
   (`notArchivedWhere`, sibling to 031's `visibleIssuesWhere`) with a
   leak-matrix test covering every read surface — no scattered `archived:
   false` clauses.
4. **Given** `/projects/{key}/settings?section=archived` (or a backlog view
   toggle), **When** opened by an admin, **Then** archived issues list with
   issue count + *Restore* (`/restore`, `RESTORE_ISSUES`).
5. **Given** the MCP surface, **Then** an `archive_issue` tool exists with a
   deterministic check in `apps/mcp/eval/run.ts` (D21 budget).

### US8 — Projects nav dropdown (P2)

As a user, I want Jira's *Proyectos* menu: current project, recents, and the
create/import entries.

1. **Given** the TopNav *Projects* item, **When** clicked, **Then** a dropdown
   shows *Proyecto actual* (from route context), *Proyectos recientes*
   (localStorage `tf:recentProjects` — same pattern as `recordRecentIssue` in
   `TopNav.tsx`; recorded by a `useRecordRecentProject` hook on project
   pages), *View all projects*, *Import external project* (admin only →
   `/admin/migration`), *Create project* (opens `CreateProjectDialog`).

### Stretch (P3 — only after US1–US8 clear)

- **Priority schemes**: `PriorityScheme` + ordered items + `defaultPriorityId`,
  `Project.prioritySchemeId`; `/api/internal/priorityschemes` CRUD + project
  bind; `createmeta`/`editmeta` `priority.allowedValues` filtered + write
  rejection; admin tab on `/admin/metadata` or `/admin/schemes`.
- **Announcement banner**: `SystemSetting` row, banner render under TopNav,
  admin field on `/admin/system`.
- **`Status.category` constraint**: validate writes against the Jira category
  keys (`new`/`indeterminate`/`done`) instead of free-form strings — no model,
  just the guard.

## Non-functional requirements

- **FR-001**: Every new endpoint follows the AGENTS.md contract checklist —
  zod in `lib/validation.ts`, registration in `lib/openapi.ts` (drift test
  stays green), `errorMessages` shape with allowed values, `Idempotency-Key`
  on POSTs, `?dryRun=true` on issue mutations, two-step `confirmToken` for
  destructive ops, `audit()` + `actor` threading on every mutation.
- **FR-002**: Archive filtering is a single composed predicate covered by a
  leak-matrix test hitting every issue read surface (031 slice-6 list is the
  template) — scattered `archived: false` filters are a review blocker.
- **FR-003**: Invite tokens are single-use, short-TTL, constant-time compared,
  and cannot target an existing active account (no takeover).
- **FR-004**: Scheme pages reuse the `AdminSchemesPage`/`AdminMetadataPage`
  tab+dialog patterns — no new dependencies; `pnpm typecheck && pnpm lint` at
  zero warnings.
- **FR-005**: Every new importable entity (priority scheme, `Issue.archived`)
  ships an `EntityImporter` + a threat-model entry + MCP toolset assignment —
  the standing 017+ obligations.

## API surface (candidates)

| Method | Path | Notes |
|---|---|---|
| GET/DELETE | `/api/internal/workflows/:id` | Fill the two CRUD holes (US1) |
| GET | `/api/internal/workflowschemes/:id` | Needed by the scheme editor |
| GET | `/rest/api/2/project` | Add issue-count + last-issue-updated aggregates (or internal route) |
| GET | `/api/internal/users` | `include=groups,directory` + `?status=&group=&type=` filters |
| POST | `/api/internal/users/invite` | Inactive user + single-use token + EmailOutbox |
| POST | `/api/internal/users/{id}/invite` | Re-invite (revokes prior token) |
| GET/POST | `/invite/{token}` → `/api/internal/invites/{token}/accept` | Public accept page |
| POST | `/api/internal/users/{id}/anonymize` | `?dryRun` → `confirmToken`; two-step |
| PUT | `/rest/api/2/issue/{key}/archive` + `/restore` | DC shape — verify wire form in plan |
| — | `/api/internal/priorityschemes` CRUD + `POST /projects/{k}/priorityscheme` | Stretch |

## Data model (candidates)

`InviteToken` (or extend the 036 reset-token model with a `purpose`),
`Issue.archived`/`archivedAt`/`archivedById` (indexed; composed into the read
predicate), `PriorityScheme`(+`PrioritySchemeItem`, `Project.prioritySchemeId`)
— stretch only. All screens/schemes models already exist (031).

## MCP (D21 admin toolset)

`archive_issue` + restore arg; `manage_priority_scheme` (stretch). Screen and
field-config tools shipped in 031 — add eval coverage asserting the UI and MCP
payloads serialize identically.

## Success criteria

- **SC-001**: An admin creates + edits + deletes every scheme type from the UI
  with zero API calls — screens, screen schemes, ITSS, field configs +
  schemes, issue-type schemes, workflow schemes.
- **SC-002**: Category create → assign → filter works entirely in UI;
  archiving a project hides it from `/projects` until *Archived* → *Restore*.
- **SC-003**: Invite email → `/invite/:token` → login works end-to-end against
  the seeded SMTP stub; expired token produces the re-invite path.
- **SC-004**: Anonymizing a user leaves authored content attributed to the
  tombstoned principal, revokes all credentials, and survives the last-admin
  guard (tests).
- **SC-005**: An archived issue is invisible to the full leak-matrix surface
  and restored byte-for-byte (including security level + rank) on `/restore`.
- **SC-006**: Projects dropdown shows current + ≥1 recent project; import item
  is admin-gated.

## Risks

| Risk | Mitigation |
|---|---|
| Archive predicate leaks through one read path | Single `notArchivedWhere` + leak test per FR-002; land right before a hardening sprint |
| Invite tokens become an account-takeover vector | New-user only, single-use, short TTL; audit both mint and accept |
| Anonymization breaks attribution displays | Tombstone name `user-<hash>` renders everywhere a display name does — audit UserAvatar/assignee renderers before slice starts |
| Scheme editors recreate Jira's UX complexity | Stay on the existing tab+dialog pattern; functional ordering lists, no drag-drop (031 precedent) |
| Sprint is wide (6 US + stretch) | Slices are independently shippable; P2/P3 items drop first without stranding P1 work — UI slices have no schema risk |

## Slice plan (each ships runnable)

1. US1 scheme tabs + workflow DELETE/GET holes (frontend-led, tiny backend)
2. US2 screens console
3. US3 field-config console
4. US4 project admin depth
5. US5 user admin + invite
6. US6 anonymization
7. US7 issue archiving (model → enforcement → leak matrix → browse → MCP)
8. US8 Projects dropdown
9. Stretch: priority schemes, banner, status-category guard

## Implementation status

### Slice 1 — US1 scheme hub + workflow CRUD holes (landed)

- `GET /api/internal/workflowschemes/:id` (service `getWorkflowScheme`,
  shared `schemeInclude`/`toSchemeResponse`) and `DELETE
  /api/internal/workflows/:id` (`deleteWorkflow` — in-use guard counts
  project binding + scheme default + scheme items; children deleted in a
  transaction since `WorkflowStatus`/`WorkflowTransition` have no cascade).
- `/admin/schemes` gained *Issue type schemes* and *Workflow schemes* tabs:
  ordered type lists, per-type workflow mappings, bound-project lists (from
  `schemeIds` on `GET /project`), in-use delete guards.
- `WorkflowsPage` gained a guarded Delete action.
- Tests: `workflowschemes.test.ts` 6/6 (incl. 404 + bound-delete guards).

### Slice 2 — US2 screens console (landed)

- `/admin/screens` with three tabs — Screens (tab/ordered-field editor),
  Screen schemes (per-operation selects), Issue-type screen schemes
  (default + per-type mappings + bound projects). Pure frontend on the 031
  backend; sidebar + route registered.

### Slice 3 — US3 field-config console (landed)

- `/admin/field-config` with two tabs — Field configurations (items table:
  required/hidden/description/default + a conditional-rules editor that
  serializes `when{field,is|in|isNot|empty}` + `required|hidden|defaultValue`
  into the 031 `rules` JSON) and Field configuration schemes (default +
  per-type mappings).

### Slice 4 — US4 project admin depth (landed)

- `GET /api/internal/admin/projects` — all projects incl. archived with
  `issues` count + `lastIssueUpdate` (groupBy aggregate merged into
  `toProjectResponse`).
- `/admin/projects` with three tabs — Projects (Jira *Ver proyectos* columns +
  Archive action), Categories (full CRUD — the endpoints had zero UI), and
  Archived (Restore action).

### Slice 8 — US8 Projects dropdown (landed)

- TopNav `Projects` is now a Jira-style menu: current project (from route),
  recent projects (`tf.recentProjects` localStorage, recorded automatically
  on any `/projects/{key}` route), View all / Import external (admin) /
  Create project.

### Slice 5 — US5 user admin depth + invite (landed)

- `GET /api/internal/users` gained `?status|type|group|query` filters and
  per-user `lastLoginAt`, `groups[]`, `directory` (GroupMember +
  ExternalIdentity joins).
- Invite flow: `POST /api/internal/users/invite` creates an inactive account
  + `PasswordResetToken` (reused 036 model) + emails the `/invite/:token`
  link via `getMailAdapter` (dev surfaces `x-invite-token` header);
  `POST /users/{id}/invite` re-invites; public `POST
  /api/internal/auth/invite-accept` sets the password and activates
  (`confirmInvite`). `/admin/users` shows Jira's filter row + Last login /
  Groups / Directory columns, Invite users dialog, and a Re-invite row
  action; `/invite/:token` is a public accept page.

### Slice 6 — US6 anonymization (landed)

- `POST /api/internal/users/{id}/anonymize` — two-step like deletes:
  `?dryRun=true` returns `willScrub` preview + signed `confirmToken`
  (`anonymizePreviewToken`, HMAC — same pattern as `deletePreviewToken`).
- `anonymizeUser` scrubs displayName/email to a deterministic tombstone
  (`user-<hmac10>` / `user-<hmac10>@anonymized.invalid`), nulls
  password/TOTP/backup codes, deactivates, revokes sessions + PATs, deletes
  external + OIDC identities and reset tokens — in one transaction. Last
  active admin + self-anonymize guards; authored content keeps the
  anonymized principal.
- `/admin/users` rows got an Anonymize action that previews counts in the
  confirm dialog.

### Slice 7 — US7 issue archiving (landed)

- Schema: `Issue.archived/archivedAt/archivedById` + index (migration
  `20261124000000_060_issue_archive`).
- **Single composed predicate**: `visibleIssuesWhere` now ANDs
  `{ archived: false }` — all 17 read surfaces (search, boards, backlog,
  sprints, epics, children, reports, roadmap) hide archived issues. Single
  reads + every `enforceIssueScope` route 404 them via `canSeeIssue`
  (existence-hiding, same as security levels).
- **Write gate**: `assertIssueWritable(issue)` (projectService) =
  `assertProjectWritable` + archived check — swapped into all 8 mutation
  sites (edit, transition, comments ×3, worklogs ×3) + `planDelete`, so
  archived issues are read-only even via bulk/secondary paths.
- `PUT /rest/api/2/issue/{key}/archive` + `/restore` (Jira DC shape) gated
  on `ARCHIVE_ISSUES`/`RESTORE_ISSUES` — the previously catalogued-but-
  unenforced permission keys. Restore deliberately bypasses
  `enforceIssueScope` (token allow-list still applies); both honor
  `?dryRun=true`; `issue.archived`/`issue.restored` domain events + audit.
- Browse: `GET /api/internal/projects/{key}/issues/archived`
  (RESTORE_ISSUES or admin) + a project-settings *Archived issues* section
  with Restore.
- MCP `archive_issue`/`restore_issue` tools + `MUTATION_REGISTRY` entries.
- `tests/integration/issuearchive.test.ts` 4/4 — dryRun preview, 404 leak
  matrix (GET/JQL/PUT/comment/re-archive), browse + restore round-trip.

### Stretch results

- **Announcement banner** — landed: `GET/PUT /api/internal/system/banner`
  (SiteSetting `announcement.banner`), admin card on `/admin/system`,
  site-wide strip under TopNav.
- **Status.category guard** — already enforced: `statusSchema` z.enum
  (`todo|inprogress|done`) covers the only public write path.
- **Priority schemes** — deferred: needs a new model + endpoints + console;
  a real slice, not a stretch item. Candidate for a follow-up sprint.

### Remaining

- Importer coverage for `archived` (and priority schemes if they land).



- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `docs/compatibility.md` entries for `/invite`, anonymize semantics,
  archive/restore wire shape, and any new divergences.
- [ ] `apps/mcp/eval/run.ts` gains deterministic checks for new tools.
- [ ] AdminLayout sidebar updated; every new page sits behind `RequireAdmin`.
- [ ] 048/039 importers map `archived` + priority schemes (or record
  `unsupported` explicitly — never silently dropped).

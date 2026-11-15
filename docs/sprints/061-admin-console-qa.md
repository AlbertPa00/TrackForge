# Sprint 061 — Admin Console QA Sweep: Nav Truth, Destructive Consistency, Mail UI & Missing Surfaces

| | |
|---|---|
| **Status** | Planned |
| **Milestone** | Post-GA (hardening-flavored follow-up to 060) |
| **Theme** | Close the correctness and coverage gaps a page-by-page QA of the admin console found: the sidebar lies about external pages, destructive deletes lack confirms, re-invite can un-deactivate a user, and several shipped backends (mail, notification schemes, extra importers, agent policy) have no console at all — including the one customers ask for most: **restore a backup without the CLI** |
| **Depends on** | 021 (admin shell), 060 (the audited pages), 029 (mail/notification-scheme backends), 036 (invite tokens), 044 (backupService + pgRestore), 049 (identity/directory pages), 051 (GitLab page), 017/048 (importer endpoints) |
| **Unblocks** | Working invites without SMTP UI workarounds; honest "everything admin-manageable from UI" claim; safe user deactivation |
| **Spec-kit folder** | `specs/061-admin-console-qa/` |

> **Origin**: page-by-page QA review of every admin surface (19 pages), cross-checked
> against live API behavior on a populated instance (114 users, 24 groups, 43
> projects, 413 workflows). Result: structural shape is good — every page maps
> to a working backend with delete guards and audit trails. The gaps are
> concentrated at the edges: two newest pages skip confirm dialogs, invite and
> deactivate semantics conflate, one route escapes RequireAdmin, and a cluster
> of backends never got a console.

## Goal

- **The admin nav tells the truth**: every sidebar item highlights where the user actually is; every admin-only page sits behind `RequireAdmin`.
- **Destructive actions are uniformly confirmed or two-stepped**: no silent DELETE on a single click anywhere in `/admin`.
- **User lifecycle is unambiguous**: invite ≠ deactivate — a deactivated user cannot self-reactivate via an invite link.
- **The missing consoles land**: mail config/test/outbox, notification schemes, additional migration sources, agent/approval-policy management, small user-ops gaps (rename, reset password) — and **self-service backup restore**, the capability self-hosted customers need to trust the platform without a DBA.
- **Performance holds at migrated-data scale**: no N+1 fan-outs on admin pages; heavy lists paginate or search.

## Scope

**In**: AdminLayout external-flag fix; `/settings/ai` route gating; confirm dialogs on identity/integrations deletes; invite-pending semantics for re-invite; invite-link surfacing when mail is off; mail + notification-scheme admin UI; migration wizard source coverage (jira-server, csv, jira-server-xml, project export); agent type + approvalPolicy in user admin; user rename/reset-password; admin token aggregate endpoint; users-groups dialog reuse; workflows list pagination; page-title gaps; UX polish batch (containers, CheckBadge glyph, avatar-menu dedupe, audit action datalist, SCIM token naming, SPA links, group-delete copy, brand leak, stale-draft guard); **backup restore console** — a new guarded `POST /system/backups/:id/restore` endpoint plus the System-page UI driving it.

**Out**: priority schemes (still deferred per 060); application roles/links; general site settings page beyond what already exists (`baseUrl` lives in mail config — a full *General configuration* page is a separate discussion); attachment-dir restore via UI (the manifest's attachment mirror stays a CLI step per `docs/backup-restore.md` — this sprint restores the DB dump only); redesigning the scheme pages' information architecture (renaming "Metadata" is in scope as a label change, not a restructure); Jira's drag-drop editors (out per 031/060 precedent).

## Candidate user stories

### US1 — Nav truthfulness & route gating (P1 — small, all frontend)

As an admin, I want the sidebar to reflect where I am and every admin page to be unreachable by non-admins.

1. **Given** `/settings/workflows` (or customfields/webhooks), **When** open,
   **Then** the sidebar shows the admin chrome **and** the matching nav item is
   active-highlighted — remove the stale `external` markers/↗/tooltip from
   `AdminLayout.SECTIONS` (they render inside `AdminLayout` since 042 F-027).
2. **Given** a non-admin authenticated user, **When** they navigate to
   `/settings/ai`, **Then** they see the same 404-style gate as every other
   admin page — move the route inside the `RequireAdmin` group in `App.tsx`.
3. **Given** `/admin/people`, `/admin/projects`, `/admin/screens`,
   `/admin/field-config`, **When** open, **Then** `document.title` resolves to
   specific titles — fill the `admin` map in `lib/pageTitle.ts`.
4. **Given** the dead `me.isAdmin` checks in Webhooks/CustomFields/Workflows/
   Migration pages, **When** reviewing, **Then** they are removed (unreachable
   inside `RequireAdmin`) or kept uniformly — and MigrationPage's
   "Jira-administrator" copy is corrected to TrackForge terminology (brand leak).

### US2 — Destructive consistency + invite hardening (P1 — correctness/security-adjacent)

As an admin, I want destructive ops to confirm and user status transitions to be unambiguous.

1. **Given** `/admin/identity` OAuth client and directory rows, and
   `/admin/integrations` GitLab rows, **When** Delete is clicked, **Then** a
   `ConfirmDialog` describes the blast radius (tokens minted, inbound
   provisioning, dev-panel data) before the DELETE fires — matching every
   other admin page.
2. **Given** a user row, **When** `!u.active`, **Then** *Re-invite* appears
   **only** for never-activated accounts (`lastLoginAt == null` or an explicit
   `invitedAt`/`invitePending` marker); backend
   `POST /users/{id}/invite` enforces the same guard server-side (today it
   accepts any inactive user, so a deactivated account can be mailed a link
   whose accept sets `active: true` + a new password — deactivation bypass).
3. **Given** the same row, **Then** *Re-invite* and *Reactivate* are visually
   and semantically distinct actions (re-invite = pending invite; reactivate =
   previously-active account).
4. **Given** mail is not configured, **When** an invite is created, **Then**
   the accept link is shown copyable in the UI (read `x-invite-token` in dev,
   or better: return `inviteUrl` in the response body for admins) — today the
   toast says "share the link manually" with no way to obtain it.
5. **Given** `confirmInvite`, **When** the token holder's account was
   deactivated by an admin after invite issue, **Then** decide-and-document:
   either refuse activation or make the admin intent explicit — never silently
   re-activate.

### US3 — Mail & notification admin console (P1 — highest-leverage missing surface)

As an admin, I want to configure SMTP and notification schemes from the UI — invites and notifications depend on it.

1. **Given** `/admin/mail` (new sidebar item under *System* or *Configuration*),
   **Then** a form edits `GET/PUT /api/internal/admin/mail` (host, port,
   secure, from, baseUrl), `POST /admin/mail/test` sends a test to a chosen
   address with inline result, and a read-only **outbox** tab lists
   `GET /admin/outbox` (status filter, retries visible) — endpoints exist and
   are verified live today; this is frontend-only.
2. **Given** `/admin/notifications` (or a tab on the schemes page),
   **Then** notification-scheme CRUD + project binding via the existing
   `notificationSchemeRouter` surface — decide tab placement in plan (new page
   vs `/admin/schemes` fifth tab).
3. **Given** no mail configured, **Then** the mail page shows a clear
   "not configured" state explaining which features degrade (invites, resets,
   notifications) — preempting the B5 dead-end permanently.

### US4 — Backup restore console (P1 — the customer-facing slice)

As a self-hosted admin, I want to restore a verified backup from `/admin/system` without shell access — disaster recovery must be a console capability, not a runbook.

1. **Given** the Backups card on `/admin/system`, **When** a row's *Restore* is
   clicked, **Then** a dialog shows the manifest (created-at, file count,
   sizes, checksum status) and warns in plain language — "everything after
   this backup is permanently erased; all users including you are signed
   out" — requiring a typed `RESTORE` phrase, stronger than a checkbox.
2. **Given** `POST /api/internal/admin/system/backups/:id/restore` (new
   route; `pgRestore()` already exists in `backupService.ts` — 044 shipped
   list/run/verify but never exposed restore), **When** called with
   `?dryRun=true`, **Then** it returns the manifest preview + a `confirmToken`
   per the two-step destructive convention; without it → 400.
3. **Given** the confirmed call, **Then** `verifyBackup` runs first and a
   checksum mismatch refuses with 409, then `pgRestore` is launched as a
   **detached process** — *not* the durable job runner, whose own table is
   dropped mid-restore — with progress/terminal state written to a status
   marker file under `BACKUP_DIR`. `AuditEvent` records actor + backup id
   *before* launch.
4. **Given** `GET /api/internal/admin/system/restore-status` (new),
   **When** polled, **Then** it reads the marker file — file-backed because
   the DB it would otherwise report through is being replaced; the UI shows
   progress until the session dies, then the login page + a
   "restored from \<id\> at \<ts\>" post-restore notice (site setting
   survives in the restored DB only if the backup contained it — otherwise a
   first-login flag file is acceptable).
5. **Given** attachments, **Then** the dialog states honestly that file
   restore is still the CLI step in `docs/backup-restore.md` — DB restore
   must not imply files came back too.
6. **Given** a hardened install, **Then** `TF_DISABLE_UI_RESTORE=1` removes
   the action and the route 404s — operators who want CLI-only keep it.

### US5 — Admin performance at migrated-data scale (P2)

As an admin on a populated instance, I want admin lists to load in bounded time.

1. **Given** `/admin/tokens`, **When** opened, **Then** a single
   `GET /api/internal/admin/tokens` (new aggregate endpoint joining owner)
   replaces the current 1 + N fan-out (measured 115 requests / ~865 ms
   localhost on 114 users).
2. **Given** the per-user Groups dialog, **When** opened, **Then** initial
   membership comes from the `groups[]` field `fetchAdminUsers` already
   returns — no 1 + N_groups recompute per dialog open (24 groups ≈ 25
   requests today).
3. **Given** `/settings/workflows` with 413 workflows, **When** opened,
   **Then** the table paginates or search-filters server-side.
4. **Given** `/admin/users` filter bar, **When** typing, **Then** the
   server-side `?query=` filter (shipped in 060 US5 but never wired in the UI)
   is used — removes dead client code and keeps text filtering correct past
   page-size limits.

### US6 — Admin completeness gaps (P2)

As an admin, I want the full set of shipped capabilities reachable from the console.

1. **Given** `/admin/migration`, **When** choosing a source, **Then** Jira
   Server/DC, CSV, and Jira Server XML are offered alongside Jira Cloud (all
   endpoints exist: `POST /migration/jira-server|csv|jira-server-xml`), and
   project **export** (`GET /migration/export/{projectKey}`) is reachable —
   currently Jira-Cloud-only UI over a multi-source backend.
2. **Given** Create user, **Then** an *Account type* (human/agent) selector and
   *Approval policy* (`never|destructiveOnly|always`) control exist —
   `POST /users` already accepts `type`/`approvalPolicy`/`ownerId` per
   `docs/agents.md`; agents are first-class users but currently un-creatable
   from the UI.
3. **Given** a user row, **Then** admin can *Rename* and *Reset password*
   (`PATCH /users/{id}` supports `displayName`/`password` today — UI only
   toggles `active`/`isAdmin`).
4. **Given** a security level member, **Then** the add-level form offers the
   member kinds the model supports (group today only) or explicitly documents
   the limitation — and level rows render member types humanely instead of raw
   `type:param` strings.

### US7 — UX polish batch (P3 — bundle of small fixes, one review each)

Batch (each is an independently reviewable diff; drop freely):

- **Containers**: unify admin page shells — most use `p-6` full-width;
  Webhooks (`max-w-1000`, `bg-atl-n-20`), CustomFields (`max-w-5xl`), Migration
  (`max-w-1200`), System (`max-w-860` + inline styles/`--tf-*` vars) each
  differ. One container pattern; restyle SystemPage in the Tailwind system.
- **`CheckBadge`**: identical `●` glyph for ok/fail — use distinct glyphs
  (✓/✗) for color-blind accessibility.
- **Avatar menu**: collapse the six admin shortcuts (Administration, AI
  settings, Custom fields, Webhooks, Migration, System) into one
  "Administration" entry, or mirror the full sidebar — the arbitrary subset
  is the confusing part.
- **"Metadata" label**: rename nav/page title to "Issue metadata" or split
  toward Jira's "Issues" naming so statuses/priorities/resolutions are
  findable.
- **Audit action filter**: free-text → datalist/autocomplete of distinct
  action names (cheap: `SELECT DISTINCT action FROM AuditEvent` endpoint or
  collect from the current page).
- **`WorkflowEditorPage`**: re-init draft when `workflowId` changes (stale-
  draft edge on same-route navigation).
- **SCIM "Mint token"**: accept a name instead of hardcoding `ui-minted`.
- **AiSettingsPage**: `<a href="/approvals">` → `<Link>` (full reload today).
- **SystemPage**: "Runbooks" href points at an invented GitHub URL — point at
  the docs portal or drop it.
- **Group delete dialog**: copy describes the refusal, not the consequence —
  rewrite ("Members lose this group's permissions. Deletion is refused while
  referenced.").
- **People directory**: relabel or annotate — it is the public `/teams` page,
  not an admin function (link is fine; implication of admin-only is not).
- **Grant/field-config custom-field params**: `customfield_10000` typed by
  hand — add a field picker (data already loaded for other selects).
- **Entity-id truncation** on audit rows: full id on Detail copy affordance.

## Non-functional requirements

- **FR-001**: Every touched endpoint keeps the contract checklist — zod
  validation, OpenAPI registration where the route is new (aggregate tokens
  endpoint), `errorMessages` shape with allowed values, `actor` threading,
  two-step/`ConfirmDialog` for destructive ops.
- **FR-002**: The re-invite guard is enforced **server-side**, not just hidden
  in the UI (UI-only gating was the original B2 mistake).
- **FR-003**: No new dependencies; reuse `ConfirmDialog`, `AdminLayout` section
  model, existing tab+dialog patterns. `pnpm typecheck && pnpm lint` at zero
  warnings.
- **FR-004**: Invite-link surfacing must not leak tokens to non-admin
  principals — admin-only response field, never in the mail-visible body.
- **FR-005**: Integration tests for the re-invite guard (deactivated ≠
  reinvitable), the aggregate tokens endpoint, and mail PUT validation.
- **FR-006**: Restore never runs inside the durable job runner or any
  DB-resident progress store — the restore target drops those tables.
  Detached process + file status marker; `verifyBackup` gate; `confirmToken`;
  `TF_DISABLE_UI_RESTORE` opt-out; audit before launch.

## API surface (candidates)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/admin/system/backups/:id/restore` | New — `confirmToken` two-step, detached `pgRestore`, verify-first (US4) |
| GET | `/api/internal/admin/system/restore-status` | New — file-backed marker, survives DB replacement (US4) |
| GET | `/api/internal/admin/tokens` | New aggregate — joins owner; replaces N+1 (US5) |
| POST | `/api/internal/users/{id}/invite` | Tighten guard: never-activated only (US2) |
| GET/PUT/POST | `/api/internal/admin/mail{,/test}`, `GET /admin/outbox` | Exist — UI only (US3) |
| CRUD | `/api/internal/notificationschemes` + project bind | Exist — UI only (US3) |
| POST | `/api/internal/migration/{jira-server,csv,jira-server-xml}`, `GET /migration/export/{k}` | Exist — UI only (US6) |
| POST/PATCH | `/api/internal/users{,/{id}}` | `type`/`approvalPolicy`/`displayName`/`password` already accepted — UI only (US6) |
| GET | `/api/internal/audit/actions` (optional) | Distinct action names for the filter datalist (US7) |

## Data model (candidates)

`User.lastLoginAt` (exists — sufficient for the re-invite guard in the common
case) or an explicit `User.invitedAt`/`inviteConsumedAt` marker if plan
prefers distinguishing "created inactive by invite" from "never logged in".
No other schema work expected.

## Success criteria

- **SC-001**: Every sidebar item highlights correctly on all 19 admin pages,
  and non-admins get the 404 gate on `/settings/ai` (e2e or unit coverage of
  the route table).
- **SC-002**: No `DELETE` in `apps/frontend/src/pages` fires without a
  `ConfirmDialog` (lint-grep checkable); re-invite refuses a previously-active
  account with a named error (integration test).
- **SC-003**: An admin configures SMTP, sends a test mail, and sees it in the
  outbox tab — zero `curl` involved.
- **SC-004**: An admin restores a verified backup entirely from
  `/admin/system` — typed confirmation, visible progress, forced re-login to
  the restored instance, and the pre-restore audit entry is present in the
  restored audit log. A tampered backup is refused at verify.
- **SC-005**: `/admin/tokens` loads in ≤2 requests regardless of user count;
  workflows list paginates.
- **SC-006**: An agent account with `approvalPolicy=always` is created end-to-
  end from Create user, and a CSV import job starts from the wizard.

## Risks

| Risk | Mitigation |
|---|---|
| Re-invite guard breaks a legit flow (user deactivated before first login) | Guard on "ever activated" not "was invited"; document the edge in `docs/compatibility.md` |
| Mail UI exposes SMTP password/secrets | `secretRef` pattern only (env refs), never raw secrets — same as identity/integrations pages |
| Aggregate tokens endpoint leaks token metadata to weaker admins | `requireAdmin` server-side — same as the per-user endpoints it replaces |
| UI restore corrupts a live instance (partial drop, mid-restore writes) | Verify-first + detached process + loud signed-out warning; audit before launch; `TF_DISABLE_UI_RESTORE` for conservative installs; integration test on a scratch DB |
| Restore status disappears when DB is dropped | File marker under `BACKUP_DIR`, never a DB table (FR-006) |
| Polish batch balloons the sprint | US7 items are independent; merge-ready subsets are acceptable; P3 drops first |
| Invite-link-in-response enables token harvesting | Admin-only field + audit the invite mint (already audited) |

## Slice plan (each ships runnable)

1. US1 nav truth + gating (frontend-only, one PR)
2. US2 confirm dialogs + re-invite guard + invite-link surfacing (small backend)
3. US3 mail console + notification schemes (frontend on shipped backends)
4. US4 restore console (new endpoint + detached-process marker + UI)
5. US5 aggregate tokens + dialog reuse + pagination (one new endpoint)
6. US6 migration sources + agent/user-ops fields
7. US7 polish batch (independent diffs, land opportunistically)

## Implementation status

### Slice 1 — US1 nav truth + gating (landed)

- `AdminLayout`: stale `external` flags/↗/tooltips removed — Workflows, Custom
  fields, Webhooks now highlight normally; **AI settings added to the sidebar**
  (Configuration) — it was only reachable via the avatar menu.
- `/settings/ai` moved inside `RequireAdmin` + `AdminLayout` (was `RequireAuth`
  only — non-admins got a broken form).
- `pageTitleFor`: added people/projects/screens/field-config titles.
- Dead `me.isAdmin` checks removed from Webhooks/CustomFields/Workflows/
  Migration pages (unreachable inside `RequireAdmin`); the
  "Jira-administrator" brand leak went with the dead check.

### Slice 2 — US2 destructive consistency + invite hardening (landed)

- `ConfirmDialog` wired into all three unconfirmed deletes: OAuth clients,
  directory connections (both `/admin/identity`), GitLab connections
  (`/admin/integrations`), with blast-radius copy.
- **New `User.invitedAt`** (migration `20261125000000_061_user_invitedat`) —
  pending-invite marker, set on (re-)invite, cleared on accept, explicit
  reactivation, or anonymize. `POST /users/:id/invite` now refuses
  non-invited accounts — a deactivated user can no longer be mailed a link
  that re-activates them.
- **`confirmInvite` hole closed**: previously *any* valid reset token
  presented to `/invite/:token` activated the account — including a
  deactivated user's own "forgot password" link. Now requires `invitedAt`.
- Response-bug fixed along the way: `/users/invite` returned the pre-update
  user (`active: true`) despite creating the account inactive.
- `inviteUrl` returned in invite + re-invite responses (admin-only field);
  `InviteLinkModal` shows the copyable link when mail is unconfigured —
  the "share the link manually" dead-end is gone.
- Users table: `Invited` status badge (distinct from Inactive); Re-invite
  shows only for pending invitees, Reactivate only for real deactivated
  accounts.
- Tests: `inviteGuard.test.ts` 4/4 — full lifecycle, deactivated-user refusal,
  reset-token reactivation refusal, post-accept refusal.

### Slice 3 — US3 mail + notification consoles (landed)

- **`/admin/mail`** (sidebar, System): SMTP form (host/port/TLS/user/pass/
  from/baseUrl) with env-override notice, masked-password unchanged
  semantics, test send; plus an **Outbox** tab with status filter + delivery
  rows — verified live (GET/PUT/test/outbox all 200).
- **`/admin/notifications`** (sidebar, Configuration): scheme table with
  entries editor (event + recipient kind + ref), per-scheme bound-project
  chips with unbind and a bind-project picker, guarded delete.
  `listSchemes` now includes `projects: { key }` for the bound list.
- Client functions for both surfaces; routes + sidebar + pageTitles wired.

### Slice 4 — US4 backup restore console (landed)

- **`POST /admin/system/backups/:id/restore`** — `?dryRun=true` previews the
  manifest (counts, version, warning copy incl. "attachments not restored")
  and mints an HMAC `confirmToken`; the real call rejects without it (400),
  runs `verifyBackup` first (409 on checksum mismatch), audits
  `system.backup.restored`, then launches `pgRestore` detached → 202.
  `TF_DISABLE_UI_RESTORE=1` → 404 (hardened-install opt-out).
- **`GET /admin/system/restore-status`** — reads `.restore-status.json` under
  `BACKUP_DIR`; survives the DB being replaced because it never touches it.
- **`runRestoreDetached`** — writes `running` → `done|failed` markers around
  the fire-and-forget `pg_restore --clean --if-exists` child; deliberately
  not the durable job runner (its own tables are dropped mid-restore).
- **System page** — per-row Restore button → typed-`RESTORE` dialog
  (Modal) showing manifest + warning; status line polls every 2s while
  running, warns "you may be signed out".
- Tests: `backupRestore.test.ts` 5/5 — dryRun preview/token, no-token 400,
  tampered-file 409, disabled 404, detached launch + marker. Live: routes
  mounted (`restore-status` → `idle`; bogus-id dryRun → 404).
- `docs/backup-restore.md` updated with the UI path + env opt-out.

### Slice 5 — US5 performance (landed)

- **`GET /api/internal/admin/tokens`** — aggregate join; `/admin/tokens` page
  now loads in 1 request (was 1 + N users fan-out, ~115 on the migrated DB).
  `adminTokens.test.ts` covers owner fields; verified live.
- **Groups dialog** seeds membership from `fetchAdminUsers`' `groups[]` and
  updates locally on toggle — the per-group `fetchGroupMembers` fan-out is gone.
- **Workflows** page: name filter + client pagination (50/page) — 413 rows no
  longer render at once.
- **Users page**: the 060 `?query=` server filter is finally wired via
  `useDeferredValue` — client-side row filter removed.

### Slice 6 — US6 completeness gaps (landed)

- **Migration wizard** is now a 5-tab source picker: Jira Cloud (unchanged),
  **Jira Server/DC** (authMode basic|PAT, username, secretRef, TLS-skip and
  private-address opt-outs, delta-from), **CSV** (file picker + the 039
  header→field mapping preview), **XML backup** (zip → base64 → fixture),
  and **Export project** (project picker → fixture JSON download). All hit
  already-shipped 048/039 endpoints.
- **Create user** offers Human/Agent; agents get owner picker (active humans),
  assignable checkbox and the approval-policy select — the 047 fields' first UI.
- **Edit user** dialog on every row: display-name rename, password reset
  (humans), assignable + approval policy (agents).

### Slice 7 — US7 polish batch (landed)

- **Avatar menu**: the arbitrary 6-shortcut block collapsed to a single
  "Administration" entry (TopNav).
- **`CheckBadge`**: `●`/`●` → `✓`/`✗` (color-blind safe).
- **"Metadata"** → "Issue metadata" in the sidebar (title already matched).
- **Audit**: `GET /audit/actions` (`SELECT DISTINCT`) + datalist on the Action
  filter; entity-id cell now shows the full id on hover.
- **Grant editor**: `userCustomField`/`groupCustomField` params are picked
  from a field select (filtered to `user`/`group` types) — no more
  hand-typing `customfield_10000`.
- **Workflow editor**: drafts reset on `workflowId` change (stale-draft edge).
- **SCIM mint**: prompts for a token name instead of hardcoding `ui-minted`.
- **AI settings**: `<a href>` → `<Link>` (no more full reload).
- **System page**: invented GitHub runbooks link dropped; shell moved to the
  `p-6 max-w-4xl` Tailwind container.
- **Groups delete** copy now states the consequence before the refusal.
- **Containers**: Webhooks, CustomFields, Migration, System normalized to
  `p-6` + page max-width (no more centered outliers/dark bg).
- **People directory** labelled "People (view only)" — it's the public
  `/teams` page, not an admin function.

## DoD

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `docs/compatibility.md` updated for re-invite semantics and any new
  divergences.
- [ ] Integration tests: re-invite guard, aggregate tokens endpoint, mail PUT
  validation, restore dryRun/confirmToken/verify-refusal on a scratch DB.
- [ ] `docs/backup-restore.md` updated — UI path documented alongside the CLI
  path; `TF_DISABLE_UI_RESTORE` added.
- [ ] `AdminLayout` section membership matches this doc's final page map.
- [ ] Zero unconfirmed `DELETE` callers in `apps/frontend/src/pages` (grep
  audit in PR description).

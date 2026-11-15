# Sprint 029 — Email & Notification Schemes

| | |
|---|---|
| **Status** | Epic (draft) — Wave 3; scenarios are candidates, re-validate at wave planning |
| **Milestone** | M3 Insight & communication |
| **Theme** | Jira parity — the notification engine's missing channel (DESIGN P1) |
| **Depends on** | 011 (in-app notifications, watchers, event feed), 015 (roles/groups as recipients), 016 (job runner + scheduler for outbox and subscriptions), 021 (admin shell hosts the mail page) |
| **Unblocks** | Notification-scheme parity, filter subscription emails, offline awareness |
| **New dependencies (justify in plan)** | `nodemailer` — SMTP send; template engine optional (plain JSX-free string templates suffice — justify if more) |
| **Spec-kit folder** | `specs/029-email-notification-schemes/` |

> **Replan corrections (2026-11-07, verified against Jira Cloud REST docs):** Jira has **no public
> REST endpoint to create/delete filter subscriptions**; subscriptions are only *readable* via
> `GET /rest/api/2/filter/{id}?expand=subscriptions`. So: expose subscriptions read-only in that
> Jira shape, and manage them through native `/api/internal/filters/{id}/subscriptions`
> (documented TF extension). The `POST/GET/DELETE /rest/api/2/filter/{id}/subscription` rows
> below are superseded. Notification schemes do have Jira REST (`/rest/api/2/notificationscheme`,
> `/project/{key}/notificationscheme`) — mirror their read shapes. Outbox sends and subscription
> schedules run on the 016 runner/scheduler (exactly-once ticks) — the "in-process cron" risk
> row is superseded. Ships an `EntityImporter` for notification schemes. Threat-model entry:
> header injection, unsubscribe-token forgery, mail-bomb amplification.

## Goal

Close the gap 011 deliberately left: **email** and **notification schemes** — the two Out
items that keep notifications from matching Jira (§14):

- **SMTP channel**: HTML emails per §14.4 template (subject `[TF-95] summary — event`,
  change diff, deep link); queue + retry + failure log.
- **Notification schemes**: per-scheme mapping of `event → recipients → channels`
  (§14.3), assignable per project; recipient kinds: reporter, assignee, watchers,
  mentioned users, project lead, project role, group, single user.
- **User preferences**: per-event on/off + auto-watch toggles (§14.5 configurable) +
  digest mode (immediate | daily).
- **Filter subscriptions**: saved filter → scheduled email of results (Jira parity).

## Why now

In-app (011) covers people inside the tool; email is how notifications actually reach
humans. Schemes are also a hard Jira-parity item (§15-adjacent project admin surface) and
migration (017/039) expects them to exist.

## Scope

**In**: SMTP config (env + `/admin` mail page: host/port/auth/TLS, from-address, test
button); notification scheme CRUD + per-project assignment; recipient resolution through
015 roles/groups; email templates (issue events: created/updated/assigned/commented/
transitioned/deleted/linked/worklogged/mentioned + sprint + version events per §14.1);
per-user prefs page (channel toggles per event + auto-watch + digest); filter subscriptions
(`POST /filter/{id}/subscription`, schedule daily/weekly → mail run); `EmailOutbox` log
(status, retries); unsubscribe-by-token link per user.

**Out**: batched "issue update" thread-style emails (Jira batches — v2), localized templates
(036 i18n groundwork first), incoming-mail handlers (Jira's mail→issue creation — future),
SMS/webhook channels beyond existing webhooks.

---

## User stories

### US1 — SMTP channel (P1)

As an admin, I want TrackForge to send mail.

**Independent test**: configure SMTP (MailHog in dev/CI), trigger `issue_commented`,
verify the §14.4-shaped email lands with correct recipients.

**Acceptance scenarios**

1. **Given** `/admin/mail`, **When** configured + "Send test", **Then** a test email validates the full path; failures surface the SMTP error verbatim.
2. **Given** an event matching a scheme, **When** emitted (011 bus), **Then** an `EmailOutbox` job renders the event template and sends to resolved recipients minus the actor and minus users who opted out.
3. **Given** SMTP down, **When** send fails, **Then** the job retries with backoff (3×) and lands in the outbox `failed` state — visible in admin, never silently lost.

### US2 — Notification schemes (P1)

As a project admin, I want to decide who gets notified about what.

**Acceptance scenarios**

1. **Given** `/admin/notifications` scheme editor, **When** mapping `issue_commented → email: assignee, reporter, watchers, mentioned`, **Then** the matrix is stored and used; per-project assignment via project settings Schemes tab (021).
2. **Given** recipient kinds including **project role** and **group**, **When** an event resolves, **Then** 015 membership expands to concrete users at send time.
3. **Given** no scheme on a project, **When** events fire, **Then** the seeded default scheme applies (today's 011 in-app recipients + email mirrors).

### US3 — Preferences & subscriptions (P2)

As a user, I want control over what lands in my inbox.

**Acceptance scenarios**

1. **Given** profile→Notifications, **When** toggled per event/channel, **Then** prefs filter delivery; auto-watch toggles (on create/comment/assign) change 011 watch behavior per §14.5.
2. **Given** digest=daily, **When** events accrue, **Then** one daily summary mail replaces individual mails (in-app unaffected).
3. **Given** `POST /filter/{id}/subscription {frequency: daily|weekly, day?}`, **When** scheduled, **Then** the filter's results mail to the subscriber; `GET /filter/{id}/subscription` and `DELETE` round-trip; one-click unsubscribe token stops a subscription without login.

---

## Edge cases

- Email to deactivated users → skipped (021 `active` check at resolve time).
- User watches and is assignee → single mail, not N (recipient dedupe, Jira merges).
- Huge watcher lists → batched sends, documented cap + `Bcc`-style privacy (never expose recipient lists).
- Outbox grows → retention policy (30d) + purge job.
- Mail server auth differs per env → env-overridable config, admin UI read-only view of effective source (env wins).

## Functional requirements

- **FR-001**: All sends MUST flow through `EmailOutbox` — no fire-and-forget; every send attempt logged (A2).
- **FR-002**: Recipient resolution MUST be scheme → event → channels → dedupe → prefs → send.
- **FR-003**: Schemes MUST be admin-editable with per-project assignment and a seeded default.
- **FR-004**: Filter subscriptions MUST run on schedule server-side — no client dependency.
- **FR-005**: Actor self-notify MUST be suppressed (011 rule) across email too.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST/PUT/DELETE | `/api/internal/notificationschemes` · `/{id}` | Admin CRUD |
| POST | `/api/internal/projects/{key}/notificationscheme` | Assign |
| GET/PUT | `/api/internal/admin/mail` + `POST /mail/test` | SMTP config + test |
| GET | `/api/internal/admin/outbox` | Send log/status |
| GET/PUT | `/api/internal/me/preferences` | User prefs |
| POST/GET/DELETE | `/rest/api/2/filter/{id}/subscription` | Jira subscriptions |

## Data model changes

- **NotificationScheme** + **NotificationSchemeEntry** (`schemeId`, `event`, `channel`, `recipientKind`, `recipientRef?`); `Project.notificationSchemeId?`.
- **NotificationPreference** (`userId`, `event`, `channel`, `enabled`) + `autoWatch Jsonb`, `digest` on User.
- **FilterSubscription** (`filterId`, `userId`, `frequency`, `day?`, `unsubscribeToken`).
- **EmailOutbox** (`id`, `to`, `subject`, `body`, `status`, `attempts`, `error?`, `createdAt`, `sentAt?`).

## MCP tools added

`manage_notification_scheme`, `send_test_mail`, `get_outbox`, `subscribe_filter`,
`update_preferences` — admin-scoped where applicable.

## AI-native checklist

- [ ] Schemes/prefs/subscriptions discoverable + dry-run-able (A3/A4).
- [ ] Outbox inspectable by agents — "did TF-9 notify" answerable via API (A1).
- [ ] Send failures surface as actionable errors (A8).

## Success criteria

- **SC-001**: Comment on watched issue → correct deduplicated §14.4 email to exactly the scheme recipients.
- **SC-002**: Scheme edit on one project changes only that project's delivery.
- **SC-003**: Filter subscription delivers a scheduled digest; unsubscribe link works.
- **SC-004**: Agent eval: "who was emailed about TF-3 today" returns outbox truth.

## Risks

| Risk | Mitigation |
|---|---|
| Email is infra-dependent (no SMTP in tests) | `MailAdapter` port: SMTP adapter + in-memory test adapter (constitution §stack) |
| Spam-amplification (every event emails) | Prefs + digest + scheme defaults conservative; admin can disable channel globally |
| Scheduler for subscriptions | 016 `Scheduler` (BullMQ, exactly-once ticks — D20) |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Dev default ships a MailHog/Mailpit docker-compose service for demos/tests.
- [ ] §14 event matrix documented: which events fire which default recipients.

## Implementation status (slice 1 — backend + subscriptions)

**Implemented:** `NotificationScheme`/`NotificationSchemeEntry`/`EmailOutbox`/`FilterSubscription` schema + `Project.notificationSchemeId`; `MailAdapter` port (nodemailer SMTP prod + in-memory test adapter); event → scheme → recipients → dedupe → prefs → `EmailOutbox` pipeline wired into `dispatchEvents`; durable jobs `mail.send`/`mail.digest`/`mail.subscriptions`/`mail.prune`; admin scheme CRUD + project assignment + mail config (env wins) + test + outbox list; user prefs (UserPreference KV: per-event/channel toggles, autowatch flags, digest); filter subscriptions (daily/weekly, 23h gate, public `/unsubscribe?token=` one-click); seeded default scheme mirroring 011 in-app recipients; Mailpit compose service; 5 MCP tools (`manage_notification_scheme`, `send_test_mail`, `get_outbox`, `subscribe_filter`, `update_preferences`); `get_report` extended for all 028 types. `mail.test.ts` 5/5.

### Default scheme — event matrix (§14)

| DomainEvent | Scheme event | Default recipients |
|---|---|---|
| `jira:issue_created` | `issue_created` | reporter, assignee, watchers |
| `jira:issue_updated` (assignee change) | `issue_assigned` | reporter, assignee, watchers |
| `jira:issue_updated` (other) | `issue_updated` | reporter, assignee, watchers |
| `jira:issue_deleted` | `issue_deleted` | reporter, assignee, watchers |
| `comment_*` | `comment_created` | reporter, assignee, watchers, **mentioned** (always) |
| `worklog_*` | `work_logged` | reporter, assignee, watchers |
| `sprint_*` | `sprint_event` | reporter, assignee, watchers |
| `version_*` | `version_event` | reporter, assignee, watchers |
| `issuelink_*` | `issue_updated` | reporter, assignee, watchers |
| everything else | `generic` | reporter, assignee, watchers |

Actor self-notify suppressed (FR-005); dedupe by user+event; deactivated/agent users skipped at resolve time.

**Deferred:** admin mail page + project-settings Schemes tab UI (021 shell), EntityImporter row (lands with 039 batch), incoming-mail handlers, batched thread-style emails, per-event user-pref defaults seeding.

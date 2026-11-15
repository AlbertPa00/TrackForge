# TrackForge pre-release audit

Date: 2026-11-10 · Auditor: Devin · Target: working tree of TrackForge (uncommitted changes included)

## 1. Verdict

**Not ready to ship to a customer as a finished product.** The code is clearly security-conscious in many places, but this pass found several independent ways to bypass its own controls: two-factor login, token scoping, the agent approval gate, project/issue visibility, and comment restrictions. Most are small fixes. Section 10 gives a fix order.

**This audit is partial.** It was stopped before the frontend, the MCP server and about half of the backend were read (section 9). Treat the list below as a floor, not a complete inventory.

## 2. Scope and method

- **Static reading only.** No tests were run, no server was started, no request was sent. Every finding is a reading of the code.
- Each finding is tagged:
  - **[read]** the behaviour follows directly from the lines cited.
  - **[inferred]** the code is as cited, but the consequence depends on library or runtime behaviour that was not exercised. Confirm with a test before acting.
- Read: about 14–15k of roughly 80k source lines, almost all in `apps/backend/src`. Files read are listed in section 9 alongside what was skipped.
- Docs, specs and sprint notes were deliberately not read, as requested.
- Paths are relative to the repo root. Line numbers refer to the working tree on the audit date.

Severity scale: **Critical** (unauthenticated or trivially reachable compromise), **High** (an ordinary account or token defeats a core control), **Medium** (needs an elevated role, an opt-in feature, or has limited impact), **Low**.

## 3. Release blockers at a glance

| ID | Severity | Finding | Precondition |
|---|---|---|---|
| A1 | Critical | 2FA is bypassable: the "pending" login token works as a session cookie | Knows the password |
| A2 | Critical | `SESSION_SECRET_FILE` passes validation but the app signs with the public dev secret | Operator uses the documented `_FILE` option |
| A3 | Critical | `.env.example` placeholder secret and admin password are accepted in production | Operator copies `.env.example` unchanged |
| B1 | High | Any write-scoped token can mint an unrestricted token for itself | Any PAT/OAuth token with `write` |
| B2 | High | Any signed-in human can view, approve and rewrite any agent proposal | Any browser session |
| B3 | High | Copilot endpoints drop token project limits and the approval gate | AI configured; token with `write` |
| C1 | High | Live event stream ignores `BROWSE_PROJECTS` | Any browser session |
| C2 | High | Restricted comments leak through events, e-mail and AI summary | Can see the issue |
| D1 | High | Automation "run" accepts any issue key; webhook action posts that issue out | Project admin of any one project |
| D2 | High | Smart commits from unknown authors execute as a site admin | Push access to a connected repo |
| E1 | High | Async route errors can crash the process, including unauthenticated `/metrics` | Redis/DB hiccup |
| F1 | High | Passwords set by admins are written to the audit log in plaintext | Admin changes a password |
| G1 | High (functional) | Reset, invite and notification e-mails link to `http://localhost:5173` by default | Default configuration |
| G3 | High (functional) | Jobs longer than 5 s are reported failed and retried; backups show "failed" | Any real-size database |

## 4. Security findings

### A. Authentication and sessions

**A1 — Two-factor authentication bypass (Critical) [read]**
- Where: `apps/backend/src/routes/auth.ts:32`, `apps/backend/src/lib/auth.ts:85-92`, `apps/backend/src/services/identityService.ts:31-32`.
- What: after a correct password, a TOTP user receives `pending = jwt.sign({ sub, kind: '2fa' }, SESSION_SECRET, 5m)`. `verifySession()` accepts any JWT signed with the same secret that has a `sub`; it does not look at `kind`. The token has no `sid`, and `sessionAlive(undefined)` returns `true` ("legacy sessions").
- Impact: sending the pending token as the `tf_session` cookie gives a full session for five minutes without the second factor. That is enough to create a long-lived API token (`POST /api/internal/tokens`).
- Fix: reject tokens with a `kind` claim in `verifySession`; sign pending tokens with a different secret or audience; make `sid` mandatory and delete the legacy branch.

**A2 — `SESSION_SECRET_FILE` is validated but never used (Critical when that option is used) [read]**
- Where: `config.ts:13-23,101,124-126` reads `NAME_FILE`; `lib/auth.ts:5` uses `process.env.SESSION_SECRET ?? 'trackforge-dev-secret'`. The same fallback is repeated in `services/userService.ts:237,243`, `services/issueService.ts:1357`, `services/backupService.ts:73`, `lib/ai.ts:16`.
- Impact: an operator who mounts the secret as a file (the error message at `config.ts:125` recommends it) boots successfully, and every signature uses the published default: session JWTs, the `X-TrackForge-Internal` actor header, delete/restore/anonymize confirm tokens, and the AI API-key encryption key. Combined with A1's missing `sid` check, a session can be forged for any known user id.
- Fix: export one resolved secret from `config.ts` and import it everywhere; remove every literal fallback; fail at import time if it is missing outside development/test.

**A3 — Example secrets pass production validation (Critical if copied) [read]**
- Where: `.env.example:6,10`, `config.ts:117-126`, `services/userService.ts:206-230`, `docker-compose.prod.yml:77`.
- What: `SESSION_SECRET=change-me-at-least-32-characters-of-randomness` is 46 characters and is not in the deny-list, so it passes. `TF_ADMIN_PASSWORD=change-me-admin` is accepted by `ensureBootstrap` with no check. Compose falls back to `trackforge-s3-secret` for the object store.
- Fix: reject any secret starting with `change-me`; require a minimum admin password length and reject the example value; use `${S3_SECRET_KEY:?…}` when S3 storage is selected.

**A4 — Second-factor management has no attempt limit (Medium) [read]**
- Where: `routes/me.ts:221-237`, `identityService.ts:285-315`. Only the login step is capped (`routes/auth.ts:61-84`).
- Impact: with a session (or A1), the 6-digit code guarding "disable 2FA" and "regenerate backup codes" can be guessed at the general limit of 1000 requests/minute.
- Also: TOTP secrets are stored in plaintext; backup codes are 8 hex characters hashed with unsalted SHA-256; a code can be replayed inside its 90-second window (`identityService.ts:267-272`).

**A5 — Login hardening gaps (Medium/Low) [read]**
- `scryptSync` runs on the request thread (`lib/auth.ts:22-34`): each login attempt blocks the whole API while it hashes.
- No per-account lockout or back-off; only a per-IP budget (`middleware/auth.ts:357-377`).
- With SSO-only on, non-admin e-mails get 403 and admin e-mails proceed (`routes/auth.ts:22-27`): this identifies admin accounts.
- Password policy is length ≥ 8 only, and an admin-set password via `PUT/PATCH /api/internal/users/:id` has no validation at all (`routes/users.ts:201-212`, `userService.ts:161-196`). An admin password change does not revoke the user's sessions.
- Session cookie `Secure` depends on `PUBLIC_BASE_URL` starting with `https://` (`routes/auth.ts:45`); the shipped default is `http://localhost:3000`.

**A6 — OIDC details (Medium/Low) [read]**
- `iss` and `aud` are only checked when present (`identityService.ts:467-471`).
- `state` is not bound to the browser (no cookie), so login CSRF is possible.
- The token-endpoint fetch has no timeout (`identityService.ts:489`).
- Updating an IdP rebuilds the row from defaults: a partial `PUT` either fails with 400 or silently resets `enabled`, `autoProvision`, `scopes` and `claimMap` (`identityService.ts:343-361`, `routes/identity.ts:48-54`). A disabled IdP can be re-enabled by renaming it.

**A7 — Security features defined but not reachable (Medium) [read]**
- `adminResetPassword` and `setSsoOnly` (`identityService.ts:173,563`) are never called from a route.
- `mustChangePassword` is never enforced anywhere in `apps/backend/src`.
- No route was found that sets `Group.requireTotp`, so the group 2FA policy checked in `middleware/auth.ts:91-95` cannot be switched on through the API.

### B. Tokens, agents and approvals

**B1 — Token self-escalation (High) [read]**
- Where: `routes/users.ts:314-331`, `lib/validation.ts:206-213`, `services/tokenService.ts:24-48`.
- What: `POST /api/internal/tokens` lets a token-authenticated caller create a new token for the same user with any scopes, no `projectKeys`, and `approvalPolicy: never`. Nothing checks that the new token is a subset of the calling one.
- Impact: a token limited to one project, or one with `approvalPolicy: always`, or an OAuth access token, can replace itself with an unrestricted one that also outlives grant revocation. The proposal gate does not cover this path (`middleware/proposals.ts:74`).
- Fix: allow token creation only from a browser session, or enforce scopes/projects/policy ⊆ caller.

**B2 — Proposal review has no authorization (High) [read]**
- Where: `services/proposalService.ts:153-155` (`canReview = !actor.token`), `:157-176`, `:178-193`, `:277-314`; replay as the principal at `:200-230`.
- What: any user with a browser session can list every pending proposal in every project (including request body and diff), approve it, or approve it with a replacement body. The replay runs with the **proposing principal's** permissions, not the reviewer's.
- Impact: a user with no access to a project can read proposed changes there and execute an arbitrary body on the proposal's method and path as the agent (or as an admin, if the proposal came from an admin's gated token). Self-approval is also allowed.
- Fix: require the reviewer to hold a defined permission on the proposal's project (for example `ADMINISTER_PROJECTS`, or be the agent's owner); filter the list the same way; block self-approval; re-check the edited body against the reviewer's permissions.

**B3 — Copilot endpoints launder token restrictions (High, opt-in feature) [read]**
- Where: `routes/ai.ts:217-262`, `services/copilotService.ts:101,639,703,809-814`, `lib/internalRequest.ts`, `middleware/proposals.ts:62`.
- What: plan and execute dispatch internal requests as the user with channel `copilot` and no token. The token's `projectKeys` and scopes are dropped, and channel `copilot` skips the approval gate. Read results come back in `steps[].result`.
- Impact: a project-restricted or approval-gated token with `write` scope can read and write outside its limits when AI is configured.
- Fix: refuse token-authenticated callers on `/api/internal/ai/plan|execute`, or carry the token's restrictions into the internal actor.

**B4 — `ask_agent` with `autoApply` trusts model output (Medium/High, opt-in) [read]**
- Where: `services/agentAction.ts:34-51`, `services/copilotService.ts:280-289,770-827`.
- What: issue content read during planning is fed to the model; with `autoApply` every planned write, including `delete_issue`, executes as the rule actor with no human step. The only injection guard is one sentence in the prompt.
- Fix: exclude destructive tools from auto-apply and restrict writes to the triggering issue.

### C. Data visibility

**C1 — Event stream ignores project browse permission (High) [read]**
- Where: `routes/events.ts:79-127`, `lib/jobs.ts:102-125`. The polling endpoint applies the project scope (`routes/events.ts:51-60`); the stream does not.
- Impact: any signed-in user connected to `/api/internal/events/stream` receives issue keys, changelog items, full comment objects and link objects for projects they cannot browse (unless the issue has a security level).
- Fix: apply `visibleProjectScope` in the backfill loop and in `sseBroadcast`.

**C2 — Comment visibility restrictions are not honoured outside the comment list (High) [read]**
- `services/commentService.ts:81-91` puts the full comment in the event payload; `services/eventService.ts:91-105` returns it in the feed and stream to everyone who can see the issue.
- `services/mailService.ts:212` e-mails the first 500 characters to reporter, assignee and watchers.
- `services/aiService.ts:59-86` feeds all comments to the summariser.
- JQL `comment ~ "word"` searches all comments (`jql/compiler.ts:230-233`), which confirms the content of restricted ones.
- Fix: omit or redact the body for restricted comments in events and mail; filter by visibility in the AI loader and the FTS prequery.

**C3 — Single-issue print export skips project permission and token scope (Medium) [read]**
- Where: `routes/bulk.ts:74-79`, `services/exportService.ts:80-88`. Only `canSeeIssue` (security level and archived flag) is checked.
- Impact: `GET /api/internal/export/issue/KEY-1` returns the issue as HTML to any authenticated caller who knows or guesses the key.
- Fix: call `enforceIssueScope` in the route.

**C4 — Comment access is checked per project, not per issue (Medium) [read]**
- Where: `services/commentService.ts:104-118`. A comment id from a security-levelled issue can be read, edited or deleted through the URL of another visible issue in the same project.

**C5 — Smaller leaks (Low) [read]**
- `createmeta` checks only the token allow-list, not browse permission (`routes/issues.ts:390-414`).
- `user/assignable/search` returns up to 50 users for an empty query, bypassing the 2-character guard (`userService.ts:95-124`); user responses expose `isAdmin` to everyone (`userService.ts:18`).
- Anyone can subscribe to another user's private filter by id and read its name and JQL (`mailService.ts:411-426`).
- `GET /api/internal/automation/rules/:id` has no authorization check and returns the full rule, including webhook secrets (`routes/automation.ts:124-128`).
- Notification e-mails do not check that the recipient can still see the issue (`mailService.ts:228-275`).

### D. Automation and integrations

**D1 — Manual rule run accepts any issue key (High) [read]**
- Where: `routes/automation.ts:205-210`, `services/automationService.ts:518-563,337-353`.
- What: `POST /rules/:id/run` passes a caller-supplied `issueKey` straight to `executeRule`, which loads it with no visibility check. The `webhook` action posts the whole issue snapshot to the rule's URL and performs no permission check.
- Impact: a project admin of any one project can export any issue in the instance, including security-levelled ones.
- Fix: require the key to belong to the rule's project and be visible to both the caller and the rule actor.

**D2 — Smart commits fall back to a site admin (High) [read]**
- Where: `services/devService.ts:125-143,239-246`.
- What: when the commit author is unknown or unverified, the commands run as the first active admin. Issue keys are matched globally, not limited by the repository's project map.
- Impact: anyone who can push to a connected repository can comment on, log time against, or transition any issue in any project, attributed to an admin.
- Fix: ignore smart-commit commands from unverified authors, or run them as a dedicated low-privilege service account limited to mapped projects.

**D3 — Editing an admin-authored project rule keeps the admin actor (Medium/High) [read]**
- Where: `routes/automation.ts:130-164`. A project admin may change trigger and actions; `actorId` and `createdById` stay as they were, so the edited rule runs with the original (admin) actor and author.
- Fix: on edit by a non-admin, reset actor and author to the editor, or refuse.

**D4 — Automation webhook bypasses the redirect-safe fetch (Medium) [read]**
- Where: `services/automationService.ts:343-350` validates the URL, then uses plain `fetch`, which follows redirects. `lib/egress.ts` exists for exactly this and is not used here.
- Impact: blind SSRF to internal addresses through a redirecting public URL.

**D5 — GitLab branch and merge-request creation is under-guarded (Medium) [read]**
- Where: `main.ts:112`, `routes/dev.ts:119-174`. The only permission is `VIEW_DEV_TOOLS`; the router is mounted before the global chain, so rate limiting, idempotency and the approval gate do not apply; `connectionId` is caller-chosen.

**D6 — Webhook secret is generated but never shown (Medium, functional) [read]**
- Where: `services/webhookService.ts:48-64,82`. A receiver cannot verify signatures unless the admin supplied the secret.

**D7 — Bitbucket signature header (to verify) [inferred]**
- `routes/dev.ts:32` reads `x-hub-signature-256`, `x-gitlab-token` or `x-hook-signature`. Bitbucket's header name should be checked against a real delivery; if it differs, Bitbucket webhooks never verify.

### E. Unauthenticated surface and availability

**E1 — Unhandled async errors can terminate the process (High) [inferred]**
- Where: `routes/ops.ts:46-78` (`/metrics`, mounted unauthenticated at `main.ts:102`), `:80-94`, `:98-132`, `:144-147`, `:211-214`. These are `async` handlers with no `try/catch` on Express 4 (`apps/backend/package.json:28`); there is no `unhandledRejection` handler in `apps/backend/src`.
- Consequence: a rejected await (for example a Redis error in `getDurableRunner().list`) becomes an unhandled rejection, which stops Node by default. Confirm with a test that stops Redis and requests `/metrics`.
- Fix: wrap every async handler (the codebase already has `ah`/`wrap` helpers), add a process-level handler, or move to Express 5.

**E2 — No rate limit before authentication (Medium) [read]**
- `main.ts:168` runs `requireAuth` before `rateLimit`, so failed authentication is never counted; each attempt costs a database lookup.
- `/metrics` is open unless `METRICS_BEARER` is set and does database and queue work per call (`routes/ops.ts:49-58`).
- The public dev-webhook receiver writes a row for every bad signature and has no limit (`routes/dev.ts:51-53`, `devService.ts:179-181`).

**E3 — Error handler turns client mistakes into 500 (Medium) [read]**
- Where: `main.ts:252-259` handles only `JiraApiError`.
- Malformed JSON, oversized bodies, `zod.parse()` failures (`routes/automation.ts:102,133,182,240`; `routes/agentSessions.ts:89,101,137`; `routes/bulk.ts:48,59,75`), Prisma "not found" on deletes (`routes/dev.ts:91-94`), and a non-numeric event id (`routes/events.ts:132`) all return "Internal server error".
- Fix: map body-parser errors, `ZodError` and Prisma known errors to 4xx with the standard error shape.

**E4 — Missing response hardening (Medium) [read]**
- `main.ts:88-94` sets four headers; there is no `Content-Security-Policy` and no `Strict-Transport-Security`. The app serves the SPA and server-rendered HTML (print export, unsubscribe, OAuth pages) from the same origin as the session cookie.

**E5 — Idempotency gaps (Medium/Low) [read]**
- Check-then-insert: two concurrent requests with the same key both execute (`middleware/idempotency.ts:44-66,92-109`).
- The hash ignores the query string (`:8-13`): a `?dryRun=true` call followed by the real call with the same key replays the preview and never writes.

### F. Secrets and data at rest

**F1 — Plaintext passwords in the audit log (High) [read]**
- Where: `routes/users.ts:201-209` stores `req.body` as audit details, including `password`. It is then visible in the admin audit page, the CSV export and every backup.
- Fix: log field names only.

**F2 — Mail settings response returns the SMTP password (Medium) [read]**
- Where: `routes/mail.ts:68-71` returns the unmasked config after `PUT`; the `GET` at `:63-66` masks it.

**F3 — Secrets stored unencrypted (Medium) [read]**
- IdP client secret (`identityService.ts:348`), webhook secrets (`webhookService.ts:82`), dev-repo webhook and signing tokens (`routes/dev.ts:80,212-216`), SMTP password (`mailService.ts:41-44`), TOTP secrets. Backups are plain `pg_dump` files on a local volume (`backupService.ts:55-58`).
- The AI API key is encrypted, but with a key derived from `SESSION_SECRET` (`lib/ai.ts:16-17`): see A2, and note that rotating the session secret silently makes the stored key undecryptable.

**F4 — Confirm tokens are deterministic (Low) [read]**
- Delete, anonymize and restore tokens are an HMAC of a fixed string (`userService.ts:236-240`, `backupService.ts:72-76`): never expire, reusable.

**F5 — Admin-only path traversal in backup verify (Low) [read]**
- `routes/ops.ts:160-167` passes the URL parameter to `join(backupDir(), id)` (`backupService.ts:219-229`). The restore route validates the id against the listing; verify does not.

## 5. Functional bugs

**G1 — E-mail links point to `localhost:5173` by default (High) [read]**
- Where: `services/mailService.ts:37` uses `process.env.BASE_URL ?? stored.baseUrl ?? 'http://localhost:5173'`. `PUBLIC_BASE_URL`, the variable the config schema documents for e-mail links (`config.ts:40`), is not consulted; `BASE_URL` is not in the schema or `.env.example`.
- Affects password reset (`routes/identity.ts:73`), invites (`routes/users.ts:105-108`, also the `inviteUrl` shown to the admin), issue notifications (`mailService.ts:211`) and filter subscriptions.

**G2 — Invites expire after one hour (Medium) [read]**
- `identityService.ts:181-187` issues a 1-hour token; invites reuse it (`routes/users.ts:140`). Too short for real onboarding.

**G3 — Background jobs run inside a 5-second transaction (High) [inferred]**
- Where: `lib/jobs.ts:71-77` wraps each job in `prisma.$transaction` with default options (`prisma.ts:3`), whose interactive timeout is 5 s.
- Consequences if Prisma behaves as documented: (a) the advisory lock is released at 5 s while the job continues; (b) the commit fails afterwards, the job is marked failed and retried up to three times (`lib/jobsBullmq.ts:72`, `lib/jobs.ts:206`).
- Most visible effect: a successful backup longer than 5 s is recorded as failed (`dispatchService.ts:117-125`) and re-run. LDAP sync, GitLab backfill and slow webhook or mail batches are affected the same way.
- One lock key serves every job type (`lib/jobs.ts:62`).
- Fix: take a session-level advisory lock on a dedicated connection, or pass an explicit long timeout; use one key per job.

**G4 — Multi-instance deployment is not supported by the code (Medium) [read]**
- In-process state: rate-limit buckets (`middleware/auth.ts:310`), TOTP attempts (`routes/auth.ts:61`), OIDC states (`identityService.ts:364`), copilot plans (`copilotService.ts:738`), and the live-event hub (`lib/jobs.ts:91`). Only the instance that dispatches an event pushes it to its own stream clients.

**G5 — Mail scheduling (Medium/Low) [read]**
- "Daily" digest is sent every hour (`dispatchService.ts:106`, `mailService.ts:303-331`).
- A subscription's `hour` is stored and never used (`mailService.ts:437-444`).
- The unsubscribe link in subscription mail goes to the authenticated JSON endpoint (`mailService.ts:457`), not the public confirmation page at `routes/mail.ts:144-164`.
- With SMTP unset, mail goes to `localhost:1025` (`mailService.ts:31-32`): every notification fails three times and reset requests fail silently.

**G6 — Scheduled automation (Medium/Low) [read]**
- The UI hint suggests `0 9 * * MON` (`automationService.ts:380`); the matcher only parses numbers (`:650-665`), so that rule never fires. `7` never matches Sunday despite the comment. Cron is evaluated in UTC and not validated on save. Runs are capped at 500 issues without notice (`:685`).

**G7 — Backup and restore (Medium) [read]**
- Attachment copy errors are swallowed and attachments are not checksummed (`backupService.ts:141`), so a backup can report success without them.
- UI restore runs `pg_restore --clean` against the live database, does not restore attachments, and does not compare the backup's version with the running one (`routes/ops.ts:172-209`).

**G8 — Project delete is single-step (Medium) [read]**
- `routes/projects.ts:148-157` deletes on one call, with no preview or confirm token, unlike issue delete.

**G9 — Other (Low)**
- In-memory job runner never prunes finished jobs when `REDIS_URL` is unset (`lib/jobs.ts:167-254`) [read].
- `EVENT_RETENTION_DAYS` defaults to 30 in code (`dispatchService.ts:19`) and 90 in `.env.example:36` [read].
- Attachment `Content-Disposition` embeds the raw filename (`attachmentService.ts:218,236`); filenames with characters outside Latin-1 may fail to download [inferred — test with a non-Latin filename].

## 6. Performance and scale risks

All [read]; none measured.

- `nonBrowsableProjectIds` runs a permission query per project on every search, project list and event read (`permissionService.ts:395-403`).
- Every session request does a session lookup, a user lookup, a session write, and (for users without TOTP) a group count (`middleware/auth.ts:79-97`).
- Each event costs one issue query per connected stream client (`lib/jobs.ts:113-125`).
- Event dispatch is sequential and runs automation (HTTP calls up to 10 s, model calls up to 60 s) inline (`dispatchService.ts:29-56`).
- Webhook delivery is sequential, 50 per tick, 10 s timeout each, and reads the whole response body (`webhookService.ts:176-217`).
- Sorting by a custom field loads the whole result set into memory (`searchService.ts:159-173`); text-search prequeries return unbounded id lists (`jql/compiler.ts:227-249`).
- Export loads up to 10,000 full issues and only then rejects the request (`exportService.ts:31-49`).
- Uploads are buffered in memory, up to 10 files × 25 MB per request (`routes/attachments.ts:26-31`); downloads are read whole, with no range support (`attachmentService.ts:211-225`).
- The hourly attachment sweep does one query per stored file (`attachmentService.ts:141-153`).

## 7. User-friendliness and missing capabilities

Based on backend evidence only; the UI itself was not reviewed.

- **Onboarding**: invite links expire in an hour and point to the wrong host by default (G1, G2). There is no signal to users or admins that mail is unconfigured (G5).
- **Account recovery**: no working admin "force password reset"; no enforced "must change password"; no lockout or notice on repeated failed logins (A5, A7).
- **Security administration**: SSO-only mode and group-required 2FA exist in code but cannot be turned on (A7). Editing an identity provider can silently re-enable it (A6).
- **Error messages**: malformed input often returns "Internal server error" rather than a field-level message (E3). This matters doubly for agents, which rely on error text to self-correct.
- **Integrations**: webhook secret is not retrievable (D6); cron hint is wrong (G6); "daily" digest and subscription hour do not behave as labelled (G5).
- **Preview-before-write coverage**: comment edit/delete, worklog edit/delete, votes, remote links and project delete have no dry-run (`routes/issues.ts:707-731,836-909,998-1027`; G8).
- **Operations**: no TLS termination in the shipped compose file; object store image uses `latest`; the object store container starts even when file storage is selected (`docker-compose.prod.yml:45-46,74`).

## 8. Things that look solid

For calibration, from the files read: scrypt password hashing; API tokens stored as SHA-256 of 192 random bits; constant-time comparisons on signatures; a central outbound-request guard with per-hop redirect validation (where used); 404 existence-hiding on scoped routes; request logs that omit query strings and redact credentials; CSV formula-injection guard; attachments served with sniffed type, `nosniff` and forced download for unsafe types; path-traversal guard in the file store; non-root container with a digest-pinned base image; raw SQL in the JQL compiler uses only whitelisted fragments.

## 9. Not reviewed

- **Frontend** (`apps/frontend/src`, about 100 files): no file read. Markdown rendering/XSS, client-side route guards, forms, accessibility, i18n and general usability are unassessed.
- **MCP server** (`apps/mcp/src`): not read.
- **Backend services not read**: `issueService`, `boardService`, `sprintService`, `worklogService`, `workflowService`, `customFieldService`, `filterService`, `dashboardService`, `reportService`, `projectService`, `linkService`, `epicService`, `issueOpsService`, `bulkService`, `oauthService`, `scimService`, `directoryService`, `gitlabService`, `agentSessionService`, `notificationService`, and others.
- **Backend routes seen only as a route list**: `permissions`, `dashboards`, `reports`, `roadmap`, `worklogs`, `releaseMgmt`, `customfields`, `screens`, `workflows`, `metadata`, `system`, `migration`, `meta`, `issueSecurity`, `agentSessions`, `issueOps`, `oauth`, `scim`.
- **Importers** (`apps/backend/src/import`), the JQL lexer/parser, `s3Store`, the Prisma schema and migrations, tests, CI workflows.
- **Dependencies**: no vulnerability scan was run.
- Because permission checks inside the unread services were not traced, routes that rely on them (sprint moves, board configuration, bulk operations, issue create/update/delete) are neither cleared nor flagged.

## 10. Suggested fix order

1. **Before any customer sees it**: A1, A2, A3, B1, B2, C1, C2, D1, D2, F1, E1.
2. **Before calling it finished**: G1, G2, G3, B3, D3, D4, C3, C4, E2, E3, E4, A4, A6, A7, F2.
3. **Hardening sprint**: F3, G4–G8, section 6, remaining Low items.
4. **Second audit pass** over section 9, then a dynamic pass: run the test suite, and write a failing test for each [inferred] item and for A1, B1, B2, C1 and D1.

## 11. Remediation status (065 repo-cleanup, appended after fix work)

Every finding above has been addressed in the working tree; regression tests
cover the security-sensitive fixes (auth, dev, mail, automation, security,
leak, identity, agent/copilot suites all green alongside the full backend
suite: ~930 passing).

| Tier | Items | Status |
|---|---|---|
| 1 — ship blockers | A1–A3, B1–B2, C1–C2, D1–D2, E1, F1 | **Fixed.** Session `kind` rejection + mandatory sid; `sessionSecret()` env→file→dev resolution; prod secret/password floors; session-only token mint; proposal review requires `ADMINISTER_PROJECTS`; SSE per-client project scope; restricted-comment redaction in events/AI/JQL-FTS; automation issue scoping + actor visibility; smart-commit unverified-author skip + repo project map; all ops handlers `ah`-wrapped + process handlers; password values out of audit detail. |
| 2 — before finished | G1–G3, B3, C3–C4, D3–D4, E2–E4, A4, A6–A7, F2 | **Fixed.** `PUBLIC_BASE_URL` mail links; invite TTL; per-name advisory locks + tx budgets; copilot token laundering closed (`tok` claim replayed, approval gate enforced); print export + comment visibility checks; rule-actor reset on foreign edit; webhook egress via `egressFetch`; pre-auth IP limiter; Jira-shaped 400s; CSP/HSTS; TOTP attempt limits + salted backup codes; OIDC iss/aud/timeout/state-binding + partial IdP PUT; dead admin surfaces wired (password reset, auth policy, group TOTP); SMTP pass masked on write. |
| 3 — hardening | A5, B4, C5, D5–D7, E5, F3–F5, G4–G9 | **Fixed.** Async scrypt + per-account lockout + admin-pw policy + session revocation + http-base-url prod warn; `autoApply` restricted to non-destructive triggering-issue writes; createmeta browse check, `isAdmin` off public beans, assignable 2-char floor, automation rule GET authz + masked secrets, private-filter subscription check, per-recipient mail visibility; GitLab branch/MR under auth chain + enabled-repo guard, webhook secret shown once, Bitbucket `X-Hub-Signature`; idempotency claim-first + query-hash; secrets AES-256-GCM at rest (SMTP pass, IdP clientSecret, repo/webhook secrets — `readSecret` migrates legacy rows); single-use expiring `ConfirmToken` (delete/restore/project-delete); backup-id traversal guard; mail digest/subscriber-hour/unsubscribe-URL; cron names + Sunday + save-time validation; job map pruning; retention default aligned to 90d; RFC-5987 filenames; attachment checksums in backup + verify; `docs/ha.md` multi-instance matrix incl. OIDC state. |

**Remaining (accepted/documented, not code bugs):**
- Section 9 areas never read (frontend, MCP, ~half of backend) — a second
  pass is still recommended before a security-sensitive launch.
- `gitlab.signingToken` inside the `gitlab` JSON extras column remains
  plaintext — same protection class as the JSON column it lives in.
- Multi-instance caveats are documented in `docs/ha.md` (in-process SSE +
  OIDC state), not rearchitected.
- Section-6 perf notes (N+1s, unbounded queries) are unchanged — acceptable
  at self-hosted scale, revisited when data sizes demand.

# Sprint 064 — Pre-Release Security Audit (Launch Blocker)

| | |
|---|---|
| **Status** | Planned — deep audit complete, findings enumerated below; nothing fixed yet |
| **Milestone** | LW Launch wedge — **gates publish/GA**. P0s must close before release; P1s close here or land tracked in `hardening-backlog.md` for the H8 gate |
| **Theme** | Close every exploitable path the pre-release audit confirmed: one unauthenticated ATO, broken-visibility read paths, assumed-identity write paths, and a stale dependency floor |
| **Depends on** | 063 (installable proof), 053 (scope enforcement — this is wave 2 of the same audit method), 036 (identity), 049 (OAuth/SCIM), 018 (attachments), 034 (automation) |
| **Unblocks** | Public/GA release; trustworthy multi-user + multi-tenant deployment |
| **Spec-kit folder** | `specs/064-pre-release-security-audit/` |

> **Origin**: pre-release penetration review (backend + frontend + JQL + MCP + deps +
> deployment). Method: same deep-audit as 053 — four parallel surface sweeps plus manual
> trace of the auth core. Findings below are all **confirmed against source**, each with a
> reproduction. `pnpm audit` today: 1 critical / 5 high / 12 moderate — `audit-check`
> currently fails CI (empty `scripts/audit-allowlist.json`).

## Goal

- **No unauthenticated path to a session**: the reset flow delivers tokens by mail only,
  auth endpoints are throttled, and no malformed input can crash the process.
- **Every read path applies the same three gates** — token `projectKeys` allow-list,
  `BROWSE_PROJECTS`, `canSeeIssue` — through one shared helper, not per-route memory.
- **Authority can't be claimed, only granted**: channel headers, author emails, IdP
  emails, and automation `actorId`s are verified against something stronger than the
  request itself.
- **Outbound fetches honor egress policy at delivery time**, not registration time.
- **Supply chain is clean**: `pnpm audit --prod` passes at `high+` with an empty allow-list.

## Scope

**In**: every finding in this doc (P0 = US1–US4, P1 = US5–US6) + regression tests +
the shared `visibleIssueWhere(actor)` refactor that makes the US3 fixes structural.

**Out**: the centralized route/scope codegen registry (arch review — the helper in US3 is
the interim enforcement); redesigning the permission model; MFA beyond TOTP; pen-test
tooling/dynamic scanning (this sprint closes the static-audit findings).

## User stories

### US1 — Authentication boundary holds (P0, blocks release)

As an operator, I want no unauthenticated request to yield a credential, brute-force a
password, or crash the process.

1. **Given** any deployment mode, **When** I `POST /api/internal/auth/reset-request
   {"email":"admin@…"}`, **Then** the response carries **no** token material — today
   `x-reset-token` returns the raw reset token unconditionally (`routes/identity.ts:71-79`;
   comment claims "non-production" but nothing gates it — unauthenticated ATO of any
   account). The reset link must ride the 029 mail outbox; with SMTP unconfigured the
   endpoint returns the generic 204 and logs the undeliverable.
2. **Given** a request to any `/rest` or `/api/internal` route with `Cookie: x=%`,
   **When** `requireAuth` runs, **Then** the request gets a 4xx/500 response, **not** a
   process exit — `decodeURIComponent` in `parseCookies` (`lib/auth.ts:94-102`) throws
   inside the async middleware and Express 4 turns the rejection into an unhandled
   rejection → crash. Wrap `resolveRequestActor` (auth resolution, incl. Prisma throws) and
   the cookie decoder.
3. **Given** `/api/internal/auth/*` mounts before `rateLimit` (`main.ts:80-81` vs `:142`),
   **When** I fire 1000 logins/min or TOTP codes, **Then** a strict per-IP limiter (≤10/min)
   throttles me — today password brute-force, 6-digit TOTP within the 5-min `pending`
   window, and reset spam are all unbounded. Include a failed-attempt counter on
   `consumeSecondFactor` (lock `pending` after N misses).
4. **Given** `PUBLIC_BASE_URL` is `https://…`, **When** the session cookie is set
   (`auth.ts:38`, `identity.ts:121`), **Then** `Secure` is set — today the flag is absent
   and a TLS-terminating proxy still leaves the cookie vulnerable on any HTTP hop. Also fix
   `remember`: the 30-day cookie outlives the 12h session row + JWT (align or drop).

### US2 — Rendered and stored URLs can't carry script (P0)

As a user, I want links stored by other users to be incapable of executing JavaScript in
my session.

1. **Given** `POST /rest/api/2/issue/{key}/remotelink {"object":{"url":"javascript:…"}}`,
   **When** stored, **Then** 400 — today `issues.ts:872-892`/`issueOpsService.ts:84-94`
   persist `url` verbatim and `LinkedIssuesPanel.tsx:237` renders it as `href` (React does
   not block `javascript:` → stored XSS, click-to-fire, same-origin `fetch` bypasses
   `httpOnly`). Server-side scheme allow-list (`https?`, `mailto`) + render-time guard.
2. **Given** a `url`-type custom field, **When** `fields.{cf}` receives
   `javascript:alert(1)`, **Then** rejected — `cfTypes.ts:58` `z.string().url()` accepts
   any parseable scheme; `CustomFields.tsx:92` renders it verbatim. Same fix both ends.
3. **Given** `GET /oauth/device?user_code="><script>…`, **When** the page renders,
   **Then** escaped — `routes/oauth.ts:154-165` interpolates `user_code` unescaped into a
   double-quoted attribute (reflected XSS in the auth origin). Show client name + requested
   scopes on the approval page, add `X-Frame-Options`/`frame-ancestors` to `/oauth/*` HTML,
   and drop `admin` from DCR-allowed scopes (`oauthService.ts` `validScopes`).
4. **Given** dev-panel integration URLs (`DevelopmentPanel.tsx:10`), **When** rendered,
   **Then** non-`https?` values render as text, not `href`.

### US3 — Visibility is one helper, applied everywhere (P0)

As an admin, I want `projectKeys` + `BROWSE_PROJECTS` + issue-security to be a single
enforcement primitive every read path uses — the root cause of all findings below is
each route hand-rolling a subset.

Introduce `visibleIssueWhere(actor)` (extends `issueSecurityService.visibleIssuesWhere`
with token allow-list + `nonBrowsableProjectIds`) and `visibleProjectIds(actor)`; port the
call sites and add leak-test regressions (`tests/integration/leak.test.ts` pattern):

1. **Given** issue data I cannot browse, **When** `GET /api/internal/events` or
   `/events/:id`, **Then** filtered — today only `projectKeys` is applied (`events.ts:22-65`,
   `119-135`); the SSE path's `eventIssueVisible` proves the check exists but was skipped.
2. **Given** a non-JQL report (`/reports/board/:id/*`, `/sprint/:id/report`, `/project/:key`,
   `/timesheet?userId=…`, version/epic/workload), **When** I lack BROWSE, **Then** no data —
   `reportService.ts` never consults `nonBrowsableProjectIds`/`projectAllowed`;
   `timesheet` must scope `userId` to self unless admin/`VIEW_ALL_WORKLOGS`.
3. **Given** a PAT with `projectKeys:["PUB"]`, **When** I bulk-select `SECRET-*` keys
   explicitly or sync `/rest/api/2/worklog/updated`, **Then** 404/empty — `bulkService.
   resolveSelection` and `worklogs.ts` check `nonBrowsableProjectIds` but not the
   allow-list; bulk per-op gates must also AND `canSeeIssue` (security-levelled issues are
   currently bulk-editable).
4. **Given** `/api/internal/ai/issues/SECRET-1/summary` (and `similar|draft|breakdown`),
   **When** I lack BROWSE, **Then** 404 — `aiService.ts` checks `projectAllowed` only.
   Same for `GET /me/work|recent-views|notifications` and `getPublicProfile`
   (`identityService.ts:100-153` — profile issues/comments leak cross-project).
5. **Given** `GET /version/:id/releasenotes` on a non-browsable project, **When** fetched,
   **Then** 404 — `releaseMgmt.ts` `assertProjectVisible` is `projectAllowed` only;
   applies to component/version reads and issue counts too.
6. **Given** `GET /api/internal/agent-sessions/:id`, automation `GET /rules/:id` +
   `/rules/:id/runs`, **When** the resource isn't mine/visible, **Then** 404 — by-id loads
   carry no authz (list endpoints filter, detail endpoints forgot).
7. **Given** `POST /me/recent-views` with a hidden issue key, **When** recorded, **Then**
   `enforceIssueScope` first.

### US4 — Delegated authority can't be assumed (P0)

As an admin, I want writes that run *as someone else* to verify the delegation, not infer
it from request-controlled fields.

1. **Given** a token/user with `approvalPolicy:"always"`, **When** the request carries
   `X-TrackForge-Channel: copilot`, **Then** the proposal gate still applies — today
   `requireAuth` honors the client-claimed channel (`middleware/auth.ts:154-157`) and
   `proposalGate` bypasses on `copilot` (`proposals.ts:62`). Only the signed internal
   header may claim `copilot`/`mcp`.
2. **Given** a global automation rule authored by an admin, **When** any user calls
   `POST /automation/rules/:id/{run,dry-run}` or `/scheduled-tick`, **Then** 403 —
   zero authz today; actions execute as `rule.actorId` against a caller-chosen `issueKey`
   (`automation.ts`, `automationService.ts:481-548`). Dry-run issue enumeration must apply
   US3's `visibleIssueWhere`. `PUT /rules/:id` must re-run `canAuthor` so a project admin
   can't flip a rule to `scope:"global"`.
3. **Given** a smart-commit payload with `author.email = admin@…`, **When** `#done`/`#comment`
   executes, **Then** the actor is a least-privilege smart-commit principal or a verified
   author mapping — today `devService.resolveActor` grants the matched user's full rights
   to any repo contributor who sets `--author` (also reachable via authenticated
   `/rest/devinfo/0.10/bulk`). Add a per-repository trusted-author allow-list or
   externalIdentity match; unmapped authors get a dedicated low-priv actor.
4. **Given** a SCIM/LDAP directory asserting `email = <existing local user>`,
   **When** first sync runs, **Then** no silent link — `scimService`/`directoryService`
   "email-link" claims pre-existing accounts, letting the IdP rewrite/deactivate them
   (incl. credential revocation). Manage provisioned identities only; linking an existing
   account requires explicit admin confirmation.
5. **Given** `trackforge-mcp --http --port 3001` with `TRACKFORGE_TOKEN` set, **When** a
   request arrives without `Authorization`, **Then** 401 — today it executes as the
   daemon's PAT (`mcp/src/index.ts:70-80`). Add a server-level `--readonly` flag (not the
   client-hint `?toolset=`) and document TLS.
6. **Given** `POST /api/internal/automation/scheduled-tick` and `/rest/devinfo/0.10/bulk`,
   **When** a non-admin/non-dedicated credential calls them, **Then** 403.

### US5 — Egress re-validated at delivery (P1, required before GA)

As an operator, I want every outbound fetch to enforce the private-network policy when it
actually connects — defeating DNS rebinding, redirects, and literal-form bypasses.

1. **Given** a webhook URL of `http://[::1]:3000/…`, `[::ffff:7f00:1]`, or a public host
   that 302s to `169.254.169.254`, **When** delivery runs, **Then** refused —
   `webhookService.ts` keeps `[`/`]` so `isIP` misses, checks only the first DNS answer at
   registration, and `fetch` follows redirects unchecked. Resolve `{all:true}` at delivery,
   strip brackets, `redirect:'manual'` + re-validate each hop, widen the blocklist
   (unspecified, all `::ffff:` forms, NAT64, 198.18/15, multicast/reserved, port policy).
2. **Given** an OIDC `id_token`, **When** `finishOidc` decodes it (`identityService.ts:417`),
   **Then** signature (JWKS), `iss`, `aud`, and `nonce` are verified — today `jwt.decode`
   only; `http://` issuers rejected at `upsertIdp`; `claimMap.{token,userinfo,authorization}
   Endpoint` URLs pass the same egress guard as webhooks.
3. **Given** `GET /oauth/authorize?client_id=https://<attacker>` (metadata-document
   clients, `oauthService.ts:90-140`), **When** the doc is fetched, **Then** egress-guarded
   and no redirect following — blind SSRF today; also rate-limit and flag persisted
   clients registered this way.
4. **Given** import attachment `content:` URLs and `POST /ai/settings/test {baseUrl}`,
   **When** fetched, **Then** the same guard + `redirect:'manual'` (`importers.ts:495-515`,
   `ai.ts`). Admin-initiated today but untrusted-origin content drives the request.
5. **Given** `env:` secret references (GitLab `apiTokenRef`, LDAP `secretRef`) and LDAP
   `hosts`, **When** resolved, **Then** an allow-listed set of env names (block
   `DATABASE_URL`, `SESSION_SECRET`, `*_FILE`) and LDAP hosts pass the egress guard —
   today any env var can be exfiltrated to an admin-chosen host.
6. **Given** Jira-Server import `baseUrl`, **When** validated (`jiraServerClient.ts`),
   **Then** DNS is resolved (not just hostname-regex) and `allowPrivate` requires explicit
   operator opt-in per connection.

### US6 — Platform hardening & supply chain (P1, required before GA)

As an operator, I want the shipped artifact to pass its own audit gate and degrade
gracefully under abuse.

1. **Given** `pnpm audit --prod`, **When** `audit-check` runs, **Then** green with empty
   allow-list: `express` bump (pulls `body-parser ≥1.20.9`, `qs ≥6.16.1`, `proxy-addr
   ≥2.0.8`), `sharp ≥0.35.5`, `sanitize-html ≥2.18` (4 XSS-adjacent CVEs on the markdown
   path), `file-type ≥21.3.2`, `zod ≥4.6.6` (or backported patch), transitive `uuid`/
   `deepmerge`.
2. **Given** `multer({memoryStorage})` (`attachments.ts:26`), **When** a request carries
   500 parts, **Then** rejected — add `files`/`parts`/`fields` caps (heap is unbounded
   today).
3. **Given** 100kb of nested `(((((…` JQL or `assignee in (u1,…,u5000)`, **When** compiled,
   **Then** bounded — JQL length cap (~4KB), AST node/depth cap, operand-count cap,
   per-compile resolution budget; `statement_timeout` on search queries.
4. **Given** security headers, **When** any HTML is served, **Then**
   `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, and a
   baseline CSP on the SPA + OAuth pages (attachments already self-protect).
5. **Given** the in-memory rate-limit `Map`, **When** many principals hit it, **Then**
   bounded memory + consistent limits across replicas — move to the Redis already shipped
   for BullMQ, or a bounded LRU; document `trust proxy` (unset today → limiter buckets on
   the LB IP and audit logs record it).
6. **Given** CSV exports, **When** a cell starts `=`/`+`/`-`/`@`, **Then** formula-escaped
   (`exportService.ts`); unsubscribe links render a confirm page + POST instead of a
   state-changing GET; XML importer caps `entities.xml` entry size + `processEntities:
   false`; `GET /me/recent-views` join applies US3 helper; refresh-token rotation checked
   inside its transaction; `idempotency` check-then-act made atomic or documented.

## Non-functional requirements

- **FR-001**: Every P0 fix ships with a regression test that fails on the pre-fix code
  (the leak-test pattern). Auth-boundary fixes get `supertest` reproductions (curl-level).
- **FR-002**: `visibleIssueWhere`/`visibleProjectIds` become the *only* visibility
  primitives — a follow-up lint or code-search gate (`scripts/`) fails CI when a route
  queries issues through `nonBrowsableProjectIds`/`projectAllowed` directly.
- **FR-003**: The egress guard is one shared module (`lib/egress.ts`) — webhook, OIDC,
  metadata-doc, importer, and AI-test call sites all consume it.
- **FR-004**: No behavior changes for valid users — Jira-compat shapes, dryRun,
  idempotency, and the error contract stay intact (OpenAPI drift test stays green).
- **FR-005**: `SESSION_SECRET` is fail-closed everywhere: refuse to boot (any `NODE_ENV`)
  when unset **or** print a boot-blocking warning with an explicit `TF_DEV_INSECURE=1`
  escape hatch — the dev default is the key to session JWTs, internal-actor signatures,
  the AI-key cipher, and every HMAC confirm-token in the codebase.

## API surface (candidates)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/auth/reset-request` | Remove `x-reset-token`; mail via outbox |
| — | `middleware/auth.ts` | try/catch `resolveRequestActor`; safe cookie decode; auth-surface limiter |
| POST | `/rest/api/2/issue/{key}/remotelink` | URL scheme allow-list |
| GET | `/oauth/device`, `/oauth/authorize` | Escape `user_code`; show client+scopes; frame headers; DCR scope drop |
| — | `issueSecurityService` / new `lib/visibility.ts` | `visibleIssueWhere`, `visibleProjectIds` |
| GET | `/api/internal/events*` | Apply US3 helper |
| GET | `/api/internal/reports/*`, `/me/*`, `/rest/api/2/{component,version}*` | Apply US3 helper + BROWSE |
| POST | `/api/internal/automation/{rules/:id/run,rules/:id/dry-run,scheduled-tick}` | Caller authz + scope |
| — | `lib/egress.ts` | Shared outbound guard (delivery-time, redirects, IPv6, blocklist) |
| — | `identityService.finishOidc` | JWKS verify + iss/aud/nonce |
| POST | `/rest/devinfo/0.10/bulk`, `/unsubscribe` | Dedicated credential; GET→confirm page |
| — | `mcp/src/index.ts --http` | No env-token fallback; `--readonly` flag; TLS docs |

## Success criteria

- **SC-001**: `curl` repros for US1.1–US1.3 and the cookie-crash fail post-fix (tests).
- **SC-002**: `javascript:` remotelink/CF/device-page payloads are rejected or inert (tests
  + DOM assertion).
- **SC-003**: A token scoped to `projectKeys:["PUB"]` and a user without `BROWSE` on
  `SECRET` cannot reach `SECRET` data via events, reports, /me, AI, bulk, worklogs,
  release notes, profiles, or by-id loads — one parameterized leak test per surface.
- **SC-004**: `X-TrackForge-Channel: copilot` on an `always`-gated token still produces a
  202 proposal; automation run/dry-run 403s non-privileged callers; smart-commit author
  spoofing executes as the low-priv actor.
- **SC-005**: `pnpm audit --prod` exits clean at `high+` (allow-list stays empty); CI
  `audit-check` green.
- **SC-006**: Threat-model entries for the changed surfaces; `docs/compatibility.md` and
  `eval/compat.ts` updated where responses changed.

## Risks

| Risk | Mitigation |
|---|---|
| US3 helper port touches ~10 route families; scope creep | Port behind the helper one family at a time with per-family leak tests; ship P0 families first (events, reports, bulk) |
| Egress re-validation at delivery adds DNS latency per webhook | Cache validated resolutions for the connection TTL; keep the 5s fetch timeout |
| OIDC JWKS verify breaks exotic IdPs that only expose userinfo | Keep the userinfo-claims path (already claim-verified); document `jwksUri` per-IdP config |
| `Secure` cookie breaks plain-HTTP intranet installs | Conditional on `PUBLIC_BASE_URL` scheme — documented in env reference |
| zod 4.x upgrade has breaking API surface | Evaluate backport patch first (`3.25.x`); if 4.x, stage the migration in this sprint's first PR |
| Smart-commit identity mapping breaks existing repos | Default unmapped authors to low-priv actor + log; admin UI shows the mapping table |

## Operator notes (not code — user actions at deploy)

- Rotate any import credential (e.g. `JIRA_TOKEN`) that ever lived in a local `.env`
  (plaintext on disk — never committed, but rotate if the file was ever synced/shared).
- `docker-compose.prod.yml` relies on the image's `ENV NODE_ENV=production`; bare
  `node dist/main.js` skips the prod gate — covered by FR-005.
- Set `METRICS_BEARER`, `WEBHOOK_ALLOW_PRIVATE=false`, real `SESSION_SECRET`,
  `PUBLIC_BASE_URL=https://…` per `docs/env-reference.md` before publish.

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Every finding in this doc has a failing-now regression test committed before its fix.
- [ ] `pnpm audit --prod` clean at `high+`; `audit-check` and all CI gates green.
- [ ] Threat-model updated (`docs/`); `compatibility.md` + `eval/compat.ts` regenerated.
- [ ] Changelog/release notes call out the auth-surface, header, and scope changes for
  self-hosters.

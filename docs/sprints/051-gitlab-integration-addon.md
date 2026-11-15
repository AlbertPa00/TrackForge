# Sprint 051 — GitLab Integration Add-on

| | |
|---|---|
| **Status** | ✅ Implemented (2026-11-08) — SC-001/003 green vs fixture; SC-002/004 need a live GitLab (fixture covers the contracts) |
| **Milestone** | M5 Enterprise & reach |
| **Theme** | Provider-deep integration — the GitLab-side of the development panel |
| **Depends on** | 038 (dev panel, `DevelopmentItem` model, smart-commit processor, events), 021 (admin shell), 016 (job runner), 049 optional (OAuth client credentials for GitLab v4 calls) |
| **Unblocks** | Self-managed GitLab ↔ TrackForge parity with Jira's DVCS connector + GitLab-for-Jira app |
| **Spec-kit folder** | `specs/051-gitlab-integration-addon/` |

> **Why a separate sprint:** 038 ships the *provider-agnostic* ingest (webhook →
> `DevelopmentItem` → panel) including a `/dev/gitlab` receiver. This sprint is the
> **GitLab-specific depth** Jira operators expect: API-driven backfill/sync (GitLab v4),
> outbound actions (create branch/MR from the issue), GitLab's own push protocol
> (`/rest/devinfo/0.10/bulk`, what the official GitLab-for-Jira app posts), and support
> for GitLab's *native* Jira integration pointed at TrackForge — the zero-code path.
> Verified against GitLab docs + Atlassian devinfo docs (2026-11-12).

## Goal

The three real-world GitLab ↔ issue-tracker paths, all supported:

1. **GitLab webhooks → panel** (038 base + GitLab hardening): `X-Gitlab-Token`
   *and* HMAC-SHA256 signing-token verification (GitLab ≥16 recommended);
   events: `push`, `merge_request`, `pipeline`, `deployment`, `feature_flag`,
   `note`, `tag_push`. Normalize into `DevelopmentItem` — plus GitLab-specific
   fields (MR approvals/reviewers, pipeline stages/jobs, environment names).
2. **API sync & backfill** (DVCS-connector equivalent): connect a GitLab
   instance (gitlab.com **or self-managed base URL**) with a PAT; enumerate
   group projects via `/api/v4`; backfill last-N branches/MRs (GitLab-for-Jira
   seeds the last 400) into dev items; incremental poll cursor for instances
   where webhooks can't reach us (firewalled self-managed).
3. **`/rest/devinfo/0.10/bulk` receiver**: accept the devinfo payload shape
   (repositories, branches, commits, pullRequests, builds/pipelines,
   deployments, featureFlags, `updateSequenceId` ordering) so tools built for
   Jira's dev-info surface — including GitLab's own sync workers — can push
   into TrackForge unmodified.
4. **Outbound actions**: "Create branch" / "Create MR" on the dev panel →
   `POST /api/v4/projects/:id/repository/branches` · `/merge_requests`; links
   back on the panel item. PAT stored in the secrets store, never echoed.
5. **GitLab native Jira integration path** (documented + tested): GitLab's
   built-in *Jira issues* integration (project/group/instance settings) posts
   to Jira `/rest/api/2` — point it at TrackForge. Verify: issue links render
   in GitLab, MR-merge adds a comment via `POST /issue/{key}/comment`, Basic
   auth (user+PAT) authenticates. Zero code — a supported configuration with
   an integration test fixture.

## Scope

**In**: `GitLabConnection` model (instance URL incl. self-managed + custom CA/SSL-verify
flag, token ref, group/project mapping, sync cursor, webhook-vs-poll mode);
devinfo-compat receiver (async accept → normalize → `DevelopmentItem`); backfill
job (batched, resumable, rate-limit aware) on the 016 runner; GitLab adapter
extensions (pipelines, deployments, feature flags, MR approvals, reviewers);
panel outbound actions; setup wizard under `/admin/development/gitlab`
(test-connection call `GET /api/v4/user`, group picker, per-project map,
webhook-secret display-once); MCP `gitlab_create_branch` /
`gitlab_create_merge_request` (issue-scoped, dryRun-aware).

**Out**: GitLab issues/epics two-way sync (separate product domain), GitLab
source-code browsing inside TrackForge (038 out too), OAuth-app installation
flow for gitlab.com SaaS (v1 = PAT; 049 OAuth2 client enables it later),
GitLab → TrackForge user mapping beyond email match, Gitea/Codeberg
lookalikes (adapter pattern exists — document, don't build).

---

## User stories

### US1 — Hardened webhook receiver (P1)

1. **Given** a GitLab webhook with a signing token, **When** `push`/`merge_request`/`pipeline`/`deployment`/`feature_flag` events arrive, **Then** HMAC-SHA256 verifies; legacy `X-Gitlab-Token` plaintext headers also verify (per-connection choice, signing token preferred); delivery id dedupes.
2. **Given** an `merge_request` event, **When** normalized, **Then** the `DevelopmentItem` carries state, reviewers/approvals, source→target branch, pipeline status — the panel shows Jira-layout rows with GitLab links.
3. **Given** a `pipeline`/`deployment` event, **When** normalized, **Then** build/deployment items update in place and emit `dev_status_changed` (034 automation).

### US2 — Connection + backfill (P1)

1. **Given** `/admin/development/gitlab` with instance URL + PAT, **When** "test connection" runs, **Then** `GET /api/v4/user` validates scope (`read_api` minimum) and version; on save, the connection is created with project mapping.
2. **Given** a mapped group, **When** backfill runs, **Then** projects enumerate via `/api/v4/groups/{g}/projects?include_subgroups`, last-400 MRs and last-400 branches+head-commit ingest per project (GitLab-for-Jira parity), batched ≤20 projects/min on the 016 runner, resumable on failure.
3. **Given** webhook-unreachable self-managed GitLab, **When** poll mode is on, **Then** an incremental cursor (per-project `updated_at`) syncs new MRs/pipelines on schedule — eventual-consistency documented.

### US3 — devinfo-compatible receiver (P2)

1. **Given** `POST /rest/devinfo/0.10/bulk` with a GitLab-shaped payload (`providerMetadata`, repositories/branches/commits/pullRequests/pipelines/deployments/featureFlags), **When** verified (Bearer PAT with `write` scope), **Then** entities upsert honoring `updateSequenceId` — older submissions don't clobber newer data; 202 async semantics.
2. **Given** `DELETE /rest/devinfo/0.10/repository/{id}/{entityType}/{entityId}`, **When** called, **Then** the item is removed (GitLab sends branch-deletion via `remove_branch_info`).

### US4 — Outbound actions (P2)

1. **Given** the dev panel on `TF-9`, **When** "Create branch" is clicked, **Then** name defaults to `TF-9-<slug>`, base ref picker lists the repo's branches (cached), `POST /api/v4/.../branches` executes with the stored PAT, and the new branch appears as a panel item with deep link.
2. **Given** "Create MR" **When** submitted, **Then** `POST /api/v4/.../merge_requests` with title pre-filled `TF-9 <summary>`; failures (protected branch, perms) surface verbatim in the UI.
3. **Given** MCP `gitlab_create_branch`, **When** called, **Then** same path executes — panel + API identical (A1); dryRun returns the would-be request.

### US5 — GitLab native-Jira path (P2, docs+test)

1. **Given** a GitLab project's *Jira issues* integration pointed at TrackForge (`Web URL` + `Jira API URL` = TF base), **When** "test settings" runs, **Then** GitLab's `GET /rest/api/2/serverInfo` (and issue GET) succeeds against our Jira v2 surface.
2. **Given** an MR merged mentioning `TF-9`, **When** GitLab posts its comment, **Then** `POST /rest/api/2/issue/TF-9/comment` stores it with the GitLab author's PAT attribution — fixture replayed in an integration test.

---

## Edge cases

- Self-managed TLS with internal CA → per-connection `verifySsl` + CA bundle path; never a global disable.
- GitLab group with 100s of projects → backfill batches + progress in admin UI; per-project failure doesn't abort the run.
- Webhook flood (mono-repo push storms) → receiver enqueues, never processes inline (016 contract); dedupe on `X-Gitlab-Event-UUID` where present.
- devinfo `updateSequenceId` out-of-order arrivals → last-writer-wins on the sequence, not on arrival time.
- PAT rotation/revocation mid-sync → connection marked degraded, admin notified, no silent failure.

## Functional requirements

- **FR-001**: All inbound paths MUST verify authenticity (signing-token HMAC or secret token or PAT Bearer for devinfo) and dedupe before enqueue.
- **FR-002**: `DevelopmentItem` MUST stay provider-agnostic; GitLab extras live in `payload` + typed fields the panel understands — panel code never branches on provider beyond a formatter map.
- **FR-003**: Outbound GitLab calls MUST use the connection's stored token, honor 049-style secret hygiene (hashed at rest, never echoed), and audit each call.
- **FR-004**: Backfill/poll MUST run on the 016 job runner — resumable, rate-limit-aware (respect `Retry-After`).
- **FR-005**: The native-Jira path MUST need zero TrackForge code changes — if verification shows a gap (e.g. `serverInfo` field), fix the v2 surface, not a GitLab shim.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/dev/gitlab` | 038 receiver — gains signing-token + event coverage here |
| POST/DELETE | `/rest/devinfo/0.10/bulk` · `/repository/{id}/{entityType}/{entityId}` | devinfo-compat (subset documented in `docs/compatibility.md`) |
| GET/POST/PUT/DELETE | `/api/internal/dev/gitlab/connections` | Admin connection CRUD (extends `DevRepository` or sibling) |
| POST | `/api/internal/dev/gitlab/connections/{id}/test` · `/backfill` | Test + trigger |
| POST | `/api/internal/issues/{key}/gitlab/branch` · `/merge-request` | Outbound actions |

## Data model changes

- **GitLabConnection**: `id`, `name`, `baseUrl`, `apiTokenRef`, `verifySsl`, `caBundlePath?`,
  `groupPath`, `projectMap Jsonb`, `mode (webhook|poll|both)`, `syncCursor Jsonb`,
  `webhookSecret`, `signingToken`, `enabled`.
- `DevelopmentItem.payload` gains GitLab-typed fields: `pipeline {stages,jobs}`,
  `mergeRequest {approvals,reviewers,sourceBranch,targetBranch}`, `deployment {environment}`,
  `featureFlag {name,state}`.
- **DevDelivery** (038) reused for devinfo submissions.

## MCP tools added

`gitlab_create_branch`, `gitlab_create_mr` (dryRun-aware),
`gitlab_connection_status` (inspect mode/cursors/backfill/lastError).
`get_dev_status` (038) unchanged — panel + tool read the same model.

## AI-native checklist

- [x] Agents create branches/MRs through the same endpoint the panel uses (A1) — MCP `gitlab_create_branch`/`gitlab_create_mr` hit `/api/internal/issues/{key}/gitlab/*`.
- [x] Backfill/poll state inspectable via API (A2) — `GET …/connections/{id}/status` exposes mode, `syncCursor`, `backfill`, `lastError`; MCP `gitlab_connection_status`.
- [x] devinfo submissions are deduped/ordered so re-push by an external tool is safe (A4) — `updateSequenceId` monotonic per repository; stale payloads marked, not applied.

## Success criteria

- **SC-001**: ✅ Self-managed GitLab (fixture): connect → test → backfill → webhook → panel shows MR + pipeline + deployment. *Verified — `tests/integration/gitlab.test.ts` (fixture GitLab v4 server).*
- **SC-002**: ⏳ A real GitLab instance's *Jira issues* integration, pointed at TrackForge, passes its own "test settings" and comments on merge. *Contract verified in the fixture (serverInfo + issue/comment via Basic `user:PAT`); needs a live GitLab for final sign-off.*
- **SC-003**: ✅ A devinfo payload captured from GitLab-for-Jira replays 1:1 — same entities land. *Verified — bulk upsert, stale-seq skip, and delete-by-repository covered in `gitlab.test.ts`.*
- **SC-004**: ⏳ Agent eval: "create a branch for TF-9 and open an MR" completes via MCP with correct links. *Tools ship (`gitlab_create_branch`/`gitlab_create_mr`) hitting the same routes the panel uses + dry_run support; the live eval needs a reachable GitLab.*

## Risks

| Risk | Mitigation |
|---|---|
| devinfo API is Cloud-shaped, on-prem DVCS differs | Documented subset; on-prem path = webhook+poll, devinfo is the Cloud-app-compat lane |
| GitLab API version drift across self-managed releases | `GET /api/v4/metadata` version gate on connect; fixture matrix of supported ranges |
| Secret sprawl (PAT + webhook secret + signing token per connection) | One secrets-store discipline (006/049); display-once, hashed, rotatable |
| GitLab's own Jira integration sends fields we don't support | FR-005 — fix the v2 surface; log unsupported fields to the admin view, never 500 |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints) — backend suite 802/804 green (2 skipped), typecheck clean, openapi drift test green (all 12 routes documented), threat-model row added.
- [x] `docs/compatibility.md` gains the devinfo subset row.
- [x] Setup guide: webhook mode (gitlab.com + self-managed) and poll mode (firewalled) — `docs/admin-guide.md` § GitLab integration.
- [x] Fixture suite: captured GitLab webhook + devinfo payloads replay deterministically — in-process GitLab v4 fixture in `tests/integration/gitlab.test.ts`.

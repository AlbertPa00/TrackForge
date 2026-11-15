# Sprint 016 — Platform Reliability (Hardening H1)

| | |
|---|---|
| **Status** | **Done** — all five tracks landed across 5 slices: durable-job port (in-memory + BullMQ/Redis adapters), all periodic jobs on the durable runner with single-exec proof; ops surface `/healthz`+`/readyz`+`/metrics` + admin jobs API + MCP `get_job_status`/`retry_job`; pino structured logs (secret-free, tested); `pnpm audit` CI gate with expiring allow-list; 50k deterministic perf fixture + CI budgets (caught + fixed a JQL-compile regression); frontend test baseline (RTL, 13 tests, 89% lines vs 60% gate); threat model + deployment docs + hardening backlog |
| **Milestone** | M1 Parity MVP |
| **Theme** | Hardening — build once the infrastructure every later sprint was deferring |
| **Depends on** | 011 (outbox dispatcher behind `JobRunner` port — 011 FR-006), 014/015 (perf + permission budgets to measure) |
| **Unblocks** | 017 importer jobs, 023 bulk jobs, 029 email outbox/subscriptions, 034 automation schedules, multi-instance deployment |
| **New dependencies (justified)** | `bullmq` + Redis service (constitution §stack lists Redis + BullMQ; D20), `pino` (structured logs), `@testing-library/react` (frontend unit tests) |
| **Spec-kit folder** | `specs/016-platform-reliability/` |

## Goal

Four later sprints (bulk, email, automation, migration) each said "in-process runner for now".
That compounds into duplicate infrastructure and double-executing crons on more than one
instance. This sprint pays the debt once, before the features that need it, and installs the
quality gates the critique found missing:

1. **Job runner & scheduler** — `JobRunner`/`Scheduler` ports; BullMQ adapter (Redis) for
   prod, in-memory adapter for tests; repeatable jobs run exactly once cluster-wide; 011's
   outbox dispatch moves onto it.
2. **Observability** — structured logs with request/actor/channel/trace ids, `/metrics`
   (Prometheus text: request latency, job queue depth/failures, outbox lag, DB pool), health
   vs readiness endpoints.
3. **Perf baseline** — deterministic 50k-issue seed (`pnpm seed:perf`), query budgets in CI for
   search, board, backlog, issue GET, CF JQL (014), permission evaluation (015).
4. **Frontend test baseline** — Vitest + Testing Library; tests for the high-risk components
   (`InlineEdit`, `LabelsEditor`, `ActivitySection`, `IssueActionsMenu`, `AssigneePicker`,
   `Markdown` sanitisation); coverage gate on *new* frontend code.
5. **Security gate** — `docs/threat-model.md` (STRIDE per surface) + a DoD checklist item
   every later sprint must complete for new attack surface; dependency audit in CI.

## Why now

Directly after the two foundation sprints and directly before the importer — the first
feature that needs durable, resumable background jobs. Doing it later means retrofitting four
sprints of in-process workers.

## Scope

**In**: items 1–5; docker-compose gains `redis`; `REDIS_URL` optional in dev/test (in-memory
adapter when absent, constitution §stack allowance); graceful shutdown draining jobs; job
dashboard data endpoint `/api/internal/admin/jobs` (UI in 021); outbox lag alert threshold.

**Out**: distributed tracing backend (emit trace ids only), OpenSearch, autoscaling, read
replicas, a full WCAG audit (037), visual regression tests.

---

## User stories

### US1 — Exactly-once scheduling, at-least-once jobs (P1)

As an operator, I want background work to survive restarts and multiple instances.

**Independent test**: run two backend instances against one Redis; a repeatable job (outbox
prune) executes once per interval; kill a worker mid-job → job retried and completed once
(idempotent handler).

**Acceptance scenarios**

1. **Given** `JobRunner.enqueue(name, payload, {idempotencyKey, attempts, backoff})`, **When** a worker crashes mid-job, **Then** the job is retried per policy and handlers are idempotent by key.
2. **Given** `Scheduler.every(name, cron)`, **When** N instances run, **Then** each tick executes on exactly one instance.
3. **Given** the 011 outbox, **When** dispatch moves onto the runner, **Then** 011's chaos test (zero lost events) still passes and ordering per issue holds.
4. **Given** tests/CI without Redis, **When** run, **Then** the in-memory adapter executes jobs synchronously-deterministically.

### US2 — Observability (P1)

1. **Given** any request, **When** logged, **Then** one structured line carries method, route, status, latency, actorId, channel, tokenId, requestId; secrets/tokens never logged (test scans log output for `tfp_`/`Authorization`).
2. **Given** `GET /metrics` (admin/network-restricted), **When** scraped, **Then** latency histograms, queue depth/failed counts, outbox lag and DB pool stats are exposed.
3. **Given** `/healthz` vs `/readyz`, **When** Redis or DB is down, **Then** readiness fails while liveness stays up.

### US3 — Performance budgets (P1)

1. **Given** `pnpm seed:perf` (50k issues, 20 projects, CFs, sprints, comments, links), **When** the perf suite runs in CI (nightly + on-demand), **Then** p95 budgets hold: issue GET < 100 ms, search (JQL incl. CF) < 300 ms, board (500 cards) < 400 ms, backlog (1k) < 500 ms, permission check < 5 ms.
2. **Given** a budget breach, **When** CI runs, **Then** the job fails with the offending query plan attached.

### US4 — Frontend test baseline (P1)

1. **Given** the listed components, **When** tests run, **Then** keyboard flows (Enter/Esc/blur), error states, and Markdown XSS payloads (`<img onerror>`, `javascript:` links) are covered.
2. **Given** a PR adding frontend code, **When** CI runs, **Then** new-code coverage below threshold (60 % lines) fails.

### US5 — Security gate (P1)

1. **Given** `docs/threat-model.md`, **When** reviewed, **Then** it covers current surfaces (auth, PATs, webhooks/SSRF, markdown XSS, idempotency, MCP) with mitigations and owners.
2. **Given** the common DoD, **When** a sprint adds attack surface (uploads, inbound webhooks, OIDC, email, rule execution), **Then** a threat-model entry is required before the sprint is done.
3. **Given** CI, **When** dependencies have known high CVEs, **Then** `pnpm audit --prod` fails the build (allow-list with expiry for accepted risks).

---

## Edge cases

- Redis unavailable at runtime → enqueue fails fast with 503 for job-creating endpoints; synchronous paths unaffected; readiness reflects it.
- Job payloads must not contain secrets (store refs, resolve at run time).
- Poison jobs → dead-letter state visible via `/admin/jobs`, never infinite retry.

## Functional requirements

- **FR-001**: All background work (outbox, retention, future bulk/email/automation/migration) MUST use the `JobRunner`/`Scheduler` ports — no ad-hoc `setInterval`.
- **FR-002**: Repeatable jobs MUST be single-execution across instances.
- **FR-003**: Logs MUST be structured and secret-free (tested).
- **FR-004**: Perf budgets MUST be enforced in CI with a documented fixture.
- **FR-005**: The threat-model checklist MUST become part of the common DoD (roadmap §4).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` · `/readyz` | Liveness / readiness |
| GET | `/metrics` | Prometheus text, restricted |
| GET | `/api/internal/admin/jobs` · `/{id}` · POST `/{id}/retry` | Job inspection (admin) |

## Data model changes

None in Postgres (BullMQ state lives in Redis). Optional `JobRecord` mirror only if 017 needs
SQL-joinable job history — decided in 017's plan.

## MCP tools

Admin toolset: `get_job_status`, `retry_job`. No core-toolset additions.

## Success criteria

- **SC-001**: Two-instance test: repeatable job runs once per tick; crash-retry completes once.
- **SC-002**: 011 chaos test green on the new runner.
- **SC-003**: Perf suite green on the 50k fixture; budgets documented.
- **SC-004**: Frontend tests cover the six listed components incl. XSS cases.
- **SC-005**: Threat model merged; DoD updated.

## Risks

| Risk | Mitigation |
|---|---|
| Redis becomes a hard dependency | Optional in dev/test via in-memory adapter; prod requirement documented |
| Perf CI flakiness | Nightly + on-demand, budgets with headroom, plans attached on failure |
| Hardening sprint scope creep | Fixed five items; anything else goes to the hardening backlog for 020 |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Deployment docs: Redis service, env vars, metrics scraping.
- [ ] Hardening backlog file (`docs/hardening-backlog.md`) created and triaged.

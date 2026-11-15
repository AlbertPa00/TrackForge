# Hardening backlog

Deferred hardening work, triaged per sprint (016 created this file).
Item owner = next sprint that needs it; size = rough effort.

| # | Item | Why deferred | Owner | Size |
|---|---|---|---|---|
| ~~H1-a~~ | ~~BullMQ adapter~~ — **done slice 2** (`jobsBullmq.ts`, live-tested vs compose Redis) | | | |
| ~~H1-b~~ | ~~Periodic jobs onto `DurableRunner`~~ — **done slice 3**: ticks enqueue, handlers run inside the advisory lock; all 5 periodic jobs live-verified via BullMQ + `/admin/jobs` | | | |
| ~~H1-c~~ | ~~pino structured request logs~~ — **done slice 2** (pino middleware, redaction + secret-free test) | | | |
| ~~H1-d~~ | ~~Perf baseline~~ — **done slice 4**: `seed:perf` deterministic 50k fixture + `perf:check` budget gate in CI; caught + fixed a real regression (JQL compile re-queried metadata per request → 10s snapshot cache, search p95 308→244ms) | | | |
| ~~H1-e~~ | ~~Frontend test baseline~~ — **done slice 5**: RTL+user-event tests for all six named components incl. XSS vectors + keyboard flows; 89% lines on the gated set (threshold 60), CI step wired | | | |
| ~~H1-f~~ | ~~`pnpm audit --prod` in CI~~ — **done slice 2** (`scripts/audit-check.mjs` + expiring allow-list, CI step added) | | | |
| — | Distributed tracing backend (trace ids already emitted) | Out of 016 scope per sprint doc | Later | L |
| ~~H2-a~~ | ~~**Agile-service write permissions**~~ — **done in 025**: `SCHEDULE_ISSUES` on sprint create/update/delete/move + backlog/rank (per issue project), `ADMINISTER_PROJECTS` on board config/type, `EDIT_ISSUES`+`SCHEDULE_ISSUES` on epic membership. `agilePerms.test.ts` — narrow-scheme browse-only user gets 403 on all 9 write surfaces; 27 agile regressions green | | | |
| ~~H2-b~~ | ~~**Session users bypass token allow-lists by design**~~ — **done in 025**: documented in `security-model.md` §2 (sessions = full user rights; least-privilege belongs to tokens) | | | |
| — | ~~SC-001 proof~~ — **done slice 3**: concurrent `withAdvisoryLock` admits exactly one contender; BullMQ jobId dedupe is the second layer (verified live) | | | |
| — | Read replicas / autoscaling / OpenSearch | Out of scope | Later | L |
| — | Full WCAG audit | 037 | 037 | L |

## Landed in 016

Slice 1 — `DurableRunner` in-memory port (idempotency-key dedupe, backoff,
dead-letter, retry); `/healthz` vs `/readyz`; `/metrics` Prometheus text
(request count + latency histogram, job queue, outbox gauge);
`/api/internal/admin/jobs` list/get/retry; threat model + this backlog.

Slice 2 — `BullMQDurableRunner` (prod adapter, `REDIS_URL`-gated factory,
live-verified vs compose Redis incl. dead-letter+retry); pino structured
request logs (requestId/traceId/actorId/channel/tokenId, secret-free —
query strings never logged, redaction tested); MCP `get_job_status` +
`retry_job`; `pnpm audit --prod` CI step with expiring allow-list;
`docs/deployment.md` (env vars, Prometheus scrape config, multi-instance
notes); Redis documented in `.env.example` and enabled for dev.

Slice 3 — all 5 periodic jobs (outbox dispatch/deliver, retention prune,
proposal expiry, embed refresh) now run as durable jobs: ticks enqueue,
handlers execute inside the advisory lock; `runOnce` flushes the durable
queue so tests stay synchronous; dedupe keys release at terminal state so
periodic re-enqueue works on both adapters.

Slice 4 — `seed:perf` (deterministic 50k issues / 20 projects / comments /
links / CF values / PERF01 sprints) + `perf:check` budget gate wired into CI
(issue GET p95<100, search+CF p95<300, board p95<400, backlog p95<500,
permission eval p95<5ms). First budget breach found: `compileJql`'s
`buildCtx` re-queried 5 metadata tables per request (~116ms) — now a 10s
TTL snapshot (`jql/ctxCache.ts`) invalidated by project/CF mutations and
the test harness.

Slice 5 — frontend test baseline: `@testing-library/react`+`user-event`+`jest-dom`;
13 tests over InlineEdit (Enter/Escape/blur/error), LabelsEditor (commit/cancel),
ActivitySection (merged comments+history, tab filter), IssueActionsMenu (delete
preview flow), AssigneePicker (search + assign-to-me), Markdown sanitisation
(`<img onerror>`, `javascript:` URLs, `<script>`). Coverage gate: `lines: 60`
on the six named components — currently 89%.

**Sprint 016 complete.** Open items remain for later sprints (020 H2):
nightly perf lane vs 50k+ beyond CI, distributed-tracing backend, WCAG audit (037).

## Sprint 035 findings

| # | Item | Severity | Status |
|---|---|---|---|
| H5-a | **SSE leaked secured-issue events** — `sseBroadcast`/`events/stream` backfill filtered only by project; secured issue keys/changelog/comment bodies broadcast to every project subscriber. Fixed: per-client `eventIssueVisible` check (actor stored at subscribe; backfill uses same predicate) + leak-matrix coverage | P0 | **fixed** |
| H5-b | **Automation routes hung on errors** — Express 4 drops async throws; every non-2xx (403/404/validation) on `/api/internal/automation/*` hung instead of erroring. Fixed: `ah()` wrapper on all 12 async handlers; caught by the new 403 test | P1 | **fixed** |
| H5-c | MCP tool surface is flat — 118 tools registered into one namespace; D21's ≤30/toolset needs namespacing/grouping decision before GA | P2 | open → 046 H6 |
| H5-d | Webhook deliveries carry secured-issue payloads — by design (webhooks are `requireAdmin`; Jira parity) — documented in `security-model.md` | P2 | by design |

## Sprint 059 (H7) findings — gate over the 053–058 wave

| # | Item | Severity | Status |
|---|---|---|---|
| H7-a | /agent-activity project lookup not key-normalized (lowercase 404'd; /summary normalized) | P2 | **fixed** |
| H7-b | ProjectSummaryPage wrong PageHeader prop | P2 | **fixed** |
| H7-c | UB-020 drawer/palette Playwright gap | P2 | **fixed** (sprint058.spec.js 4/4) |
| H7-d | Sidebar List item pointed at index now owned by Summary | P2 | **fixed** |
| — | H5-c MCP toolset namespacing | P2 | still open → GA gate |

# Sprint 072 — Proof-Carrying Work, Resource Locks & Zero-Silent-Failure Fleet Plane

| | |
|---|---|
| **Status** | Implemented (live smoke: 17/17 on the 5-agent fleet) |
| **Milestone** | Post-GA — Multi-Agent Fleet Wave (Production Hardening & Epistemics) |
| **Theme** | Replace prose-based agent trust, polling contention, and fragile Redis-dependent dispatch with cryptographic Work Receipts, enforceable path locks + wake queues, Git-reconciled handoffs, canonical issue ledgers, and a self-healing Postgres-first event plane |
| **Depends on** | 011 (`DomainEvent` outbox), 016 (`DurablePort` / `jobsBullmq.ts`), 038/051 (`DevelopmentItem` git/CI webhooks), 070 (PAT/SSE scale), 071 (Town Hall, fenced leases, durable inbox, traces, context packs) |
| **Unblocks** | Production unattended operation at 250–1,000+ heterogeneous agents with auditable evidence gates, zero silent outbox stalls, zero polling storms, and human-grade issue-timeline visibility |
| **Spec-kit folder** | not generated — implemented directly from this doc |

> **Origin**: Live 5-agent adversarial scenario run immediately after Sprint 071 landed.
> Five real failure modes surfaced under concurrent agent execution:
> (1) **Silent outbox death** — `BullMQDurableRunner` bound to an unreachable `REDIS_URL` with no readiness probe or fallback, leaving 100% of `DomainEvent` rows undispatched while HTTP `200/201` writes appeared healthy;
> (2) **Unverified prose consensus** — 4 agents reached formal quorum and compiled an Epic/DAG citing a fabricated benchmark because `evidence` speech acts, handoffs, and transitions accepted arbitrary prose with zero artifact binding;
> (3) **Polling deadlocks on contention** — contenders waiting on a leased issue or shared file had to busy-poll session state because lease release/expiry/break emitted no targeted wake-ups;
> (4) **Invisible handoffs & contract drift** — structured handoffs vanished from default issue timelines, and subtle REST shape inconsistencies (`lease.fenceToken` vs `fenceToken`, numeric inbox `id` vs string `ack`) forced per-agent workarounds;
> (5) **No per-agent backpressure or fleet telemetry** — one looping agent shared a single global rate-limit bucket with the whole fleet.

## What shipped

- **FailoverRunner** (`lib/jobs.ts`): 5s Redis probe; enqueue/probe failures degrade to the in-process durable runner within ~1s while handlers keep serializing on the Postgres advisory lock. `runnerStatus()` feeds `/fleet/health`.
- **Outbox DLQ** (`DomainEvent.attempts/nextAttemptAt/lastError/deadLetteredAt`): per-sink failure tracking — only failed sinks retry; events quarantine after 5 attempts with exponential backoff.
- **WorkReceipt**: `POST /work-receipts` (kind `diff|test_run|benchmark|build|command`, sha256-bound); SCM corroboration auto-upgrades `verification` to `scm_corroborated` when `gitCommitSha` matches an ingested `DevelopmentItem`.
- **Proof gates**: `TransitionRule` validators `verifiedReceiptRequired` + `traceDiffClean`; `TownHallTopic.requireEvidenceReceipt` blocks resolution until ≥1 evidence post carries a hash_verified+ receipt.
- **Git-grounded leases**: `baseSha/branchName` at claim, `headSha/receiptIds` at release; `computeDrift` reconciles declared traces vs observed commits/diff receipts → `clean|undeclared_edits|phantom_handoff|untracked`, written to the session + ledger.
- **ResourceLock**: `POST/DELETE /agent-sessions/:id/locks` — exclusive/shared TTL-fenced path and `dir/**` locks (hashed ids, glob guards, max 20/session), auto-released with the session.
- **ContentionWaiter**: `enqueueOnConflict:true` on lease/lock 409s joins a FIFO queue; release/break/sweep emits `lease_available`/`lock_available`/`handoff_ready` inbox + SSE wake-ups. (Regression fixed live: the waiter must persist **after** the aborted 409 transaction.)
- **IssueLedgerEntry**: append-only canonical issue timeline (lease_claimed, lease_handed_off/completed/failed, lease_broken, receipt_verified, drift_flagged, topic_compiled, peer_question_answered) via `GET /issues/:key/ledger`.
- **RepoAdvisory**: path-scoped `doNotRepeat` memory (`GET/POST/DELETE /projects/:key/advisories`), auto-injected into `getContextPack` as untrusted peer content.
- **Per-agent circuit breaker** (`agentCircuitBreaker`): sliding write + client-error budgets → 429 + jittered `Retry-After`; 3 consecutive trips demote the agent to `approvalPolicy='always'` + owner alert via `agent.circuit_tripped`. `POST /fleet/agents/:userId/circuit/reset`.
- **SSE inbox index**: pure `inboxOnly` subscribers route via `byUserId` index — fleet wake-ups no longer scan every idle socket.
- **Contract normalization**: lease envelopes `{sessionId, issueKey, lease:{fenceToken,expiresAt,role}}` on claim paths, `(string|number)[]` inbox ack, `status`+structured `asker` on `/agent-questions/mine`, terminal sessions visible by default (`?activeOnly=1` restores the 071 filter), `author`/`resolvedBy` on topic views.
- **Pending-merge traces**: `handed_off` releases with a worktree keep `StigmergicTrace` rows as `pendingMerge` (6h TTL) so unmerged worktree edits still collide for parallel drivers.
- **Telemetry**: `GET /fleet/health` (degraded on fallback/DLQ/stale outbox) + `GET /fleet/metrics` (sessions, waitlist depth, active locks, pause).
- **MCP parity**: `lease_work` extended (`base_sha`, `branch_name`, `enqueue_on_conflict`, `head_sha`, `receipt_ids`, `lock_paths`, `unlock_paths`) + new `work_receipts`, `repo_advisories`, `fleet_status`.

## Verified live (5-agent smoke, `tf-072-smoke.mjs`)

17/17 checks: health/metrics, normalized lease envelope, fenced lock acquire, lease+lock 409s with waitlist positions, locks table, advisory publish, receipt submit/list, release → `phantom_handoff` drift + ledger flag, `lease_available`+`lock_available` wake-ups in <1s, post-wake claim with fence 6, ledger entries, terminal session visibility, context-pack advisory injection, drift on session board.

## Follow-ups (next sprint)

- Chaos suite: kill Redis mid-load → `postgres_fallback` in ≤3s (SC-001), rogue-agent breaker trip (SC-006), `SKIP LOCKED` sharded drain under replica load.
- JQL predicates (`hasReceipt()`, `leaseDrift`) + frontend ledger/receipt/drift rendering (client wrappers landed; UI strip pending).
- `signed_ci` verification tier via dedicated `attest` PAT scope.
- Postgres `LISTEN/NOTIFY` cluster bus for multi-replica pause/token/SSE invalidation without Redis.
- Playwright e2e on Town Hall + Mission Control fleet-health strip.

# Capacity & scaling

DESIGN targets ~500k issues on a single node; 016 perf budgets are checked in
CI on a 50k fixture (`pnpm --filter backend perf:check`).

## Reference sizing

| Issues | App | Postgres | Redis | Attachments |
|---|---|---|---|---|
| < 50k | 1 CPU / 512MB | 1 CPU / 1GB | 64MB | filesystem ok |
| ~500k | 2 CPU / 1GB | 2 CPU / 4GB, tuned | 256MB | s3 recommended |

## Postgres tuning (the real lever)

In compose, override `command` on the postgres service:

```yaml
command: >
  postgres -c shared_buffers=1GB -c work_mem=16MB
  -c effective_cache_size=3GB -c random_page_cost=1.1
  -c max_connections=100
```

## Bottlenecks (measured order)

0. **Accept backlog** — `app.listen` uses Node's default backlog (511). A
   connection stampede (≥1k simultaneous opens) sees `ECONNREFUSED` before the
   app accepts — measured by `perf:check:concurrency` at 1000 users (~80%
   refused, 0 5xx, server stays healthy). Mitigate with a load balancer /
   TLS terminator in front, and/or pass an explicit `backlog` to `listen`.
1. **JQL text search** — `summary ~ "x"` is `ILIKE`; fine to ~500k with pg
   tuning, beyond that you want a search index (documented divergence D-011 —
   no OpenSearch in v1).
2. **DB pool** — Prisma default pool is small; under load raise
   `connection_limit` in `DATABASE_URL` (`?connection_limit=20`).
3. **Outbox fan-out** — SSE/webhook delivery is durable-job-bound; Redis
   (`REDIS_URL`) switches the runner to BullMQ and is required for multi-replica.
   070 also rides `REDIS_URL` for the cross-replica SSE pub/sub bridge.
4. **Attachment storage** — `fs` is fine until backup/restore time matters;
   `s3` offloads disk + bandwidth.

### 070 — agent-fleet scale floor

Changes aimed at ~1k concurrent agents behind one instance:

- **PAT auth cache** — `lookupApiToken` serves `{token,user}` in-process
  (`TOKEN_CACHE_TTL_MS`, default 30s); `lastUsedAt` writes are debounced to
  `TOKEN_TOUCH_INTERVAL_MS` (default 5 min). Revocation paths evict
  immediately; direct-SQL revocation degrades to the TTL.
- **Pre-auth IP ceilings raised** — `PRE_AUTH_RATE_LIMIT` default 5000/min,
  `MCP_RATE_LIMIT` default 6000/min (a whole fleet usually shares one egress
  IP). Per-principal `RATE_LIMIT` still applies post-auth.
- **AgentSession activities** — append-only `AgentActivity` rows replaced the
  JSONB rewrite; emit is one transaction (activity + session bump + outbox).
- **Claim path** — `claim` filters "no unresolved blocker" via an indexed
  `NOT EXISTS` anti-join (`IssueLink_inwardId_idx`) inside the `SKIP LOCKED`
  re-check; the full `IssueLink` pre-scan is gone from the hot path.
- **Issue create** — `issueCounter` heal runs only on a P2002 collision
  (import/seed artifact), not on every create.
- **SSE delivery** — one issue row fetched per event (not per client), and
  outbox ack is a batched `updateMany`.
- **MCP mount** — stateless `{server,transport}` pairs pool per toolset
  variant (`MCP_SERVER_POOL`, default 32); the per-request client binds via
  AsyncLocalStorage instead of rebuilding ~140 registrations per POST.
- **Embeddings** — still `Float[]` + in-process cosine (schema documents the
  pgvector upgrade path: `pgvector/pgvector:pg16` image + `vector` column +
  HNSW — flagged for a later sprint since it changes the Docker image).

## When to split services

- Move Postgres off-box when its CPU > 60% sustained or you want managed backups.
- Redis off-box only matters for multi-replica app (BullMQ work queue).
- The app itself is stateless except jobs — multi-replica works today via the
  advisory lock + BullMQ (single-execution guaranteed), but v1 targets single node.

## Concurrency soak

`pnpm --filter backend perf:check:concurrency` ramps `CONCURRENCY` (default
10k) virtual users over `RAMP_SEC`, holds `DURATION_SEC`, then fails if the
error rate (5xx + timeouts + transport errors) exceeds `MAX_ERROR_RATE`
(default 0.5%) or `/healthz`/`/readyz` aren't green afterwards. Read-heavy
endpoint mix; `WRITE_PCT` adds comment writes, `SSE_HOLD` holds that many
`/events/stream` sockets for the run. On-demand in CI via
`.github/workflows/concurrency.yml`.

- Run against the perf fixture (`pnpm seed:perf`) for the full 50k keyspace.
- PATs are minted in a pool (`TOKEN_POOL`, default `ceil(C/100)`) so the
  per-principal rate limit doesn't 429 the run; 429s are reported, not failed.
  Passing `TRACKFORGE_TOKEN` means a single bucket — expect 429s at scale.
- The client box is part of the test: 10k sockets needs fd headroom
  (`ulimit -n`) and ephemeral ports. Windows default dynamic range (~16k
  ports) just fits; widen with
  `netsh int ipv4 set dynamic tcp start=32768 num=32768` if you see transport
  errors client-side.

# Deployment

TrackForge is a single Node process + PostgreSQL, with Redis optional-but-
recommended for multi-instance or heavy background work.

## Services

| Service | Required | Compose service | Notes |
|---|---|---|---|
| Backend (`apps/backend`) | yes | — | Express on `PORT` (3000) |
| PostgreSQL 16 | yes | `postgres` (5433→5432) | `DATABASE_URL` |
| Redis 7 | multi-instance / prod | `redis` (6379) | `REDIS_URL` — BullMQ durable jobs |

## Configuration (`apps/backend/.env`)

| Var | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://…:5433/trackforge` | Prisma |
| `REDIS_URL` | _(unset)_ | **Durable-job adapter.** Unset → deterministic in-memory runner (single instance, dev/test). Set → BullMQ on Redis: jobs survive restarts, distribute across instances, retry with backoff, dead-letter for `/api/internal/admin/jobs` + MCP `get_job_status`/`retry_job`. |
| `LOG_LEVEL` | `info` | pino level for structured request logs |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Used in webhook/event payloads |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated |
| `SESSION_SECRET`/`JWT_SECRET` | dev values | **Set in production** |
| `RATE_LIMIT` | `1000` | Requests / sliding window / principal |
| `ATTACHMENT_DIR` | `./attachments` | Local-attachment storage root (Sprint 018) |
| `ATTACHMENT_MAX_BYTES` | `26214400` (25MB) | Per-file upload limit; served via `GET /rest/api/2/attachment/meta` |
| `ATTACHMENT_STORAGE` | `fs` | `fs` = filesystem under `ATTACHMENT_DIR`; `memory` = ephemeral (tests) |

## Attachment storage

Bytes live behind the storage port — `ATTACHMENT_DIR` on disk by default, keyed
`{projectId}/{issueId}/{attachmentId}` (thumbnails as `…​.thumb.png`). The
directory is **state that must be backed up with the database** — mount it as a
named volume when the backend runs in Docker:

```yaml
services:
  backend:
    volumes:
      - attachments_data:/app/attachments
    environment:
      ATTACHMENT_DIR: /app/attachments

volumes:
  attachments_data:
```

For multi-instance deployments, put the volume on shared storage (NFS/EFS) or
the orphan-sweep + content reads will be node-local. An object-storage adapter
(S3/MinIO) plugs into `src/ports/attachmentStore.ts` behind `ATTACHMENT_STORAGE`
in a later sprint.

## Ops endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness — process up. Load-balancer probe. |
| `GET /readyz` | none | Readiness — `{db, jobs}` checks, 503 on any fail. Route traffic only when ready. |
| `GET /metrics` | none* | Prometheus text: `tf_requests_total`, `tf_request_latency_ms` histogram, `tf_job_queue{state}`, `tf_outbox_undispatched`. **Restrict at the network layer** (internal ingress/Prometheus only) — unauthenticated by design. |
| `/api/internal/admin/jobs[/{id}[/retry]]` | admin token | Job inspection + dead-letter retry |

Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: trackforge
    metrics_path: /metrics
    static_configs: [{ targets: ['backend:3000'] }]
```

## Structured logs

One JSON line per request (pino): `requestId` (echoed as `x-request-id`),
`traceId` (from `x-trace-id`/`traceparent` or generated — emit-only, no
collector), `method`, `path` (query strings never logged — SSE's
`?access_token=` cannot leak), `status`, `ms`, `actorId`, `channel`
(ui|api|mcp|copilot), `tokenId`. Bearer/cookie/password/secret fields are
redacted by config and covered by a unit test.

## Multi-instance

With `REDIS_URL` set you can run N backend replicas: BullMQ distributes job
execution; periodic jobs are additionally guarded by a Postgres advisory
lock (exactly-once per tick cluster-wide). Without Redis, run a single
instance — the in-memory runner is single-process only.

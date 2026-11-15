# HA readiness — honest topologies

DESIGN targets one server. What survives >1 replica, tested or pinned:

## Supported: 1 app replica

The shipped topology. Stateful parts (SSE fan-out, cache) are in-process —
fine at N=1. BullMQ + advisory lock (016) already guarantee exactly-once jobs.

## Works with caveats: N app replicas

| Concern | Status |
|---|---|
| Sessions | Stateless JWT — no sticky sessions needed |
| Jobs/cron | BullMQ on shared Redis + advisory lock — exactly-once at N (016, tested via two-contender lock test) |
| SSE (`/events`) | **Redis pub/sub bridge (070)** — with `REDIS_URL` set, every replica publishes domain events + per-user frames to `tf:sse` and delivers them to its local clients, so fans see all events regardless of landing replica. Without `REDIS_URL` the fan-out stays in-process (single-replica default). |
| OIDC login state | **In-process Map** (`oidcStates`) — the SSO authorize→callback pair must land on the same replica or the callback 400s ("Invalid or expired SSO state"). Pin /auth/oidc traffic with sticky sessions, or retry the login. (065 audit G4) |
| Confirm tokens | Postgres (`ConfirmToken`) — replica-safe |
| Attachments | `s3` backend required (fs is node-local) |
| Rate limits | Per-replica counters — effective limit ≈ `RATE_LIMIT × N` |

Required shared infra for N>1: Postgres, Redis, S3-compatible store — all
already external services in prod compose.

## Not supported

- Multi-region/active-active (single writeable Postgres).
- Zero-downtime schema changes beyond expand-contract (docs/migrations.md).
- Replica counts > 2 are untested — "works at 1, documented at N", no claims beyond.

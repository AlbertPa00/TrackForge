# Installing TrackForge

Two paths: **production compose** (everything in containers) and **dev source**
(hot reload, local toolchain). Both end at `http://localhost:3000`.

## Production (docker compose)

Requirements: Docker + Docker Compose. No other deps — the app image builds
from source.

```bash
cp .env.example .env
# edit .env — required:
#   POSTGRES_PASSWORD, SESSION_SECRET (32+ chars), TF_ADMIN_EMAIL, TF_ADMIN_PASSWORD
docker compose -f docker-compose.prod.yml up -d
```

What comes up:

| Service | Role | Exposure |
|---|---|---|
| `app` | backend + built frontend (single origin) | host port `${HTTP_PORT:-3000}` |
| `postgres` | database | private (no host port) |
| `redis` | sessions/events | private |
| `s3` (RustFS) | attachment storage, opt-in via `ATTACHMENT_STORAGE=s3` | private |
| `migrate` | runs `prisma migrate deploy` on boot, then exits | — |

First-run behavior: when zero users exist, the `TF_ADMIN_*` values create the
admin account. Migrations are idempotent; re-running `up -d` after a new
checkout is the upgrade path.

Verify:

```bash
curl http://localhost:3000/rest/api/2/serverInfo
curl http://localhost:3000/api/internal/ready   # liveness
```

Environment reference: `.env.example` (annotated) and `docs/env-reference.md`
(generated). Attachments default to a volume-mounted filesystem dir; set
`ATTACHMENT_STORAGE=s3` + `S3_SECRET_KEY` to use the bundled RustFS service.

> Note on images: `docker-compose.prod.yml` references
> `ghcr.io/albertpa00/trackforge:${TF_TAG:-latest}` but includes a `build:`
> block, so it builds locally until prebuilt images are published. Set
> `TF_TAG` once a published tag exists to skip the build.

## Development (source)

Requirements: Node 20+, pnpm, Docker (for Postgres only).

```bash
docker compose up -d          # postgres :5433, redis :6379, mailpit :1025/:8025
pnpm install
pnpm db:seed                  # metadata, workflows, demo users
pnpm dev                      # turbo: backend :3000 + frontend :5173
```

`DATABASE_URL` for local tooling defaults to the dev compose instance —
`postgres://trackforge:trackforge@localhost:5433/trackforge`. Tests use
`TEST_DATABASE_URL` (falls back to `DATABASE_URL`); vitest wipes the DB per
test.

## Verify the agent surface

```bash
# mint an agent token (admin bearer required)
curl -X POST http://localhost:3000/api/internal/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"smoke","scopes":["read","write"]}'

# deterministic contract eval (no LLM, exits non-zero on failure)
TRACKFORGE_URL=http://localhost:3000 TRACKFORGE_TOKEN=tfp_xxx \
  pnpm --filter trackforge-mcp eval
```

## Troubleshooting

| Symptom | Check |
|---|---|
| `POSTGRES_PASSWORD unset` error | `.env` not created / not beside compose file |
| App restarts in a loop | `docker compose -f docker-compose.prod.yml logs migrate` — migration failure |
| 401 on every call | PAT missing `Bearer ` prefix, or token scopes/allow-list exclude the project |
| Attachments fail | `ATTACHMENT_STORAGE=s3` set without `S3_SECRET_KEY`/reachable `S3_ENDPOINT` |

# TrackForge admin guide

Self-hosting TrackForge: install, operate, back up, migrate.

## Install

Requirements: Node ≥ 20, pnpm, PostgreSQL ≥ 15, Redis ≥ 7 (optional but recommended for durable jobs).

```bash
pnpm install
cp apps/backend/.env.example apps/backend/.env   # set DATABASE_URL, secrets
pnpm --filter backend db:migrate                  # prisma migrate deploy
pnpm --filter backend db:seed                     # admin@trackforge.local / trackforge + metadata
pnpm dev                                          # backend :3000, frontend :5173
```

Production: `pnpm --filter backend build && node apps/backend/dist/main.js` behind your reverse proxy; serve `apps/frontend/dist` statically. Set `PUBLIC_BASE_URL` to the external origin so `self`/content URLs resolve.

## Configuration

All env vars are documented in [deployment.md](deployment.md). The operationally important ones:

| Var | Why |
|---|---|
| `DATABASE_URL` | Postgres connection — the single source of truth |
| `REDIS_URL` | Durable job queue (BullMQ). Unset → in-memory runner (single instance only) |
| `PUBLIC_BASE_URL` | External origin used in `self`/attachment links |
| `ATTACHMENT_STORAGE` / `ATTACHMENT_DIR` / `ATTACHMENT_MAX_BYTES` | Attachment storage backend, root, per-file limit (default fs / `./attachments` / 25MB) |
| `RATE_LIMIT` | Per-principal requests/minute (default 1000) |
| `SESSION_SECRET` / `INTERNAL_ACTOR_SECRET` | Rotate on any suspected leak |

## Redis & durable jobs

Periodic jobs (outbox dispatch/delivery, retention prune, proposal expiry, attachment sweep) run inside an advisory lock so multi-instance deploys are safe. With `REDIS_URL` set, jobs persist across restarts (BullMQ); without it the in-memory runner is for single-node only. Inspect/retry via `GET /api/internal/admin/jobs` (admin) or MCP `get_job_status`/`retry_job`.

## Backups

Two state stores, back up both:

1. **Postgres** — `pg_dump -Fc "$DATABASE_URL" > trackforge-$(date +%F).dump`. Restore with `pg_restore -d "$DATABASE_URL" --clean`.
2. **Attachment bytes** — `ATTACHMENT_DIR` (default `./attachments`) when `ATTACHMENT_STORAGE=fs`. Filesystem snapshot/copy. DB rows reference `{projectId}/{issueId}/{attachmentId}` keys — keep the dumps in the same backup window.

`GET /healthz` (liveness) and `/readyz` (Postgres ping) for your uptime checks; `/metrics` for Prometheus.

## Migrating from Jira Cloud

UI path: **Admin → Migration** — paste the Jira site URL + email + API token, dry-run first, then apply. The importer covers users, groups, project metadata, workflows, custom fields + contexts/options, components/versions, issues, comments, attachments (streams bytes via job credentials), links, watchers, boards, sprints, filters. API path: `POST /api/internal/migration` + job polling; MCP `run_import`/`resume_import`. Per-item failures land in the job report, not fatal — re-run to retry (idempotent by external id).

## GitLab integration

Connect GitLab (gitlab.com or self-managed) so branches, merge requests, pipelines and deployments show on the issue's development panel — and so users/agents can create branches and MRs straight from an issue.

**Create a connection** (admin): `POST /api/internal/dev/gitlab/connections` with `{name, baseUrl, apiTokenRef, groupPath?|projectIds?, mode?, signingToken?, verifySsl?}`.

- `apiTokenRef` must be an `env:VAR` reference — the token lives in the environment, never in the DB or responses. GitLab side: a PAT (or project access token) with `api` scope.
- `mode`: `webhook` (GitLab pushes events), `poll` (TrackForge pulls on a 2-minute sweep — for firewalled GitLab that can't reach TrackForge), or `both`.
- `verifySsl: false` opts in to skipping TLS verification — self-signed labs only.

**Preflight**: `POST …/connections/{id}/test` checks the token (`GET /api/v4/user`) and group reachability before you save anything.

**Webhook mode**: TrackForge shows `webhookUrl` (`/api/internal/dev/{id}/gitlab`) on the connection. In GitLab → group/project → Settings → Webhooks: paste the URL, set the **secret token** to the connection's `webhookSecret` (returned once at creation — or the `signingToken` you supplied), and enable *Merge request*, *Push*, *Pipeline*, *Deployment* and *Feature flag* events. Out-of-order or replayed deliveries are safe: items dedupe by external id and `updateSequenceId` is monotonic per connection.

**Poll mode**: nothing to configure on GitLab — the `gitlab.poll` job sweeps enabled `poll`/`both` connections every 2 minutes, advancing a per-project `syncCursor`. `POST …/connections/{id}/sync` runs a sweep now; `POST …/connections/{id}/backfill` enqueues a full history walk (resumable, deduped per connection); `GET …/connections/{id}/status` shows cursors + last error.

**GitLab's native Jira integration** also works: point GitLab → Settings → Integrations → *Jira issues* at your TrackForge URL with `user:PAT` basic auth — GitLab's "test settings" calls `GET /rest/api/2/serverInfo` and issue/comment calls land on the standard v2 surface. Its *Jira development panel* (devinfo) pushes to `POST /rest/devinfo/0.10/bulk` (Bearer PAT) and stale entities are removed via the matching `DELETE`.

**Outbound actions**: `POST /api/internal/issues/{key}/gitlab/branch` and `…/gitlab/merge-request` (dryRun supported) — every call is audit-logged. MCP equivalents: `gitlab_create_branch`, `gitlab_create_mr`, `gitlab_connection_status`.

## Users, tokens & permissions

- Users: `GET/POST /api/internal/users` (admin). Deactivation is immediate for sessions + tokens.
- API tokens: users mint their own under `/api/internal/tokens`; scopes `read|write|admin`; `projectKeys` allow-list scopes a token to projects — out-of-scope resources return 404.
- Permissions: project roles via `GET/POST /rest/api/2/project/{key}/role`; schemes map permission → role. `ADMINISTER_PROJECTS`/`DELETE_ALL_*` live on the admin tier; everything else defaults to the `application` role (any logged-in user).
- Audit: every mutation writes an audit row (`GET /api/internal/audit`, admin) + an `Event` row for the stream.

## Troubleshooting

- **Import stuck**: check `/api/internal/admin/jobs` → retry; the runner dead-letters after its backoff schedule.
- **413 on upload**: `ATTACHMENT_MAX_BYTES`; the same limit is advertised at `GET /rest/api/2/attachment/meta`.
- **Attachment orphans**: the periodic sweep deletes storage keys with no DB row; issue deletes queue a post-commit purge.
- **Logs**: pino JSON per request (`requestId`, `traceId`, `actorId`, `channel`) — query strings and secrets are never logged.

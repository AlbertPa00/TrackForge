# Runbook

Ordered paths for the incidents the alert rules and support calls name.

## Startup order

postgres (healthy) → migrate (exits 0) → app (healthy) → redis, s3.
`docker compose -f docker-compose.prod.yml ps` should show one `Exited (0)`
(migrate) and the rest `Up`.

## Site down

1. `docker compose ... ps` — is `app` restarting? → `logs app --tail 100`.
2. Crash-loop on config: `validateEnv` prints the missing/invalid vars table → fix `.env`.
3. `/healthz` down but process up → check port mapping (`HTTP_PORT`).
4. 5xx storm (TrackForgeHighErrorRate) → check `checks.db` on `/readyz`; db fail → postgres container/volume.
5. Prisma engine errors after an image change → rebuild without cache (engine/OS mismatch).

## Emails not sending

1. `/admin/system` → queue failed count; `mail.send`/`mail.digest` jobs on the admin jobs list.
2. `POST /api/internal/admin/mail/test` (029) — verifies SMTP envs (`SMTP_HOST/PORT/USER/PASS/TLS/FROM`).
3. Outbox lag alert → is `outbox.deliver` running? Durable runner needs `REDIS_URL` reachable in prod.
4. Check `docker compose logs app | grep mail` for SMTP auth/connect errors.

## Webhooks not firing

1. `/admin/system` → queue waiting/failed; retry failed jobs via `POST /api/internal/admin/jobs/{id}/retry`.
2. `outbox.deliver` failing on SSRF guard → target is RFC1918/loopback and `WEBHOOK_ALLOW_PRIVATE=false` (set true only for trusted internal targets).
3. Per-webhook deliveries: `GET /api/internal/webhooks/{id}/deliveries` shows response codes.

## Disk full

1. `docker system df` — prune images/logs first (`docker system prune`).
2. `postgres_data` growth → `pg_stat_activity`/vacuum; `backups` volume → lower `BACKUP_KEEP`.
3. `attachment_data`/`s3_data` — attachment growth is unbounded; move to S3 or larger volume.

## Slow JQL / requests

1. `TrackForgeSlowRequests` → Prometheus p95 panel — is it search or writes?
2. Large issue counts need `DATABASE_URL` pool headroom; see docs/scaling.md for pg tuning.
3. JQL text search is SQL `ILIKE` — a `summary ~ "x"` scan over ~500k issues is the known ceiling.

## Backups

1. `/admin/system` → last backup failed? `POST /admin/system/backup` manually and read the error.
2. `pg_dump` missing → image without `postgresql16-client` (rebuild).
3. `BACKUP_DIR` unwritable → volume mount/permissions (`/backups` must be writable by the `trackforge` user).
4. Restore: `docs/backup-restore.md` — verify checksums first, always.

## Restore from backup

See `docs/backup-restore.md` — `backup verify <id>` → `restore <id>` (pg_restore --clean).

## Reset admin password

```bash
docker compose -f docker-compose.prod.yml exec app \
  node -e "import('./dist/services/userService.js').then(async m => { /* see reset script */ })"
```
Or revoke the admin's sessions and use password-reset email if SMTP works.

## Rotate SESSION_SECRET

Rotating invalidates every session JWT + API-session cookie (users re-login;
`tfp_*` PATs are unaffected). Set the new value in `.env`, `up -d`, expect a
login spike. No data loss.

## Rotate PAT

`/profile` → tokens → revoke old, create new. Rotation has no server-side
blast radius.

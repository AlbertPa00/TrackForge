# Backup & restore

An untested backup is not a backup — verify checksums and run a restore drill
before you need it.

## What a backup contains

Each run creates a timestamped set under `BACKUP_DIR` (`/backups` in the prod
image, `./backups` in dev):

```
20260608-030000/
  db.dump            pg_dump --format=custom (compressed)
  attachments/       mirror of the fs attachment tree (s3: see below)
  manifest.json      version, scm, sha256, entity counts, file list
  checksums.sha256   sha256 of every checksummed file
```

The last run's status is recorded in `SystemSetting['backup:last']` and
surfaced on `GET /api/internal/admin/system/status` (`backup` + `backups`).

## Scheduled backups

A durable job (`backup.run`, 016 runner + advisory lock → single execution
across instances) runs every `BACKUP_INTERVAL_MS` (default 24 h) and prunes
retention to `BACKUP_KEEP` sets (default 14).

- **On** in production by default; dev opts in with `BACKUP_ENABLED=true`.
- Volume: prod compose mounts `backups:/backups` — back the host directory or
  the named volume up off-box; a backup on the same disk is not a backup.

## Operator commands

```bash
pnpm --filter backend backup            # dev — run a backup now
pnpm --filter backend backup list       # list sets + counts
pnpm --filter backend backup verify <id>  # sha256 check

docker compose -f docker-compose.prod.yml exec app node dist/bin/backup.js now
docker compose -f docker-compose.prod.yml exec app node dist/bin/backup.js verify <id>
```

Or via the API: `POST /api/internal/admin/system/backup`,
`POST /api/internal/admin/system/backups/{id}/verify` (admin).

## Restore

```bash
# 1. Verify the set first
pnpm --filter backend backup verify 20260608-030000

# 2. Restore — pg_restore --clean --if-exists + attachment tree copy (fs store)
pnpm --filter backend restore 20260608-030000

# containerized
docker compose -f docker-compose.prod.yml exec app \
  node dist/bin/restore.js 20260608-030000
```

`pg_restore --clean` drops existing objects — **the live database is replaced
by the backup**. Restore into a scratch database first if you only need part
of the data. Across versions: restore into a database on the *old* schema
isn't supported — restore the data, then run `migrate` (forward-only), or
restore on the version that wrote the backup.

### Restore from the admin console (Sprint 061)

System → Backups → **Restore** on a row previews the manifest (dryRun +
HMAC `confirmToken`), requires typing `RESTORE`, re-verifies every checksum
(`409` if any file was tampered with after the preview), audits the action,
then runs `pg_restore` detached. Progress lives in
`$BACKUP_DIR/.restore-status.json` — polled via
`GET /api/internal/admin/system/restore-status` — deliberately outside the
database, since the restore drops the tables a job runner would report
through.

The UI path restores the **database only** — attachment files are not
restored (copy them per the steps above). `pg_restore` must be on PATH where
the app runs, exactly like the CLI. Set `TF_DISABLE_UI_RESTORE=1` to remove
the restore endpoints entirely on hardened installs (the route returns 404).

## S3 / object storage

When `ATTACHMENT_STORAGE=s3`, the job mirrors every object key into the
backup's `attachments/` tree. For large stores prefer a native mirror:

```bash
docker run --rm --network trackforge_default \
  -e MC_HOST_tf=http://$S3_ACCESS_KEY:$S3_SECRET_KEY@s3:9000 \
  minio/mc mirror tf/trackforge-attachments ./backups/attachments
```

## Drill (quarterly)

1. `backup now` → `backup verify <id>`
2. Restore into a scratch instance (separate compose project + volumes)
3. Spot-check counts from `manifest.json` against the restored DB

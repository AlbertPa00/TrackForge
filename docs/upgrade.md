# Upgrading TrackForge

Migrations are **forward-only** (`prisma migrate deploy`). There is no
in-place downgrade path — roll back by restoring a backup.

## Upgrade

```bash
# 1. Back up first — required for rollback
docker compose -f docker-compose.prod.yml exec postgres \
  pg_dump -U trackforge trackforge > backup-$(date +%F).sql

# 2. Pin the new version in .env (or pull latest)
TF_TAG=1.2.3 docker compose -f docker-compose.prod.yml pull
TF_TAG=1.2.3 docker compose -f docker-compose.prod.yml up -d
```

The `migrate` service runs the new migrations before `app` starts, so the app
never boots against an un-migrated schema.

## Rollback

```bash
# 1. Pin the previous image
TF_TAG=1.2.2 docker compose -f docker-compose.prod.yml up -d

# 2. If a migration already ran, restore the backup instead:
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U trackforge trackforge < backup-YYYY-MM-DD.sql
```

## Version policy

- Tags: `vX.Y.Z` (semver). Compose images: `X.Y`, `latest`, `sha-*`.
- Breaking API changes are called out in release notes and in
  `docs/jira-divergences.md` where they affect Jira compatibility.

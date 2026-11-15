# Sprint 044 — Production Operations (Backup, Monitoring, Runbooks)

| | |
|---|---|
| **Status** | Done pending live-verification — all US shipped: US1 backup/restore (`2d253ea`), US3 support-zip + `/admin/system` (`fe14f16`), US2 monitoring profile + US5 opt-in update check + ops docs (`e16dec3`), SC-001 restore drill + monthly workflow (`f26d406`). Open: first CI drill run, live monitoring-profile scrape smoke, SC-002 kill-infra check on the running stack |
| **Milestone** | M6 Ship & Operate |
| **Theme** | Day-2 ops: a self-hosted admin can run TrackForge safely without us |
| **Depends on** | 016 (metrics/health/logs/jobs), 043 (distribution artifact), 018 (attachments store for backup scope) |
| **Unblocks** | GA (046) — production readiness checklist; 045's deploy automation |
| **Spec-kit folder** | `specs/044-production-operations/` |

## Goal

Self-hosted TrackForge must be *operable by its admins*, not just installable. DESIGN §19.3
names the backup strategy; this sprint makes it real plus the monitoring and runbooks around it.

- **Backup & restore**: scheduled `pg_dump` (custom, compressed, checksummed) to a volume
  with retention (daily×7, weekly×4, monthly×12); MinIO/attachments mirror (`mc mirror` or
  `rclone` to a second bucket/path — DESIGN §19.3); a `backup` compose service driven by the
  016 scheduler (single execution across instances); **`pnpm backup`/`pnpm restore` scripts**
  plus the documented `docs/backup-restore.md`; **quarterly restore drill** as a DoD ritual.
- **Monitoring stack** (opt-in compose profile `monitoring`): Prometheus scraping `/metrics`
  (016), Grafana with checked-in dashboards (request latency, error rate, JQL/search p95,
  queue depth/failures, outbox lag, DB pool, attachment storage, job runs), Alertmanager-free
  Grafana alert rules exported as JSON; alert list shipped in `docs/alerting.md` with
  "what to do" per alert.
- **Logs**: pino JSON already (016); `docs/logging.md` — levels, `LOG_LEVEL` env, shipping to
  Loki/journald examples; log retention guidance.
- **Runbooks**: `docs/runbook.md` — startup order, restart, "site down", "emails not sending",
  "webhooks not firing", "disk full", "slow JQL", "restore from backup", "reset admin
  password", "rotate JWT_SECRET" (what breaks, how to re-auth), "rotate PAT".
- **Status & diagnostics**: `/admin/system` page (021 shell) — version, uptime, DB/Redis/MinIO
  health, queue depth, last backup status/time, license-free "support zip" generator
  (sanitized config + recent errors — secrets redacted, tested).
- **Update notification**: `/rest/api/2/serverInfo` + an admin "check for updates" that calls
  GitHub releases — **opt-in, off by default** (no silent phone-home; documented).
- **Capacity guidance**: `docs/scaling.md` — DESIGN's ~500k-issue target vs the 016 perf
  budgets; pg tuning, Redis memory, MinIO growth, when to move services off-box.

## Candidate user stories

### US1 — Backup & restore (P1)
1. **Given** the `backup` profile, **When** the scheduler fires, **Then** a timestamped `pg_dump --format=custom` + attachments mirror lands in the backup volume with a manifest (version, sha256, counts); retention prunes per policy; the run is visible in `/admin/system` and emits a metric + failure alert.
2. **Given** a seeded 10k-issue instance, **When** `pnpm restore` runs against a backup, **Then** all entities return and the restore runbook's checksum verification passes (drill test in CI monthly).
3. **Given** upgrade, **When** `docs/upgrade.md` is followed, **Then** a pre-upgrade backup is mandatory and timestamped (restore point for DB rollback).

### US2 — Monitoring (P1)
1. **Given** `docker compose --profile monitoring up`, **When** started, **Then** Prometheus scrapes app metrics and Grafana serves the checked-in dashboards without manual import.
2. **Given** alert rules, **When** error rate > 5 % for 5 min / queue depth grows / backup older than 26 h / disk < 15 %, **Then** the corresponding alert fires; each has a runbook link.
3. **Given** metrics, **When** scraped without auth from outside the profile, **Then** `/metrics` is not publicly reachable (bind to internal network / basic-auth documented).

### US3 — Diagnose without us (P1)
1. **Given** "emails stopped", **When** the admin follows the runbook, **Then** they reach SMTP config, outbox state (029), and a test-send button in `/admin/system` unaided.
2. **Given** a support zip request, **When** generated, **Then** it contains version, sanitized config (no secrets — test greps for `tfp_`/passwords), recent error logs, and queue stats.

## Key constraints

- **FR**: backups MUST be restorable — an untested backup is not a backup (CI restore drill).
- **FR**: monitoring is a profile, not a dependency — core runs with zero extra services.
- **FR**: no telemetry/phone-home by default; update check is explicit opt-in.
- **FR**: runbooks link from the UI (admin system page "docs" links) — findable in context.

## Deliverables

`docker-compose.monitoring.yml` + `backup` service/profile, `prometheus.yml`, Grafana
dashboard JSON, alert rules JSON, `docs/{backup-restore,alerting,logging,runbook,scaling,security-hardening}.md`,
`/admin/system` page, support-zip endpoint (admin toolset MCP `get_system_status` — D21).

## Success criteria

- **SC-001**: CI restore drill: backup → wipe → restore → fixture diff = 0.
- **SC-002**: Kill postgres/Redis/MinIO individually → `/readyz` and `/admin/system` each show the right cause, and the runbook path resolves it.
- **SC-003**: Dashboards render real data on the 016 perf fixture; each shipped alert proven to fire.
- **SC-004**: Support zip contains zero secrets (automated scan).

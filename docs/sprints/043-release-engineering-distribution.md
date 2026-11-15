# Sprint 043 — Release Engineering & Self-Hosted Distribution

| | |
|---|---|
| **Status** | In progress — config contract + Dockerfile + prod compose + release pipeline + docs shipped; install-smoke CI + real-image cosign verification remain |
| **Milestone** | M6 Ship & Operate |
| **Theme** | Turn the finished product into an installable, versioned, verifiable distribution |
| **Depends on** | 016 (health/readiness, metrics, job runner — compose gains `redis` here), 018 (attachments → MinIO wiring), 021 (first-run admin UX), 036 (env surface incl. IdP config) |
| **Unblocks** | GA (046) — "publish to production users" requires a published artifact; pilots beyond 020 run this path |
| **New dependencies (justify in plan)** | `zod` (or existing validator) for env schema at boot — already in dep tree via MCP zod |
| **Spec-kit folder** | `specs/043-release-engineering-distribution/` |

## Goal

A production user can install TrackForge in under 10 minutes and trust the artifact:

- **Production images**: multi-stage Dockerfiles — `trackforge-app` (backend Node runtime,
  serves built frontend as static assets behind the same origin — no CORS/proxy needed),
  non-root user, pinned base images (`node:20-alpine` digest-pinned), OCI labels
  (`org.opencontainers.image.source/revision/version`), `HEALTHCHECK` on `/healthz`,
  graceful `SIGTERM` shutdown (drain HTTP + jobs before exit).
- **Production compose** (`docker-compose.prod.yml`): `app`, `migrate` (one-shot
  `prisma migrate deploy` job gated on postgres health — DESIGN §19 single-node path),
  `postgres` (volume, healthcheck, no host port by default), `redis`, `minio` (attachments —
  `AttachmentStore` `s3` adapter configured), optional `nginx`/`caddy` profile, SMTP via env.
  Root `docker-compose.yml` stays dev-only.
- **Config contract (12-factor)**: every setting via env or mounted secret file
  (`*_FILE` convention); a zod-validated `config.ts` that **fails fast at boot** with a
  readable error table (name, expected format, why it's needed) — no runtime surprises;
  `docs/env-reference.md` generated from the schema so it can't drift.
- **First-run experience**: `TF_ADMIN_EMAIL`/`TF_ADMIN_PASSWORD`/`TF_ADMIN_PASSWORD_FILE`
  bootstrap OR a `/setup` wizard that exists only while zero admin users exist (locks itself);
  `seedMetadata`-style bootstrapping runs automatically.
- **Versioning & artifacts**: semantic versioning; `version` in `/rest/api/2/serverInfo`
  (Jira already calls this — `version`/`buildNumber`/`buildDate` fields); conventional-commits
  changelog (`changesets` — monorepo-native, versions `apps/*` once via root `version`);
  GitHub Releases with the compose file + `env.example` attached.
- **Image publishing**: GHCR via GitHub Actions on tag push — multi-arch
  (linux/amd64+arm64, `docker buildx`), tags `vX.Y.Z`, `X.Y`, `latest`, `sha-*`;
  Trivy scan gate (HIGH+CRITICAL fails); SBOM (`syft`, attached to release);
  cosign keyless signing + `VERIFY.md` instructions.
- **Provenance & trust**: `SECURITY.md` (report policy, supported versions), `gitleaks` in CI,
  Dependabot/Renovate for the repo, published support matrix (Node/Postgres/Redis versions).

## Why now (and the honest debate)

This is deliberately placed **late-but-before-GA**, not last: GA must mean "production users
can adopt". It can't be earlier because the artifact isn't stable until the data model settles
(014–041 change migrations, env vars, and services). The **020 pilot** runs the dev compose +
020's admin-guide deliverable — adequate for an internal pilot; 043 productizes it for GA.

## Candidate user stories

### US1 — 10-minute install (P1)
1. **Given** a clean Linux VM with Docker, **When** the user copies `docker-compose.prod.yml` + `.env.example`, sets `JWT_SECRET` + admin creds, and runs `docker compose -f docker-compose.prod.yml up -d`, **Then** login works in < 10 min (timed in CI on a fresh runner).
2. **Given** a missing/invalid required env, **When** the app starts, **Then** it exits 1 with a table of what's wrong — never starts half-configured.
3. **Given** `migrate` service, **When** the stack starts, **Then** migrations run exactly once before `app` is healthy; `app` `depends_on` migrate `completed_successfully`.

### US2 — Verifiable artifacts (P1)
1. **Given** tag `v1.0.0`, **When** pushed, **Then** CI builds+scans+signs+SBOMs and publishes `ghcr.io/<org>/trackforge:{v1.0.0,1.0,latest,sha-*}` amd64+arm64, and creates the GitHub Release with changelog + compose + env files.
2. **Given** `cosign verify ghcr.io/.../trackforge:v1.0.0`, **When** a user runs it per `VERIFY.md`, **Then** signature + issuer identity validate.
3. **Given** a HIGH+ CVE in a base image, **When** Trivy runs, **Then** the publish job fails with the CVE listed.

### US3 — Single-origin runtime (P1)
1. **Given** the prod image, **When** running, **Then** the backend serves the frontend build at `/`, the SPA router falls back to `index.html`, `/rest`, `/api/internal`, `/rest/agile`, `/api/internal/events/stream` (SSE through proxy timeouts documented) all work — one port, no CORS.
2. **Given** `/rest/api/2/serverInfo`, **When** called, **Then** `version`, `buildDate`, `buildNumber` reflect the image's build metadata (injected via OCI labels → env).

### US4 — Upgrade path (P1)
1. **Given** `v1.0.0` running with data, **When** upgrading to `v1.1.0`, **Then** `docker compose pull && up -d` runs `migrate` first, app rolls forward, and `docs/upgrade.md` explains the backup-before-upgrade step (runs 044's backup job) and that DB rollback = restore (forward-only migrations).
2. **Given** a broken release, **When** rolling back, **Then** pinning the previous image tag + restoring the pre-upgrade backup is a documented, tested path.

## Key constraints

- **FR**: no secrets in the image or repo; runtime config only via env/`*_FILE`.
- **FR**: images run read-only-root + dropped capabilities where feasible; no `latest` base pins.
- **FR**: every published artifact is reproducible from the tag (`provenance` attestation).
- **FR**: `docker-compose.prod.yml` MUST NOT expose postgres/redis/minio ports publicly by default.
- **FR**: env schema is the single source of truth — `env.example` and `env-reference.md` generated.
- **Divergence (documented)**: DESIGN §19 shows separate frontend/backend services + OpenSearch;
  v1 ships single-origin app (no OpenSearch — D-list divergence) — documented in `docs/deployment.md`.

## Deliverables

`apps/backend/Dockerfile` (multi-stage, bundles frontend build), `.dockerignore`,
`docker-compose.prod.yml`, `.env.example`, `docs/{install,upgrade,env-reference,verify}.md`,
`.github/workflows/release.yml`, `SECURITY.md`, `serverInfo` version fields, setup-wizard or
bootstrap path.

## Success criteria

- **SC-001**: Clean-VM install < 10 min (CI job `install-smoke` does it unattended).
- **SC-002**: `cosign verify` + Trivy report + SBOM attach to every release.
- **SC-003**: Upgrade v_prev→v_current on a seeded 10k-issue fixture: zero manual steps beyond the documented backup+pull+up.
- **SC-004**: `serverInfo.version` correct in the image; env-validation failure output is human-readable.

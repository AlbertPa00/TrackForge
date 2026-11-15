# Sprint 045 — Deployment Environments, HA Readiness & Ship Automation

| | |
|---|---|
| **Status** | In progress — US1 pipeline (deploy.yml + smoke suite + staging override), US2 migration-compat CI check (proven on synthetic break), US3 SESSION_SECRET denylist + docs/{migrations,ha,release-process}.md shipped. Remaining: Helm chart (P2, waivable post-GA), SC-002 rollback verified on a real staging env, SC-004 ha.md topologies live-run |
| **Milestone** | M6 Ship & Operate |
| **Theme** | Staging/prod delivery pipeline + the honest limits of single-node deployment |
| **Depends on** | 043 (images/releases), 044 (backup for upgrade path), 016 (BullMQ cluster-safe runner) |
| **Unblocks** | GA (046) — the release candidate pipeline is how GA ships |
| **Spec-kit folder** | `specs/045-deployment-environments-ha/` |

## Goal

The last mile of DevOps: automated delivery through environments, and an honest account of
what "high availability" means for a self-hosted single-node product (DESIGN §19 targets one
server — multi-instance is documented readiness, not a promise).

- **Delivery pipeline**: `.github/workflows/deploy.yml` — `staging` deploys on every
  `main` merge (or RC tag), `production` deploys only via GitHub Environment approval
  (required reviewers); post-deploy **smoke suite** (`/healthz`, login, project list, issue
  create/edit, JQL search, board fetch — reused Playwright subset + API checks); automatic
  **rollback** = re-deploy previous image tag if smoke fails (DB only rolls forward — the
  compatibility rule below).
- **Staging environment**: documented reference stack (compose on a VM is fine) with the
  perf seed; RCs soak there (≥ 24 h or one working day) before prod per `docs/release-process.md`.
- **Release process**: `docs/release-process.md` — RC cut, changelog review, staged soak,
  prod promotion, patch/hotfix flow (cherry-pick → patch release), security-advisory flow
  (SECURITY.md + GitHub advisories + release note flag).
- **Migration compatibility for rolling deploys** (the hard rule): multi-version rollouts
  require **expand-migrate-contract** discipline — every migration must be backward-compatible
  with the previous app version (additive-only within a release; destructive changes split
  across two releases). Enforced by a `migration-compat` CI check that runs the previous
  release's app against the new schema for the P1 journeys.
- **HA readiness (documented, honest)**: app stateless (JWT, no in-process state beyond
  caches); BullMQ scheduler already exactly-once across instances (016); requirements for
  >1 replica — shared Postgres/Redis/MinIO, SSE fan-out via Redis pub/sub (flagged: single-node
  SSE is in-process — multi-instance needs the pub/sub adapter built here or documented as
  1-replica-only); sticky sessions not needed; `docs/ha.md` with the supported topologies
  (1 app replica fully supported; N replicas = "works, SSE caveat" or resolved).
- **Kubernetes path**: a minimal **Helm chart** (`deploy/helm/trackforge`) — app+worker
  Deployments, postgres/redis/minio via external refs or subchart flags, PVCs, probes
  (`/healthz`/`/readyz`), ingress example, values documented; smoke-tested on kind in CI
  (P2 — can waive to post-GA).
- **Secrets handling**: compose `*_FILE` + k8s Secrets/External Secrets examples; boot
  refuses to run if `JWT_SECRET` is the documented example value (guard like the HMAC gotcha
  pattern).

## Candidate user stories

### US1 — Delivery pipeline (P1)
1. **Given** a merge to `main`, **When** CI is green, **Then** the staging environment updates automatically and the smoke suite runs; failures page the pipeline, not users.
2. **Given** a green staging soak, **When** a maintainer approves the `production` environment, **Then** prod deploys the same image digest (never rebuilt — promote, don't rebuild) and smoke runs again.
3. **Given** a failed post-deploy smoke, **When** detected, **Then** the workflow re-deploys the previous image tag and marks the release bad; DB stays forward (rule enforced by migration-compat).

### US2 — Rolling-safe migrations (P1)
1. **Given** a PR adding a migration, **When** the `migration-compat` job runs, **Then** the previous release's app boots and passes P1 journeys against the new schema; non-additive changes fail with the expand-contract guidance.
2. **Given** a destructive change need (drop column), **When** planned, **Then** the docs enforce the two-release split (release N: stop writing; release N+1: drop).

### US3 — HA & k8s (P2)
1. **Given** two app replicas behind a proxy, **When** running, **Then** jobs still run once (016), sessions work statelessly, and SSE either fans out via Redis pub/sub or the docs pin SSE-aware deployments to one replica (choose in plan).
2. **Given** the Helm chart, **When** `helm install` on kind runs in CI, **Then** the smoke suite passes against the ingress URL (P2, waivable).
3. **Given** `JWT_SECRET=change-me`, **When** the app boots, **Then** it refuses with the fix instruction (no silent default-secret run).

## Key constraints

- **FR**: the prod image is promoted by digest — what soaked is what ships.
- **FR**: every schema change within a release is expand-only; contract changes happen across two releases (documented in `docs/migrations.md` + the CI check).
- **FR**: staging data is synthetic/perf-seeded — never production copies with user data.
- **FR**: HA claims must be tested or explicitly documented as unsupported — no "should work".
- **Out**: managed/hosted TrackForge (single-tenant SaaS is a different business), blue/green
  traffic management (replicas ≤ "works at 1, documented at N"), Chaos-engineering suite
  beyond the 016 crash tests.

## Deliverables

`.github/workflows/deploy.yml`, smoke suite (`tests/smoke/` shared by pipeline + 045 docs),
`docs/{release-process,migrations,ha}.md`, `deploy/helm/trackforge/` chart, compose
`staging`/`prod` override examples, SSE multi-instance decision + implementation or doc pin.

## Success criteria

- **SC-001**: End-to-end dry run: merge → staging deploy → soak → approve → prod, all automated except the approval click.
- **SC-002**: Smoke-fail → automatic rollback to previous image, verified in staging.
- **SC-003**: `migration-compat` CI catches a deliberately breaking migration in test.
- **SC-004**: `docs/ha.md` reviewed-true: every claimed topology was actually run.

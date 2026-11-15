# Release process

The go/no-go bar for each step lives in **`docs/release-gates.md`** — a tag
does not exist until every hard gate is green and conditional waivers are
recorded.

## Cadence

Semver tags `vX.Y.Z` drive everything: `release.yml` builds/publishes the
multi-arch image, SBOM, and signature on tag push.

## Ship flow

1. **RC cut** — tag `vX.Y.Z-rc.N` on main → release workflow publishes
   `-rc.N` images (GHCR, signed). Changelog drafted from commits.
2. **Staging soak** — `deploy.yml` auto-deploys main/RC to the `staging`
   environment; smoke suite (`tests/smoke/smoke.mjs`) gates it. Soak ≥ 24h
   or one working day on the perf-seeded synthetic data (never prod copies).
3. **Prod promote** — a maintainer approves the GitHub `production`
   environment → same digest ships (promote, don't rebuild). Smoke re-runs.
4. **Post-prod** — smoke fail ⇒ automatic rollback to previous image tag;
   DB stays forward (expand-contract, `docs/migrations.md`).

## Patch / hotfix

Cherry-pick the fix onto the release branch → tag `vX.Y.(Z+1)` → same flow
with an abbreviated soak (judgment call, documented in the release notes).

## Security releases

Per `SECURITY.md`: fix privately → GitHub security advisory → release with
the advisory linked → mark the release notes `[security]` and bump the
severity in `docs/alerting.md` if it adds an ops action.

## Pre-upgrade (operators)

`docs/backup-restore.md` — a verified backup is mandatory before any
version bump; the migrate service rolls the schema forward only.

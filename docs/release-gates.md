# Release gates — QA lines before publishing to customers

The go/no-go bar for any `v*` tag, and the one-time **launch gate** for the
first public publish. `release-process.md` defines the flow; this file defines
what must be true to move through it.

## Rules

- Every gate has a **measurable pass line** and an **enforcer** (a workflow
  step, a suite, or a named human who signs the release notes).
- Two severities:
  - **hard** — no ship, no waiver. Fix it or don't tag.
  - **conditional** — the release owner may waive *once*, per gate: file an
    issue tagged `waived`, name the reason in the release notes. The same
    conditional gate cannot be waived on two consecutive releases.
- "auto" means a workflow enforces it; "manual" means the release owner
  verifies and signs. A manual line that is skipped still counts as failed.

## Gate 1 — Build integrity (auto, hard)

| # | Line | Enforcer |
|---|---|---|
| G1.1 | `pnpm install --frozen-lockfile` clean | ci.yml, release.yml |
| G1.2 | `pnpm typecheck` zero errors on all apps | ci.yml, release.yml |
| G1.3 | `pnpm lint` **zero warnings** (repo bar) | ci.yml, release.yml |
| G1.4 | Frontend + backend production builds succeed | ci.yml, release.yml image job |

## Gate 2 — Correctness (auto, hard)

| # | Line | Enforcer |
|---|---|---|
| G2.1 | Backend suite: 100% pass, no new `skip`/`todo` | ci.yml `backend test` |
| G2.2 | Frontend coverage ≥ 60% on named components | ci.yml `test:coverage` |
| G2.3 | Playwright e2e green (incl. axe a11y spec) | ci.yml `test:e2e` |
| G2.4 | MCP eval: **every check green** — currently 135/135; count must grow with tool surface, never shrink without a registry change | ci.yml `trackforge-mcp eval` |
| G2.5 | Cold-install smoke green on main (compose build → healthz → admin login → SPA → infra ports private) | install-smoke.yml |
| G2.6 | OpenAPI/route drift test green — every mounted route registered | `agent.test.ts` |

## Gate 3 — Security & supply chain (auto + manual, hard unless noted)

| # | Line | Enforcer |
|---|---|---|
| G3.1 | gitleaks: zero findings over **full history** (fetch-depth 0) | release.yml |
| G3.2 | Zero prod dependency vulns ≥ high outside `scripts/audit-allowlist.json`; every allowlist entry has an expiry + issue link | ci.yml `audit-check.mjs` |
| G3.3 | Trivy on the shipped digest: zero fixable HIGH/CRITICAL | release.yml |
| G3.4 | `docs/threat-model.md` has a row for every attack surface added since the last tag — check each merged sprint's SC list (manual) | release owner |
| G3.5 | SBOM (SPDX-JSON) published; image cosign-signed; `VERIFY.md` verify steps pass on the released digest (manual — run it) | release.yml + release owner |
| G3.6 | No `tfp_`/session/test credentials in repo, docs, or release notes — `scripts/hygiene-scan.mjs` scans tracked files for secret-shaped literals + tracked `.env`/key material | ci.yml |
| G3.7 | Dependabot PRs triaged — none open ≥ high older than 14 days (conditional) | release owner |

## Gate 4 — Agent-safety (auto, hard)

The product's core claim; a single failure here is a launch story about the
competitor's CVE happening to us.

| # | Line | Enforcer |
|---|---|---|
| G4.1 | Readonly toolset: zero `MUTATION_REGISTRY` keys in `tools/list`; a direct `tools/call` to a filtered tool is refused | eval §37 + contract scan |
| G4.2 | Zero write tools registered without the `if (write)` gate (`wtool` or `server.tool`) | eval source scan |
| G4.3 | Scopes enforced **at call time**: read-scope token writes → 403; `projectAllowed`/`enforceIssueScope` on every project-scoped route | eval + `scope053.test.ts` |
| G4.4 | Approval policies honored: `always` → 202 proposal (incl. `POST /agent/claim`), `destructiveOnly` → destructive ops park, replay re-validates, self-approve impossible | eval gated-token block |
| G4.5 | `?dryRun=true` on every mutating issue route; destructive deletes require `confirmToken` | eval dry-run checks |
| G4.6 | `Idempotency-Key` replay-safe: same key+body → same entity; same key+different body → 422 | eval + integration |
| G4.7 | Every mutation carries actor/channel attribution in changelog/audit | integration tests |

## Gate 5 — Data & operations (auto/scheduled + manual)

| # | Line | Enforcer |
|---|---|---|
| G5.1 | Migration expand-contract check green; no destructive migration ships without a paired expand/contract issue | ci.yml `migration-compat.mjs` |
| G5.2 | Restore drill green within the last 30 days — dispatch `restore-drill.yml` manually if stale | restore-drill.yml |
| G5.3 | Perf budgets green on the 50k fixture (p95 latency/memory) | ci.yml `perf:check` |
| G5.4 | Concurrency soak ≥ 1× per release at ≥ default params; run id recorded in release notes (conditional — can waive once) | concurrency.yml dispatch |
| G5.5 | Staging soak ≥ 24h with zero sev-1/sev-2 alerts and green smoke | deploy.yml + `tests/smoke/smoke.mjs` |
| G5.6 | Prod deploys the **same digest** that soaked — promote, don't rebuild; rollback path (previous tag) verified in the last 90 days | deploy.yml; manual audit |
| G5.7 | `docs/alerting.md` severities still match reality; a named human owns the alert channel during the 48h post-publish window (manual) | release owner |

## Gate 6 — Launch gate (one-time, first customer publish)

Everything above, plus:

| # | Line | Status |
|---|---|---|
| L1 | `LICENSE` decided and committed — the deferred decision from sprint 063. **Hard block for public visibility.** | open |
| L2 | `ghcr.io/…/trackforge` public: `docker compose -f docker-compose.prod.yml up -d` on a clean machine pulls the published image without building. Required before "one-command install" may appear in copy. | open (manifests currently `denied`) |
| L3 | README + `docs/install.md` walked line-by-line from a clean clone; every cited number reproduced from the tagged tree | **partially wired** — `scripts/docs-claims.mjs` in CI verifies cited `pnpm --filter`/`pnpm`/compose commands and doc links resolve; the clean-clone prose walkthrough stays manual |
| L4 | `docs/compatibility.md` regenerated from the tagged build's OpenAPI; compat-regen CI job added so drift fails CI | **wired** — ci.yml regenerates + `git diff --exit-code` after the eval step |
| L5 | Repo metadata: public name/description/topics set; no clone/dupe product framing in public-facing copy (`hygiene-scan.mjs` enforces the clone-family patterns); README hero + demo script checked | copy wired — `hygiene-scan.mjs` in CI; name/topics remain a GitHub-setting, manual |
| L6 | `SECURITY.md` contact monitored; named owner for incoming reports; P0 response expectation stated | open |
| L7 | `.env.example` ↔ `docker-compose.prod.yml` field parity | **wired** — `scripts/env-parity.mjs` runs in CI: compose `${VAR}` refs must be documented, active example keys must be consumed; un-documented backend env reads warn |
| L8 | Support path real: issue tracker + discussion channel stated in README | **done** — README `## Support`: GitHub Issues + private security reports via `SECURITY.md` |

## Release sign-off format

Paste `.github/release-signoff.md` into the release notes and fill every
`✅/➖` line. Condensed version:

```
Gates: G1 ✅  G2 ✅  G3 ✅  G4 ✅  G5 ✅ (G5.4 waived — issue #NNN)
Launch: L1..L8 ✅   Owner: @name   Digest: sha256:…
```

A release without this block did not pass QA — treat it as unpublished.

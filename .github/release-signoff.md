<!--
Release sign-off — paste into the release notes body before publishing.
Every hard gate must be ✅. A conditional gate may be ➖waived once, with
the `waived:` issue linked; the same gate cannot be waived twice running.
Rules: docs/release-gates.md
-->

## QA sign-off

Owner: @____  ·  Tag: v____  ·  Digest: `sha256:____`  ·  Soak start: ____ (UTC)

**G1 Build** — `✅/➖`
frozen-lockfile install · typecheck · lint 0 warnings · both builds

**G2 Correctness** — `✅/➖`
backend suite pass (no skips) · frontend coverage ≥60% · playwright e2e ·
MCP eval all-green · install-smoke · openapi drift

**G3 Security** — `✅/➖`
gitleaks clean · audit ≥high zero outside allowlist · trivy fixable HIGH/CRIT zero ·
threat-model rows added this cycle · SBOM+cosign verified on digest ·
no credentials in tree · dependabot triaged

**G4 Agent-safety** — `✅/➖`
readonly toolset leaks zero mutations (list + call-time) · all writes `if(write)`-gated ·
call-time scopes/403s · approval policies incl. claim · dryRun+confirmToken · idempotent replay ·
attribution recorded

**G5 Data/ops** — `✅/➖`
expand-contract green · restore drill ≤30d · perf budgets green ·
concurrency soak run ≥1× (run: ____) · staging soak ≥24h, zero sev-1/2 ·
same digest promoted · rollback verified ≤90d · alert owner during 48h window: @____

**G6 Launch (first publish only)** — `✅/➖/n/a`
LICENSE committed · GHCR image public, clean-machine pull verified ·
README/install walked on clean clone · compat matrix regenerated from tag ·
repo metadata set (no clone/dupe framing in copy) · SECURITY.md contact monitored ·
.env.example↔compose parity · support channel stated

Waivers: `____` (issue links; leave blank if none)

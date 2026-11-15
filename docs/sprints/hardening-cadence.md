# Hardening Cadence (H-sprints)

**Rule**: after every 4 feature sprints there is one hardening sprint. 016 (H1) and 020 (H2)
are detailed sprint docs; later H-sprints are planned here and get their own doc at wave
planning (rolling-wave rule, roadmap §2).

## Why

Sprint 008 (one L sprint) shipped with ~13 correctness/security defects while its test suite
was green. Nineteen consecutive feature sprints would compound that. A fixed cadence keeps
defect debt, perf regressions and doc drift bounded and gives each milestone an exit gate.

## Fixed scope of every H-sprint

1. **Defect burn-down**: all P0/P1 items in `docs/hardening-backlog.md`; P2 trend down.
2. **Perf**: 016 budgets re-run on the perf fixture (grown with new entities); regressions fixed.
3. **Security**: threat-model entries for the wave's new surfaces reviewed; leak test extended to new read paths; dependency audit clean.
4. **Compat audit**: new `compat.ts` rows verified against official Jira docs.
5. **Test debt**: frontend unit coverage for the wave's components; Playwright journeys for the wave's P1 flows; flaky tests fixed or quarantined with owner.
6. **Importer parity**: re-run the pilot/fixture import; every entity added in the wave appears in the 017 validation report.
7. **MCP surface review** (D21): tool count per toolset ≤ 30; merge/retire redundant tools; eval pass.
8. **Docs**: admin/user/API docs updated; roadmap §1 baseline refreshed.
9. **Milestone gate**: each H-sprint closes a milestone with an explicit gate table (see 020 for the format).

No new features. Feature requests discovered go to the next wave's refinement.

## Schedule

| H | Sprint | Closes | Milestone-specific gate focus |
|---|---|---|---|
| H1 | [016](016-platform-reliability.md) | — (infrastructure) | Job runner, observability, perf baseline, frontend tests, threat model |
| H2 | [020](020-mvp-gate.md) | M1 Parity MVP | Real pilot from Jira Cloud |
| H3 | 025 | M2 Daily-driver parity | Admin self-service without API calls; bulk-job load test (500 issues); worklog/estimate accuracy vs Jira fixture |
| H4 | 030 | M3 Insight & communication | Report numbers match hand-computed fixtures; email delivery/outbox chaos test; dashboard per-viewer permission test |
| H5 | 035 | M4 Configurability & power | Issue-security leak test across *every* read path (search, boards, dashboards, reports, exports, webhooks, SSE, MCP); automation loop/escalation tests |
| H6 | 046 | M6 Ship & Operate — GA | Full XML/CSV round-trip; v2/v3 parity test; SSO/2FA pen-test checklist; WCAG automated pass; **042 UX-parity ledger clean (P0=0)**; clean-VM install <10 min; restore drill passed; deploy-pipeline dry run; GA release notes |

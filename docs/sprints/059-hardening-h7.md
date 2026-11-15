# Sprint 059 — Hardening H7 (post-GA audit wave gate)

| | |
|---|---|
| **Status** | Done |
| **Closes** | Audit wave 053–058 |
| **Cadence** | Fixed scope per `hardening-cadence.md` — no new features |

## Gate table

| Fixed scope | Result | Evidence |
|---|---|---|
| 1. Defect burn-down | **Pass** — zero open P0/P1 in `hardening-backlog.md`; H5-c (MCP toolset namespacing) stays routed P2; distributed tracing/replicas/WCAG remain "Later" by design | backlog table |
| 2. Perf budgets | **Pass** — re-run on the 50k fixture, all green (issue GET p95 60ms/100, search+CF 241/300, board 126/400, backlog 122/500, perm eval 0/5) | `perf-check.ts` |
| 3. Security | **Pass** — threat-model entry added for the 058 rollup read paths (`/summary`, `/agent-activity`); leak coverage: 8/8 `sprint058.test.ts` incl. BROWSE denial + lowercase-bypass + cross-project scoping | `threat-model.md`, `sprint058.test.ts` |
| 4. Compat audit | **Pass** — new routes are `/api/internal` (D-002); OpenAPI drift test green (`agent.test.ts` 15/15); D-014 resolved, D-015–D-019 recorded | `jira-divergences.md` |
| 5. Test debt | **Pass** — `sprint058.spec.js` Playwright 4/4: drawer open/Escape/`?selectedIssue=`, deep-link restore, palette local command with zero AI calls, summary widgets | `tests/e2e/sprint058.spec.js` |
| 6. Importer parity | **N/A** — wave added no new importable entities (UI/internal-API wave) | — |
| 7. MCP surface | **Pass** — drift scan 7/7 (zero dupes, wtool coverage, 75↔75 registry parity); eval 115/115 from 057 stands — no tool changes this wave | `eval/run.ts` |
| 8. Docs | **Pass** — `ux-parity-ledger.md`, `jira-divergences.md`, `threat-model.md`, sprint docs updated | this doc |
| 9. Milestone gate | **Pass** — audit wave 053–058 closes clean | — |

## Findings fixed inside the gate

| # | Item | Severity | Status |
|---|---|---|---|
| H7-a | `/agent-activity` project lookup not key-normalized — lowercase project keys 404'd while `/summary` normalized | P2 | **fixed** (`agentSessions.ts`) |
| H7-b | `ProjectSummaryPage` used wrong `PageHeader` prop (`breadcrumbs` vs `crumbs`) | P2 | **fixed** |
| H7-c | UB-020 drawer/palette e2e gap — deferred at 058 close | P2 | **fixed** (4/4 spec) |
| H7-d | Sidebar "List" pointed at the index route now owned by Summary — added a real List entry to the project-scoped navigator + `search` icon | P2 | **fixed** |

## Wave retro (053–058)

- 053 security/scope, 054 drag correctness, 055 interactions, 056 MCP contracts,
  057 data integrity, 058 better-than-Jira UX — all closed with green gates.
- The wave's structural wins: `wtool`/AsyncLocalStorage extras (no more per-site
  flag forwarding), source-scan drift test (contract drift now fails CI without a
  server), `patchIssueLists` (one rollback primitive for all optimistic writes),
  and `enforceIssueScope` alias normalization.
- Known accepted residuals: `ReportsPage`/CSV 2-D cell key format changed to
  `JSON.stringify([x,y])` in 057 — migration note for existing persisted gadget
  caches is tracked in the 057 doc.

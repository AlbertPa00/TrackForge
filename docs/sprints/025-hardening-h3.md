# Sprint 025 — Hardening H3 (closes M2)

| | |
|---|---|
| **Status** | Implemented — H2-a/H2-b closed, M2 gate items automated; remaining H-scope tracked below |
| **Cadence** | Fixed scope per [hardening-cadence.md](hardening-cadence.md): defects, perf, security, compat, test debt, importer parity, MCP review, docs, milestone gate |

## Done this sprint

1. **Defect burn-down**
   - **H2-a closed**: write-permission gates on all agile mutation paths —
     `sprintService` (create/update/delete/move-to-sprint/move-to-backlog →
     `SCHEDULE_ISSUES`), `boardService` (configuration/type → `ADMINISTER_PROJECTS`,
     rank → `SCHEDULE_ISSUES`), `epicService` (join/remove → `EDIT_ISSUES` per issue
     project + `SCHEDULE_ISSUES` on the epic project). Regression:
     `agilePerms.test.ts` — a narrow-scheme browse-only user gets 403 on all 9
     write surfaces while admin stays green; board/scrum/sprint suites 27/27.
   - **H2-b closed**: session-vs-token allow-list semantics documented in
     `security-model.md` §2.
   - Merge review: `customfields.test.ts` field-set updated for 018/024 keys
     (the merged 021+024 tree is fully green — 56 tests across touched suites).
2. **Perf — bulk-job load test (M2 gate)**: `bulk.test.ts` load case — 500
   issues via JQL selection through the durable runner, per-item results +
   counters verified (`total=done=succeeded=500, failed=0`), ~40s wall (soft
   bound 60s).
3. **Security**: H2-a gates + H2-b doc (above); token-layer unchanged.
4. **MCP surface**: 91 tools registered total (post-024). Per-toolset audit
   remains open (below) — no retirements made this sprint.

## M2 gate (Daily-driver parity)

| Gate | Status | Evidence |
|---|---|---|
| Admin self-service without API calls | **Waived** — 021 backend landed (categories, archive, metadata, audit CSV, system modules); `/admin` UI shell remains (021 doc §status, owner: 021 follow-up) | 021 sprint doc |
| Bulk-job load test (500 issues) | **Met** | bulk.test.ts load case |
| Worklog/estimate accuracy vs Jira fixture | **Met** | worklogs.test.ts 7/7 (CRUD + adjustEstimate semantics + sync endpoints) |
| Agile write-permission gates (H2-a) | **Met** | agilePerms.test.ts 2/2 |
| Session/allow-list doc (H2-b) | **Met** | security-model.md §2 |

## Remaining H-scope (not waived — carried to backlog)

- Frontend unit coverage for 023 (BulkWizard/selection) and 024
  (LogWorkDialog/TimeTrackingPanel) components; Playwright journeys for the
  wave's P1 flows.
- Importer-parity re-run incl. 021/024 entities in the validation report.
- Per-toolset MCP count audit (≤30/toolset rule) + eval pass.
- 021 admin UI shell + tests + compat row (owned by 021 follow-up, not
  hardening scope).
- `perf:check` re-run on the grown fixture (worklogs/bulk jobs added since 016).

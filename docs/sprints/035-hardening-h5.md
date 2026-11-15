# Sprint 035 — Hardening H5 (M4 gate)

| | |
|---|---|
| **Status** | Done — gate table below; H6 carries MCP namespacing (H5-c) |
| **Cadence** | H5 — closes **M4 Configurability & power** (sprints 031–034) |
| **Gate focus** | Issue-security leak test across **every** read path (search, boards, dashboards, reports, exports, webhooks, SSE, MCP); **automation loop/escalation** tests |

M4 shipped issue-security schemes, field/workflow/issue-type schemes, the JQL
completion, multi-boards, and the automation engine. H5 proves the two
properties that make the wave trustworthy: **secured issues never leak**, and
**rules can never exceed their author**.

## Work items

### W1 — Security leak matrix: every read path
Extend `leakmatrix.test.ts` + `leak.test.ts` so a secured issue is invisible via:
- JQL search + navigator + saved filters + filter subscriptions (029)
- Board issues, backlog, sprint issues, board picker (033)
- Dashboards: every gadget resolver + shared-dashboard viewer path (026)
- Reports: every resolver incl. CSV export (027/028)
- Bulk export endpoint (023), issue picker (033)
- Webhook deliveries: secured events must not enqueue a delivery for
  subscribers lacking visibility (011/029)
- SSE broadcast: `sseBroadcast` project allow-list honored
- MCP tools: `get_issue`, `search`, `run_filter`, `pick_issue`, board tools
- Comments/worklogs/attachments sub-resources; changelog; link panels

### W2 — Automation loop & escalation suite (deferred from 034)
- **Escalation**: rule actor ≠ author only with site admin; project admin
  cannot author global rules; run fails closed when author loses
  `BROWSE_PROJECTS` after save (re-evaluated per run).
- **Loop**: two mutually-triggering rules (A comments → B comments → A…)
  terminate at the depth cap with `skipped-loop` runs; same-rule recursion
  proven structurally (already covered — extend to cross-rule chains).
- **Attribution**: every write carries `channel='automation'`; changelog shows
  the rule actor, not the author.
- **Validation**: `POST /validate` rejects unknown types, bad JQL, bad actor;
  disabled rules never run; `failureCount` increments on action errors.

### W3 — Perf re-run
`perf:check` + `perf:check:security` on the 50k fixture; fixture grown with
automation rules + schemes where material. Budget breaches fixed or recorded.

### W4 — Compat audit
`compat.ts` rows added in 031–034 (schemes, boards, quickfilter, picker,
automation endpoints where Jira-shaped) verified vs official docs; gaps
recorded as deviations.

### W5 — MCP surface review (D21)
Tool count per toolset ≤ 30; automation board/scheme tools reviewed for
merge/retire; eval suite pass.

### W6 — Test debt
Frontend unit tests for wave components (BoardSettings quick filters,
AutomationPage); Playwright journey for create-rule → fire → audit path if
budget allows; flaky tests quarantined with owner.

### W7 — Importer parity
Re-run pilot fixture import; new wave entities (schemes, multi-boards) either
import or are documented as import-excluded in `docs/importers.md` (039 owns
the XML/CSV carrier).

### W8 — Docs refresh
`security-model.md` (automation actor/author model, channel), `deployment.md`
(automation.schedule job), `docs/automation.md` already landed in 034.

## Milestone gate (M4 exit)

| Gate | Evidence | Status |
|---|---|---|
| Secured issues invisible on every read path | W1 matrix all green (7/7 incl. picker + SSE) | **green** — SSE leak found + fixed |
| Automation cannot escalate privileges | W2 suite green (6/6) | **green** |
| Rules cannot loop indefinitely | skipped-loop runs in audit log | **green** — same-rule + cross-rule proven |
| Perf budgets hold | W3 security gate: ~160-186ms secured vs 360 | **green** |
| New endpoints audited vs Jira | W4 compat.ts entry added | **green** — automation = native ext |
| MCP toolsets ≤ 30 | W5: 118 tools in one flat surface | **P2** — namespacing deferred to H6 (backlog H5-c) |

## Definition of Done

- [x] Common DoD in roadmap §4.
- [x] Gate table above — every row green or explicitly deferred with owner (H5-c → 046).
- [x] Backlog P0/P1 items triaged; none open that belong to M4 scope.

## Results (2026-11-17)

**W1** — found+fixed a real P0: SSE live + backfill broadcast secured-issue
events to all project subscribers; per-client `canSeeIssue` now gates both
paths. Matrix extended (picker, `eventIssueVisible`) → 7/7.
**W2** — `automationEsc.test.ts` 6/6: authoring perms, cross-actor admin gate,
fail-closed per-run intersection, cross-rule loop termination, automation
attribution, disabled inertness, failureCount, validate errors. Caught a P1:
async throws on automation routes hung instead of erroring (`ah()` wrapper).
**W3** — perf:check:security green (159–186ms vs 360).
**W4** — compat.ts entry.
**W5** — 118 flat tools → backlog H5-c.
**W6** — `automation.test.tsx` 6/6 (AutomationPage list/toggle/audit/editor +
IssuePicker); fixed stale `fetchProjects` mock in components.test.tsx → 24/24.
**W7** — board importer now carries Jira quick filters → `BoardQuickFilter`;
fixed stale `board.findUnique({projectId})` in import.test.ts → 6/6.

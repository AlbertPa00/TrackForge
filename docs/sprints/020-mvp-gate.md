# Sprint 020 — Parity MVP Gate (Hardening H2)

| | |
|---|---|
| **Status** | In progress — autonomous scope landed; G1/G2/G8 waived pending human pilot |
| **Milestone** | M1 Parity MVP — exit gate |
| **Theme** | Hardening + proof: can a real team switch from Jira? |
| **Depends on** | 009–019 complete |
| **Unblocks** | Wave 2 planning (021–025 refined from epic to detailed using pilot evidence) |
| **Spec-kit folder** | `specs/020-mvp-gate/` |

## Goal

M1's promise is "a team can move from Jira Cloud and work daily in TrackForge". This sprint
proves or disproves it with a real pilot and burns down the defects and gaps that the pilot
and the 016 gates surface. It is a hardening sprint with an explicit, measurable exit gate —
not a feature sprint.

## Scope

**In**:
- **Pilot**: import ≥ 1 real internal Jira Cloud project (017), run the team on TrackForge for
  the sprint, collect a gap log (what they had to leave TrackForge for).
- **Defect burn-down**: all P0/P1 defects from `docs/hardening-backlog.md`, pilot gap log
  items that are bugs (not features), and any 016 perf-budget regressions.
- **Parity audit**: `apps/mcp/eval/compat.ts` matrix re-verified against the official Jira REST
  docs for every endpoint marked `full`; mismatches fixed or downgraded with a documented note.
- **Security review**: threat-model entries for 014–019 verified; leak test (every read
  endpoint as an unauthorized user and as a token outside its project allow-list).
- **Frontend**: Playwright journeys for the M1 flows (import → board → backlog → issue edit
  with CFs → attach → release); frontend unit coverage for components added in 014–019.
- **Docs**: admin guide (install, Redis, backups via `pg_dump`, migration), user guide basics.

**Out**: new features — any feature request from the pilot goes into wave-2 refinement, not
this sprint.

## Exit gate (all must hold to declare M1 done)

| # | Criterion | Evidence | Status |
|---|---|---|---|
| G1 | Pilot team completed a full sprint in TrackForge | Sprint closed in TF; burndown from 013 | **Waived** — needs a real team + real Jira project; owner: pilot coordinator, target: wave-2 kickoff |
| G2 | Import validation report has zero unexplained diffs | 017 report attached | **Waived** — blocked on G1's real import; owner: pilot coordinator, target: wave-2 kickoff |
| G3 | No open P0/P1 defects; P2 count trending down | hardening backlog | **Met** — zero open P0/P1; new findings logged as H2-a/H2-b |
| G4 | 016 perf budgets green on the 50k fixture | CI perf run | **Met** — `seed:perf` + `perf:check` in CI |
| G5 | Leak test green (permissions + token scope) | `tests/integration/leak.test.ts` 7/7 | **Met** — found + fixed real leaks (boards/sprints/components/versions had no allow-list checks) |
| G6 | `compat.ts` `full` rows verified against Jira docs | audit checklist | **Met** — audited; `/rest/api/2/workflow` downgraded to partial (names-only response) |
| G7 | Agent evals for 014–019 pass | MCP eval run | **Met** — `pnpm --filter trackforge-mcp eval` in CI |
| G8 | Pilot gap log triaged into wave-2 epics with value scores | roadmap §2 updated | **Waived** — no pilot, no gap log; owner: pilot coordinator, target: wave-2 kickoff |

If a gate fails, the sprint extends with defect work only, or the failing item is explicitly
waived in roadmap §1 with a reason. No feature work starts until the gate is decided.

## Functional requirements

- **FR-001**: No new endpoints or entities except fixes.
- **FR-002**: Every waived gate item MUST be recorded with owner and target sprint.
- **FR-003**: Wave-2 epics (021–025) MUST be re-prioritized using the pilot gap log before their `/speckit.specify` step.

## Success criteria

- **SC-001**: G1–G8 met or explicitly waived.
- **SC-002**: Pilot team's "had to go back to Jira for…" list is empty or fully mapped to scheduled epics.

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Roadmap §1 baseline updated with M1 status and pilot findings.

# 068 — Tasks

- [x] `CopilotThread`/`CopilotTurn` schema + migration 068 (FR-004, FR-011)
- [x] Answer channel on plan contract + prompts (FR-001, FR-002)
- [x] Full read results to Pass-N via `projectPayload`; `find_users` accountId
      (FR-003, FR-012)
- [x] Bounded read loop ≤3 rounds + identical-read dedupe (FR-005)
- [x] `threadId` plan param, turn persistence, verbatim entity extraction,
      ≤8-turn history in system role (FR-004)
- [x] `turnId` on execute → `writesApplied` + outcome (FR-006)
- [x] 6 new read tools + presenters (project summary, sprints, comments,
      changelog, versions, aggregate)
- [x] `POST /api/internal/search/aggregate` + `aggregateIssues` (FR-010)
- [x] Thread REST endpoints owner-only + OpenAPI paths (FR-010, FR-011)
- [x] Outcome enum `answer` (AI-native checklist)
- [x] MCP `search_aggregate` + eval check (FR-010)
- [x] `CopilotDock` — stacked turns, answers, clarify, Apply, history,
      minimize, reload resume, merge hydration (FR-007, FR-008)
- [x] `Ctrl+J` wiring, dock layout column, TopNav buttons (FR-007)
- [x] Palette re-scope: `paletteIntent`, Ask-Copilot row, `ai:` handoff (FR-009)
- [x] Shared `copilotSteps.tsx` extraction (FR-003 display contract)
- [x] `ai-workspace.test.ts` 9 integration tests; `ai.test.ts` 052 regression
      green (SC-001..SC-008 backend half)
- [x] `copilotdock.test.tsx` + `commandpalette.test.tsx` 11 unit tests
- [x] `docs/ai.md` updated
- [x] typecheck + lint clean; backend + frontend suites green
- [ ] Playwright e2e for dock↔IssueDrawer coexistence + keyboard flows
- [ ] `specs` generated via speckit (this folder hand-authored to match format)

# 052 — Tasks

- [x] dryRun on comment/bulk/issueLink/watchers/rank (FR-001)
- [x] Plan store + planId binding + TTL (FR-002)
- [x] StepDisplay presentation layer server-side (FR-003)
- [x] Structured clarify + palette option chips (FR-004)
- [x] Stop-on-failure + skipped + idempotency keys (FR-005)
- [x] Server-computed outcomes + clarified/failed counters (FR-006)
- [x] Planner grounding + two-pass read→write (FR-007)
- [x] New tools: whoami, nl_search, summarize_issue, draft_description, find_similar (FR-008)
- [x] Palette human rendering + friendly unconfigured + chip audit
- [x] AiSettingsPage outcome columns
- [x] Integration tests (dryRun matrix, binding, skipped, two-pass, display, clarify, grounding)
- [x] docs/ai.md — two-pass planner, grounding, plan store, display contract
- [x] docs/compatibility.md — new dryRun surfaces
- [x] `pnpm typecheck && pnpm lint` clean (0 errors / 0 warnings, both apps)
- [x] backend tests green — `ai.test.ts` 38/38; agent/issues/meta/sprint/board/automation 51/51
- [x] frontend unit tests — `commandpalette.test.tsx` 8/8 (display contract, Details, clarify
      options, destructive opt-in, results, warnings, unconfigured card, discard telemetry);
      full unit suite 71/71 (also refreshed stale automation/components mocks vs WIP refactor)
- [x] e2e — `sprint052.spec.js` 4/4 on live stack (palette surface, issue-context chips,
      bare-key nav, Esc); AI-dependent journeys covered at unit level (provider is live in dev)
- [x] MCP parity — `dry_run` arg on add_comment/link_issues/rank_issue/watch_issue/
      bulk_create_issues; deterministic eval checks added and passing live (5/5)
- [x] live smoke vs configured provider — plan wrote nothing, execute applied once,
      tampered/missing planId → 400

# 068 — Implementation plan

## Backend

- `prisma/schema.prisma` + migration `20261129000000_068_copilot_workspace` —
  `CopilotThread`, `CopilotTurn` (cascade on user/thread).
- `services/copilotService.ts`
  - TOOLKIT +6 reads (`get_project_summary`, `list_sprints`,
    `get_issue_comments`, `get_changelog`, `list_versions`, `aggregate_issues`);
    PRESENT fixes (`find_users` keeps `accountId`) + presenters for new tools.
  - Prompts: `SYSTEM` (answer + history rules), `SYSTEM_R` (continuation),
    `SYSTEM2` (finalization, answer required for info asks).
  - `planCopilot` — bounded loop (≤3 read rounds, dedupe identical reads),
    `answer` channel, `threadId` in → thread/turn persistence, entity
    extraction (`collectKeys`/`collectUsers`), `threadHistory` injection.
  - `executePlan` — `turnId` param records `writesApplied` + outcome.
  - `projectPayload` replaces `truncate` (FR-012); `runReadStep` helper;
    thread CRUD helpers (`listCopilotThreads`, `getCopilotThread`,
    `deleteCopilotThread`, `ensureThread`, `persistTurn`, `sweepThreads`).
- `services/searchService.ts` — `aggregateIssues` (compileJql →
  visibility-scoped count + group-by buckets over ≤5000-row projection).
- `routes/search.ts` — `searchInternalRouter` POST `/aggregate` (named export,
  co-located with the restored Jira `/search` router).
- `routes/ai.ts` — `threadId`/`turnId` zod params, `GET/DELETE /ai/threads`,
  outcome enum +`answer`.
- `lib/openapi.ts` — plan response shape, threads paths, aggregate path.
- `services/agentAction.ts` — `executePlan` call guarded for optional `planId`.

## MCP

- `apps/mcp/src/tools.ts` — `search_aggregate` beside `search_issues`.
- `apps/mcp/eval/run.ts` — deterministic count/bucket check after step 8.

## Frontend

- `api/client.ts` — `answer`/`threadId`/`turnId` on `CopilotPlan`, `turnId` on
  `executeCopilot`, thread types + `fetchCopilotThread(s)`,
  `deleteCopilotThread`.
- `components/copilotSteps.tsx` — StepRow/ResultRow/FieldRow/IssueRows/
  PLAN_STEP_LABEL extracted (shared palette ↔ dock).
- `components/CopilotDock.tsx` — persistent right rail: stacked turns,
  markdown answers, clarify chips + free-text, per-turn Apply, thread history
  picker, minimize rail, localStorage thread resume, once-per-thread merge
  hydration (live plan state never clobbered by refetch).
- `lib/copilotBus.ts` — `openCopilot(prompt?)` event.
- `lib/commands.ts` — `paletteIntent` (question-verbs / ≥5 tokens → copilot).
- `components/CommandPalette.tsx` — re-scoped: commands + issue-key jump +
  "Ask Copilot" handoff row (pinned first on copilot intent); copilot UI removed.
- `App.tsx` — `Ctrl+J` toggle, dock as layout column beside `<Outlet/>`.
- `components/TopNav.tsx` — sparkle → dock; `⌘K` glyph → palette.

## Tests

- `tests/integration/ai-workspace.test.ts` — answers, thread continuity +
  foreign-404, clarify-as-turn, execute→writesApplied, aggregate, trust boundary.
- `tests/integration/ai.test.ts` — pass-detection updated to `Read results`
  marker (continuation/finalization).
- `tests/unit/commandpalette.test.tsx` — rewritten for launcher scope.
- `tests/unit/copilotdock.test.tsx` — answer, multi-turn threadId, clarify,
  apply w/ turnId, persisted-thread restore.

## Docs

- `docs/ai.md` — answer channel, threads, bounded loop, dock, new tools.

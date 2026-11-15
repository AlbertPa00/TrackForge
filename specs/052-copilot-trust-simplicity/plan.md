# 052 — Implementation plan

## Backend

- `services/linkService.ts` — extract `planLink` (shared validation) →
  `previewLink` (dryRun twin of `createLink`).
- `routes/meta.ts` — `POST /issueLink?dryRun=true` → `previewLink`.
- `routes/issues.ts` — dryRun branches: `POST /issue/bulk` (per-item
  `previewCreateIssue` + per-item errors), `POST /:key/comment`
  (`{dryRun, comment{body,author}}` after existence+permission),
  `POST /:key/watchers` (`resolveWatchTarget`, returns target).
- `services/boardService.ts` — `previewRankIssues` (same guards as
  `rankIssues`, zero writes); `routes/sprints.ts` rank route dryRun branch.
- `services/copilotService.ts` — rework:
  - `StepDisplay` + `PRESENT` per-tool presenters (read/preview/exec kinds);
    raw payload kept in `preview`/`result` for Details only.
  - Plan store `Map<planId,{userId,steps,at}>` 10-min TTL; `loadPlan` +
    canonical args match binds execute to the previewed plan.
  - `groundingBlock` — whoami/projects/types/statuses/live transitions into
    the system prompt.
  - Two-pass planning: reads execute → trimmed results + draft writes →
    finalization call (bounded, writes-only adopted).
  - `callPlanner` one parse retry (mirrors NL→JQL); unknown tools →
    `warnings[]`, never silent.
  - `executePlan`: membership check, stop-on-failure (`skipped`), reads →
    skipped, `Idempotency-Key: copilot-{planId}-{index}` on POSTs,
    destructive → confirmToken flow.
  - New tools: `whoami`, `nl_search` (server-side JQL), `summarize_issue`,
    `draft_description`, `find_similar`.
- `routes/ai.ts` — `planId` required on execute; server-computed outcome
  (`accepted`/`edited`/`failed`/`discarded`); `clarified` recorded on clarify;
  outcome enum + usage aggregation extended.
- `lib/ai.ts` — `AiOutcome` gains `clarified` | `failed`.
- `lib/openapi.ts` — endpoint/contract descriptions updated.
- `services/agentAction.ts` — skipped steps are not failures (ask_agent).

## Frontend

- `api/client.ts` — `StepDisplay`, `CopilotStep.display`,
  `CopilotPlan.clarify {question,options[]}` + `warnings`,
  `CopilotResult.skipped/display`, outcome enum, `executeCopilot` planId required.
- `components/CommandPalette.tsx` — human-first cards (display.text, diff
  rows, issue links, markdown), Details disclosure for raw JSON, clarify
  option chips, plan warnings, skipped/done result rows, friendly
  AI-unconfigured card, chip audit, `discarded` outcome on Start over.
- `pages/AiSettingsPage.tsx` — outcomes table gains Clarified/Failed columns.

## Tests

`tests/integration/ai.test.ts` — 052 describe: dryRun matrix persistence,
plan-no-write + exact-once execute, planId binding + mutated-args 400,
stop-on-failure skipped, unknown-tool warnings, two-pass summarize→comment,
display presence, clarify options, grounding in system prompt.

# 067 — Implementation plan

## Backend

- `services/aiService.ts`
  - `rankSimilar(actor, vec, excludeIssueId?, opts?: {resolvedOnly?: boolean})`
    — when set, AND `resolutionId: {not: null}` into the `where`, select
    `id`, `projectId`, `resolution.name`; return them on the hit.
  - `suggestResolution(issueKey, actor)` — `issueForAi` anchor →
    already-resolved short-circuit → embedding (cached vector or `embed`) →
    resolved-only ranking → < 2 short-circuit → latest visible comment per hit
    (`filterByVisibility`, 600 chars) → `chat('resolution', …, {json:true})` →
    closed-set / basedOn validation → server-computed confidence.
  - `similarIssues` — add the anchor `aiEnabled` 400 (FR-008).
- `routes/ai.ts` — `POST /issues/:key/suggest-resolution` (`requireAi`,
  `withProgress(req,'resolution',…)`); outcome zod enum gains `resolution`.
- `lib/openapi.ts` — register the path next to `/issues/{key}/similar`;
  update the `/ai/outcome` description.
- `services/copilotService.ts` — `suggest_resolution` in TOOLS (write:false)
  + `PRESENT.suggest_resolution`.

## MCP

- `apps/mcp/src/tools.ts` — `suggest_resolution {issue_key}` beside
  `summarize_issue` (same `wtool` registration).
- `apps/mcp/eval/run.ts` — deterministic contract check.

## Frontend

- `api/client.ts` — `ResolutionInsight` type, `aiSuggestResolution(key)`,
  `'resolution'` in the `postAiOutcome` feature union.
- `components/TransitionScreenModal.tsx` — optional `initialResolution` prop
  seeding the resolution state when the transition opens.
- `components/IssueDetailView.tsx` (`AiPanel`) — button, card, Apply flow
  (own `useMutation` over `executeTransition` + `TransitionScreenModal`,
  `useIssueWrite` invalidation as in `StatusTransitionMenu`), outcomes.

## Tests

- `tests/integration/ai.test.ts` — `067` describe: SC-001..SC-005 with
  `mockProvider` (assert chat-call count and captured prompt).
- Frontend unit — `AiPanel` Apply paths and outcome calls (SC-006).

## Docs

- `docs/ai.md` — endpoint, closed-set rule, confidence formula.

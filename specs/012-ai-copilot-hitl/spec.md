# Sprint 012 spec — AI Copilot & Human-in-the-Loop

Source: `docs/sprints/012-ai-copilot-human-in-the-loop.md`. Status: **Done**.

## Delivered

| US | Deliverable |
|---|---|
| US1 | Provider-agnostic AI, off by default. `AiSettings` singleton (provider `openai`/`anthropic`, `baseUrl`, AES-256-GCM-encrypted `apiKey` derived from `SESSION_SECRET`, `chatModel`, `embeddingModel`, `promptLogging`, `dailyRequestLimit`, `monthlyTokenBudget`). OpenAI-compatible chat + embeddings; Anthropic Messages chat. `lib/ai.ts` returns `null`/`404` until `baseUrl`+`chatModel` are set. `PUT /api/internal/ai/settings`, `POST .../settings/test` (verifies connectivity + model names without persisting), `GET /ai/usage`, `GET /ai/prompts` (admin). `AiUsage` per-user daily request counters + global monthly token budget → `429` on exceed. `AiPromptLog` opt-in with token/secret redaction. `Project.aiEnabled` excludes a project from every AI path (retrieval, model context, copilot tools). `User.requireApproval` + `ApiToken.requireApproval` flags. |
| US2 | Approval mode for agent writes. `proposalGate` middleware intercepts gated principals on public `/rest/` write methods and parks the request as a `Proposal` (method, path, body, diff preview, rationale, channel, principal, token, issue/project linkage, 7-day expiry) → `202 { proposalId, status: "pending" }`. Previewable writes: issue create/update/assignee/transition/delete, each rendered as a field diff via dry-run through the real route stack. `proposalsService`: list/get (own proposals for tokens, all for admins), approve (re-validates + replays through full middleware via signed `x-trackforge-internal` actor with `bypassApproval` + `approvedById`), reject, bulk resolve. Tokens can never resolve proposals. Changelog records original agent as author + human `approvedBy`. `proposal_resolved` events + notifications; expiry job on the JobRunner. Internal `/api/internal/*` routes are not gated (they're app, not agent, surface). |
| US3 | Copilot plan → preview → confirm → execute. `POST /ai/plan` produces strict JSON steps over the agent toolkit (search/create/update/transition/comment/assign/label/link/delete/sprint ops) — every write step validated + diffed before execution. `POST /ai/execute` runs only explicitly confirmed step indexes, dispatching internally through the full route stack with `channel=copilot` (never direct DB writes); destructive deletes use dry-run confirm-token semantics. Cmd/Ctrl+K `CommandPalette`: instruction → plan step list with per-step checkboxes + preview diffs → confirm executes → results rendered inline. |
| US4 | NL → JQL. `POST /ai/jql` calls the provider for strict `{"jql":"…"}`, parses/validates with the real JQL engine, retries once with parser feedback, then errors. JqlEditor gains an ✨ toggle that swaps to a plain-language input; translated JQL fills the editor and runs immediately. |
| US5 | Issue intelligence. `POST /ai/issues/{key}/summary` (issue + comments → concise summary), `POST /ai/issues/draft` + `POST /ai/issues/{key}/draft` (Markdown descriptions), `POST /ai/issues/{key}/breakdown` (epic → sub-task suggestions). Issue detail aside "AI actions" panel (summarize / draft / break down / similar); create-issue dialog gets **Draft with AI**. |
| US6 | Similarity via `IssueEmbedding` (`Float[]` + app-code cosine — no pgvector dependency; documented lightweight path). `GET /ai/issues/{key}/similar`, `POST /ai/similar` (text → similar issues). Background embed job on the JobRunner; results respect project visibility, token allow-lists, `aiEnabled`. Create dialog shows "Possibly similar" as you type. |

## MCP

`get_proposal`, `list_my_proposals`, `find_similar_issues`, `summarize_issue`;
`rationale` argument on write tools stored on proposals when approval-gated;
`202` responses surfaced with proposal ids.

## Verification

- **20/20** Sprint 012 integration tests against a mock LLM server (provider
  calls, budgets, approvals lifecycle, copilot plan/execute, NL→JQL retry,
  issue intelligence, similarity, per-project exclusion).
- Full backend suite **345/345** across 16 files.
- All 3 packages typecheck clean; OpenAPI drift test green.
- Two real bugs found & fixed en route: `webhookInternalRouter.use(requireAdmin)`
  router-level shadow blocking every non-admin `/api/internal/*` request
  (pre-existing Sprint 011 bug); `truncate(JSON.stringify(undefined))` crash
  on 204 empty bodies during internal replay.

## Out of scope

pgvector similarity (platform sprint 016), streaming model responses, AI cost
dashboards, prompt templates per project, email/chat delivery of AI output.

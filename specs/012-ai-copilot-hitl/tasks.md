# Tasks — Sprint 012

- [x] T1 Schema: `AiSettings`, `AiUsage`, `AiPromptLog`, `Proposal`,
      `IssueEmbedding`, `Project.aiEnabled`, `User/ApiToken.requireApproval`,
      `ChangeHistory.approvedById` + migration (dev + test DBs)
- [x] T2 `lib/ai.ts` — OpenAI-compatible chat/embeddings + Anthropic Messages,
      key encryption, off-by-default, budgets/usage, prompt-log redaction
- [x] T3 `lib/internalRequest.ts` — signed internal actor dispatch
      (`bypassApproval`, `approvedById`, `channel=copilot`), 60s signatures
- [x] T4 `middleware/proposalGate` + `proposalsService` — park writes, diff
      previews via dry-run, approve=revalidate+replay, reject/bulk, expiry job,
      `proposal_resolved` events + notifications
- [x] T5 `copilotService` — agent toolkit, strict-JSON plan, per-step
      validation/preview, confirmed-only execution via internal dispatch,
      delete dry-run confirm-token semantics
- [x] T6 `aiService` — NL→JQL (parse+validate+one retry), summary, draft,
      breakdown, embeddings (`Float[]`+cosine), similarity queries with
      visibility/`aiEnabled` scoping
- [x] T7 Routes: `/api/internal/ai/*` (settings, test, usage, prompts, plan,
      execute, jql, summary/draft/breakdown/similar) + `/api/internal/proposals*`
      + embed/expiry jobs
- [x] T8 Token/user `requireApproval`, `Project.aiEnabled` wiring through
      validation + services
- [x] T9 OpenAPI paths for all Sprint 012 endpoints (drift test green)
- [x] T10 MCP: `get_proposal`, `list_my_proposals`, `find_similar_issues`,
      `summarize_issue`, `rationale` arg on write tools, 202 surfacing
- [x] T11 Frontend: `ApprovalsPage` inbox w/ diffs, `AiSettingsPage`,
      `CommandPalette` ⌘K plan→confirm→execute, TopNav badge + AI settings
      link, issue-detail AI actions panel, create-dialog similar+AI draft,
      JqlEditor NL mode
- [x] T12 Tests: `ai.test.ts` 20/20 (mock LLM server) — incl. changelog
      author/approver attribution, token read-own/no-resolve, copilot
      confirmed-only execution
- [x] T13 Bugfixes en route: `webhookInternalRouter` router-level
      `requireAdmin` shadow (Sprint 011 regression); `truncate(undefined)`
      on empty-body internal responses
- [x] T14 Docs: `docs/ai.md`, spec/plan/tasks, sprint doc → Done
- [ ] T15 Compat matrix + roadmap/data-model updates + full verification + commit

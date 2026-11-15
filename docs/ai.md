# AI Copilot & Human-in-the-Loop

TrackForge ships an **opt-in, off-by-default** AI layer. Nothing is enabled until an
administrator configures a provider — all AI endpoints return `404` until then.
No keys ever leave the server: API keys are stored AES-256-GCM encrypted (key
derived from `SESSION_SECRET`) and are never returned by any endpoint.

## Providers

| Provider | Chat | Embeddings | Speech | Notes |
|----------|------|------------|--------|-------|
| `openai` | ✅ | ✅ | ✅ | Any OpenAI-compatible endpoint (`/chat/completions`, `/embeddings`, `/audio/transcriptions`) — works with OpenAI, Azure, Ollama, LM Studio, vLLM, etc. |
| `anthropic` | ✅ | — | — | Anthropic Messages API (`/v1/messages`) |

Embeddings and speech recognition only work on OpenAI-compatible providers.
Similar-issue features are soft-disabled when `embeddingModel` is unset; the
copilot microphone is hidden when `speechModel` is unset.

## Configuration

Admin → **AI settings** (`/ai-settings`), or `PUT /api/internal/ai/settings`:

```json
{
  "provider": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-…",              // write-only; stored encrypted
  "chatModel": "gpt-4o-mini",
  "embeddingModel": "text-embedding-3-small",
  "speechModel": "whisper-1",
  "promptLogging": false,
  "dailyRequestLimit": 500,
  "monthlyTokenBudget": 5000000
}
```

`POST /api/internal/ai/settings/test` verifies connectivity and model names
without persisting anything.

### Usage limits

- **Per-user daily request cap** (`dailyRequestLimit`) — counted across chat +
  embedding calls, resets at UTC midnight.
- **Global monthly token budget** (`monthlyTokenBudget`) — summed prompt +
  completion tokens per calendar month.

Exceeding either returns `429` with a Jira-style error body. Current counters
are visible at `GET /api/internal/ai/usage`, which also sums `costUsd` —
provider-reported spend (e.g. OpenRouter `usage.cost`) across chat,
embeddings and transcriptions; `0` for providers that don't report it.

### Prompt logging

When `promptLogging` is on, every request is logged to `AiPromptLog` with
tokens/secrets redacted. View at `GET /api/internal/ai/prompts` (admin only).
Keep it off unless debugging — prompts may contain issue content.

### Per-project exclusion

Set **AI features → disabled** in Project Settings (`aiEnabled=false`) to exclude
a project from *all* AI paths: copilot tools, summaries, drafts, breakdowns,
and embedding/retrieval. Excluded projects are also filtered out of
similarity results and never sent to the provider.

## Features

### Copilot (ask → answer / plan → confirm → execute)

`POST /api/internal/ai/plan` turns a natural-language instruction into a turn:
an optional grounded markdown **answer**, a list of plan steps using the agent
toolkit (search/create/update/transition/comment/summarize/etc.), or a
clarifying question — any combination. Every write step is validated and
**previewed** before anything executes.

**Planning never writes.** Read steps run immediately; writes only ever run as
`?dryRun=true` previews through endpoints that honor it — the planner refuses
to dispatch non-previewable writes at all. The promise in the UI ("writes
never execute without your check") is an invariant, not a convention.

**Answers.** When the instruction asks for information the response carries
`answer` — markdown grounded only in instance context and data returned by
executed reads (issue keys cited verbatim). The pass that produces it sees the
**full structured read payloads** (projection-bounded), never the compact
8-row display clip — descriptions, comments, assignees and `accountId`s stay
visible to the model.

**Bounded read chaining (068).** Reads run in up to 3 rounds, each followed by
a continuation/finalization call (≤4 model calls per turn). Between rounds the
model may request more reads, emit final writes, answer, or clarify. Identical
read calls are deduplicated — a model that re-asks for the same data can't spin
the budget. The last allowed round is the write-only finalization prompt.

**Threads (068).** Every plan response carries `threadId` + `turnId` into a
`CopilotThread`/`CopilotTurn` pair — private per user, swept after 30 idle
days. Turns record the instruction, the answer, verbatim entity refs (issue
keys fetched, `accountId`s resolved, keys created, writes applied), and an
outcome (`answered|planned|clarified|applied|partial|discarded|failed`). The
next turn's system prompt includes a compact history (last 8 turns) so "assign
those three to me" resolves without re-asking. Follow-ups pass `threadId`;
`POST /ai/execute` accepts `turnId` and records applied writes back onto the
turn. Threads are owner-only: `GET/DELETE /api/internal/ai/threads[/{id}]` 404
for anyone else, and history rides the system role — it can never override
instructions. Turns are a **record, not authority**: execution still requires
the in-memory `planId`.

**Grounding.** The system prompt carries instance context — the caller's
identity ("me" resolves without asking), visible projects, issue types,
statuses, and live transitions for the issue on screen — plus a defaults
doctrine ("this" → context issue, one visible project → default, "close/done"
→ matching transition). Clarify is reserved for genuine ambiguity and returns
`{question, options[]}`; the palette renders options as one-click answers.

**Human display.** Every step carries a `display` summary —
`{text, fields[] (label/from/to), issues[] (key/summary/status), markdown}` —
computed per tool from the preview/result payload. The palette renders
sentences, diff rows, issue links and markdown; raw JSON lives behind a
Details disclosure only.

**Bound execution.** `POST /api/internal/ai/execute` requires the `planId`
minted by `/ai/plan` (in-memory store, 10-min TTL); submitted steps must
deep-match the stored plan — mutated args or a foreign planId → 400.
Execution dispatches internally through the **full middleware/route stack**
(`x-trackforge-internal` signed, `channel=copilot`) — never direct DB
writes — so workflows, validators, events, and audit all apply. POST writes
carry `Idempotency-Key: copilot-{planId}-{index}` (double-Apply safe); the
first failed write stops the plan (later steps report `skipped`). Deletes
require the same dry-run confirm-token handshake as the public API.

UI: press **Ctrl+J / ⌘J** to open the Copilot dock — a persistent right rail
that keeps the thread visible while you navigate boards, backlogs and issues.
**⌘K / Ctrl+K** is the deterministic command palette; natural-language input
there offers an "Ask Copilot" row that hands off into the dock. The read
toolkit also covers `get_project_summary`, `list_sprints`,
`get_issue_comments`, `get_changelog`, `list_versions` and `aggregate_issues`
(backed by `POST /api/internal/search/aggregate`, exposed to MCP as
`search_aggregate`).

**Voice input.** Setting `speechModel` (e.g. `whisper-1`, or `faster-whisper`
on a local server) enables a microphone button in the Copilot dock — unset,
the button isn't rendered at all. While dictating, the browser rotates the
MediaRecorder every ~5s and each complete audio chunk is posted as multipart
to `POST /api/internal/ai/transcribe` (serially, in speech order), which
proxies it to the provider's `/audio/transcriptions` endpoint — words stream
into the draft as you speak; Esc discards the streamed span. Nothing is stored
server-side. The endpoint requests `verbose_json` and returns
`{text, audioSeconds, costUsd}`; `costUsd` is the provider-reported spend
(OpenRouter `usage.cost`, 0 when unreported) and is also accumulated on
`AiUsage.costUsd`, surfaced in the Usage card in AI settings. The transcript
lands in the draft at the cursor, still human-editable before sending.
`GET /api/internal/ai/capabilities` returns `{configured, embeddings, speech}`
to any authenticated user so the UI knows which AI affordances to render.

### Human-in-the-loop approvals

Any user or PAT can be flagged `requireApproval` (user admin or token settings).
Writes they attempt on the public `/rest/api/2/*` surface are **parked** as
proposals instead of executing:

- `POST /issue`, `PUT /issue/{key}`, `PUT /issue/{key}/assignee`,
  `POST /issue/{key}/transitions`, `DELETE /issue/{key}`
- Response is `202 { proposalId, status: "pending" }` with a rendered diff
  preview.
- Humans (session users) review at **Approvals** (`/approvals`, badge in the
  nav) or via `GET /api/internal/proposals`. Approving **re-validates** the
  request against current state and replays it through the normal route stack;
  the changelog records the original agent as author *and* the human in
  `approvedBy`.
- Proposing tokens can read their own proposals but **cannot approve/reject** —
  no self-approval. Proposals expire after 7 days; resolution emits
  `proposal_resolved` events + notifications.
- MCP agents get the same flow via `list_my_proposals` / `get_proposal`, and can
  attach a `rationale` argument to write tools — it lands on the proposal.

### Natural language → JQL

`POST /api/internal/ai/jql { "text": "my open bugs updated this week" }` →
`{ "jql": "assignee = currentUser() AND statusCategory != Done AND updated >= -1w" }`.

The result is parsed+validated by the real JQL engine; a malformed first attempt
is retried once with parser feedback, then surfaced as an error. In the issue
navigator, click the ✨ button next to the JQL box to search in plain language.

### Issue intelligence

On every issue (AI-enabled projects): **Summarize**, **Draft description**,
**Break down** (epic → suggested sub-tasks), **Similar issues**, and
**Resolution insight**.

| Endpoint | Purpose |
|----------|---------|
| `POST /ai/issues/{key}/summary` | Concise summary of issue + comments |
| `POST /ai/issues/draft` | Draft a description from a summary (new issues) |
| `POST /ai/issues/{key}/draft` | Draft/improve description for an existing issue |
| `POST /ai/issues/{key}/breakdown` | Epic breakdown into sub-task suggestions |
| `GET  /ai/issues/{key}/similar` | Embedding-similar issues |
| `POST /ai/similar` | Similar issues for arbitrary text (duplicate check) |
| `POST /ai/issues/{key}/suggest-resolution` | Suggested resolution + likely cause from resolved similar issues |

**Resolution insight** never auto-runs — one click in the issue AI section
spends one model call. Evidence is the top semantic-similar issues that are
actually resolved (`resolution` set); fewer than two → an honest
`{resolution: null, reason}` instead of a guess, and already-resolved issues
short-circuit before any provider call. The suggested resolution is picked
only from resolution names present in the evidence, confidence is computed
server-side from score-weighted evidence share, and `basedOn` links the
source issues. **Apply** executes a real workflow transition (screens and
validators intact, suggested resolution preselected) — never a direct field
write. Outcomes (`accepted` / `edited` / `discarded`) feed the AI settings
trust metrics under the `resolution` feature.

The create-issue dialog runs the text-similarity check as you type the summary
("Possibly similar") and offers a **Draft with AI** button.

### Embeddings

Vectors are stored as `Float[]` on `IssueEmbedding`; cosine similarity is
computed in application code (the lightweight path — no pgvector dependency).
A background job embeds issues that lack vectors; updates re-embed lazily.
Results always respect project visibility, token allow-lists, and `aiEnabled`.

## MCP tools

`get_proposal`, `list_my_proposals`, `find_similar_issues`, `summarize_issue`,
`suggest_resolution` —
plus a `rationale` argument on write tools that is stored on proposals when an
agent is in approval mode.

## Security notes

- AI off by default; every feature endpoint 404s until configured.
- API keys encrypted at rest, write-only over the API.
- All AI retrieval respects project visibility + token allow-lists.
- Copilot writes traverse the normal route stack — identical validation,
  workflow, and audit behavior as a human write.
- Approvals require a human session principal; tokens can never self-approve.

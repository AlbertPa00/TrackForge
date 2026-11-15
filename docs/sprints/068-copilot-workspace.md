# Sprint 068 — Copilot Workspace: answers, threads & a place to work

| | |
|---|---|
| **Status** | Implemented — dock + threads + answer channel + bounded read loop landed; e2e deferred to next hardening pass |
| **Milestone** | Post-GA |
| **Theme** | Turn the copilot from a one-shot plan compiler into a persistent workbench — it answers questions with real data, remembers the work so far, and stops fighting the app for screen space |
| **Depends on** | 052 (plan-confirm invariants), 057 (idempotent writes), 058 (issue drawer, unified palette, project summary), 047 (guidance, SSE progress, outcome telemetry) |
| **Unblocks** | Actual non-technical-user copilot usage; answer-driven triage; a sane path to delegated copilot sessions later |
| **Spec-kit folder** | `specs/068-copilot-workspace/` |

> **Origin**: field review — "the copilot doesn't answer data questions and keeps no
> space or context between steps." Root cause is architectural, not model quality:
> (1) the planner contract has **no answer field** — Pass 2 reads fetched data and is
> instructed to reply `{"plan":[]}` for information-only requests, leaving raw step
> cards and a disabled "Nothing to apply" button;
> (2) the read-results pipe **strips payloads** — `display.issues` (8 rows of
> `{key,summary,status}`) replaces `s.result` for `search_issues`, `get_issue`,
> `find_users`, so Pass 2 never sees descriptions, comments, assignees, or
> `accountId`s;
> (3) **every interaction boundary wipes state** — the API takes one instruction
> with no thread, the palette clears `plan`/`results` on the first keystroke of a
> follow-up, and the modal unmounts on Esc, link clicks, or Done;
> (4) deterministic local commands **hijack natural language** — `matchCommands`
> substring-matches "find issues"/"list sprints" to navigation and runs on Enter
> unless prefixed `ai:`.

## Goal

- **The copilot answers.** Read-only instructions return a markdown `answer`
  synthesized from executed read results — with issue-key citations and evidence
  cards — instead of an empty plan and a dead footer.
- **The workbench persists.** Copilot lives in a dockable right rail that
  survives navigation, `Escape`, issue clicks and reloads; `Ctrl+K` goes back to
  being a fast, deterministic launcher.
- **Context carries forward.** A `CopilotThread` stores each turn's entities
  (keys fetched, users resolved, issues created, writes applied); follow-ups
  like "assign the oldest three to me" resolve against real prior data.
- **Reads can chain.** The fixed two-pass cap becomes a bounded loop (≤3 read
  rounds, ≤5 LLM calls/turn) so "why can't TF-12 move to Done" can run
  `get_issue` *then* `get_transitions`.
- **Nothing else changes about writes.** Every mutation still previews via
  `dryRun`, stays bound to a stored `planId`, executes through the route stack
  with `channel=copilot` and per-step idempotency. This sprint adds a mouth and
  a memory — it does not loosen a single write invariant.

## Diagnosis ledger (what this sprint fixes)

| # | Defect | Evidence |
|---|---|---|
| D1 | No answer channel — Pass 2 reads results then must reply `{"plan":[]}`; UI shows step cards + "Nothing to apply" | `copilotService.ts` SYSTEM2 prompt; `PlanResult` shape; `CommandPalette.tsx` Apply footer |
| D2 | Read-results starvation — `result` replaced by `display.issues` (≤8 rows, `{key,summary,status}`); `get_issue` loses description/comments/assignee; `find_users` drops `accountId` when `emailAddress` exists | `copilotService.ts` readResults mapper; `PRESENT.find_users`/`get_issue`/`issueRows` |
| D3 | Hard two-pass wall — Pass-2 read requests skipped with a warning; multi-hop questions impossible | `copilotService.ts` "two-pass limit" warning |
| D4 | Stateless API + stateless UI — no `threadId`/history in `/ai/plan` schema; `onChange` does `setPlan(null); setResults(null)`; `useEffect([open])` resets everything | `routes/ai.ts` planSchema; `CommandPalette.tsx` input onChange + open effect |
| D5 | Local-command hijack — substring `matchCommands` intercepts NL input on Enter; "find issues" navigates to the navigator instead of asking the copilot | `lib/commands.ts` matchCommands scoring; `CommandPalette.tsx` Enter handler ordering |
| D6 | Modal fights the workspace — 640px backdrop modal covers the board; issue links inside cards close it; no multi-line input; post-execute only offers "Done" | `CommandPalette.tsx` Modal + `<input>` + results footer |
| D7 | Double-encoded Details — `truncate()` returns a stringified fragment that gets `JSON.stringify`'d again into an escaped blob | `copilotService.ts` truncate(); `CommandPalette.tsx` Details `<pre>` |
| D8 | Blind spots in the read toolkit — 13 reads vs ~140 MCP tools; no sprints, comments, changelog, versions, project rollup, or aggregation | `copilotService.ts` TOOLKIT vs `apps/mcp/src/tools.ts` |

## Scope

**In**: `answer` field on the plan contract end-to-end; read-results pipe fix
(structured `result` preserved for the model, `display` preserved for humans);
`CopilotThread`/`CopilotTurn` persistence with history assembly; bounded read
loop (≤3 read rounds); clarify-as-turn with free-text answers; new read tools
(`get_project_summary`, `list_sprints`, `get_issue_comments`, `get_changelog`,
`list_versions`, `aggregate_issues`); Copilot dock component (right rail,
context pills, multi-line composer, turn stack, inline Apply); `Ctrl+K`
re-scoped to commands + explicit copilot handoff; `Ctrl+J`/nav-button toggle;
thread list/get/delete endpoints; outcome telemetry extension; Details
double-encode fix; routing tests.

**Out**: native `tool_use`/`tools` protocol (JSON contract stays — same
provider-agnostic surface as today); streaming token-by-token answers;
`AgentSession` unification (deliberate — sessions model *delegated agent work*,
the dock models *interactive human work*); answer quality ratings; copilot
for admin operations; mobile drawer layout; MCP exposure of threads (agents
run their own loop — documented decision); multi-user shared threads.

## User stories

### US1 — The copilot answers data questions (P0, D1/D2/D7)

As a user, when I ask a question about my data, I get a readable answer grounded
in what the copilot actually fetched — never a bare plan shell.

1. **Given** "which issues are unassigned in TF?", **When** the plan resolves,
   **Then** the response carries `answer` (markdown citing real keys like
   `TF-14, TF-19 …`) built from the executed `search_issues` result, `steps`
   show the read evidence, and **no Apply footer renders**.
2. **Given** "what is TF-12 about and who reported it?", **When** `get_issue`
   ran, **Then** the answer can reference description, reporter, assignee,
   priority and comments — the model saw the full result, not a 3-field row.
3. **Given** "how many bugs are open per assignee?", **When** planning, **Then**
   `aggregate_issues` returns real counts by bucket and the answer lists them.
4. **Given** a Details disclosure on a read card, **When** the payload exceeded
   the cap, **Then** it renders as formatted JSON (truncated projection), never
   an escaped string.
5. **Given** an answer, **When** the model asserts facts, **Then** grounding
   requires citations to entities present in read results — the prompt contract
   states answers may only reference data the tools returned or the grounding
   block provided.

### US2 — The workbench has a home (P0, D4/D6)

As a triager, I keep the copilot open next to the board while I drill into what
it found.

1. **Given** `Ctrl+J` or the nav copilot button, **When** pressed, **Then** a
   ~400px right rail docks beside the page content (flex sibling of the router
   outlet, not a backdrop modal); pressing again collapses it; state persists
   across routes via the app shell + `sessionStorage`.
2. **Given** the dock open with turns rendered, **When** I click an issue link,
   press `Escape`, or navigate to `/browse/TF-12`, **Then** the dock, its turns
   and my draft text are untouched — only the explicit **New thread** action
   clears them.
3. **Given** the `IssueDrawer` opens on board/backlog while the dock is open,
   **When** both occupy the right edge, **Then** the drawer overlays above the
   dock and the dock compresses to its collapsed width; closing the drawer
   restores it.
4. **Given** a composer, **When** I type, paste multi-line text, or hit
   `Shift+Enter`, **Then** nothing above the composer changes or unmounts —
   turns are append-only.
5. **Given** writes applied in a turn, **When** execution finishes, **Then** the
   turn shows per-step results plus a **Continue** affordance that focuses the
   composer (replacing modal "Done").

### US3 — Threads keep the work so far (P0, D4)

As a user, follow-ups understand what "those", "the oldest three" and "it" mean.

1. **Given** turn 1 found issues `TF-14, TF-19, TF-23`, **When** turn 2 says
   "assign the oldest to me", **Then** the planner receives a compact history
   (≤8 turns: instruction, answer excerpt, entity refs, applied writes) and
   resolves the target keys without re-searching or asking.
2. **Given** turn 1 created `TF-42`, **When** turn 2 says "link it to TF-10",
   **Then** `it` resolves to `TF-42` — created keys are recorded on the turn and
   passed verbatim, never re-derived by the model.
3. **Given** a pending clarify, **When** I type a free-form answer (not a chip),
   **Then** it submits as a normal turn preserving the clarify question in
   history — no string concatenation into a single-line field.
4. **Given** a reload or a new tab on the same account, **When** I open the
   dock, **Then** `GET /ai/threads` lists prior threads and reopening one
   restores its turns and context (plans older than the 10-min `planId` TTL are
   marked "preview expired — re-plan").
5. **Given** 30 days idle on a thread, **When** the lazy sweep runs, **Then**
   the thread and its turns are removed (prompt content isn't retained
   indefinitely).

### US4 — Multi-hop reads within a budget (P1, D3/D8)

As a user, questions that need several lookups still land in one turn.

1. **Given** "why can't TF-12 move to Done and what blocks it?", **When**
   planned, **Then** round 1 runs `get_issue` (+links), round 2 runs
   `get_transitions`, and the answer explains the missing transition — ≤3 read
   rounds, ≤5 LLM calls per turn, each round surfaced via `ai.progress` SSE.
2. **Given** "what's in the active sprint and is anything stale?", **When**
   planned, **Then** `list_sprints` + `search_issues` answer it — tools exist
   for sprint/board data, comments, changelog, versions, project rollups.
3. **Given** a Pass-N reply requesting a write in a non-terminal round, **When**
   rounds remain, **Then** write drafts are held until the terminal pass —
   unchanged: previewed via `dryRun`, bound by `planId`, never dispatched early.
4. **Given** a Pass-N reply requesting a 4th read round, **When** the budget is
   exhausted, **Then** the terminal pass runs anyway with accumulated results
   and the turn notes the cap in `warnings` — never a silent drop, never a loop.

### US5 — `Ctrl+K` stops eating questions (P1, D5)

As a user, the launcher does instant commands and hands natural language to the
copilot — it never guesses between them wrong.

1. **Given** input starting with `>` or matching a short command verb (≤2-word
   prefix/exact match), **When** `Enter` is pressed, **Then** the local command
   runs exactly as today.
2. **Given** a question-form input (leading `what|who|why|how|which|show|find
   issues like|summarize|count|list my` or ≥4 tokens with no command match),
   **When** typed, **Then** the top row is **Ask Copilot →** which opens the
   dock and submits the prompt; commands still list below as secondary matches.
3. **Given** "find issues" typed without `ai:`, **When** `Enter` is pressed,
   **Then** the app does **not** navigate away mid-thought — the copilot
   handoff is the primary action for ambiguous input.
4. **Given** the copilot dock opens from a handoff, **When** it mounts,
   **Then** context pills reflect the current route (`TF-12`, `TF` project) —
   same grounding contract as before.

## Edge cases

- `planId` TTL (10 min, in-memory) is unchanged; threads live longer → turn UI
  marks expired plans and offers a one-click re-plan of the same steps.
- History references an issue since deleted/moved → grounding fetch fails
  closed; the entity is dropped from history with a note, never fabricated.
- Project `aiEnabled=false` → existing gates apply; answers must not leak
  excluded-project data (tools already enforce; test covers the answer path).
- Daily cap / 429 mid-thread → turn-level error card, thread preserved, retry
  reuses the same `threadId`.
- Composer accepts multi-line paste (logs, stack traces) — capped at 8k chars;
  pasted content is user text, system trust boundary unchanged.
- Answer-only turn on an AI-unconfigured instance → friendly setup card (same
  as palette today), dock still opens for local commands handoff copy.
- Model emits `answer` asserting entities absent from reads → prompt contract
  requires citation to returned keys; evidence cards render under the answer so
  humans can spot-check (same honesty doctrine as 067's `basedOn`).
- Thread cap: 50 most-recent threads per user listed; turns per thread capped
  at 200 (oldest compacted out of prompt, retained in DB).
- `delegate_issue` steps inside a copilot plan spawn real agent sessions as
  today — dock turns just record the delegation, no session merge.

## Functional requirements

- **FR-001**: `/ai/plan` MAY return `answer` (markdown) alongside `plan`,
  `clarify`, `warnings`. `plan:[]` + `answer` is a valid terminal response; the
  UI MUST NOT render an apply affordance for it.
- **FR-002**: Answers MUST be grounded — prompt contract restricts claims to
  executed read results and the grounding block; issue keys in answers link to
  `/browse/{key}` and evidence cards stay attached.
- **FR-003**: Pass-N MUST receive full structured read results (`result`),
  compacted by projection (field allow-list + row caps ≥50 for lists), never by
  the `display` rendering; `PRESENT.find_users` MUST include `accountId`.
- **FR-004**: `/ai/plan` accepts optional `threadId`; each accepted turn is
  persisted (`instruction`, `answer`, entity refs, applied writes, outcome).
  History assembly MUST inject entity refs verbatim (keys, `accountId`s,
  created keys), compacted to ≤8 turns.
- **FR-005**: Read chaining is bounded: ≤3 read rounds and ≤5 LLM calls per
  turn; reads after the terminal round are skipped with a `warnings` entry.
- **FR-006**: Write invariants are unchanged — dryRun-only previews,
  `planId`-bound execute with deep arg match, stop-on-failure, per-step
  `Idempotency-Key`, `channel=copilot`, destructive steps never pre-selected.
- **FR-007**: Dock state MUST NOT reset on input change, route change, `Esc`,
  or link navigation; only explicit **New thread** / **Delete thread** clears.
- **FR-008**: Clarify renders as a turn with option chips AND accepts free-text
  answers as follow-up turns preserving the pending question.
- **FR-009**: `Ctrl+K` local commands fire only on `>` prefix or unambiguous
  short-verb match; NL/question input routes to the copilot dock via an
  explicit handoff row. Zero behavior change to command execution itself.
- **FR-010**: Every new endpoint follows the contract checklist — zod schema,
  OpenAPI registration (drift test green), project scoping via
  `projectAllowed`/`canSeeIssueFull`, Jira error shape.
- **FR-011**: Threads are per-user, private, lazy-swept after 30 days idle;
  list returns ≤50 ordered by `updatedAt`.
- **FR-012**: `truncate()` no longer stringifies objects mid-payload — payload
  reduction happens via field projection before serialization; Details renders
  `JSON.stringify` of an object, never a pre-stringified fragment.

## API surface changes

| Method | Path | Change |
|---|---|---|
| POST | `/api/internal/ai/plan` | accepts `threadId`; response gains `answer`, `threadId`, `turnId` |
| GET | `/api/internal/ai/threads` | new — caller's threads (≤50, `updatedAt` desc) |
| GET | `/api/internal/ai/threads/{id}` | new — thread + turns (owner or admin only → 404 otherwise) |
| DELETE | `/api/internal/ai/threads/{id}` | new — owner or admin only |
| POST | `/api/internal/search/aggregate` | new — `{jql, groupBy?: status|assignee|priority|issuetype|project}` → `{total, buckets:[{value,count}]}` (visibility-scoped) |
| POST | `/api/internal/ai/outcome` | feature enum gains `'answer'` |
| — | `GET /rest/agile/1.0/board/{id}/sprint`, `GET /rest/api/2/issue/{key}/comment`, `GET /rest/api/2/project/{key}/versions`, `GET /api/internal/projects/{key}/summary` | no contract change — new toolkit resolvers dispatch to existing endpoints |

## Data model changes

```prisma
/// Copilot workbench thread — private to the user, lazy-swept after 30d idle.
model CopilotThread {
  id        String        @id @default(uuid())
  userId    String
  title     String?       // first instruction, truncated
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt

  user      User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  turns     CopilotTurn[]

  @@index([userId, updatedAt])
}

model CopilotTurn {
  id           String        @id @default(uuid())
  threadId     String
  index        Int
  instruction  String
  answer       String?       // markdown synthesis
  entities     Json?         // {issueKeys:[], users:[{accountId,displayName}], createdKeys:[]}
  writesApplied Json?        // [{tool, target, status}] — record, not authority
  outcome      String?       // applied | partial | discarded | answered | clarified | failed
  createdAt    DateTime      @default(now())

  thread       CopilotThread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@unique([threadId, index])
  @@index([threadId, createdAt])
}
```

The in-memory `planStore` (10-min TTL) is unchanged — it remains the execution
authority; `CopilotTurn` stores *what happened*, not permission to re-run it.

## MCP tools added

None — the dock is a human surface and external agents already drive the same
REST toolkit through their own loop. Threads are intentionally not exposed to
MCP this sprint (recorded decision: exposing a human's copilot history to PAT
principals needs a consent model — deferred to the delegated-sessions sprint).

## AI-native checklist

- [ ] `/ai/plan` answer path is a first-class contract: documented, drift-tested
  in OpenAPI, exercised by integration tests (A2).
- [ ] Thread endpoints enforce owner/admin scoping + Jira error shape (A7) —
  no new scoping gaps vs `docs/roadmap.md` pre-flight.
- [ ] New read tools dispatch via `internalRequest` with `channel=copilot` —
  identical middleware path as human REST calls, no shortcuts.
- [ ] Entity refs in history are verbatim structured data, never model-
  paraphrased — agents/humans can trust "the oldest three" resolution.
- [ ] Answer honesty is measurable: `outcome` gains `answer` feature; clarify
  and failed counters extend to the multi-round loop.

## Success criteria

- **SC-001**: "Which issues are unassigned in TF?" → markdown answer citing
  real keys + evidence card; `plan:[]`; **no Apply footer** (regression test +
  mocked model).
- **SC-002**: Turn 2 "assign the oldest three to me" resolves target keys from
  turn 1's entities and plans `assign_issue` ×3 — no re-search, no clarify.
- **SC-003**: Dock survives `/browse/TF-12` navigation, `Esc`, issue-link
  clicks, and full reload (thread restored from `GET /ai/threads/{id}`);
  typing in the composer never alters rendered turns.
- **SC-004**: Clarify accepts a typed free-form answer as a turn; chips still
  one-click; pending question preserved in history.
- **SC-005**: "Why can't TF-12 move to Done?" performs ≥2 read rounds
  (`get_issue` → `get_transitions`) and answers with the available
  transitions — verified via mocked multi-round planner test.
- **SC-006**: "find issues" in `Ctrl+K` no longer navigates; question-form
  inputs show **Ask Copilot →** as primary; `>assign me` still runs the local
  command (unit tests on the routing table + e2e).
- **SC-007**: 052/057 invariants regression-green — planning persists nothing
  across the write matrix; mutated args/foreign planId → 400; per-step
  idempotency holds.
- **SC-008**: `aggregate_issues` returns real counts by `status`/`assignee`
  under the caller's visibility scope; AI-disabled projects excluded (test).
- **SC-009**: Details disclosure renders formatted JSON for oversized payloads
  (no escaped-string blob) — unit test on the fixed `truncate`/`Details` pair.

## Risks

| Risk | Mitigation |
|---|---|
| History grows token cost per turn | ≤8-turn window, entity refs verbatim, answer excerpts ≤500 chars; measured against `AiUsage` before/after |
| Two right-edge surfaces (dock + `IssueDrawer`) | Spec'd z-order: drawer overlays, dock auto-collapses to 56px rail while drawer is open; a11y pass on focus order |
| Model answers beyond its evidence | Prompt contract requires key citations; evidence cards stay attached; `answer` claims untestable → keep `display` data visible by default |
| Multi-round latency | ≤3 rounds, SSE phases per round, reads run in parallel within a round where independent |
| Users lose quick commands under new routing | `>` prefix + unchanged registry; routing table unit-tested; suggestion chips unchanged |
| Thread store becomes a prompt-log backdoor | 30-day idle sweep; content is user-owned; `promptLogging` setting unchanged |

## Delivery plan (task slices)

1. **Backend contract** — `answer` + `threadId` on `/ai/plan`; read-results
   pipe fix (D2); `truncate`/projection fix (D7); expanded read toolkit;
   bounded read loop (D3); thread models + endpoints; tests.
2. **Frontend dock** — `CopilotDock` in `AppShell`, turn stack rendering
   (answer/step/result/clarify cards reusing `StepRow`/`ResultRow`/`FieldRow`),
   composer, context pills, `Ctrl+J`, `IssueDrawer` coexistence, session
   persistence.
3. **Palette re-scope** — routing table + handoff row in `CommandPalette`;
   remove copilot planning path from the modal (or thin-shim it into a dock
   submit).
4. **Docs & telemetry** — `docs/ai.md` (threads, answer contract, read loop),
   `docs/agents.md` note (dock ≠ agent session), outcome enum, compatibility
   note that nothing in the Jira surface changed.

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `docs/ai.md` documents the answer contract, thread model, bounded read
  loop, and the dock surface; `docs/agents.md` clarifies copilot threads are
  interactive-human scope, distinct from `AgentSession`.
- [ ] `pnpm typecheck && pnpm lint` clean; backend integration tests green —
  new `ai-workspace` suite covering SC-001/002/004/005/007/008 plus the 052/057
  regressions.
- [ ] Frontend coverage — unit tests for the routing table, turn-stack
  rendering, clarify free-text, Details JSON fix; e2e for dock persistence
  across navigation and the `Ctrl+K` handoff.
- [ ] Live smoke against the configured provider: two-turn flow
  ("find stale issues in TF" → "assign the three oldest to me"), multi-hop
  answer ("why can't X transition"), thread resume after reload, plan-expiry
  re-plan affordance.

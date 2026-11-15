# Sprint 047 — Agent Experience Polish

| | |
|---|---|
| **Status** | Epic (core shipped, green) — delegate field + sessions/questions + autonomy policy + approve-with-edits + guidance + MCP tools + issue-page UX + SSE-driven refresh + delegator notifications + `ai.progress` streaming + outcome telemetry; full backend regression green (743/745). Open: telemetry dashboards, mention/rule-spawned session triggers, external-agent e2e eval |
| **Milestone** | Post-GA (after 046) |
| **Theme** | Agent-native UX — the delegate/session/guidance triangle (Linear-proven, LangChain-ambient), on machinery that already exists |
| **Depends on** | 012 (copilot, proposals, embeddings — shipped), 011 (event stream), 022 (actions menu, assignee UI), 023 (bulk ops), 029 (notifications), 034 (automation + `ask_agent`) |
| **Unblocks** | External agents working inside TrackForge as reviewable first-class teammates |
| **Spec-kit folder** | `specs/047-agent-experience-polish/` |

> **Origin**: agentic-UX research (Linear Agent Interaction SDK, LangChain ambient agents,
> background-agent landscape). The finding: the model is a commodity — the harness
> (governance, context, reviewability) is the product. 012 shipped the review layer
> (proposals); this sprint ships the *presence* layer: agents visible, addressable,
> correctable teammates. Everything here rides existing machinery — no new infrastructure.

## Goal

- **Delegate, not assign** (Linear's refinement over Rovo): an agent works the issue while a
  human keeps ownership. `Issue.delegateId` → agent account; the assignee stays accountable.
- **Agent sessions**: a lifecycle object per agent-task (delegated, mentioned, or rule-spawned)
  emitting visible activities (`thought`/`action`/`error`) as live status on the issue — the
  agent's work-in-progress is inspectable, not a black box.
- **Three interrupt modes** (LangChain ambient: notify / question / review): review = proposals
  (012, exists); **question** is new — an agent blocked mid-task asks the human and resumes
  with the answer; notify = existing notifications.
- **Autonomy slider** (Intuit/Karpathy): `requireApproval` graduates from boolean to policy —
  `always | destructiveOnly | never` per agent/project. A smooth onramp, not an on/off switch.
- **Agent guidance**: per-project `agentGuidance` text (CLAUDE.md-for-the-tracker) injected
  into copilot/`ask_agent`/session prompts — team conventions without per-run re-prompting.
- **Verification engineering**: AI outputs carry provenance (summaries cite comment links),
  proposals get approve-**with-edits**, telemetry records accept/edit/discard + time-to-approve.

## Scope

**In**: `delegate` field (registry field, JQL `delegate`/`delegatedTo`); delegate picker in the
assignee menu (agent accounts only, `app:assignable`-style opt-in flag on the user);
`AgentSession` + activities feed + status chip on issue; `AgentQuestion` (create → notify →
answer → delivered via event + `get_agent_question`); proposal approve-with-edits (edited args
re-validated, applied under the approver's authority); `approvalPolicy` enum superseding the
`requireApproval` boolean (migration: `true`→`always`, `false`→`never`); `Project.agentGuidance`
+ global guidance in AI settings; bulk "Delegate to agent" on 023's multi-select (parallel
sessions); palette suggestion chips (context-derived, kills the empty-box problem);
SSE-carried progress events for `/ai/plan` and issue-intelligence endpoints (reuse 011's
channel; buffered fallback); AI telemetry (accept/edit/discard counters on `AiUsage`,
time-to-approve on proposals).

**Out**: time-travel debugging of agent runs (034 run log + proposals cover inspection),
generative UI, deep-research mode, persistent chat threads (palette stays plan-confirm),
named internal agent personas / Studio-lite (`ask_agent` prompt templates cover v1),
cross-source AI search (recorded non-goal), `app:mentionable` mention-parsing of agent
comments (P3 — delegate is the high-value entry point).

---

## User stories

### US1 — Delegate & bulk-delegate (P1)

As a user, I want to hand an issue to an agent while keeping ownership so I stay accountable
and can follow its progress.

1. **Given** an agent account flagged assignable, **When** the assignee menu opens, **Then** agents appear in a separate "Agents" group; choosing one sets `fields.delegate` and keeps me assignee; the issue appears in my "Delegated by me" view and the agent's queue.
2. **Given** delegation, **When** it happens, **Then** an `agent_session.created` event fires (011 bus + webhook) carrying issue + context; the agent's writes arrive through normal auth/proposal rules — delegation grants no powers.
3. **Given** 20 issues multi-selected (023), **When** "Delegate to agent X", **Then** N sessions spawn in parallel with per-item results, as Linear's bulk delegation.
4. **Given** JQL, **When** `delegate = currentUser()` or `delegate is EMPTY`, **Then** the registry-backed field resolves like assignee.

### US2 — Agent sessions (P1)

As a user, I want to see what a delegated agent is doing — live, per step — so delegation
isn't a black box.

1. **Given** a running session, **When** the agent emits activities (`POST /agent-sessions/{id}/activities` — `{type: thought|action|error, text}`), **Then** the issue shows a status chip (working / needs-answer / done / failed) and the activity feed interleaves in Activity, attributed `channel` = agent.
2. **Given** a session, **When** it stalls (> configurable timeout), **Then** it flips to `blocked` and the delegator is notified.
3. **Given** session history, **When** viewing `/issues/{key}/sessions`, **Then** prior runs with their full activity trail are inspectable (A2 — "what did the agent do on TF-9" is answerable via API).

### US3 — Question interrupts (P1)

As an agent, I want to ask the human when I'm missing information instead of guessing.

1. **Given** a session needing input, **When** `POST /agent-questions {issueKey, sessionId, question, options?}`, **Then** the delegator/assignee is notified (011 bell + 029 email per scheme); the session pauses `blocked(needs-answer)`.
2. **Given** a question, **When** answered (comment reply or inbox answer), **Then** `agent_question.answered` fires and the agent picks it up via event/`get_agent_question` — same loop as `proposal_resolved` (012 parity).
3. **Given** an unanswered question past expiry, **When** it lapses, **Then** the session resolves `failed(question-expired)` — no silent hang.

### US4 — Autonomy slider + edit-approve (P1)

As an admin, I want graduated trust, not a boolean.

1. **Given** `approvalPolicy: destructiveOnly`, **When** the agent edits a field, **Then** it writes directly; when it deletes or runs a guarded transition, it parks as a proposal — a middle rung between `always` and `never`.
2. **Given** a pending proposal, **When** I approve **with edited args** (e.g. fix the target status), **Then** the edited body re-validates and applies; the diff view shows my edit, changelog records agent + approver + "applied with edits".
3. **Given** a policy change mid-flight, **When** re-evaluated per write, **Then** pending proposals keep the policy they were created under (documented).

### US5 — Guidance, suggestions, streaming, telemetry (P2)

1. **Given** `Project.agentGuidance` set, **When** copilot/`ask_agent`/sessions touch that project, **Then** the guidance text is prepended to the system context (per project, plus a global line in AI settings).
2. **Given** the palette on an issue page, **When** opened, **Then** context-derived suggestion chips appear ("Summarize", "Find similar", "Draft description") — no empty box.
3. **Given** `/ai/plan` or `/ai/issues/{key}/summary`, **When** running, **Then** progress streams over the 011 SSE channel (`ai.progress` events) with buffered fallback — no frozen spinner.
4. **Given** an AI output accepted/edited/discarded, **When** logged, **Then** `AiUsage` records the outcome per feature; proposals record time-to-approve — verification-cost metrics exist, not just token counts.

---

## Edge cases

- Agent account deleted/deactivated mid-session → open sessions resolve `failed`, delegate cleared, delegator notified.
- Delegate + `approvalPolicy: always` → every write still parks; delegation changes *triggering*, not *authorization*.
- Human edits the issue while agent works → agent's writes re-validate against current state (proposals already do); session activities continue, no conflict model needed.
- Question answered by someone other than the delegator → allowed (anyone with comment rights), recorded as the answer's author.
- `delegate` on issue move/clone → cleared (target project may exclude that agent's scope).

## Functional requirements

- **FR-001**: Delegation MUST NOT change permissions — it emits a trigger event; the agent acts under its own token/scopes/policy.
- **FR-002**: Every session activity and question MUST be attributable (A2) and appear in audit for sensitive ops.
- **FR-003**: `approvalPolicy` MUST be re-evaluated per write (revoking an author mid-run defangs it — 034's constraint).
- **FR-004**: Guidance MUST be context, never instruction override — injected issue content can't elevate it (prompt-injection suite extends to guidance text).
- **FR-005**: `delegate` MUST be a registry field (014) — `createmeta`/`editmeta`/JQL/`/field` for free, importer-mapped post-039.

## API surface (candidates)

| Method | Path | Notes |
|---|---|---|
| — | `fields.delegate` on `GET/PUT /issue` | Registry field; `createmeta` lists assignable agents |
| GET | `/api/internal/issues/{key}/sessions` · `/agent-sessions/{id}` | Inspect runs |
| POST | `/api/internal/agent-sessions/{id}/activities` | Agent emits thought/action/error |
| POST | `/api/internal/agent-questions` · `/{id}/answer` | Question interrupt |
| POST | `/api/internal/proposals/{id}/approve` | gains `{edits}` — approve-with-edits |
| PUT | `/api/internal/ai/settings` · `…/projects/{key}` | `globalGuidance` / `agentGuidance` |
| — | SSE `ai.progress`, `agent_session.*`, `agent_question.*` | 011 bus + webhooks + 029 email |

## Data model changes (candidates)

- `Issue.delegateId` (+ registry field `delegate`), `User.isAssignableAgent`.
- `AgentSession` (`id`, `issueId`, `agentUserId`, `trigger`, `status`, `activities Jsonb`, `startedAt`, `finishedAt?`) — Jsonb like `AutomationRun.steps`.
- `AgentQuestion` (`id`, `sessionId`, `issueId`, `question`, `options Jsonb?`, `answer?`, `answeredById?`, `status`, `expiresAt`).
- `ApiToken`/`User`: `approvalPolicy` enum — replaces `requireApproval` (data migration `true→always`, `false→never`).
- `Project.agentGuidance`, `AiSettings.globalGuidance`; `AiUsage` + `outcome`; `Proposal` + `editedBody`, `timeToApproveSec`.

## MCP tools added

`delegate_issue`, `list_agent_sessions`, `get_agent_session`, `emit_activity` (agents report
their own progress), `ask_user` + `get_agent_question` (the interrupt pair),
`approve_proposal` gains `edits`. All write tools unchanged — policy is enforced server-side.

## AI-native checklist

- [ ] Delegation/sessions/questions fully scriptable — an agent can be a teammate with zero UI (A1).
- [ ] Session trail answers "what did the agent do" via API (A2, A6).
- [ ] Suggestion chips + provenance citations measurably cut verify time (verification-cost metric recorded).
- [ ] Prompt-injection suite extended to `agentGuidance` and question answers.

## Success criteria

- **SC-001**: Delegate → session → activities → done, end-to-end with an external MCP agent, no UI-only step (Playwright + eval).
- **SC-002**: `ask_user` → question → human answers → agent resumes — full loop in API test.
- **SC-003**: `destructiveOnly` policy: normal write direct, delete parked — boundary test.
- **SC-004**: Approval-with-edits applies the *edited* args, re-validated, correctly attributed.

## Risks

| Risk | Mitigation |
|---|---|
| Sessions/questions add two entities of lifecycle bugs | Reuse `AutomationRun`/`Proposal` lifecycle patterns; states are enums + one resolver each |
| Delegation reads as permission grant | FR-001 + docs; UI labels "delegate" never "assign" |
| Guidance becomes prompt-injection vector | Guidance is system-context text, sanitization + injection suite (012 pattern) |
| Scope creep toward Studio/agent-builder | Hard Out-list; personas stay a 034 template string |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `docs/agents.md` documents delegation, sessions, interrupts, policies and guidance end-to-end.
- [ ] `requireApproval` → `approvalPolicy` migration is reversible; fixtures updated.

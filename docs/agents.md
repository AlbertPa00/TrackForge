# Agents in TrackForge

TrackForge treats agents as first-class, reviewable teammates — not a chat sidebar.
An agent is a user account (`type=agent`) that authenticates with API tokens and
drives the same REST/MCP surface a human does. Delegation grants no powers:
the agent sees and edits exactly what its token scopes + permissions allow.

## Concepts

| Concept | What it is |
|---|---|
| **Delegate** | `fields.delegate` on an issue — the agent account working it. Distinct from `assignee`: the human assignee stays accountable. JQL: `delegate`, `delegatedTo`, `delegate IS EMPTY`, `delegate = currentUser()`. |
| **Agent session** | A `running|needs-answer|blocked|done|failed` record spawned when an issue is delegated. Sessions hold an inspectable `thought|action|error` activity timeline and appear on the issue page under **Agent activity**. |
| **Agent question** | The "question" interrupt — the agent asks, the session pauses at `needs-answer`, the delegator is notified. Answering resumes the session and emits `agent_question.answered` (visible on the issue event stream). Expired questions fail the session. |
| **Approval policy** | Per-user / per-token autonomy: `always` (every write parks as a proposal), `destructiveOnly` (ordinary writes execute; DELETEs park), `never` (writes execute). The effective policy is the strictest of user+token; the legacy `requireApproval` flag floors the policy at `always` until it is dropped in a later release. |
| **Proposal** | A parked write — validated at capture, reviewed inline on the issue's **Pending approvals** panel (or in the `/approvals` batch inbox for multi-issue triage), replayed as the principal on approve. Approvers may edit the request body (`approve-with-edits`); edits are re-validated by the real route and attributed to the principal with `appliedWithEdits`. `timeToApproveSec` is recorded on resolution. |
| **Guidance** | Operator instructions injected into agent context: `AiSettings.globalGuidance` (admin → AI settings) prefixes every AI request's system prompt; `Project.agentGuidance` (project settings → Agent guidance) reaches the copilot planner for that project and is exposed to external agents in their session view (`guidance`). Guidance rides the system role — issue/user content can never override it. |

## Setting up an agent

1. **Create the account** — `POST /api/internal/users` (admin) with
   `type: "agent"`, `ownerId: <human>`, `isAssignableAgent: true`,
   `approvalPolicy: "never" | "destructiveOnly" | "always"`.
   Or via MCP `manage_users`.
2. **Issue a token** — agents can't session-login, so an admin mints their
   PAT via `POST /api/internal/users/{accountId}/tokens` with `scopes`,
   optional `projectKeys` allow-list and `approvalPolicy`. (`POST
   /api/internal/tokens` stays the self-service path for human accounts.)
3. **Delegate work** — set `fields.delegate = { name } | { accountId } | null`
   on issue create or update; the assignee is untouched and a session opens.

## Driving the loop (external agent, MCP)

```
delegate_issue          → session opens (status: running)
find_ready_issues       → list ready work (JQL: key in ready())
claim_issue             → atomically take the top ready issue + open a session
list_agent_sessions     → find your session id
emit_activity           → report thoughts/actions/errors; status=done closes
ask_user                → pause with a question (options supported)
get_agent_question      → poll for the answer, then resume
```

The same loop works over REST:

- `POST /api/internal/agent/claim` `{projectKey, jql?, agent?}` — atomic
  delegate + `trigger:'claim'` session (SKIP LOCKED; agents self-claim,
  admins claim on an agent's behalf via `agent:{accountId|name}`)
- `GET  /api/internal/issues/{key}/sessions`
- `GET  /api/internal/agent-sessions/{id}` (includes `guidance`)
- `POST /api/internal/agent-sessions/{id}/activities`
- `POST /api/internal/agent-questions`
- `GET  /api/internal/issues/{key}/agent-questions?status=open`
- `POST /api/internal/agent-questions/{id}/answer`

Every activity, question and resolution emits an `agent_session.*` /
`agent_question.*` domain event — the issue SSE stream and `resources/subscribe`
see them live.

## Autonomy in practice

- `never` — the agent writes like a human within its permissions.
- `destructiveOnly` — creates/updates execute immediately; issue/attachment/
  comment deletes park as proposals.
- `always` — every write on the `/rest/` surface returns `202 { proposalId }`.
- Approved-with-edits writes keep the agent as author; the approver is recorded
  (`approvedBy` in the changelog, `resolvedBy` on the proposal).

## Safety properties

- Sessions stall → `blocked`, questions lapse → `failed` (5-min sweep job,
  `AGENT_SESSION_STALE_MS`), so no silent hangs.
- Session endpoints only answer the agent, the delegator, or an admin.
- Proposals re-validate at replay — a stale or human-broken edit fails closed
  (`status: failed`) rather than applying.
- Guidance is operator-controlled: it lives in admin/project settings, arrives
  via the system role, and cannot be injected from issue content.

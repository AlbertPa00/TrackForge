# 071 — Agent town hall (spec)

Sprint doc: `docs/sprints/071-agent-town-hall.md`

## Problem

Hundreds of agents can each hold a delegated issue, but they cannot interact:
no shared floor for deliberation, no durable addressable mailbox, no mutual
exclusion on writes (duplicate work, lost updates, zombie drivers), no
operator brake short of revoking tokens. The town hall adds typed deliberation,
fenced leases, durable inboxes, stigmergic traces, context packs and fleet
pause — coordination as first-class API, not a chat channel.

## Contract (FRs, condensed from the sprint doc)

- **FR-001** `AgentSession` gains `role` (driver|reviewer|observer),
  `fenceToken`, `ttlSec`, `leaseExpiresAt`, `worktreeRef`, `handoff`;
  `Issue` gains `version` + `lastFenceToken`.
- **FR-002** `POST /api/internal/issues/{key}/lease` mints a driver lease
  atomically (one driver per issue; 409 while another is live). `heartbeat`
  renews and returns `{fenceToken, leaseExpiresAt, paused, unreadInbox}`;
  `release` records a structured handoff; `lease/break` is the human brake;
  `sweepExpiredLeases` closes lapsed drivers (status `expired`, issue
  re-pools).
- **FR-003** Writes carry `fenceToken`/`expectedVersion` (body fields on
  issue PUT + transition POST); a stale fence or version → `409
  FENCE_TOKEN_EXPIRED` / stale-version error. Agents may not write to an
  issue another agent drives without a token; humans are never fenced.
- **FR-004** `AgentInboxItem` — durable, cursor-paged, reason-tagged mailbox
  (`GET /api/internal/agent-inbox`, `POST .../ack`); fed by mentions,
  `[@role:x]` summons, peer questions, DAG unblocks, trace collisions,
  directives. Retention: 7d acked / 30d unacked.
- **FR-005** `TownHallChannel` (global or per-project) → `TownHallTopic`
  (`rfc|discovery|blocker|incident|standup`; `open|voting|decided|archived`)
  → `TownHallPost` (speech acts) + `TownHallStance` (zero-prose
  `endorse|object|abstain`; `object` requires a cited reason).
- **FR-006** Quorum = endorsements ≥ `quorumRequired` + zero open objections +
  every `requiredRoles` endorsed. `resolve` records the binding decision and
  may compile an Epic + `Blocks`-linked task DAG atomically; `?dryRun=true`
  previews without writing.
- **FR-007** Floor control: one post per agent per `agentCooldownSec` per
  topic unless @-mentioned; per-topic depth/size caps in the service.
- **FR-008** `AgentProfile` — role, skills, model, `maxConcurrentLeases`,
  presence (derived from heartbeats); `GET /api/internal/agents/roster`
  filters project/role/skill/status; `PUT /api/internal/agents/{id}/profile`
  self-or-admin.
- **FR-009** `StigmergicTrace` — declared file/symbol intents
  (`file_read|file_edit|symbol_edit|resource_lock`); write-kind collisions
  across live drivers return inline + ping the holder's inbox;
  `GET /api/internal/projects/{key}/traces` is the heatmap.
- **FR-010** `GET /api/internal/issues/{key}/context-pack?maxTokens=` packs
  issue core + version/fence + leases + transitions + handoffs + town-hall
  decisions + trace collisions + comments, priority-packed under the budget.
- **FR-011** Fleet pause — `PUT /api/internal/projects/{key}/pause`
  (lead/admin) and `PUT /api/internal/fleet/pause` (site admin) freeze agent
  writes with 423; reads, heartbeats and inbox acks stay open; humans never
  gated. `GET /api/internal/fleet/pause?project=` reports both scopes.
- **FR-012** `POST /api/internal/agent-questions/peer` — non-blocking consult
  targeted at `targetUserId` or `targetRole`; lands in the peer's inbox and
  `/agent-questions/mine`; answers wake the asker's inbox without pausing
  their session.
- **FR-013** All new surfaces follow the invariants: zod in
  `lib/validation.ts`-style schemas at the routes, OpenAPI registration,
  MCP parity (`town_hall`, `lease_work`, `agent_inbox`, `agent_roster`,
  `ask_peer`, `get_context_pack`), Jira error shape, actor attribution,
  project scoping, and proposal-gate coverage for REST-class mutations.
- **FR-014** SSE honors filtered subscriptions (project/issue-security/type
  filters); `town_hall.*`, `agent_trace.collision`, `dag.unblocked` events
  invalidate the mission-control caches.
- **FR-015** `/town-hall` (global) + `/projects/{key}/town-hall` — roster
  presence strip, live lease board with break control, channel/topic feed,
  threaded speech-act view, stances + quorum tally, resolve composer.

## Success criteria

SC-001..SC-007 in the sprint doc (lease exclusivity under concurrency,
decision→DAG atomicity, inbox durability, zombie fencing, pause semantics,
REST/MCP parity, no cross-scope leakage).

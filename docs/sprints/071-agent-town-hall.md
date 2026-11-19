# Sprint 071 — Agent Town Hall & Fleet Coordination

| | |
|---|---|
| **Status** | Proposed — ready for `/speckit.specify` |
| **Milestone** | Post-GA — Multi-Agent Fleet Wave |
| **Theme** | Turn TrackForge from a 1-human-to-1-agent ticket queue into the parliamentary Town Hall and fenced coordination plane where hundreds of agents discover peers, debate RFCs, compile task DAGs, and develop without collisions |
| **Depends on** | 011 (DomainEvent outbox + SSE), 009/031 (Workflows & TransitionRule), 034 (Automation loop guards), 047 (AgentSession, AgentQuestion, delegate), 063 (`claimReadyWork` SKIP LOCKED), 070 (PAT cache, Redis `tf:sse` bridge, MCP server pool) |
| **Unblocks** | 100–1,000 concurrent external coding/triage/review agents operating collaboratively on shared repositories; downstream sprints for Proof-Carrying CI Attestations (072) and Organizational Memory (073) |
| **Spec-kit folder** | `specs/071-agent-town-hall/` |

> **Origin**: Fleet-readiness audit post-070. Sprint 070 raised the HTTP/auth/SSE
> ceiling to ~1k concurrent agents, but the domain model remains strictly
> single-agent hub-and-spoke:
> (1) **No public square** — agents cannot deliberate, propose RFCs, or
> coordinate outside an existing `Issue`, and `Comment` is an unthreaded prose
> wall with no floor control;
> (2) **Agents are deaf to peers** — `notificationService.ts` hardcodes
> `type: 'human'`, `assertSessionActor` blocks peer inspection (`403`),
> `AgentQuestion` only targets humans, and `/events/stream` floods every socket
> with every project event;
> (3) **No zombie fencing or cross-issue collision sensing** —
> `sweepStaleSessions` marks stalled runs `blocked` without clearing
> `Issue.delegateId` or fencing late writes, `Issue` lacks `version`/`If-Match`
> optimistic concurrency, only one agent can attach to an issue (`delegateId`),
> and parallel worktrees cannot sense overlapping file edits;
> (4) **Self-certification** — an implementing agent can transition its own
> issue to `Done` with zero peer or human review.

## Goal

- **A parliamentary Town Hall, not a noisy chatroom.** Global and per-project
  channels host typed **Topics** (`rfc`, `discovery`, `blocker`, `incident`,
  `standup`) where agents and humans post threaded **Speech Acts** (`proposal`,
  `critique`, `evidence`, `question`, `answer`, `decision`), cast zero-prose
  **Stance Votes** (`endorse`, `object`, `abstain`), obey server-enforced
  **Floor Control**, and **compile resolved topics directly into Epic/Issue
  dependency DAGs**.
- **Agents become addressable, discoverable teammates.** `AgentProfile`
  publishes each agent's role, skills, concurrency limit, and live heartbeat
  presence. A bounded **Agent Inbox** (`AgentInboxItem`) + **filtered SSE**
  (`?filter=inbox` / `?channels=...`) delivers `@agent` mentions,
  `@role:<skill>` summons, peer questions, review requests, DAG unblocks, and
  file-collision alerts without firehose polling.
- **Zero-collision, fenced execution.** `Issue` gains `version` +
  `lastFenceToken` (`If-Match` / `X-TrackForge-Fence-Token` → `409 Conflict`
  with diff). `AgentSession` unifies session tracking with **fenced leases**
  (`role: driver | reviewer | observer`, `fenceToken`, `leaseExpiresAt`,
  `worktreeRef`, `handoff`), auto-repools expired `driver` leases, piggybacks
  interrupt signals on heartbeats, and tracks **Stigmergic File/Symbol Traces**
  across issues.
- **Peer review & fleet safety.** Workflow `TransitionRule` gains
  `separation_of_duties` (`actor != session driver`) and
  `town_hall_topic_decided`. Admins and project leads get a one-click **Fleet
  Pause** kill-switch (`Project.agentPaused` / global `SystemSetting`) that
  halts non-human writes immediately while preserving read/heartbeat
  visibility.
- **Zero LLM calls on the coordination hot path.** Every Town Hall post,
  stance tally, DAG compilation, lease claim, heartbeat, inbox pull, and trace
  collision check is 100% deterministic TypeScript + PostgreSQL (`<10ms` p95).

## Diagnosis ledger (what this sprint fixes)

| # | Defect | Evidence |
|---|---|---|
| D1 | No deliberation space above/across issues; `Comment` has no `parentId`, speech-act type, or consensus state | `prisma/schema.prisma` (`Comment`); `services/commentService.ts` |
| D2 | Agents receive zero notifications on `@mention`, assignment, or watch (`where: { type: 'human' }`) | `services/notificationService.ts` |
| D3 | `AgentQuestion` only targets human delegator/assignee; `assertSessionActor` 403s peer agents | `services/agentSessionService.ts` |
| D4 | SSE broadcasts all project events to every connected agent socket with no inbox/channel/type filter | `routes/events.ts`; `services/sseHub.ts` |
| D5 | No agent capability/skill registry or live presence (`online`/`busy`/`offline`) | `prisma/schema.prisma` (`User` has only `type` + `isAssignableAgent`) |
| D6 | Silent lost updates on concurrent `PUT /issue` and transitions (no `version` / `If-Match`) | `services/issueService.ts`; `prisma/schema.prisma` (`Issue`) |
| D7 | Stalled sessions flip to `blocked` but leave `Issue.delegateId` locked forever; zombie agents aren't fenced | `services/agentSessionService.ts` (`sweepStaleSessions`) |
| D8 | Single-agent bottleneck per issue (`Issue.delegateId` scalar; no concurrent `reviewer`/`observer` sessions) | `prisma/schema.prisma` (`Issue.delegateId`); `agentSessionService.claimReadyWork` |
| D9 | No cross-issue file/symbol intent traces — parallel worktrees collide at `git merge` time | Absent across codebase (`docs/research/01` unimplemented) |
| D10 | Implementing agent can self-transition its own issue to `Done`; no instance/project fleet pause switch | `services/workflowService.ts`; `middleware/auth.ts` |

## Scope

**In**:

- `AgentProfile` (skills, role, model, maxConcurrentLeases, presence via
  heartbeat) + `GET /api/internal/agent/roster`.
- `AgentInboxItem` durable mailbox (mentions, `@role:<skill>` summons, peer
  questions, review requests, blocker unblocks, trace collisions, human
  directives) + `POST /api/internal/agent/inbox/ack` + filtered SSE
  (`?filter=inbox`, `?channels=...`, `?types=...`).
- Peer-addressable `AgentQuestion` (`targetUserId?`, `targetRole?`) + relaxed
  read access on `AgentSession` (`BROWSE_PROJECTS` + issue security lets peers
  read sessions; writes remain actor/delegator/admin).
- Parliamentary Town Hall: `TownHallChannel` (global + project-scoped, seeded
  `#town-hall`, `#architecture`, `#blockers`, `#reviews` per project),
  `TownHallTopic` (`rfc | discovery | blocker | incident | standup`, status
  `open | voting | decided | archived`), `TownHallPost` (threaded `parentId`,
  mandatory `speechAct`, markdown + entity refs), `TownHallStance`
  (`endorse | object | abstain` + reason).
- Town Hall Floor Control (per-topic agent cooldown, max consecutive agent
  posts without new `evidence`/`critique`, duplicate-stance rejection, max
  thread depth/length) + `POST /api/internal/town-hall/topics/{id}/resolve`
  (locks topic, records `decisionSummary`, optionally compiles an Epic +
  child/blocker `Issue` DAG in one transaction).
- Optimistic concurrency (`Issue.version`, `ETag` header, `If-Match` /
  `expectedVersion` → `409` with `conflictingChanges`).
- Fenced `AgentSession` leases (`role: driver | reviewer | observer`,
  `fenceToken`, `leaseExpiresAt`, `heartbeatAt`, `worktreeRef`, `handoff`),
  partial unique index enforcing ≤1 open `driver` per issue,
  `POST /api/internal/agent-sessions/{id}/heartbeat` with piggybacked interrupt
  signals, `POST /api/internal/agent-sessions/{id}/release` requiring `handoff`
  when unresolved, and `sweepStaleSessions` upgrading to expire + clear
  `delegateId` + bump `lastFenceToken` when `repoolOnExpiry=true`.
- `StigmergicTrace` (`file_read | file_edit | symbol_edit | resource_lock`)
  bound to `AgentSession` + collision detection on deposit + project heatmap
  endpoint.
- Single-call deterministic `GET /api/internal/issues/{key}/context-pack?maxTokens=4000`
  (core + guidance + active leases/collisions + prior handoffs + linked Town
  Hall decisions + pinned/recent comments).
- Workflow `TransitionRule` validators: `separation_of_duties`
  (`actor.id != lastDriverAgentId`) and `town_hall_topic_decided`.
- Fleet safety: `Project.agentPaused` + global `agent.fleetPaused`
  `SystemSetting` enforced in `requireAuth` (`423 Locked` with `Retry-After` on
  agent mutations; heartbeats + reads still permitted).
- Frontend: `/town-hall` (instance) and `/projects/:key/town-hall` (project)
  pages + live Fleet Roster & File Heatmap drawer + Admin/Project Fleet Pause
  banner; issue detail page gains Lease/Fence badge, File Traces chips, Linked
  Town Hall Topics, and Multi-Role Session avatars.
- MCP: 4 D21-compliant composite tools (`town_hall`, `agent_inbox`,
  `lease_work`, `agent_roster`) + `get_context_pack`, plus multi-agent fleet
  scenario in `apps/mcp/eval/run.ts`.

**Out (explicitly deferred to 072+)**:

- Per-issue `Issue.blackboard` JSONB schema & Active Inference foraging gates
  (`072` — `Handoff` + Town Hall `evidence`/`decision` posts + `StigmergicTrace`
  deliver 80% of the value now with a simpler schema surface).
- Proof-carrying signed CI attestations & Stage-1 Red-Test SHA-256 locks
  (`072` — extends `038`/`051` webhooks).
- 3-tier `pgvector` organizational memory (`ProjectMemory`) & Nanopublication
  retraction cascades (`073`).
- Empirical Wilson-score reputation ledger, Contract-Net auction bidding, and
  external Google A2A federation (`074+`).
- LLM-generated thread summaries on the write path (all resolution summaries
  are caller-supplied or deterministic projections; optional Copilot summarize
  button reuses `012`).

---

## User stories

### US1 — Parliamentary Town Hall & Topic-to-DAG Compilation (P0, D1)

As a fleet of specialist agents and human leads, we need a structured place to
propose RFCs, challenge assumptions with evidence, vote, and compile decisions
into executable issues without chat stampedes.

1. **Given** a project `TF`, **When** created or migrated, **Then** default
   channels (`#town-hall`, `#architecture`, `#blockers`, `#reviews`) exist
   alongside instance-wide global channels; browsing honors `BROWSE_PROJECTS`
   and token `projectKeys`.
2. **Given** an agent opening a `TownHallTopic` (`kind: 'rfc'`, `title`,
   `body`, `quorumRequired: 2`, `requiredRoles: ['security','backend']`),
   **When** posted, **Then** a `town_hall.topic_created` event fires and agents
   matching `requiredRoles` receive a `role_summon` inbox item.
3. **Given** an open topic, **When** peers reply via
   `POST /topics/{id}/posts`, **Then** each post MUST declare `speechAct`
   (`proposal | critique | evidence | question | answer | synthesis`);
   attempting to post twice within the topic's `agentCooldownSec` (default
   `15s`) without an intervening `@mention` returns `429` with `retryAfterSec`
   (floor control).
4. **Given** an agent that agrees or objects without needing a long essay,
   **When** it calls `PUT /topics/{id}/stances`
   (`stance: 'endorse' | 'object' | 'abstain'`, `reason?`), **Then** its stance
   upserts (1 stance per actor per topic; `object` requires `reason`), and
   `quorumMet` flips `true` once endorsements ≥ `quorumRequired`, all
   `requiredRoles` have endorsed, and zero unresolved `object` stances remain.
5. **Given** a topic ready to settle, **When** an authorized resolver (project
   lead, admin, or designated moderator agent once `quorumMet=true`) calls
   `POST /topics/{id}/resolve` with
   `{ decisionSummary, compileDag?: { epic, tasks: [{ tempId, summary, issueType, roleHint?, targetFiles?, blockedByTempIds? }] } }`,
   **Then** in a single transaction the topic locks as `decided`, the Epic +
   child Issues + `Blocks` `IssueLink`s are created, `TownHallTopicIssue` links
   bind them, and `ready()` leaf tasks immediately enter the `claim` pool.

### US2 — Agent Roster, Presence & Durable Inbox (P0, D2/D3/D4/D5)

As an agent (or orchestrator), I want to discover which specialist peers are
online, summon them by `@name` or `@role:skill`, ask peer questions, and pull
only events relevant to me.

1. **Given** an agent account, **When** its `AgentProfile` is configured
   (`role: 'reviewer'`, `skills: ['prisma','security']`,
   `maxConcurrentLeases: 2`), **Then**
   `GET /api/internal/agent/roster?project=TF&skill=security&status=online`
   returns matching agents whose `lastHeartbeatAt` is within
   `AGENT_ONLINE_TTL_SEC` (default `120s`), plus their active lease count.
2. **Given** a comment or Town Hall post containing `[~accountId:<agentId>]`
   or `[@role:security]`, **When** committed, **Then** `AgentInboxItem` rows
   (`reason: 'mention' | 'role_summon'`) are written for the target agent (or
   up to `N=3` least-loaded online agents holding that skill, avoiding
   200-agent broadcast storms).
3. **Given** an agent blocked on domain knowledge mid-session, **When** it
   calls `POST /agent-questions` with `targetUserId` (a peer agent) or
   `targetRole: 'db-specialist'`, **Then** the peer receives an
   `agent_question` inbox item, can inspect the asker's `AgentSession`
   (`GET /agent-sessions/{id}` succeeds for any actor with `BROWSE_PROJECTS` +
   issue visibility), and answering unblocks the asker's session.
4. **Given** an agent runner connecting to
   `GET /api/internal/events/stream?filter=inbox` (or polling
   `GET /api/internal/agent/inbox?unreadOnly=true`), **When** unrelated project
   issues update, **Then** zero frames are sent to that socket; when an inbox
   item or subscribed channel/issue event occurs, it delivers in `<1s` and can
   be acknowledged via `POST /api/internal/agent/inbox/ack`.

### US3 — Fenced Leases, Optimistic Concurrency & Dead-Worker Re-pooling (P0, D6/D7/D8)

As a fleet operator, I want ironclad guarantees that two coding agents never
clobber the same issue, hung agents automatically lose their lock and get
fenced out, and reviewers can attach alongside drivers.

1. **Given** `GET /rest/api/2/issue/{key}`, **When** returned, **Then**
   `ETag: "v{version}"` and `fields.version` are present; mutating
   `PUT /issue/{key}` or `POST /transitions` with a stale `If-Match: "v3"`
   returns `409 Conflict` including `currentVersion` and the
   `conflictingChanges` changelog slice since `v3`.
2. **Given** `POST /api/internal/agent/claim` (or
   `POST /api/internal/issues/{key}/lease` with
   `role: 'driver' | 'reviewer' | 'observer'`, `ttlSec`, `worktreeRef`),
   **When** `role='driver'`, **Then** PostgreSQL atomically increments
   `Issue.lastFenceToken`, sets `AgentSession.fenceToken`, sets
   `leaseExpiresAt = NOW() + ttlSec`, enforces
   `activeDriverCount <= agentProfile.maxConcurrentLeases`, and mirrors
   `Issue.delegateId = agent.id`. Multiple `reviewer`/`observer` sessions MAY
   coexist on the same issue simultaneously.
3. **Given** an active `driver` lease (`fenceToken = 7`) on `TF-12`, **When** a
   stale/zombie agent attempts *any* mutation on `TF-12` carrying
   `X-TrackForge-Fence-Token: 6` (or another agent without `overrideLease`
   tries to edit guarded fields), **Then** the server rejects with `409
   FENCE_TOKEN_EXPIRED` (for stale fence) or `423 Locked` naming the current
   holder and `leaseExpiresAt` (for non-holder). Humans/admins may pass
   `overrideLease: true` ("Break Lease & Take Over"), bumping `lastFenceToken`
   to `8` and closing session `7` as `broken`.
4. **Given** an active session calling
   `POST /api/internal/agent-sessions/{id}/heartbeat`, **When** processed,
   **Then** `leaseExpiresAt` and `AgentProfile.lastHeartbeatAt` advance, and
   the response piggybacks
   `signals: { fleetPaused, issueVersion, unreadInboxCount, openQuestionsAnswered, fileCollisions[], humanDirectives[] }`.
5. **Given** a `driver` session whose `leaseExpiresAt < NOW()`, **When** the
   30-second lease reaper runs, **Then** the session transitions to `expired`,
   `Issue.delegateId` clears to `null` (immediately returning the issue to
   `ready()` / `claim`), `Issue.lastFenceToken` increments so the dead worker
   is fenced, its ephemeral `StigmergicTrace` rows delete, and
   `agent_session.expired` emits.
6. **Given** an agent releasing a `driver` lease via
   `POST /agent-sessions/{id}/release` while the issue is still unresolved,
   **When** called, **Then** a structured `handoff` (`outcome`, `summary`,
   `completedSteps[]`, `remainingSteps[]`, `doNotRepeat[]`, `worktreeRef?`) is
   REQUIRED (`400` if omitted).

### US4 — Stigmergic File/Symbol Traces & `context-pack` (P1, D9)

As a coding agent starting work, I want the entire relevant context in one
bounded call, and I want immediate warning if another agent in another
worktree is editing the same files.

1. **Given** an active session on `TF-101`, **When** the agent calls
   `PUT /api/internal/agent-sessions/{id}/traces` with
   `[{ kind: 'file_edit', target: 'apps/backend/src/services/issueService.ts', summary: 'Add version check' }]`,
   **Then** paths are POSIX-normalized (`\` → `/`, strip leading `./`),
   upserted with `expiresAt = session.leaseExpiresAt`, and checked against all
   other active sessions in the project.
2. **Given** `TF-102`'s active session already holds `file_edit` or
   `symbol_edit` on `apps/backend/src/services/issueService.ts`, **When**
   `TF-101` deposits its trace, **Then** the response returns
   `collisions: [{ issueKey: 'TF-102', agent, sessionId, kind, target, worktreeRef, leaseExpiresAt }]`,
   delivers a `trace_collision` `AgentInboxItem` to `TF-102`'s holder, and
   emits `agent_trace.collision`.
3. **Given** any issue `TF-101`, **When** an agent calls
   `GET /api/internal/issues/TF-101/context-pack?maxTokens=4000`, **Then** a
   single deterministic read returns priority-packed sections under budget:
   `P0` (issue core + version + active leases + allowed transitions +
   `agentGuidance`) → `P1` (prior session `handoff`s + `doNotRepeat[]`
   warnings) → `P2` (linked Town Hall `decision` summaries + active file
   traces/collisions) → `P3` (parent/children + `blocks`/`is blocked by` DAG)
   → `P4` (recent/mention comments, with elision count).

### US5 — Separation-of-Duties Review & Fleet Pause Switch (P1, D10)

As an engineering lead, I want coding agents to require independent review
before closing issues, and I need an instant brake if the fleet misbehaves.

1. **Given** a workflow transition (e.g. `In Review → Done`) configured with
   validator
   `{ type: 'separation_of_duties', config: { allowHumanOverride: true } }`,
   **When** the agent who drove the implementation (`lastDriverAgentId` or
   current `driver` session holder) calls `POST /issue/{key}/transitions`,
   **Then** it fails with `400` (`errors.transition: "Separation of duties:
   implementer @codex-1 cannot approve its own work; request review from
   another agent or human."`), including on `?dryRun=true`.
2. **Given** a reviewer agent (holding a `role='reviewer'` session) or a human
   user, **When** they execute that same transition, **Then**
   `separation_of_duties` passes.
3. **Given** an admin or project lead toggling
   `PUT /api/internal/projects/{key}/agent-pause { paused: true, reason: "DB migration in progress" }`
   (or global `/api/internal/admin/agent-fleet/pause`), **When** any
   `User(type='agent')` sends a mutating request (`POST|PUT|PATCH|DELETE`,
   except `/heartbeat` and `/inbox/ack`), **Then** middleware immediately
   returns `423 Locked` with
   `{ errorMessages: ["Agent writes are paused: DB migration in progress"], retryAfterSec: 60 }`.
   Human sessions and PATs continue unaffected.

### US6 — Town Hall & Fleet Mission Control UI (P1, D1/D5/D9/D10)

As a human supervisor (or observer), I want to watch the Town Hall, answer
escalations, inspect file-collision heatmaps, and steer or pause the fleet in
real time.

1. **Given** the top nav and project sidebar, **When** rendered, **Then**
   **Town Hall** links to `/town-hall` (global) and
   `/projects/:key/town-hall` (project), showing a 3-pane layout: Channel list
   (left), Topic stream + threaded Speech-Act view + Stance vote bar +
   "Resolve & Compile to Issues" modal (center), and Live Fleet Roster + File
   Collision Heatmap (right).
2. **Given** live SSE events (`town_hall.*`, `agent_session.*`,
   `agent_trace.*`), **When** agents post, vote, claim leases, or collide on
   files, **Then** TanStack Query caches invalidate/patch live without page
   reload.
3. **Given** an issue detail page (`/browse/TF-12`), **When** leased or linked
   to Town Hall topics, **Then** the sidebar shows active `driver`/`reviewer`
   session chips with live lease countdown + **"Break Lease"** button, active
   `StigmergicTrace` file badges (amber on collision), and linked Town Hall
   decision cards.

---

## Edge cases

- **Role summon storm**: `[@role:backend]` in a project with 400 online
  `backend` agents MUST NOT create 400 inbox items; the router selects up to
  `k` (default `3`, configurable per topic/channel) online, unpaused agents
  with free lease capacity ordered by fewest active leases +
  least-recently-summoned round-robin.
- **Agent deactivated or token revoked mid-lease**: `deactivateAgent()`
  (extending 047 + 070 `invalidateApiTokens`) immediately expires all open
  sessions, deletes active `StigmergicTrace`s, clears `Issue.delegateId`,
  increments `lastFenceToken`, and marks open `AgentInboxItem`s expired.
- **Unleased issues & standard Jira REST callers**: If an issue has **no**
  active `driver` lease and the caller omits `If-Match` /
  `X-TrackForge-Fence-Token`, standard Jira v2 `PUT /issue` behaves identically
  to 070 (zero breaking change for legacy scripts and Jira importers).
  `If-Match` is opt-in on REST, and automatically threaded by MCP `lease_work`
  / write tools when version is known.
- **Topic DAG cycle detection**: `POST /topics/{id}/resolve` with `compileDag`
  topologically sorts `blockedByTempIds` before writing; a cycle rejects with
  `400` (`errors.compileDag: "Cycle detected: t1 → t2 → t1"`) and writes
  nothing (`?dryRun=true` previews the planned keys, types, and edges).
- **Approval policy (`always` / `destructiveOnly`) interaction**: An agent
  with `approvalPolicy: 'always'` MAY post `proposal`/`question`/`critique` in
  Town Hall and send heartbeats directly, **but** calling
  `/topics/{id}/resolve` with `compileDag` or mutating `/rest/` issues still
  parks as a `Proposal` (047 FR-003 preserved: Town Hall participation never
  escalates write authority).
- **Prompt injection across peer agents**: Town Hall posts, `handoff`
  envelopes, and `AgentQuestion` bodies from peer agents are **untrusted
  data**, never system instructions. `context-pack` wraps peer/user fields in
  explicit `<untrusted_data actor="..." channel="...">` delimiters while
  keeping `Project.agentGuidance` isolated in `systemGuidance`.
- **Inbox retention**: Read/acked `AgentInboxItem` rows older than 7 days (and
  unread rows older than 30 days) are pruned in batches by `retention.prune` so
  high-frequency fleets never bloat Postgres.

---

## Functional requirements

- **FR-001**: Every Town Hall channel, topic, post, and stance MUST enforce
  `projectAllowed()` + `BROWSE_PROJECTS` (for project channels) or
  authenticated access (for global channels); unauthorized project channels
  return `404` (existence-hiding, matching `enforceIssueScope`).
- **FR-002**: `TownHallPost.speechAct` is required and validated against
  `proposal | critique | evidence | question | answer | synthesis | decision`.
  `decision` posts may only be written via `/topics/{id}/resolve`.
- **FR-003**: Floor control is enforced server-side inside a transaction:
  per-actor per-topic cooldown (`agentCooldownSec`, bypassed if directly
  `@mentioned` since the actor's last post), max posts per topic (`500`), and
  max nesting depth (`4`). Humans (`user.type === 'human'`) bypass
  `agentCooldownSec`.
- **FR-004**: `TownHallStance` enforces `@@unique([topicId, actorId])`;
  `stance = 'object'` requires non-empty `reason` (`10..2000` chars).
  Resolving a topic while unresolved `object` stances exist requires
  `overrideObjections: true` (restricted to human project lead / site admin,
  audited in `AuditEvent`).
- **FR-005**: Topic-to-DAG compilation (`compileDag`) MUST support
  `?dryRun=true` and `Idempotency-Key`, validate every planned issue through
  the project's `IssueTypeScheme` / `FieldConfiguration`, record `channel` +
  `actor` in `ChangeHistory`, and emit `DomainEvent`s in the same transaction.
- **FR-006**: `Issue.version` increments atomically (`version = version + 1`)
  on every issue field update and status transition. When `If-Match` (or
  `expectedVersion`) is supplied and mismatches, the server MUST abort before
  mutating and return `409` with
  `{ errorMessages, errors, currentVersion, conflictingChanges }`.
- **FR-007**: `AgentSession` enforces at most one open
  (`running | needs-answer | blocked`) `driver` session per `issueId` via a DB
  partial unique index. Acquiring a `driver` session increments
  `Issue.lastFenceToken` and sets `session.fenceToken = issue.lastFenceToken`.
- **FR-008**: When an open `driver` session exists on an issue:
  1. Writes by the `driver` carrying
     `X-TrackForge-Fence-Token < issue.lastFenceToken` fail with `409
     FENCE_TOKEN_EXPIRED`.
  2. Writes to guarded issue fields (`status`, `assignee`, `delegate`,
     `summary`, `description`, `sprint`, custom fields) by another
     `type='agent'` user fail with `423 Locked` (comments, watchers, `reviewer`
     sessions, and Town Hall links remain allowed).
  3. Humans/admins passing `overrideLease: true` break the lease atomically
     (`status = 'broken'`, `lastFenceToken + 1`, `AuditEvent` recorded).
- **FR-009**: Releasing an open `driver` session on an unresolved issue
  (`resolutionId IS NULL`) requires a valid `HandoffSchema` payload; expired
  leases reaped by `agent.leaseSweep` (every 30s under advisory lock)
  transition `running → expired`, clear `Issue.delegateId`, increment
  `lastFenceToken`, and cascade-delete `StigmergicTrace` rows.
- **FR-010**: `StigmergicTrace.target` MUST be normalized on write (`\` → `/`,
  collapse `..`, strip leading `./`, max 500 chars); batch upserts are capped
  at 100 targets per session.
- **FR-011**: `AgentInboxItem` creation in `dispatchEvents()` MUST batch via
  `prisma.agentInboxItem.createMany({ skipDuplicates: true })` (zero
  per-recipient N+1 queries).
- **FR-012**: `GET /api/internal/events/stream` accepts `?filter=inbox`,
  `?channels=c1,c2`, and `?types=t1,t2`, evaluated in-memory in `sseHub.ts`
  before `res.write` so idle agents receive zero irrelevant frames.
- **FR-013**: `TransitionRule` validator `separation_of_duties` rejects
  transitions when `actor.user.type === 'agent'` and `actor.user.id` matches
  either `issue.delegateId` or the most recent `driver`
  `AgentSession.agentUserId` on that issue.
- **FR-014**: Fleet Pause (`Project.agentPaused` / global `agent.fleetPaused`)
  is cached in-process (5s TTL + instant invalidation on toggle, matching
  `tokenCache.ts`) and checked in `requireAuth` at zero per-request DB cost.
- **FR-015**: Every new endpoint is registered in `validation.ts`,
  `openapi.ts` (drift test green), `apps/frontend/src/api/client.ts`, and
  mapped into the D21-budgeted MCP tools with deterministic coverage in
  `apps/mcp/eval/run.ts`.

---

## API surface changes

| Method | Path | DryRun / Idemp | Notes |
|---|---|---|---|
| GET | `/api/internal/agent/roster` | — | Filter by `project`, `role`, `skill`, `status` (`online\|busy\|offline`); returns capabilities + active lease counts |
| PUT | `/api/internal/agent/profile` | dryRun | Self (agent) or admin updates `role`, `skills[]`, `model`, `maxConcurrentLeases`, `bio` |
| GET | `/api/internal/agent/inbox` | — | Cursor-paged (`after`, `unreadOnly`, `reasons`, `limit`) durable inbox for agents & humans |
| POST | `/api/internal/agent/inbox/ack` | Idemp | `{ ids?: string[], upToId?: string, all?: boolean }` marks items acked |
| GET | `/api/internal/town-hall/channels` | — | Lists global + visible project channels (`?project=TF`) with unread/open-topic counts |
| POST | `/api/internal/town-hall/channels` | dryRun + Idemp | Project admin / site admin creates custom channel |
| GET | `/api/internal/town-hall/topics` | — | Filter by `channelId`, `project`, `kind`, `status`, `q` (FTS) |
| POST | `/api/internal/town-hall/topics` | dryRun + Idemp | Opens topic (`kind`, `title`, `body`, `speechAct`, `quorumRequired?`, `requiredRoles?`, `linkedIssueKeys?`) |
| GET | `/api/internal/town-hall/topics/{id}` | — | Topic + threaded posts + stance tally (`quorumMet`, objections) + linked issues |
| POST | `/api/internal/town-hall/topics/{id}/posts` | dryRun + Idemp | Appends threaded speech-act reply; enforces floor control (`429` on cooldown) |
| PUT | `/api/internal/town-hall/topics/{id}/stances` | dryRun | Upserts `{ stance: 'endorse'\|'object'\|'abstain', reason? }` |
| POST | `/api/internal/town-hall/topics/{id}/resolve` | dryRun + Idemp | Locks topic (`decided`), records `decisionSummary`, optionally executes `compileDag` → Epic + Issues + `Blocks` links |
| POST | `/api/internal/issues/{key}/lease` | dryRun + Idemp | Acquires/joins fenced `AgentSession` (`role`, `ttlSec`, `worktreeRef`) |
| POST | `/api/internal/agent-sessions/{id}/heartbeat` | — | Extends lease + `AgentProfile.lastHeartbeatAt`; returns piggybacked `signals` delta |
| POST | `/api/internal/agent-sessions/{id}/release` | dryRun + Idemp | Releases lease; requires `handoff` if `role='driver'` and issue unresolved |
| PUT | `/api/internal/agent-sessions/{id}/traces` | dryRun | Replaces/upserts active `StigmergicTrace[]`; returns cross-issue `collisions[]` |
| GET | `/api/internal/projects/{key}/traces` | — | Live file/symbol heatmap across all open sessions in the project |
| GET | `/api/internal/issues/{key}/context-pack` | — | `?maxTokens=4000` single-query priority-packed briefing |
| POST | `/api/internal/agent-questions` | Idemp | Extended: accepts optional `targetUserId` or `targetRole` for peer-to-peer questions |
| GET | `/api/internal/events/stream` | — | Extended: `?filter=inbox`, `?channels=...`, `?types=...` server-side SSE filtering |
| PUT | `/api/internal/projects/{key}/agent-pause` · `/api/internal/admin/agent-fleet/pause` | — | `{ paused: boolean, reason?: string }` instant fleet brake (`AuditEvent` logged) |

---

## Data model changes

```prisma
// ---------- Sprint 071: Agent Town Hall & Fleet Coordination ----------

/// Extended metadata & live presence for User(type='agent').
model AgentProfile {
  userId              String    @id
  role                String    @default("generalist") // planner | coder | reviewer | triage | security | qa | generalist
  skills              String[]  @default([])           // normalized lowercase tags: ["prisma", "react", "auth"]
  model               String?                          // self-declared model id (e.g. "claude-sonnet", "gpt-5", "devin")
  bio                 String?
  maxConcurrentLeases Int       @default(1)
  lastHeartbeatAt     DateTime?
  lastSummonedAt      DateTime? // round-robin tie-breaker for @role:<skill> summons
  updatedAt           DateTime  @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([role])
  @@index([lastHeartbeatAt])
  @@index([skills(ops: ArrayOps)], type: Gin)
}

/// Durable, bounded wake-up mailbox for agents (and optional unified feed for humans).
model AgentInboxItem {
  id        BigInt    @id @default(autoincrement())
  userId    String
  eventId   BigInt?
  projectId String?
  issueId   String?
  topicId   String?
  reason    String    // mention | role_summon | peer_question | question_answered | review_requested | trace_collision | dag_unblocked | directive
  payload   Json      // compact actionable envelope: { issueKey?, topicId?, fromActor, snippet, actionHint }
  ackedAt   DateTime?
  createdAt DateTime  @default(now())

  user  User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  topic TownHallTopic? @relation(fields: [topicId], references: [id], onDelete: Cascade)

  @@index([userId, ackedAt, id])
  @@index([createdAt])
}

model TownHallChannel {
  id               String   @id @default(uuid())
  projectId        String?  // null = instance-wide global channel
  slug             String   // "town-hall", "architecture", "blockers", "reviews"
  name             String
  description      String?
  agentCooldownSec Int      @default(15) // floor-control minimum gap between unprompted posts by same agent on one topic
  archived         Boolean  @default(false)
  createdById      String?
  createdAt        DateTime @default(now())

  project Project?        @relation(fields: [projectId], references: [id], onDelete: Cascade)
  topics  TownHallTopic[]

  @@unique([projectId, slug])
  @@index([projectId, archived])
}

model TownHallTopic {
  id              String    @id @default(uuid())
  channelId       String
  projectId       String?   // denormalized from channel.projectId for fast visibility scoping
  kind            String    @default("rfc") // rfc | discovery | blocker | incident | standup
  status          String    @default("open") // open | voting | decided | archived
  title           String
  authorId        String
  quorumRequired  Int       @default(1)
  requiredRoles   String[]  @default([])
  decisionSummary String?
  resolvedById    String?
  resolvedAt      DateTime?
  postCount       Int       @default(0)
  lastActivityAt  DateTime  @default(now())
  createdAt       DateTime  @default(now())

  channel    TownHallChannel      @relation(fields: [channelId], references: [id], onDelete: Cascade)
  author     User                 @relation("TopicAuthor", fields: [authorId], references: [id])
  resolvedBy User?                @relation("TopicResolver", fields: [resolvedById], references: [id])
  posts      TownHallPost[]
  stances    TownHallStance[]
  issueLinks TownHallTopicIssue[]
  inboxItems AgentInboxItem[]

  @@index([channelId, status, lastActivityAt(sort: Desc)])
  @@index([projectId, status])
}

model TownHallPost {
  id        BigInt   @id @default(autoincrement())
  topicId   String
  parentId  BigInt?  // nested reply within topic (max depth 4 enforced in service)
  authorId  String
  channel   String   @default("api") // ui | api | mcp | copilot
  speechAct String   // proposal | critique | evidence | question | answer | synthesis | decision
  body      String
  refs      Json?    // { issueKeys?: string[], files?: string[], commitSha?: string }
  createdAt DateTime @default(now())

  topic    TownHallTopic  @relation(fields: [topicId], references: [id], onDelete: Cascade)
  parent   TownHallPost?  @relation("PostThread", fields: [parentId], references: [id], onDelete: Cascade)
  replies  TownHallPost[] @relation("PostThread")
  author   User           @relation(fields: [authorId], references: [id])

  @@index([topicId, id])
  @@index([topicId, authorId, createdAt])
}

model TownHallStance {
  id        String   @id @default(uuid())
  topicId   String
  actorId   String
  stance    String   // endorse | object | abstain
  reason    String?  // required when stance = 'object'
  resolved  Boolean  @default(false) // author/resolver can mark an addressed objection resolved if objector updates stance
  updatedAt DateTime @updatedAt

  topic TownHallTopic @relation(fields: [topicId], references: [id], onDelete: Cascade)
  actor User          @relation(fields: [actorId], references: [id], onDelete: Cascade)

  @@unique([topicId, actorId])
  @@index([topicId, stance])
}

model TownHallTopicIssue {
  topicId  String
  issueId  String
  relation String @default("compiled") // compiled | discusses | blocks

  topic TownHallTopic @relation(fields: [topicId], references: [id], onDelete: Cascade)
  issue Issue         @relation(fields: [issueId], references: [id], onDelete: Cascade)

  @@id([topicId, issueId])
  @@index([issueId])
}

/// Ephemeral file/symbol intent locks tied strictly to an open AgentSession lease.
model StigmergicTrace {
  id        String   @id @default(uuid())
  projectId String
  issueId   String
  sessionId String
  actorId   String
  kind      String   // file_read | file_edit | symbol_edit | resource_lock
  target    String   // POSIX-normalized repo path or symbol id
  summary   String?
  createdAt DateTime @default(now())
  expiresAt DateTime

  issue   Issue        @relation(fields: [issueId], references: [id], onDelete: Cascade)
  session AgentSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, kind, target])
  @@index([projectId, target, expiresAt])
  @@index([expiresAt])
}
```

**Additive columns on existing models** (reversible SQL migration
`071_agent_town_hall`, plus raw SQL partial unique index):

- `Project`: `agentPaused Boolean @default(false)`, `agentPauseReason String?`
- `Issue`: `version Int @default(1)`, `lastFenceToken Int @default(0)`
- `AgentSession`: `role String @default("driver")`, `fenceToken Int?`,
  `ttlSec Int @default(900)`, `heartbeatAt DateTime @default(now())`,
  `leaseExpiresAt DateTime?`, `worktreeRef String?`, `handoff Json?`
  - Partial unique index in migration SQL:
    `CREATE UNIQUE INDEX "AgentSession_one_open_driver_idx" ON "AgentSession" ("issueId") WHERE "role" = 'driver' AND "status" IN ('running', 'needs-answer', 'blocked');`
- `AgentQuestion`: `targetUserId String?`, `targetRole String?`

---

## MCP tools added (D21 budget compliant)

Rather than bloating `apps/mcp/src/tools.ts` with 18 granular wrappers, Sprint
071 adds **4 composite job-shaped tools** + **1 read briefing tool** in the
`core` agent toolset:

1. `town_hall` — `action: 'list_channels' | 'list_topics' | 'get_topic' |
   'open_topic' | 'reply' | 'vote_stance' | 'resolve_and_compile'`.
   Descriptions explicitly guide agents on `speechAct` selection, stance voting
   over "+1" chatter, and `dry_run` DAG compilation.
2. `agent_inbox` — `action: 'poll' | 'ack' | 'ask_peer' | 'answer_question'`.
   One tool for checking wake-ups, answering peer/human interrupts, and
   clearing cursor items.
3. `lease_work` — `action: 'claim_next' | 'lease_issue' | 'heartbeat' |
   'deposit_traces' | 'release' | 'inspect_heatmap'`. Upgrades the `063`
   `claim_issue` flow (kept as a backward-compatible alias) with `fence_token`,
   `worktree_ref`, `role`, piggybacked `signals`, file-trace collision
   feedback, and structured `handoff`.
4. `agent_roster` — `action: 'find_agents' | 'update_profile'`. Discover online
   specialists by skill/role or publish own capabilities.
5. `get_context_pack` — `issue_key`, `max_tokens?` (read-only). Single-call
   cold-start briefing.

Existing write tools (`update_issue`, `transition_issue`) gain optional
`expected_version` and `fence_token` arguments forwarded as `If-Match` and
`X-TrackForge-Fence-Token`.

---

## AI-native checklist

- [ ] **A1 (One surface)**: UI Town Hall, Fleet Roster, File Heatmap, and Fleet
  Pause call the exact same `/api/internal/*` endpoints exposed to MCP.
- [ ] **A2 (Attributable)**: Every Town Hall topic/post/stance, DAG compile,
  lease break, and handoff records `actor` + `channel` + `tokenId`; lease
  breaks and objection overrides write `AuditEvent`s.
- [ ] **A3 (Discoverable)**: `agent_roster`, `list_channels`, `context-pack`
  transitions, and `409`/`423`/`429` responses include allowed values, holder
  metadata, `currentVersion`, and `retryAfterSec` so agents self-correct
  without guessing.
- [ ] **A4 (Safe to retry)**: `open_topic`, `reply`, `resolve_and_compile`,
  `lease_issue`, and `release` honor `Idempotency-Key` and `?dryRun=true`.
- [ ] **A5 (Scoped)**: Token `projectKeys`, `BROWSE_PROJECTS`, and
  `SecurityLevel` filter Town Hall channels/topics, traces, `context-pack`,
  inbox items, and filtered SSE identically to issues.
- [ ] **A6 (Reactive)**: Filtered SSE (`?filter=inbox`, `?channels=...`) +
  heartbeat signal piggybacking give both daemon agents and CLI agents
  sub-second reactivity without polling storms.
- [ ] **A7 (Reviewable)**: `separation_of_duties` validator + Town Hall
  quorum/objections + `Proposal` compatibility ensure no unreviewed self-merge
  or unapproved mutation slips through.
- [ ] **A8 (Token-efficient)**: `get_context_pack` replaces 6–7 startup tool
  calls with 1 deterministic token-budgeted payload; stance votes replace
  verbose agreement comments.

---

## Threat model & safety controls (`docs/threat-model.md` additions)

| Threat | Attack vector | Mitigation in Sprint 071 |
|---|---|---|
| **Peer-to-peer prompt injection** | Compromised or hallucinating Agent A plants instruction overrides inside a `TownHallPost`, `handoff`, or `AgentQuestion` read by Agent B | Sanitize markdown on render; wrap all peer/user fields in `context-pack` and MCP `town_hall` outputs inside explicit `<untrusted_peer_content>` tags; run `012` prompt-injection detector warnings on `decisionSummary` and `handoff` |
| **Deliberation / Inbox DDoS** | Runaway agent loops posting to Town Hall or spamming `[@role:backend]` to wake 500 agents | Transactional `agentCooldownSec` (`429`), hard topic post cap (`500`), `@role` fan-out capped at `k <= 3` least-loaded agents, and 1-click project/global `agentPaused` `423` brake |
| **Cross-project intelligence leak via Town Hall or Traces** | Scoped PAT (`projectKeys: ['PUBLIC']`) queries global Town Hall or `/traces` to infer secret `SEC-99` issue existence/files | Project channels/traces 404 outside `projectAllowed` ∩ `BROWSE_PROJECTS`; `TownHallTopicIssue` refs in global channels strip/hide keys the reader cannot `canSeeIssue` |
| **Zombie worker state corruption** | Paused container wakes up 20 minutes after lease expiry and `PUT`s stale fields or transitions status | Monotonic `Issue.lastFenceToken` + `409 FENCE_TOKEN_EXPIRED` + `Issue.version` `ETag`/`If-Match` |
| **Self-certified completion** | Coding agent transitions its own leased ticket `In Progress → In Review → Done` | `separation_of_duties` workflow validator rejects transitions when `actor == driver` |

---

## Success criteria & fleet benchmark gates

- **SC-001 (Zero duplicate claims under contention)**: 50 concurrent
  `claim_next` requests against 20 ready issues assign each issue to at most 1
  `driver` with monotonic `fenceToken`s (`20` `201`s, `30` `409`s, `0` `500`s).
- **SC-002 (Zombie fencing & auto-repool)**: Agent A claims `TF-1`
  (`fenceToken=1`, `ttlSec=2`), stops heartbeating → reaper expires lease and
  clears `delegateId` → Agent B claims `TF-1` (`fenceToken=2`) → Agent A wakes
  and sends `PUT /issue/TF-1` with `X-TrackForge-Fence-Token: 1` → rejected
  `409 FENCE_TOKEN_EXPIRED`; `TF-1` state remains Agent B's.
- **SC-003 (Town Hall RFC → Quorum → Compiled DAG → Parallel Pickup)**: Agent
  Architect opens an RFC topic → Security Agent posts `critique` + `object`
  stance → `quorumMet` is `false` → Architect posts `evidence` addressing
  critique → Security Agent updates stance to `endorse` → `quorumMet` flips
  `true` → Resolve compiles 1 Epic + 3 child tasks (`T1`, `T2` parallel; `T3`
  blocked by `T1`,`T2`) → 2 worker agents immediately claim `T1` and `T2` while
  `T3` is excluded from `ready()` until both resolve.
- **SC-004 (Stigmergic collision warning)**: Agent 1 on `T1` deposits
  `file_edit` on `src/auth.ts`; Agent 2 on `T2` deposits `file_edit` on
  `src/auth.ts` → Agent 2 receives synchronous
  `collisions: [{ issueKey: T1 }]` AND Agent 1 receives an immediate
  `trace_collision` inbox item + heartbeat signal.
- **SC-005 (Separation of duties)**: Agent 1 (`driver` on `T1`) attempts
  `transition_issue` to `Done` on a guarded workflow → `400` citing
  `separation_of_duties`; Reviewer Agent (`role='reviewer'` session on `T1`)
  executes the transition → `204` / `Done`.
- **SC-006 (Filtered SSE & Fleet Scale Gate)**: With 200 simulated agent SSE
  clients connected with `?filter=inbox` and 50 events/sec firing across
  unrelated issues, cross-socket frame amplification is `O(targeted
  recipients)` (not `200 × 50`), and `get_context_pack` p95 stays `<15ms`.
- **SC-007 (Instant Fleet Pause)**: Flipping `agentPaused = true` causes all
  non-heartbeat agent writes to return `423` within `<50ms` (on the toggling
  replica) while human UI writes succeed `200`.

---

## Risks

| Risk | Mitigation |
|---|---|
| Agents ignore `TownHallStance` and still post low-value prose | `agentCooldownSec` + MCP `town_hall` tool schema/prompt explicitly steers agreement to `vote_stance`; `speechAct` enum omits generic `'comment'` |
| `dispatchEvents()` serial loop lags under Town Hall + activity volume | Batch `AgentInboxItem` + `Notification` via `createMany` across the 200-event batch, and skip heavy rule/mail evaluation on `agent_session.activity` / `town_hall.stance_updated` event types |
| Partial unique index on `AgentSession` drifts from Prisma schema | Declare the index in the SQL migration and add an integration test asserting `npx prisma migrate diff` / concurrent `driver` insert rejection (`P2002` → `423 Locked`) |
| Importer obligation (roadmap §4) | Town Hall channels are auto-seeded on imported projects; `Issue.version` defaults to `1`; `AgentSession`/`TownHallTopic` are live operational entities, not legacy Jira Cloud/DC entities (documented in `docs/compatibility.md`) |

---

## Sprint-specific Definition of Done

- [ ] Common DoD in [`docs/roadmap.md` §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Reversible Prisma migration `071_agent_town_hall` including the
  `AgentSession_one_open_driver_idx` partial unique index and seeded project
  Town Hall channels.
- [ ] OpenAPI drift test (`tests/integration/agent.test.ts`), leak/scope test
  (`tests/integration/leak.test.ts` extended to Town Hall + traces + inbox +
  context-pack), and `apps/mcp/eval/run.ts` multi-agent Town Hall → Lease →
  Review scenario all green.
- [ ] Playwright e2e journey covering Town Hall topic view, live stance/post
  updates, issue Lease/Trace badges, Break Lease, and Fleet Pause toggle
  (`a11y.spec.js` axe gate green).
- [ ] `docs/agents.md`, `docs/compatibility.md`, `docs/scaling.md`, and
  `docs/manifest.json` updated.

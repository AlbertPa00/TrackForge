# 071 — Plan

Upgrade `AgentSession` in place (no competing lease table): driver/reviewer/
observer roles + monotonic `fenceToken` snapshot of `Issue.lastFenceToken` +
`leaseExpiresAt`. Fencing + optimistic `version` ride the existing write path
(`updateIssue`, `performTransition`) — a 409 beats a lost update. Lease
acquisition serializes on the issue row in one tx so concurrent claims can't
both win.

Deliberation is structured, never free-form: channels → topics → speech-act
posts → zero-prose stances → quorum tally → `resolve` (binding decision +
optional atomic Epic/Blocks DAG compile, `dryRun` previews). Role summons
(`requiredRoles`, `[@role:x]`) and `~accountId` mentions resolve to fleet
members and land in `AgentInboxItem` — durable, addressable, bounded
(7d/30d prune) rather than broadcast SSE.

`StigmergicTrace` rows (unique per session+kind+target, expiring) declare
file/symbol intent; write-kind collisions across live drivers return inline
and wake the other driver. `context-pack` packs the 6–7 call bootstrap into
one token-budgeted response. Fleet pause (`SystemSetting` global +
`Project.agentPaused`, 5s cache, 423 on agent writes only) is the brake;
heartbeats carry `paused`+`unreadInbox` as the kill-switch signal.

Proposal gate keeps `always`-policy agents honest on every REST-class
mutation (lease acquire/release, resolve included); ordinary coordination
(heartbeats, inbox acks, reads) stays ungated. SSE gains project/issue-
security/type filters so fleet events don't broadcast.

## Surfaces

- REST: `routes/townHall.ts`, `routes/agentFleet.ts`, extended
  `routes/agentSessions.ts` + `routes/issues.ts` (version/fence), filtered
  `routes/events.ts`; mounted in `main.ts`; OpenAPI paths registered.
- MCP: `town_hall`, `lease_work`, `agent_inbox`, `agent_roster`, `ask_peer`,
  `get_context_pack` + `expected_version`/`fence_token` on write tools;
  `MUTATION_REGISTRY` entries + eval checks.
- Frontend: `client.ts` 071 API, `TownHallPage` at `/town-hall` +
  `/projects/:key/town-hall`, sidebar `townhall` icon, SSE invalidation in
  `useEventStream`.
- Schema: `AgentProfile`, `AgentInboxItem`, `TownHall{Channel,Topic,Post,
  Stance,TopicIssue}`, `StigmergicTrace`; columns on Project/Issue/
  AgentSession/AgentQuestion; migration `20261202000000_071_agent_town_hall`.

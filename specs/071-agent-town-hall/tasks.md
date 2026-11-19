# 071 — Tasks

- [x] Schema + migration `20261202000000_071_agent_town_hall` (FR-001)
- [x] `fleetPause.ts` — global/project brake, 423 on agent writes, 5s cache
      + invalidation (FR-011)
- [x] `agentProfileService.ts` — roster, profiles, presence, capacity (FR-008)
- [x] `agentInboxService.ts` — generate/list/ack/prune, reason tags (FR-004)
- [x] `townHallService.ts` — channels/topics/posts/stances/quorum/resolve +
      DAG compile + floor control (FR-005..FR-007)
- [x] `traceService.ts` — deposit/collide/heatmap (FR-009)
- [x] `contextPackService.ts` — token-budgeted bootstrap (FR-010)
- [x] `agentSessionService.ts` — lease mint/heartbeat/release/break,
      `sweepExpiredLeases`, `listFleetSessions`, peer questions,
      fence assertions (FR-002, FR-003, FR-012)
- [x] `issueService.ts`/`workflowService.ts` — `expectedVersion`/`fenceToken`,
      version increments, P2025→409 race guard, transition gating +
      `dag_unblocked` inbox (FR-003)
- [x] Routes: `townHall.ts`, `agentFleet.ts`, `agentSessions.ts` extensions,
      `GET /agent-sessions` fleet board (FR-013)
- [x] `main.ts` mounts; proposal-gate REST-class patterns; OpenAPI paths (FR-013)
- [x] `sseHub.ts`/`events.ts` filtered subscriptions (FR-014)
- [x] MCP tools + `MUTATION_REGISTRY` + read-only gates on mixed tools (FR-013)
- [x] MCP eval — 071 live-check block (leases, fence/version 409s, town-hall
      round-trip, inbox, roster, context pack, break→zombie)
- [x] `client.ts` 071 API surface (types + wrappers)
- [x] `TownHallPage` + `/town-hall` + `/projects/:key/town-hall` routes +
      sidebar nav + SSE invalidation (FR-015)
- [x] `townHall.test.ts` — lease/fence/409/pause + topic→DAG + inbox + traces
- [x] `docs/agents.md` town-hall section; `docs/roadmap.md` registration
- [x] backend + MCP + frontend typecheck green
- [ ] `prisma migrate dev` + DB-backed test run (Postgres unavailable locally)
- [ ] `pnpm lint` full pass
- [ ] Issue-page sidebar badges (lease holder, town-hall decisions) — US6 tail
- [ ] Playwright e2e for the town-hall page

# 067 — Tasks

- [x] `rankSimilar` `resolvedOnly` option + hit carries resolution (FR-001)
- [x] `similarIssues` anchor `aiEnabled` check + regression test (FR-008)
- [x] `suggestResolution` service: short-circuits, evidence text, chat call (FR-001, FR-004)
- [x] Closed-set + `basedOn` validation, server-computed confidence (FR-002, FR-003)
- [x] Route `POST /ai/issues/:key/suggest-resolution` + outcome enum `resolution`
- [x] OpenAPI registration; drift test green (FR-007)
- [x] Copilot `suggest_resolution` tool + presenter (FR-007)
- [x] MCP `suggest_resolution` tool + eval check (FR-007)
- [x] Frontend client: `aiSuggestResolution`, `ResolutionInsight`, outcome union
- [x] `TransitionScreenModal` `initialResolution` prop
- [x] `AiPanel` button + card + Apply via transitions (FR-005)
- [x] Outcomes accepted / edited / discarded (FR-006); verify `AiSettingsPage` table
- [x] Integration tests SC-001..SC-005
- [x] Frontend unit test SC-006
- [x] `docs/ai.md`
- [x] `pnpm typecheck && pnpm lint` clean; backend + frontend suites green; MCP eval green

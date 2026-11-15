# Feature Specification: Hardening & AI-Native Charter

**Feature Branch**: `005-hardening-and-ai-charter` | **Created**: 2026-11-07 | **Status**: Draft

**Source doc**: [`docs/sprints/005-hardening-and-ai-charter.md`](../../docs/sprints/005-hardening-and-ai-charter.md) — full user stories, edge cases, acceptance scenarios live there; this file is the spec-kit registration.

## Scope (from source doc, condensed)

- **US1 (P1)**: CI — GitHub Actions: pnpm install, prisma generate, `typecheck`, `lint`, backend tests, Playwright smoke; new `pnpm typecheck` script.
- **US2 (P1)**: Honest navigation — dead top-nav items disabled w/ sprint tooltips + `aria-disabled`; Projects highlighted on project routes; global search box: issue-key → `/browse/:key`, free text inside project → list w/ prefilled text, outside → Sprint-010 hint.
- **US3 (P1)**: Issue list scales — pager (1–50 of N, prev/next, sizes 25/50/100), sortable Key/Created/Updated via `ORDER BY`, server-side `summary ~ "text"` JQL-lite clause, URL query params.
- **US4 (P1)**: Integrity — atomic per-project issue counter in one transaction (concurrency test), `PUBLIC_BASE_URL` for `self` links, Jira-shaped JSON 404 for unknown `/rest/*` routes.
- **US5 (P2)**: One design-token set (D3: current ADS tokens), no raw hex in components; unified Create button; `/browse/:key` highlights List; details panel layout; date tooltips.
- **US6 (P2, D1)**: PostgreSQL default — provider switch, re-baselined migration, CI postgres service, sqlite removal, quickstart update. Conditional on Docker availability in dev env.
- **US7 (P2, must not slip)**: Constitution v1.1.0 + principle VI (AI-Native Operability, draft text in source doc); DESIGN.md "AI-Native Control Plane" section + D5 prefix fix `/api/internal/*`; plan-template.md update.

## Success criteria

Per source doc: CI green + blocks broken commits; 0 enabled-but-dead controls; 250-issue paging/search; 20-parallel-creates concurrency test 10/10; backend tests ≥ 47.

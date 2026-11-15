# Contributing to TrackForge

Welcome — issues and PRs are open. The maintainer contract lives in
[`AGENTS.md`](AGENTS.md) (repo map, request flow, invariants); this file is the
short version for humans.

## Set up

```bash
docker compose up -d        # postgres :5433 (+ redis, mailpit)
pnpm install
pnpm db:seed                # metadata, workflows, demo users
pnpm dev                    # backend :3000, frontend :5173
```

## Before you push

```bash
pnpm typecheck && pnpm lint # must be clean (0 warnings is the bar)
pnpm --filter backend test  # vitest; needs Postgres (DATABASE_URL/TEST_DATABASE_URL)
pnpm --filter trackforge-mcp eval   # agent contract eval; needs TRACKFORGE_URL + TRACKFORGE_TOKEN
```

## House rules that bite if you skip them

- **Jira v2 shapes.** Responses mimic Jira Server; document divergences in
  `docs/compatibility.md`.
- **Status moves via transitions only** — `PUT fields.status` is rejected.
- **New writes** must support `?dryRun=true`, honor `Idempotency-Key`, thread
  `actor` (user + `X-TrackForge-Channel` + token) into changelog/audit, and
  enforce `projectAllowed()`/`enforceIssueScope()`.
- **Endpoint changes touch four surfaces** — `lib/validation.ts` (zod),
  `lib/openapi.ts`, `apps/mcp/src/tools.ts`, `apps/frontend/src/api/client.ts`.
  There's a drift test; keep it green.
- **Destructive deletes** are two-step (dryRun → `confirmToken` → real delete).
- ESM imports use `.js` extensions; TypeScript strict; Prettier + ESLint.

## Workflow

Features follow spec-kit: sprint doc in `docs/sprints/NNN-*.md` →
`/speckit.specify` → `plan` → `tasks` → `implement`. Commit messages reference
the sprint/spec dir (e.g. `specs/063-launch-wedge` or `docs/sprints/063`).

## Reporting bugs

Repro steps, expected vs actual, and the request/response pair (headers matter:
`Idempotency-Key`, `X-TrackForge-Channel`, `?dryRun=` change behavior).
Security issues: [`SECURITY.md`](SECURITY.md) — not public issues.

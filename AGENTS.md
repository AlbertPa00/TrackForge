# AGENTS.md — TrackForge

Self-hosted issue tracker that implements the Jira v2 REST contract, designed
so that **AI agents are first-class users** (via REST + MCP) and first-class
maintainers. This file is the orientation map. Read it before editing.

- North star: `DESIGN.md` (long, Jira-parity analysis — consult, don't read whole)
- Constitution: `.specify/memory/constitution.md` (Principle VI = AI-native operability)
- Architecture: `docs/architecture.md` (Mermaid orientation — start here)
- Architecture review: `docs/architecture-review-agentic.md` (known structural debt + refactor plan)
- Sprint backlog: `docs/roadmap.md`; feature specs: `specs/NNN-<name>/`

## Repo map

```
apps/backend    Express + Prisma + zod. Jira v2 REST under /rest/api/2,
                agile under /rest/agile/1.0, extensions under /api/internal.
apps/frontend   React 18 + Vite + Tailwind + TanStack Query. Thin UI over the
                same REST API agents use.
apps/mcp        MCP server (stdio/HTTP) — the agent tool surface; wraps REST.
                eval/run.ts is a deterministic no-LLM contract suite.
specs/          spec-kit artifacts per feature (spec, plan, tasks, contracts).
.specify/       constitution, templates, workflow registry.
docs/           markdown docs + VitePress public site (docs/manifest.json is the
                registry for BOTH the in-app portal and the site sidebar;
                sprints/, research/ and DENYLISTed audit pages are excluded).
docs/sprints/   one file per sprint — what + why.
```

## Commands

```bash
pnpm install                 # bootstrap
pnpm dev                     # turbo: backend :3000 + frontend :5173
pnpm --filter backend test   # vitest (unit + integration, needs Postgres)
pnpm typecheck && pnpm lint  # always run before committing (0 warnings is the bar)
pnpm db:seed                 # metadata, workflows, demo users (admin@trackforge.local / trackforge)
pnpm --filter backend import:run <jobId>   # run an ImportJob outside the HTTP server
pnpm --filter trackforge-mcp eval   # agent-contract eval; needs TRACKFORGE_URL + TRACKFORGE_TOKEN
cd apps/backend && npx prisma migrate dev   # after schema.prisma changes
cd apps/frontend && npx playwright test tests/e2e/a11y.spec.js  # axe gate, needs backend :3000 + seed
```

Tests need `DATABASE_URL` (or `TEST_DATABASE_URL` for vitest) pointing at
Postgres — see `docker-compose.yml` for the dev instance.

## Backend request flow (package-by-layer today)

`main.ts` mounts routers → `routes/*.ts` parse/validate (zod from
`lib/validation.ts`) → `services/*.ts` hold all domain logic + Prisma →
`middleware/auth.ts` (sessions, PATs, scopes, rate limit, idempotency).
`jql/` is a self-contained engine (lexer → parser → AST → Prisma compiler).

## Contract surfaces — FOUR places, drift risk

One endpoint's contract is currently declared in all of these. **If you change
one, change them all** (a codegen registry is planned — see the arch review):

1. `apps/backend/src/lib/validation.ts` — zod request schemas (400s via `formatZodErrors`)
2. `apps/backend/src/lib/openapi.ts` — OpenAPI doc assembly (drift-tested in `tests/integration/agent.test.ts`)
3. `apps/mcp/src/tools.ts` — MCP tools, hand-mapped to REST calls (~140 tools vs ~360 documented REST paths incl. api/3 mirrors — parity is the goal, not the rule today)
4. `apps/frontend/src/api/client.ts` — hand-written TS types + fetch wrappers

## Invariants (enforced today — don't break)

- **Jira v2 shapes.** Responses mimic Jira Server; intentional divergences are
  documented in `docs/compatibility.md`.
- **`PUT fields.status` is rejected.** Status moves via transitions only —
  `GET /issue/{key}/transitions` then `POST` with `{transition:{id}}`.
- **dryRun on writes.** `?dryRun=true` on mutating issue endpoints validates +
  returns a preview without persisting. New write endpoints must support it.
- **Idempotency.** `Idempotency-Key` on POST is replay-safe per principal
  (`IdempotencyRecord`). Reusing a key with a different body → 422.
- **Attribution.** Every mutation threads `actor` (user + channel + token) into
  `ChangeHistory`/`AuditEvent`. Channel comes from `X-TrackForge-Channel`
  (`mcp`, `copilot`) — never hardcode it.
- **Error shape.** `{errorMessages: string[], errors: {field: msg}}` — include
  allowed values in field errors so agents can self-correct.
- **Token scoping.** Write methods require `write` scope; `projectAllowed()`
  / `enforceIssueScope()` must be applied on every project-scoped route —
  known gaps are listed in `docs/roadmap.md` pre-flight; don't add new ones.
- **Two-step destructive deletes.** `DELETE` + `dryRun` returns `confirmToken`;
  the real delete requires it.

## Planned, not yet enforced (don't rely on)

- `PUT fields.status` rejection, dryRun, and MCP parity are conventions, not
  lints — the arch review tracks making them structural.

## When you add or change an endpoint

1. zod schema in `lib/validation.ts`; validate in the route.
2. Register it in `lib/openapi.ts` (keep the drift test green).
3. If agent-facing: add the MCP tool in `apps/mcp/src/tools.ts` **and** a
   deterministic check in `apps/mcp/eval/run.ts`.
4. Mutations on issues: support `dryRun`, record changelog via `actor`,
   audit sensitive ops, enforce project scoping.
5. Integration test in `apps/backend/tests/integration/`.
6. Update `docs/compatibility.md` if it diverges from Jira.

## Development workflow

Features follow spec-kit: sprint doc (`docs/sprints/NNN-*.md`) →
`/speckit.specify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`,
producing `specs/NNN-*/`. Workflows live in `.windsurf/workflows/`.
Every sprint ships a runnable increment; a hardening sprint follows every four
feature sprints (`docs/sprints/hardening-cadence.md`).

## Conventions

- ESM (`"type": "module"`) — internal imports use `.js` extensions.
- TypeScript strict; Prettier for format; ESLint must pass.
- Commit messages reference the feature dir (e.g. `specs/010-jql-engine-search`).
- Hovers: `truncate`d or `line-clamp`ed dynamic text must have a reveal path —
  prefer `components/OverflowText.tsx` (conditional title only when clipped) or
  a `title` on the cell/row. Icon-only controls pair `aria-label` with a
  matching `title`. Tooltip content is never the sole carrier — the full value
  must also live at the navigation destination.

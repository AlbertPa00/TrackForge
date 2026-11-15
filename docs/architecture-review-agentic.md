# Architecture Review — TrackForge as an Agent-Maintained Platform

**Date**: 2026-11-07 · **Scope**: whole repo (`apps/*`, `specs/`, `.specify/`, `docs/`)
**Lens**: not "is this good architecture" in the abstract, but "is this the right
architecture for a platform that is *developed and maintained primarily by AI
agents*". That changes the cost model: the dominant resource is **context
budget and retrieval reliability**, not human familiarity.

---

## 0. Verdict

The *product* surface for agents is genuinely ahead of industry practice — the
MCP server, `dryRun`, `Idempotency-Key`, scoped PATs, `whoami`, createmeta
discovery, channel attribution, a transactional outbox, and a deterministic
eval harness are more agent-native than most production SaaS.

The *codebase* surface for agents is a conventional 2015-era package-by-layer
Express monolith. It works today because the codebase is still small
(~12k LOC backend), but every structural trend is in the wrong direction:
four hand-maintained contract surfaces, duplicated write paths for previews,
an emerging god-service, auth scoping applied per-route ad hoc, and zero
agent-orientation docs. None of these hurt at current size; all of them
compound exactly the way the roadmap (40+ planned sprints) guarantees growth.

The recommendation is **not** a rewrite. It is a staged migration to a
**domain-modular monolith with a single generated contract surface**, which
is the strongest known structure for agent-maintained code (see §4–§5).

---

## 1. What is genuinely good (don't refactor these)

| Asset | Why it matters for agentic development |
|---|---|
| `apps/mcp/eval/run.ts` — deterministic, no-LLM eval of the whole agent contract | This is the single most valuable agentic artifact in the repo. Most teams don't have it. It is a regression suite for "can an agent still operate this product". |
| `Idempotency-Key` + `IdempotencyRecord` table | Agent retry-safety solved at the platform level. |
| `dryRun`/`preview` *concept* | Correct instinct; the implementation is the problem (F3). |
| `DomainEvent` outbox written in the same tx as mutations | Correct eventing foundation; already loop-guarded via `Webhook.excludeActorIds`. |
| `.specify/` + `specs/NNN` + constitution + sprint docs | A real spec-driven pipeline. This is the *development*-side agent scaffolding and it is ahead of the code organization it produces. |
| `zod` for all input + `zod-to-json-schema` for OpenAPI | Half of the contract-generation story already exists. |
| Jira-shaped errors (`errorMessages` + per-field `errors`, allowed-values hints) | Errors agents can act on without retries-by-guessing. |

---

## 2. Critical findings

### F1 — Package-by-layer wastes agent context; coupling runs through a hub

```
apps/backend/src/
  routes/      11 files   (HTTP parsing + mapping only)
  services/    16 files   (all domain logic, cross-importing)
  middleware/  lib/  jql/
```

Any non-trivial change to the issue lifecycle touches, at minimum:
`routes/issues.ts`, `services/issueService.ts`, `services/changelogService.ts`,
`lib/validation.ts`, `tests/integration/issues.test.ts` — 5 directories before
the frontend is even opened. `issueService.ts` alone is 860 lines and is
imported by `searchService`, `boardService`, `commentService`, `linkService`,
and `sprintService` — it is becoming the god-object every Jira-shaped codebase
grows, and every one of those dependents reaches into its internals
(`toIssueResponse`, `parseIssueKey`, `issueInclude`) rather than a published
interface.

For a human this is mildly annoying. For an agent it is the difference between
*one `ls` revealing the whole feature* and *reconstructing a dependency graph
across the tree on every task*. The agent-facing literature is unambiguous
here: feature/domain folders with co-located tests minimize retrieval cost and
missed-context errors (Jimmy Bogard's original VSA essay; Anthropic's Claude
Code monorepo guidance; the Codex agent-ready-repo writeups — §7).

**Counterpoint, stated honestly**: the service graph is already a de-facto
domain split — `issue`, `sprint`, `board`, `workflow`, `jql`, `meta`,
`identity`, `collaboration` are visible in the filenames. The codebase does
not need per-endpoint slices; it needs the existing implicit domains made
*explicit as modules*.

### F2 — Four contract surfaces maintained by hand; agents consume the drift

Today, one endpoint's contract lives in **four** places:

1. `lib/validation.ts` — zod request schemas
2. `lib/openapi.ts` — 407 lines of manual OpenAPI assembly (bodies generated
   from zod, but paths/queries/params registered by hand)
3. `apps/mcp/src/tools.ts` — **729 lines** of `server.tool(...)` wrappers, each
   re-declaring a *separate* zod param schema and hand-mapping it to a
   `tf.call(method, path)`
4. `apps/frontend/src/api/client.ts` — 693 lines of hand-written TS interfaces
   + fetch wrappers

Measured drift already: **65 routes** registered in `routes/` vs **~31 MCP
tools** — the agent surface covers roughly half the REST surface, and nothing
enforces parity. There is an OpenAPI drift test (good) but **the MCP eval is
not wired into CI** (`.github/workflows/ci.yml` runs unit + integration +
Playwright only). The one suite that proves "agents can still use the product"
is run manually or not at all.

For a platform whose constitution (Principle VI) says agents must operate
everything with human fidelity, a hand-mirrored tool layer is the highest-risk
file in the repo: tools can call routes that changed shape, tools silently lag
new routes, and every new endpoint pays a ~20-line translation tax three times.

**Fix direction — contract registry**: define each endpoint once
(`{ method, path, requestSchema, responseSchema, scopes, dryRun, mcpName,
mcpDescription }`) and *generate*: the Express binding, the OpenAPI doc, the
MCP tool registration, and the frontend client types. The infrastructure to
do this is half-built (zod → JSON Schema is already used). This single change
eliminates ~1,800 lines of hand-maintained mirror code and makes
REST↔MCP parity *structural* instead of aspirational. It is also the classic
enabler for agent maintenance: agents modify one spec file and the whole
surface updates — a self-describing system.

Framework alternatives that reach the same end state: Fastify + typebox,
Hono + zod-openapi, zodios, or contract-first codegen (`openapi-typescript` +
`orval` for the frontend). The constitution pins Express; a ~200-line internal
registry achieves the same without a framework migration. Fastify would
additionally buy schema-validated *responses* (today responses are untyped at
the boundary — a real gap: zod validates what comes in, nothing checks what
goes out).

### F3 — Preview/dry-run is a hand-duplicated write path

`issueService.ts` contains 5 parallel `preview*` functions
(`previewCreateIssue`, `previewUpdateIssue`, `previewAssignIssue`,
`previewDeleteIssue`, `previewTransition`) that re-run validation and then
*hand-construct a fake persisted entity* (`id: 'preview'`, `createdAt: new
Date()`) to feed the response mapper. `planCreate` was extracted (good
instinct — plan/commit split) but the pattern is neither formalized nor
enforced: each new write op must remember to author a second implementation,
and a preview that diverges from the real write is worse than no preview —
it trains the agent on a lie.

**Fix direction**: one of two mechanical patterns, both provably honest:

- **Transactional rollback preview**: run the *real* mutation inside
  `prisma.$transaction`, snapshot the result, abort the tx. Zero duplicated
  logic; preview is the truth by construction. Cost: consumes `issueCounter`
  increments and sequences — but `issueCounter` is already a manual column
  (not a DB sequence), so simply don't increment it on preview, or increment
  and accept gaps (Jira tolerates gaps in keys anyway).
- **Formalized plan/commit**: keep `planX(data) → PlannedMutation{writes,
  changes}` for every mutation; `execute = commit(plan)`;
  `preview = render(plan)`. This is what `planCreate` already half-does —
  finish it as a *rule*, documented and lint-checked, not a convention some
  services follow.

Either way: "every mutation previewable" (constitution VI) must become an
**enforceable invariant** — an architecture test that fails if a `POST|PUT|
DELETE` route lacks a `dryRun` path — not a feature implemented per-route.

### F4 — Auth/scope enforcement is per-route ad hoc; the roadmap's own debt list proves it

The pre-flight debt list in `docs/roadmap.md` reads like a symptom map of
missing cross-cutting enforcement: *"token project-scope on agile/link/label
routes and DELETE /project"*, *"comment issue-number scoping (cross-issue
comment access)"*, *"resolveAssigneeRef({}) assigning an arbitrary user"*.
These are not random bugs — they are what happens when scope checks are
re-implemented route by route (`enforceIssueScope`, `projectAllowed` called
manually inside handlers) instead of being a property of the endpoint
declaration.

Same fix as F2: if scopes and project allow-lists are fields in the contract
registry, forgetting them becomes a lint error, not a security bug found a
sprint later.

### F5 — No agent-orientation layer for the repo itself

For an "AI-native" platform, the repo is oddly unfriendly to the agents asked
to maintain it:

- **No `AGENTS.md`/`CLAUDE.md`** at root. A fresh agent (Devin, Claude Code,
  Codex — not just Windsurf) gets no map: what the apps are, where domains
  live, how to run tests, what invariants exist.
- The `.windsurfrules` file documents `rtk` token-proxying — useful, but it is
  the *only* always-on instruction file.
- Invariants are scattered in schema comments ("every mutation writes one
  DomainEvent row in the same tx" lives as a `///` comment on the model, not
  in any doc an agent reads before writing a mutation).
- Tests live in a detached `tests/` tree; unit tests are not co-located with
  the code they pin. Agents consistently produce better test edits when the
  test file is adjacent to the source (this is now well-documented folk
  knowledge in the agent-repo literature — §7).

### F6 — Frontend mirrors the same disease, one stage earlier

`api/client.ts` (693 lines) is the frontend god-file — every domain's types and
fetchers in one file. `components/` is a flat bucket of 24 files mixing board,
issue-detail, search, and workflow-editor concerns. Fine at 8k LOC; the roadmap
(dashboards, reports, admin console, importer) will 3× this. Same prescription:
feature folders (`features/board`, `features/issue`, `features/search`,
`features/workflow`) and a **generated** API client instead of the hand one.

### F7 — Single-binary deployment constraint is real — respect it

docker-compose is one Postgres + the app. Self-hosted, single-node is a
*feature* (it's why the outbox + in-process MCP work so cleanly). Every
alternative below is judged against this constraint; anything that requires a
service mesh or a queue to stay correct is disqualified, not merely deprioritized.

---

## 3. Severity ranking

| # | Finding | Risk if unaddressed | Effort |
|---|---|---|---|
| F2 | Hand-mirrored contract surfaces (tools.ts / openapi.ts / client.ts) | Agent surface drifts from reality — the platform's core promise breaks silently | M — biggest single win |
| F3 | Duplicated preview write-paths | Previews lie; agent trust erodes | S–M |
| F4 | Ad-hoc scope enforcement | Security bugs recur sprint over sprint (already happening) | S once F2 lands |
| F1 | Layered layout + issueService hub | Context cost per task grows superlinearly; merge conflicts concentrate | M–L, but incremental |
| F5 | No AGENTS.md / invariants doc; eval not in CI | Every agent session rediscovers the repo; agent contract regresses unnoticed | XS — do this week |
| F6 | Frontend god-client + flat components | Same as F1, one sprint behind | M |

---

## 4. Alternatives, honestly evaluated

| Alternative | What it is | Verdict for this codebase |
|---|---|---|
| **A. Keep package-by-layer, tidy up** | Rename, split big files | Treats symptoms. The layer boundaries are the problem — every feature change crosses them by construction. |
| **B. Vertical slice per endpoint** (MediatR/handlers) | `features/CreateIssue/{handler,validator,test}` | Right instinct, wrong granularity *here*. The issue domain has deep shared machinery (`issueInclude`, `toIssueResponse`, changelog, JQL compilation into the same tables) that per-endpoint slices fragment into duplicated helpers or a de-facto `shared/` junk drawer. Works in CRUD-heavy apps; this is a domain-heavy one. |
| **C. Modular monolith — modules by bounded context** ✅ | `modules/{issues,agile,jql,workflow,identity,meta,collaboration}/`, each owning routes+service+schemas+tests+AGENTS.md; enforced import boundaries | **Recommended.** Matches the domain split the services already imply; a module listing gives an agent the whole bounded context; boundaries make "does this module touch issues internals?" a lint question. Layers *inside* a module where they earn it (the JQL engine is already a clean sub-module). |
| **D. Hexagonal / clean architecture** | ports & adapters everywhere | Violates the constitution's own Principle V (explicit simplicity). The only real external axes are Postgres, the LLM provider, and webhooks — three adapters don't justify ports-per-module. Rejected. |
| **E. Microservices** | split apps/backend | Actively harmful for a self-hosted single-binary product. Destroys transactional outbox semantics, the in-process MCP/copilot design (sprint 012 depends on in-proc tool registry), and ops simplicity. Rejected. |
| **F. Full event-sourcing / CQRS** | event log as source of truth | The outbox already gives the integration benefits. ES would fight Jira-compat semantics (Jira is CRUD-shaped; importers expect current-state reads) and explode the preview/dry-run complexity. Keep CQRS-*lite* — the implicit read/write split already present (writes via services, reads via search/JQL compiler) — formalized per module, no framework. |
| **G. Contract-first codegen** (contract registry → routes/OpenAPI/MCP/client) | single endpoint spec generates all four surfaces | **Recommended, independent of C — do it first.** Cheapest, highest-leverage change; removes the drift class entirely and makes the platform self-describing to the agents that maintain it. |
| **H. tRPC for `/api/internal`** | type-safe RPC for frontend-only endpoints | Reasonable hybrid: keep `/rest/api/2` Jira-shaped forever, but the internal surface (auth, workflows, future copilot) needn't pretend to be Jira. tRPC gives end-to-end types for free. Optional; G subsumes most of the benefit. |

The honest synthesis of the literature (Bogard, modular-monolith writeups,
agent-repo guidance): **slices at the top level (bounded contexts), layers
inside slices only where they pay, contracts generated from one source.**

## 5. Recommended path (incremental, sprint-sized)

Ordered by leverage-per-effort; each step is independently shippable, matching
the sprint cadence already in `docs/roadmap.md`/`hardening-cadence.md`.

- **R0 — Agent-orientation layer (days, not a sprint).**
  Root `AGENTS.md`: app map, domain list, commands (`pnpm test`,
  `--filter backend`, eval), invariants ("mutations emit DomainEvent in the
  same tx", "writes are dryRun-capable", "routes declare scopes in the
  contract registry"). Wire `apps/mcp eval` into CI (it's a seeded-docker
  job away; the CI already boots backend+Postgres for Playwright — the eval
  can run against that same stack with a PAT from the seed).
- **R1 — Contract registry + generated surfaces.** Introduce
  `src/contracts/*.ts`; port endpoints module-by-module; generate OpenAPI,
  MCP tool registration, and frontend client types. Add CI checks: REST↔MCP
  parity, OpenAPI drift (exists), *response* schema validation in dev/test.
  Delete the hand-written halves of `tools.ts`, `openapi.ts`, `client.ts`.
- **R2 — Scope enforcement declarative.** `scopes` + `projectKeys` become
  registry fields enforced by middleware, not per-route calls. Closes the
  entire class of pre-flight auth debt, permanently.
- **R3 — Plan/commit formalization.** Every mutation = `plan → commit`,
  `preview = render(plan)` (or tx-rollback where plan is impractical).
  Architecture test: any mutating route without a preview path fails lint.
  Delete the 5 preview twins.
- **R4 — Module migration, in dependency order.** `identity` + `meta` first
  (few dependents, proves the pattern), then `workflow`, `agile`
  (sprint+board together — they're one bounded context in practice),
  `jql` (already nearly a module), `collaboration` (comments/links/watchers),
  **`issues` last** — it's the hub; by then its interface is what the other
  modules actually import. Enforce with `eslint-plugin-boundaries` or
  `dependency-cruiser`; publish per-module `AGENTS.md`. Move unit tests
  beside source; keep `tests/integration/` as the cross-module suite.
- **R5 — Frontend feature folders + generated client.** Follows R1 for free
  (client types are generated); group components/pages by feature domain.

Prisma note: if module-local schema ownership is wanted, Prisma's multi-file
`prismaSchemaFolder` (GA since v6) allows `prisma/schema/issues.prisma` etc.;
optional — one schema file with clear section headers is acceptable at
505 lines.

## 6. Guardrails — what NOT to do

- **Don't rewrite.** Every finding above is a mechanical migration; the
  domain model is sound and Jira-compatible. A rewrite forfeits the spec-kit
  history and eval suite that are the actual moat.
- **Don't chase clean architecture.** Three external systems do not justify
  ports-and-adapters ceremony; the constitution already forbids it (V).
- **Don't split services.** Single-binary self-hosted is a feature.
- **Don't let "agentic" justify removing the human surface.** The same
  contract registry must keep producing the human API; parity is the point.
- **Don't over-tool.** The registry should be ~200 lines of internal code
  before reaching for a framework.

## 7. References

- Bogard, *Vertical Slice Architecture* — "couple along the axis of change;
  minimize coupling between slices, maximize within" — jimmybogard.com/vertical-slice-architecture/
- Nilus Consulting, *Layered vs Vertical Slice in Modular Monoliths* —
  "top-level structure and internal structure are different decisions;
  slices on top, layers inside" — nilus.be
- Anthropic, *Set up Claude Code in a monorepo or large codebase* —
  per-directory scoped instruction files; context as the scarce resource —
  code.claude.com/docs/en/large-codebases
- *Agent-Ready Repository Architecture* (Codex knowledge base) —
  "every architectural decision either shrinks or expands the context the
  agent needs; feature slices shrink it; layer scattering expands it" —
  codex.danielvaughan.com
- Repo evidence: `apps/mcp/src/tools.ts` (729-line hand mirror),
  `apps/backend/src/services/issueService.ts` (860 lines, 5 preview twins,
  hub for 5 other services), `.github/workflows/ci.yml` (MCP eval absent),
  `docs/roadmap.md` pre-flight debt list (ad-hoc scoping symptoms).

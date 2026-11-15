# Sprint 065 — Repo cleanup: dead code, duplication, bad abstractions, stale docs

**Goal.** Remove drift before it compounds: dead exports, ~100 copies of
hand-rolled helpers, routes acting as services, a 3k-line MCP mirror, and
docs/CI that describe a product that no longer exists. This is the tactical
layer under `docs/architecture-review-agentic.md` (R0–R5) — we dedupe and
de-leak now; the contract registry (R1) and module migration (R4) stay
separate work this sprint deliberately does NOT start.

**Non-goals.** No vertical-slice/module migration, no codegen registry, no
reorganization of `routes/` vs `services/` boundaries wholesale (R4's job).
No behavior changes except the explicitly-marked correctness fixes.

**Audit basis.** Three whole-repo inventories (dead code / duplication+leaks /
docs): 5 dead items, 58 abstraction findings, 60 doc findings. Dead code is
near-zero — the real debt is *copy-paste and mis-layering*, not litter.

---

## US1 — Correctness bugs hiding inside duplication (ship first)

These are live bugs found during the audit — fix before cosmetics.

1. **Raw `.parse()` → unhandled ZodError → 500.** Ten sites throw a generic
   500 instead of a Jira-shaped 400:
   `automation.ts:102,133,182,240`, `agentSessions.ts:89,101,137`,
   `bulk.ts:48,59,75`. Fix via shared `parseBody(schema, req)` (US3).
2. **`automation.ts` JQL path omits browse scope** (`:223-232`): the route
   compiles JQL and queries issues itself, missing `nonBrowsableProjectIds`.
   Route through `searchService` (US4.6).
3. **CSV emitter without escaping** (`releaseMgmt.ts:155-158`) — newlines in
   a summary break rows. Consolidate on the RFC-4180 emitter (US3).
4. **Error-shape violations**: `users.ts:123,190,282,318` put zod issues in
   `errorMessages[]` not `errors{field}`; `oauth.ts`/`scim.ts` emit
   `{error,details}` — route all through `jiraError`/`formatZodErrors`.
5. **`jiraServerClient` weak SSRF check** (`:56-78` `PRIVATE_HOST` regex, no
   DNS resolution): delegate to `lib/egress.ts` `assertPublicUrl` (the
   `jiraClient` twin already wraps it).
6. **Weak visibility twin still live** (residual 064 risk):
   `issueSecurityService.visibleIssuesWhere` covers gate 3 only and is still
   used on ~10 read surfaces (`searchService:147`, `boardService:255,298,749`,
   `sprintService:369`, `roadmapService:46`, `epicService:68`). Rename it to
   `securityGateWhere` to mark it as ONE gate, and port single-project callers
   to the `canSeeProjectId` + security-only pattern established in 064
   (reportService). Full `visibleIssueWhere` stays for multi-project queries.

## US2 — Dead code sweep (trivial, ~25 LOC)

Verified zero-reference removals:

- `IMPORT_ORDER` (`import/types.ts:83-95`) — superseded by `dependsOn`.
- `jqlSchema` (`lib/validation.ts:197`) — never referenced.
- `config()` alias (`config.ts:148-150`) — everything uses `loadEnv`.
- `bulkSelectionSchema` export (`routes/bulk.ts:81`) — stale "for tests" note.
- `JWT_SECRET` line (`apps/backend/.env.example:5`) — never read; SESSION_SECRET
  is the real var. Operator-confusing, not just dead.

## US3 — `lib/http.ts` + `lib/validation.ts` dedup wave (mechanical)

Single-source the per-route boilerplate. ~200 LOC net, kills whole classes of
"forgot the wrapper / divergent caps" drift.

| Helper | Replaces | Sites |
|---|---|---|
| `ah(handler)` | 11 local `wrap`/`ah`/`meAh` copies + 30 inline try/catchs | routes/* |
| `isDryRun(req)` + `markDryRun(res)` | 5 spellings + 18 hand-set headers | routes/* |
| `pageParams(req,{cap,default})` | ~18 divergent `Math.min/max` clamps | routes/* |
| `parseBody(schema, req)` | 10 raw `.parse()` 500s + `body()` copies that drop field errors | automation, agentSessions, bulk, screens, issueSecurity |
| `issueSelf(key)`/`resourceSelf` | ~15 inline `self:` URL templates | services/* |
| `sendCsv(res,name,rows)` | 4 divergent CSV emitters (1 broken) | reports, releaseMgmt, users, audit |
| `jiraDate(d)` | ~19 `toISOString().slice(0,10)` | services/* |

## US4 — Domain dedup wave (medium)

1. **Issue-key resolution**: `parseIssueKeyParts(key)` (pure) +
   `issueKeyToWhere` + `resolveIssueRef` (alias-aware) — replaces ~29
   `split('-')` sites that each uppercase/alias differently
   (`middleware/auth.ts:219`, `aiService`, `devService`, `importers`, …).
   Alias-divergence is a real correctness bug, not just duplication.
2. **`projectByKeyOr404(key)`** — ~10 copies of findUnique+404.
3. **`loadRuleManaged(req)`** — automation.ts's inline author/admin fork ×7.
4. **`canModifyAuthored(actor,row,kind,verb)`** — comment vs worklog OWN/ALL
   fork (`commentService:98`, `worklogService:448`).
5. **`lib/confirmToken.ts`** — HMAC confirm-token built 3×
   (issueService, userService, backupService); plus the
   strip-stale→dry-run→re-append dance in `proposalService:206` vs
   `copilotService:829` which already diverged.
6. **`searchService.issueKeysForJql(actor,jql,cap)`** — shared by
   automation.ts's ad-hoc path (fixes US1.2).
7. **`resolveUserRef`** — 3 different OR-sets (assignee resolver, JQL compiler,
   automation `actorOk`) → refs resolvable on one surface 400 on another.
8. **MCP `WRITE_EXTRAS` dead schema** — ~55 per-tool re-declarations of
   `idempotency_key`/`rationale` whose `.describe()` text is dead (~120 LOC,
   pure deletion in `tools.ts`).

## US5 — Layer repairs (routes → services; lib inversion)

- `routes/permissions.ts` (71 direct prisma calls — a whole domain in a route
  file) → `permissionDomainService`. `dev.ts` (31) → `devPanelService`.
- Domain logic out of routes: `automation.ts` mappers+authz →
  `automationService`; `me.ts` worked-merge → service; `agentSessions.ts`
  activity aggregation → `agentSessionService`.
- **lib→service inversion**: `lib/jobs.ts` imports event/security services and
  hosts the SSE hub — move SSE to `services/sseHub.ts`; invert
  `lib/fieldRegistry.ts`'s customFieldService import to types-only.
- **Cycle-breaking**: the ~8 `await import('../services/…')` idioms exist
  because hub modules create cycles — extract the shared types to `lib/`
  instead of dynamic imports (me.ts ×8, agentSessions, searchService).
- `KNOWN_FIELD_KEYS` list moves from `routes/issues.ts` into
  `services/fieldRegistry` (drift surface).
- `enforceIssueScope` contract cleanup: return `{issue|null}` or throw —
  current "writes the 404 AND returns bool" makes every caller know internals.

## US6 — God-file splits (the four 3k/2k/1.8k files)

Per-file, mechanical decomposition, no interface changes:

- `mcp/src/tools.ts` (3,041): delete WRITE_EXTRAS copies (US4.8), then split
  by domain into `tools/{issues,agile,meta,identity,…}.ts` with one `register`
  barrel. Full codegen is R1 — do not attempt here.
- `api/client.ts` (2,942): split into `api/{transport,types,endpoints/*}`;
  route the 2 `fetch()` bypasses (:1183,:2635) through `request()` for
  `ApiError` normalization.
- `issueService.ts` (1,862): split `issueKeys/issueFields/issueWritePlans/
  issueReads/issueResponse`; type the include via `Prisma.validator` →
  removes 53 `as never` casts.
- `jql/compiler.ts` (1,796): ~40-case field switch → per-field handler
  registry (unblocks CF-ordering work noted in roadmap).
- `openapi.ts` (1,331): no split — it gets deleted by R1 codegen later;
  leave as-is.
- `import/importers.ts` (1,722): split per-source (`csv/xml/jira`).

## US7 — Frontend dedup

- `SearchableSelect` + `useSearchPicker` — collapses 6 pickers
  (User/Assignee/Delegate/Group/Issue/EntityRef ≈875→~450 LOC); fixes the
  DelegatePicker absolute-positioning clip as a side effect.
- `useIssueWrite(issueKey)` hook — `markIssueWrite`+invalidate pair at 64
  sites / 14 components → one hook.
- `useCrud`/`CrudPage` for the 6 admin CRUD pages (~25% of ~1,900 LOC).
- `useDateFormat`/`formatDateTime` — replace ~20 inline `toLocaleString`.

## US8 — Docs hygiene wave

**Broken CI first (they'll fail when triggered):**
- `.github/workflows/deploy.yml` references `tests/smoke/smoke.mjs` —
  doesn't exist (3 doc referrers). Create the suite or remove the steps.
- `.github/workflows/restore-drill.yml` posts to `/rest/api/2/auth/login` —
  real path is `/api/internal/auth/login`.

**Env-truth reconciliation** (4 sources diverged: config.ts, env-reference,
two .env.examples):
- `HTTP_PORT` documented, `PORT` read; `JWT_SECRET` dead (US2);
  `INTERNAL_ACTOR_SECRET` listed for rotation — never read
  (internal HMAC derives from SESSION_SECRET);
  `EVENT_RETENTION_DAYS` default is 30 in code, docs say 90;
  env-reference omits all direct-read vars (SESSION_TTL_HOURS, TRUST_PROXY,
  AUTH_RATE_LIMIT, TRACKFORGE_SECRET_REF_ALLOW, DOCS_*, SCIM_RATE_LIMIT,
  OAUTH_DCR_*, TF_DISABLE_UI_RESTORE). Regenerate env-reference or
  parity-check it in CI (extend `docs-claims.mjs`).

**Frozen snapshots (most misleading):**
- `capability-matrix.md` — ~12 shipped features still marked "planned".
- `roadmap.md` §1 — baseline is a sprint-025 snapshot.
- `data-model.md` header — "17 domain models" vs ~50 in schema.prisma.
- `AGENTS.md` — "~31 tools vs 65 routes" vs ~62 tools / ~186 paths.
- `identity.md` deferred lists, `positioning.md` OAuth/image claims,
  `security-hardening.md` bcrypt→scrypt + "030" phantom sprint,
  `jira-divergences.md` D-006 SQLite + tool count, `automation.md`/`SECURITY.md`
  authz phrasing vs 064 gates.

**Phantom sprints**: 030 & 046 referenced by 12+ docs (incl. `hardening-
cadence.md`'s gate table) but never existed — write stub docs ("absorbed
into 035/059/064") or remove references. Also add "shipped — historical"
header convention to sprint docs rather than moving files (drift tests only
cover top-level docs).

**Stale comments** (agent-maintainer hazards): `permissionService.ts:11-13`
("no issue-archive feature"), `lib/jobs.ts:60` + `dispatchService.ts:4`
("until 016" stopgap that IS the mechanism), `automation.ts:1-4` header
contradicting its own canManage gates.

**Manifest `helpAnchors`** — dead metadata (HelpLink uses its own map):
either wire them or drop the field.

**Keep-as-history** (explicit non-actions): all 59 sprint docs, specs 001–052,
audits, research/ — they are load-bearing delivery history. Spec checkboxes
stale in 006–012 get annotated "delivered in sprint NNN" not deleted.

## DoD

- `pnpm typecheck && pnpm lint && pnpm audit` — zero warnings.
- Backend + frontend suites green (064 established ~922 backend).
- OpenAPI drift test + docs manifest test green (route/doc registries stay
  current — US5 moves must re-register paths).
- No new `as never`/`any` casts; the 53 existing issue-response casts drop
  to zero after US6.
- Error-shape conformance: zero raw `{error,details}` literals outside the
  error middleware; zero unhandled ZodError paths (grep-able).
- Dedup accounting: ≥300 LOC net removal excluding file moves; no duplicated
  helper introduced to satisfy a boundary (share via lib/, not copy).

## Risks

- `visibleIssuesWhere` rename touches ~10 callers across board/sprint/roadmap
  — mechanical but security-adjacent; port each caller deliberately.
- `parseBody`/`pageParams` change error *shape* on edge inputs — integration
  tests must run per wave, not at the end.
- tools.ts/client.ts splits are pure moves but huge diffs — land them early
  in the wave and rebase the user's WIP promptly.
- The user's WIP tree (230 files, sprints 052/061/063) overlaps several
  targets (issueService, client.ts, TopNav) — coordinate file ownership per
  wave to avoid rebase hell; do NOT fold their WIP into cleanup commits.

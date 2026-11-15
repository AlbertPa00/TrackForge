# Sprint 063 — Launch Wedge (Pre-GA Installable Proof)

| | |
|---|---|
| **Status** | Planned |
| **Milestone** | LW Launch wedge — pulls the launch-critical slice of 043 (publish pipeline), 053 (scope enforcement, MCP leg) and the agent-DX items no later sprint owns forward of the GA wave |
| **Theme** | Turn "agents are first-class" from a claim into three provable artifacts: installable, Jira-compatible, governable |
| **Depends on** | 016 (ops surface), 020 (MVP gate), 022–025 (daily-driver parity + H3), 048 + 050 (importers, docs portal) |
| **Intersects** | 053 — that sprint owns REST/`/api/internal` scope enforcement; 063 owns the **MCP call-time mirror** and the mcp-atlassian-CVE regression shape. Shared middleware merges carefully (see Risks). |
| **Unblocks** | Public repo flip + launch announcement; 043–046 shrink to release machinery and ops compliance |
| **Spec-kit folder** | `specs/063-launch-wedge/` |

> **Origin**: competitive research, 2026-11. "Agents are first-class" is now claimed by
> Linear (Agent Sessions API), Atlassian (Rovo MCP), Plane (`plane-mcp-server`,
> 30 tools × 207 actions), It's a Plan, Agentra, Specivo, Beads and Backlog.md.
> What none of them ship together: **Jira v2 wire-compat verified by a client
> harness**, a **per-write proposal layer with approve-with-edits**, and **dryRun +
> Idempotency-Key on every mutation**. This sprint makes those three provable on
> contact, and closes the table-stakes gaps — install, README, agent onboarding,
> ready-work discovery, scope-at-call-time — that would otherwise bury the wedge.
> Deferred on purpose: OAuth 2.1 provider (049 — PAT is acceptable for a self-hosted
> v1; remote-MCP OAuth is a fast-follow), two-way GitHub sync, semantic search,
> hosted agents, repo-native export.

## Goal

Three proofs a skeptical reviewer can verify in under an hour:

1. **Install proof** — `docker compose -f docker-compose.prod.yml up -d` on a clean
   host reaches `/readyz` green in ≤ 5 min, from a *published* image, no repo clone.
2. **Compat proof** — a scripted Jira v2 client harness runs against TrackForge and
   publishes its pass/diverge matrix into `docs/compatibility.md` in CI — not
   hand-edited claims.
3. **Agent proof** — from the README alone: `claude mcp add` → read issues → claim
   ready work → run a session → hit an approval gate → get approved. Every step
   scripted in the eval suite.

## Why now

The launch window's value is the provable moat, not feature count — the field has
more people, stars and capital. Unproven claims decay fast: every month the compat
and governance story stays unannounced, a competitor closes part of it. Doing this
before 043–046 (rather than inside them) also keeps the GA wave honest — release
engineering on a product nobody has tried to install is premature optimization.

## Scope

**In**:

- **T1 Public-repo artifacts**: root `README.md` (demo asset, feature matrix,
  quickstart, `claude mcp add` one-liner, link to compat matrix), LICENSE decision,
  `SECURITY.md` + disclosure channel, minimal `CONTRIBUTING.md`, repo
  description/topics checklist.
- **T2 Install**: publish `ghcr.io/trackforge/trackforge` on tagged versions;
  `.env.example` audit vs `docker-compose.prod.yml`; cold-install verification run;
  `docs/install.md` distilled from sprint-043 material.
- **T3 Agent onboarding**: `GET /llms.txt` + `docs/mcp.md`; verified MCP
  registration for stdio and remote HTTP; **read-only toolset** — write tools
  absent from `tools/list` *and* refused at call time.
- **T4 Ready-work + claim**: JQL `ready` / `blocked` predicates (inward `blocks`
  links all resolved); `POST /api/internal/agent/claim` — atomic top-ranked
  ready-issue delegate + session open; MCP `find_ready_issues` / `claim_issue`.
- **T5 Composite agent write**: `PUT /rest/api/2/issue/{key}` accepts `transition`,
  `comment`, `worklog` alongside `fields`/`update`, applied in fixed order in one
  transaction; `update_issue` MCP tool extended identically; `dryRun` previews the
  whole composite. Documented divergence from Jira (mcp-atlassian v0.24 does the
  same composition).
- **T6 Call-time enforcement proof**: every MCP tool enforces token scopes and
  project allow-list *at invocation*; regression tests in the shape of the
  mcp-atlassian advisories (GHSA-3r68-hf9h-887v / GHSA-wm45-qh3g-v83f):
  filtered tool callable → fail; read-scope token on write tool → fail;
  allow-listed-project bypass → fail; attachment tools can never reach
  server-local paths.
- **T7 Compat harness**: `tests/compat/jira-v2.mjs` (or `apps/mcp/eval` extension)
  drives the documented endpoint matrix; output renders the compat table in
  `docs/compatibility.md` via CI job; divergences carry reason + tracking ref.
- **T8 Positioning**: README comparison table limited to verifiable claims
  (vs Jira Cloud, Plane, Linear, It's a Plan, Beads); 60–90 s demo asset showing
  delegate → session → question → approve-with-edits → applied; maintainer-facing
  `docs/positioning.md`.

**Out**: OAuth 2.1 provider / DCR (049 — PAT + header auth documented for launch);
two-way sync to GitHub/Linear/Beads; semantic/pgvector search; hosted agent
runtime; acceptance-criteria as a first-class field (covered by a seeded project
template instead); pricing/hosted-cloud decisions; repo-native/JSONL mode.

---

## User stories

### US1 — Install proof (P0)

As an evaluator, I want the tracker running before I've formed an opinion.

1. **Given** a host with only Docker (no repo, no Node, no dev state), **When** I
   fetch `.env.example` + `docker-compose.prod.yml` and run
   `docker compose -f docker-compose.prod.yml up -d`, **Then** `/readyz` is green
   in ≤ 5 min using a *published* `ghcr.io/trackforge/trackforge:$TAG` image.
2. **Given** `.env.example`, **When** compared against every `environment:`/`env_file`
   reference in the prod compose, **Then** each var has a documented default or an
   explicit required marker — verified by a test that parses both files.
3. **Given** first boot, **When** migrations + seed run, **Then** a documented demo
   login works and the README's first JQL query returns issues.

### US2 — Public-repo readiness (P0)

As a maintainer, I want the repo to survive being made public.

1. **Given** the repo root, **When** a new visitor lands, **Then** `README.md`
   shows: one-line positioning, 30–60 s demo asset, quickstart, MCP registration
   one-liner, feature/compat matrix link, license badge.
2. **Given** a license decision (see DoD — recommendation: **AGPL-3.0**, matching
   Plane/It's a Plan/Boardupscale; agent-side tooling precedent is MIT but the
   hosted-strip-mining risk argues AGPL), **When** chosen, **Then** `LICENSE`
   exists and `package.json`/docs agree.
3. **Given** `SECURITY.md`, **When** reviewed, **Then** it names a disclosure
   channel, supported-version policy, and points at `docs/threat-model.md`.
4. **Given** the GitHub repo page, **When** configured, **Then** description/topics
   (`jira`, `issue-tracker`, `mcp`, `ai-agents`, `self-hosted`) and social preview
   are set — checked off in the launch checklist.

### US3 — Agent zero-to-delegation (P0)

As an agent (or its operator), I want to self-onboard without reading prose docs.

1. **Given** `GET {base}/llms.txt`, **When** fetched, **Then** it returns the
   agent-relevant index: MCP endpoint, auth (`Authorization: Bearer tfp_…`), doc
   map — the Linear `llms.txt`/`mcp.md` pattern.
2. **Given** the README's `claude mcp add` line, **When** run against a fresh
   install, **Then** the client lists tools and `whoami` returns the principal —
   asserted by an eval-suite scenario for both stdio and `--http` transports.
3. **Given** a read-scoped token or the `readonly` toolset URL/flag, **When** an
   agent connects, **Then** write tools are absent from `tools/list` **and**
   invoking one by name returns a permission error — the Linear `/mcp/readonly`
   and Plane toolset patterns combined.

### US4 — Ready-work discovery and atomic claim (P1)

As an agent, I want to find and take the next workable issue without racing other
agents — Beads' `ready` + leases, on the Jira data model.

1. **Given** `A blocks B` and `A` is unresolved, **When** I query
   `project = X AND ready`, **Then** `B` is excluded and `A` (if ready itself) is
   included; once `A` resolves, `B` appears. `blocked` is the inverse predicate.
2. **Given** two agents calling `POST /api/internal/agent/claim {projectKey}`
   concurrently on a 3-ready-issue set, **Then** each receives a *distinct* issue
   and a `running` session; the third caller gets `409 { errorMessages: ["no ready
   issues"] }` — no double delegation, proven by a concurrency test
   (`SELECT … FOR UPDATE SKIP LOCKED` or equivalent).
3. **Given** a claim by a token whose `approvalPolicy` is `always`, **When** the
   claim executes, **Then** the delegation write respects the gate (parks as a
   proposal) — claiming never bypasses the principal's own policy.
4. **Given** MCP, **When** I call `find_ready_issues` / `claim_issue`, **Then**
   they wrap the same semantics; `claim_issue` returns issue + `sessionId`.

### US5 — Composite write (P1)

As an agent, I want one call to do what takes three in Jira.

1. **Given** `PUT /rest/api/2/issue/{key}` with `{fields: {…}, transition: {id},
   comment: {body}, worklog: {timeSpentSeconds}}`, **When** it executes, **Then**
   steps apply in fixed order (fields → transition → comment → worklog) inside one
   transaction and the response reports each step's outcome.
2. **Given** the same body with `?dryRun=true`, **When** validated, **Then** the
   preview reports the post-state of every step without persisting.
3. **Given** a failure at step N (e.g. invalid transition), **When** the request
   runs, **Then** zero partial writes persist and the error names the failing step
   with allowed values where applicable.
4. **Given** `docs/compatibility.md`, **When** the composite ships, **Then** it is
   listed as an intentional extension (Jira needs separate calls; mcp-atlassian
   v0.24 composes the same way).

### US6 — Scope enforcement at call time (P0)

As a security reviewer, I want the mcp-atlassian failure mode to be impossible here.

1. **Given** a token with `scopes: ["read"]`, **When** `create_issue` is invoked
   directly by name, **Then** a permission error — not just absence from
   `tools/list` (regression test; the GHSA-3r68 pattern).
2. **Given** a token allow-listed to project `A`, **When** any tool resolves an
   issue/attachment/comment in project `B`, **Then** 403/404 identical to the REST
   leak tests (`tests/integration/leak.test.ts` pattern, extended to the MCP layer).
3. **Given** a toolset/tool filter, **When** a filtered-out tool is called by name,
   **Then** refusal at call time — filtering enforced at invocation, not listing.
4. **Given** attachment read/write tools, **When** supplied crafted ids/paths
   (`../`, absolute paths, symlink targets), **Then** only storage-layer keys are
   dereferenced — no client-supplied filesystem path ever reaches `fs`/S3
   (the GHSA-wm45 pattern).

### US7 — Compat harness (P0)

As a launch reader, I want the compat matrix generated, not asserted.

1. **Given** `tests/compat/jira-v2.mjs` exercising the documented endpoint matrix
   (issue CRUD, transitions, search/JQL, comments, attachments, worklogs, agile
   board/sprint, metadata), **When** run in CI (nightly + on-demand), **Then** it
   emits a machine-readable result file.
2. **Given** the results, **When** CI regenerates `docs/compatibility.md`'s matrix
   table, **Then** each cell is pass/partial/fail + note, and the README badge/link
   reflects the current pass rate.
3. **Given** a divergence found by the harness, **When** it lands, **Then** it is
   logged with reason + tracking ref — honest gaps feed 056/the audit wave, not
   shame-driven doc edits.

### US8 — Positioning (P1)

As a maintainer writing the launch post, I want defensible claims only.

1. **Given** `docs/positioning.md`, **When** reviewed, **Then** the wedge statement
   ("the only self-hosted, Jira-wire-compatible tracker where agent writes are
   governable") plus the comparison table cite verifiable evidence (eval results,
   compat matrix, doc links) — no unverifiable superlatives.
2. **Given** the demo asset, **When** recorded, **Then** it shows delegate →
   `running` session → `needs-answer` question → approve-with-edits → changelog
   attribution — the four beats no competitor demonstrates end-to-end.

## Edge cases

- `ready` on cross-project blockers: link-aware check must follow the resolved
  issue's status regardless of project; scoped tokens never learn a blocker exists
  in an invisible project (predicate degrades to visible-links-only, documented).
- `claim` fairness: concurrent claims on the same ranking must not starve —
  `SKIP LOCKED` (or rank+`FOR UPDATE` retry) with a bounded attempts loop.
- Composite vs `fields.status`: `transition` in a composite is legal; a literal
  `fields.status` in the same body stays rejected — error explains the difference.
- Readonly toolset with stdio transport: `--readonly` flag + `TF_TOOLSET=readonly`
  env must behave identically to the URL variant.
- Compat harness credentials: runs against a seeded fixture instance, never a
  shared dev DB; results commit only on `main` CI.
- `.env.example` drift: the US1 parse test must run in CI, not as a manual check.

## Functional requirements

- **FR-001**: Every write path reachable via MCP enforces scope and permission at
  invocation; "absent from `tools/list`" is never the enforcement mechanism.
- **FR-002**: `claim` is atomic — issue selection, delegate write, and session
  creation commit or fail together; exactly-once per issue.
- **FR-003**: Composite `PUT` is all-or-nothing within one transaction; step order
  and per-step outcomes are part of the contract (validation schema + OpenAPI +
  MCP tool description updated — the four contract surfaces all move together).
- **FR-004**: The compat matrix is CI-generated; hand edits to the matrix table
  fail CI (regeneration check).
- **FR-005**: README quickstart + `claude mcp add` are verified by script
  (eval-suite scenario), not by the author's memory.
- **FR-006**: New MCP tools are assigned to a toolset within the D21 budget —
  `find_ready_issues`/`claim_issue` join the agent toolset; `readonly` toolset
  excludes every mutation tool by construction (contract-level test).

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/agent/claim` | `{projectKey, jql?}` → `{issue, sessionId}`; atomic; 409 when nothing ready |
| PUT | `/rest/api/2/issue/{key}` | Composite: `fields`/`update` + `transition` + `comment` + `worklog`, one txn, dryRun-aware |
| GET | `/llms.txt` | Static agent-onboarding index (backend serves from `docs/mcp.md` link map) |
| — | JQL `ready` / `blocked` | Link-aware predicates in `jql/` compiler + autocomplete + `jql_help` |
| — | MCP `--readonly` / `?toolset=readonly` | Write tools absent at list, refused at call |
| — | CI job | Compat harness → regenerates `docs/compatibility.md` matrix |

## Data model changes

None anticipated — `claim` composes `delegate` + `AgentSession`. `ready` needs an
indexed join on `IssueLink` (inward `blocks` + resolved status); measure under the
50k perf fixture and add the index if the predicate misses the search budget
(016 US3). If a claim audit trail is wanted later it belongs in `AuditEvent`, not
a new table.

## MCP tools

`find_ready_issues`, `claim_issue`, `update_issue` (composite params). Eval
additions in `apps/mcp/eval/run.ts`: zero-to-delegation scenario (whoami → ready →
claim → emit_activity), readonly-toolset assertions, composite-update scenario.

## Success criteria

- **SC-001**: Cold install to `/readyz` green ≤ 5 min on a Docker-only host, timed
  and documented.
- **SC-002**: Eval suite: fresh install → `claude mcp add` (or equivalent
  registration) → claim a ready issue → activity visible — exit 0.
- **SC-003**: Read-scope token + readonly toolset: write tools absent at list
  *and* refused at call; cross-project access via MCP denied — tests committed
  failing-first where behavior is new.
- **SC-004**: Compat matrix regenerated by CI; pass rate and divergence list land
  in `docs/compatibility.md`; README links it.
- **SC-005**: Two-way claim race test — disjoint issues, zero double-delegation.
- **SC-006**: Composite `PUT` atomicity test — mid-sequence failure persists
  nothing and names the failing step.
- **SC-007**: `LICENSE`, root `README.md`, `SECURITY.md`, `llms.txt` merged; repo
  description/topics checklist complete.

## Risks

| Risk | Mitigation |
|---|---|
| Compat harness exposes embarrassing gaps | That's the point — publish honestly; fixes feed 056/audit wave; matrix shows trajectory |
| Claim races under multi-agent fleets | `FOR UPDATE SKIP LOCKED` + bounded retry; concurrency test is SC-005 |
| Toolset drift as tools grow | Contract-level test asserts every declared tool resolves to ≥1 toolset and `readonly` contains zero mutations (ties into D21 + 056) |
| Overlap with 053 on shared auth/proposal middleware | 053 ships REST/internal enforcement; 063 adds the MCP invocation leg + tests. If 053 lands first, reuse its destructiveness registry; if 063 lands first, declare MCP-side checks in a 053-shaped module |
| License debate stalls the sprint | Day-0 decision gate before any public-repo work; recommendation recorded (AGPL-3.0); Apache-2.0/MIT only with an explicit reason written into the decision |
| Demo/README work crowds out tests | SC-002 makes the demo itself a scripted eval — no unscripted demo claims |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md).
- [ ] **License decision recorded** in the sprint artifacts before any repo-prep work.
- [ ] README quickstart + MCP registration verified by a clean-room run (fresh clone, fresh env, Docker only).
- [ ] Compat matrix CI job committed; `docs/compatibility.md` regenerated, not edited.
- [ ] Every T6 test committed failing-first against the pre-fix code (leak-test pattern).
- [ ] `docs/positioning.md` merged; every comparison claim cites a verifiable source.
- [ ] Threat-model entries for the claim endpoint, composite write, readonly toolset, and compat-harness fixture (recurring obligation).
- [ ] New MCP tools assigned to toolsets (D21 budget) and added to `eval/run.ts`.

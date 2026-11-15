# Sprint 032 — JQL & Search Completion

| | |
|---|---|
| **Status** | Done — implemented 2026-11-16 (US1–US5 + SC-001 matrix) |
| **Milestone** | M4 Configurability & power |
| **Theme** | Jira parity — finishing §2.3/§10 JQL |
| **Depends on** | 010 (JQL engine, saved filters with favourites + share-with-all), 014 (CF refs), 015 (groups → `membersOf()`), 019 (version functions), 022 (votes/watches), 024 (worklog fields), 031 (`security` field) |
| **Unblocks** | Full §10.3 function set, history-powered queries, granular filter sharing |
| **Spec-kit folder** | `specs/032-jql-search-completion/` |

> **Replan corrections (2026-11-07, verified against Jira Cloud REST v2):** (1) filter favourites
> are **`PUT`/`DELETE /rest/api/2/filter/{id}/favourite`** (draft said POST). (2) Filter sharing
> uses Jira's share-permission API — `GET/POST /rest/api/2/filter/{id}/permission`,
> `GET/DELETE /filter/{id}/permission/{permissionId}`, `GET/PUT /filter/defaultShareScope` —
> extending 010's share-with-all; the `sharedScope/sharedTarget` columns below are superseded by
> `FilterSharePermission` rows (same model as 026 dashboards). (3) `starred`/`starred()` are
> removed (not Jira; dropped in 022). (4) `Flagged` is a CF since 014 — the JQL is
> `Flagged = Impediment` / `Flagged is not EMPTY`, not `flagged = true`. (5) Column chooser and
> favourites already exist in 010; this sprint only extends them.

## Goal

The JQL engine from 010 deliberately scoped to a field/function subset. Everything DESIGN
§2.3/§10.3 promises but no sprint delivers lands here:

- **Functions**: `membersOf()` (was explicitly deferred in 010), `updatedBy()`,
  `linkedIssuesOf()`, `currentLogin()`/`previousLogin()`/`lastLogin()`, `cascadeOption()`
  (014 CF), `watchers()`/`voters()` (022), `history`-adjacent helpers.
- **Function registry + tree-traversal pack**: functions are declared in a table
  (`name → arg schema → Prisma binding → doc string`), not hardcoded in the compiler — the
  registry ships the §10.3 set plus `subtasksOf(jql)`, `parentsOf(jql)`, `epicsOf(jql)`,
  `issuesInEpics(jql)`, `hasComments` (Appfire JQL-Extensions parity, a paid category, free
  here). Exposed to agents via `GET /api/internal/jql/functions` (A3 discoverability) and the
  future extension-manifest seam.
- **Operators**: `WAS`, `WAS IN`, `WAS NOT`, `CHANGED TO/FROM/BY/BEFORE/AFTER/DURING` —
  the history operators Jira analysts use daily.
- **Fields**: `votes`, `watches`, `Flagged` (CF), `security`, `component`,
  `fixVersion`, `affectedVersion` (019 landed), `worklogDate`, `environment`,
  `filter`/`savedfilter`, `projectCategory` (021), `epic link`/`parent` parity review.
- **Saved-filter polish**: share filters (group/role/project/public via 015), favorite,
  JQL `filter = "name"` / `filter = id` as a subquery.
- **Autocomplete**: field/function/operator coverage updated; `jql_help` MCP updated.

## Why now

Every dependency needed for these constructs exists after 029. This is the last JQL sprint —
after it, "our JQL is a subset" stops being true for all documented fields.

## Scope

**In**: the function/operator/field sets above; history operators compile to changelog
queries (006 data is already complete for post-006 changes); `membersOf` resolves through
015 groups; filter sharing UI + `filter` JQL field; `ORDER BY` on all new scalar fields;
`autocompletedata`/`suggestions` coverage for the new vocabulary.

**Out**: `issueHistory()`/`issuesFromReport()` (obscure, undocumented value — skip),
`~` relevance ranking (still regex/contains — OpenSearch deferred note stands),
`WAS` on multi-valued fields beyond status/assignee/priority (documented subset),
JQL over remote links (niche).

---

## User stories

### US1 — Group/user/linkage functions (P1)

As a user, I want Jira's social/linkage functions so real team queries work.

**Independent test**: `assignee in membersOf("backend")`, `reporter = updatedBy("me")`-style
queries return the right sets; `linkedIssuesOf("Blocks")`/`issue in linkedIssues(TF-1, is blocked by)` resolve.

**Acceptance scenarios**

1. **Given** `membersOf("group")`, **When** used as a value, **Then** it expands via 015 group membership; unknown group → Jira-style error naming it.
2. **Given** `updatedBy()`, **When** `assignee = updatedBy()` or `reporter in updatedBy("juan")`, **Then** changelog-derived user sets resolve.
3. **Given** `linkedIssues(issueKey)` / `linkedIssuesOf(linkType)` (Jira/ScriptRunner parity), **When** queried, **Then** link-joined sets return — including across projects.
4. **Given** `currentLogin()`/`previousLogin()`, **When** `updated >= currentLogin()`, **Then** session-derived timestamps resolve per user.

### US2 — History operators (P1)

As a lead, I want `WAS`/`CHANGED` so I can answer "what slipped/bounced" questions.

**Acceptance scenarios**

1. **Given** `status WAS "In Progress" BEFORE startOfWeek()`, **When** run, **Then** changelog-derived predicate matches; `CHANGED TO Done DURING (-1w, now())` similarly.
2. **Given** `assignee CHANGED FROM currentUser()`, **When** run, **Then** correct history semantics; unsupported field→operator combos 400 with a named reason (not silent wrong results).

### US3 — Field coverage & saved filters (P1)

**Acceptance scenarios**

1. **Given** `votes > 0`, `watches > 1`, `Flagged = Impediment`, `security IS NOT EMPTY`, `component = X`, `worklogDate >= -1w`, `projectCategory = Platform`, **When** queried, **Then** each resolves per 022 (votes/flags/watches), 019 (components), 024 (worklogs) and 021 (project categories) fields.
2. **Given** filter sharing `{scope: group|role|project|public}`, **When** `filter = "Team triage"` is used inside another JQL, **Then** it's inlined as a subquery honoring share scope (Jira parity).
3. **Given** autocomplete, **When** typing new vocabulary, **Then** suggestions cover all new fields/functions/operators.

---

## Edge cases

- History operators on fields never changed → empty set, not error.
- `membersOf` with nonexistent/inactive group → explicit error (Jira parity).
- Circular filter refs (`filter=A` inside A) → rejected at save and at eval (cycle guard).
- `updatedBy` on issues with no changelog → empty.
- `WAS` on non-history-safe fields (labels, CF arrays) → supported subset documented; rest 400.

## Functional requirements

- **FR-001**: All new constructs MUST compile through the existing parser/compiler — grammar extended, not bypassed.
- **FR-002**: Unsupported combinations MUST error explicitly, never silently degrade.
- **FR-003**: `filter` subqueries MUST respect share-scope visibility of the referenced filter.
- **FR-004**: `contracts/jql.md` MUST be regenerated as the grammar's source of truth (010 artifact updated).

## API surface

| Method | Path | Notes |
|---|---|---|
| — | `/search` | Extended grammar |
| GET/PUT | `/rest/api/2/filter/{id}` | Sharing fields |
| POST/DELETE | `/rest/api/2/filter/{id}/favourite` | Favorites |
| GET | `/rest/api/2/filter/favourite` · `/my` | Jira |
| — | `/jql/autocompletedata*`, `/jql/parse` | Coverage |
| GET | `/api/internal/jql/functions` | Function registry (name, args, doc) for agents/extensions |

## Data model changes

- **Filter** (from 010) gains `sharedScope`, `sharedTarget?`, favorites join table.
- No other tables — history ops read `ChangeItem` (006).

## MCP tools added

`jql_help` updated (full grammar), `share_filter`, `run_filter` gains share-awareness.
No new tools needed beyond scope updates — A8.

## AI-native checklist

- [x] Full grammar published via `jql_help`/contract (A3) — regenerated contract + MCP hint + `GET /api/internal/jql/functions` registry.
- [x] Errors name the unsupported combo + nearest valid form (A8) — matrix test asserts every deferred/invalid construct errors explicitly.
- [x] History ops documented for agent use ("find issues that regressed this week") (A1) — contract §History + `jql_help`.

## Success criteria

- **SC-001**: Every §10.3 documented function/field/operator works or errors explicitly — matrix test.
- **SC-002**: `WAS`/`CHANGED` verified against seeded changelog fixtures.
- **SC-003**: Shared-filter subquery works cross-project with scope enforcement.
- **SC-004**: Agent eval: "bugs that were In Progress last week and moved back" — correct JQL formed + executed.

## Risks

| Risk | Mitigation |
|---|---|
| History-operator semantics subtle (reopens, multi-hops) | Fixture-based golden tests per operator; documented semantics in contract |
| Changelog coverage gaps (pre-006 fields) | Documented: history queries only see post-006 data |
| Grammar ambiguity growth | `contracts/jql.md` regenerated + drift test |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] `contracts/jql.md` + `jql_help` regenerated; evaluator coverage updated (jqlmatrix.test.ts SC-001).
- [x] DESIGN §10.3 matrix annotated implemented/deferred per item.

## Completion notes (2026-11-16)

| Slice | Commit | Content |
|---|---|---|
| US1 | `b5b58c3` | Function registry + group/user/linkage/tree/date functions; `/api/internal/jql/functions`; `User.lastLoginAt/previousLoginAt` |
| US2 | `a4e53e1` | `WAS`/`WAS NOT`/`CHANGED` + FROM/TO/BY/DURING/BEFORE/AFTER/ON over ChangeItem; transitions now record from+to values |
| US3 | `73daa16` | `votes`/`watches`/`security`/`projectcategory`/`filter` fields; denormalized vote/watcher counts; CF-name operands; parse-time field validation |
| US4 | `93091c9` | Replan-corrected `FilterSharePermission` rows + Jira `/filter/{id}/permission` + `defaultShareScope` |
| US5 | `920651e` | `commentedBy`/`componentsLeadBy`/`projectsLeadBy` + `environment` + `epicLink` (incl. quoted `"Epic Link"`) |
| UI/MCP | `dd5f803` | Filter share editor, `share_filter` tool, perm name annotation |
| Matrix | `0c648df` | SC-001 matrix (79 checks) + `priority >` sequence-compare fix + DESIGN annotations |

**Deferred (explicit):** `cascadeOption` (no cascading CF type), `issueHistory`/`issuesFromReport`
(out of scope per sprint), `issueFunction` pseudo-field (issue-set functions hang off
`key`/`parent` instead), `WAS` beyond the documented history-safe field set, `~`
relevance ranking (OpenSearch note stands), JQL over remote links.

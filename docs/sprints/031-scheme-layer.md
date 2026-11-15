# Sprint 031 — Scheme Layer: Screens, Field Configurations, Issue-Type Schemes & Issue Security

| | |
|---|---|
| **Status** | **Done** — 10 slices: US4 issue security (predicate + eff column), comment/worklog visibility, screens+schemes, field configs, issue-type & workflow schemes, leak matrix, MCP, bindings UI, importers, perf gate (184-251ms p95 vs 360ms budget on 50k) |
| **Milestone** | M4 Configurability & power |
| **Theme** | Jira configuration parity (P0 data model, simplified UX — D18) |
| **Depends on** | 014 (field registry), 015 (permission service, roles/groups), 021 (admin console shell), 017 (importer extension contract) |
| **Unblocks** | Lossless import of Jira configuration (039 XML extends it), per-operation field control, sensitive-issue projects |
| **Spec-kit folder** | `specs/031-scheme-layer/` |

## Goal

The configuration layer split out of 014 and 015. Data model and REST follow Jira so imports
are lossless (D18); UX stays project-centric — admins edit "this project's create screen" and
the system manages the underlying scheme objects, with sharing across projects available but
never required.

- **Screens & screen schemes**: which fields appear on Create / Edit / View, per issue type.
- **Field configurations**: required / hidden / default value / description per field — plus
  **conditional rules** (behaviours): required-if / hidden-if / default-by context expression
  (e.g. required when `priority = High`), evaluated by the field engine at create/edit/transition.
  Rules are data in the field config — no scripting (covers the ScriptRunner-Behaviours use
  cases that never needed code).
- **Issue-type schemes**: which issue types a project offers (+ default type).
- **Workflow schemes**: per-issue-type workflow (009 FR-001 deferred "per-issue-type P3").
- **Issue security schemes & levels**: who can *see* an issue (DESIGN §15.3).
- **Comment & worklog visibility** restrictions (`visibility: {type: role|group, value}`), Jira field.

## Why here

These are high-complexity, lower-frequency needs. Shipping them after the MVP (M1) and the
daily-driver work (M2–M3) keeps the regression budget for issue-security filtering — which
touches every query — inside a mature hardening cadence.

## Scope (candidate)

**In**: screens/screen-tab-fields/screen schemes/issue-type-screen schemes; field configurations
+ field-configuration schemes; issue-type schemes; workflow schemes (issue type → workflow);
issue security schemes + levels + `fields.security`; comment/worklog `visibility`; project-centric
editors in project settings (Fields, Screens, Issue types, Security tabs) generating per-project
schemes; "share this configuration with project…" action; importer extensions for all of the
above.

**Out**: Jira's tabbed-screen designer drag-drop polish (functional ordering list instead),
field-configuration "renderer" switching (markdown only), notification schemes (029 owns).

## Candidate user stories

### US1 — Per-operation fields (P1)

1. **Given** a screen scheme for TF/Bug, **When** creating vs editing vs viewing, **Then** each shows only its screen's fields in UI and in `createmeta`/`editmeta`.
2. **Given** `PUT /issue` with a field not on the edit screen, **When** submitted, **Then** Jira's error `"Field 'x' cannot be set. It is not on the appropriate screen, or unknown."`.
3. **Given** default config, **When** no scheme is assigned, **Then** behaviour equals 014 (all context fields on all operations) — zero regression.

### US2 — Field configurations (P1)

1. **Given** `required: true` for "Risk Level" on TF/Bug, **When** creating without it, **Then** 400 `errors.customfield_NNNNN: "Risk Level is required."`; `createmeta` reports `required: true`.
2. **Given** `hidden: true`, **When** fetched, **Then** the field is absent from payloads/meta for that context (values retained).
3. **Given** a default value, **When** creating without the field, **Then** default applies.
4. **Given** a conditional rule `required when priority = High` on TF/Bug, **When** creating a High-priority bug without the field, **Then** 400 as for static required; on a Medium bug the same create passes; `createmeta` reports the conditional requirement so agents can pre-fill (A3).

### US3 — Issue-type & workflow schemes (P2)

1. **Given** an issue-type scheme without Epic, **When** creating in that project, **Then** Epic isn't offered in UI/createmeta; existing epics remain.
2. **Given** a workflow scheme mapping Bug → "Bug workflow", **When** a Bug transitions, **Then** the mapped workflow governs; changing the scheme requires the 009 status-mapping flow.

### US4 — Issue security (P1)

1. **Given** a security level "Developers only", **When** set via `fields.security`, **Then** ineligible users get 404 for the issue and it's filtered from search, boards, backlog, children, links, dashboards, reports, exports, webhooks/SSE and MCP.
2. **Given** filtering, **When** paginating, **Then** totals/counts are computed post-filter at the query layer (no "page of 50 shows 37").
3. **Given** subtasks of a secured parent, **When** viewed, **Then** they inherit visibility.

### US5 — Visibility-restricted comments/worklogs (P2)

1. **Given** `POST /comment {body, visibility:{type:"role", value:"Developers"}}`, **When** non-members view, **Then** the comment is absent (Jira shape).

## Key constraints

- **FR**: issue-security filtering MUST be a query-layer predicate shared by every read path — a single `visibleIssues(actor)` scope; architecture test as in 015.
- **FR**: default configuration MUST reproduce pre-sprint behaviour exactly.
- **FR**: every scheme object MUST be importable/exportable (017/039 extension).
- **Perf**: security predicate + CF JQL on 50k issues within the 014 budget (+20 %).

## Data model (candidate)

`Screen`, `ScreenTab`, `ScreenTabField`, `ScreenScheme`, `IssueTypeScreenScheme(+Entry)`,
`FieldConfiguration(+Item)`, `FieldConfigurationScheme(+Entry)`, `IssueTypeScheme(+Item)`,
`WorkflowScheme(+Mapping)`, `IssueSecurityScheme`, `SecurityLevel(+Member)`,
`Issue.securityLevelId`, `Comment.visibility`, `Worklog.visibility`.

## MCP (D21 admin toolset)

`manage_screens`, `manage_field_configuration`, `set_issue_security`; core tools gain
`visibility` on comments.

## Risks

| Risk | Mitigation |
|---|---|
| Security filtering leaks through one forgotten path | Single scope + architecture test + leak test that hits every read endpoint as an ineligible user |
| Scheme complexity reaches users | Project-centric editors; schemes are an implementation detail |
| Biggest regression surface in the plan | Scheduled right before hardening H5 (035) |

## Implementation status

### Slice 1 — US4 issue security (backend, this commit)

- Schema: `IssueSecurityScheme`, `SecurityLevel` (+ `SecurityLevelMember`),
  `Issue.securityLevelId`, `Project.issueSecuritySchemeId` — migration
  `20261115000000_031_issue_security`.
- Single shared predicate `visibleIssuesWhere(actor)` — composed into
  `executeSearch` (JQL, post-filter totals), `enforceIssueScope` (every
  issue route → Jira-style 404), `listBoardIssues`, `listBacklog`,
  `listSprintIssues`, `listChildren`.
- `canSeeIssue` single-issue check; subtasks inherit the parent level
  (effective level = own ?? parent).
- `fields.security` — set/clear at create + PUT + `update.security[].set`;
  default level auto-applies on create; serialized as `{id,name}`
  (effective, inherited shown for subtasks).
- Member kinds: `user`, `group`, `projectrole`, `reporter`, `assignee`,
  `projectlead`. Jira semantics: security applies to everyone (admins too).
- Endpoints: Jira `GET /rest/api/2/issuesecurityschemes[/{id}]`; admin CRUD
  `/api/internal/issuesecurityschemes` + `/{id}/levels` + `/levels/{id}`;
  project assignment `POST /api/internal/projects/{k}/issuesecurityscheme`.
- Tests: `security.test.ts` 8/8 + search/board/leak regressions 20/20.
- Note: `SET_ISSUE_SECURITY` is not in the permission catalog — level
  assignment is gated by `EDIT_ISSUES` for now (revisit before H5).

### Remaining (later slices)

- Screens/tabs, screen schemes, issue-type screen schemes; field configs +
  conditional behavior rules; issue-type schemes; workflow schemes.
- Comment/worklog `visibility`; project-centric admin UI; importer/exporter;
  MCP `manage_screens` / `manage_field_configuration` / `set_issue_security`;
  full leak-matrix test; 50k+20% perf gate.

### Slice 2 — comment/worklog visibility (this commit)

- `Comment.visibility` / `Worklog.visibility` JSON columns —
  Jira `{type:"role"|"group", value}`; migration
  `20261115010000_031_visibility`.
- Write path: POST/PUT comment + POST/PUT worklog accept `visibility`;
  target group/role validated (400 on unknown); `null` clears.
- Read path: `filterByVisibility`/`canSeeVisibility` share the
  issue-security `actorContext` (groups + per-project role names);
  restricted rows visible to author + matching members; list endpoints
  post-filter totals; single-GET → 404 existence-hiding; non-members
  cannot edit/delete what they cannot see.
- Tests: security.test.ts 9/9; worklogs+issues regressions 13/13.
- Caveat (documented): `timespent`/`worklog` aggregates in the issue
  response include restricted worklogs (Jira-compatible edge; revisit
  with the fields-response layer).

### Slice 3 — US1 screens & screen schemes (this commit)

- Schema: `Screen`/`ScreenTab`/`ScreenTabField`, `ScreenScheme` +
  `ScreenSchemeItem` (operation: default|create|edit|view),
  `IssueTypeScreenScheme` + `ScreenSchemeMapping` (issueType → scheme),
  `Project.issueTypeScreenSchemeId` — migration `20261115020000`.
- Resolution chain: ITSS mapping[issueType] ?? defaultScheme →
  item[op] ?? item[default] → screen → ordered field ids.
- Enforcement: `createmeta`/`editmeta` list only on-screen fields;
  create/PUT reject off-screen writes with Jira canonical
  `Field "x" cannot be set. It is not on the appropriate screen, or unknown.`
  (project/summary/issuetype/parent always allowed).
- Default: project with no ITSS is fully unrestricted (pre-sprint, SC).
- Endpoints: Jira `GET /rest/api/2/screens[/{id}|/{id}/tabs]`; admin CRUD
  `/api/internal/screens|screenschemes|issuetypescreenschemes` (+ /tabs,
  in-use guards); `POST /api/internal/projects/{k}/issuetypescreenscheme`;
  admin `GET .../resolved` debug view.
- Tests: screens.test.ts 5/5; issues+customfields+security regressions 36/36.

### Slice 4 — US2 field configurations & schemes (this commit)

- Schema: `FieldConfiguration` + `FieldConfigurationItem` (required /
  hidden / description / defaultValue + conditional `rules` JSON),
  `FieldConfigurationScheme` + `FieldConfigurationSchemeMapping`
  (issueType → config), `Project.fieldConfigurationSchemeId` —
  migration `20261115030000`.
- Resolution: mapping[issueType] ?? scheme.defaultConfig -> item set.
  Conditional rules evaluated against merged create/update context
  ({field,is|in|not|notIn}) — required-if / hidden-if / default-by-context.
- Enforcement: create/PUT reject hidden writes (`cannot be set`), missing
  required (Jira `is required`), and rule-required fields — after the
  screen gate; edit-context merged with stored values so conditional
  rules see the effective state.
- Defaults: config defaults applied in planCreate when field unprovided
  (before user CF writes).
- Metadata: `createmeta`/`editmeta` merge required/description/defaultValue
  and omit hidden fields. NOTE: meta lists registry fields only — hidden/
  required on non-registry writable columns (environment, security) still
  enforce on the write path.
- Endpoints: Jira `GET /rest/api/2/fieldconfigurations[/{id}]`; admin
  `/api/internal/fieldconfigurations|fieldconfigurationschemes` CRUD +
  `POST /api/internal/projects/{k}/fieldconfigurationscheme`.
- Tests: fieldconfigs.test.ts 8/8; issues+screens+customfields 32/32.

### Slice 5a — US3 issue type schemes (this commit)

- Schema: `IssueTypeScheme` + `IssueTypeSchemeItem` (ordered),
  `Project.issueTypeSchemeId` — migration `20261115040000`.
- `typesForProject(projectId)`: bound scheme -> ordered scheme types;
  unbound -> all types (pre-031 default preserved).
- Enforcement: createmeta type list + `issuetype` allowedValues filtered;
  per-type createmeta 404 for out-of-scheme type; create write rejected
  with Jira `The issue type selected is invalid.`
- Endpoints: admin `/api/internal/issuetypeschemes` CRUD (+in-use guard),
  `POST /api/internal/projects/{k}/issuetypescheme`.
- Tests: issuetypeschemes.test.ts 4/4.

### Slice 5b — US3 workflow schemes (this commit)

- Schema: `WorkflowScheme` (defaultWorkflowId) + `WorkflowSchemeItem`
  (issueType -> workflow), `Project.workflowSchemeId` — migration
  `20261115050000`.
- `getProjectWorkflow(projectId, issueTypeId?)`: bound scheme ->
  mapping[issueType] ?? scheme.default; else legacy `Project.workflowId`;
  else Simple. Single resolution point covers create initial status
  AND transition listing/execution.
- `initialStatusForProject` + transition paths now type-aware; IssueCtx
  gained `issueTypeId`.
- Endpoints: admin `/api/internal/workflowschemes` CRUD (+in-use guard),
  `POST /api/internal/projects/{k}/workflowscheme`.
- Tests: workflowschemes.test.ts 4/4 (Bug starts In Progress via BugFlow,
  Task via Simple default; Bug Fix vs Start Progress transitions);
  transitions+issues+its regressions 16/16.

### Slice 6 — US4 leak matrix + predicate closure (this commit)

- Closed remaining predicate gaps found by matrix audit:
  `exportIssuePrint` (bypassed scope via getIssueByKey — now canSeeIssue
  404), `listEpicIssues`, and all report resolvers (velocity, burndown,
  sprint-report, epic-report, CFD, control chart, time-tracking,
  timesheet, version, project-summary, org) — each now ANDs
  `visibleIssuesWhere(actor)` into its issue queries or filters sprint
  member histories through `visibleIds`.
- `actor` threaded through report routes and dashboard burndown/velocity
  gadget resolvers (which previously dropped it).
- leakmatrix.test.ts 5/5: 12 issue-scoped GETs 404 for non-member,
  write-op hiding, search/board/backlog/export-CSV filtering, epic
  children, secured epic 404, pie/project-summary/dashboard-gadget
  viewer-context filtering.
- Regressions: reports+reports28+dashboards+sprint+bulk+security 42/42.

### Slice 7 — MCP tools (this commit)

- `manage_screens`: screen CRUD + tabs, screen-scheme CRUD (op items),
  issue-type-screen-scheme CRUD + project assignment.
- `manage_field_configuration`: config CRUD (items incl. conditional
  rules) + scheme CRUD (default + per-type mappings) + project binding.
- `set_issue_security`: set/clear `fields.security` on an issue,
  `list_schemes` (Jira read), `assign_scheme` (project bind).
- Payloads verified against the admin schemas (tabs `{name,fields}`,
  screen-scheme `items`, itss `mappings[]`, fcs `mappings[]`).

### Slice 8 — Admin UI: project scheme bindings (this commit)

- `toProjectResponse` emits `schemeIds` {issueSecurity, issueTypeScreen,
  fieldConfiguration, issueType, workflow, notification} — TF-native
  extension next to avatarColor; every scalar binding is now readable
  via `GET /project/{key}`.
- Project settings → new "Schemes" section (admin-only): five dropdown
  pickers bound via `POST /api/internal/projects/{k}/*scheme`; "None"
  unbinds (project returns to unrestricted default).
- Client: fetchers for all five scheme lists + `assignProjectScheme`.

### Slice 9 — importer extensions (this commit)

- Real EntityImporters: `issueSecurityScheme` (levels + members,
  actorUser/group/role kinds, ExternalIdMap provenance + dedupe),
  `issueTypeScheme` (ordered `_issueTypeIds` via mapping endpoint,
  resolved through issue-type ExternalIdMap), `fieldConfiguration`
  (config + items incl. conditional rules via `/fields` paging).
- IMPORT_ORDER: scheme entities placed before component/version so
  project binding deps resolve in order.
- Explicit unsupported stubs (`plannedOpsForEmpty` sentinel path) for
  the nested scheme objects Jira Cloud REST cannot faithfully round-
  trip: `screen`, `screenScheme`, `issueTypeScreenScheme`,
  `fieldConfigurationScheme`, `workflowScheme` — reported in
  `job.report.unsupported`, never silently dropped. Export direction
  lands with 039 XML backup.
- discover() treats absent scheme endpoints as "nothing to import"
  (fixture/older-Jira compat): outer loop swallows 404.
- Fixed stale suite assertion: `attachment` has a real importer —
  `unsupported` now asserts remoteLink/dashboard present,
  attachment/workflow absent. import.test.ts 6/6.
- Regressions: security+leak+screens+fieldconfigs+issuetypeschemes+
  workflowschemes 37/37; backend typecheck clean.

### Remaining

- 50k perf gate (security predicate + CF JQL within 014 +20% budget).
- Real nested scheme importers (screen tabs/fields, scheme mappings)
  when a Jira fixture contract exists — 039 is the natural carrier.
- Full admin-console scheme management pages (021 shell); project
  settings bindings UI shipped.

### Slice 10 — perf gate: scalar predicate + effSecurityLevelId (this commit)

- 50k fixture gate FAILED at first measure: the relation-chain predicate
  compiled to ~25 LEFT JOINs (securityLevel + parent hops per OR branch)
  -> seq-scan + sort, p95 4.6-5.9s vs the 014 budget (+20% = 360ms).
- Fix: membership resolved ONCE per request into level-id sets; predicate
  is pure scalar columns + small IN lists, zero relation joins.
  `Issue.effSecurityLevelId` = own ?? parent's (denormalized, FK SetNull,
  indexed, backfilled) removes the parent self-join.
- eff maintained on every write path: create (own ?? parent), update
  security/parent + child cascade (`cascadeEffectiveSecurity`), epic
  add/remove, epic-unlink on delete, clone + sub-clone, importer.
- `canSeeIssue` reads eff directly — no parent fetch (one less roundtrip).
- Gate `perf:check:security`: baseline unbound + active (scheme bound to
  all 20 PERF projects, 10% issues secured, admin not a member = worst
  case). Results vs 360ms: baseline CF 246 / plain 184; secured CF 196 /
  plain 197 — ~25x faster than the join form. Correctness spot-check:
  PERF01 2500 total -> 2250 visible (exactly the 10% hidden).
- Regressions: security 9/9, leak 7/7, issues 6/6; typecheck clean.

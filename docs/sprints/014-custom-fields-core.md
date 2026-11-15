# Sprint 014 — Custom Fields Core

| | |
|---|---|
| **Status** | Done |
| **Milestone** | M1 Parity MVP |
| **Theme** | Jira parity — the biggest remaining P0, cut to one shippable slice |
| **Depends on** | 008 (editable fields, editmeta), 010 (JQL compiler — extended here), 013 (Story Points column → registered as CF facade, D19) |
| **Unblocks** | 015 (group-picker type), 017 (CF import), 019 (version/component pickers), 031 (screens/field configs build on the registry), 033 (CF swimlanes/columns) |
| **Spec-kit folder** | `specs/014-custom-fields-core/` |

## Goal

Ship a working custom-field engine in one sprint: admins define fields, scope options per
project, users set values on issues, and JQL finds them. Everything that *configures where
fields appear* (screens, field configurations, issue-type schemes) is deliberately split into
the 031 scheme-layer epic — today's behaviour ("every field the project has is on every
operation") stays the default.

## Why now

Custom fields are DESIGN P0 and the first thing a Jira migration needs (017). Shipping the
engine before the importer means imported CF data has somewhere lossless to land.

## Scope

**In**:
- **Field registry** (D19): one registry describing every field — system fields (summary,
  labels, …) and custom fields — with `id`, `name`, `schema`, `searcherType`, `storage adapter`.
  `/field`, `createmeta`, `editmeta`, JQL and issue serialization all read the registry.
  Field **types** are a registry too (`type → {zod schema, searcher, serializer, renderer,
  importer}`) — a new type is a registry entry + renderer, never a refactor (the future
  extension-manifest seam).
- **CF types (13)**: text, textarea, number, date, datetime, select, multiselect, cascading
  select, user picker, URL, checkbox, radio, **checklist** (JSONB `{items:[{text,done}]}` in
  `CustomFieldValue`, checkbox-list renderer + progress chip on cards; display + API only, no
  JQL — kills the checklist-app category). Labels-type CF (P2 if time allows).
- **Contexts**: per-project option sets with a global fallback (DESIGN §6.4); a CF applies to
  a project only if a context includes it (this is also the "which fields does project X have"
  answer until 031).
- **Values**: storage in `CustomFieldValue` (JSONB, D10) with per-type validation, changelog,
  `update` ops (`set`/`add`/`remove` for multi-value).
- **System-managed CFs** (Jira models these as CFs): **Story Points** (storage = 013 column via
  adapter, no migration), **Flagged** (multi-checkbox, option "Impediment"), **Start date**
  (date). Each has a stable alias id (`story_points`, `flagged`, `startdate`) besides its
  `customfield_NNNNN`.
- **JQL**: `cf[10042]`, `"Field Name"`, per-type operators (§6.2), `ORDER BY` on scalar CFs.
- **Admin**: CF CRUD + context/options API; minimal admin table UI under project settings
  (full console consolidation in 021).
- **Importer hook**: CF definitions/values import contract used by 017.

**Out** (with owner):
- Screens, screen schemes, field configurations (required/hidden/default), issue-type schemes → **031**.
- Version/component pickers → **019**; group picker → **015**; project picker → P3 backlog.
- Renderer switching (markdown only), CF type conversion of existing fields (P3; needs dry-run report).
- OpenSearch indexing — Postgres only (documented divergence; perf budget below).

---

## User stories

### US1 — Define and scope fields (P1)

As an admin, I want to create custom fields and choose which projects see which options.

**Independent test**: create select CF "Risk Level"; context A (TF: Low/Med/High), context B
(QA: S1–S4); `createmeta` for TF and QA lists different `allowedValues`; project MOB (no
context) doesn't list the field.

**Acceptance scenarios**

1. **Given** admin, **When** `POST /api/internal/customfields {name, type, description?}`, **Then** the field gets a sequential `customfield_NNNNN` id (starting 10000, Jira convention) and appears in `GET /rest/api/2/field` with `custom: true`, `schema.custom`, `clauseNames: ["cf[10000]", "Risk Level"]`.
2. **Given** contexts (`POST /api/internal/customfields/{id}/contexts {projectKeys[] | global, options[]}`), **When** issues in TF vs QA load metadata, **Then** each sees only its context's options; global context covers unlisted projects.
3. **Given** a duplicate field name, **When** created, **Then** 400 `"A custom field named 'Risk Level' already exists."` (JQL ambiguity guard).
4. **Given** a field with values, **When** deleted, **Then** `dryRun=true` reports affected issue count; confirm soft-deletes (`active=false`), hides it everywhere, keeps values for audit (Jira hard-deletes — divergence documented).

### US2 — Values on issues (P1)

As a user, I want to see and edit custom fields on the issue page and via the API.

**Acceptance scenarios**

1. **Given** an issue, **When** `GET /issue/{key}`, **Then** `fields.customfield_NNNNN` holds Jira-shaped values (select → `{id, value}`, multi → array, user → user object, cascading → `{id, value, child:{id,value}}`, number → number, date → `"YYYY-MM-DD"`); `expand=names` returns the `names` map and `expand=schema` the schema map (Jira).
2. **Given** `PUT /issue/{key}` with `fields.customfield_NNNNN` or `update.customfield_NNNNN:[{add|remove|set}]`, **When** saved, **Then** per-type validation applies, an invalid option returns `errors.customfield_NNNNN` listing allowed values (A8), changelog records `fromString`/`toString`.
3. **Given** the issue detail page, **When** rendered, **Then** CFs from the project's contexts appear under Details using `InlineEdit` variants (input/number/date/select/multi-chip/user picker/cascading).
4. **Given** `POST /issue` with CF values, **When** created, **Then** values persist and appear in `createmeta`-driven create dialog fields.

### US3 — Search and sort (P1)

As a user, I want JQL over custom fields.

**Acceptance scenarios**

1. **Given** `"Risk Level" = High`, `cf[10000] in (High, Med)`, `"Story Points" >= 3`, `"Start date" <= endOfMonth()`, `Flagged = Impediment`, `"Risk Level" is EMPTY`, **When** run, **Then** results are correct per the §6.2 operator table; unsupported operator for a type returns a Jira-style error naming field + operator.
2. **Given** `ORDER BY "Story Points" DESC`, **When** run, **Then** ordering is correct with nulls last (Jira).
3. **Given** a 50k-issue fixture, **When** CF equality/range queries run, **Then** p95 < 300 ms (perf budget; GIN on `value` + expression indexes for numeric/date CFs — D10).

### US4 — System-managed CFs (P1)

As a maintainer, I want Story Points, Flagged and Start date to behave like Jira CFs without data churn.

**Acceptance scenarios**

1. **Given** 013's `Issue.storyPoints`, **When** 014 ships, **Then** `/field` lists Story Points as `customfield_NNNNN` with alias `story_points`; reads/writes via either id hit the existing column; backlog totals are byte-identical before/after (no migration).
2. **Given** Flagged, **When** set to `[{value:"Impediment"}]`, **Then** the field shape matches Jira's Flagged CF; boards/cards can render the flag (UI in 022/033).
3. **Given** Start date, **When** set, **Then** it's queryable (`"Start date"`/`startdate`) and available to the roadmap epic (041) — no separate column added later.

---

## Edge cases

- Context removed while issues hold values → values kept, rendered read-only, dropped on next edit (Jira).
- Cascading child option without parent → 400.
- User-picker CF pointing at a deactivated user → value kept, rendered "inactive user".
- Option renamed → stored by option id, so history and JQL by id remain stable; JQL by name uses current name.
- Required-ness: none in this sprint (field configs are 031) — documented so agents don't expect it.

## Functional requirements

- **FR-001**: All field consumers (serializer, `/field`, createmeta/editmeta, JQL, changelog, importer) MUST resolve fields through the registry — no hardcoded field lists remain.
- **FR-002**: CF ids MUST be `customfield_NNNNN`, sequential, never reused.
- **FR-003**: API shapes MUST follow Jira; storage MAY differ (D19).
- **FR-004**: CF writes MUST record actor/channel changelog items and honour `Idempotency-Key`/`dryRun` (A2/A4).
- **FR-005**: CF JQL MUST meet the perf budget in US3.3 or fail CI's perf check.
- **FR-006**: `fields=` selection (`*all`, `*navigable`, `-customfield_X`, `customfield_X`) MUST work with CFs (007 contract).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/api/2/field` | Registry-backed; CFs included |
| GET/POST | `/api/internal/customfields` · PUT/DELETE `/{id}` | Admin CRUD (Jira's CF admin REST is app-scoped; native here, documented) |
| GET/POST | `/api/internal/customfields/{id}/contexts` · PUT/DELETE `/{ctxId}` | Contexts + options |
| — | `GET /issue?expand=names,schema` | Jira expansions |
| — | `createmeta` / `editmeta` / `/search` | Registry-driven |

## Data model changes

- **CustomField** (`id` string `customfield_NNNNN`, `seq` int unique, `name` unique, `type`, `searcherType`, `description?`, `active`, `systemManaged`, `alias?`).
- **CustomFieldContext** (`fieldId`, `isGlobal`) + **CustomFieldContextProject** (`contextId`, `projectId`) + **CustomFieldOption** (`contextId`, `value`, `parentId?`, `position`, `disabled`).
- **CustomFieldValue** (`issueId`, `fieldId`, `value Jsonb`, unique pair) + GIN index; numeric/date expression indexes per D10.
- No `Issue` column changes (Story Points stays; Flagged/Start date live in `CustomFieldValue`).

## MCP tools

Extends existing tools rather than adding many (D21): `update_issue`/`create_issue` accept CF ids
or names; `get_create_meta` returns CF allowed values. New: `list_custom_fields`; admin toolset:
`manage_custom_field` (create/update/context, dry-run).

## AI-native checklist

- [x] Agents discover CFs, options and operators from metadata only (A3).
- [x] Invalid CF values return allowed values in the error (A8).
- [x] Delete/soft-delete is previewable (A4).

## Success criteria

- **SC-001**: Define → scope → set (UI, REST, MCP) → JQL → sort round-trip passes e2e.
- **SC-002**: Story Points totals unchanged after registry switch-over (fixture diff = 0).
- **SC-003**: Perf budget met on the 50k fixture (introduced in 016's seed; until then a local fixture).
- **SC-004**: Agent eval: "set Risk Level High on TF-3, then list High-risk bugs" succeeds with no invalid call.

## Risks

| Risk | Mitigation |
|---|---|
| Registry refactor touches serialization everywhere | Land registry first behind existing outputs (snapshot tests of current payloads must stay identical) |
| JSONB query performance | Index plan in D10 + perf test in CI |
| Scope creep into screens/configs | Hard Out-list; 031 owns it |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] Payload snapshot tests prove no change for non-CF fields.
- [x] `docs/fields.md` documents the registry and the system-field vs CF rule (D19).
- [x] Importer contract for CFs documented for 017.

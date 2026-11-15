# Fields registry & custom fields

TrackForge resolves **every** field — system or custom — through one registry
(`apps/backend/src/lib/fieldRegistry.ts`). Issue serialization, `/rest/api/2/field`,
createmeta/editmeta, JQL, changelog, `names`/`schema` expansions and the importer
all read from it. No consumer keeps its own field list.

## Two kinds of fields (D19)

| | System fields | Custom fields |
|---|---|---|
| Id | `summary`, `assignee`, `labels`, … | `customfield_NNNNN` (sequential, never reused, from 10000) |
| Defined in | `lib/systemFields.ts` (`FIELD_DEFS`) | `CustomField` table |
| Storage | `Issue` columns / relations | `CustomFieldValue` JSONB |
| Deletable | No | Soft-delete (`active=false`), previewable via `?dryRun=true` |

**System-managed custom fields** bridge the two: Story Points, Flagged and Start
date are real `CustomField` rows (seeded, `systemManaged`) with stable aliases —
`story_points` maps to the `Issue.storyPoints` column via a storage adapter, so
Sprint 013 data needed no migration; `flagged` and `startdate` store normal CF
values. Writes via the alias or the `customfield_NNNNN` id are equivalent.

## Type registry

`lib/cfTypes.ts` maps each field `type` to `{zod parse, Jira schema, searcher,
serializer, toDisplay, updateOps, jqlOps}`. Adding a type = adding a registry
entry, never a refactor.

| Type | Jira `schema.type` | Stored / returned shape | JQL ops |
|---|---|---|---|
| `text`, `textarea`, `url` | `string` | string | `= != ~ !~ IS [NOT] EMPTY` |
| `number` | `number` | number | `= != > >= < <= IN` + `IS` |
| `date`, `datetime` | `date`/`datetime` | `"YYYY-MM-DD"` / ISO 8601 | comparisons + `IS` |
| `select`, `radio` | `option` | `{id, value, self}` | `= != IN NOT IN IS` |
| `multiselect`, `checkbox` | `array<option>` | `[{id, value, self}]` | `= != IN NOT IN IS` |
| `cascading` | `option` | `{id, value, child:{id,value}}` | `= != IN NOT IN IS` |
| `user` | `user` | Jira user object | `= != IN NOT IN IS` |
| `checklist` | `checklist` | `{items:[{text,done}]}` | — (not searchable) |

Options are stored **denormalized as `{id, value}`** so reads never join; the
serializer refreshes `value` from current options (rename-safe). `IS EMPTY`
covers scalar CFs; `ORDER BY <cf>` works on orderable (scalar) types with EMPTY
sorting last in both directions.

## Contexts

A `CustomFieldContext` is either global or scoped to projects
(`CustomFieldContextProject`). A field applies to a project iff a global context
exists or a context lists the project — this is also the answer to "which fields
does project X have" until the scheme layer (sprint 031). Applicable options are
the merge/dedup of the matching contexts' `CustomFieldOption` rows.
`createmeta`/`editmeta` surface them as `allowedValues`; validation rejects
values outside them with the allowed list in the error (A8).

## Admin API (TrackForge-native, `/api/internal/customfields`)

Jira's CF admin REST is app-scoped, so administration is native:

- `GET /` — list (`?includeInactive=true`); `POST /` — create `{name, type, description?, context?}`
- `GET /{id}` · `PUT /{id}` — read/rename · `DELETE /{id}` — soft-delete (`?dryRun=true` reports affected issues)
- `POST /{id}/contexts` · `PUT/DELETE /{id}/contexts/{ctxId}` — contexts + options (cascading: `{value, children[]}`)
- `GET /{id}/options?project=KEY` — option listing for pickers

Reads are authenticated; mutations require admin. All mutations are audited.

## JQL

- `cf[10042]`, `customfield_10042`, the alias, or `"Field Name"` all resolve.
- Option values match by name or id; unknown values produce Jira-style errors.
- Autocomplete lists CFs (id, alias, name) and suggests option values.
- Unknown non-CF field names still fail in the parser; `cf[N]`/quoted names
  resolve in the compiler so inactive fields produce a clean "does not support
  searching"/"unknown field" error.

## Importer contract (for sprint 017)

1. **Definitions**: `POST /api/internal/customfields` per Jira field — TrackForge
   assigns its own `customfield_NNNNN`; keep a `jiraFieldId → tfFieldId` map.
   Field types map onto the registry types above; unmapped types → `text` + the
   original JSON in `description` for traceability.
2. **Contexts/options**: `POST /{id}/contexts` with `projectKeys` + `options`
   (cascading via `children`). Option ids are assigned — keep `jiraOptionId →
   tfOptionId`; write values by **id**, never name.
3. **Values**: `PUT /rest/api/2/issue/{key}` `fields.<tfFieldId>` using the
   Jira-shaped writes in the type table; or bulk via `fields` on create.
4. **System-managed**: map Jira's Story Points/Flagged/Start date onto the
   seeded aliases (`story_points`, `flagged`, `startdate`) — do not create
   duplicates.
5. Values for fields whose context doesn't cover the issue's project fail
   validation — create the project context first.

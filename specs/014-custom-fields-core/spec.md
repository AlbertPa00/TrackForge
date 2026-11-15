# Spec — Sprint 014: Custom Fields Core

> Mirrors `docs/sprints/014-custom-fields-core.md`. Records implementation decisions.

## Goal

Ship a working custom-field engine: admins define fields, scope options per
project via contexts, users set values on issues, JQL finds them, and every
field consumer resolves through one unified registry (D19).

## Implemented user stories

- **US1 Define and scope fields** — `POST /api/internal/customfields` creates
  fields with sequential `customfield_NNNNN` ids (from 10000); contexts are
  global or project-scoped with per-context option sets; duplicate names → 400;
  delete is a dry-run-previewable soft-delete reporting affected issue counts.
- **US2 Values on issues** — `fields.customfield_NNNNN` in responses holds
  Jira-shaped values (select `{id,value,self}`, multi `[{id,value}]`, user
  object, cascading `{id,value,child}`, checklist `{items}`); PUT `fields` +
  `update` ops (`set`/`add`/`remove`) with per-type validation; option errors
  list allowed values; changelog items record `fieldtype=custom`; issue detail
  renders CF rows under Details with type-appropriate inline editors; the
  create dialog renders `customfield_*` entries from createmeta.
- **US3 Search and sort** — JQL resolves `cf[NNNNN]`, `customfield_NNNNN`,
  aliases and display names; per-type operators (text `~`, number/date
  comparisons, option/user `IN`, `IS [NOT] EMPTY`); `ORDER BY` on scalar CFs
  with EMPTY last in both directions; autocomplete lists CFs + option values.
- **US4 System-managed CFs** — Story Points (`alias story_points` →
  `Issue.storyPoints` adapter, zero data migration), Flagged (`flagged`,
  Impediment option), Start date (`startdate`) seeded as `systemManaged`
  CustomField rows; reads/writes via alias or cf id equivalent.

## Decisions

- **Unified registry** (`lib/fieldRegistry.ts`): `RegistryEntry` merges
  `FIELD_DEFS` (`lib/systemFields.ts`) + active `CustomField` rows. All
  consumers — `/field`, createmeta/editmeta, issue serializer, JQL
  parser/compiler/autocomplete, changelog, importer contract — resolve here.
- **Type registry** (`lib/cfTypes.ts`): type → `{parse, serialize, toDisplay,
  searcher, updateOps, jqlOps, jiraType}`. 13 types.
- **Denormalized option refs**: stored `{id, value}`; serializer refreshes
  `value` from current options → rename-safe, no join on read. User values
  store the Jira user shape (denormalized at write).
- **System-field snapshots**: `toIssueResponse` stays sync; `cfFields` opt-in
  merge before `fields=` filtering; `toIssueResponseWithCf` hydrates
  asynchronously for direct reads; list endpoints batch-hydrate.
- **Parser vs compiler**: unknown plain names still parse-error; `cf[N]` and
  `customfield_*` tokens defer to the compiler for registry resolution.

## API surface added/changed

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/api/2/field` | now async, registry-backed, `custom:true`+`clauseNames` on CFs |
| GET/POST | `/api/internal/customfields` | list (auth) / create (admin) |
| GET/PUT/DELETE | `/api/internal/customfields/{id}` | read / rename / soft-delete (`?dryRun`) |
| POST/PUT/DELETE | `/api/internal/customfields/{id}/contexts[/{ctxId}]` | contexts + options |
| GET | `/api/internal/customfields/{id}/options?project=` | picker listing |
| — | createmeta / editmeta / `/search` / issue reads+writes | registry-driven; CFs in values, meta, changelog, names/schema |

## Data model changes

- `CustomField` (`id customfield_NNNNN`, `seq` unique, `name` unique, `type`,
  `searcherType`, `description?`, `active`, `systemManaged`, `alias?`)
- `CustomFieldContext` + `CustomFieldContextProject` + `CustomFieldOption`
  (`parentId?`, `position`, `disabled`)
- `CustomFieldValue` (`issueId`,`fieldId` unique pair, `value` Jsonb + GIN)

## MCP tools

`list_custom_fields`; `manage_custom_field` (create/rename/deactivate/
set_options, admin, dry-run); `create_issue.custom_fields` and
`update_issue.custom_fields` + `custom_field_ops` pass-throughs.

## Edge cases handled

- Option rename → stored refs refresh labels at serialization; JQL/history by
  id stays stable.
- `ORDER BY cf` sorts EMPTY last in both directions (deviation noted: Jira
  varies; keeps real values on top).
- Create/update responses patch `cfValues`/`storyPoints` in-memory after writes
  so response reflects values without refetch.
- Soft-deleted fields hide from registry/meta/JQL but keep values.

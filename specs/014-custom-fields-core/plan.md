# Plan — Sprint 014: Custom Fields Core

## Architecture

```
┌────────────────────────── apps/backend ──────────────────────────┐
│  prisma/schema  CustomField(+seq/alias/systemManaged),            │
│                 CustomFieldContext(+ContextProject),              │
│                 CustomFieldOption(parentId/position/disabled),    │
│                 CustomFieldValue(issueId+fieldId unique, Jsonb)   │
│  lib/systemFields     FIELD_DEFS moved out of metaService         │
│  lib/fieldRegistry    unified registry: system + CF, resolve by   │
│                       id / cf[N] / alias / name                   │
│  lib/cfTypes          type → parse/serialize/display/searcher/ops │
│  services/customFieldService  CRUD, contexts, optionsForProject,  │
│                       validate/serialize, cfFieldsForIssues       │
│  services/issueService        CF write planning + cfFields merge  │
│  services/createmetaService     registry-driven + allowedValues   │
│  jql/parser+compiler+routes     cf[N] resolution, per-type ops,   │
│                       ORDER BY, autocomplete                      │
│  routes/customfields  /api/internal/customfields* (admin)         │
└───────────────────────────────────────────────────────────────────┘
┌──────────── apps/frontend ────────────┐  ┌──────── apps/mcp ────────┐
│ CustomFields.tsx   CfDisplay/CfEditor/│  │ list_custom_fields,      │
│   CfFormInput for all 13 types        │  │ manage_custom_field,     │
│ IssueDetailPage    CF rows under      │  │ custom_fields +          │
│   Details (via editmeta)              │  │ custom_field_ops params  │
│ CreateIssueDialog  CFs via createmeta │  └──────────────────────────┘
│ CustomFieldsPage   admin table,       │
│   options editor, soft-delete dry-run │
└───────────────────────────────────────┘
```

## Key decisions

- **One registry, two sources.** `fieldRegistry` merges `FIELD_DEFS`
  (extracted to `lib/systemFields.ts` to break the metaService↔registry cycle)
  with active `CustomField` rows. Every consumer — `/field`, createmeta/
  editmeta, serializer, JQL, changelog, importer — resolves here (FR-001).
- **Denormalized value storage.** Option values store `{id, value}` and user
  values store the Jira user shape at write time; serializers refresh labels
  from current defs. Issue reads never join → serialization stays cheap and
  `toIssueResponse` stays sync (values merged via a `cfFields` opt-in).
- **Story Points facade.** `story_points` is a system-managed CustomField with
  a storage adapter to `Issue.storyPoints` — registry switch-over with zero
  data churn (US4); `flagged`/`startdate` store normal CF values.
- **Context = "does this project have this field".** Global fallback +
  project-scoped option sets; applicable options merged/deduped across
  matching contexts. Scheme layer (031) owns screens/required-ness later.
- **JQL split**: parser keeps rejecting unknown plain names; `cf[N]` /
  `customfield_*` / quoted names defer to the compiler so inactive fields fail
  cleanly.
- **Soft-delete, not hard-delete** — `active=false` hides everywhere, keeps
  values for audit; `?dryRun=true` previews the affected-issue count (A4).

## Post-mortems

- `created`/`u` rows were fetched before CF writes → responses showed nulls;
  the rows are now patched in-memory from `cfWrites` after each write.
- Admin option input only accepted `{value}` objects — string shorthand added
  (`options: ["Low","High"]` works).
- `ORDER BY cf` initially put EMPTY first DESC → switched to EMPTY last in
  both directions.
- System-field snapshot test caught a real contract detail: unset
  `description`/`parent` serialize as `undefined` → JSON drops the keys.

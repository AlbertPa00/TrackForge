# Tasks — Sprint 014

- [x] T1 Schema+migration: `CustomField`, `CustomFieldContext`,
      `CustomFieldContextProject`, `CustomFieldOption`, `CustomFieldValue`
      + indexes (dev + test DBs, client regenerated)
- [x] T2 Field registry: `lib/systemFields.ts` extracted (no circular import),
      `lib/fieldRegistry.ts` unified resolution (id/cf[N]/alias/name),
      `lib/cfTypes.ts` 13-type registry (parse/serialize/display/searcher/ops)
- [x] T3 customFieldService: CRUD + contexts/options, sequential
      `customfield_NNNNN` ids, `optionsForProject` merge, validate/serialize/
      applyFieldOp, batch `cfFieldsForIssues`, soft-delete + dryRun,
      system-managed adapters (story_points)
- [x] T4 Issue values: `customfield_NNNNN` in `toIssueResponse` (cfFields opt),
      PUT `fields` + `update` ops, `.catchall` in schemas, per-type +
      allowed-values validation, changelog `fieldtype=custom`, event snapshot
      merge, list-endpoint hydration (search/sprint/epic/board)
- [x] T5 Metadata: `/field` async registry-backed; createmeta/editmeta include
      CFs with per-context `allowedValues`; names/schema expand
- [x] T6 JQL: parser defers cf[N]/customfield_* tokens; compiler resolves via
      registry with per-searcher clauses + `IS EMPTY` + ORDER BY; autocomplete
      fields + option suggestions
- [x] T7 Admin routes `/api/internal/customfields*` + OpenAPI + audit events
- [x] T8 Seed `seedSystemCustomFields` (Story Points/Flagged/Start date) —
      reserved seqs 10001–10003; test setup cleanup + seeding
- [x] T9 Backend tests — 21-test suite: registry snapshots, admin CRUD,
      contexts/options, values+ops, validation, changelog, system-managed
      aliases, JQL id/name/option/emptiness/order
- [x] T10 Frontend: `CustomFields.tsx` (CfDisplay/CfEditor/CfFormInput for all
      types), issue-detail CF rows via editmeta, create-dialog CF inputs via
      createmeta, `CustomFieldsPage` admin table + option editor + create
      modal + soft-delete confirm, `/settings/customfields` + nav item
- [x] T11 MCP: `list_custom_fields`, `manage_custom_field`,
      `create_issue.custom_fields`, `update_issue.custom_fields` +
      `custom_field_ops`
- [x] T12 `docs/fields.md` (registry + D19 rule + importer contract for 017),
      spec artifacts

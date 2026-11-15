# Plan (as executed)

1. Schema: Group, GroupMember, ProjectRole, ProjectRoleActor, PermissionScheme, PermissionGrant, Project.permissionSchemeId → migration `20261107220000_permissions_core` (dev + test).
2. `services/permissionService.ts` — PERMISSIONS, HOLDER_TYPES, holder evaluation, WeakMap request memo, hasPermission/requirePermission, userInProjectRole/userInGroup, nonBrowsableProjectIds, myPermissions.
3. `routes/permissions.ts` — Jira API surface mounted at `/rest/api/2` + `/rest/api/2/project`.
4. `seedPermissionDefaults()` — default groups/roles/scheme/grants/actors; runs in seed chain, test setup, and `createProject`.
5. Enforcement: services write checks; `enforceIssueScope` async + BROWSE→404 across all issue routes; `nonBrowsableProjectIds` in search + project list; project PUT → ADMINISTER_PROJECTS.
6. Workflow conditions (async conditionPasses) + `group` CF type.
7. Frontend: PeopleSection in ProjectSettingsPage (actors chips, add/remove, mypermissions-gated controls).
8. MCP tools + OpenAPI + docs/security-model.md + tests.

# Sprint 015 — Permissions Core (spec)

Implemented. See `docs/sprints/015-permissions-core.md` for user stories and
acceptance criteria, `docs/security-model.md` for the model, and
`apps/backend/tests/integration/permissions.test.ts` for the executable spec.

## Delivered
- Groups + membership (Jira `/group`, `/group/member`, `/group/user`; admin)
- Project roles + per-project user/group actors (Jira `/role`, `/project/{k}/role/{id}`)
- Permission schemes + grants with Jira holder types (`/permissionscheme*`)
- Project ↔ scheme assignment (`/project/{k}/permissionscheme`, dryRun impact)
- `/mypermissions` (permissions param required, Jira-shaped flags)
- `permissionService` single funnel: WeakMap request memo, site-admin bypass,
  holder-type evaluation incl. group-derived role membership
- Enforcement in services (REST/MCP/proposals/post-functions identical),
  `enforceIssueScope` now async + BROWSE → 404, search/project-list scoping
- Workflow conditions `userInRole` / `userInGroup` / `hasPermission`
- `group` (group-picker) custom-field type
- Default scheme seeded to pre-015 access (FR-002); groups/roles/actors wired
- People section in project settings; last-Administrators guard
- MCP: get_my_permissions, manage_groups, manage_project_roles, manage_permission_scheme
- Architecture test + meta-test (SC-003)

## Deferred (per sprint doc)
- Issue security schemes/levels, comment/worklog visibility → 031
- Scheme editor polish / global admin console → 021
- LDAP/SCIM → Later

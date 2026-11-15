# Security model

Sprint 015 replaced "site admin vs everyone + token allow-lists" with Jira's
authorization model at the data/API level (D18).

## Layers (both must pass)

1. **Authentication** — session cookie, PAT (Bearer/Basic), or internal
   `x-trackforge-internal` actor. Deactivated users cannot authenticate.
2. **Token layer** — PAT `scopes` (read/write/admin) and `projectKeys`
   allow-list. A token scoped out of a project gets 404 (existence
   protection), regardless of user permissions. The allow-list applies to
   API tokens only (`actor.token`): interactive **session** auth carries
   the user's full rights by design — sessions are the user, so narrowing
   them would break the UI; least-privilege belongs to tokens (H2-b).
   Write paths additionally evaluate the permission layer below (H3
   closed the agile-service gap — sprint/board/epic mutations previously
   checked nothing).
3. **Permission layer** — `permissionService` resolves project permissions
   from the project's `PermissionScheme`. Site admins bypass project
   permissions (Jira "Jira administrators" semantics) but are still audited.

## Permissions (§15.1 subset)

`ADMINISTER_PROJECTS`, `BROWSE_PROJECTS`, `CREATE_ISSUES`, `EDIT_ISSUES`,
`TRANSITION_ISSUES`, `SCHEDULE_ISSUES`, `MOVE_ISSUES`, `DELETE_ISSUES`,
`LINK_ISSUES`, `ASSIGN_ISSUES`, `ASSIGNABLE_USER`, `ADD_COMMENTS`,
`EDIT_ALL_COMMENTS`, `EDIT_OWN_COMMENTS`, `DELETE_ALL_COMMENTS`,
`DELETE_OWN_COMMENTS`, `MANAGE_WATCHERS`.

## Holder types (Jira)

| Type | Parameter | Meaning |
|---|---|---|
| `applicationRole` | — | any logged-in user |
| `user` | userId | a specific user |
| `group` | group name | members of a group |
| `projectRole` | roleId | actors of the role in the project (direct or via group) |
| `projectLead` | — | `Project.leadId` |
| `reporter` / `assignee` | — | issue-scoped (needs an issue context) |

`applicationRole` covers agents only if the agent is an active user; Jira has
no agent concept — agents get access through role/group grants like humans.

## Evaluation

`hasPermission(actor, permission, {projectId, issue?})`:

1. `actor.user.isAdmin` → true (bypass, still audited).
2. Load project → `permissionSchemeId` (falls back to the Default Permission
   Scheme when unset).
3. Any grant of the permission whose holder matches → true.
4. Results are memoized **per request** (WeakMap keyed on the Actor object)
   — no cross-request cache.

`requirePermission` throws a Jira-shaped 403 naming the missing permission
in `errors.permission` (A8). Reads that fail `BROWSE_PROJECTS` return 404 —
inaccessible resources never leak existence (FR-003). Search/JQL excludes
issues in non-browsable projects.

## Enforcement funnel

Write checks live in the services every surface funnels through:
`issueService` (CREATE/EDIT/ASSIGN+ASSIGNABLE/DELETE),
`workflowService.performTransition` (TRANSITION_ISSUES + `userInRole` /
`userInGroup` / `hasPermission` conditions), `commentService`
(ADD + own/all edit/delete), `linkService` (LINK_ISSUES on both projects).
This makes REST, MCP, board drags, inline edits, bulk creates, proposal
replays, and post-functions enforce identically (SC-002). Read checks use
`enforceIssueScope` (BROWSE → 404) and `nonBrowsableProjectIds` in
search/project listing.

Admin mutations on groups/roles/schemes require site admin; project role
actors and scheme assignment require `ADMINISTER_PROJECTS` or site admin.
Removing the last Administrators actor of a project is blocked (US4.2).

## Default scheme (FR-002)

Seeded "Default Permission Scheme" reproduces pre-015 access: ordinary work
permissions → `applicationRole`; the admin tier (`ADMINISTER_PROJECTS`,
`EDIT_ALL_COMMENTS`, `DELETE_ALL_COMMENTS`, `MANAGE_WATCHERS`) →
Administrators role + `jira-administrators` group.
Default groups `jira-software-users` (all active users) and
`jira-administrators` are seeded and wired as group actors on every project;
project leads get a user actor in Administrators. New projects get the same
wiring via `createProject` → `seedPermissionDefaults`.

## Importer contract (017)

Import order: users → groups + memberships → roles → schemes + grants →
project scheme assignment → role actors. `holderParam` for `group` is the
group **name** (Jira-shaped); for `projectRole` the **roleId**; for `user`
the **userId/accountId**. Unknown permissions/holder types are rejected by
the grant API — map foreign permissions to the §15.1 subset first.

## Automation rules (034/035)

- Every rule write runs as its **actor** on `channel='automation'` through the
  normal service layer — identical validators, permissions, changelog, events.
- **Effective permissions = actor ∩ author**, enforced at save and re-evaluated
  on every run (`BROWSE_PROJECTS` on the scope project). Deactivating either
  user fails the run closed. Selecting a non-self actor requires site admin;
  project admins may only author project-scoped rules.
- Loop prevention is structural: automation-emitted events are post-annotated
  with the rule chain (`payload.automation`); same-rule skip + depth cap 5.
- Rule `webhook` actions reuse the SSRF guard (`assertPublicUrl`) + HMAC signing.
- `ask_agent` proposals replay through the standard approval flow; the prompt
  is fenced so issue content is data, not instructions.

## Outbound surfaces vs issue security (035)

- **SSE** live + backfill: per-client `canSeeIssue` on the subscribing actor —
  secured events never reach a non-member's stream.
- **Webhooks**: `requireAdmin` registration — an admin surface that receives
  full payloads by design (Jira parity). JQL filters can narrow deliveries.
- **Issue picker / dashboards / reports / exports**: all run the shared
  `visibleIssues` predicate per the caller's token — verified by
  `leakmatrix.test.ts` (035 extended: picker + `eventIssueVisible`).

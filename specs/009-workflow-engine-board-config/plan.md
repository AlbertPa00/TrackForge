# Sprint 009 plan

## Sequence

1. Schema: `Workflow`, `WorkflowStatus`, `WorkflowTransition`, `TransitionRule`, `Project.workflowId`, `Board`, `BoardColumn`, `BoardColumnStatus`, `Issue.rank` (indexed). Migration + `seedWorkflows`/`ensureProjectBoard`/`migrateToWorkflows`.
2. `lexorank.ts` — fixed-width base36 midpoint ranks + `spreadRanks` rebalancing.
3. `workflowService` — project workflow resolution, transition listing (conditions), `performTransition` (conditions → validators → fields → status move → post-functions → comment → changelog, dry-run preview), workflow CRUD, `assignWorkflowToProject` with status mapping.
4. `issueService` — initial status from workflow, rank on create, transitions delegated, `PUT fields.status` rejected.
5. `boardService` — persisted boards, `resolveBoard` (id or project key), column mapping, WIP, rank-sorted issues, `rankIssues` with rebalance.
6. Routes — real transition handlers, `/project/{key}/statuses`, `/workflow`, internal `/workflows` + `/projects/:key/workflow`, board config PUT, `PUT /issue/rank`.
7. Frontend — `TransitionScreenModal`, transition-aware `StatusTransitionMenu`, multi-status board columns + WIP headers + rank drag + drop modals, `BoardSettingsPage`, `WorkflowsPage`/`WorkflowEditorPage`, project-settings workflow switcher.
8. MCP — workflow/board tools per sprint doc.
9. Tests — migrate PUT-status tests to `transitionTo` helper; new transition contract tests (validators, screens, post-functions, global transitions); keep 86-test suite green.
10. Contracts + docs + verify + commit.

## Decisions

- **Board id = UUID with legacy key alias** (D7): `resolveBoard` accepts either; responses carry the UUID.
- **LexoRank = fixed-width base36** midpoints; rebalance via `spreadRanks` when a gap can't be subdivided.
- **Rank is project-scoped** (one ordering per project), matching Jira's rank-per-board-filter closely enough until 010 JQL filters.
- **WIP limits are advisory** (per US4.3): headers show `count / max` in red, drops are not blocked.
- `PUT /issue/{key}` keeps Jira semantics: `fields.status` → `400` rather than a silent ignore.

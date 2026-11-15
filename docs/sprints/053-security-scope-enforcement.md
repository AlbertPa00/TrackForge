# Sprint 053 — Security & Scope Enforcement (Audit P0 Wave)

| | |
|---|---|
| **Status** | Planned — permission-catalog parity portion landed in working tree (catalog 35 keys, scheme/role read gating, TRANSITION/RESOLVE/CLOSE gates, MANAGE_SPRINTS, MANAGE_WATCHERS, VIEW_* gates, `groupCustomField` holder, assignable-search filtering, `useIssuePermissions` extension) |
| **Milestone** | Post-GA (audit wave, ordered first — every finding is exploitable or data-corrupting today) |
| **Theme** | Close the authorization and data-integrity holes the deep audit confirmed; turn scattered checks into enforced invariants |
| **Depends on** | 015 (permission service), 031 (schemes + issue security), 022 (issue ops), 023 (bulk ops), 012 (proposals) |
| **Unblocks** | Trustworthy multi-tenant use; 054–058 land on a safe base |
| **Spec-kit folder** | `specs/053-security-scope-enforcement/` |

> **Origin**: deep codebase audit (frontend + backend + JQL + MCP + copilot). The permission
> *catalog* parity half is already landing; this sprint ships the remaining P0 holes —
> two `enforceIssueScope` bypasses, a workflow-condition bypass, a move-with-subtasks
> crash, assign-permission gaps, and the proposal-gate `/api/internal` escape hatch.

## Goal

- **No scope bypass paths**: `enforceIssueScope` must be correct for every issue reference —
  lowercase keys, moved-issue aliases (`IssueKeyAlias`), and security-level-restricted issues.
- **Workflow conditions mean what they say**: `onlyProjectLead` restricts to the lead, not
  "the lead or whoever reported the lead's issues".
- **Assignment authority is uniform**: `ASSIGN_ISSUES`/`ASSIGNABLE_USER` checked identically
  on edit, create, and transition-screen paths.
- **Approval policy can't be routed around**: gated agents cannot reach destructive writes
  via `/api/internal/*`, and dry-run previews never park as proposals.
- **Move is atomic**: moving an issue with subtasks never crashes on `(projectId,
  issueNumber)` and never leaves subtasks key-less or un-aliased.

## Scope

**In**: `enforceIssueScope` correctness (case + alias + re-check after resolution);
`onlyProjectLead` condition; `checkAssign` on `planCreate` + transition screen fields;
`resolveAssigneeRef({})` empty-ref rejection; `proposalGate` coverage of destructive
`/api/internal` writes + `?dryRun=true` bypass; `moveIssue` subtask renumbering/aliasing/
counter fix; regression tests for every item.

**Out**: redesigning the permission model (schemes work — these are enforcement bugs);
new permission keys (catalog complete after the in-flight parity pass); the centralized
scope-declaration refactor (tracked in the arch review — this sprint fixes behavior, the
registry is a later structural sprint).

## User stories

### US1 — Issue-scope enforcement is airtight (P0)

As an admin, I want issue security levels and `BROWSE_PROJECTS` to hold for every way an
issue can be addressed, so restricted issues can't leak.

1. **Given** issue `SECRET-1` is security-restricted, **When** I request `GET /rest/api/2/issue/secret-1` (lowercase) as a non-member, **Then** 404/403 — today `enforceIssueScope` splits the raw param without upper-casing, `project` resolves `null`, and both the browse check and `canSeeIssue` are skipped (`middleware/auth.ts` ~197–221).
2. **Given** `PUBLIC-1` was moved to `SECRET-5` (alias `PUBLIC-1 → SECRET-5`), **When** a non-member requests `GET /rest/api/2/issue/PUBLIC-1`, **Then** 404/403 — today the scope check runs against `PUBLIC` (no issue found → `canSeeIssue` skipped) and `getIssueByKey` then resolves the alias and returns the restricted issue (`issueService.ts` ~662–686).
3. **Given** the fix, **When** any route resolves an issue through an alias, **Then** permission and security checks run against the *resolved* issue's project and security level — regression-tested in the leak-test style of `tests/integration/leak.test.ts`.

### US2 — `onlyProjectLead` means the lead (P0)

As a project lead, I want the `onlyProjectLead` workflow condition to gate on the actor,
not the reporter.

1. **Given** a transition with the `onlyProjectLead` condition on a project where the lead reported the issue, **When** any other user lists transitions or POSTs it, **Then** it is hidden/rejected — today `conditionPasses` also passes on `issue.reporterId === leadId` (`workflowService.ts` ~72–79).
2. **Given** the fix, **When** the lead (or a site admin) attempts the transition, **Then** it still passes.

### US3 — Assign authority is checked on every write path (P1)

As an admin, I want `ASSIGN_ISSUES` + `ASSIGNABLE_USER` enforced identically whether
assignment happens via edit, create, or a transition screen.

1. **Given** a user with `CREATE_ISSUES` but not `ASSIGN_ISSUES`, **When** `POST /rest/api/2/issue` with `fields.assignee`, **Then** 403 — today `planCreate` calls `resolveAssigneeRef` directly (`issueService.ts` ~411–416).
2. **Given** a transition screen exposing `assignee`, **When** a user without `ASSIGN_ISSUES` supplies it, **Then** 403 — today `performTransition` resolves screen fields without `checkAssign` (`workflowService.ts` ~221–235).
3. **Given** `assignee: {}` on any path, **When** resolved, **Then** a 400 field error (not a silent `findFirst({OR:[]})` matching the first user — `issueService.ts` ~77–87).

### US4 — Approval policy covers every destructive surface (P0)

As an approver, I want a `destructiveOnly`/`always`-gated agent to be unable to destroy
data through any route family.

1. **Given** an agent with `approvalPolicy: 'destructiveOnly'`, **When** it calls `bulk_change` → `POST /api/internal/bulk/delete` on 500 issues, **Then** the writes park as proposals — today `proposalGate` returns early for non-`/rest/` URLs (`middleware/proposals.ts` ~35–59).
2. **Given** any gated principal, **When** a request carries `?dryRun=true`, **Then** it executes as a preview and never parks as a proposal — today the gate swallows the two-step delete's *preview* leg, breaking `confirmToken` flow and spamming approvers with no-ops.
3. **Given** `POST /api/internal/issues/{key}/move` or other non-DELETE destructive writes, **When** `destructiveOnly` applies, **Then** destructiveness is classified by operation, not `req.method === 'DELETE'`.

### US5 — Move-with-subtasks is atomic (P0)

As a project admin, I want moving a parent with subtasks to renumber or deliberately
preserve subtasks — never a 500.

1. **Given** `SRC-1` has subtask `SRC-3` and target project `DST` already has issue number 3, **When** `POST /api/internal/issues/SRC-1/move` to `DST`, **Then** the subtask is renumbered (`issueCounter` incremented, `IssueKeyAlias` written) instead of a P2002 on `@@unique([projectId, issueNumber])` (`issueOpsService.ts` ~409–414).
2. **Given** the move succeeds, **When** I request the old subtask key, **Then** the alias resolves — today subtasks get no alias and `target.issueCounter` is never bumped, so the next create in `DST` can collide.

## Non-functional requirements

- **FR-001**: Every fix ships with a regression test that fails on the pre-fix code (the leak-test pattern).
- **FR-002**: Scope checks run on the *resolved* issue — alias resolution must happen inside the enforcement path, not before it.
- **FR-003**: Destructive classification is a per-route declaration (allowlist/metadata), not method-sniffing — extensible when new destructive verbs land.
- **FR-004**: Dry-run previews remain free of side effects — no `Proposal`, `AuditEvent` "blocked" noise, or notification rows.

## API surface (candidates)

| Method | Path | Notes |
|---|---|---|
| — | `enforceIssueScope` internals | Upper-case key; post-resolution re-check incl. alias path |
| — | `proposalGate` | Applies to declared-destructive `/api/internal` routes; `?dryRun=true` exempt |
| POST | `/api/internal/issues/{key}/move` | Subtask renumber + alias + counter |
| — | workflow conditions | `onlyProjectLead` actor-only |

## Success criteria

- **SC-001**: Lowercase + alias scope-bypass reproductions return 404/403 (tests).
- **SC-002**: Non-lead reporter's issue is not transitionable via `onlyProjectLead` (test).
- **SC-003**: `destructiveOnly` agent cannot bulk-delete; `?dryRun=true` never 202s (tests).
- **SC-004**: Move-with-subtasks over a colliding target succeeds, aliases resolve, counter monotonic (test).

## Risks

| Risk | Mitigation |
|---|---|
| Alias re-check adds a second permission pass on hot path | `canSeeIssue` is already a couple of indexed lookups; cache per request |
| `/api/internal` proposal coverage 202s existing UI flows | Gate by channel — UI/copilot already bypass; only agent channels hit the gate |
| Subtask renumber changes visible keys | Aliases preserve old keys; changelog records renumber per Jira move |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Every finding in this doc has a failing-now regression test committed before its fix.
- [ ] `docs/compatibility.md` + `apps/mcp/eval/compat.ts` updated where enforcement changed documented behavior.

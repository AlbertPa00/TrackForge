# 05 — Verification Contracts, Proof-Carrying Transitions & Task DAGs

**Theme**: Moving from "an agent asserted it is Done" to machine-verified evidence bundles, separation of duties, and executable work graphs
**Depends on**: Sprint 009 (Workflows & Validators), Sprint 016 (Job Runner), Sprint 038 (Git/CI Integration)
**Related Sprint**: Extends [Sprint 009](../sprints/009-workflow-engine-board-config.md), [Sprint 034](../sprints/034-automation-agent-triage.md), and [Sprint 038](../sprints/038-git-integration-dev-panel.md)

---

## 1. Problem Statement & Research Foundation

In human-centric Jira, moving a card to `Done` is a **social assertion** backed by professional accountability. When an autonomous coding agent calls `transition_issue(key: "TF-104", transition: "Done")`, that social contract breaks down:

1. **Reward Hacking & Confabulated Completion**: Empirical evaluations of coding agents consistently show that under pressure or after repeated failures, LLMs will weaken test assertions, skip failing suites, or claim a bug is fixed when the build is broken.
2. **Self-Certifying Writes**: In TrackForge today, if an agent has `TRANSITION_ISSUES` permission, the same agent that wrote the code can transition the issue from `To Do` → `In Progress` → `Done` in 2 seconds with zero independent verification.
3. **Tree-Shaped Hierarchy vs. DAG Reality**: Jira's `Epic → Story → Subtask` model is a strict tree, and `blocks` links are passive annotations. Real multi-agent software development is a **Directed Acyclic Graph (DAG)** with fan-out (one spec spawns parallel backend, frontend, and MCP tasks) and fan-in (an integration test task waits for all three branches to merge their artifacts).

### Theoretical Grounding
- **Proof-Carrying Code (Necula, POPL 1997)**: An untrusted producer must attach a formal, machine-checkable **proof/witness** to its output; the host environment runs a fast, deterministic **verifier** on the proof before accepting the state transition. Applied to issue tracking: **transitions to `In Review` or `Done` require a verifiable `EvidenceBundle`**.
- **Design by Contract (Meyer, 1986) & Separation of Duties (Clark & Wilson, 1987)**: Critical state transitions require both (a) postconditions verified by an independent predicate evaluator and (b) **two-principal separation** where `reviewerActorId != implementerActorId`.

---

## 2. Step-by-Step Specification

### Step 1: Machine-Checkable Acceptance Criteria (`AcceptanceCheck`)

Instead of prose checklists buried in `description` (`- [ ] tests pass`), an issue carries first-class `AcceptanceCheck` rows that TrackForge (or a trusted runner) can evaluate deterministically.

#### Supported Check Kinds
1. **`jql_invariant` (Evaluated In-Process by TrackForge)**:
   - Asserts a JQL predicate over the issue or its children (e.g., `"All subtasks Done"`: `parent = {{issue.key}} AND statusCategory != Done` must return `0` issues).
2. **`blackboard_invariant` (Evaluated In-Process by TrackForge)**:
   - Asserts structural completeness of the issue's Blackboard (e.g., `reproduction.status == "passing"`, `artifacts` contains at least one `commit` or `pr`, `targetFiles` is non-empty).
3. **`signed_attestation` (Cryptographic CI / Test Runner Receipt)**:
   - Rather than TrackForge executing arbitrary untrusted shell commands inside the web server (which would violate security boundaries), the agent's test runner or CI pipeline runs the verification command (e.g. `pnpm --filter backend test`) and submits a **HMAC-signed or token-authenticated `CheckAttestation`**:
   ```json
   {
     "checkId": "chk_unit_tests",
     "command": "pnpm --filter backend test components.test.ts",
     "exitCode": 0,
     "gitCommitSha": "9f8e7d6c",
     "stdoutTail": "7 passed (7)",
     "durationMs": 1420,
     "signature": "hmac-sha256=..."
   }
   ```
4. **`review_verdict` (Independent Agent or Human Sign-off)**:
   - Requires a structured `IssueReview` with `verdict = 'APPROVED'` from a principal distinct from the implementer, matching the current `gitCommitSha` on the Blackboard.

---

### Step 2: New Workflow Validator Rules (Extending Sprint 009's `TransitionRule`)

Sprint 009 introduced `TransitionRule` (`condition` | `validator` | `post_function`). We add three AI-native validator types to the existing workflow engine (`apps/backend/src/services/workflowService.ts`) with zero changes to how transitions are invoked:

| Validator Type | Rule Config (`Jsonb`) | Enforcement Logic at `POST /issue/{key}/transitions` |
|---|---|---|
| **`all_acceptance_checks_passed`** | `{ "scope": "required_only" }` | Rejects transition with `400` if any `AcceptanceCheck` with `required: true` on the issue is not in `PASSED` state for the latest artifact revision. Error payload lists the exact failing check IDs so the agent knows what to fix. |
| **`separation_of_duties`** | `{ "disallowedRoles": ["leaseHolder", "lastImplementer"], "allowHumanOverride": true }` | Rejects transition (e.g., `In Review` → `Done`) if `actor.id` is the same agent that held the implementation lease or authored the code artifact. Forces a separate **Verifier/Reviewer Agent** (or human) to inspect and close the issue. |
| **`handoff_or_evidence_required`** | `{ "requireArtifactKind": ["commit", "pr"] }` | Rejects transition to `In Review` unless the Blackboard contains a `commit`/`pr` artifact and a passing `reproduction` status. |

Because TrackForge already supports `?dryRun=true` on `POST /issue/{key}/transitions`, an agent can call `transition_issue(..., dry_run: true)` at any time to get a **machine-readable pre-flight checklist** of every remaining gate before it can close the issue!

---

### Step 3: Structured Code & Spec Reviews (`IssueReview`)

Comments are unstructured; agents need a first-class review primitive (analogous to GitHub PR reviews, but bound to the issue and its Blackboard revision):

```typescript
export const CreateIssueReviewSchema = z.object({
  issueVersion: z.number().int(),
  artifactRef: z.string().optional(), // e.g. commit SHA or branch reviewed
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENT_ONLY']),
  summary: z.string().min(10).max(2000),
  findings: z.array(z.object({
    severity: z.enum(['blocker', 'major', 'minor', 'nit']),
    file: z.string().optional(),
    line: z.number().int().optional(),
    message: z.string().max(500),
    suggestedFix: z.string().max(500).optional(),
  })).max(50).default([]),
});
```

When a Reviewer Agent submits `verdict: 'CHANGES_REQUESTED'`:
1. Any `blocker` or `major` findings are automatically converted into a `ReflectionEntry` (`triggerKind: 'review_rejected'`, Doc 04) and appended to the Blackboard's `remainingSteps`.
2. If configured in the workflow, the issue automatically transitions back from `In Review` → `In Progress` and wakes an implementation worker.

---

### Step 4: Executable Task Decomposition DAGs (`POST /issues/{key}/decompose`)

When an agent or planner breaks down a complex Story or Epic, creating flat subtasks loses the **execution topology** (which subtasks can run in parallel worktrees vs. which must wait for upstream outputs).

`POST /api/internal/issues/{key}/decompose` accepts a declarative **Work DAG**:
```json
{
  "dryRun": false,
  "nodes": [
    {
      "localId": "schema",
      "summary": "Add Component & Version Prisma models",
      "issueType": "Sub-task",
      "targetFiles": ["apps/backend/prisma/schema.prisma"],
      "acceptanceChecks": [{ "kind": "signed_attestation", "name": "Migration applies cleanly" }]
    },
    {
      "localId": "backend_api",
      "summary": "Implement /rest/api/2/component and /version endpoints",
      "issueType": "Sub-task",
      "dependsOn": ["schema"],
      "targetFiles": ["apps/backend/src/routes/components.ts"]
    },
    {
      "localId": "mcp_tools",
      "summary": "Add manage_components and manage_versions MCP tools",
      "issueType": "Sub-task",
      "dependsOn": ["schema"],
      "targetFiles": ["apps/mcp/src/tools.ts"]
    },
    {
      "localId": "integration_eval",
      "summary": "Run full integration + MCP eval suite for components/versions",
      "issueType": "Sub-task",
      "dependsOn": ["backend_api", "mcp_tools"]
    }
  ]
}
```

#### What TrackForge Does in One Transaction:
1. Validates that `nodes` + `dependsOn` form a valid **acyclic** graph (topological sort check; rejects cycles with `400`).
2. Checks that parallel sibling branches (`backend_api` and `mcp_tools`) have **disjoint `targetFiles`**—warning on dry-run if two parallel nodes plan to edit the same file!
3. Creates the child issues, populates each child's initial `blackboard.targetFiles` and `AcceptanceCheck` rows, and creates `blocks` `IssueLink` edges for every `dependsOn` edge.
4. Marks root nodes (`schema`) as `ready`, while downstream nodes start `blocked`. As root nodes finish, Doc 03's **Dependency Unblocking Reflex** automatically schedules `backend_api` and `mcp_tools` in parallel, and finally `integration_eval` (fan-in).

---

### Step 5: Cryptographic Provenance (`ChangeHistory.provenance`)

To provide enterprise-grade auditability:
- Every agent mutation can attach `X-TrackForge-Provenance` metadata: `{ modelId, provider, sessionId, promptHash, gitCommitSha }`.
- Stored on `ChangeHistory` and `AuditEvent`, enabling instant answers to: *"Which exact model version and prompt produced the regression in TF-104?"*

---

## 3. Data Model (Prisma Schema Additions)

```prisma
model AcceptanceCheck {
  id            String   @id @default(cuid())
  issueId       String
  issue         Issue    @relation(fields: [issueId], references: [id], onDelete: Cascade)
  name          String
  kind          String   // jql_invariant | blackboard_invariant | signed_attestation | review_verdict
  required      Boolean  @default(true)
  spec          Json     // JQL query, blackboard rule, or expected command pattern
  status        String   @default("PENDING") // PENDING | PASSED | FAILED
  lastEvidence  Json?    // Attestation payload, stdout snippet, commitSha, timestamp
  verifiedById  String?
  verifiedAt    DateTime?
  createdAt     DateTime @default(now())

  @@index([issueId, required, status])
}

model IssueReview {
  id           String   @id @default(cuid())
  issueId      String
  issue        Issue    @relation(fields: [issueId], references: [id], onDelete: Cascade)
  reviewerId   String
  reviewer     User     @relation(fields: [reviewerId], references: [id])
  issueVersion Int
  artifactRef  String?
  verdict      String   // APPROVED | CHANGES_REQUESTED | COMMENT_ONLY
  summary      String
  findings     Json     @default("[]")
  createdAt    DateTime @default(now())

  @@index([issueId, verdict, createdAt])
}
```

---

## 4. Scaling, Difficulties, Impact & Risks

### Scaling Analysis (PostgreSQL Single-Node)
- **Zero-Sandboxing Overhead on Server**: Because `signed_attestation` checks verify cryptographic signatures / CI receipts rather than spawning `child_process.exec` inside the TrackForge Express backend, the TrackForge server remains fast, stateless, and immune to remote code execution (RCE) or CPU starvation.
- **DAG Scheduling**: Topological validation on a 20-node decomposition graph takes `<0.1ms` in memory; unblocking runs incrementally via indexed `IssueLink` lookups.

### Implementation Difficulties
1. **Stale Approvals After New Edits**: If Reviewer Agent approves `TF-104` at `issueVersion: 5` (`artifactRef: "sha-111"`), and the implementer subsequently pushes a new commit (`artifactRef: "sha-222"`), the approval must invalidate.
   - *Solution*: `all_acceptance_checks_passed` checks that `review.artifactRef === issue.blackboard.latestCommitSha` (just like GitHub's "Dismiss stale pull request approvals when new commits are pushed").

### Risks & Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| **Colluding or Same-Model Reviewer Bias** (Claude-Sonnet reviews Claude-Sonnet's code and rubber-stamps the same blind spot) | High | Allow `separation_of_duties` validator config to specify `requireDifferentModelFamily: true` or `requireRole: "Verifier"` so review must come from a distinct agent persona/model or human. |
| **Agent Forges Attestation Payload** | High | Require `signed_attestation` submissions to either carry an HMAC signature from a secret held only by the test harness/CI runner (`ATTESTATION_SECRET`), or come from a dedicated `runner`-scoped PAT that coding agents do not possess. |

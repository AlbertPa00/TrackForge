# 02 — Shared-State Blackboard, Handoff Envelopes & Context Packs

**Theme**: Eliminating the 62% information loss across multi-agent handoffs and cutting cold-start context cost
**Depends on**: Sprint 007 (MCP), Sprint 008 (Comments/Links), Proposal 01 (Leases & Versioning)
**Related Sprint**: Direct enhancement to [Sprint 047 (Agent Experience Polish)](../sprints/047-agent-experience-polish.md)

---

## 1. Problem Statement & Research Foundation

When multiple agents (or an agent and a human) collaborate on an issue over time—for example: a **Triage Agent** reproduces a bug → a **Planner Agent** designs the fix → a **Coding Agent** writes the patch → a **Reviewer Agent** audits it—how should they pass state?

In standard Jira, agents communicate by **appending prose comments**. As the issue progresses:
- Comment 1 has a stack trace and a guess that turned out to be wrong.
- Comment 3 has the real root cause buried in paragraph four.
- Comment 6 changes the target file list.
- Comment 9 is an automated status log.

When the next agent wakes up, it must either read the entire noisy comment stream (polluting its context window and attending to outdated hypotheses) or read only the latest summary comment (suffering severe information loss).

### Empirical Evidence: *SE-Blackboard* (IEEE Access, 2026)
The *SE-Blackboard* study measured this exact phenomenon on 50 SWE-bench Lite issues using the **Information Fidelity Score (IFS)**—the fraction of critical technical entities (file paths, function/class identifiers, error types, constraints) from upstream discovery that survive to the coding stage:
- **Message-Passing (sequential natural-language summaries/comments)**: Coder-stage IFS dropped to **`0.362`** (63.8% entity loss), and agents targeted the correct file only **55.1%** of the time.
- **Shared-State Blackboard (structured, mutable state object)**: Coder-stage IFS rose to **`0.586` (+62% improvement)**, and correct file targeting jumped to **82.6% (+27.5 percentage points)**.

### Classical Lineage: Hearsay-II & Hayes-Roth Blackboard Control
In classical AI (Erman et al., 1980; Hayes-Roth, 1985), a **Blackboard** is a structured, schema-validated shared working memory partitioned into abstraction levels (e.g., *observations → hypotheses → verified facts → plan steps*). Independent specialist knowledge sources read from and write atomic updates to the blackboard rather than chatting with one another.

---

## 2. Step-by-Step Specification

### Step 1: The Per-Issue Typed Blackboard (`Issue.blackboard`)

Every issue gains a structured `blackboard` JSONB column validated by a strict Zod schema. Unlike `description` (which represents the **human problem statement**) or `comments` (which represent **chronological discussion**), the `blackboard` represents **current distilled technical truth**.

#### Canonical Blackboard Schema
```typescript
export const IssueBlackboardSchema = z.object({
  schemaVersion: z.literal(1).default(1),

  // 1. Localization: Where in the codebase does this work live?
  targetFiles: z.array(z.object({
    path: z.string().max(500),
    role: z.enum(['modify', 'create', 'delete', 'read_only_context']),
    confidence: z.number().min(0).max(1).optional(),
    note: z.string().max(300).optional(),
  })).max(50).default([]),

  targetSymbols: z.array(z.object({
    name: z.string().max(200),       // e.g. "issueService.planCreate"
    file: z.string().max(500).optional(),
    intent: z.string().max(300).optional(),
  })).max(50).default([]),

  // 2. Empirical Grounding: How do we reproduce and verify?
  reproduction: z.object({
    command: z.string().max(1000).optional(), // e.g. "pnpm --filter backend test issues.test.ts -t 'dryRun'"
    status: z.enum(['unverified', 'reproduced', 'passing', 'flaky']).default('unverified'),
    lastOutputSnippet: z.string().max(2000).optional(),
    verifiedBy: z.string().optional(),
    verifiedAt: z.string().datetime().optional(),
  }).optional(),

  // 3. Epistemic State: Facts vs. Hypotheses
  verifiedFacts: z.array(z.object({
    id: z.string(),
    statement: z.string().max(500),
    evidenceRef: z.string().max(300).optional(), // e.g. "apps/backend/src/routes/issues.ts:142"
    addedBy: z.string(),
  })).max(30).default([]),

  hypotheses: z.array(z.object({
    id: z.string(),
    statement: z.string().max(500),
    status: z.enum(['untested', 'confirmed', 'refuted']),
    evidence: z.string().max(500).optional(),
  })).max(20).default([]),

  // 4. Execution Artifacts & Open Blockers
  artifacts: z.array(z.object({
    kind: z.enum(['branch', 'commit', 'pr', 'worktree', 'spec_doc', 'eval_run']),
    ref: z.string().max(500),
    label: z.string().max(200).optional(),
  })).max(20).default([]),

  decisions: z.array(z.object({
    id: z.string(),
    decision: z.string().max(500),
    rationale: z.string().max(500),
    decidedBy: z.string(),
    decidedAt: z.string().datetime(),
  })).max(20).default([]),
});
```

#### Atomic Mutation Operations (`PATCH /api/internal/issues/{key}/blackboard`)
Rather than forcing agents to re-upload the entire JSON object (which risks accidentally dropping entries and wastes output tokens), the blackboard endpoint supports semantic operations:
- `upsert_target_file`, `remove_target_file`
- `set_reproduction`
- `add_fact`, `update_hypothesis` (`untested` → `confirmed` | `refuted`)
- `add_decision` (append-only; decisions cannot be silently deleted by workers)
- `add_artifact`

Every blackboard mutation:
1. Checks `If-Match` / `fenceToken` (from Doc 01).
2. Records a compact `ChangeHistory` entry (`field: "blackboard.targetFiles"`, `fromString`, `toString`) so the full evolution of the blackboard is auditable and reversible.
3. Automatically syncs `targetFiles` with `role: 'modify' | 'create' | 'delete'` into `StigmergicTrace` rows (connecting Doc 02 directly to Doc 01's collision detector).

---

### Step 2: Mandatory Structured Handoff Envelopes (`HandoffEnvelope`)

Whenever an agent releases a lease without transitioning the issue to `Done`, or delegates/reassigns the issue to another actor (human or agent), TrackForge requires a structured **Handoff Envelope**:

```typescript
export const HandoffEnvelopeSchema = z.object({
  outcome: z.enum(['completed_stage', 'blocked', 'needs_human_decision', 'exceeded_budget', 'failed_checks']),
  summary: z.string().min(10).max(1000),
  completedSteps: z.array(z.string().max(300)).max(20),
  remainingSteps: z.array(z.string().max(300)).max(20),
  doNotRepeat: z.array(z.string().max(400)).max(10).default([]), // Feeds Doc 04 Reflexion buffer
  worktreeOrBranch: z.string().max(300).optional(),
  nextRecommendedRole: z.string().max(100).optional(), // e.g. "frontend-specialist", "human-reviewer"
});
```

Why enforce this at the protocol boundary? Because an agent surrendering a task has the full execution trace in its active context window *right then*; extracting a 200-token structured handoff before exiting costs pennies, whereas forcing the next agent to reconstruct what happened from git diffs and logs costs thousands of tokens and high error rates.

---

### Step 3: Typed Speech-Act Comments (`Comment.speechAct`)

Drawing on Winograd & Flores' **Language/Action Perspective ( Speech Act Theory)** and FIPA ACL performatives, comments gain an optional `speechAct` classification + structured `metadata`:
- `observation` · `question` · `answer` · `proposal` · `decision` · `blocker` · `handoff` · `review_verdict`
- JQL gains `commentType = blocker` and `hasUnresolvedBlocker = true`.
- When `context-pack` compresses a 50-comment thread, it **never drops** comments with `speechAct IN ('decision', 'blocker', 'handoff')`, while routine status chatter is elided.

---

### Step 4: The Single-Call `context-pack` Endpoint

Today, an agent starting work on `TF-104` must call `get_issue`, `list_comments`, `get_children`, `get_transitions`, `get_project` (for guidance), and search linked issues—6+ round-trips before writing a single line of code.

`GET /api/internal/issues/{key}/context-pack?maxTokens=4000` (and MCP tool `get_context_pack`) assembles a **deterministic, token-budgeted briefing in one SQL round-trip**.

#### Deterministic Priority Packing Algorithm
Given a caller budget `maxTokens` (default `4000`, estimated at `1 token ≈ 4 chars`), the packer allocates budget in strict priority order:

| Priority | Section | Budget Share | Truncation / Compression Policy |
|---|---|---|---|
| **P0 (Never Dropped)** | **Issue Core + Active Lease + Project `agentGuidance`** | ~15% | Key, summary, status, priority, type, components, versions, allowed transitions, project rules. |
| **P1 (Never Dropped)** | **Latest Handoff Envelope + `doNotRepeat` Reflexions** | ~15% | Most recent `HandoffEnvelope` + all `refuted` hypotheses and `doNotRepeat[]` warnings so the agent never repeats a known dead-end. |
| **P2 (High Priority)** | **Shared Blackboard State** | ~30% | `targetFiles`, `targetSymbols`, `reproduction`, `verifiedFacts`, `decisions`, `artifacts`. |
| **P3 (Medium Priority)** | **Dependency & Hierarchy Graph** | ~15% | Parent/Epic summary + status; subtasks; `blocks` / `is blocked by` issue keys, statuses, and one-line summaries; active file collisions from Doc 01. |
| **P4 (Elastic Tail)** | **High-Signal Comment Thread & Changelog Tail** | Remaining (~25%) | All pinned `decision`/`blocker` comments in full, followed by the most recent $N$ comments that fit the remaining token budget. Elided comments are replaced with `"[... 14 earlier comments omitted; 0 decisions, 2 observations — call list_comments to expand]"`. |

---

## 3. Data Model (Prisma Schema Additions)

```prisma
model Issue {
  // ... existing fields ...
  blackboard Json      @default("{}") // Validated via IssueBlackboardSchema
  handoffs   Handoff[]
}

model Handoff {
  id                  String   @id @default(cuid())
  issueId             String
  issue               Issue    @relation(fields: [issueId], references: [id], onDelete: Cascade)
  fromActorId         String
  fromActor           User     @relation("HandoffFrom", fields: [fromActorId], references: [id])
  toActorId           String?
  toActor             User?    @relation("HandoffTo", fields: [toActorId], references: [id])
  leaseId             String?
  outcome             String   // completed_stage | blocked | needs_human_decision | exceeded_budget | failed_checks
  summary             String
  completedSteps      Json     // string[]
  remainingSteps      Json     // string[]
  doNotRepeat         Json     // string[]
  worktreeOrBranch    String?
  nextRecommendedRole String?
  createdAt           DateTime @default(now())

  @@index([issueId, createdAt(sort: Desc)])
}

model Comment {
  // ... existing fields ...
  speechAct  String?  // observation | question | answer | decision | blocker | handoff | review_verdict
  resolved   Boolean? // For blocker / question speech acts
}
```

---

## 4. Scaling, Difficulties, Impact & Risks

### Scaling Analysis (PostgreSQL Single-Node)
- **Read Performance of `context-pack`**: Everything in the context pack lives on `Issue` + 4 indexed relations (`Comment`, `Handoff`, `IssueLink`, `StigmergicTrace`). A single Prisma `findUnique` with bounded `take` clauses executes in **<5ms** on PostgreSQL.
- **Zero LLM Dependency**: Crucially, `context-pack` uses **structural prioritization** (Blackboard + Speech Acts + Handoffs) rather than calling an LLM to summarize comments on the fly. That makes it deterministic, instant, $0 in API cost, and immune to summarization hallucinations.
- **JSONB Indexing**: Adding a GIN index on `Issue.blackboard -> 'targetFiles'` enables fast JQL queries like `blackboardFile ~ "issueService.ts"` so agents and humans can search issues by the code files they affect.

### Implementation Difficulties
1. **Discipline of Blackboard Updates**: Agents trained primarily on GitHub/Jira prose habits will default to `add_comment` unless nudged.
   - *Solution*: The MCP tool descriptions for `claim_issue` and `get_context_pack` explicitly instruct the agent to use `patch_blackboard` for files/facts/hypotheses, and `release_lease` / `transition_issue` validate that a blackboard or handoff update occurred during the session.
2. **Bounding Blackboard Growth**: Over long-lived epics, `verifiedFacts` or `hypotheses` could accumulate stale items.
   - *Solution*: Enforce array caps in `IssueBlackboardSchema` (e.g., max 50 files, 30 facts) and provide a `prune_refuted` op.

### Risks & Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| **Poisoned Blackboard Fact** (Agent A records a false "verifiedFact" that misleads Agent B) | High | Require `evidenceRef` (`file:line` or test run ID) on `verifiedFacts`; untagged claims must be filed under `hypotheses` (`status: 'untested'`). |
| **Prompt Injection via Blackboard/Comments inside `context-pack`** | High | Wrap untrusted user/external text inside explicit XML delimiters with data-only provenance markers in the context pack response, and run the 012 prompt-injection scanner on blackboard writes. |
| **Jira Importer Compatibility** | Low | `blackboard` defaults to `{}` on imported Jira issues; `context-pack` gracefully degrades to description + comments when `blackboard` is empty. |

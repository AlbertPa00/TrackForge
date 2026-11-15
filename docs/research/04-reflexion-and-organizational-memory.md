# 04 — Reflexion & Organizational Memory: Verbal RL, 3-Tier Knowledge Graphs & Playbooks

**Theme**: Turning failed attempts and closed issues into compounding team intelligence without fine-tuning weights
**Depends on**: Sprint 012 (`IssueEmbedding`, AI provider), Sprint 019 (`Component`), Proposals 01–03
**Related Sprint**: Extends [Sprint 012](../sprints/012-ai-copilot-human-in-the-loop.md) and [Sprint 047](../sprints/047-agent-experience-polish.md) (`Project.agentGuidance`)

---

## 1. Problem Statement & Research Foundation

Most multi-agent setups are **stateless across tasks**:
- **Intra-Task Amnesia**: Agent A attempts `TF-104`, spends 15 minutes discovering that `prisma.$transaction` interactive timeouts fail when calling an external webhook inside the transaction, hits an error, and releases the lease. Agent B claims `TF-104` and immediately makes the exact same mistake.
- **Inter-Task Amnesia**: Even after `TF-104` is solved, when `TF-210` arrives two weeks later in the same component (`Events`), the fleet has forgotten the architectural lesson learned on `TF-104`. Static files like `AGENTS.md` or `Project.agentGuidance` only capture what a human remembers to write down manually.

### Theoretical Grounding
1. **Reflexion: Language Agents with Verbal Reinforcement Learning (Shinn, Cassano, Yao et al., NeurIPS 2023)**: Instead of updating model weights via PPO/RLHF, Reflexion converts binary/scalar failure signals from an **Evaluator ($M_e$)** into a concise natural-language self-critique via a **Self-Reflection step ($M_{sr}$)** stored in an episodic buffer. This "semantic gradient" boosted HumanEval coding pass@1 from **80% to 91%**.
2. **G-Memory: Tracing Hierarchical Memory for Multi-Agent Systems (NeurIPS 2025)**: Flat RAG over past logs degrades as history grows because raw logs are too noisy and high-level rules lack execution detail. *G-Memory* organizes multi-agent experience into a **three-tier graph hierarchy**:
   - **Tier 1 (Interaction Graph)**: Condensed per-issue execution trajectories and handoffs.
   - **Tier 2 (Query / Episode Graph)**: Task-specific reflections (`ReflectionEntry`) indexed by problem signature and component.
   - **Tier 3 (Insight Graph)**: Generalizable cross-task engineering rules and gotchas distilled from multiple episodes, achieving **+20.89% task success** over memoryless MAS baselines.
3. **LEGOMem & SMITH (2025)**: Decompose successful past trajectories into modular **Procedural Memory Playbooks** (reusable step-by-step checklists + verification commands) retrieved dynamically by issue type and component.

---

## 2. Step-by-Step Specification

### Step 1: The Episodic Reflexion Loop (`ReflectionEntry`)

Whenever an agent session ends in failure (test failure, rejected review, circuit-breaker trip from Doc 03, or lease surrender with `outcome != 'completed_stage'`), the protocol enforces a **Verbal RL Reflexion Step**:

```text
[Actor Agent] ──(attempts fix)──► [Evaluator (Test / Review / Breaker)]
      ▲                                        │
      │ (injected into P1 of                   │ (Fail signal + stderr / review diff)
      │  next `context-pack`)                  ▼
[Episodic Buffer: ReflectionEntry] ◄── [Self-Reflection ($M_{sr}$)]
```

#### Structured Schema of a `ReflectionEntry`
Rather than free-form apologies ("I'm sorry, I failed"), the reflection schema forces causal diagnosis:
```typescript
export const ReflectionEntrySchema = z.object({
  issueKey: z.string(),
  leaseId: z.string().optional(),
  triggerKind: z.enum(['test_failure', 'review_rejected', 'circuit_breaker', 'lease_abandoned']),
  attemptedApproach: z.string().min(10).max(500)
    .describe('What concrete change or command was tried?'),
  failureSignal: z.string().min(5).max(1000)
    .describe('Exact error message, failing assertion, or reviewer objection'),
  rootCauseHypothesis: z.string().min(10).max(500)
    .describe('Why did this approach fail in this codebase?'),
  doNotRepeat: z.string().min(10).max(300)
    .describe('Imperative rule for the next attempt, e.g. "Do not call dispatchWebhook inside prisma.$transaction"'),
  affectedFiles: z.array(z.string().max(300)).max(10).default([]),
});
```

- **Injection into `context-pack` (Doc 02)**: All `ReflectionEntry` rows for `TF-104` are placed in **Priority P1 (Never Dropped)** of `GET /issue/TF-104/context-pack`. The next agent literally sees a `### Prior Failed Attempts — DO NOT REPEAT` block before writing code.

---

### Step 2: The 3-Tier Organizational Memory Graph (*G-Memory* for TrackForge)

Beyond a single issue, TrackForge promotes durable lessons from closed issues into project-scoped **Semantic & Procedural Memory (`ProjectMemory`)**:

```text
Tier 3: ProjectMemory (kind = 'gotcha' | 'convention' | 'playbook')
          ▲  ▲
          │  └── Distilled & promoted when an issue closes after >=1 ReflectionEntry
          │      (via Sprint 012 Proposal or Reviewer sign-off)
Tier 2: ReflectionEntry (per-issue verbal RL critiques + root causes)
          ▲
          │
Tier 1: Handoff + IssueBlackboard + ChangeHistory (raw episode trace)
```

#### Memory Kinds
1. **`gotcha` (Negative Constraint / Pitfall)**: *"In component `JQL`, PostgreSQL `ILIKE` does not use the GIN FTS index; always compile `~` to `to_tsvector`."*
2. **`convention` (Positive Architectural Pattern)**: *"Every new endpoint in `routes/*.ts` must register its schema in `lib/openapi.ts` and `apps/mcp/src/tools.ts`."*
3. **`playbook` (Procedural Workflow — *LEGOMem*)**: Step-by-step recipe scoped to `(projectId, issueTypeId?, componentId?)`:
   ```json
   {
     "title": "Adding a New Custom Field Type",
     "appliesTo": { "component": "Custom Fields", "issueType": "Story" },
     "steps": [
       "1. Add the type validator in apps/backend/src/services/customFieldService.ts",
       "2. Register the picker widget in apps/frontend/src/components/CustomFieldInput.tsx",
       "3. Add round-trip coverage in apps/backend/tests/integration/customfields.test.ts"
     ],
     "verificationCommand": "pnpm --filter backend test customfields.test.ts"
   }
   ```

#### Bi-Directional Retrieval in `context-pack`
When an agent requests `GET /api/internal/issues/{key}/context-pack`:
1. **Top-Down (Symbolic Match)**: TrackForge fetches all active `ProjectMemory` rows matching the issue's `projectId` AND (`componentId IN issue.components` OR `issueTypeId = issue.issueTypeId` OR `scope = 'project_global'`).
2. **Bottom-Up (Semantic Similarity)**: Using Sprint 012's embedding infrastructure (`IssueEmbedding`), TrackForge computes cosine similarity between the current issue's vector and embeddings of past `ProjectMemory` + resolved `ReflectionEntry` items, returning the top-3 highest-scoring insights above similarity `0.78`.

---

### Step 3: Anti-Pollution & Memory Hygiene (Confidence Decay + Validation)

The #1 failure mode of persistent agent memory systems in production is **memory rot**: an insight that was true in Sprint 008 becomes false after a refactor in Sprint 019, and begins actively misleading agents.

TrackForge prevents memory rot through three mechanisms:
1. **File-Anchored Staleness**: Every `ProjectMemory` row can declare `anchoredFiles: string[]` (e.g., `["apps/backend/src/services/customFieldService.ts"]`). When those files undergo major churn (>40% lines changed in Git) or are deleted, the Context-Rot Reflex (Doc 03) flips the memory status to `NEEDS_REVALIDATION` and stops auto-injecting it until verified.
2. **Empirical Utility Scoring (Helpful vs. Harmful Telemetry)**: When an agent finishes an issue whose context pack included Memory $M_i$:
   - If the issue succeeds on the first attempt (`0` reflections/circuit trips), $M_i.\text{utilityScore}$ increments (EMA).
   - If the issue fails or the agent flags `report_stale_memory(memoryId)`, $M_i.\text{utilityScore}$ drops; below a threshold, the memory is auto-archived.
3. **Gated Promotion**: Workers cannot unilaterally write global project conventions. An agent calls `propose_memory`, which creates a `ProjectMemory` in `PROPOSED` state (or a Sprint 012 `Proposal`). Only a Reviewer agent or human project admin promotes it to `ACTIVE`.

---

## 3. Data Model (Prisma Schema Additions)

```prisma
model ReflectionEntry {
  id                  String   @id @default(cuid())
  projectId           String
  issueId             String
  issue               Issue    @relation(fields: [issueId], references: [id], onDelete: Cascade)
  actorId             String
  actor               User     @relation(fields: [actorId], references: [id])
  leaseId             String?
  triggerKind         String   // test_failure | review_rejected | circuit_breaker | lease_abandoned
  attemptedApproach   String
  failureSignal       String
  rootCauseHypothesis String
  doNotRepeat         String
  affectedFiles       Json     @default("[]") // string[]
  embedding           Json?    // float[] (reuses 012 embedding format)
  promotedToMemoryId  String?
  createdAt           DateTime @default(now())

  @@index([issueId, createdAt])
  @@index([projectId])
}

model ProjectMemory {
  id                  String   @id @default(cuid())
  projectId           String
  project             Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  componentId         String?  // Optional scoping to a Sprint 019 Component
  issueTypeId         String?  // Optional scoping to Bug / Story / Task
  kind                String   // gotcha | convention | playbook
  status              String   @default("PROPOSED") // PROPOSED | ACTIVE | NEEDS_REVALIDATION | ARCHIVED
  title               String
  content             String   // Concise rule or markdown steps
  verificationCommand String?
  anchoredFiles       Json     @default("[]") // string[] for Context-Rot Reflex
  embedding           Json?    // float[]
  sourceIssueId       String?
  createdById         String
  approvedById        String?
  timesInjected       Int      @default(0)
  timesSucceeded      Int      @default(0)
  utilityScore        Float    @default(0.5)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  @@index([projectId, status, componentId])
}
```

---

## 4. API & MCP Contract Surface

| Method | Path | MCP Tool | Description |
|---|---|---|---|
| `POST` | `/api/internal/issues/{key}/reflections` | `record_reflection` | Records a structured `ReflectionEntry` on an issue (required when releasing a failed/paused lease). |
| `GET` | `/api/internal/issues/{key}/reflections` | `list_reflections` | Lists all prior failure reflections and `doNotRepeat` rules for an issue. |
| `POST` | `/api/internal/projects/{key}/memories` | `propose_project_memory` | Proposes a reusable `gotcha`, `convention`, or `playbook` distilled from an issue. |
| `GET` | `/api/internal/projects/{key}/memories` | `search_project_memory` | Queries active project memories by component, issue type, file path, or semantic query. |
| `POST` | `/api/internal/memories/{id}/feedback` | `flag_memory_stale` | Marks an injected memory as outdated/inaccurate so it enters `NEEDS_REVALIDATION`. |

---

## 5. Scaling, Difficulties, Impact & Risks

### Scaling Analysis (PostgreSQL Single-Node)
- **Episodic Reflections (`ReflectionEntry`)**: Scoped per `issueId`. An issue rarely has more than 1–5 failed attempts; querying `WHERE issueId = $1` is an $O(1)$ index lookup.
- **Project Memory Vector Search (`ProjectMemory`)**: A typical engineering project accumulates 50–500 curated `gotcha`/`playbook` entries over a year—not millions. Computing exact cosine similarity over 500 JSON float arrays in Node.js (the exact pattern Sprint 012 already uses for `IssueEmbedding`) takes **<3ms** in memory with zero external vector database required.

### Implementation Difficulties
1. **Preventing Verbose Low-Signal Reflections**: Left unconstrained, LLMs write 400-word essays about why they failed.
   - *Solution*: Enforce strict character caps (`doNotRepeat <= 300 chars`) in Zod so reflections remain punchy imperative rules.
2. **Cold-Start When No AI Provider Is Configured**: TrackForge must work in deterministic, no-LLM environments (as proven by `apps/mcp/eval/run.ts`).
   - *Solution*: Symbolic matching (by `componentId`, `issueTypeId`, and `anchoredFiles` overlap with `blackboard.targetFiles`) works with **zero embedding provider configured**; vector similarity is an additive ranking boost when embeddings are enabled.

### Risks & Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| **Superstitious Learning** (Agent blames the wrong root cause in `doNotRepeat`, blocking the actual right solution for the next agent) | High | Label reflections with the authoring model/agent + `triggerKind`, and instruct agents in `context-pack` that `doNotRepeat` entries are *prior failed attempts with their exact error signals*, not infallible axioms. |
| **Prompt Injection via Curated Memory** | High | Only `ACTIVE` memories approved by a user with `ADMINISTER_PROJECT` or a trusted Reviewer role are auto-injected into `context-pack`. |

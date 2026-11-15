# 03 — The Reflex Engine: System 0/1/2 Cognitive Tiers & Homeostatic Circuit Breakers

**Theme**: Fast, zero-LLM spinal reflexes on the event bus + cybernetic self-regulation to prevent agent loops and context rot
**Depends on**: Sprint 011 (`DomainEvent` outbox), Sprint 016 (Job Runner), Sprint 034 (Automation Engine), Proposals 01 & 02
**Related Sprint**: Natural evolution of [Sprint 034 (Automation Rules & Agent Triage)](../sprints/034-automation-agent-triage.md)

---

## 1. Problem Statement & Research Foundation

When teams wire AI agents into event buses (webhooks, pub/sub), they almost always make the same architectural mistake: **connecting raw events directly to full LLM agent invocations**.
- Every issue edit, comment, or status change wakes a deliberative agent ("System 2").
- Latency is 10–60 seconds per reaction; token bills spike; worst of all, **multi-agent feedback storms** emerge (Agent A updates field X → triggers Agent B → updates field Y → re-triggers Agent A).
- Meanwhile, when a single coding agent gets stuck in a pathological loop (editing the same file 6 times while failing the same test, or ballooning a 2-point bug fix into a 40-file refactor), the tracker sits passively as a dumb database until the agent exhausts its max-turns limit.

### Theoretical Grounding
1. **SOFAI — Slow and Fast AI (*npj Artificial Intelligence*, Booch, Fabiano, Rossi et al., 2025)**: Inspired by Kahneman's dual-process theory, SOFAI separates incoming problems into fast experiential reactions (**System 1**), slow deliberative search/reasoning (**System 2**), and a **Metacognitive Controller** that arbitrates between them based on confidence, resource budget, and novelty.
2. **Biological Reflex Arcs & Subsumption Architecture (Sherrington 1906; Brooks 1986)**: In vertebrates, withdrawing a hand from a hot stove does not route through the cerebral cortex; sensory neurons synapse directly onto motor neurons in the **spinal cord ("System 0")** in milliseconds, while sending an asynchronous signal upward to the brain.
3. **Cybernetic Homeostasis & Nociception (Wiener 1948; Ashby's Law of Requisite Variety; Beer's Viable System Model)**: A viable multi-agent platform requires **algedonic (pain/pleasure) signals**—deterministic monitors that detect when an agent trajectory deviates from homeostatic bounds (thrashing, budget burn, scope explosion, stale environment) and trigger an immediate circuit-breaker reflex.

---

## 2. The Three-Tier Reflex Architecture in TrackForge

TrackForge's transactional `DomainEvent` outbox (Sprint 011) is already the sensory nerve fiber of the platform. We partition event handling into three explicit tiers:

```text
                       ┌────────────────────────────────────────────────┐
                       │   DomainEvent Outbox + Heartbeat Telemetry     │
                       └───────────────────────┬────────────────────────┘
                                               │
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 0: SPINAL REFLEXES (In-Process Deterministic Evaluator · <10ms · $0 LLM Cost)           │
│  • Lease expiry → mark EXPIRED, clear traces, re-pool issue, notify watchers                 │
│  • Blocker resolved → when last `blocks` issue hits Done, wake blocked issue's leaseholder   │
│  • Duplicate reflex → cosine(IssueEmbedding) > 0.92 on create → auto-link `is duplicated by` │
│  • Context-rot reflex → Git push modifies file in open issue's Blackboard → flag `stale=true`│
│  • Nociceptive circuit breakers → thrash/loop/budget trip → pause lease + emit algedonic evt │
└──────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                               │ (Only when deterministic rules cannot resolve
                                               │  AND event matches a routing ambiguity)
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: FAST INTUITION (Embedding Router / Tiny Classifier · ~100–300ms · ~100 tokens)       │
│  • Auto-classify component & severity from stack trace / summary                             │
│  • Match issue against Procedural Playbooks (Doc 04) & rank top-3 specialist agents          │
│  • Confidence check: if score >= threshold (e.g. 0.85), apply via Proposal/autoApply;        │
│    if score < threshold, escalate to Tier 2.                                                 │
└──────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                               │ (Only on novel/ambiguous problems, failed
                                               │  circuit breakers, or explicit delegation)
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 2: DELIBERATIVE CORTEX (Full Coding / Planning Agent · Seconds–Minutes · Pre-Packed)    │
│  • Awakened with pre-assembled `context-pack` (Doc 02) + matched Playbook (Doc 04)           │
│  • Executes inside a fenced lease (Doc 01) under homeostatic monitoring                      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Step-by-Step Specification of Core Reflexes

### Step 1: Dependency Unblocking Reflex (Zero-Latency DAG Scheduling)
When Issue `TF-101` transitions to `Done`:
1. The Tier 0 reflex queries all outward `IssueLink` rows where `sourceId = TF-101` and `linkType.outward = "blocks"`.
2. For each target issue `TF-102`, it checks whether *all* inbound `blocks` issues are now in a `Done` statusCategory.
3. If `TF-102` has zero remaining open blockers:
   - It clears the `blocked` flag on `TF-102`.
   - It appends a system fact to `TF-102.blackboard.verifiedFacts`: `"Unblocked: dependency TF-101 completed at <timestamp> (artifacts: <branch/PR>)"`.
   - It emits `issue.unblocked` on the event bus so `pull_next_issue` workers immediately see `TF-102` at the top of the ready queue.

---

### Step 2: Context-Rot / Staleness Reflex (Preventing Outdated Assumptions)
One of the most expensive silent bugs in agentic software engineering occurs when Agent A analyzes an issue on Monday (recording `targetFiles: ["src/services/issueService.ts"]` and line numbers on the Blackboard), and on Tuesday a human or Agent B merges a major refactor of `issueService.ts`. When Agent C picks up the issue on Wednesday, its context pack references functions or line numbers that no longer exist.

**How the Context-Rot Reflex works (integrating with Sprint 038 Git Integration):**
1. When a push/merge webhook arrives (or when another issue in TrackForge transitions to `Done` with `blackboard.targetFiles` overlapping), Tier 0 intersects the modified file list against `Issue.blackboard -> 'targetFiles'` across all open, non-Done issues in the project.
2. Any matching open issue gets `staleContext: true` + a structured `StigmergicAlert` entry:
   ```json
   {
     "kind": "context_rot",
     "file": "apps/backend/src/services/issueService.ts",
     "causedByIssue": "TF-99",
     "commitSha": "a1b2c3d",
     "detectedAt": "2026-11-07T16:00:00Z"
   }
   ```
3. If an agent is *currently* holding a lease on that issue, the next `heartbeat_lease` response delivers the `context_rot` signal immediately so the agent runs `git pull --rebase` and re-reads the file instead of generating a broken diff.

---

### Step 3: Nociceptive Circuit Breakers (Homeostatic Self-Regulation)

Tier 0 continuously evaluates lightweight sliding-window counters per active `IssueLease` and `AgentSession`. When a pathology threshold is crossed, the **Nociceptive Reflex** fires synchronously:

| Breaker Name | Trigger Condition (Deterministic, $0 LLM) | Reflex Action |
|---|---|---|
| **1. Edit-Test Thrash Breaker** | Agent updates `reproduction.status = 'reproduced'` (failing) or emits `error` activity **$\ge 3$ consecutive times** on the same target file without changing hypothesis. | Suspends lease (`status = 'PAUSED_THRASH'`), forces agent to submit a `ReflectionEntry` (Doc 04) before lease can resume, or re-queues issue for a higher-tier model / human review. |
| **2. Status Ping-Pong Breaker** | Issue transitions back and forth between the same two statuses (e.g., `In Progress` ⇄ `In Review`) **$\ge 3$ times** within 2 hours. | Freezes auto-transitions on the issue, sets `needsHumanIntervention = true`, and pages the project lead / delegator. |
| **3. Scope Explosion Breaker** | Active lease deposits `file_edit` traces across **$> \max(8, 3 \times \text{storyPoints})$ files** or touches **$\ge 3$ distinct `Component` boundaries** when only 1 component is set on the issue. | Rejects further `file_edit` trace expansion with `409 SCOPE_EXPLOSION` and instructs the agent to invoke `propose_decomposition` (Doc 05) instead of monolithically refactoring. |
| **4. Token / Cost Burn Breaker** | Cumulative `AiUsage` tokens/cost attributed to `issueId` exceeds the issue's budget cap (e.g. `storyPoints * 500k tokens` or explicit `budgetTokens`). | Revokes active lease, parks any pending mutations as a `Proposal`, and notifies the assignee. |

---

### Step 4: Habit Compilation (System 2 → System 0 Consolidation)
In human cognition (and SOAR's "chunking" mechanism), tasks that initially require slow System 2 deliberation eventually compile into automatic System 0/1 reflexes.

TrackForge supports **Habit Compilation** by connecting Sprint 012 (`Proposal` history) to Sprint 034 (`AutomationRule`):
- Whenever an `ask_agent("triage")` action (Sprint 034 US-AI) produces the same deterministic pattern $K$ times (e.g., 15 issues containing `"ECONNREFUSED 5432"` in description were all assigned `component = "Database"` and `priority = "High"` with 100% human approval), a background job proposes a **Tier 0 `AutomationRule` (`Proposal` kind = `compile_reflex`)**.
- Once a human approves the compiled rule, future matches execute in 5ms at $0 via Tier 0 instead of invoking the LLM.

---

## 4. Data Model (Prisma Schema Additions)

```prisma
model Issue {
  // ... existing fields ...
  staleContext           Boolean @default(false)
  needsHumanIntervention Boolean @default(false)
  budgetTokens           Int?    // Optional hard ceiling on cumulative agent token spend
  tokensSpent            Int     @default(0)
}

model ReflexCircuitTrip {
  id          String   @id @default(cuid())
  projectId   String
  issueId     String
  leaseId     String?
  actorId     String
  breakerKind String   // edit_test_thrash | status_ping_pong | scope_explosion | budget_exceeded | context_rot
  details     Json     // Window metrics that tripped the breaker
  resolution  String   @default("OPEN") // OPEN | REFLECTED | ESCALATED | OVERRIDDEN
  createdAt   DateTime @default(now())
  resolvedAt  DateTime?

  @@index([issueId, resolution])
  @@index([projectId, breakerKind, createdAt])
}
```

---

## 5. Scaling, Difficulties, Impact & Risks

### Scaling Analysis (PostgreSQL Single-Node)
- **Why Tier 0 Scales Effortlessly**: Every breaker condition above is computed from state already present on the `Issue`, `IssueLease`, or a bounded `COUNT(*)` over the last 10 `ChangeHistory` / `StigmergicTrace` rows for *that single issue*. Evaluation takes **<2ms** inside the existing mutation transaction or 011 outbox consumer.
- **Cost Savings**: In fleet simulations, Tier 0 duplicate detection (using existing `IssueEmbedding` vectors from Sprint 012), dependency unblocking, and thrash breakers eliminate **40–70% of wasted LLM invocations**.

### Implementation Difficulties
1. **Tuning Breaker Thresholds**: If the Scope Explosion breaker is too strict (e.g. blocks at 4 files), legitimate cross-cutting tasks (like renaming a shared type across 12 files) will trip false positives.
   - *Solution*: Thresholds are configured per `IssueType` or `Project` (e.g. `Bug` defaults to max 6 files; `Epic` / `Refactor` defaults to 25 files), and an agent can pass a `rationale` to request a one-click or policy-auto-approved scope extension.
2. **Preventing Reflex Cascades**: A Tier 0 reflex that transitions or updates an issue emits a `DomainEvent`, which could trigger another rule.
   - *Solution*: Reuse Sprint 034's structural loop guard (`originChain: string[]` carried in the event metadata, hard cap `depth <= 5`, and `excludeRuleIds`).

### Risks & Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| **False-positive thrash trip** during legitimate TDD (writing 3 failing tests intentionally) | Medium | Only increment the thrash counter when the *same* test/reproduction command fails after an edit, or allow the agent to tag activity as `phase: 'writing_red_tests'`. |
| **Habit compilation suggests brittle regex rules** | Low | Compiled reflexes are never activated automatically; they are created as `enabled: false` + a Sprint 012 `Proposal` requiring admin approval after a dry-run backtest over the last 100 issues. |

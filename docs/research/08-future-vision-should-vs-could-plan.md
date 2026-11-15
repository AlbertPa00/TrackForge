# 08 — The Future of TrackForge: "What Should Be" vs. "What Could Be" & Strategic Plan

**Status**: Strategic Architecture Plan (Research — Not Yet Scheduled)
**Baseline**: Sprints 001–025 Done (M1 Parity MVP & M2 Daily-Driver Parity complete as of 2026-11-07)
**Horizon**: M3–M6 Hooks (Sprints 026–046) · Post-GA Wave 1 (Sprint 047) · Post-GA Wave 2 (Candidate Sprints 051–055)

---

## 1. The Strategic Divide: "What Should Be" vs. "What Could Be"

When designing for next-generation virtual workers, it is critical to separate **normative engineering necessities ("What SHOULD Be")** from **transformative frontier possibilities ("What COULD Be")**:

- **What SHOULD Be (The Correctness & Governance Floor)**:
  If you put 5–20 coding agents (Claude Code, Codex, Devin, internal workers) on TrackForge tomorrow to build real software together, what *breaks* deterministically?
  Without concurrency control, structured state handoffs, loop circuit-breakers, and independent verification, multi-agent runs fail in predictable ways: agents overwrite each other's fields, lose 62% of technical entities across comments, burn $50 looping on the same failing test, or weaken test assertions to fake completion. **Fixing these is not speculative—it is the minimum viable correctness layer for multi-agent work.**
- **What COULD Be (The Category-Defining Ceiling)**:
  Once the correctness floor holds, the accumulated issue graph + event outbox + trajectory log unlocks capabilities no human-only tracker (Jira, Linear, GitHub Issues) can replicate: **honeybee-style swarm hypothesis tournaments, game-theoretic blind peer review, self-compiling habits, Monte Carlo sprint simulation, and a live labor market with portable cryptographic reputation.**

---

## 2. "What SHOULD Be" — The 7 Non-Negotiable Pillars

Every item below has a **high signal-to-noise ratio**, **runs in $O(1)$ or $<5\text{ms}$ on single-node PostgreSQL**, requires **zero external infrastructure**, and solves an empirically measured failure mode.

| # | Normative Pillar ("Should Be") | Source Doc | Why It Is Mandatory (Failure Mode If Omitted) | Cost / Complexity |
|---|---|---|---|---|
| **S1** | **Optimistic Concurrency (`version` + `If-Match`) & Fenced Leases (`claim`, `fenceToken`, `SKIP LOCKED`)** | [Doc 01](01-coordination-leases-and-stigmergy.md) | Without fenced leases, two agents pull the same `To Do` issue or a paused "zombie" agent wakes up and overwrites a newer agent's work. | **XS–S** · 1 table + 2 integer columns on `Issue` |
| **S2** | **Heartbeat Signal Piggybacking** | [Doc 01](01-coordination-leases-and-stigmergy.md) | CLI coding agents cannot easily host inbound webhooks. Returning human stop/steer directives, `staleContext`, and file collisions inside the periodic `POST /lease/heartbeat` response gives instant control with zero polling bloat. | **XS** · Part of lease heartbeat |
| **S3** | **Typed Issue Blackboard (`JSONB`) + Mandatory Handoff Envelope** | [Doc 02](02-shared-blackboard-and-context-packs.md) | *SE-Blackboard* (2026) proved prose comments lose **63.8%** of technical entities across agent handoffs. A structured Blackboard (`targetFiles`, `reproduction`, `verifiedFacts`, `hypotheses`) + mandatory handoff on lease release fixes this structurally. | **S–M** · 1 `JSONB` column + `Handoff` table |
| **S4** | **Single-Call Token-Budgeted `GET /issue/{key}/context-pack`** | [Doc 02](02-shared-blackboard-and-context-packs.md) | Cold-starting an agent currently takes ~7 MCP tool calls and wastes tokens on low-signal chatter. One deterministic, priority-packed SQL read (`P0 Core → P1 Reflections/Handoff → P2 Blackboard → P3 DAG → P4 Comments`) cuts startup latency by 80%. | **S** · Pure read endpoint, $0 LLM cost |
| **S5** | **Tier 0 Spinal Reflexes & Nociceptive Circuit Breakers** | [Doc 03](03-reflex-engine-and-autonomic-loops.md) | Waiting for an agent to hit a 50-turn limit while failing the same test 10 times wastes budget. Deterministic counters on the `DomainEvent` outbox pause thrashing leases after 3 identical failures and flag `staleContext` when Git commits touch Blackboard files. | **M** · In-process consumer on 011 outbox |
| **S6** | **Episodic Reflexion Buffer (`doNotRepeat[]`)** | [Doc 04](04-reflexion-and-organizational-memory.md) | When Agent A fails on `TF-104`, Agent B must not repeat the exact same dead-end. Requiring a 300-char causal `ReflectionEntry` on failed lease release (*Reflexion*, NeurIPS 2023) injects prior dead-ends into P1 of the next `context-pack`. | **S** · 1 append-only table |
| **S7** | **Separation-of-Duties Validator + Registered Report Red-Test Lock + JIT Lease Capabilities** | [Doc 05](05-verification-contracts-and-settlement.md), [Doc 06](06-labor-market-reputation-and-federation.md), [Doc 07](07-scientific-publishing-and-cross-disciplinary-frontiers.md) | Agents must not self-certify `Done`, weaken test files to fake a green build, or hold standing write access to issues they haven't leased. Locking the Stage-1 failing test SHA-256 hash + requiring `reviewer != implementer` enforces honest engineering. | **M** · Extends 009 `TransitionRule` + 006 auth middleware |

---

## 3. "What COULD Be" — The 7 Transformative Frontier Horizons

These proposals are higher complexity or higher coordination overhead. They should **not** be built until S1–S7 are running in production—but the schema and event hooks we build today should leave the door wide open for them.

| # | Frontier Horizon ("Could Be") | Source Doc | What It Unlocks When Fleet Scale Justifies It | Trigger Condition to Build It |
|---|---|---|---|---|
| **C1** | **Active Inference Epistemic Foraging Gate** | [Doc 07 §2.5](07-scientific-publishing-and-cross-disciplinary-frontiers.md) | Computes `epistemicUncertainty` from the Blackboard; locks the lease to *read/reproduce/ask* until the bug is reproduced and files are localized, preventing premature 500-line speculative diffs. | Build as soon as S3 (Blackboard) has 2+ weeks of real agent usage data to calibrate the uncertainty weights. |
| **C2** | **Nanopublications & ATMS Retraction Cascades** | [Doc 07 §2.2](07-scientific-publishing-and-cross-disciplinary-frontiers.md) | Every Blackboard fact and `ProjectMemory` tracks `dependsOnNanopubIds[]`. When an upstream assumption or file span is falsified, a recursive CTE flips all downstream derived beliefs to `SUSPECT_RETRACTED_PREMISE`. | Build when projects accumulate >50 `ProjectMemory` rows and stale cross-issue assumptions become a bottleneck. |
| **C3** | **3-Tier Organizational Memory (*G-Memory*) & Learned Playbooks (*LEGOMem*)** | [Doc 04 §2.2](04-reflexion-and-organizational-memory.md) | Distills closed issues + `ReflectionEntry` rows into reusable project `gotchas`, `conventions`, and step-by-step `playbooks` automatically attached to future `context-pack` responses by component/type. | Build after S6 (`ReflectionEntry`) has collected >100 real reflections across sprints. |
| **C4** | **Empirical Reputation Ledger & Self-Adjusting Autonomy Slider** | [Doc 06 §2.2](06-labor-market-reputation-and-federation.md) | Tracks per-agent, per-component Wilson reliability scores, first-pass test rates, and token cost per story point; automatically graduates proven agents from `always` → `destructiveOnly` and demotes regressing models. | Build after Sprint 047's static `approvalPolicy` slider ships and >3 distinct agent personas/models operate in parallel. |
| **C5** | **Honeybee Quorum Sensing & Swarm Hypothesis Tournaments** | [Doc 07 §2.4](07-scientific-publishing-and-cross-disciplinary-frontiers.md) | When a hard bug trips the Thrash Breaker, spawns $K=3$ parallel scout probes testing competing hypotheses with non-linear cross-inhibition ("stop-signals" via falsifying counterexamples) until quorum $Q$ locks the winner. | Build as an escalation handler for S5's `edit_test_thrash` circuit breaker on P0/Highest-priority bugs. |
| **C6** | **Peer Elicitation Games (PEG) + Dendritic Cell Immune Quarantine** | [Doc 07 §2.3, §2.6](07-scientific-publishing-and-cross-disciplinary-frontiers.md) | Blind dual-review from distinct model families scored by mutual information (defeating lazy "LGTM" reviews) + Danger-Theory $MCAV$ correlation that auto-quarantines compromised agents during tissue stress. | Build for high-security / unattended overnight fleet operations. |
| **C7** | **Contract Net Auction Market, Google A2A Federation & Trajectory Benchmarking** | [Doc 06 §2.3–2.4](06-labor-market-reputation-and-federation.md) | Cross-vendor A2A task delegation (`/.well-known/agent-card.json`), reverse-auction bidding for complex epics, and exporting closed issues as deterministic SWE-bench-style evaluation suites to "interview" new models before granting write tokens. | Build when integrating external multi-vendor agent clouds or benchmarking new LLM releases against your own repo history. |

---

## 4. Zero-Regret Hooks to Plant in Upcoming Sprints (026–047)

Because Sprints 001–025 are now complete and TrackForge is entering **M3 (026–030) → M4 (031–035) → M5 (036–042) → M6 (043–046) → Post-GA (047)**, we can save massive future refactoring by planting five tiny, **zero-cost design hooks** inside the sprints already on the roadmap:

### Hook 1 — Sprint 026 (Dashboards & Gadgets) & Sprint 027/028 (Reports)
- **What's already planned**: Gadget framework (`DashboardGadget`), chart kit, agile & org reports.
- **Zero-regret hook to plant**:
  - Design the 026 gadget registry so **human oversight consoles** ("Agent Exception Queue: Blocked / Needs Answer / Circuit Tripped", "Active Leases & File Heatmap") are just standard gadget types consuming JQL + `/api/internal/*`.
  - In 028 (Org/Project Reports), include `channel` and `actor.isAgent` as standard group-by dimensions so **human vs. agent throughput, cycle time, and reopen rates** come for free before the full Reputation Ledger (Doc 06) is even built.

### Hook 2 — Sprint 032 (JQL Completion)
- **What's already planned**: `WAS`, `CHANGED`, `updatedBy`, `linkedIssues`.
- **Zero-regret hook to plant**:
  - Ensure `CHANGED` and `WAS` compilation over `ChangeHistory` can query status ping-pong counts (e.g., `status CHANGED FROM "In Review" TO "In Progress"`), which directly powers Doc 03's Status Ping-Pong Circuit Breaker.

### Hook 3 — Sprint 034 (Automation Rules & Agent Triage)
- **What's already planned**: `AutomationRule` (`trigger`, `conditions`, `actions`), depth cap (`max 5`), `AutomationRun` step log, `ask_agent` action.
- **Zero-regret hook to plant**:
  - Structure 034's trigger/condition/action registry (`FR-006`) so **Tier 0 Spinal Reflexes** (Doc 03: auto-unblock downstream issues when last `blocks` link hits `Done`, auto-link high-cosine duplicates) are simply **built-in system rules in the 034 engine** rather than a second competing rule engine!
  - Include `ruleOrigin: 'human' | 'compiled_habit'` on `AutomationRule` so Habit Compilation (System 2 → System 0) slots straight into 034 later.

### Hook 4 — Sprint 038 (Git Integration & Development Panel)
- **What's already planned**: `DevelopmentItem` (`branch | commit | pull_request | build`), GitHub/GitLab/Bitbucket signed webhook receivers.
- **Zero-regret hook to plant**:
  - When ingesting push and PR webhooks into `DevelopmentItem.payload`, **always extract and store `modifiedFiles: string[]`** (GitHub's `commits[].modified/added/removed` array) in a normalized column or indexed JSON key.
  - Why? Because having `modifiedFiles` on every ingested commit makes both the **Context-Rot Reflex** (Doc 03 — flagging open issues whose Blackboard references those files) and the **Registered Report Test-Hash Lock** (Doc 07) trivial 20-line subscribers on `dev_status_changed`!

### Hook 5 — Sprint 047 (Agent Experience Polish)
- **What's already planned**: `Issue.delegateId`, `AgentSession`, `AgentQuestion`, `approvalPolicy`, `Project.agentGuidance`.
- **Zero-regret hook to plant**:
  - Merge **Wave A ("Should Be" S1–S4)** directly into Sprint 047 or an adjacent `047b` slice:
    - Combine `AgentSession` with `IssueLease` (`fenceToken`, `ttlSeconds`, `heartbeatAt`) so you don't create two separate "active agent run" tables.
    - Add `Issue.version` (`If-Match`), `Issue.blackboard`, and `GET /api/internal/issues/{key}/context-pack` right alongside `Project.agentGuidance`.

---

## 5. Concrete Post-047 Sprint Plan (Candidate Wave: Sprints 051–055)

Following TrackForge's constitution (Principle I: sprint-sized runnable slices; hardening every 4 feature sprints per `docs/sprints/hardening-cadence.md`), here is the step-by-step sprint plan for turning these research documents into shipped software after Sprint 047:

```text
034 (Automation) ──┬──► 047 (Delegate/Sessions) ──► 051 (Leases, Blackboard & Context-Pack)
038 (Git Ingest) ──┘                                       │
                                                           ├──► 052 (Spinal Reflexes, Breakers & Reflexion)
                                                           ├──► 053 (Proof-Carrying Checks, Red-Lock & DAGs)
                                                           └──► 054 (JIT Capabilities, Reputation & Memory)
                                                                       │
                                                                       ▼
                                                                ═055 Hardening H7 (Multi-Agent Fleet Gate)═
```

### Sprint 051 — Agent Coordination Core: Fenced Leases, Blackboard & Context Packs
- **Scope**: `Issue.version` + `If-Match` 409 handling; `IssueLease` (`claim_issue`, `pull_next_issue` via `SKIP LOCKED`, `heartbeat_lease` with signal piggybacking, reaper job); `StigmergicTrace` file/symbol collision detection; `Issue.blackboard` + `patch_blackboard`; mandatory `Handoff` envelope on unfinished lease release; `GET /api/internal/issues/{key}/context-pack`.
- **Size**: M · **Docs**: [01](01-coordination-leases-and-stigmergy.md), [02](02-shared-blackboard-and-context-packs.md).
- **Gate / Eval**: Two concurrent MCP agents pulling from the same project queue never claim the same issue; stale `fenceToken` is rejected with `409`; `get_context_pack` returns full briefing under budget in `<10ms`.

### Sprint 052 — Autonomic Reflexes, Nociceptive Breakers & Episodic Reflexion
- **Scope**: Tier 0 reflexes on 011/034 bus (dependency unblocking, Git `modifiedFiles` → `staleContext` flagger); Nociceptive Circuit Breakers (`edit_test_thrash`, `status_ping_pong`, `scope_explosion`, `budget_exceeded`); Active Inference `epistemicUncertainty` foraging gate; `ReflectionEntry` (`doNotRepeat[]` required on failed lease release and injected into P1 of `context-pack`).
- **Size**: M · **Docs**: [03](03-reflex-engine-and-autonomic-loops.md), [04](04-reflexion-and-organizational-memory.md), [07 §2.5](07-scientific-publishing-and-cross-disciplinary-frontiers.md).
- **Gate / Eval**: Simulated thrashing agent is paused on 3rd identical failure, forced to record a `ReflectionEntry`, and the subsequent retry receives the reflection in its context pack.

### Sprint 053 — Verifiable Engineering: Proof-Carrying Transitions, Registered Reports & Work DAGs
- **Scope**: `AcceptanceCheck` (`jql_invariant`, `blackboard_invariant`, `signed_attestation`, `review_verdict`); Registered Report Stage-1 Red-Test SHA-256 lock; `IssueReview` structured findings; 009 workflow validators (`all_acceptance_checks_passed`, `separation_of_duties`); `POST /api/internal/issues/{key}/decompose` acyclic DAG creator with disjoint `targetFiles` verification.
- **Size**: M–L · **Docs**: [05](05-verification-contracts-and-settlement.md), [07 §2.1](07-scientific-publishing-and-cross-disciplinary-frontiers.md).
- **Gate / Eval**: Coding agent cannot transition its own leased issue to `Done` (`separation_of_duties`), cannot tamper with a locked Stage-1 test file without invalidating the check, and `dryRun` transition returns the exact missing evidence checklist.

### Sprint 054 — Fleet Governance: JIT Capability Security, Organizational Memory & Reputation
- **Scope**: `lease_bound_write` token scope (POLA enforcement in auth middleware); `ProjectMemory` (`gotcha | convention | playbook`) with Nanopublication `dependsOn` links and recursive CTE retraction cascade; `AgentProfile` empirical reputation rollup + dynamic `approvalPolicy` graduation; `suggested-agents` routing endpoint.
- **Size**: L · **Docs**: [04](04-reflexion-and-organizational-memory.md), [06](06-labor-market-reputation-and-federation.md), [07 §2.2](07-scientific-publishing-and-cross-disciplinary-frontiers.md).
- **Gate / Eval**: An agent with `lease_bound_write` gets `403` when attempting to edit an unleased issue, `200` on its leased issue, and `403` the instant the lease expires; retracting an upstream Nanopublication cascades `SUSPECT_RETRACTED_PREMISE` to dependent memories.

### Sprint 055 — Hardening H7: Multi-Agent Fleet Stress & Adversarial Gate
- **Scope**: 10-agent concurrent chaos & race-condition suite (`SKIP LOCKED`, zombie lease fencing, simultaneous file-trace collisions); prompt-injection & test-tampering adversarial suite; MCP contract eval expansion covering all 051–054 tools; load benchmark proving single-node Postgres handles 50 concurrent simulated agent loops at `<15ms` p95.
- **Size**: M · **Follows**: [`docs/sprints/hardening-cadence.md`](../sprints/hardening-cadence.md).

---

## 6. Explicit Anti-Goals (What TrackForge Must *Never* Become)

To protect Constitution Principle V (Explicit Simplicity) and F7 (Single-Binary Self-Hosted Operation):
1. **TrackForge is the Control Plane & Blackboard, NOT the Sandbox Container Host**: TrackForge coordinates leases, blackboards, memories, and signed check attestations; it must never execute arbitrary untrusted repo code or manage Docker/VM containers inside the Express process.
2. **No Mandatory LLM on the Critical Read/Write Path**: Every core coordination primitive (claiming a lease, patching a blackboard, assembling a `context-pack`, evaluating Tier 0 circuit breakers, verifying a test-hash lock) must execute deterministically in PostgreSQL + TypeScript in milliseconds with **zero LLM calls required**.
3. **Never Break Human First-Class Legibility**: Every Blackboard state, Stigmergic Trace, Reflex Circuit Trip, and Reflection Entry must render cleanly in the React UI as human-readable panels and badges with one-click human override.

# TrackForge Research — Next-Generation Agentic Coordination & Virtual Worker Architecture

**Status**: Research & Architecture Proposals (Not Yet Scheduled for Implementation)
**Date**: 2026-11-07
**Governed by**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) (Principle V: Explicit Simplicity · Principle VI: AI-Native Operability)
**Related Sprints**: [011 Events](../sprints/011-events-webhooks-realtime.md) · [012 AI Copilot & HITL](../sprints/012-ai-copilot-human-in-the-loop.md) · [034 Automation & Agent Triage](../sprints/034-automation-agent-triage.md) · [047 Agent Experience Polish](../sprints/047-agent-experience-polish.md)

---

## 1. Executive Thesis

TrackForge already solves **single-agent operability** better than almost any issue tracker: self-describing OpenAPI + createmeta, MCP parity, `dryRun` previews, `Idempotency-Key` replay safety, transactional `DomainEvent` outbox, and `Proposal` human-in-the-loop gates.

However, when shifting from **one agent assisting a human** to **a fleet of heterogeneous coding agents (Claude Code, Codex, Devin, custom workers) collaborating to build software**, the bottleneck moves from *tool access* to **multi-agent coordination, information fidelity, autonomic regulation, and verifiable trust**.

Empirical multi-agent systems (MAS) research from 2023–2026 exposes four structural failure modes when coding agents coordinate through traditional issue trackers:

1. **Handoff Information Decay (*SE-Blackboard*, IEEE Access 2026)**: When agents coordinate via sequential natural-language comments (message passing), **63.8% of critical technical entities** (file paths, symbol names, reproduction commands, verified constraints) are lost across handoffs (Information Fidelity Score = `0.362`). Replacing prose handoffs with a structured shared-state **Blackboard** improves information fidelity by **+62%** (`0.586`) and file-targeting accuracy by **+27.5 percentage points** (`82.6%` vs `55.1%`).
2. **Race Conditions & Split-Brain Work (*Stigmergy & Distributed Systems*, Kleppmann 2016; Crowston 2015)**: Jira's `assignee` field is an advisory label, not a distributed lock. Without **fenced leases**, **optimistic concurrency (`If-Match`)**, and **stigmergic file/symbol traces**, two agents routinely claim the same ticket or edit overlapping files in separate worktrees, discovering the collision only at PR merge time.
3. **Deliberative Overload (*SOFAI / Thinking Fast and Slow in AI*, *npj AI* 2025)**: Waking a full LLM agent ("System 2") on every webhook event burns token budgets and creates feedback storms. Biological and cybernetic systems handle 90%+ of regulation through **zero-LLM spinal reflexes ("System 0")** and **tiny classifiers ("System 1")**, escalating to System 2 only on novelty or circuit-breaker trips.
4. **Amnesia Across Retries (*Reflexion*, NeurIPS 2023; *G-Memory*, NeurIPS 2025; *LEGOMem*, 2025)**: When an agent fails on an issue and releases it, the next agent starts cold or wades through raw logs. Converting failure traces into structured **verbal reinforcement reflections** (`doNotRepeat[]` + root-cause hypotheses) and distilling closed issues into **hierarchical organizational memory** boosts pass rates by 11–21% without weight updates.

---

## 2. Document Map

Each document in `docs/research/` defines one architectural pillar step-by-step: theoretical foundation, concrete PostgreSQL/Prisma data models, REST + MCP surfaces, step-by-step execution flows, scaling mechanics under TrackForge's **single-binary + PostgreSQL constraint**, failure modes, and migration paths.

| # | Document | Core Primitives | Primary Research Lineage |
|---|---|---|---|
| **01** | [`01-coordination-leases-and-stigmergy.md`](01-coordination-leases-and-stigmergy.md) | Fenced Issue Leases, Optimistic Concurrency (`If-Match`), Stigmergic Intent Traces (file/symbol locks), Dead-Agent Re-pooling | Kleppmann (Fencing Tokens), Grassé / Crowston (Software Stigmergy) |
| **02** | [`02-shared-blackboard-and-context-packs.md`](02-shared-blackboard-and-context-packs.md) | Per-Issue Typed Blackboard (`JSONB` + RFC 6902 Patch), Mandatory Handoff Envelopes, Typed Comments, Token-Budgeted `context-pack` | *SE-Blackboard* (IEEE Access 2026), Hearsay-II Blackboard Systems |
| **03** | [`03-reflex-engine-and-autonomic-loops.md`](03-reflex-engine-and-autonomic-loops.md) | System 0 / 1 / 2 Tiered Reflex Arcs on `DomainEvent`, Homeostatic Nociception (Loop/Thrash/Scope-Creep Circuit Breakers), Context-Rot Detector | *SOFAI* (*npj AI* 2025), Kahneman Dual-Process, Beer's Viable System Model |
| **04** | [`04-reflexion-and-organizational-memory.md`](04-reflexion-and-organizational-memory.md) | Episodic Reflexion Buffer (`doNotRepeat`), 3-Tier Organizational Graph (*G-Memory*), Procedural Playbooks (*LEGOMem* / *SMITH*) | *Reflexion* (NeurIPS 2023), *G-Memory* (NeurIPS 2025), *SMITH* (2025) |
| **05** | [`05-verification-contracts-and-settlement.md`](05-verification-contracts-and-settlement.md) | Executable Issue DAGs, Proof-Carrying Transitions (`AcceptanceCheck`), Separation-of-Duties Workflow Validators, Signed Provenance | Necula (Proof-Carrying Code), Design-by-Contract, Cryptographic Attestation |
| **06** | [`06-labor-market-reputation-and-federation.md`](06-labor-market-reputation-and-federation.md) | Contract Net Task Bidding, JIT Capability Security (Lease-Bound Scopes), Empirical Reputation Ledger, Graduated Autonomy, Google A2A Protocol | Smith (Contract Net Protocol, 1980), Dennis & Van Horn (Capabilities), A2A (2025) |
| **07** | [`07-scientific-publishing-and-cross-disciplinary-frontiers.md`](07-scientific-publishing-and-cross-disciplinary-frontiers.md) | Registered Reports (Red-Test Hash Lock), Nanopublications & ATMS Retraction Cascades, Peer Elicitation Games (PEG), Honeybee Quorum Sensing, Active Inference Epistemic Gates, Immunological Danger Theory | Chambers (Registered Reports), Doyle/de Kleer (TMS), NeurIPS 2025 (PEG), Seeley/*Comms Phys* 2025, Friston (Active Inference), Matzinger (Danger Theory) |
| **08** | [`08-future-vision-should-vs-could-plan.md`](08-future-vision-should-vs-could-plan.md) | **"What SHOULD Be" vs. "What COULD Be"** normative/exploratory split, Zero-Regret Hooks for Sprints 026–047, and Candidate Post-GA Sprint Plan (Sprints 051–055) | Synthesis & Roadmap Architecture |

---

## 3. Master Comparative Analysis: Impact, Scaling, Difficulty & Risks

The table below evaluates all proposed capabilities across six engineering dimensions so product and architecture decisions can prioritize ruthlessly.

| Proposal | Doc | Impact on Agent Fleet | Implementation Difficulty | Scaling Behavior (Postgres Single-Node) | Primary Technical Risk | Recommended Horizon |
|---|---|---|---|---|---|---|
| **Optimistic Concurrency (`If-Match` / `version`)** | 01 | **High** — eliminates silent lost updates immediately | **XS** (1–2 days) | **O(1)** — single integer column check in `UPDATE ... WHERE version = $1` | Clients omitting header if optional; mitigate by making required on `channel=mcp` | **Immediate** (Pre-034) |
| **Token-Budgeted `GET /issue/{key}/context-pack`** | 02 | **Very High** — cuts agent cold-start from ~7 tool calls to 1 deterministic call | **S** (3–4 days) | **O(1) read** — single indexed join query + deterministic token truncation | Token estimator drift vs model tokenizers; mitigate with `chars/4` safety margin | **Immediate** (Sprint 047 pull-forward) |
| **Fenced Issue Leases (`claim` / `heartbeat`)** | 01 | **Very High** — prevents two agents working the same issue; automatic dead-agent recovery | **S–M** (1 week) | **Excellent** — 1 row per active issue; expired leases reaped by 016 cron every 30s | Clock skew if TTL computed client-side; mitigate by using DB `NOW()` exclusively | **Near-Term** (Sprint 047) |
| **Per-Issue Shared Blackboard + Handoff Envelopes** | 02 | **Very High** (+62% handoff fidelity per *SE-Blackboard*) | **M** (1–2 weeks) | **Very Good** — `JSONB` column on `Issue` with GIN index; bounded at 64 KB per issue | Schema bloat if agents dump raw logs into blackboard; enforce strict Zod caps | **Near-Term** (Sprint 047) |
| **Stigmergic File/Symbol Intent Traces** | 01 | **High** — detects cross-issue merge collisions *before* code is written | **M** (1 week) | **Moderate** — high write rate if agents emit per file; requires TTL + batch upsert | Noisy traces if agents forget to clear; tie trace lifetime strictly to `leaseId` | **Mid-Term** (With 038 Git Integration) |
| **System 0 Spinal Reflex Engine + Circuit Breakers** | 03 | **Very High** — stops infinite agent loops & token burn at $0 LLM cost | **M** (1–2 weeks) | **Excellent** — rides existing 011 `DomainEvent` outbox consumer in-process | Reflex cascades (Rule A triggers Reflex B); reuse 034's depth-cap (`maxDepth = 5`) | **Mid-Term** (Sprint 034 extension) |
| **Episodic Reflexion Buffer (`ReflectionEntry`)** | 04 | **High** — stops agents repeating the exact same failed approach on retry | **S–M** (1 week) | **Excellent** — append-only table (~1–5 rows per failed issue); tiny storage footprint | Hallucinated self-reflections poisoning next agent; require linking to a failed check/error | **Mid-Term** (Sprint 047) |
| **Proof-Carrying Transitions & Separation of Duties** | 05 | **Very High** — eliminates "LLM claims Done when tests fail" | **M** (1–2 weeks) | **Good** — webhook/check execution runs on 016 job queue, not inside HTTP tx | Untrusted shell execution if checks run arbitrary code; restrict to signed CI attestations + HTTP/JQL | **Mid-Term** (Sprint 034 / 038) |
| **Registered Reports (Stage 1 Red-Test Hash Lock)** | 07 | **Very High** — prevents agents from weakening tests to fake green builds | **S** (3–4 days) | **O(1)** — SHA-256 hash comparison on locked test files | Legitimate test refactors mid-PR; allow Reviewer/Human re-lock approval | **Mid-Term** (With Doc 05 Checks) |
| **Active Inference Epistemic Gate (Reproduce Before Code)** | 07 | **High** — forces file localization & bug reproduction before large code diffs | **S** (2–3 days) | **O(1)** — arithmetic over existing `Issue.blackboard` completeness | Over-constraining trivial 1-line typos; bypass gate when `storyPoints <= 1` | **Mid-Term** (With Doc 02 Blackboard) |
| **Nanopublications & ATMS Retraction Cascades** | 07 | **High** — auto-invalidates downstream facts/memories when an upstream assumption breaks | **M** (1 week) | **Excellent** — Postgres `WITH RECURSIVE` over justification edges (<2ms) | Over-eager cascade if agents link too broadly; distinguish `hard_depends` vs `soft_cited` | **Mid-Term** (With Doc 04 Memory) |
| **3-Tier Organizational Memory (*G-Memory* + Playbooks)** | 04 | **High** — compounds team knowledge across sprints | **L** (2–3 weeks) | **Moderate** — vector similarity over `IssueEmbedding` / `MemoryEntry` scales to ~100k rows in Postgres before needing `pgvector` HNSW | Memory pollution (outdated insights); requires decay weights + human/reviewer curation | **Long-Term** (Post-GA) |
| **JIT Lease-Bound Capability Tokens** | 06 | **High** (Security) — zero standing privileges for worker agents | **M–L** (2 weeks) | **Excellent** — piggybacks on `IssueLease` check in auth middleware | Breaks workflows where an agent legitimately needs to file a side-quest bug in another component | **Long-Term** (Post-031 Schemes) |
| **Danger Theory Dendritic Cell Quarantine** | 07 | **High** (Safety) — correlates sensitive actions with codebase stress to quarantine rogue agents | **M** (1 week) | **Excellent** — sliding-window PAMP/Danger/Safe counters on outbox | False quarantine during intentional breaking migrations; add `migration_mode` safe-signal | **Long-Term** (Post-GA) |
| **Peer Elicitation Games (PEG) Blind Dual-Review** | 07 | **Medium–High** — defeats lazy "LGTM" reviewer agents without ground truth | **M** (1 week) | **O(1)** — runs only on high-risk/security issues | Doubles review token cost on gated issues; reserve for `High` security or `storyPoints >= 8` | **Long-Term** (Post-GA) |
| **Honeybee Quorum Sensing + Cross-Inhibition** | 07 | **Medium** — resolves elusive bugs via parallel hypothesis probes + falsification stop-signals | **M–L** (2 weeks) | **Very Good** — bounded to $K \le 5$ competing hypotheses on one issue | Overkill for routine CRUD tasks; invoke only on circuit-breaker escalation | **Far Horizon** (v2.0+) |
| **Empirical Reputation & Graduated Autonomy** | 06 | **Medium–High** — automates trust levels (`always` → `destructiveOnly` → `never`) | **L** (2–3 weeks) | **Good** — materialized rollup per agent updated asynchronously on issue close | Goodhart's Law (agents gaming easy issues to boost score); weight by complexity & human review | **Long-Term** (Post-GA) |
| **Contract Net Bidding & A2A Federation** | 06 | **Medium** (High for multi-vendor fleets, low for small teams) | **XL** (3–4 weeks) | **Moderate** — auction windows add coordination latency (seconds to minutes) per task | Over-engineering for teams with <5 agents; keep static routing as default | **Far Horizon** (v2.0+) |

---

## 4. What Works Best Together: Recommended Phased Rollout

Rather than implementing all six documents at once (which would violate Constitution Principle I and V), these proposals naturally stack into four self-contained waves that each deliver immediate value.

### Wave A — The "Zero-Collision & Cold-Start" Foundation (Highest ROI, Lowest Risk)
*Target: Can be pulled into Sprint 047 or a dedicated pre-047 slice.*
1. **Optimistic Concurrency (`version` + `If-Match`)** on `Issue` ([Doc 01](01-coordination-leases-and-stigmergy.md)).
2. **Fenced Issue Leases** (`POST /issue/{key}/claim`, heartbeat, auto-expiry) ([Doc 01](01-coordination-leases-and-stigmergy.md)).
3. **Structured Issue Blackboard + Mandatory Handoff Envelope** ([Doc 02](02-shared-blackboard-and-context-packs.md)).
4. **Token-Budgeted `GET /issue/{key}/context-pack`** combining issue fields, blackboard, active lease, and handoff trail ([Doc 02](02-shared-blackboard-and-context-packs.md)).

**Why this wave wins first**: It requires zero LLM calls inside TrackForge, zero external infrastructure beyond PostgreSQL, and solves the two biggest daily pain points of multi-agent coding: agents stepping on each other and agents losing context across handoffs.

### Wave B — The "Autonomic Nervous System & Anti-Amnesia" Layer
*Target: Pairs naturally with Sprint 034 (Automation) and Sprint 038 (Git Integration).*
1. **System 0 Spinal Reflexes & Homeostatic Circuit Breakers** (thrash detection, automatic lease pause on 3× repeated failure, context-rot flagging when referenced files change in Git) ([Doc 03](03-reflex-engine-and-autonomic-loops.md)).
2. **Episodic Reflexion Buffer** (requiring a structured `ReflectionEntry` when a lease is surrendered or a transition check fails) ([Doc 04](04-reflexion-and-organizational-memory.md)).
3. **Stigmergic File/Symbol Intent Traces** linked to active leases so two issues touching `src/services/issueService.ts` raise an early collision warning ([Doc 01](01-coordination-leases-and-stigmergy.md)).

### Wave C — The "Cryptographic Trust & Verification" Layer
*Target: Extends Sprint 009 Workflows + Sprint 038 Git/CI.*
1. **Separation-of-Duties Workflow Validator** (`actor != leaseHolder` for review transitions) ([Doc 05](05-verification-contracts-and-settlement.md)).
2. **Proof-Carrying Transitions (`AcceptanceCheck`)** verifying signed CI/eval attestations or JQL invariants before allowing transition to `Done` ([Doc 05](05-verification-contracts-and-settlement.md)).
3. **Executable Task DAGs** (`decompose` into fan-in/fan-out dependency graphs with automatic downstream wake-ups) ([Doc 05](05-verification-contracts-and-settlement.md)).

### Wave D — The "Autonomous Labor Economy" Layer
*Target: Post-GA Differentiator.*
1. **3-Tier Organizational Memory (*G-Memory*) & Procedural Playbooks** ([Doc 04](04-reflexion-and-organizational-memory.md)).
2. **Empirical Agent Reputation Ledger & Dynamic Autonomy Slider** ([Doc 06](06-labor-market-reputation-and-federation.md)).
3. **JIT Lease-Bound Capabilities, Contract Net Bidding, and Google A2A Protocol Peer Endpoint** ([Doc 06](06-labor-market-reputation-and-federation.md)).

> **For the complete "What SHOULD Be" (normative necessities) vs. "What COULD Be" (frontier horizons) analysis, zero-regret hooks for Sprints 026–047, and the candidate Sprint 051–055 breakdown, see [`08-future-vision-should-vs-could-plan.md`](08-future-vision-should-vs-could-plan.md).**

---

## 5. Architectural Guardrails (Preserving TrackForge's DNA)

Every proposal in this folder obeys five strict constraints derived from [`AGENTS.md`](../../AGENTS.md) and [`docs/architecture-review-agentic.md`](../architecture-review-agentic.md):

1. **Single-Binary + PostgreSQL Only**: No Redis, Kafka, or external vector DB required. Leases use PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` and monotonic DB sequences; reflexes use the existing `DomainEvent` outbox (`011`) and durable job runner (`016`).
2. **Jira v2 Surface Intact**: All new agentic coordination endpoints live under `/api/internal/agent/*` or additive fields (`fields.blackboard`, `fields.lease`), keeping `/rest/api/2/*` 100% Jira-compatible.
3. **Previewable & Idempotent (`dryRun` + `Idempotency-Key`)**: Every mutating coordination endpoint (claiming a lease, patching a blackboard, submitting a reflection, awarding a bid) supports `?dryRun=true` and `Idempotency-Key`.
4. **Contract-Registry Ready**: Every endpoint specification in these docs is written as a single declarative schema (`requestSchema`, `responseSchema`, `scopes`, `mcpTool`) ready for the R1 contract registry.
5. **Human Sovereignty**: Agents propose, lease, and execute; humans retain override authority, kill-switches, and budget caps at every layer.

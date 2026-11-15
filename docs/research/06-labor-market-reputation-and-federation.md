# 06 — Autonomous Labor Market: Capability Security, Reputation, Bidding & A2A Federation

**Theme**: Evolving from static permissions and top-down assignment to lease-bound capabilities, empirical reputation, market allocation, and cross-vendor agent interoperability
**Depends on**: Sprint 006 (Tokens/Audit), Sprint 015/031 (Permissions/Schemes), Proposals 01–05
**Related Sprint**: Long-horizon extension beyond [Sprint 047 (Agent Experience Polish)](../sprints/047-agent-experience-polish.md)

---

## 1. Problem Statement & Research Foundation

As an engineering organization scales from 1–2 Homogeneous Copilots to **dozens of specialized virtual workers** (e.g., fast/cheap Haiku triage bots, deep-reasoning o3/Opus architecture planners, frontend Playwright specialists, security audit agents, plus external partner agents), three governance problems emerge:

1. **Over-Privileged Standing Tokens**: Today, an `ApiToken` granted `write` scope on project `TF` can mutate *any* issue in `TF` at *any* time. If an agent suffers a prompt injection while reading an untrusted bug report on `TF-104`, its token allows it to vandalize `TF-1` through `TF-103`.
2. **Blind Static Routing**: Assigning tasks round-robin or manually ignores empirical reality: Agent A may have a 92% first-pass test rate on `JQL` backend issues at $0.40/issue, while failing 70% of the time on React drag-and-drop UI tasks.
3. **Siloed Agent Ecosystems**: Coding agents built on different stacks (Devin, Claude Code, Codex, LangGraph, CrewAI) need a standard protocol to discover TrackForge's capabilities and accept delegated tasks without bespoke glue code.

### Theoretical Grounding
1. **Object-Capability Security (Dennis & Van Horn 1966; Miller, *Robust Composition*, 2006)**: Access rights should not live in ambient authority (`who you are` / broad standing ACLs), but in **unforgeable, task-bound capability tokens** that grant only the minimum authority needed to complete the currently leased task (**Principle of Least Authority — POLA**).
2. **The Contract Net Protocol (Reid G. Smith, IEEE TC 1980)**: The foundational distributed AI protocol for heterogeneous task allocation: a manager broadcasts a **Task Announcement** (`requirements`, `maxBudget`, `deadline`), eligible idle contractors submit **Bids** (`capabilityFit`, `estimatedTokens`, `confidence`, `eta`), and an explicit scoring policy **Awards** the lease.
3. **Google / Linux Foundation Agent2Agent (A2A) Protocol (2025)**: The open industry standard complementing MCP. While **MCP** connects an agent to *tools* (`agent → tool`), **A2A** connects *agents to agents* (`orchestrator ⇄ specialist agent`) via `/.well-known/agent-card.json` discovery, asynchronous `tasks/send`, streaming artifact updates, and opaque execution.

---

## 2. Step-by-Step Specification

### Step 1: Just-in-Time (JIT) Lease-Bound Capability Security

Instead of giving worker agents broad standing `write` permissions across an entire project, TrackForge introduces scope `lease_bound_write` on `ApiToken`:

```text
[Standing Agent PAT: scope = "read, lease_bound_write"]
        │
        ├── Can read project issues & call `pull_next_issue` / `claim_issue`
        ├── CANNOT mutate arbitrary unleased issues (403 LEASE_REQUIRED)
        │
        ▼ (Claims Lease on TF-104)
[Ephemeral Lease Capability Active for TF-104]
        ├── CAN update fields, blackboard, traces, and comments on TF-104
        ├── CAN create child subtasks under TF-104 or link issues to TF-104
        └── The instant Lease expires or releases → write authority on TF-104 evaporates
```

#### Why This Is a Security Breakthrough for Agent Fleets
Even if an agent processes malicious prompt-injected text inside `TF-104`, **its blast radius is mathematically confined to `TF-104`** (and every mutation on `TF-104` is versioned and undoable via `ChangeHistory`). It cannot touch other issues, alter workflows, or exfiltrate unrelated project settings.

---

### Step 2: Agent Capability Cards & Empirical Reputation Ledger

Every agent `User` (`isAssignableAgent: true` from Sprint 047) gains a structured `AgentProfile` combining **declared capabilities** with **empirically measured outcomes** computed automatically from TrackForge's own audit/changelog tables:

#### Declared vs. Measured Profile
```typescript
export interface AgentProfile {
  userId: string;
  modelFamily: string;           // e.g. "claude-4-opus", "gpt-5-codex", "gemini-4"
  declaredSkills: string[];      // e.g. ["typescript", "prisma", "react", "playwright"]
  preferredComponents: string[]; // Component IDs
  costPerMillionTokensUsd: number;
  maxConcurrentLeases: number;

  // Empirically computed by TrackForge (cannot be self-reported by the agent!)
  reputation: {
    completedIssuesCount: number;
    firstPassSuccessRate: number;    // Completed with 0 circuit-breaker trips & 0 review rejections
    reviewApprovalRate: number;      // Approved on 1st review / total reviews
    revertOrReopenRate: number;      // Fraction of Done issues reopened within 7 days
    avgTokensPerStoryPoint: number;
    avgCycleTimeSeconds: number;
    byComponent: Record<string, {    // Per-component specialization score (Wilson lower bound)
      completed: number;
      reliabilityScore: number;      // 0.0 – 1.0
    }>;
  };
}
```

#### Dynamic Graduated Autonomy (Automating Sprint 047's `approvalPolicy`)
Sprint 047 introduces `approvalPolicy: 'always' | 'destructiveOnly' | 'never'`. With the Reputation Ledger, this slider becomes **self-adjusting within admin-defined guardrails**:
- A newly registered agent starts at `approvalPolicy: 'always'` (every mutation parks as a Sprint 012 `Proposal`).
- Once `completedIssuesCount >= 10` and `reliabilityScore >= 0.85` in Component `X`, the agent automatically graduates to `destructiveOnly` inside Component `X`.
- If a model upgrade causes a regression (e.g., two consecutive circuit-breaker trips or a reopened bug), a Tier 0 reflex **immediately demotes** the agent back to `always` and alerts the admin.

---

### Step 3: Contract Net Task Allocation (Smart Routing & Optional Bidding)

TrackForge supports two allocation modes depending on fleet size:

#### Mode A: Zero-Latency Reputation Routing (Default for 1–20 Agents)
`GET /api/internal/issues/{key}/suggested-agents` (and `pull_next_issue`) scores candidate agents using a deterministic utility function over the Reputation Ledger:
$$\text{Score}(a, i) = w_1 \cdot \text{Reliability}(a, i.\text{component}) + w_2 \cdot \text{CapacityAvailable}(a) - w_3 \cdot \text{NormalizedCost}(a)$$
- High-risk / high-story-point issues automatically route to high-reliability deliberative agents; low-complexity chores route to fast, low-cost workers.

#### Mode B: Contract Net Bid Book (For Heterogeneous / Multi-Vendor Fleets)
For complex or cross-team issues where central static estimation is poor:
1. **Announce**: Issue transitions to `Open for Bids` (`biddingWindowSeconds: 120`, `maxBudgetTokens: 200000`).
2. **Bid**: Subscribed agents inspect `GET /issue/{key}/context-pack` (dry-run) and submit a structured `TaskBid`:
   - `estimatedTokens`, `estimatedDurationSec`, `confidence` ($0..1$), `proposedApproachSummary`, `targetFiles[]`.
3. **Award**: When the window closes (or all subscribed specialists have bid), TrackForge's scoring policy awards the fenced `IssueLease` (Doc 01) to the winning bid and initializes the Blackboard with the winner's `targetFiles`.

---

### Step 4: Google A2A Protocol Peer Interoperability

While `apps/mcp` lets an agent call TrackForge as a *tool*, adding an **A2A Protocol adapter** lets external orchestrators treat TrackForge (or specific project queues inside TrackForge) as an **A2A-compliant Agent Peer**:

1. **Discovery (`GET /.well-known/agent-card.json`)**:
   Exposes TrackForge's capabilities, supported modalities, authentication schemes, and project skills in standard A2A Agent Card format.
2. **Inbound Delegation (`POST /a2a/tasks/send` & `tasks/sendSubscribe`)**:
   An external agent sends an A2A task request → TrackForge creates a tracked `Issue` (with `Idempotency-Key` mapped from A2A `task.id`), routes it to an internal worker lease, and streams `TaskStatusUpdateEvent` and `TaskArtifactUpdateEvent` back over SSE using Sprint 011's `DomainEvent` stream.
3. **Outbound Delegation (Webhook → A2A Client)**:
   When a user delegates `TF-104` (`Issue.delegateId` in Sprint 047) to an external A2A agent whose profile includes an `a2aEndpointUrl`, TrackForge dispatches `tasks/send` with the `context-pack` payload and maps the remote agent's streaming status updates directly into `AgentSession.activities`.

---

## 3. Data Model (Prisma Schema Additions)

```prisma
model AgentProfile {
  userId                  String   @id
  user                    User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  modelFamily             String
  a2aEndpointUrl          String?  // For outbound A2A delegation
  declaredSkills          Json     @default("[]") // string[]
  costPerMillionTokensUsd Float    @default(0)
  maxConcurrentLeases     Int      @default(1)
  completedCount          Int      @default(0)
  firstPassSuccessCount   Int      @default(0)
  reviewApprovedCount     Int      @default(0)
  reviewTotalCount        Int      @default(0)
  reopenedCount           Int      @default(0)
  componentStats          Json     @default("{}") // Record<componentId, {completed, success, reliabilityScore}>
  updatedAt               DateTime @updatedAt
}

model TaskBid {
  id                      String   @id @default(cuid())
  issueId                 String
  issue                   Issue    @relation(fields: [issueId], references: [id], onDelete: Cascade)
  agentId                 String
  agent                   User     @relation(fields: [agentId], references: [id])
  estimatedTokens         Int
  estimatedDurationSec    Int
  confidence              Float
  proposedApproachSummary String
  targetFiles             Json     @default("[]")
  status                  String   @default("SUBMITTED") // SUBMITTED | AWARDED | REJECTED | EXPIRED
  createdAt               DateTime @default(now())

  @@unique([issueId, agentId])
  @@index([issueId, status])
}
```

---

## 4. Scaling, Difficulties, Impact & Risks

### Scaling Analysis (PostgreSQL Single-Node)
- **JIT Lease-Bound Capabilities**: Adds **zero extra DB queries**—the auth middleware (`apps/backend/src/middleware/auth.ts`) already loads the issue for scope checking; verifying `issue.activeLease?.holderId === req.actor.userId` is an in-memory field check on the loaded row.
- **Reputation Rollups**: Updated asynchronously on `jira:issue_updated` (when transitioning to `Done` or `Reopened`) via the 011 outbox consumer. Reads during routing are $O(1)$ lookups on `AgentProfile` ( typically <100 agent rows per instance).

### Implementation Difficulties
1. **Goodhart's Law on Agent Reputation**: If reputation rewards raw completion count or speed, agents may cherry-pick trivial 1-point issues or split 1 bug into 5 tiny tickets.
   - *Solution*: Weight reputation using **Wilson score confidence intervals** stratified by `componentId` and `storyPoints`, heavily penalize `reopenedCount` ($5\times$ weight), and gate decomposition via Doc 05's validation rules.
2. **Bidding Latency Overhead**: Waiting 60 seconds for an auction on a trivial bug wastes time.
   - *Solution*: Keep **Mode A (instant Reputation Routing + `pull_next_issue`)** as the default for 95% of issues; reserve **Mode B (Contract Net bidding)** for issues explicitly flagged `allocationMode = 'bid'` or `storyPoints >= 8`.

### Risks & Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| **Dishonest Bids in Contract Net** (An external agent always bids `confidence: 0.99` and low tokens to win every auction) | Medium | Multiply bid score by the agent's historical **calibration factor** ($1 - |\text{predictedSuccess} - \text{actualSuccess}|$) from `AgentProfile`. Chronic over-bidders are automatically discounted. |
| **External A2A Endpoint SSRF / Hung Connections** | High | Reuse Sprint 011's webhook SSRF guard, HMAC signing, and strict request timeouts on all outbound A2A calls. |

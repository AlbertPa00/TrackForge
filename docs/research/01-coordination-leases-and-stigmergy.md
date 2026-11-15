# 01 — Coordination Primitives: Fenced Leases, Optimistic Concurrency & Stigmergic Traces

**Theme**: Preventing agent collisions, split-brain execution, and silent overwrites
**Depends on**: Sprint 006 (Identity/Tokens), Sprint 011 (`DomainEvent` outbox), Sprint 016 (Durable Job Runner)
**Related Sprint**: Candidate pull-forward for [Sprint 047 (Agent Experience Polish)](../sprints/047-agent-experience-polish.md)

---

## 1. Problem Statement & Research Foundation

In human software teams, social protocols prevent two developers from silently picking up the same ticket or rewriting the same file simultaneously: humans talk in standups, notice branch names, and work at human timescales (hours/days).

In a fleet of coding agents operating at machine timescales (seconds/minutes), traditional Jira assignment fails in three ways:

1. **The Check-Then-Act Race on Issue Claiming**: Two idle worker agents query `assignee is EMPTY AND status = "To Do"`, both receive `TF-104`, both call `PUT /issue/TF-104/assignee`, and both spin up isolated git worktrees to solve the task. Thousands of tokens and CI minutes are wasted before the collision surfaces.
2. **The Zombie Worker Problem (Split-Brain)**: Agent A claims `TF-104`, hangs on a network call or crashes mid-run. If the system auto-reassigns `TF-104` to Agent B after a timeout, and Agent A wakes up from its pause, Agent A will overwrite Agent B's status transitions, comments, and blackboard state.
3. **Cross-Issue Hidden Coupling**: Agent A works on `TF-104` ("Add rate limit header") and Agent B works on `TF-105` ("Refactor auth middleware"). These are *different* issues, so per-issue locks do not block them—yet both modify `apps/backend/src/middleware/auth.ts`.

### Theoretical Grounding
- **Fencing Tokens in Distributed Locks (Kleppmann, *Designing Data-Intensive Applications*, 2016)**: Time-based leases alone cannot prevent a paused client from corrupting state after lease expiry. Every lease acquisition must issue a monotonically increasing integer **fencing token** (`fenceToken`), and the storage layer must reject any write carrying a `fenceToken < issue.lastFenceToken`.
- **Stigmergic Coordination (Grassé 1959; Crowston et al. 2015; *State-Centric Stigmergic Traces for LLM MAS*, 2025)**: Social insects coordinate complex structures without direct messaging by depositing volatile traces (pheromones) in the shared environment that decay over time. In software engineering, agents leaving **ephemeral, lease-bound intent traces** (`touching-file`, `touching-symbol`, `running-test`) on the issue graph allow peers to sense overlapping territory *before* editing files.

---

## 2. Step-by-Step Specification

### Step 1: Optimistic Concurrency Control (`version` + `If-Match`)

Every `Issue` row gains an integer `version` column incremented atomically on every mutation.

- **Read path**: `GET /rest/api/2/issue/{key}` returns header `ETag: "v{issue.version}"` and includes `version: number` in the envelope.
- **Write path**: `PUT /rest/api/2/issue/{key}`, `POST /transitions`, and blackboard patches accept `If-Match: "v{expectedVersion}"` (or `expected_version` in MCP tool arguments).
- **Enforcement**:
  ```sql
  UPDATE "Issue"
  SET ..., "version" = "version" + 1, "updatedAt" = NOW()
  WHERE "id" = $1 AND "version" = $2;
  ```
  If `rowsAffected === 0`, return **HTTP 409 Conflict** with Jira-shaped error + the current server state diff so the agent can reconcile without an extra round-trip:
  ```json
  {
    "errorMessages": ["Issue TF-104 was modified by another actor (expected version 4, current version 5)."],
    "errors": { "version": "Stale version; inspect currentFields and retry." },
    "currentVersion": 5,
    "conflictingChanges": [
      { "field": "priority", "from": "Medium", "to": "High", "by": "agent-triage", "at": "2026-11-07T14:02:11Z" }
    ]
  }
  ```

---

### Step 2: Fenced Issue Leases (`IssueLease`)

Unlike `assignee` (who is *accountable*) or 047's `delegate` (which agent persona is *designated*), an `IssueLease` represents **who holds the active execution lock right now**.

#### Lifecycle State Machine
```text
[Unleased] ──(claim / pull_next)──► [ACTIVE (fenceToken = N, expiresAt = NOW + ttl)]
                                         │                      │
                                  (heartbeat)            (TTL elapsed / reaper job)
                                         ▼                      ▼
                                    [ACTIVE]               [EXPIRED] ──► (re-pooled, event emitted)
                                         │
                                  (release / transition to Done)
                                         ▼
                                    [RELEASED]
```

#### Atomic Claim & Queue-Pull Semantics
Agents can either claim a specific issue (`POST /api/internal/issues/{key}/lease`) or atomically pull the highest-priority claimable issue matching a JQL filter (`POST /api/internal/leases/pull`) using PostgreSQL's `FOR UPDATE SKIP LOCKED`:

```sql
-- Atomic fence increment + lease acquisition inside prisma.$transaction
UPDATE "Issue"
SET "lastFenceToken" = "lastFenceToken" + 1
WHERE "id" = $issueId
RETURNING "lastFenceToken";
```

#### Fencing Enforcement Rule
When an `ACTIVE` lease exists on an issue:
1. Mutations from the **leaseholder** must pass `X-TrackForge-Fence-Token: <N>` (or MCP `fence_token`). If `N < issue.lastFenceToken`, the server rejects the write with **HTTP 409 Conflict (`FENCE_TOKEN_EXPIRED`)** — the zombie agent immediately learns it lost the lease and aborts its local worktree.
2. Mutations from **other agents** on guarded fields (status, blackboard, assignee) without `overrideLease: true` (admin/human privilege) are rejected with **HTTP 423 Locked**, returning the active holder, lease expiry, and current activity.
3. **Humans** in the UI see a live badge (`Locked by @codex-worker · expires in 4m 12s`) with a one-click **"Break Lease & Take Over"** button that increments `lastFenceToken` and revokes the agent's lease.

---

### Step 3: Stigmergic Intent Traces (`StigmergicTrace`)

While holding a lease, an agent declares the **code artifacts and resources** it is actively reading or modifying.

#### Trace Kinds
- `file_read`: Agent is inspecting a file as critical context (e.g., `apps/backend/src/services/issueService.ts`).
- `file_edit`: Agent intends to modify or has modified a file in its worktree.
- `symbol_edit`: Agent is changing the signature/behavior of an exported symbol (e.g., `issueService.planCreate`).
- `resource_lock`: Agent is using a shared external resource (e.g., `staging-db-migration`).

#### Collision Detection on Deposit
When Agent B on `TF-105` posts a trace `{ kind: "file_edit", target: "apps/backend/src/middleware/auth.ts" }`:
1. TrackForge queries all active (non-expired) `StigmergicTrace` rows across the project where `target = 'apps/backend/src/middleware/auth.ts'` and `issueId != TF-105`.
2. If Agent A on `TF-104` holds a conflicting `file_edit` or `symbol_edit` trace, the response returns `collisions: [{ issueKey: "TF-104", holder: "claude-worker-1", kind: "file_edit", target: "...", expiresAt: "..." }]` and emits a `stigmergy.collision_detected` domain event.
3. Depending on project policy (`collisionPolicy: 'warn' | 'block'`), Agent B either receives an immediate warning to coordinate/sequence after `TF-104` or is blocked from claiming that file path until `TF-104`'s lease finishes.

---

## 3. Data Model (Prisma Schema Additions)

```prisma
model Issue {
  // ... existing fields ...
  version         Int               @default(1)
  lastFenceToken  Int               @default(0)
  activeLease     IssueLease?
  traces          StigmergicTrace[]
}

model IssueLease {
  id            String    @id @default(cuid())
  issueId       String    @unique
  issue         Issue     @relation(fields: [issueId], references: [id], onDelete: Cascade)
  holderId      String
  holder        User      @relation(fields: [holderId], references: [id])
  fenceToken    Int       // Monotonically increasing per issue (or global sequence)
  worktreeRef   String?   // e.g., git branch "agent/tf-104-rate-limit" or Orca worktree ID
  status        String    @default("ACTIVE") // ACTIVE | RELEASED | EXPIRED | BROKEN
  ttlSeconds    Int       @default(600)      // Default 10 minutes
  acquiredAt    DateTime  @default(now())
  heartbeatAt   DateTime  @default(now())
  expiresAt     DateTime
  releasedAt    DateTime?
  releaseReason String?

  traces        StigmergicTrace[]

  @@index([expiresAt, status])
  @@index([holderId, status])
}

model StigmergicTrace {
  id          String     @id @default(cuid())
  projectId   String
  issueId     String
  issue       Issue      @relation(fields: [issueId], references: [id], onDelete: Cascade)
  leaseId     String
  lease       IssueLease @relation(fields: [leaseId], references: [id], onDelete: Cascade)
  actorId     String
  kind        String     // file_read | file_edit | symbol_edit | resource_lock
  target      String     // Normalized repo-relative path or symbol URI, e.g. "apps/backend/src/middleware/auth.ts"
  summary     String?    // Brief intent, e.g. "Adding X-Fence-Token check"
  createdAt   DateTime   @default(now())
  expiresAt   DateTime   // Tied to lease.expiresAt

  @@unique([leaseId, kind, target])
  @@index([projectId, target, expiresAt])
}
```

---

## 4. API & MCP Contract Surface

| Method | Path | MCP Tool | Description |
|---|---|---|---|
| `POST` | `/api/internal/issues/{key}/lease` | `claim_issue` | Acquires a fenced lease on `{key}` (`ttlSeconds`, `worktreeRef`, `dryRun`). Returns `{ leaseId, fenceToken, expiresAt, issueVersion }`. |
| `POST` | `/api/internal/leases/pull` | `pull_next_issue` | Given a JQL query (e.g. `project = TF AND status = "To Do" ORDER BY priority DESC`), atomically claims the first unlocked issue via `SKIP LOCKED`. |
| `POST` | `/api/internal/issues/{key}/lease/heartbeat` | `heartbeat_lease` | Extends `expiresAt = NOW() + ttlSeconds`; returns any new comments, human interrupts, or `stale_context` warnings since last heartbeat. |
| `DELETE` | `/api/internal/issues/{key}/lease` | `release_lease` | Releases the lease (requires handoff envelope or reflection if not `Done`) and deletes associated ephemeral traces. |
| `POST` | `/api/internal/issues/{key}/traces` | `deposit_traces` | Upserts `StigmergicTrace[]` for the active lease and returns any detected cross-issue `collisions[]`. |
| `GET` | `/api/internal/projects/{key}/traces` | `inspect_active_traces` | Returns the live heatmap of all files/symbols currently being touched across the project and by which issues/agents. |

### Heartbeat Piggybacking (Zero-Polling Interrupt Delivery)
A subtle design win: `POST /lease/heartbeat` does not just return `{ ok: true }`. It returns a compact delta since the previous heartbeat:
```json
{
  "leaseId": "clx...",
  "fenceToken": 12,
  "expiresAt": "2026-11-07T15:20:00Z",
  "signals": {
    "issueVersionChanged": false,
    "newCommentsCount": 1,
    "pendingHumanDirective": "Stop editing auth.ts; use the existing projectAllowed helper.",
    "fileCollisions": []
  }
}
```
This turns the periodic heartbeat into a **low-cost control channel** so mid-flight agents can be steered or halted by humans without needing an open WebSocket/SSE listener inside every CLI tool.

---

## 5. Scaling, Difficulties, Impact & Risks

### Scaling Analysis (PostgreSQL Single-Node)
- **Throughput**: Even with 200 concurrent agents sending a heartbeat every 60 seconds, that is **3.3 writes/sec** on a single-row indexed primary key (`IssueLease.id`). PostgreSQL handles >10,000 such updates/sec on modest hardware.
- **Queue Contention**: `pull_next_issue` uses `SELECT id FROM "Issue" WHERE ... FOR UPDATE SKIP LOCKED LIMIT 1`. In PostgreSQL, `SKIP LOCKED` scales linearly under high concurrency because competing workers skip locked candidate rows in microseconds rather than queuing behind row locks.
- **Storage Growth**: `StigmergicTrace` rows are ephemeral (cascade-deleted when the lease releases or expires). Table size is proportional only to *currently active* work, never historical volume.

### Implementation Difficulties
1. **JQL Compiler Integration for `pull_next_issue`**: The JQL compiler (`apps/backend/src/jql/`) currently compiles to a Prisma `where` object. To use `FOR UPDATE SKIP LOCKED`, `pull_next_issue` can run the standard Prisma JQL query to fetch the top 10 candidate IDs, then run a tiny raw SQL `SELECT id FROM "Issue" WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM "IssueLease" ...) FOR UPDATE SKIP LOCKED LIMIT 1` inside the transaction. This avoids rewriting the JQL compiler in raw SQL.
2. **Path Normalization on Traces**: Windows vs POSIX slashes (`\` vs `/`) and leading `./` will defeat exact-match collision queries unless normalized on ingest (`path.posix.normalize`).

### Risks & Mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| **Agent hoards leases** (claims 50 issues at once) | High | Enforce `maxConcurrentLeases` per agent token/user (default: `1` for coding workers, `5` for triage routers). |
| **Short TTL kills legitimate long test runs** | Medium | Allow `ttlSeconds` up to `1800` (30m) and provide an MCP wrapper / background heartbeat helper; on lease expiry, transition lease to `EXPIRED` but preserve `worktreeRef` on the handoff record so work isn't lost. |
| **Fencing breaks naive REST scripts** | Low | Only enforce `X-TrackForge-Fence-Token` when an `ACTIVE` lease exists on the issue. Unleased issues behave identically to standard Jira v2. |

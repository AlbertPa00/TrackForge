# Architecture — five-minute orientation

The system in four diagrams: who talks to it, what a request passes through,
how an agent works an issue, and what runs in production. For structural debt
and the refactor plan see `architecture-review-agentic.md`; for module-by-module
orientation see the repo's root `AGENTS.md`.

## 1. System context

```mermaid
flowchart LR
    subgraph Clients
        H[Human users<br/>React SPA]
        A[AI agents<br/>MCP stdio/HTTP]
        R[REST clients<br/>Jira-aware tooling]
        IMP[Jira importer<br/>Cloud / Server-DC]
    end

    subgraph TrackForge["TrackForge (single origin)"]
        FE[Frontend<br/>React 18 · Vite]
        BE[Backend<br/>Express · Prisma]
        JQL[JQL engine<br/>lexer→parser→compiler]
        MCP[MCP server<br/>tools → REST]
        FE -->|same REST API| BE
        MCP -->|tools call REST| BE
        JQL -.->|search, filters| BE
    end

    subgraph Infra
        PG[(PostgreSQL 16<br/>issues, JQL, audit)]
        RD[(Redis 7<br/>BullMQ jobs, SSE fan-out)]
        ST[(S3 / fs<br/>attachments)]
    end

    H --> FE
    A --> MCP
    R --> BE
    IMP --> BE
    BE --> PG
    BE --> RD
    BE --> ST
```

Agents use the **same REST surface** as the UI — no privileged back door.
Their token scopes, project allow-lists, and approval policy apply identically.

## 2. Request pipeline (every mutation)

```mermaid
flowchart LR
    REQ[Request] --> AUTH{auth<br/>session or PAT}
    AUTH -->|401| X[reject]
    AUTH --> SCOPE{scopes +<br/>project allow-list}
    SCOPE -->|403/404| X
    SCOPE --> IDEM{Idempotency-Key<br/>seen?}
    IDEM -->|same body| REPLAY[replay stored<br/>response]
    IDEM -->|diff body| E422[422]
    IDEM -->|new| ZOD{zod schema}
    ZOD -->|400 Jira-shaped| X
    ZOD --> GATE{approvalPolicy}
    GATE -->|always /<br/>destructiveOnly| PROP[202 proposal<br/>parked, not applied]
    GATE -->|never / dryRun ok| SVC[service fn<br/>Prisma tx]
    SVC --> OUT[changelog + audit<br/>+ domain events<br/>+ webhooks/outbox]
```

Two invariants worth remembering: **`PUT fields.status` is rejected** (status
moves via transitions only) and **destructive deletes are two-step**
(`dryRun` → `confirmToken` → delete).

## 3. Agent work loop

```mermaid
sequenceDiagram
    participant H as Human (assignee stays accountable)
    participant API as REST / MCP
    participant S as AgentSessionService
    participant AG as Agent
    H->>API: delegate = agent (or POST /agent/claim)
    API->>S: session opens (trigger: delegate|claim)
    S-->>AG: session + project guidance
    loop work
        AG->>API: emit_activity (thought|action|error)
        AG->>API: writes (dryRun / proposals apply per policy)
        opt needs a decision
            AG->>API: ask_user(question)
            S-->>H: notification
            H->>API: answer
            S-->>AG: resume (agent_question.answered)
        end
    end
    AG->>API: status = done (or failed)
    Note over S: stale sweep: no heartbeat → blocked;<br/>expired question → failed
```

`delegate` ≠ `assignee`: the human keeps accountability, the agent gets a
session. `POST /api/internal/agent/claim` does the pick-up atomically
(`FOR UPDATE SKIP LOCKED`) so fleets don't double-claim.

## 4. Production topology (`docker-compose.prod.yml`)

```mermaid
flowchart TB
    subgraph Host["one host — single exposed port"]
        direction LR
        APP[app<br/>backend + bundled SPA<br/>:3000 public]
        MIG[migrate<br/>prisma migrate deploy<br/>runs once, exits]
        DB[(postgres<br/>no host port)]
        RD[(redis<br/>no host port)]
        S3C[(rustfs<br/>S3-compat, no host port)]
    end
    NET[operator's TLS / reverse proxy] --> APP
    MIG --> DB
    APP --> DB
    APP --> RD
    APP --> S3C
```

- `migrate` runs first; `app` waits for it (`service_completed_successfully`).
- Infra ports never publish — the only public port is the app's
  (install-smoke workflow asserts this).
- Attachments default to the `fs` volume; `ATTACHMENT_STORAGE=s3` switches to
  the bundled RustFS or any external S3.

## Module map

| Path | Holds |
|---|---|
| `apps/backend/src/routes/` | HTTP surface — parse + validate + delegate to services |
| `apps/backend/src/services/` | All domain logic + Prisma access |
| `apps/backend/src/middleware/` | auth/scopes/idempotency, proposal gate, rate limit |
| `apps/backend/src/jql/` | Self-contained engine: lexer → parser → AST → Prisma compiler |
| `apps/backend/src/import/` | Jira Cloud / Server-DC importers |
| `apps/mcp/` | MCP server (stdio + Streamable HTTP) — tools map to REST calls |
| `apps/frontend/` | React SPA — thin client over the same REST API |
| `scripts/` | Release-gate checks (audit, env parity, hygiene, docs claims, migration compat, restore drill) |
| `tests/smoke/` | Post-deploy smoke suite shared by deploy.yml and operators |

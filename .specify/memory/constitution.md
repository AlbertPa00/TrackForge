<!--
Sync Impact Report:
- Version change: 1.0.0 → 1.1.0
- Added principles: VI. AI-Native Operability
- Added sections: None
- Removed sections: None
- Templates requiring updates: plan-template.md (Constitution Check now covers principle VI)
- Follow-up TODOs: None
- Source: Sprint 005 (Hardening & AI-Native Charter), docs/roadmap.md §3 principles A1–A8
-->

# TrackForge Constitution

## Core Principles

### I. Sprint-First Delivery
Deliver working software in short, fully integrated increments. Each sprint must produce a runnable, testable slice of the Jira-compatible platform. Scope is bounded by what can be designed, implemented, tested, and verified in one cycle. No "foundational-only" sprints that leave the system unshippable.

Rationale: TrackForge is a large platform. The only way to avoid a big-bang rewrite is to ship a small working product every sprint, then expand it.

### II. API-First Design
Every domain feature is exposed through a REST API before a UI is built. The UI consumes the same API as external clients. Internal-only endpoints require explicit justification. API contracts are documented, typed, and tested.

Rationale: Jira compatibility depends on a stable API layer. Building API first surfaces data-model mistakes early and keeps the frontend thin.

### III. Test-First Quality
Automated tests are written before or alongside implementation. Unit tests cover domain logic; integration tests cover API contracts; end-to-end tests cover primary user journeys. Code without tests is not considered done. Coverage is a guide, not a target.

Rationale: A workflow engine and permission system are complex and regression-prone. Tests are the only practical way to refactor safely as the platform grows.

### IV. Jira Compatibility
Where TrackForge replicates a Jira concept, it uses Jira-compatible naming, data shapes, and REST API conventions. Where it intentionally diverges, the divergence is documented. Migration compatibility is not negotiable for P0 features.

Rationale: The primary purpose of the platform is to replace internal Jira instances with minimal migration friction. Names and endpoints must feel familiar to integrations and administrators.

### V. Explicit Simplicity
Avoid premature abstraction. Start with the minimal design that satisfies the sprint's requirements. Refactor only when the current design creates measurable pain. Every new dependency must be justified in the plan.

Rationale: The design document is a north star, not a blueprint. Shipping the full stack from day one is impossible; the system must grow through simple, well-tested additions.

### VI. AI-Native Operability
Every capability must be operable by an AI agent with the same fidelity as by a human. Features are exposed through the public API and the MCP tool layer; writes are attributable to a human or agent actor, safe to retry, previewable, and reversible through history; agents discover valid inputs from metadata rather than guessing. A feature that only works through the UI is not done.

Rationale: TrackForge's differentiator over a plain Jira-compatible tracker is that agents can plan, triage and execute work inside it safely. That property cannot be retrofitted; it must be designed into every slice.

## Technology Stack

The stack is chosen from the DESIGN.md and is fixed unless amended by the constitution:

- Language: TypeScript 5.x (full-stack)
- Package manager: pnpm
- Monorepo: Turborepo
- Backend: Node.js + Express + Prisma ORM
- Database: PostgreSQL (production) / SQLite (local development, when explicitly configured)
- Search: OpenSearch 2.x (future; not required in early sprints)
- Cache/Queue: Redis + BullMQ (future; not required in early sprints)
- Frontend: React 18 + Vite + Tailwind CSS + TanStack Query
- State: Zustand (global), React state (local)
- Testing: Vitest (unit/integration), Playwright (e2e), Supertest (API)
- Linting: ESLint + Prettier
- Containerization: Docker + Docker Compose

For early sprints, infrastructure dependencies (PostgreSQL, Redis, OpenSearch) are optional via Docker Compose; in-memory or file-based equivalents are acceptable for local development and CI when the real service is not required by the feature under test.

## Development Workflow

1. Constitution guides all decisions.
2. Each sprint follows the spec-kit cycle: constitution → specification → plan → tasks → implement → verify.
3. Specifications are written in plain language and reviewed for testability before planning begins.
4. Implementation tasks are small enough to complete in a single focused session.
5. Code is committed with descriptive messages referencing the active feature directory (e.g., `specs/001-core-foundation`).
6. Before a sprint is marked done, automated tests pass and the increment is demonstrable.

## Quality Gates

- All new domain logic has unit tests.
- All new API endpoints have integration tests for happy path and primary error paths.
- No TypeScript errors or ESLint errors at commit time.
- Migrations must be reversible and seeded with sensible defaults.
- UI changes must be manually smoke-tested in the browser before the sprint ends.

## Governance

This constitution supersedes ad-hoc decisions. Amendments require:
1. A clear proposal recorded in the constitution file or a linked amendment document.
2. Impact analysis on active specifications and in-flight work.
3. Updated version and last-amended date.
4. Compliance review for all changes: verify that the change does not violate an existing principle, or explicitly update the principle.

All plans, specs, and tasks must reference the constitution. Any exception is temporary and documented in the relevant spec's Assumptions section.

**Version**: 1.1.0 | **Ratified**: 2026-06-20 | **Last Amended**: 2026-11-07

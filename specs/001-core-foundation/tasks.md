# Tasks: Core Foundation

**Input**: Design documents from `/specs/001-core-foundation/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

## Phase 1: Monorepo Setup (Shared Infrastructure)

**Purpose**: Initialize project structure and tooling.

- [x] T001 [P] Create root monorepo files: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `.nvmrc`
- [x] T002 [P] Create `apps/backend/package.json` with Express, Prisma, Zod, Vitest, Supertest
- [x] T003 [P] Create `apps/frontend/package.json` with React, Vite, Tailwind, TanStack Query, React Router
- [x] T004 [P] Add shared root scripts: `test`, `dev`, `lint`, `format`
- [x] T005 [P] Configure ESLint and Prettier at root level

## Phase 2: Foundational Backend

**Purpose**: Database, models, and base API infrastructure.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T006 Define Prisma schema in `prisma/schema.prisma` per data-model.md
- [x] T007 [P] Create `apps/backend/src/prisma.ts` Prisma client singleton
- [x] T008 [P] Create seed script `apps/backend/src/seed.ts` for issue types, statuses, priorities
- [x] T009 Add backend scripts: `db:generate`, `db:migrate`, `db:seed`, `dev`, `test`
- [x] T010 Setup Express app in `apps/backend/src/main.ts` with JSON body parsing and basic error middleware
- [x] T011 Create shared error format helper in `apps/backend/src/lib/errors.ts`
- [x] T012 Create Jira-style validation helper in `apps/backend/src/lib/validation.ts`

**Checkpoint**: Backend can start, connect to SQLite, and run migrations/seed.

## Phase 3: User Story 1 — Create and View Projects (P1)

**Goal**: Users can create projects and retrieve them via API.

**Independent Test**: `GET /rest/api/2/project` returns a project after `POST /rest/api/2/project` succeeds.

### Tests for User Story 1

- [x] T013 [P] Integration test: create project in `apps/backend/tests/integration/projects.test.ts`
- [x] T014 [P] Integration test: list and get project in `apps/backend/tests/integration/projects.test.ts`

### Implementation for User Story 1

- [x] T015 [US1] Implement project service in `apps/backend/src/services/projectService.ts`
- [x] T016 [US1] Implement project routes in `apps/backend/src/routes/projects.ts`
- [x] T017 [US1] Wire project routes into `apps/backend/src/main.ts`

**Checkpoint**: Project endpoints pass integration tests.

## Phase 4: User Story 2 — Create and View Issues (P1)

**Goal**: Users can create issues within projects and retrieve them.

**Independent Test**: `GET /rest/api/2/issue/PROJ-1` returns an issue after creation.

### Tests for User Story 2

- [x] T018 [P] Integration test: create issue in `apps/backend/tests/integration/issues.test.ts`
- [x] T019 [P] Integration test: get issue and list issues by project in `apps/backend/tests/integration/issues.test.ts`
- [x] T020 [P] Unit test: issue key generation in `apps/backend/tests/unit/issueKey.test.ts`

### Implementation for User Story 2

- [x] T021 [US2] Implement issue service in `apps/backend/src/services/issueService.ts`
- [x] T022 [US2] Implement issue routes in `apps/backend/src/routes/issues.ts`
- [x] T023 [US2] Implement simplified `GET /rest/api/2/search` JQL handler in `apps/backend/src/routes/search.ts`
- [x] T024 [US2] Wire issue routes into `apps/backend/src/main.ts`

**Checkpoint**: Issue endpoints pass integration tests.

## Phase 5: User Story 3 — Update Issue Status (P2)

**Goal**: Users can transition an issue through a simple workflow.

**Independent Test**: `PUT /rest/api/2/issue/PROJ-1` changes status to "In Progress".

### Tests for User Story 3

- [x] T025 [P] Integration test: update issue fields and status in `apps/backend/tests/integration/issues.test.ts`
- [x] T026 [P] Integration test: reject invalid status transitions in `apps/backend/tests/integration/issues.test.ts`

### Implementation for User Story 3

- [x] T027 [US3] Extend issue service with `updateIssue` in `apps/backend/src/services/issueService.ts`
- [x] T028 [US3] Add `PUT /rest/api/2/issue/:key` route in `apps/backend/src/routes/issues.ts`

**Checkpoint**: Status transitions work and reject invalid statuses.

## Phase 6: User Story 4 — Simple Web UI (P2)

**Goal**: Users can view projects and issues in a browser.

**Independent Test**: Opening the frontend shows a project list and clicking a project shows issues.

### Implementation for User Story 4

- [x] T029 [P] Create API client in `apps/frontend/src/api/client.ts`
- [x] T030 [P] Create `ProjectList` page in `apps/frontend/src/pages/ProjectList.tsx`
- [x] T031 [P] Create `IssueList` page in `apps/frontend/src/pages/IssueList.tsx`
- [x] T032 [US4] Setup React Router in `apps/frontend/src/main.tsx`
- [x] T033 [US4] Add simple styling with Tailwind for project/issue cards
- [x] T034 [P] Add Playwright smoke test in `apps/frontend/tests/e2e/smoke.spec.js`

**Checkpoint**: Frontend renders project list and issue list in a browser.

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story cleanup, docs, and validation.

- [x] T035 [P] Add `docker-compose.yml` for PostgreSQL and Redis (optional for this sprint)
- [x] T036 [P] Update `specs/001-core-foundation/quickstart.md` with any script changes
- [x] T037 [P] Run `pnpm lint` and `pnpm test` end-to-end and fix errors
- [x] T038 [P] Verify manual quickstart steps work
- [x] T039 [P] Commit all work with descriptive messages (repo not initialized; run `git init` first)

## Dependencies & Execution Order

1. Phase 1 (Setup) can run in parallel.
2. Phase 2 (Foundational) must complete before user stories.
3. User stories 1, 2, 3, and 4 can start after Phase 2; UI (US4) depends on backend APIs but can use mocks initially.
4. Phase 7 (Polish) runs after all user stories are complete.

## Implementation Strategy

Sequential MVP delivery:
1. Complete Setup.
2. Complete Foundational backend.
3. Complete User Story 1 (projects) and validate.
4. Complete User Story 2 (issues) and validate.
5. Complete User Story 3 (status transitions) and validate.
6. Complete User Story 4 (UI) and validate.
7. Run full test suite and polish.

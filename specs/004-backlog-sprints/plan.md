# Implementation Plan: Backlog & Sprint Management

**Branch**: `004-backlog-sprints` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

## Summary

Add the scrum cadence: a persisted `Sprint` model, Jira Agile-shaped sprint endpoints, a Jira-faithful backlog view with drag-to-plan, and active-sprint scoping on the board. Native HTML5 DnD as on the board — still zero new runtime deps.

## Technical Context

- Stack unchanged. **Schema change**: new `Sprint` model + `Issue.sprintId` (Prisma migrate, SQLite).
- Board semantics: active sprint ⇒ board issues = sprint issues; no sprints ⇒ all issues (kanban). Documented in contracts.

## Constitution Check

- [x] Sprint-First: end-to-end scrum loop (plan → start → board → complete).
- [x] API-First: Jira Agile paths/shapes; UI consumes them only.
- [x] Test-First: integration tests for lifecycle, one-active invariant, spillover, board scope.
- [x] Jira Compatibility: `/rest/agile/1.0/sprint*` + `/backlog/issue`; `boardId=projectKey` divergence carried over.
- [x] Explicit Simplicity: no rank, no dates UI, no parallel sprints, no reports.

## Structure

```text
apps/backend/src/
├── prisma/schema.prisma      # + Sprint, Issue.sprintId
├── services/sprintService.ts  # NEW: CRUD-lite + lifecycle + moves
├── services/boardService.ts   # listBoardIssues: active-sprint filter
├── services/issueService.ts   # include sprint in response
└── routes/sprints.ts          # NEW: /sprint*, /backlog/issue
apps/frontend/src/
├── api/client.ts              # sprint types + fetchers
├── pages/BacklogPage.tsx      # NEW: grouped rows + DnD + lifecycle buttons
├── components/ProjectSidebar.tsx  # Backlog link enabled
└── pages/IssueDetailPage.tsx  # + Sprint row in Details
apps/backend/tests/integration/sprint.test.ts  # NEW
```

## Data Flow

- Backlog page: `GET /board/{key}/sprint` (sections) + `GET /search?jql=project=K&maxResults=200` (all issues; `fields.sprint` groups them).
- Drop onto sprint group → `POST /sprint/{id}/issue {issues:[key]}`; onto Backlog group → `POST /backlog/issue {issues:[key]}`.
- Start → `POST /sprint/{id} {state:'active'}` (rejects if another active); Complete → `{state:'closed'}` + spillover.

## Complexity Tracking

| Decision | Why | Revisit when |
|---|---|---|
| Implicit scrum mode on board | No separate board types yet | Board type config |
| No in-row ranking | LexoRank needs design | Sprint 005+ |

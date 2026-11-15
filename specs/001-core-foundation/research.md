# Phase 0 Research: Core Foundation

## Research Questions

1. What is the smallest Jira-compatible foundation we can build and still demonstrate value?
2. Which backend/frontend stack is fastest to set up while matching the DESIGN.md architecture?
3. Which Jira REST API endpoints are most essential for project and issue CRUD?

## Findings

### Minimal Jira Feature Set

Jira's value proposition rests on three pillars: projects, issues, and status. A sprint that delivers project creation, issue creation, and status transitions is a credible foundation. Everything else (workflows, boards, sprints, custom fields) builds on these entities.

### Stack Choice

The DESIGN.md proposes a TypeScript monorepo with Express, Prisma, React, and Vite. This stack is well-documented and fits the spec-kit requirement of keeping dependencies minimal. For the first sprint, we can run Prisma against SQLite to avoid a Docker dependency for every developer, while keeping the Prisma schema compatible with PostgreSQL.

### Jira-Compatible Endpoints

Jira REST v2 uses these patterns:

- `POST /rest/api/2/project` — create project
- `GET /rest/api/2/project` — list projects
- `GET /rest/api/2/project/{key}` — get project
- `POST /rest/api/2/issue` — create issue
- `GET /rest/api/2/search?jql=project=KEY` — search issues (or `GET /rest/api/2/issue/{issueKey}`)
- `PUT /rest/api/2/issue/{issueKey}` — update issue fields
- `POST /rest/api/2/issue/{issueKey}/transitions` — transition issue status

For this sprint, we implement simplified versions of these endpoints with Jira-style request/response bodies.

## Decisions

- Use **Turborepo + pnpm** for the monorepo.
- Use **Prisma** with SQLite in development and PostgreSQL in production (schema compatible with both).
- Use **Express + Zod** for the API.
- Use **React + Vite + Tailwind + TanStack Query** for the UI.
- Use **Vitest + Supertest** for API tests; **Playwright** for a single e2e smoke test.
- Do not implement auth; treat all users as admin.
- Use Jira-compatible field names (`key`, `summary`, `issuetype`, `status`, `priority`, `description`).

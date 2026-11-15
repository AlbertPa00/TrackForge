# Implementation Plan: Jira-Style UI & Core Issue Workflow

**Branch**: `002-jira-style-ui` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

## Summary

Transform the sprint-001 skeleton into a visually Jira-faithful app: Atlassian-style shell (dark top nav, project sidebar), Jira's list-view issue table with filters, `/browse/:key` issue detail with a details panel and transition dropdown, and Jira-style create dialogs. Backend gains metadata endpoints, Jira transitions endpoints, an extended JQL-lite search, and a stub user — all lightweight, no plugins, per constitution V.

## Technical Context

- Stack unchanged (constitution-fixed): React 18 + Vite + Tailwind + TanStack Query + React Router; Express + Prisma + Zod + SQLite. No new dependencies — icons are inline SVG components.
- Storage: SQLite dev DB unchanged; **no schema migration** this sprint.
- Testing: extend Vitest/Supertest suites; update Playwright smoke.

## Constitution Check

- [x] Sprint-First: runnable end-to-end slice (create → list → detail → transition).
- [x] API-First: all UI data via `/rest/api/2/*`; metadata + transitions endpoints added.
- [x] Test-First: integration tests for every new endpoint; e2e smoke updated.
- [x] Jira Compatibility: `/transitions`, `/myself`, `/status`, `/priority`, `/issuetype` mirror Jira v2; `/browse/:key` URL; PUT stays 204 like real Jira.
- [x] Explicit Simplicity: JQL-lite stays a small regex parser; User is a stub, not a model; icons are inline SVG, zero new deps; no plugin architecture.

## Design Decisions

1. **Stub user, no User table**: `GET /myself` returns a fixed admin; issue `reporter` = stub, `assignee` = null. Deferred to a later sprint when auth arrives.
2. **JQL-lite grammar** (documented in contracts/api.md):
   `project = KEY [AND status = "Name"] [AND issuetype = "Name"] [AND priority = "Name"] [ORDER BY created|updated|key ASC|DESC]` + `startAt`, `maxResults`.
3. **Transitions**: since the workflow allows any direction this sprint, `GET .../transitions` returns every status except the current one, each with a synthetic transition `id` = status id.
4. **Style tokens**: hand-rolled Atlassian palette in `tailwind.config.js` (N-grays, B-blues, lozenge colors); icons (type glyphs, priority chevrons, avatar initials) as small React SVG components.

## Project Structure

```text
apps/backend/src/
├── routes/
│   ├── meta.ts            # NEW: /status /priority /issuetype /myself
│   ├── issues.ts          # + GET/POST /:key/transitions
│   └── search.ts          # extended JQL-lite + pagination
├── services/
│   ├── metaService.ts     # NEW
│   ├── userService.ts     # NEW: stub admin
│   └── issueService.ts    # + listIssues(filters, page), transitions

apps/frontend/src/
├── api/client.ts          # typed fetchers for all endpoints
├── components/            # NEW
│   ├── TopNav.tsx
│   ├── ProjectSidebar.tsx
│   ├── StatusLozenge.tsx
│   ├── PriorityIcon.tsx
│   ├── IssueTypeIcon.tsx
│   ├── UserAvatar.tsx
│   ├── StatusTransitionMenu.tsx
│   ├── IssueTable.tsx
│   ├── CreateIssueDialog.tsx
│   └── CreateProjectDialog.tsx
├── layout/ProjectLayout.tsx  # sidebar + outlet
└── pages/
    ├── ProjectsPage.tsx        # Jira project directory table
    ├── IssueNavigatorPage.tsx  # list view with filters
    └── IssueDetailPage.tsx     # /browse/:key
```

## Route Map (UI)

| Path | Page |
|---|---|
| `/` | Projects directory |
| `/projects/:key` | Issue list (List view) |
| `/browse/:issueKey` | Issue detail |

## Complexity Tracking

None. User stub is documented in spec assumptions.

# Tasks: Jira-Style UI & Core Issue Workflow

**Input**: Design documents from `/specs/002-jira-style-ui/`

## Phase 1: Backend — Metadata & User Stub

- [x] T001 [P] Create `src/services/userService.ts` — stub admin `getMyself()`
- [x] T002 [P] Create `src/services/metaService.ts` — list statuses/priorities/issue types with Jira shapes
- [x] T003 Create `src/routes/meta.ts` — `GET /status`, `/priority`, `/issuetype`, `/myself`; wire into `main.ts`
- [x] T004 [P] Integration test `tests/integration/meta.test.ts` for all four endpoints
- [x] T005 Extend `toIssueResponse` in `issueService.ts` — add `status.statusCategory`, `assignee` (null), `reporter` (stub)

## Phase 2: Backend — Transitions & Search

- [x] T006 [P] `issueService.ts`: `getIssueTransitions(key)` + `executeTransition(key, statusId)`
- [x] T007 `routes/issues.ts`: `GET /:key/transitions`, `POST /:key/transitions` (204)
- [x] T008 `issueService.ts`: `listIssues(projectKey, filters, {startAt,maxResults})` → `{total, issues}`
- [x] T009 `routes/search.ts`: extended JQL-lite grammar + pagination per contracts/api.md
- [x] T010 [P] Integration tests `tests/integration/transitions.test.ts` + `tests/integration/search.test.ts`

## Phase 3: Frontend — Theme, API Client, Components

- [x] T011 Extend `tailwind.config.js` with Atlassian palette tokens
- [x] T012 Rewrite `src/api/client.ts` — all endpoint types + fetchers
- [x] T013 [P] `UserAvatar.tsx`, `StatusLozenge.tsx`, `PriorityIcon.tsx`, `IssueTypeIcon.tsx` (inline SVG)
- [x] T014 [P] `TopNav.tsx` — dark nav, links, Create button, search, avatar
- [x] T015 [P] `ProjectSidebar.tsx` — project avatar/name, List active, Board/Backlog/Timeline disabled
- [x] T016 `StatusTransitionMenu.tsx` — lozenge dropdown → transitions
- [x] T017 `IssueTable.tsx` — Jira list-view columns + row hover
- [x] T018 `CreateIssueDialog.tsx` + `CreateProjectDialog.tsx` — modal dialogs w/ validation, auto key suggestion

## Phase 4: Frontend — Pages & Routes

- [x] T019 `layout/ProjectLayout.tsx` — sidebar + `<Outlet/>`
- [x] T020 `pages/ProjectsPage.tsx` — Jira project directory table + Create project button + empty state
- [x] T021 `pages/IssueNavigatorPage.tsx` — filters (status, priority, type, text) + IssueTable + empty state
- [x] T022 `pages/IssueDetailPage.tsx` — breadcrumb, summary, description, details panel, transitions
- [x] T023 `App.tsx` — routes: `/`, `/projects/:key`, `/browse/:issueKey`; delete old pages

## Phase 5: Polish

- [x] T024 Update Playwright smoke spec for new shell
- [x] T025 `pnpm lint` + `pnpm test` green end-to-end
- [x] T026 `git init` + initial commit of the whole repo

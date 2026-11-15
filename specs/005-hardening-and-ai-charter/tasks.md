# Tasks: Hardening & AI-Native Charter

Per `docs/sprints/005-hardening-and-ai-charter.md`.

- [x] T001 Atomic issue counter: `Project.issueCounter`, single-statement `UPDATE … increment`; concurrency test (20 parallel creates → distinct gap-free numbers)
- [x] T002 `PUBLIC_BASE_URL` config; all `self` links derive from it; Jira-shaped JSON 404 for unknown `/rest/*`
- [x] T003 JQL-lite `summary ~ "text"` clause (Postgres `mode: insensitive`) + tests + contract doc
- [x] T004 CI workflow `.github/workflows/ci.yml` + `pnpm typecheck` scripts + turbo task
- [x] T005 Honest nav: dead top-nav items disabled w/ sprint tooltips + `aria-disabled`; Projects active-state fix; sidebar sprint tooltips
- [x] T006 Global search: issue-key → `/browse/:key`; free text in project → list prefilled; outside → Sprint-010 hint
- [x] T007 IssueNavigator: pager (25/50/100 + "1–50 of N"), sortable Key/Created/Updated, server-side debounced text, URL query params
- [x] T008 Palette unification (ADS `atl-b-*` + `inverse`/`card`/`lozenge` tokens, accents in `lib/palette.ts`); `/browse/:key` List-highlight; details panel width/wrap; date tooltips
- [x] T009 US6 PostgreSQL: provider switched, migration re-baselined, compose maps 5433 (avoids local pg on 5432), CI postgres service, isolated `trackforge_test` DB, quickstart + `.env.example`, `.gitignore` now tracks migrations
- [x] T010 Constitution v1.1.0 (principle VI); DESIGN.md §23 AI-Native Control Plane + `/api/internal/*` prefix fix; plan-template Constitution Check updated
- [x] T011 Suite green: 47/47 backend tests on PostgreSQL, typecheck/lint/build/e2e pass

**Notes vs plan**: issue-number allocation uses an atomic `UPDATE … SET issueCounter = issueCounter + 1` statement rather than an interactive transaction — SQLite (and Prisma's queue) cannot serialize 20 concurrent interactive transactions; the single-statement increment is atomic on Postgres and produced distinct gap-free numbers in the test.

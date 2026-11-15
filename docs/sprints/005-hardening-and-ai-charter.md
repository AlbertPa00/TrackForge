# Sprint 005 — Hardening & AI-Native Charter

| | |
|---|---|
| **Status** | Planned |
| **Theme** | Quality, product honesty, principles |
| **Depends on** | 004 (Backlog & Sprint Management) merged |
| **Unblocks** | 006 and every later sprint (CI, DB, principles) |
| **Spec-kit folder** | `specs/005-hardening-and-ai-charter/` (created at sprint start) |
| **Open decisions** | D1 (PostgreSQL), D2 (CI host), D3 (design tokens) — see [roadmap](../roadmap.md#5-open-decisions) |

## Goal

Make the existing product trustworthy before it grows: every commit is verified by CI, the UI only
shows things that work, known integrity bugs are fixed, the codebase runs on the production database,
and "AI-native" becomes a ratified principle that later sprints are measured against.

## Why now

- The list page silently caps at 100 issues and its text search only filters that page.
- Concurrent issue creation can fail with a 500 (issue-number race).
- Five top-nav links and the global search box do nothing.
- Two different blues appear on the same screen because two palettes are mixed.
- Nothing in the constitution or `DESIGN.md` requires agent operability, so nothing enforces it.

## Scope

**In**: CI pipeline, honest navigation, issue-list pagination/sorting/server-side text search,
integrity fixes, unified design tokens and detail-page polish, PostgreSQL as default database,
constitution v1.1.0 with an AI-native principle, `DESIGN.md` AI section.

**Out**: new domain features (users, comments, workflows), new pages beyond what is listed.

---

## User stories

### US1 — Every change is verified automatically (P1)

As a maintainer, I want CI to run typecheck, lint, unit/integration tests and the Playwright smoke
test on every push so that regressions are caught before merge.

**Independent test**: push a commit with a type error; CI fails. Push a fix; CI passes.

**Acceptance scenarios**

1. **Given** a push to any branch, **When** CI runs, **Then** it installs with pnpm, generates the Prisma client, runs `typecheck`, `lint`, backend tests and Playwright against a started backend+frontend, and reports pass/fail.
2. **Given** any step fails, **When** CI finishes, **Then** the run is red and shows the failing step.
3. **Given** the root `package.json`, **When** a developer runs `pnpm typecheck`, **Then** both apps are type-checked (new script).

### US2 — The UI only shows what works (P1)

As a user, I want navigation that tells the truth so that I don't click on dead ends.

**Independent test**: click every top-nav and sidebar entry; each either navigates to a working page or is visibly disabled with a "Coming in Sprint NNN" tooltip.

**Acceptance scenarios**

1. **Given** the top nav, **When** it renders, **Then** "Your work", "Filters", "Dashboards" and "Teams" are either hidden or rendered disabled with a tooltip naming the sprint that delivers them; "Projects" is highlighted only on project routes.
2. **Given** disabled sidebar items (Timeline, Project settings; Backlog and Board are live after 003/004), **When** they render, **Then** they are visually distinct from enabled items (reduced contrast, `not-allowed` cursor, `aria-disabled="true"`).
3. **Given** the global search box, **When** a user types an issue key such as `TF-12` and presses Enter, **Then** they navigate to `/browse/TF-12`.
4. **Given** the global search box, **When** a user types free text and presses Enter inside a project, **Then** they navigate to that project's list with the text search pre-filled; outside a project, a hint says cross-project search arrives in Sprint 010.

### US3 — The issue list scales (P1)

As a user, I want to page, sort and search all issues in a project so that large projects are usable.

**Independent test**: seed 250 issues; page through all of them; sort by Created; search for a summary on page 3 from page 1.

**Acceptance scenarios**

1. **Given** more than 50 matching issues, **When** the list renders, **Then** a pager shows "1–50 of N" with previous/next and page-size options (25/50/100), driven by `startAt`/`maxResults`.
2. **Given** the Key, Created or Updated column header, **When** a user clicks it, **Then** results re-sort server-side (`ORDER BY`) and the header shows the direction.
3. **Given** text in the list search box, **When** the user types, **Then** the search is server-side (debounced) using a new JQL-lite clause `summary ~ "text"`, matching across all pages.
4. **Given** the URL, **When** filters, sort, page or text change, **Then** they are reflected in query params so the view can be shared and reloaded.

### US4 — Data integrity fixes (P1)

As an API consumer, I want correct, stable responses so that integrations don't break.

**Acceptance scenarios**

1. **Given** 20 concurrent `POST /issue` calls for one project, **When** they complete, **Then** all succeed with 20 distinct, gap-free issue numbers (atomic per-project counter updated in the same transaction).
2. **Given** `PUBLIC_BASE_URL` is set, **When** any response includes `self`, **Then** it uses that base URL instead of `http://localhost:3000`.
3. **Given** an unknown route under `/rest/api/2`, **When** it is called, **Then** a Jira-shaped 404 JSON error is returned (not Express HTML).

### US5 — One design system, polished detail page (P2)

As a user, I want a consistent visual language so that the product feels finished.

**Acceptance scenarios**

1. **Given** the Tailwind config, **When** the sprint ends, **Then** a single token set (D3) is defined and no component uses raw hex colours for brand, neutral or status colours.
2. **Given** the top-nav Create button and in-page Create buttons, **When** viewed together, **Then** they use the same brand colour.
3. **Given** `/browse/:key`, **When** it renders, **Then** "List" is highlighted in the project sidebar, the details panel does not wrap names onto two lines at 1440 px, and the page width uses the available space.
4. **Given** dates in the table and details panel, **When** hovered, **Then** a tooltip shows the full timestamp.

### US6 — PostgreSQL is the default database (P2, decision D1)

As an operator, I want development, CI and production to run the same database so that migrations and queries behave identically.

**Acceptance scenarios**

1. **Given** `docker compose up -d postgres`, **When** a developer runs `pnpm db:migrate && pnpm db:seed`, **Then** the schema and seed data are created in PostgreSQL.
2. **Given** CI, **When** tests run, **Then** they run against a PostgreSQL service container with an isolated database per test run.
3. **Given** the SQLite file `apps/backend/prisma/trackforge.db`, **When** the sprint ends, **Then** it is removed from the repo and `.gitignore` covers local DB files.

### US7 — AI-native is a ratified principle (P2)

As the team, we want agent operability written into the constitution so that every later sprint is measured against it.

**Acceptance scenarios**

1. **Given** the constitution, **When** amended to v1.1.0, **Then** it contains principle **VI. AI-Native Operability** (text below), an updated Sync Impact Report and a new last-amended date.
2. **Given** `DESIGN.md`, **When** updated, **Then** it has a new section "AI-Native Control Plane" summarising principles A1–A8 from the roadmap and linking to `docs/roadmap.md`, and §18.1/§18.5 agree on the native API prefix (D5).
3. **Given** the spec-kit templates, **When** updated, **Then** `plan-template.md`'s Constitution Check includes principle VI.

**Draft principle text**

> ### VI. AI-Native Operability
> Every capability must be operable by an AI agent with the same fidelity as by a human. Features are
> exposed through the public API and the MCP tool layer; writes are attributable to a human or agent
> actor, safe to retry, previewable, and reversible through history; agents discover valid inputs from
> metadata rather than guessing. A feature that only works through the UI is not done.
>
> Rationale: TrackForge's differentiator over a plain Jira-compatible tracker is that agents can plan, triage and execute
> work inside it safely. That property cannot be retrofitted; it must be designed into every slice.

---

## Edge cases

- Concurrent create across *different* projects must not serialise on a global lock.
- `summary ~ ""` (empty text) is treated as no filter, not an error.
- Page beyond the last page returns an empty `issues` array with the correct `total`.
- Disabled nav items must remain keyboard-focusable only if they show a tooltip; otherwise skipped.

## Functional requirements

- **FR-001**: CI MUST run typecheck, lint, backend tests and Playwright on every push and fail on any error.
- **FR-002**: The UI MUST NOT render enabled controls that have no behaviour.
- **FR-003**: `GET /search` MUST support `summary ~ "text"` (case-insensitive substring) in JQL-lite; the documented grammar in `contracts/api.md` MUST be updated.
- **FR-004**: Issue numbers MUST be allocated atomically per project.
- **FR-005**: All `self` links MUST derive from `PUBLIC_BASE_URL`.
- **FR-006**: Unknown `/rest/*` routes MUST return Jira-shaped JSON errors.
- **FR-007**: The frontend MUST use a single design-token set.
- **FR-008**: PostgreSQL MUST be the default datasource for dev, CI and prod (if D1 accepted).
- **FR-009**: The constitution MUST be amended to v1.1.0 with principle VI.

## API changes

| Change | Endpoint | Jira-compatible? |
|---|---|---|
| New clause `summary ~ "text"` | `GET /rest/api/2/search` | Yes (subset of JQL) |
| `self` from `PUBLIC_BASE_URL` | All | Yes |
| JSON 404 for unknown routes | `/rest/*` | Yes |

## Data model changes

- `Project.issueCounter Int @default(0)` — incremented in the create-issue transaction.
- Datasource provider → `postgresql` (D1). Migration history re-baselined once (acceptable: no production data yet).

## AI-native checklist

- [ ] Principle VI ratified (US7).
- [ ] No new UI-only behaviour introduced (A1).
- [ ] Server-side search and pagination make the list usable by agents through the same API (A1, A8).

## Success criteria

- **SC-001**: CI is green on `main` and blocks a deliberately broken commit.
- **SC-002**: 0 enabled-but-dead controls remain (manual audit checklist in `tasks.md`).
- **SC-003**: 250-issue project: every issue reachable via paging; text search finds issues on any page.
- **SC-004**: Concurrency test (20 parallel creates) passes 10/10 runs.
- **SC-005**: Backend test count ≥ (count at end of 004) + 8.

## Risks

| Risk | Mitigation |
|---|---|
| Postgres raises the dev setup bar on Windows | Document Docker Desktop setup in quickstart; keep a `DATABASE_URL` override |
| Sprint becomes a grab-bag | US1–US4 are the P1 shippable slice; US5–US7 can slip to 006 without blocking it, except US7 should not slip |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Quickstart updated for PostgreSQL and CI.
- [ ] Constitution v1.1.0 committed; `DESIGN.md` AI section committed.

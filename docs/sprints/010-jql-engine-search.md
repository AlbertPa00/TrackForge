# Sprint 010 — JQL Engine & Advanced Search

| | |
|---|---|
| **Status** | Done |
| **Theme** | Jira parity + AI |
| **Depends on** | 006 (users, `currentUser()`), 008 (labels, parent, resolution, due date) |
| **Unblocks** | 012 (natural-language → JQL needs a validator), 013 (JQL-backed board filters) |
| **Spec-kit folder** | `specs/010-jql-engine-search/` |
| **Open decisions** | D8 (parser approach); requires D1 (PostgreSQL) for full-text search |

## Goal

Replace the regex "JQL-lite" with a real JQL engine — a parser with precise errors, a query planner
that compiles to the database, cross-project search, functions and relative dates — and give users
an advanced search page with autocomplete and saved filters. This is also the query language agents
use to find work.

## Why now

JQL is how Jira users (and Jira integrations) find anything. The current grammar must start with
`project =`, supports only `AND` and `=`, and can't search across projects, by assignee, by text or by
date. The in-app copilot (012) will translate natural language into JQL and needs a validator to
check its output.

## Scope

**In**: JQL parser and compiler, supported fields/operators/functions listed below, `ORDER BY` on
multiple fields, cross-project search, Jira-style error messages, autocomplete endpoints, advanced
search UI (basic ⇄ JQL modes), column chooser, saved filters with favourites, live top-nav "Filters"
and global search, PostgreSQL full-text search.

**Out**: filter subscriptions by email, sharing with groups/roles (only private/all-users), custom
field JQL (no custom fields yet), OpenSearch (deferred until measured need).

---

## Supported JQL (this sprint)

| Category | Supported |
|---|---|
| **Fields** | `project`, `key`/`issuekey`, `summary`, `description`, `text`, `comment`, `status`, `statusCategory`, `issuetype`/`type`, `priority`, `resolution`, `assignee`, `reporter`, `labels`, `parent`, `created`, `updated`, `resolved`, `duedate` |
| **Operators** | `=` `!=` `>` `>=` `<` `<=` `IN` `NOT IN` `~` `!~` `IS EMPTY` `IS NOT EMPTY` (and `IS NULL` aliases) |
| **Logic** | `AND` `OR` `NOT`, parentheses, precedence `NOT > AND > OR` |
| **Values** | quoted/unquoted strings, numbers, lists `(a, b)`, `EMPTY`, relative dates `-7d`, `2w`, `-1h`, absolute dates `"2026-11-01"`, `"2026-11-01 14:00"` |
| **Functions** | `currentUser()`, `now()`, `startOfDay()`, `endOfDay()`, `startOfWeek()`, `endOfWeek()`, `startOfMonth()`, `endOfMonth()` (with optional offset, e.g. `startOfDay(-1)`), `membersOf()` deferred |
| **Ordering** | `ORDER BY f1 [ASC|DESC], f2 …` on key, created, updated, priority, status, assignee, duedate, rank |

The grammar is published in `contracts/jql.md` and returned by the MCP `jql_help` tool.

---

## User stories

### US1 — Real JQL over the API (P1)

As a user or integration, I want full JQL in `/search` so that I can express any everyday query.

**Independent test**: `project in (TF, MOB) AND assignee = currentUser() AND status != Done AND updated >= -7d ORDER BY priority DESC, updated DESC` returns the correct set and order.

**Acceptance scenarios**

1. **Given** any query in the supported grammar, **When** sent to `GET|POST /rest/api/2/search`, **Then** results match a reference evaluator in tests and respect permissions (token project allow-list from 006).
2. **Given** a query without `project`, **When** executed, **Then** it searches all projects the caller can see.
3. **Given** a syntax error, **When** executed, **Then** the response is `400` with Jira-style messages, e.g. `"Error in the JQL Query: Expecting operator but got 'Done'. (line 1, character 22)"`.
4. **Given** an unknown value (e.g. `status = Doing`), **When** executed, **Then** the response is `400` with `"The value 'Doing' does not exist for the field 'status'."`.
5. **Given** `text ~ "login timeout"`, **When** executed, **Then** summary, description and comments are searched with PostgreSQL full-text search (stemming, ranking); `summary ~` uses the same engine scoped to summary.
6. **Given** `POST /rest/api/2/jql/parse` (Jira Cloud endpoint, `{ queries: [] }`), **When** called, **Then** it returns the parsed structure or errors without executing — used by the copilot to validate.

### US2 — Advanced search page (P1)

As a user, I want a search page where I can build queries visually or type JQL so that I can find anything across projects.

**Independent test**: open "Filters → Advanced search", build "Status: In Progress, Assignee: me" with dropdowns, switch to JQL mode and see the equivalent query; edit it and run.

**Acceptance scenarios**

1. **Given** `/issues`, **When** opened, **Then** a Basic mode shows chips for Project, Type, Status, Assignee, Priority, Labels and a text box; a toggle switches to JQL mode with the equivalent query.
2. **Given** JQL mode, **When** typing, **Then** autocomplete suggests fields, operators, functions and values (`GET /rest/api/2/jql/autocompletedata` and `/jql/autocompletedata/suggestions?fieldName=&fieldValue=`), and syntax errors are underlined with the server message.
3. **Given** results, **When** shown, **Then** the table supports column chooser (persisted per user), header sort (maps to `ORDER BY`), pagination and a result count.
4. **Given** a query that cannot be expressed in Basic mode, **When** switching back, **Then** the UI explains Basic mode is unavailable for this query.
5. **Given** the top-nav search box, **When** a user types text, **Then** a dropdown shows matching issues (key/summary) and recent issues; Enter opens `/issues?jql=text ~ "…"`.

### US3 — Saved filters (P2)

As a user, I want to save and star queries so that I can return to them and share them.

**Acceptance scenarios**

1. **Given** a query on `/issues`, **When** the user clicks "Save as", **Then** a filter is created with name, description, JQL and visibility (private | all users) via `POST /rest/api/2/filter`.
2. **Given** `GET /rest/api/2/filter/my` and `/filter/favourite`, **When** called, **Then** the user's own and starred filters are returned in Jira shape (`id`, `name`, `jql`, `owner`, `favourite`, `viewUrl`, `searchUrl`).
3. **Given** the top-nav "Filters" menu, **When** opened, **Then** starred filters and "View all filters" are listed; the menu is no longer disabled.
4. **Given** a filter owned by someone else and shared with all users, **When** a user opens it, **Then** they can run and star it but not edit it.

### US4 — Search is fast (P2)

**Acceptance scenarios**

1. **Given** 10,000 issues across 20 projects, **When** typical queries (5 clauses, one text term, ORDER BY) run, **Then** p95 latency is < 300 ms on the reference dev machine (benchmark script checked in).
2. **Given** the compiler, **When** a query is executed, **Then** it compiles to a single SQL query (no N+1), with indexes for all filterable columns and a GIN index for full-text.

---

## Edge cases

- `assignee = currentUser()` with a token resolves to the token's user (an agent resolves to itself).
- `assignee != X` excludes unassigned issues (Jira semantics); users must write `OR assignee IS EMPTY`.
- Reserved words and special characters require quoting; error messages must say so.
- Relative dates are evaluated in the caller's time zone (from `User.timeZone`).
- `ORDER BY rank` before Sprint 009 ships falls back to key; after 009 uses LexoRank.

## Functional requirements

- **FR-001**: The JQL engine MUST parse, validate and compile the supported grammar to SQL with parameter binding (no string concatenation).
- **FR-002**: Errors MUST include line/character position and Jira-compatible wording.
- **FR-003**: Search MUST enforce caller visibility (token project allow-list; permission schemes later).
- **FR-004**: Autocomplete endpoints and `POST /jql/parse` MUST be implemented in Jira shape.
- **FR-005**: Saved filters MUST support CRUD, favourites, private/all-users visibility.
- **FR-006**: The JQL-lite grammar from 002/005 MUST remain a valid subset (no regression).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/rest/api/2/search` | Full JQL |
| POST | `/rest/api/2/jql/parse` | Validate without executing |
| GET | `/rest/api/2/jql/autocompletedata` · `/jql/autocompletedata/suggestions` | Jira |
| GET/POST | `/rest/api/2/filter` | Jira |
| GET/PUT/DELETE | `/rest/api/2/filter/{id}` | Jira |
| GET | `/rest/api/2/filter/my` · `/filter/favourite` | Jira |
| PUT/DELETE | `/rest/api/2/filter/{id}/favourite` | TrackForge convenience (documented divergence) |

## Data model changes

- **Filter**: `id`, `ownerId`, `name`, `description`, `jql`, `visibility` (private|all), timestamps; **FilterFavourite** (`filterId`, `userId`).
- **UserPreference**: `userId`, `key` (`issueTable.columns`), `value` JSON.
- Full-text: generated `tsvector` column on issues (summary + description) and comments, GIN indexes.

## MCP tools added

`search_issues` (now full JQL), `validate_jql` (wraps `/jql/parse`), `jql_help` (grammar, fields,
functions, examples), `list_filters`, `run_filter`, `save_filter`. Saved filters exposed as resources
`trackforge://filter/{id}`.

## AI-native checklist

- [ ] Agents can validate a query before running it (A3, A4).
- [ ] JQL errors are actionable: position, expected token, valid values (A8).
- [ ] `currentUser()` resolves to agent identity for agent tokens (A2).

## Success criteria

- **SC-001**: ≥ 150 parser/compiler unit tests including a corpus of real-world JQL queries; 100% of supported grammar constructs covered.
- **SC-002**: Search benchmark meets US4 targets.
- **SC-003**: Agent eval: 10 "find …" tasks phrased naturally are answered by agents via `jql_help` + `search_issues` with ≥ 90% correct result sets.

## Risks

| Risk | Mitigation |
|---|---|
| Parser scope creep (all of Jira JQL) | Fixed supported table above; unsupported constructs return a clear "not supported yet" error |
| SQL injection through JQL | Compiler emits parameterised queries only; fuzz tests |
| Full-text quality varies by language | Default `simple` + `english` configs; configurable later |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `contracts/jql.md` documents the grammar and every divergence from Jira JQL.
- [ ] The project issue list (from 005) uses the new engine; JQL-lite code removed.

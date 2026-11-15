# Sprint 010 spec — JQL Engine & Advanced Search

Source: `docs/sprints/010-jql-engine-search.md`. Status: **Done**.

## Delivered

| US | Deliverable |
|---|---|
| US1 | Real JQL engine in `apps/backend/src/jql/`: lexer → recursive-descent parser → AST → Prisma compiler. Fields, operators, `IN`/`NOT IN`, `IS EMPTY`/`IS NOT EMPTY`, `AND/OR/NOT` with precedence, parentheses, relative dates (`-7d`), date functions (`startOfWeek()`…), `currentUser()`, multi-field `ORDER BY` including `rank`. JQL-lite grammar remains a valid subset. Jira-style positioned errors. |
| US2 | `searchService` executes compiled queries: cross-project search (omit `project =`), token `projectKeys` visibility enforced (404 for invisible keys), no N+1, `fields`/`expand` preserved. `GET`/`POST /search` rewired; old contract preserved (204→actual responses, empty `~` no-op, Jira-shaped errors). |
| US3 | PostgreSQL FTS: generated `tsvector` columns on `Issue` (summary+description) and `Comment` (body), GIN indexes, `websearch_to_tsquery` for `~`/`!~`. |
| US4 | `POST /jql/parse` (structure or per-query errors), `GET /jql/autocompletedata` + `/suggestions` (field/value autocomplete, token-scoped). |
| US5 | `Filter`/`FilterFavourite`/`UserPreference` schema + migration; `/filter` CRUD, `/my`, `/favourite` (+`favorite`), `/search`, `PUT/DELETE /:id/favourite`, `GET /:id/run`; `sharePermissions`→visibility mapping; JQL validated on save. Internal `/preferences` API. |
| US6 | Frontend: `IssueSearchView` shared by project navigator + global `/issues` — Basic⇄JQL switch (basic subset maps back, else hint), `JqlEditor` with context-aware autocomplete + error banner, column chooser persisted via `issueTable.columns`, all sortable headers, `?jql=`/`?filterId=` deep links, Save-as/star/edit flows. TopNav: Filters menu (starred+mine+links), global search dropdown (recent + live results + advanced-search link). `/filters` management page. `recordRecentIssue` feeds recent list. |
| US7 | MCP: `search_issues` full-JQL hint, `validate_jql`, `jql_help`, `list_filters`, `run_filter`, `save_filter`; `trackforge://filter/{id}` resource. Eval extended to 44 checks. |

## Verification

- **142/142** JQL unit tests (lexer/parser/compiler corpus) + **73/73** JQL integration tests.
- Full backend suite green incl. OpenAPI drift (every route documented).
- MCP eval **44/44** live.
- Frontend typecheck/lint/build/e2e green; `/issues`, `/filters` screenshot-verified.

## Out of scope (per sprint doc)

`membersOf()`, `ORDER BY` on labels/reporter, field schema endpoint, watcher
search, filter subscriptions/shares beyond global/private (Sprint 011+).

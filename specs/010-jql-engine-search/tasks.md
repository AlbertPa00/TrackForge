# Tasks — Sprint 010

- [x] T1 Schema: `Filter`, `FilterFavourite`, `UserPreference`, FTS generated
      columns + GIN indexes; migration deployed to dev + test DBs
- [x] T2 JQL engine: `jql/lexer.ts`, `jql/ast.ts`, `jql/fields.ts`,
      `jql/parser.ts`, `jql/dates.ts` — positioned Jira-style errors
- [x] T3 `jql/compiler.ts` — AST→Prisma where/orderBy, value resolution
      (names→ids, `currentUser()`, relative dates, functions), `~`→FTS
      prequery, token `projectKeys` scoping, priority/status-category ordering
- [x] T4 `searchService` + `routes/search.ts` rewrite — cross-project,
      `fields`/`expand` preserved, legacy contract kept (204, empty-`~` no-op,
      unsupported-clause errors)
- [x] T5 Routes: `POST /jql/parse`, `GET /jql/autocompletedata[ + /suggestions]`,
      `/filter` CRUD + `/my` + `/favourite(s)` + `/search` + `/:id/run` +
      `/:id/favourite`, internal `/preferences`
- [x] T6 OpenAPI paths for every new route — drift test green
- [x] T7 Unit tests: 142 parser/compiler cases; integration: 73 JQL/search/
      filter/auth cases; legacy regressions fixed (4)
- [x] T8 Frontend: `IssueSearchView` (Basic⇄JQL, column chooser persisted,
      sort headers), `JqlEditor` (autocomplete + errors), `/issues` + `/filters`
      routes, FiltersPage, navigator wrapper
- [x] T9 TopNav: Filters dropdown (starred/mine/links), global search dropdown
      (recent + live), `recordRecentIssue`
- [x] T10 MCP: `validate_jql`, `jql_help`, `list_filters`, `run_filter`,
      `save_filter`, `search_issues` full-JQL, `trackforge://filter/{id}` —
      eval 44/44
- [x] T11 Docs: `contracts/jql.md`, spec/plan/tasks, compat matrix, benchmark
- [ ] T12 Full verification + commit

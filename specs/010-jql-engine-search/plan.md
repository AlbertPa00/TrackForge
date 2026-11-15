# Plan — Sprint 010 JQL Engine & Advanced Search

## Architecture

```
JQL string → jql/lexer → jql/parser → AST (jql/ast)
                                   ↘ jql/parse route (structure/errors)
                jql/fields (canonical registry: names, aliases, ops, value kinds,
                          orderable, suggestAs) — shared by parser/compiler/autocomplete
                jql/dates — relative dates + functions in caller's user.timeZone
AST → jql/compiler → Prisma where[] + orderBy + FTS prequery + visibility scope
    → services/searchService → paged issues → toIssueResponse
services/filterService → Filter/FilterFavourite CRUD + share visibility
```

## Decisions

- **Real parser, not regex** — lexer emits positioned tokens; recursive descent
  produces Jira-style errors (`Field 'x' does not exist`, `Expected a value for
  field 'y' (position n)`).
- **Field registry (`fields.ts`)** is the single source of truth for names,
  aliases, allowed operators, value kinds, orderability, autocomplete `suggestAs`
  — parser validation, compiler dispatch, `autocompletedata`, and `jql_help`
  all read it.
- **Compile to Prisma structures**, not SQL strings; `$queryRaw` only for the
  FTS candidate prequery (`tsvector @@ tsquery`, parameterized).
- **FTS via generated columns + GIN** — `searchVector` on `Issue` (summary +
  description weighted) and `Comment`; migration adds columns/indexes; `~`
  compiles to a prequery returning matching ids, folded into the where clause.
- **Cross-project by default** — omitting `project = K` searches every project
  in the token's `projectKeys` (or all for users); `key = X` outside scope → 404.
- **Priority ordering by `sequence`** — seeded Highest→Lowest, so Jira `DESC`
  (highest first) maps to ascending sequence; status-category Jira keys
  (`new`/`indeterminate`/`done`) map to DB `todo`/`inprogress`/`done`.
- **UUID filter ids** — stable across restarts (no numeric alias fragility).
- **Shared `IssueSearchView`** — one component serves the project navigator
  (`fixedProjectKey`) and global `/issues`; basic ⇄ JQL mapping lives beside it
  (`buildBasicJql`/`jqlToBasic`); columns persist via `issueTable.columns`
  preference (URL `cols=` overrides for sharing).

## Risk areas covered by tests

- Precedence `NOT > AND > OR`, parentheses, `IN` lists, empty/null ops
- Relative dates + function offsets in a pinned timezone
- Token project allow-list → 404 vs empty
- Priority/status-category ordering direction
- FTS stemming (`notify`~`notifying`→`notifications`) + comment search via `text ~`
- Legacy contract: empty `~` no-op, `204` PUT, unsupported-clause wording

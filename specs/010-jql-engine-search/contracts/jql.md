# JQL contract — TrackForge query language

TrackForge implements a Jira-compatible JQL subset. The old JQL-lite grammar
(`project = K AND field = v …`) is a valid subset — existing queries keep working.

## Grammar

```ebnf
query        := where? orderBy?
where        := orExpr
orExpr       := andExpr ("OR" andExpr)*
andExpr      := unary ("AND" unary)*
unary        := "NOT" unary | "(" orExpr ")" | condition
condition    := field operator operand
             |  field ("IS" | "IS NOT") ("EMPTY" | "NULL")
             |  field ("WAS" | "WAS NOT") ("IN")? operand histPred*
             |  field "CHANGED" histPred*
operator     := "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~"
             |  "IN" | "NOT IN"            // operand: (v, v, …)
operand      := value | "(" value ("," value)* ")"
value        := STRING | QUOTED | NUMBER | function | "EMPTY" | relativeDate
function     := IDENT "(" (STRING|NUMBER ("," ...)*)? ")"
relativeDate := ("-"?NUMBER ("s"|"m"|"h"|"d"|"w"|"M"|"y"))  // e.g. -7d, 2w
histPred     := ("FROM"|"TO") operand            // CHANGED only
             |  ("BEFORE"|"AFTER"|"ON") dateValue
             |  "DURING" "(" dateValue "," dateValue ")"
             |  "BY" userValue
orderBy      := "ORDER BY" field ("ASC"|"DESC")? ("," field ("ASC"|"DESC")?)*
```

Keywords are case-insensitive; precedence is `NOT > AND > OR`.
Reserved words: `AND OR NOT IN IS EMPTY NULL ORDER BY ASC DESC WAS CHANGED
FROM TO BEFORE AFTER ON DURING` — quote them to use as values.

## Fields

| Field | Aliases | Operators | Value type | Orderable |
|---|---|---|---|---|
| `project` | — | `= != IN NOT IN` | project key or name | yes |
| `key` / `issue` | `issuekey` | `= != > >= < <= IN NOT IN` | issue key (TF-12), issue-set functions | yes |
| `summary` | — | `~ !~` | text (quoted for spaces) | yes |
| `description` | — | `~ !~ IS` | text | no |
| `text` | — | `~ !~` | text — summary+description+comments | no |
| `comment` | — | `~ !~` | text | no |
| `status` | — | `= != IN NOT IN WAS CHANGED` | status name | yes |
| `statusCategory` | — | `= != IN NOT IN` | `To Do`/`In Progress`/`Done` (or `new`/`indeterminate`/`done`) | no |
| `issuetype` | `type` | `= != IN NOT IN` | type name | yes |
| `priority` | — | `= != IN NOT IN WAS CHANGED` | priority name | yes (severity order) |
| `resolution` | — | `= != IN NOT IN IS WAS CHANGED` | resolution name or `Unresolved` | yes |
| `assignee` | — | `= != IN NOT IN IS WAS CHANGED` | display name, email, user functions, `EMPTY` | yes |
| `reporter` | — | `= != IN NOT IN IS WAS CHANGED` | same as assignee | no |
| `labels` | `label` | `= != IN NOT IN IS` | label (no spaces) | no |
| `parent` | — | `= != IN NOT IN` | issue key, tree functions | no |
| `created` | — | `= != > >= < <=` | `YYYY-MM-DD`, `YYYY/MM/DD`, datetime, relative, functions | yes |
| `updated` | — | `= != > >= < <=` | same | yes |
| `resolved` | `resolutiondate` | `= != > >= < <= IS` | same | yes |
| `duedate` | `due` | `= != > >= < <= IS` | same | yes |
| `storypoints` | `story_points` `storypointestimate` `points` | `= != > >= < <= IN NOT IN IS` | number | yes |
| `sprint` | — | `= != IN NOT IN IS WAS CHANGED` | sprint id/name/sequence, `openSprints()` `closedSprints()` `futureSprints()` | no |
| `component` | `components` | `= != IN NOT IN IS` | component name | no |
| `fixversion` | `fixversions` | `= != IN NOT IN IS WAS CHANGED` | version name/id, `releasedVersions()` `unreleasedVersions()` `earliestUnreleasedVersion()` `latestReleasedVersion()` | no |
| `affectedversion` | `affectsversion` `versions` | `= != IN NOT IN IS` | same | no |
| `timespent` | — | `= != > >= < <= IN NOT IN IS` | duration `2h`/`1w 3d` or seconds | no |
| `timeoriginalestimate` | `originalestimate` | same | same | yes |
| `timeestimate` | `remainingestimate` | same | same | yes |
| `workratio` | — | `= != > >= < <= IN NOT IN` | number (percent) | no |
| `worklogdate` | — | `= != > >= < <= IN NOT IN IS` | date | no |
| `billable` | — | `= != IN NOT IN IS` | `true`/`false` | no |
| `votes` | `votecount` | `= != > >= < <= IN NOT IN` | number (denormalized `voteCount`) | yes |
| `watches` | `watchers` `watchcount` | `= != > >= < <= IN NOT IN` | number (denormalized `watcherCount`) | yes |
| `security` | `level` `securitylevel` | `= != IN NOT IN IS` | security level name — effective (inherited) level | no |
| `projectcategory` | `category` | `= != IN NOT IN IS` | category name | no |
| `filter` | `savedfilter` `request` | `= != IN NOT IN` | saved-filter name or id — inlined subquery honoring share scope | no |
| `cf[NNNNN]` / `customfield_NNNNN` / bare CF name / alias | `Flagged`, `Story Points`, … | per searcher type | option value, text, number, date, user | per type |

`rank` is orderable only (`ORDER BY rank`). Unknown field names resolve as
custom-field names/aliases first — `Flagged = Impediment` works unquoted;
a genuine typo still errors `Field 'x' does not exist…`.

## Functions

Registry: `GET /api/internal/jql/functions` returns the machine-readable list
(name, arg arity, return type, doc). Unknown functions and wrong
return-type/field combinations error explicitly.

| Function | Args | Returns | Meaning |
|---|---|---|---|
| `currentUser()` | — | user | The authenticated user |
| `membersOf("group")` | group name | user[] | Users in the group; unknown group → error naming it |
| `updatedBy()` / `updatedBy("user")` | optional user | user[] | Changelog authors (post-006 data only) |
| `watchers()` / `watchers(key)` | optional issue key | user[] | Watchers globally or on an issue |
| `voters()` / `voters(key)` | optional issue key | user[] | Voters globally or on an issue |
| `linkedIssues(key)` / `linkedIssues(key, "type")` | key + optional link type | issue[] | Linked issues, both directions |
| `linkedIssuesOf("type")` | link type | issue[] | Issues joined by the link type |
| `subtasksOf("jql")` | JQL | issue[] | Subtasks of matching parents |
| `parentsOf("jql")` | JQL | issue[] | Parents of matching issues |
| `epicsOf("jql")` | JQL | issue[] | Epics containing matching issues |
| `issuesInEpics("jql")` | JQL | issue[] | Issues in matching epics |
| `hasComments()` | — | issue[] | Issues with ≥1 comment |
| `currentLogin()` / `lastLogin()` / `previousLogin()` | — | date | Actor login timestamps (never-match when unrecorded) |
| `now()` | offset e.g. `-1h` | date | Current instant ± offset |
| `startOfDay()` `endOfDay()` | offset | date | Day bounds in the caller's `timeZone` |
| `startOfWeek()` `endOfWeek()` | offset | date | Week bounds |
| `startOfMonth()` `endOfMonth()` | offset | date | Month bounds |
| `openSprints()` `closedSprints()` `futureSprints()` | — | sprint[] | Sprint-state sets (sprint field only) |
| `releasedVersions()` `unreleasedVersions()` `earliestUnreleasedVersion()` `latestReleasedVersion()` | optional project | version[] | Version sets (version fields only) |

## History operators (WAS / WAS NOT / CHANGED)

Supported on Jira's history-safe fields: `status`, `priority`, `resolution`,
`assignee`, `reporter`, `fixversion`, `sprint`. Other fields error
`The operator 'WAS' is not supported by the 'x' field.`

- `status WAS "In Progress"` — issues that have or had the value (a transition
  arriving at OR departing from it counts; the current value always counts).
- `WAS NOT v` — never had v and doesn't have it now.
- With predicates (`BEFORE`/`AFTER`/`ON`/`DURING`/`BY`) the match is
  history-only: `status WAS "Done" BEFORE -1w` requires a transition
  satisfying the predicate. `FROM`/`TO` are not valid on `WAS`.
- `field CHANGED` — any change record exists (creation counts as a change,
  matching Jira's history). Predicates: `FROM v TO v BEFORE|AFTER|ON d
  DURING(d1,d2) BY user` (`BY currentUser()` works).

History reads `ChangeItem` rows — only post-006 changes are visible.

## Saved-filter subqueries

`filter = "Team triage"` inlines the saved JQL as a subquery. Share scope is
honored: `private` (owner only), `all`/`global`, `group` (`shareTarget` =
group name), `project` (project key), `projectrole` (`projectKey:roleName`).
Invisible/missing filters error as "does not exist". Circular references are
rejected at save **and** at eval (`The filter 'x' creates a circular filter
reference.`).

## Text search

`~` / `!~` compile to PostgreSQL FTS (`plainto_tsquery` on generated
`tsvector` columns, GIN-indexed) over:

- `summary` → issue summary
- `description` → description body
- `comment` → comment bodies
- `text` → all three combined

Empty `field ~ ""` is a no-op (legacy contract).

## Errors

Syntax errors return `400` with `errorMessages` positioned where parsing
stopped. `POST /rest/api/2/jql/parse` validates (syntax + field names)
without executing. Unsupported field→operator and function→field
combinations name the combination in the error.

## Visibility & scoping

- Omitting `project = K` searches across all projects visible to the token
  (`projectKeys` allow-list) or to the logged-in user.
- `key = X-1` outside the allow-list → `404` (not empty results).
- `currentUser()` resolves to the authenticated principal for session and PAT.
- Issue-security filtering (031) applies to every search: results and totals
  exclude issues the caller cannot see — including via `filter =` subqueries.

## Endpoints

- `GET|POST /rest/api/2/search` — `jql`, `startAt`, `maxResults` (≤100),
  `fields`, `expand` → `{startAt,maxResults,total,issues[]}`
- `POST /rest/api/2/jql/parse` — `{queries:[…]}` → `{queries:[{query,structure|errors}]}`
- `GET /rest/api/2/jql/autocompletedata` — field/function/reserved-word metadata
- `GET /rest/api/2/jql/autocompletedata/suggestions?fieldName=&fieldValue=` — value suggestions
- `GET /api/internal/jql/functions` — function registry (name, args, returns, doc)
- `GET/POST /rest/api/2/filter` (+ `/search`, `/my`, `/favourite`, `/:id`,
  `/:id/favourite`, `/:id/run`) — saved filters; `PUT/DELETE .../favourite` is a
  TrackForge convenience documented as a divergence; `favorite` spelling also works
- `GET|PUT /api/internal/preferences/:key` — user-scoped preferences
  (`issueTable.columns` persists navigator column choice)

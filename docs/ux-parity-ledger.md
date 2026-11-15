# UX parity ledger

Evidence for the Jira-feel audit — sprint **042** protocol
(`docs/sprints/042-ux-parity-jira-feel.md`). Every page × every dimension gets a flag;
every finding gets a disposition. GA requires: all pages audited, P0 = 0, every P1 fixed
or waived by name.

## How findings are recorded

Each row: `ID · page · dimension · flag · Jira reference · TF behavior · disposition`.

| Flag | Meaning | Disposition rule |
|---|---|---|
| **P0** | Expected function unreachable, misplaced, or wrong outcome for the same input | Fix in owning sprint — blocks GA |
| **P1** | Same outcome, different path/clicks/naming/defaults or missing muscle-memory behavior | Fix in-sprint or named waiver |
| **P2** | Cosmetic (spacing, wording, iconography, order) | Fix if trivial; else `docs/ux-backlog.md` |
| **D** | Intentional TrackForge divergence | Recorded in `docs/jira-divergences.md` with rationale |

Dimensions per page (from the 042 matrix): **Reach · Structure · Actions · Fields ·
Tables/lists · Interactions · Feedback · Density & tokens.**

Missing-feature findings (Jira has X, TF lacks X entirely) are **routed to the owning
sprint/epic or `docs/ux-backlog.md`** — never silently absorbed into the audit.

## Findings

| ID | Page | Dimension | Flag | Jira reference | TF behavior | Disposition |
|---|---|---|---|---|---|---|
| F-001 | Projects | Fields | P0 | Projects list shows each project's actual lead | Shows current user as lead on every row | **Fixed** — `listProjects` now includes `lead`; column renders real lead + "You" badge |
| F-002 | Board | Structure | P0 | Sprint name/goal/dates/days-left + Complete button above columns | Data returned, nothing rendered | **Fixed** — seed mostly stale (name/days-left/goal/Complete already rendered); added explicit `start – end` date range |
| F-003 | Backlog | Tables/lists | P0 | Backlog shows all non-done issues; closed sprints as collapsed groups | Issues vanish while a sprint is active; closed-sprint issues in no group | **Fixed** — backlog fetches all sprint states; closed sprints render as collapsed `Group`s (completeDate-sorted, chevron toggle) |
| F-004 | Navigator/Board | Tables/lists | P0 | Lists paginate to full result set | `maxResults: 200` silently clamped to 100 | **Fixed** — `fetchBoardIssues`/`fetchSprintIssues` auto-page via `total` until full set (200/page, 2000 cap); `/search` 100 cap kept (Jira Cloud parity — documented D) |
| F-005 | Issue detail | Fields | P1 | Parent field is an editable picker | Display-only; can't reparent | **Fixed** — `ParentEditor`: hover-pencil → `IssuePicker`, `fields.parent={key}|null` (Clear supported); self excluded |
| F-006 | Issue detail | Feedback | P1 | `@name` mention chips, paged comment list | Raw `[~accountId:…]` markers; no pagination | **Fixed** — mentions already resolved via `renderMentions` (seed stale); added latest-10 window + "Show N earlier comments" pager |
| F-007 | Issue detail | Feedback | P1 | History labels: "Issue Type", "Due date" | Raw field ids (`issueType`, `duedate`) | **Fixed** — `fieldLabel` map + editmeta resolves `customfield_*` names |
| F-008 | Navigator | Interactions | P1 | Basic vs Advanced (JQL) toggle; free text escaped into JQL | Text with `AND`/`OR` produces JQL errors; no toggle | **Fixed** — free text already phrase-quoted (lexer treats `"…"` opaquely); closed the real hole: `quote()` now wraps JQL-reserved field values too |
| F-009 | Issue detail | Actions | P1 | Vote/watch/flag controls; field rows visible even when empty | Controls missing; sprint row hidden when empty (vote/watch shipped 022 — re-verify) | **Fixed** — vote/watch verified live (022); Parent + Sprint rows now always render ("None" when empty) |
| F-010 | Create dialog | Fields | P1 | Assignee/labels/due/parent per issue type; subtask creation | Fields missing; no subtask create | **Fixed** — dialog gains Assignee (assignable users), Labels, Due date, Parent picker; subtask create verified live via ChildIssuesPanel (stale claim) |
| F-011 | Board/Backlog cards | Structure | P1 | Type+priority icons, points, flags, comment/attachment counts | Bare cards | **Already shipped** (013/033) — `BoardCard` has type+priority icons, SP lozenge, ⚑ flag, 💬/📎/🔗 counts, days-in-column, color edges; seed stale |
| F-012 | Nav tooltips | Feedback | P2→P0 | No stale "coming soon" copy | Stale "Coming in Sprint N" tooltips | **Fixed** — "Teams · Sprint 013" stub removed (no owning sprint → ux-backlog as feature gap); `DISABLED_LINKS` empty |
| F-013 | Global | Feedback | P2 | Jira empty states: illustration + copy style | Plain text | **Fixed** — `EmptyState` component (icon chip + title + helper copy + action); applied to navigator, Projects, Roadmap; rest swept to UB-002 |
| F-014 | Navigator | Interactions | P1 | — | Debounce `useEffect` without dep array | **Fixed** — dep array `[text, committedText]` on `IssueSearchView` text debounce |
| F-015 | TopNav | Reach | P1 | Only real destinations are enabled | Disabled items risk landing half-built stubs | **Fixed** — `DISABLED_LINKS` emptied; every rendered nav item is live |

## Navigator pass — `/projects/:key` + `/issues` (partial, code-based; live Jira render pending)

Reference: `jira.atlassian.com/projects/JRACLOUD/issues` (Jira Cloud list view).
Re-verified seeds: **F-008 partial** — Basic↔JQL toggle now exists (`switchToBasic`/`switchToJql`);
text is phrase-quoted but `AND`/`OR` inside unquoted input still needs the escape check.
**F-004 partial** — UI paginates 25/50/100 with prev/next; backend clamp behavior unverified.
**Pass complete** — all F-016–F-025 findings dispositioned (fixed, D-flagged, or routed to ux-backlog).

| ID | Page | Dimension | Flag | Jira reference | TF behavior | Disposition |
|---|---|---|---|---|---|---|
| F-016 | Navigator | Tables/lists | P2 | Cloud list default cols put Assignee/Due early, Reporter last | Defaults `T·Key·Summary·Status·Priority·Assignee·Reporter·Created·Updated`; no Due | **Fixed** — `DEFAULT_COLUMNS` → `T·Key·Summary·Status·Assignee·Due·P·Reporter·Updated` |
| F-017 | Navigator | Interactions | P1 | Status lozenge in list is a transition dropdown (inline status change) | Static lozenge — must open issue to transition | **Fixed** — `StatusTransitionMenu` in the status cell; menu portal-rendered (`fixed` at trigger rect, closes on scroll) so it isn't clipped by the table's `overflow-x` |
| F-018 | Navigator | Interactions | P1 | Assignee cell hover → inline edit (avatar + pencil) | Avatar + name, read-only | **Fixed** — `AssigneePicker` in the assignee cell (same portal fix) |
| F-019 | Navigator | Structure | P1 | Row click opens issue in right-side detail panel | Row links navigate to `/browse/:key` full page | **Fixed** — a plain row click (or j/k + Enter) opens Jira's split detail view (`view=detail`): compact issue rows + the selected issue full-fidelity (`IssueDetailView pane`) in a right pane, both columns viewport-bounded + independently scrolled. Interactive cells (key/summary links → `/browse`, status menu, assignee picker, checkbox) keep their own actions; Views ⌄ → List view returns to the full table |
| F-020 | Navigator | Structure | P1 | Filter chips ordered Type → Status → Assignee → Priority + "More filters" catch-all | Order Status → Priority → Type → Assignee; only 4 fixed selects, no More | **Fixed** — reordered to Type→Status→Assignee→Priority; "More" menu adds Resolution/Labels chips (`resolution`/`labels` params, round-trips via `buildBasicJql`/`jqlToBasic`) |
| F-021 | `/issues` global | Structure | P1 | Collapsible left saved-filters panel (starred, recent) | No filter panel — saved filters live on separate `/filters` page | **Fixed** — `SearchPage` gains sticky collapsible panel (Starred + My filters, active-filter highlight, Manage link → `/filters`, `localStorage`-persisted) |
| F-022 | Global | Density & tokens | P2 | Single-generation ADS palette | Mixed generations: neutral ramp is legacy (`#6B778C`, `#DFE1E6`) while accents/lozenges are current (`#0C66E4`, `#44546F`) | → `docs/ux-backlog.md` (sub-perceptual; sweep scheduled, not blocking) |
| F-023 | Navigator | Fields | P2 | Empty fields render blank (never literal "Unresolved") | Resolution column prints literal `Unresolved` | **Fixed** — renders `—` when unset (duedate convention) |
| F-024 | Navigator | Fields | P2 | Priority cell = icon only (classic) — verify cloud | Icon + text name ("High ↑") | **Fixed** — icon-only cell + `title` tooltip; icon keeps `role="img"`/`aria-label` so the name stays accessible |
| F-025 | TopNav | Reach | P2 | Jira Cloud order: Your work · Projects · Filters · Dashboards | Dashboards before Filters | **Fixed** — swapped `FiltersMenu`/`DashboardsMenu` to Jira order (found in global pass) |

## Full-product pass (code-based, all routes — this session)

Subagent sweep across the page inventory × 8 dimensions. Two P0 dead-ends found and fixed same-session; P1s fixed where they're misplacements, routed where they're features (US3.3).

| ID | Page | Dimension | Flag | Jira reference | TF behavior | Disposition |
|---|---|---|---|---|---|---|
| F-026 | Board | Reach | P0 | "Board settings" reachable from board header | Link → `/projects/:key/settings/board` but route is `board/settings` → blank outlet | **Fixed** — corrected to `/projects/:key/board/settings` |
| F-027 | Issue detail | Actions | P0 | Clone/Move land on the new issue | Navigate → `/issues/KEY` — matches no route → blank page | **Fixed** — both → `/browse/:key` |
| F-028 | Releases | Interactions | P1 | Version issue links open the issue | `?selected=KEY` param the navigator ignores | **Fixed** — links → `/browse/:key` |
| F-029 | Transition dialog | Fields | P1 | Assignee screen field renders a user picker | Editor offers `assignee` in screen fields; modal renders only resolution+comment | **Fixed** — modal renders assignee select (`searchAssignableUsers`, `projectKey` threaded through `StatusTransitionMenu`) |
| F-030 | Create dialog | Interactions | P1 | "Create another" checkbox keeps dialog open | Always closed + navigated | **Fixed** — checkbox + "Created KEY…" link trail, fields retained except summary/description |
| F-031 | Backlog | Interactions | P1 | Inline create has a type selector | Hardcoded `issueTypeName:'Story'` | **Fixed** — type dropdown (non-subtask types) beside the input |
| F-032 | `/settings/*` | Reach | P1 | Workflow/field/webhook admin inside admin console | Routes outside `AdminLayout` — sidebar vanishes mid-session | **Fixed** — moved inside `AdminLayout`/`RequireAdmin` (all inbound links already admin-gated) |
| F-033 | Issue detail | Fields | P1 | Server/DC view issue: field grid (Type/Priority/Status/Resolution/versions/Components/Labels/CFs) heads the center column; rail = People → Dates → Agile → Time tracking; status dropdown under the summary; collapsible modules; Votes/Watchers inside People | All fields sat in one flat right-rail box (Cloud-style) | **Fixed** — center-column Details grid + People/Dates/Agile rail boxes (all collapsible, plus Description/Linked issues), status transition dropdown in the opsbar under the summary, Votes/Watchers rows inside People, issue-level Export ⌄, `ProjectSidebar` kept on `/browse` (Jira shows project nav on the issue view). Extracted as `IssueDetailView` — shared by `/browse` and the navigator detail pane |
| F-034 | Your work | Structure | P1 | Tabbed lists (Worked on/Viewed/Assigned) + recent-projects rail | Stacked sections, no tabs/rail/"Worked on" | → `docs/ux-backlog.md` (UB-011 — structural restructure) |
| F-035 | Projects | Tables/lists | P1 | ★ favorite column + row ⋯ menu | Name·Key·Type·Lead only | → `docs/ux-backlog.md` (UB-012 — needs project-favorite storage = feature) |
| F-036 | Backlog | Structure | P1 | Right-side epic panel (drag issues onto epics) | No epic panel | → `docs/ux-backlog.md` (UB-013 — feature, owning epic: backlog) |
| F-037 | Backlog | Interactions | P1 | Row right-click context menu (send to sprint/top, assign…) | Header toolbar only | → `docs/ux-backlog.md` (UB-014 — feature) |
| F-038 | Issue detail | Interactions | P1 | `e` opens full edit screen | `e` focuses summary inline-edit | **D** — TF's model is pervasive inline edit; `e` enters the primary field. A modal edit screen is redundant (recorded D-013) |
| F-039 | Issue detail | Actions | P1 | ⋯ menu ~10 items incl. Flag, Link, Convert to subtask | Clone·Move·Delete only | → `docs/ux-backlog.md` (UB-015 — flag/convert are features; link exists in LinkedIssuesPanel) |
| F-040 | Filters | Actions | P1 | Row ⋯ = Edit/Copy/Delete/Change owner | Delete only | → `docs/ux-backlog.md` (UB-016 — copy/edit = features) |
| F-041 | Workflows | Actions | P1 | Add/Copy/Delete workflows, diagram/text views | Edit link only; table-only editor | → `docs/ux-backlog.md` (UB-017 — workflow authoring + diagram editor = feature epic) |
| F-042 | Board | Actions | P1 | Header search box + member-avatar quick filters | Neither | → `docs/ux-backlog.md` (UB-018 — board-scoped search/person-filter = feature) |

P2 tail (logged, routed to `docs/ux-backlog.md` UB-010 batch): login has no reset/remember row; Your-work rows lack type icons + thin "recently viewed"; board settings lacks Min-WIP input + section nav; backlog rows lack epic badge; releases/components use exposed buttons vs ⋯ menus; components field order + unlinked issue count; several `window.confirm` deletes vs styled modals; legacy-hex literals in YourWork/WatchButton/ProjectSettings/CustomFields (folds into UB-003 token sweep). All cosmetic-order P2, none blocking.

## Page inventory — audit checklist

Routes from `apps/frontend/src/App.tsx` (+ dialogs/panels under each). State:
`pending` · `in-progress` · `audited` · `deferred:<sprint>`.

| Route | Jira counterpart | State | Notes |
|---|---|---|---|
| `/login` | Jira login | audited | P2: no reset/remember (UB-010); D: email-as-username |
| `/` · `/your-work` | Your work | audited | F-034 tabs/rail → UB-011; P2 icons/density |
| `/projects` | Projects list | audited | F-001; F-035 star/actions → UB-012 |
| `/projects/:key` (summary) | Project summary | audited | 058 US7 — five-widget landing (status rollup, activity, priority, versions, agents); navigator now under List nav item |
| `/projects/:key/board` | Board | audited | F-002, F-011, F-026, F-042 |
| `/projects/:key/board/settings` | Board settings | audited | F-026 fixed; P2 Min-WIP/section-nav (UB-010) |
| `/projects/:key/backlog` | Backlog | audited | F-003, F-011, F-031, F-036, F-037 |
| `/projects/:key/reports` | Reports hub | deferred:027/028 | stub until owning sprints |
| `/projects/:key/releases` | Releases | audited | F-028 fixed; P2 actions-menu/empty (UB-010) |
| `/projects/:key/components` | Components | audited | P2 field-order/actions (UB-010) |
| `/projects/:key/settings` | Project settings | audited | P1 section-nav → UB-010; D agent-guidance |
| `/browse/:issueKey` | Issue detail + clone/move/link/watch/vote dialogs | audited | F-005–007, F-009, F-027, F-033, F-038, F-039 |
| `/issues` (search) | Navigator | audited | F-021 panel shipped |
| `/filters` | Filters (manage/search/favourites) | audited | F-040 → UB-016; P2 window.confirm |
| `/settings/workflows` · `/:workflowId` | Workflow admin + editor | audited | F-032 shell fix; F-041 → UB-017 |
| `/settings/customfields` | Custom field admin | audited | F-032 shell fix; P2 wizard/textarea (UB-010) |
| `/settings/webhooks` | Webhook admin | audited | F-032 shell fix; vs design-system (D-surface) |
| `/settings/ai` | — (TF-native) | audited→D | design-system check only |
| `/admin/*` (incl. migration) | Jira admin console | audited→D | shell conformant; `/admin/migration` TF-native |
| `/approvals` | — (TF-native proposals) | audited→D | batch-triage inbox only — removed from primary nav; pending proposals review inline on `/browse/:key` (Pending approvals panel) and surface as a banner on `/` |
| Command palette (`Ctrl+K`) | Cloud quick-search | audited→D | 058 US3 — deterministic local commands + copilot in one box (D-015) |
| Issue drawer (`?selectedIssue=`) | Cloud board/backlog panel | audited | 058 US1 — slide-over `IssueDetailView` pane, focus trap, Escape/click-away, modifier-click→`/browse` (D-014) |
| Create-issue dialog | Jira create dialog | audited | F-010, F-030; P2 field order (UB-010) |
| Transition dialogs | Jira transition screens | audited | F-029 fixed |

## Score (updated per pass)

- Pages audited: **21 / 21 routes** (reports deferred:027/028 by ledger convention)
- Findings: P0 **0 open** (2 found → fixed F-026, F-027) · P1 **0 open** (9 fixed, 8 routed to ux-backlog w/ named UB entries) · P2 batch → UB-010 · D **13**
- Seeded items resolved: **15 / 15** (several seeds were stale — verified shipped; dispositions above name the fix or the verification)
- Waiver budget used: **0 / 5** — every P1 is fixed or routed by name

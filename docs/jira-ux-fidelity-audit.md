# Jira UX Fidelity Audit — TrackForge frontend

Deep page-by-page audit of `apps/frontend` against Jira (Cloud/Server visual
language). Method: full source audit of routes/components/tokens + live
computed-style probe of 26 routes at 1440×900 (Playwright, `probe-ui.mjs`) +
Atlassian Design System / Jira navigation research.

**Reference baseline.** Two Jira generations exist:

- *Classic* (pre-Aug-2025 Jira Cloud / Jira Server ≤10.1): 48px dark top bar
  with product links (Your work, Projects, Filters, Dashboards…), collapsible
  left sidebar, white content, ADS classic palette.
- *New navigation* (Jira Cloud since Aug 2025 — cannot be disabled — and
  Jira 10.2+): simplified top bar (Search + Create only), customizable global
  left sidebar, **project navigation moved to horizontal tabs**, refreshed
  color scales/iconography/typography.

TrackForge matches **classic** Jira almost everywhere. Every "nav model"
finding below is therefore a *generation* decision, not a bug — but it must
be a deliberate one.

Severity: **P0** broken/unreachable · **P1** same outcome, wrong path/missing
muscle-memory · **P2** cosmetic · **D** intentional TrackForge divergence.

---

## 1. Global chrome

| # | Finding | Sev | Detail |
|---|---------|-----|--------|
| G-01 | Top nav model is pre-2025 Jira | P1/D | TopNav keeps Your work/Projects/Filters/Dashboards/Teams/Approvals as top-bar links. Current Jira moved these into a collapsible global sidebar and uses horizontal project tabs. TrackForge has no global sidebar at all — project routes get a 240px left nav, global routes get none. Decide target generation and record it. |
| G-02 | Top bar itself matches classic Jira | ✓ | Computed: `background #1D2125`, height 48px, white text, no bottom border — matches classic Jira top bar. Search + blue Create + bell + help + avatar present. |
| G-03 | Copilot/Approvals in top bar | D | `✨`-style copilot button and Approvals link have no Jira equivalent — intentional (AI-native product). Approvals resembles JSM approvals; acceptable as D if documented. |
| G-04 | Favicon broken | P2 | `index.html` references `/vite.svg`; no `public/` asset exists — Vite SPA fallback serves HTML, so the tab icon is blank/broken. Needs a real TrackForge/Jira-style icon. |
| G-05 | Page title "TrackForge" on every route | P2 | No per-page `<title>` updates; Jira sets e.g. "SCRUM-1 Summary – Jira". |
| G-06 | Console error on every page | P2 | `CommandPalette.tsx:98` — `useQuery({queryKey:['ai-progress','plan'], staleTime:Infinity})` has no `queryFn`; TanStack logs "No queryFn was passed" 4×/page. Works (cache seeded via SSE `setQueryData`) but spams console — use a `queryFn: () => null` or `placeholderData` pattern. |
| G-07 | `/api/internal/me` 404 ×2 every page | **P0/P1** | `client.ts:2193` calls `request('/api/internal/me')` but `request()` defaults base to `/rest/api/2` → fetches `/rest/api/2/api/internal/me` → 404. 13 call sites affected (lines 2193–2237): **me/profile, sessions, password, TOTP, grants, IdPs, issue `/development`**. Profile page data, session management, 2FA, and the issue Development panel are all silently broken. Fix: pass `'/api/internal'` as base (pattern already used at lines 1864/1906). |
| G-08 | Rate limit → bounced to /login | P1 | Probe of 26 routes tripped the API rate limiter (429s); the app then landed on `/login` — an auth-gated query failing under 429 appears to be treated as logged-out. Normal browsing bursts shouldn't log you out. Verify `RequireAuth`/401-vs-429 handling. |
| G-09 | Token generation drift | P2/D | TrackForge uses **classic** ADS values (`#0C66E4` blue-300, `#172B4D` text, `#DFE1E6` border, `#0055CC`-family links). The 2024+ ADS refresh uses `#0052CC` brand, `#292A2E` text, `#505258` subtle, softer borders. Visually near-identical but not exact — pick one generation, document it in `docs/design-system.md`. |
| G-10 | Emoji/unicode icons vs SVG icon set | P2 | `BoardCard` uses `⚑ 💬 📎 🔗` glyphs; scattered `★ ⚙ ✕ ✓` etc. across pages (20 files). Jira uses a consistent outlined SVG set (atlassian-icon). Emoji render differently per-OS and break visual parity. Replace with inline SVGs like `IssueTypeIcon`/`PriorityIcon`. |
| G-11 | Raw hex outside `palette.ts`/`tailwind.config.js` | P2 | ~15 files contain `#xxxxxx` literals (Reports, WorkflowDiagram, Dashboards, AdminOrg, System, Roadmap, IssueDetail, YourWork, Webhooks, Migration, BoardSettings, ProjectSettings…). Violates the design-system rule "no raw hex elsewhere"; some may also drift from tokens. |
| G-12 | Heading scale inconsistent | P2 | Measured h1 sizes: Your work 24px · board/backlog/reports/issues/filters/teams/automation 18px · releases/components/settings/dashboards 20px · roadmap **16px** · issue detail 24px. Jira uses a consistent page-title size (~20–24px semibold). Standardize (e.g. `text-xl`/`text-2xl` page header component). |
| G-13 | Sidebar widths/backgrounds inconsistent | P2 | Project sidebar 240px white · dashboards sidebar **224px `#FAFBFC` (sunken)** · Your-work rail 260px. Jira sidebars are uniformly ~240px white (classic) — harmonize width + surface. |
| G-14 | Font stack ✓ | ✓ | `-apple-system, Segoe UI, Roboto…` = Atlassian font stack; body color `#172B4D`; body bg white. Matches. |

## 2. Page-by-page

Legend per row: **Match** = close to Jira · findings listed are deltas.

### Global / "For you" area

| Route | Jira equivalent | Verdict | Mismatches |
|---|---|---|---|
| `/` Your work | Jira *For you* / *Your work* | Close | Tabs (Worked on/Viewed/Assigned/Watching/Reported) ≈ Jira's; right rail 260px "Recent projects" vs Jira's starred/recent lists — P2 icon/density diffs (ledger). h1 24px ✓. |
| `/projects` | Jira *Projects* | Close | Compact table (search/star/lead/type/key) matches Jira's project list; star + row-action affordances differ — P2 (ledger). |
| `/issues` | Jira *All work* / search | Close | Basic+JQL modes, saved filters, quick toggles, grouping, subtask nesting, bulk select, sort, export — strong match. JQL editor has autocomplete + NL→JQL (D: AI). Jira search uses filter chips/drawer more than a persistent toolbar — P2. |
| `/filters` | Jira *Filters* | Close | Manage-filters table; confirmation/share/owner UX differs — P2 (ledger). |
| `/teams` | Jira *Teams* (Premium) | Partial | Exists; Jira teams feed board assignee pickers — verify member-picker integration — P2/D. |
| `/dashboards` | Jira *Dashboards* | Partial | List + detail exist; detail uses 224px sunken sidebar vs Jira's gadget grid w/o sidebar — P2 (G-13). Dashboard gadgets coverage vs Jira's set — P1 gap (fewer gadgets). |
| `/docs/*` | — | D | TrackForge docs surface; no Jira equivalent. |

### Project area (`/projects/:key/*`)

| Route | Jira equivalent | Verdict | Mismatches |
|---|---|---|---|
| `/:key` (List) | Jira *List* view | Close | Reuses IssueSearchView — columns, inline edit, bulk bar match Jira list. |
| `/:key/board` | Jira *Board* | Close | Columns/swimlanes/drag-drop/WIP limits/card chips ✓. Known gaps: card context menus, quick filters, board header search/member filters → UB-018 (P1). Emoji glyphs on cards (G-10). |
| `/:key/board/settings` | Jira *Configure board* | Close | Columns/swimlanes/quick-filters sections; min-WIP input + section-nav gaps — P2 (ledger). |
| `/:key/backlog` | Jira *Backlog* | Close | Sprint groups, drag/rank, points, epics panel, inline create, sprint controls ✓. Epic badge/density P2 (ledger). |
| `/:key/roadmap` | Jira *Advanced Roadmaps* (Premium) / Plans | D | Not in standard Jira; TrackForge-native timeline — h1 only 16px (G-12). |
| `/:key/reports` | Jira *Reports* | Partial | Report set deferred to sprints 027/028 — P1 coverage gap (ledger). h1 18px ✓-ish. |
| `/:key/releases` | Jira *Versions* (project settings / backlog report) | D/P2 | No dedicated Jira "Releases" page — version cards + release notes is TrackForge's own surface; actions as buttons vs Jira row-menus — P2 (ledger). h1 20px (G-12). |
| `/:key/components` | Jira *Components* (project admin) | D/P2 | Dedicated page vs Jira's settings-table — P2 (ledger). |
| `/:key/automation` | Jira *Project automation* | Partial | Rule list/builder exists but simpler than Jira's automation UI (triggers/conditions/actions palette, rule templates) — P1 depth gap. |
| `/:key/settings` | Jira *Project settings* | Partial | **Missing Jira-style left section nav** (Details/Access/Notifications/Issue types/Workflows…) — single long page instead — P1 (ledger). |

### Issue detail (`/browse/:key`)

| Jira equivalent | Verdict | Mismatches |
|---|---|---|
| Jira *Issue view* | Close | Breadcrumbs, inline summary, status lozenge + transition menu, assignee/priority/resolution/parent/sprint/points/custom fields, activity + comments, attachments/links/children/time tracking — strong match. TrackForge adds agent sessions + development panel (D) — **but `/development` endpoint 404s today (G-07)** so that panel is broken. Jira's issue header has a compact action row (watch/star/flag/share) — verify ordering — P2. |

### Admin (`/admin/*`, `/settings/*`)

| Route | Jira equivalent | Verdict | Mismatches |
|---|---|---|---|
| `/admin/users` etc. | Jira *Administration* | Close | 240px grouped sidebar (User management/Security/Configuration/System) ≈ Jira admin nav. F-032 fixed: settings moved inside AdminLayout ✓. |
| `/settings/workflows` | Jira *Workflows* admin | Partial | Full diagram authoring routed to UB-017 — P1 (ledger). |
| `/settings/customfields` | Jira *Custom fields* | Partial | Wizard/textarea differences — P2 (ledger). |
| `/settings/webhooks` | Jira *Webhooks* | Close-ish | Jira webhooks live under admin apps/integrations; layout fine — P2. |

### Auth & TrackForge-native

| Route | Verdict | Notes |
|---|---|---|
| `/login` | Partial | Centered card ≈ Jira login. **Missing "Can't log in?" reset-password flow** — P1. Check remember-me parity — P2. |
| `/profile` | Partial | **Broken data today** — all `/api/internal/me/*` calls 404 (G-07): profile, sessions, password change, TOTP/2FA, grants, IdPs all fail. |
| `/approvals` | D | TrackForge-native (JSM-flavored). |
| `/settings/ai` | D | TrackForge-native AI config. |
| Command palette (⌘K) | D | Jira has quick-search/issue-navigator; TrackForge's palette is copilot-first — acceptable D, but palette also does issue/project nav so it partially fills Jira's "issue navigator" role — P2 overlap. |

## 3. Rendering verification (live, 1440×900)

- All 26 probed routes render HTTP 200 with **no horizontal overflow**.
- Header/body tokens consistent everywhere (G-02, G-14 ✓).
- Sidebar present only inside project routes — global routes have none (G-01).
- Defects observed live: G-06 console spam, G-07 404s, G-08 429→login.

## 4. Top actions (ordered by impact)

1. **G-07** — fix `request('/api/internal/…')` base arg (13 sites) — un-breaks profile/security/development panel. *Bug, not parity.*
2. **G-08** — stop 429s from bouncing to /login. *Bug.*
3. **G-01** — decide classic-vs-new Jira nav target; if new nav, this is the largest structural gap (global sidebar + horizontal project tabs).
4. **G-10/G-11** — replace emoji glyphs + raw hex with the SVG icon set and tokens.
5. **G-12/G-13** — standardize page-title size and sidebar width/surface.
6. P1 feature gaps already routed: project-settings section nav, board quick-filters/card menus (UB-018), workflow diagram (UB-017), reports coverage (027/028), automation depth, login reset flow.
7. P2 polish: favicon, per-page titles, JQL/search toolbar layout, dashboard gadget parity.

---

## 5. Implementation status (post-audit pass)

**Fixed and verified live** (Playwright re-probe: 0 HTTP errors, 0 console errors on sampled routes):

- **G-07** — all 13 `request('/api/internal/…')` sites now pass `'/api/internal'` base (`client.ts` ~2192–2250). `/me`, sessions, password, TOTP, grants, IdPs, issue `/development` all return 200. Added `requestPasswordReset`/`confirmPasswordReset` for the reset flow.
- **G-06** — `CommandPalette` ai-progress query now `queryFn: () => null, enabled: false` (cache-only, no fetch, no warning).
- **G-08** — `RequireAuth` only redirects on 401/403; 429/5xx/network show a retry screen instead of logging out.
- **G-04** — real `public/favicon.svg` (TF mark, atl blue) + `index.html` updated.
- **G-05** — `lib/pageTitle.ts` route→title map wired in `App.tsx`; titles like `SCRUM-1 - TrackForge`, `Board - TrackForge`.
- **G-10** — new `components/icons.tsx` SVG set (flag/comment/attachment/link/star/close/pencil/check/cross/people/person/gear/sparkle/more); replaced emoji+unicode glyphs in BoardCard, ProjectsPage, IssueDetailPage, BacklogPage, BoardSettingsPage, DashboardsPage, ProjectSettingsPage, WorkflowEditorPage, CustomFields, EntityRefPicker, BulkWizard, IssueActionsMenu (⋯ kept — matches Jira).
- **G-11** — all raw hex outside `palette.ts`/`index.css` eliminated: new `SVG`, `CHART`, `PROJECT_SWATCHES` exports; arbitrary-value classes swapped to tokens (`text-atl-n-70`, `bg-atl-n-10/20`, `text-atl-p-700` — new p-700 token added); SystemPage now uses `--tf-*` vars defined in `index.css`.
- **G-12** — h1 scale normalized: app pages `text-xl font-semibold` (20px), Your work/issue detail 24px semibold.
- **G-13** — dashboards sidebar 224px/sunken → 240px white (matches project sidebar).
- **P1 login reset** — "Can't log in?" → reset-request → reset-confirm flow on LoginPage (uses existing `/auth/reset-*` endpoints; token delivered by email, `x-reset-token` header prefill in non-prod).
- **P1 project settings nav** — left section nav (Details/People/Schemes/Workflow/Danger zone, admin-gated) with panel switching, Jira-style.
- **P1 board card menu (UB-018 partial)** — hover `⋯` menu on board cards reusing `IssueActionsMenu` (new `compact` mode): flag/link/clone/move/delete/convert. Quick filters were already implemented.
- **P1 workflow diagram (UB-017 partial)** — diagram view now supports add-status/add-transition (shared controls with table view); full drag-drop edge editing remains future work.

**Deferred / remaining:**

- **G-01** — kept classic Jira nav per decision; new-navigation rebuild not attempted.
- **G-09** — kept classic ADS token generation (documented; new-ADS refresh is a separate migration).
- **Automation depth** — rule editor is JSON+schema-hints; Jira-style visual WHEN/IF/THEN builder remains a sprint item.
- **Reports** — page already covers epic/version/burndown/CFD/control/created-resolved/workload; residual Jira report gaps (if any) stay with sprints 027/028.
- **Workflow diagram** — visual edge editing (drag transitions, click-to-edit properties) still open under UB-017.

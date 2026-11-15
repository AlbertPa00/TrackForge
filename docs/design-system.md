# Design System Plan

Single source of truth for the TrackForge visual language, aligned to the
current Atlassian Design System (ADS). Ratified by roadmap decision **D3**
and Constitution principle V.

## Token layer

Two files, no raw hex elsewhere:

| File | Owns |
|---|---|
| `apps/frontend/tailwind.config.js` | `atl-n-*` neutral ramp, `atl-b-*` brand blues, `atl-{g,y,r,p,t}-*` semantic, `atl-inverse`, `atl-card`, `atl-lozenge-{new,progress,done}` |
| `apps/frontend/src/lib/palette.ts` | `ACCENT` hexes for SVG `fill`/`stroke` props (icons, avatars) — JS-only, mirrors token values |

**Rule (lint-enforceable later)**: no `#xxxxxx` literals in `src/**/*.tsx`
outside `lib/palette.ts`.

Key tokens: brand `#0C66E4` (resting) / `#0055CC` (hover) / `#0049B0`
(pressed); top-nav `#1D2125`; card bg `#F1F2F4`; link `#0C66E4`;
selected bg `#E9F2FF`.

## Implemented components

| Component | File | Jira parity |
|---|---|---|
| TopNav | `components/TopNav.tsx` | ✅ dark bar, disabled items honest (aria-disabled + sprint tooltips), working global search |
| ProjectSidebar | `components/ProjectSidebar.tsx` | ✅ project avatar, Planning group, disabled items, active-item override |
| IssueTable | `components/IssueTable.tsx` | ✅ full column set, sortable Key/Created/Updated, date tooltips |
| StatusLozenge | `components/StatusLozenge.tsx` | ✅ category colors |
| IssueTypeIcon / PriorityIcon / UserAvatar | `components/*` | ✅ inline SVG |
| BoardColumn / BoardCard | `components/Board*.tsx` | ✅ drag-and-drop, empty-column placeholder |
| CreateIssueDialog / CreateProjectDialog | `components/*Dialog.tsx` | ✅ Jira modal pattern |
| StatusTransitionMenu | `components/StatusTransitionMenu.tsx` | ✅ lozenge dropdown |
| BacklogPage / BoardPage / List / Projects / IssueDetail | `pages/*` | ✅ |
| LoginPage | `pages/LoginPage.tsx` | ✅ centered card, `?next=` redirect |
| RequireAuth | `components/RequireAuth.tsx` | ✅ route gate → `/login?next=` |
| UserMenu | in `TopNav.tsx` | ✅ identity card + Log out |
| AssigneePicker | `components/AssigneePicker.tsx` | ✅ search dropdown, "Assign to me", "Unassigned" |
| InlineEdit | `components/InlineEdit.tsx` | ✅ click→edit, Enter/blur saves, Esc cancels, `e` shortcut, `startEditing` re-trigger |
| Markdown / MarkdownEditor | `components/Markdown.tsx` | ✅ marked + DOMPurify; `.tf-markdown` scoped typography |
| LabelsEditor | `components/LabelsEditor.tsx` | ✅ chips + `/label` suggestions |
| ActivitySection | `components/ActivitySection.tsx` | ✅ All/Comments/History tabs, mention composer, interleaved feed |
| ChildIssuesPanel | `components/ChildIssuesPanel.tsx` | ✅ progress bar + inline create (subtask or epic child) |
| LinkedIssuesPanel | `components/LinkedIssuesPanel.tsx` | ✅ grouped by relationship, add/remove |
| IssueActionsMenu | `components/IssueActionsMenu.tsx` | ✅ ⋯ menu, delete via preview → confirm modal |

## Missing components → owning sprint

| Component | Sprint | Notes |
|---|---|---|
| `DropdownMenu` primitive (general ⋯ menus on cards/rows) | 009 | IssueActionsMenu exists; generalize for card/sprint menus |
| `Tooltip` primitive | when needed | currently `title=`; formalize when needed |
| `Modal` primitive | exists (`components/Modal.tsx`) | used by create/delete/settings dialogs |
| `BoardColumnMenu` (column settings) | 009 | WIP limits, column→status mapping UI |
| `SwimlaneHeader` | 009 | |
| `WorkflowEditor` (status→transition graph) | 009 | largest UI in roadmap |
| `JqlInput` (autocomplete: fields, operators, values) | 010 | drives "Filters" nav item live |
| `DatePicker` | 013 | sprint start/complete dialogs |
| `RankDragHandle` + multi-select rows | 013 | ranked backlog |
| `SprintHeader` (goal, dates, complete button) | 013 | upgrade of current BacklogPage groups |
| `BurndownChart` / `VelocityChart` | 013 | SVG, no chart lib |
| `EpicPanel` (backlog epic column) | 013 | epic colors from `ACCENT` ramp |
| `Toast` notifications | 009+ | action feedback; inline errors today |
| `CfSelect`/`CfMultiSelect`/`CfUserPicker`/`CfCascading` | 014 | `InlineEdit` variants per CF type |
| `SchemeGrantTable` (permission/security) | 015/031 | grantee-type rows: role/group/user/reporter/lead |
| `AdminShell` + `DataTable` admin pattern | 021 | users/groups/tokens/audit/metadata editors |
| `AttachmentPanel` (drag-drop grid + lightbox) | 018 | thumbnails + file icons |
| `BulkBar` + `BulkWizard` (3-step) | 023 | selection → op → field map → preview → results |
| `LogWorkDialog` + `TimeTrackingPanel` | 024 | §13.1/13.2 progress + auto-adjust |
| `VersionPicker`/`ComponentPicker` + `ReleasePage` | 019 | release hub UI |
| `ChartKit` (line/bar/pie/donut/stacked/scatter SVG) | 026 | shared by gadgets + reports (D14) |
| `DashboardGrid` + `GadgetFrame` + config forms | 026 | 2-3 col layout, refresh intervals |
| `ReportPage` skeleton (params + chart + export) | 027 | one frame, N report bodies |
| `NotificationSchemeEditor` + `PrefsForm` | 029/036 | event×channel matrix, user toggles |
| `FieldConfigEditor` + `ScreenSchemeEditor` | 031 | scheme-layer admin tables |
| `QuickFilterChips` + `BoardSwitcher` | 033 | multi-board + JQL snippets |
| `ColumnChooser` + `GroupByHeader` | 010/033 | chooser in 010; CF columns/group-by in 033 |
| `RuleBuilder` (trigger→condition→action chain) | 034 | Jira-style automation editor |
| `DevPanel` (branches/PRs/commits/builds) | 038 | dev-status sections |
| `ProfilePage` + `SecuritySection` (2FA/sessions) | 036 | identity self-service |
| `MigrationWizard` (source→map→dry-run→import→report) | 017/039 | §20.9 flow; 039 adds XML/CSV sources |
| `TimelineGrid` (epic bars, zoom, pins, deps) | 041 | roadmap view |

## View-level gaps vs Jira

| View | Gap | Sprint |
|---|---|---|
| Issue detail | editable fields, comments, links, subtasks all live (008); attachments/watchers/votes/flags/dev-panel remain | 011/018/022/038 |
| Board | no card menus, quick filters, swimlanes beyond assignee/epic, column config | 009/033 |
| Backlog | no drag-ranking, sprint header detail, epic panel, estimation | 013 |
| List | no column chooser, group-by, bulk ops | 010/023/033 |
| TopNav | Filters/Dashboards need real pages | 010/011/026 |
| Project settings | schemes/roles/components/versions tabs | 019/021/031 |
| `/admin` | entire console absent | 021 |

## Conventions

- **Disabled controls**: reduced contrast, `cursor-not-allowed`,
  `aria-disabled="true"`, tooltip naming the delivering sprint. Never render
  an enabled control with no behavior (FR-002).
- **Dialogs**: centered modal, dim backdrop, header/body/footer, primary
  action bottom-right `bg-atl-b-300`.
- **Density**: table rows `py-2`, 13–14px text; Jira compact feel, not airy.
- **Icons**: inline SVG from `palette.ts` colors; a real icon set (Lucide)
  only if a sprint needs >10 new glyphs.
- **Dates**: `formatDate` in tables (short), `formatDateTime` on `title=`
  tooltip.
- **Links**: `text-atl-b-300`, underline on hover.
- **Empty states**: dashed border box + 1-line guidance + CTA when relevant.

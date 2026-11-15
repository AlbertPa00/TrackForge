# Sprint 042 — UX Parity Audit & Jira-Feel

| | |
|---|---|
| **Status** | In progress — protocol + ledger + divergences doc shipped; DoD checklist item landed (roadmap §4); **all 15 seeded findings resolved**; navigator findings F-016–F-025 fixed/D-flagged; **full route × 8-dimension sweep complete** (21/21 routes ledgered — 2 P0 dead-end navs fixed, 9 P1s fixed, 8 routed to ux-backlog w/ named UB entries, P2 tail → UB-010); DOM parity guards landed (`tests/unit/parity.test.tsx` — nav order, column set/order, filter-chip order, icon-only priority, empty-state convention). Remaining: fresh-eyes SC-002 (needs human Jira-fluent user) |
| **Milestone** | M5 Enterprise & reach — last feature sprint before GA |
| **Theme** | Feel parity: a user fluent in Jira must switch to TrackForge with zero re-learning |
| **Depends on** | All UI-bearing sprints through 041 |
| **Unblocks** | GA (046) — the gate requires a clean audit ledger |
| **Spec-kit folder** | `specs/042-ux-parity-jira-feel/` |

> **Why it exists:** every prior sprint copies Jira's *functionality*; nobody owns "does it sit
> where a Jira user expects, say what Jira says, and move like Jira moves". The earlier code
> review already produced ~15 concrete friction findings — they are seeded below as US5. The
> audit then systematically finds the rest, flags each, and the sprint fixes the flagged items.
>
> **Adopted early:** the protocol in §"Audit protocol" is also a checklist appended to the
> common DoD (roadmap §4), so pages built in earlier sprints are audited at build time; this
> sprint is the full-product pass, not the first pass.

## Goal

Run a systematic page-by-page review against Jira Cloud (the migration source users come
from), flag every mismatch, and fix the ones that create friction — so the product is not
just feature-equivalent but *placement-equivalent*.

## Audit protocol (fixed)

### Severity ladder — how every finding is flagged

| Flag | Meaning | Disposition |
|---|---|---|
| **P0 Blocker** | A function a Jira user expects is unreachable, misplaced, or behaves differently with the same input (wrong outcome). | **Must fix in this sprint** — blocks GA |
| **P1 Friction** | Same outcome but a different path, extra clicks, different naming/order/defaults, missing hover/focus/keyboard behavior a Jira user has muscle memory for. | Fix in-sprint; wave-5 planning may waive ≤5 documented items to a named follow-up |
| **P2 Polish** | Cosmetic: spacing, wording, iconography, minor order. | Fix if trivial; else appended to `docs/ux-backlog.md` |
| **D Divergence** | Intentional TrackForge choice (markdown preview, `api/internal`, agent features). | Recorded in `docs/jira-divergences.md` — a decision, not a bug |

### Audit matrix — every route × every dimension

Each audited view is checked against these dimensions, in order:

1. **Reach**: can a Jira user get here the way they expect (nav, sidebar, shortcut, URL shape)?
2. **Structure**: page regions match Jira's layout (header content, main column, right rail, footer) and the same visual hierarchy.
3. **Actions**: primary buttons, "…" menus and their item order, wording, separators, destructive-item placement.
4. **Fields**: order, labels, inline-edit affordance, empty-value presentation ("None", "-" — Jira's conventions).
5. **Tables/lists**: default column set + order, sort affordances, hover rows, selection model.
6. **Interactions**: inline edit (click vs `e`), dialogs, drag patterns, keyboard shortcuts (037 set), focus management.
7. **Feedback**: toasts vs inline errors, confirmation patterns, loading skeletons, empty states (Jira's copy style), error copy.
8. **Density & tokens**: spacing, font sizes, icon set against `docs/design-system.md`.

### Page inventory (audit scope — each row is an audit pass)

| Area | Pages/routes | Added in |
|---|---|---|
| Entry | Login, password reset, SSO entry, 2FA challenge | 002/036 |
| Home | Projects, Your work, global search, command palette | 001/011/012 |
| Issue work | Navigator (list + JQL), Board, Backlog, Issue detail, Create/edit dialogs, Transition dialogs | 003/004/008/009/010/013 |
| Project config | Settings (general, people, fields, screens, issue types, security), Components, Versions/Releases | 008/015/019/021/031 |
| Planning | Roadmap/timeline | 041 |
| Insight | Dashboards (view/edit), Reports hub + each report, Filters | 010/026–028 |
| Administration | `/admin` (users, groups, tokens, audit, metadata, mail, jobs, migration wizard, IdPs, rules) | 016/017/021/029/034/036/039 |
| Integrations | Issue dev panel, automation rule builder | 034/038 |
| Self | Profile, preferences, sessions | 036 |

## User stories

### US1 — Audit passes (P1)

As a reviewer, I want each page compared against the same-area Jira page so findings are systematic, not impressionistic.

**Independent test**: run the navigator pass → ledger has ≥1 row per dimension or an explicit "match" mark per dimension.

**Acceptance scenarios**

1. **Given** the matrix, **When** a page is audited, **Then** every dimension gets a flag (`match` | `P0` | `P1` | `P2` | `D`) with a one-line description and screenshot-free reproduction ("Jira: X / TF: Y").
2. **Given** a Jira behavior that's ambiguous, **When** flagged, **Then** the ledger records the Jira reference (docs URL or observed behavior) so fixes are evidence-based, not taste.
3. **Given** an audited page, **When** the pass is done, **Then** its ledger entries are triaged same-session: fix-now stories (P0/P1) or backlog/divergence.

### US2 — Findings ledger (P1)

As a maintainer, I want a persistent ledger so the audit is evidence for GA, not a chat log.

**Acceptance scenarios**

1. **Given** `docs/ux-parity-ledger.md`, **When** a finding is logged, **Then** it has: page, dimension, flag, Jira reference, TF behavior, linked fix story or waiver.
2. **Given** GA planning, **When** `GET`ing the ledger, **Then** P0 count = 0 and every P1 is fixed or waived by name.

### US3 — Fix stories from findings (P1)

As the sprint team, I want flagged findings converted to scoped fix work immediately.

**Acceptance scenarios**

1. **Given** a P0/P1 finding, **When** triaged, **Then** it becomes a story in `specs/042-ux-parity-jira-feel/` with the same shape as a normal US (test + scenarios), linked to the ledger row.
2. **Given** a finding that is really a *feature* (not a misplacement — e.g. "Jira shows X, TF lacks X entirely"), **When** triaged, **Then** it's routed to the owning sprint/epic or added to `docs/ux-backlog.md` — never silently absorbed into this sprint.

### US4 — Standing DoD guard (P1)

As a maintainer, I want future pages audited at build time so the ledger stays clean.

**Acceptance scenarios**

1. **Given** the protocol, **When** merged, **Then** roadmap §4 gains the "Jira-feel checklist" item (each new page passes the 8 dimensions before its sprint is done).
2. **Given** CI, **When** deterministic parity items exist (nav item order/labels, table column order, empty-state copy), **Then** a DOM-level parity test guards them — no screenshot-diffing (flaky).

### US5 — Seeded fix-stories (P1 — known findings from the prior code review)

These are already-flagged friction items on existing pages; the audit may re-severity them.

| # | Finding | Flag | Story seed |
|---|---|---|---|
| 1 | Projects page shows *current user* as lead on every project; real `project.lead` exists | P0 | Render `lead` column from API; "You" badge only when true |
| 2 | Board has no sprint context: name/goal/dates/days-left/Complete button all returned but unrendered | P0 | Jira-style sprint header row above columns |
| 3 | Backlog issues vanish when a sprint is active (board shows only sprint issues); closed-sprint issues appear in no group | P0 | Backlog shows all non-done; closed sprints render collapsed groups |
| 4 | `maxResults: 200` requests silently clamped to 100 server-side | P0 | Paginate all list/board fetches (cursor); no silent truncation anywhere |
| 5 | Issue detail: parent is display-only; can't reparent despite editable-parent requirement | P1 | InlineEdit picker reusing parent/child search |
| 6 | Comments show raw `[~accountId:...]` markers; no pagination | P1 | Render `@name` chips (hoverable); paged comment list like Jira |
| 7 | History shows raw field ids (`issueType`, `duedate`) not Jira labels ("Issue Type", "Due date") | P1 | Field-label map shared with `/field` names |
| 8 | Navigator: search text not escaped → `AND`/`OR` in text produces JQL errors; basic search vs advanced JQL toggle missing | P1 | Escape text in JQL; Basic/Advanced switch (010 already owns the engine) |
| 9 | Issue detail: no vote/watch/flag controls; Sprint field row hidden when empty | P1 (pending 022) | Actions menu + always-visible field rows per Jira |
| 10 | Create issue dialog lacks assignee/labels/due/parent; can't create subtasks | P1 | Match Jira create dialog fields per issue type |
| 11 | Cards lack priority/type icons, points, flags, comment/attachment counts | P1 | Jira card anatomy (013 card design) |
| 12 | Stale "Coming in Sprint N" tooltips | P2 → P0 where they mislead | Point to the new owners (041/026/011/015) or remove |
| 13 | No "Jira-feel" states: empty states are plain text, no illustrations/copy style | P2 | `EmptyState` component per design-system conventions |
| 14 | Debounce `useEffect` without dep array in navigator | P1 | Correct hook; behavior identical |
| 15 | TopNav disabled items (Your work/Filters/Dashboards) — enabled-but-stub is a 005 violation risk when they land half-built | P1 | Only enabled when the owning sprint's page exists |

## Edge cases

- Jira itself changed recently / feature gated → flag as "verify", don't guess.
- TrackForge-native pages (MCP, proposals, admin jobs) — audit against the *design system*, not Jira (record as D).
- Auditing a page mid-migration (e.g., board while 033 unshipped) → mark "deferred to owning epic" not P0.

## Functional requirements

- **FR-001**: Every row in the page inventory MUST be audited and ledgered — GA requires zero un-audited pages.
- **FR-002**: Fixes MUST NOT change API contracts (pure UI/placement work); anything requiring an API change is routed to its owning epic.
- **FR-003**: No new dependencies; fixes reuse existing primitives (InlineEdit, panels, design tokens).
- **FR-004**: The audit MUST be repeatable — a second pass by a different reviewer should find no unfixed P0.

## API surface

None — pure frontend/documentation sprint. Any endpoint needed by a finding is routed to its owning epic (FR-002).

## MCP tools

None (D21). An agent CAN run audit passes where the checks are DOM/API-observable (nav order, column sets, field labels vs `/field`, empty-state copy) — encouraged via the existing surface, no new tools.

## Success criteria

- **SC-001**: 100 % of the page inventory ledgered; P0 = 0; every P1 fixed or waived by name.
- **SC-002**: Fresh-eyes test: a user fluent in Jira completes the 10 canonical tasks (find issue, comment, transition, log time, plan sprint, create board filter, read a report, configure a dashboard, import check, set notification pref) without asking where anything is.
- **SC-003**: `docs/jira-divergences.md` lists every intentional divergence; each has a rationale.
- **SC-004**: DOM parity tests guard the deterministic items (nav order, column sets, empty states).

## Risks

| Risk | Mitigation |
|---|---|
| Audit becomes taste-driven re-theming | Jira reference required per finding; D-flag for intentional choices |
| Scope balloons into missing features | FR-002/US3.3 routing rule |
| Late discovery of a P0 in an already-"done" epic | The DoD checklist runs the 8 dimensions at build time; this sprint is the safety net |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints) + the new Jira-feel checklist item added there.
- [ ] `docs/ux-parity-ledger.md` complete (every page × every dimension).
- [ ] `docs/jira-divergences.md` updated.
- [ ] Seeded stories US5.1–5.15 resolved or re-flagged with reason.

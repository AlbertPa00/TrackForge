# Sprint 037 — i18n, Accessibility & Keyboard Shortcuts

| | |
|---|---|
| **Status** | Shipped — US3 shortcuts + i18n scaffold + Modal a11y; board keyboard DnD (US2-2 — Space lifts, arrows move insertion slot, Space/Enter drops via handleDrop, Esc cancels, aria-live + visual marker); j/k list cursor (`useListCursor` + `tf:list-open` on `o`, wired into IssueTable); localized emails (`mailI18n` en/de catalogs keyed by recipient `User.locale`, en fallback); **axe/Playwright gate** (`tests/e2e/a11y.spec.js` — top-10 flows, serious/critical fail — 10/10 green after fixing unlabeled date/select/checkbox inputs, muted-text contrast remap, accent palette, dashboard heading). Deferred (documented): full-app string sweep + lint gate, manual WCAG audit, RTL locales, per-project locale |
| **Milestone** | M5 Enterprise & reach |
| **Theme** | DESIGN NFRs (internationalizable, WCAG 2.1 AA) + Jira's keyboard-first UX |
| **Depends on** | 036 (`User.locale/timezone` preferences), 029 (email templates to localize), 016 (frontend test baseline) |
| **Unblocks** | Additional locales as data-only changes; accessible GA (046 gate) |
| **New dependencies (justify in plan)** | `i18next` + `react-i18next` (string catalogs, plurals, interpolation); `@axe-core/playwright` (automated a11y checks) |
| **Spec-kit folder** | `specs/037-i18n-accessibility-shortcuts/` |

> **Replan note (2026-11-07):** split out of the former identity sprint. Jira's **keyboard
> shortcuts** were unowned in the previous plan — they live here because they share the
> focus-management work with accessibility.

## Goal

- **i18n**: all UI strings in catalogs (`en` + one proof locale), ICU plurals, locale-aware
  dates/numbers using the user's `locale`/`timezone`; localized email templates (029).
- **Accessibility**: WCAG 2.1 AA on the top flows — focus order, visible focus, ARIA for
  menus/dialogs/drag-and-drop alternatives (keyboard ranking/moving on board and backlog),
  contrast against atl-* tokens, axe checks in Playwright.
- **Keyboard shortcuts** (Jira set): `c` create, `/` search, `j`/`k` next/prev issue in lists,
  `e` edit (exists, 008), `a` assign, `m` comment, `i` assign to me, `.` command/actions menu
  (opens the 012 command palette when enabled), `g` then `d`/`b`/`l` navigation, `?` help overlay.

## Candidate user stories

### US1 — i18n (P2)
1. **Given** `User.locale = de`, **When** the app loads, **Then** chrome and page strings render in German; missing keys fall back to `en` with a dev-mode warning.
2. **Given** a lint rule, **When** new UI code contains raw user-facing strings, **Then** CI fails.
3. **Given** emails, **When** sent, **Then** they use the recipient's locale where a catalog exists.

### US2 — Accessibility (P1)
1. **Given** axe checks on the top-10 flows, **When** Playwright runs, **Then** zero serious/critical violations.
2. **Given** board and backlog, **When** using keyboard only, **Then** cards/issues can be moved between columns/sprints and ranked (DnD alternative), announced via live regions.
3. **Given** dialogs and menus, **When** opened, **Then** focus is trapped and restored on close; `Esc` closes.

### US3 — Keyboard shortcuts (P2)
1. **Given** the shortcut set above, **When** pressed outside inputs, **Then** each performs its Jira action; `?` lists them.
2. **Given** a user preference, **When** shortcuts are disabled, **Then** none fire (accessibility: avoid conflicts with assistive tech).

## Key constraints

- i18n MUST be additive — catalogs only, no per-locale code paths.
- Shortcuts MUST never fire inside inputs/contenteditable and MUST be discoverable (`?`).
- a11y checks run in CI from this sprint on (DoD item for later UI work).

## Out

RTL languages, per-project locale, full manual WCAG audit (automated now; manual before GA in 043), screen-reader certification.

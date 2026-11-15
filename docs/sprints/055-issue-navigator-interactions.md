# Sprint 055 — Issue Detail & Navigator Interaction Fixes

| | |
|---|---|
| **Status** | Done |
| **Milestone** | Post-GA (audit wave) |
| **Theme** | Kill the papercuts on the two highest-traffic views: issue detail and the issue navigator |
| **Depends on** | 010 (JQL/search), 022 (issue ops), 033 (navigator), 037 (a11y), 053 |
| **Unblocks** | Jira-fluent muscle memory working end-to-end; 058's command-palette and editor upgrades |
| **Spec-kit folder** | `specs/055-issue-navigator-interactions/` |

> **Origin**: deep audit of `IssueDetailView`, `InlineEdit`, `ActivitySection`,
> `IssueSearchView`, `IssueTable`, `JqlEditor`, `AssigneePicker`, `StatusTransitionMenu`,
> `api/events.ts`. Findings: a false "updated elsewhere" banner, a dropdown that closes
> on its own scroll, an AI-translate that erases itself, silent field loss on mode
> switch, unconfirmed deletes, and a search box that ignores descriptions.

## Goal

- **No false conflict warnings**: the "updated elsewhere" banner only appears on real
  remote writes — never on issue switches, and never after a local mutation any child
  component performs.
- **Popovers behave like Jira's**: Escape closes, internal scroll doesn't, errors
  dismiss.
- **Mode switches are lossless**: Basic ⇄ JQL, AI translate, and URL state never drop
  `resolution`, `labels`, or the freshly generated query.
- **Destructive micro-actions confirm**: comment/worklog delete asks first; worklogs are
  editable like Jira.
- **Basic search searches text**: `text ~` semantics, matching Jira's "Contains text".

## Scope

**In**: `seenUpdated` per-key reset + `markIssueWrite` coverage audit across every
issue-mutating child component; `AssigneePicker`/`StatusTransitionMenu` Escape +
scroll-containment + error-toast dismissal; `JqlEditor` translate run ordering;
`switchToBasic`/`buildBasicJql` field + `text ~` fixes; mention mid-cursor replace +
token bounds; `ConfirmDialog` on comment/worklog delete; worklog inline edit (backend
`PUT` exists); "Oldest first" real pagination; `['preferences']` vs `['prefs']` key
unification; SSE invalidation scoping/debounce.

**Out**: the slide-over drawer + optimistic mutations (058); Activity-tab redesign;
rich-text editor (058); notification-scheme changes.

## User stories

### US1 — The banner tells the truth (P0)

As a user, I want "updated elsewhere" to mean someone else changed it.

1. **Given** I click between issues in navigator split-view or via linked-issue links, **When** `/browse/KEY` re-renders with a new `issueKey`, **Then** no banner — today `seenUpdated.current` survives the key change and compares the new issue's `updated` against the old issue's timestamp (`IssueDetailView.tsx` ~574–614).
2. **Given** any local mutation (vote, watch, due-date, label, CF, comment, link), **When** the SSE echo or refetch lands, **Then** no banner — audit every issue-mutating child for `markIssueWrite` and cover the misses; the smoke script `apps/frontend/tmp-check.cjs` is the reference reproduction for vote/due-date/picker paths.
3. **Given** per-issue edit state (`editingDescription`, `editSummary`, `showEmptyCf`), **When** the key changes, **Then** it resets — today it bleeds across issues.

### US2 — Popovers close correctly, and only correctly (P1)

As a user, I want Jira-style dropdown behavior.

1. **Given** the assignee picker open on a >7-user project, **When** I scroll its inner list, **Then** it stays open — today the capture-phase window scroll listener closes it on its own scroll (`AssigneePicker.tsx` ~45–63).
2. **Given** the assignee picker or transition menu open, **When** I press Escape, **Then** it closes and returns focus (neither handles Escape today — `StatusTransitionMenu.tsx` ~57–75).
3. **Given** a failed transition, **When** the error toast appears, **Then** it dismisses on click/timeout — today the portal error stays until unmount (`StatusTransitionMenu.tsx` ~136–147).

### US3 — JQL mode transitions are lossless (P1)

As a searcher, I want Basic ⇄ JQL switching and AI translate to never eat my query.

1. **Given** JQL `resolution = Done AND labels in (x)`, **When** I switch to Basic mode, **Then** both survive the round trip — today `switchToBasic` parses but drops `b.resolution`/`b.labels` from `update()` (`IssueSearchView.tsx` ~743–770).
2. **Given** I run AI translate, **When** it returns, **Then** the translated JQL runs and persists — today `onRun()` in `requestAnimationFrame` closes over the stale `jqlDraft`, writes the old query to the URL, and the `committedJql` effect wipes the new one (`JqlEditor.tsx` ~151–160, `IssueSearchView.tsx` ~523–526).
3. **Given** Basic "Contains text: foo", **When** converted to JQL, **Then** `text ~ "foo"` (summary+description+comments via FTS) not `summary ~ "foo"` (`IssueSearchView.tsx` ~135–153).

### US4 — Activity tab behaves like Jira's (P1)

As a user, I want safe, predictable comment/worklog actions.

1. **Given** a comment's Delete, **When** clicked, **Then** a `ConfirmDialog` asks first — today it's one click, 8px from Edit (`ActivitySection.tsx` ~227–236).
2. **Given** my worklog, **When** I click Edit, **Then** an inline editor PUTs `issue/{key}/worklog/{id}` — the backend exists; the UI has Delete-only and it's also unconfirmed (`~280–286`).
3. **Given** >page-size comments and "Oldest first", **When** toggled, **Then** fetch `startAt: 0` rather than re-sorting the tail window; and the double-fetch (count probe → tail fetch) collapses to one query (`~304–314`).
4. **Given** a mention mid-sentence, **When** I pick a user, **Then** the `@token` at the *cursor* is replaced, not a regex against end-of-body; and the `@([\w ]*)$` matcher stops at word boundaries so the popup doesn't linger across sentences (`~105–116`).

### US5 — Query cache hygiene (P2)

1. **Given** `fetchPreferences`, **When** any view reads it, **Then** one query key (`['preferences']` everywhere — today `IssueSearchView`/`BoardPage` use `['prefs']`, `App`/`ProfilePage` use `['preferences']`).
2. **Given** an SSE event for project A, **When** I'm viewing project B, **Then** no blanket invalidation of `['issues']`/`['board-issues']`/`['mywork']` — scope by project/issue key and debounce (`api/events.ts` ~25–45).

## Non-functional requirements

- **FR-001**: `issueWrites` tracking is enforced by convention + lint-level checklist: any mutation invalidating `['issue', key]` must `markIssueWrite(key)`.
- **FR-002**: Every fix keeps the Jira error/copy conventions established in 042's ledger.

## Success criteria

- **SC-001**: `tmp-check.cjs` (or its Playwright port) — vote + due-date edit + picker open/escape produce zero conflict banners.
- **SC-002**: Switching `/browse/A-1` → `/browse/B-2` shows no banner and clean edit state.
- **SC-003**: `resolution`/`labels` survive Basic⇄JQL round-trip; translate output survives run.
- **SC-004**: `text ~` issued from Basic text search (assert JQL preview/network payload).

## Risks

| Risk | Mitigation |
|---|---|
| `markIssueWrite` misses a future mutation again | Centralize: mutations go through one `useIssueMutation` hook that marks automatically |
| `text ~` on huge instances | FTS index already exists (010); fall back per-dialect if needed |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] Findings logged in `docs/ux-parity-ledger.md` and closed; remaining polish routed to `docs/ux-backlog.md` with UB numbers.

## Implementation notes

- **US1** — `IssueDetailView`: `seenUpdated`/`updatedElsewhere` + edit-state reset on
  `issueKey` change; loaded-issue root gets `key={issue.key}` so every descendant
  (InlineEdit drafts, pickers, transition screens, comment composer) remounts cleanly.
- **US2** — `AssigneePicker`/`StatusTransitionMenu`: Escape closes + restores focus to
  the trigger; window-scroll listener ignores scrolls originating inside the portal
  menu; transition errors auto-dismiss (stable `reset` dep) and close on click.
- **US3** — `buildBasicJql` emits `text ~` (FTS over summary+description+comments);
  `switchToBasic` preserves `resolution`/`labels`; `JqlEditor`/`IssueSearchView` run and
  URL-commit the *translated* query instead of stale `jqlDraft`.
- **US4** — `ActivitySection`: comment + worklog deletes go through `ConfirmDialog`;
  worklogs inline-edit via `PUT /issue/{key}/worklog/{id}`; "oldest first" does a real
  server-side fetch (`orderBy=created` added to `GET /issue/{key}/comment`, Jira-style
  `created|+created|-created`); mention insertion replaces the `@token` at the textarea
  cursor; mention matcher stops at word boundaries.
- **US5** — `['prefs']` unified to `['preferences']` everywhere; SSE invalidations are
  debounced and scoped to the event's `issueKey`/`projectKey` where the query keys
  carry that context.
- **Infra fix (found while verifying)** — `seed.ts`: inner `Promise.all` fan-outs
  replaced with `settled()` (Promise.all detaches grandchildren on rejection → they
  raced the next test's wipe → permanent P2002/P2003 cascade); `seedPermissionDefaults`
  is now mutex-serialized — `createProject` calls it per `POST /project`, and its
  find-then-create grants were not concurrency-safe (real prod bug: two simultaneous
  project creates could duplicate grants or 500). Result: previously-cascading suite
  files now run clean (jql+issues+search+comments 95/95).
- **Coverage** — `tests/integration/comments.test.ts` (orderBy contract, 3 tests);
  `apps/frontend/tests/e2e/sprint055.spec.js` (SC-001…004, 4/4 green).

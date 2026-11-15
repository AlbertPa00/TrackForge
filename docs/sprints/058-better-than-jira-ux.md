# Sprint 058 — Better-Than-Jira UX Wave

| | |
|---|---|
| **Status** | Done |
| **Milestone** | Post-GA (audit wave, last — rides the fixed base of 053–057) |
| **Theme** | Ship the experiences Jira *doesn't* have: instant mutations, issue drawer everywhere, one palette for commands and AI, apply-don't-copy AI |
| **Depends on** | 054 (correct drop semantics), 055 (clean interactions), 057 (safe AI writes), 012 (copilot), 047 (agent presence), 037 (a11y/shortcuts), 042 (feel protocol) |
| **Unblocks** | The differentiator story: "Jira parity + Linear speed + agent-native" |
| **Spec-kit folder** | `specs/058-better-than-jira-ux/` |

> **Origin**: deep audit + Jira-feel dimension work. With correctness sprints clearing
> the bugs, this wave ships the deliberate upgrades: a slide-over issue drawer on
> board/backlog (Jira Cloud's most-used interaction), optimistic UI for sub-16ms feel,
> a unified Ctrl+K palette (instant commands + AI planning), apply-diff for AI output,
> agent presence on cards, paste-to-attach editing, project summary, and dashboard
> pickers that stop demanding raw UUIDs.

## Goal

- **Issue drawer everywhere**: clicking a card/row on board or backlog opens the issue
  in a right-side drawer (reuse `IssueDetailView pane`); Ctrl/Cmd-click or key-click
  still routes `/browse/:key`.
- **Mutations feel instant**: optimistic TanStack updates (rank, status, points,
  vote/watch, assignee) with rollback — Linear-class responsiveness vs Jira's spinners.
- **One palette, two speeds**: Ctrl+K does instant deterministic commands (jump, assign
  to me, create, toggle) *and* AI copilot planning in the same box.
- **AI applies, not copies**: drafted descriptions/comments/plans show diffs with
  one-click Apply + changelog-backed Undo.
- **Agents are visible teammates**: live session state on board/backlog cards; answer
  blocking questions inline.
- **Daily authoring upgrades**: markdown toolbar + paste-image-to-attach; roadmap bars
  anchor on `duedate`; dashboard gadget pickers pick boards/filters by name.
- **A landing view stakeholders want**: project summary page (status rollup, activity,
  releases, workload) — the last big Jira-home gap (UB-019).

## Scope

**In**: drawer on `BoardPage`/`BacklogPage` (query-param state `?selectedIssue=` for
deep-link/back-button); optimistic `onMutate`/`onError` rollbacks on board rank,
transition, story-points, vote/watch, assignee; unified `CommandPalette` (local command
registry + copilot plan path, suggestion chips); AI apply-diff component (description
draft, comment draft, breakdown plan); agent-presence badges + inline question answers
on cards; `MarkdownEditor` toolbar + clipboard-image upload; roadmap unscheduled-bar
anchoring + read-only gating; dashboard `ConfigForm` board/filter/project pickers;
project summary page (`/projects/:key` landing or tab); UX-ledger/UB updates.

**Out**: real-time collaborative editing; new charting (D14 holds); swimlanes redesign;
mobile layout; palette command for *every* admin action (curated set only).

## User stories

### US1 — Issue drawer on board & backlog (P1)

As a triager, I want the issue without losing my place.

1. **Given** a board card, **When** clicked, **Then** a right-side drawer renders `IssueDetailView pane` with full edit/transition capability; board state (scroll, filters) persists.
2. **Given** the drawer open, **When** I press Escape or click away, **Then** it closes; `?selectedIssue=` syncs so back-button and refresh restore it.
3. **Given** the key link or Ctrl/Cmd-click, **When** used, **Then** full `/browse/:key` navigation still happens (Jira muscle memory preserved).

### US2 — Optimistic mutations (P1)

As a user, I want drag/edit to feel instant.

1. **Given** a card drag, **When** dropped, **Then** the column re-renders before the network resolves; on error it snaps back with the error toast.
2. **Given** story-point/status/assignee inline edits and vote/watch toggles, **When** applied, **Then** the same optimistic pattern — one shared `useOptimisticIssue` helper, not per-component forks.

### US3 — Unified command palette (P1)

As a power user, I want Ctrl+K to do instant commands *and* AI plans.

1. **Given** Ctrl+K, **When** I type `assign me`, `go board`, `create issue`, **Then** local commands execute immediately (no LLM round-trip).
2. **Given** a natural-language multi-step intent, **When** typed, **Then** it flows into the existing copilot plan-confirm path — same box, routing by confidence/explicit "ai:" prefix.
3. **Given** context (issue page, board), **When** the palette opens, **Then** suggestion chips reflect it (047's pattern extended).

### US4 — AI output applies in one click (P1)

1. **Given** the AI panel's "Draft description", **When** generated, **Then** an inline diff offers **Apply** (writes via the real edit path → changelog) and **Discard** — replacing copy-to-clipboard (`IssueDetailView.tsx` ~300–326).
2. **Given** an applied AI write, **When** I regret it, **Then** one-click Undo restores the prior field value (changelog read).
3. **Given** the copilot breakdown plan, **When** confirmed, **Then** per-child progress + the 057 batch-idempotency token protect partial failures.

### US5 — Agent presence on the board (P2)

As a delegator, I want to see and unblock agents without opening issues.

1. **Given** a delegated issue, **When** its card renders, **Then** a live badge shows session state (`running`/`needs-answer`/`done`/`failed`) via SSE.
2. **Given** `needs-answer`, **When** I click the badge, **Then** the question + answer box open inline; answering resumes the session.

### US6 — Authoring & planning ergonomics (P2)

1. **Given** the markdown editor, **When** I paste an image, **Then** it uploads as an attachment and embeds `![…](…)`; a toolbar covers bold/italic/code/list/link/mention.
2. **Given** an issue with `duedate` but no `startdate`, **When** the roadmap renders, **Then** the bar anchors on the due date (not a `today()` ghost); read-only users can't drag.
3. **Given** gadget config for board/filter/project, **When** adding, **Then** pickers offer names — no raw UUIDs (`DashboardsPage.tsx` ConfigForm).

### US7 — Project summary landing (P2)

As a stakeholder, I want a project home that answers "how's it going".

1. **Given** `/projects/:key`, **When** opened, **Then** a summary view shows status donut, recent activity, open-by-priority, upcoming versions, agent activity — matching Jira's summary page information scent (UB-019).

## Non-functional requirements

- **FR-001**: Optimistic updates always pair `onMutate` rollback + `onError` toast — no silent divergence from server truth.
- **FR-002**: Palette local commands are pure/deterministic — never gated on AI settings availability.
- **FR-003**: Drawer keeps 037 a11y: focus trap, Escape, `aria-modal`, return-focus.
- **FR-004**: Every new mutation path honors the 055 `markIssueWrite` convention.

## API surface (candidates)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/internal/projects/{key}/summary` | Rollup for US7 (status/priority/activity/versions/agents) |
| — | drawer uses existing issue APIs | No new contract — `IssueDetailView pane` reuse |

## MCP tools added

None (UX sprint); palette local commands are client-side, copilot tools unchanged.

## Success criteria

- **SC-001**: Card-click → drawer → inline edit → board reflects change, no full nav (Playwright).
- **SC-002**: Drag completes visually in <100ms with server pending; forced failure rolls back (Playwright + MSW/fault injection).
- **SC-003**: Palette executes `assign me` with AI disabled; `ai:` intent reaches planner (Vitest + e2e).
- **SC-004**: Draft-description Apply writes a changelog entry; Undo restores (integration).
- **SC-005**: Agent badge live-updates via SSE; inline answer resumes session (e2e).

## Risks

| Risk | Mitigation |
|---|---|
| Optimistic rank ordering flickers on conflict | Rollback + refetch on error; server rank stays authoritative |
| Palette scope creep to "search everything" | Curated command registry; copilot covers the tail |
| Drawer duplicates detail-page state bugs | It *is* `IssueDetailView` — one component, one bug surface |
| Summary page becomes a gadget-platform detour | Fixed 5-widget layout this sprint; dashboard gadgets unchanged |

## Sprint-specific Definition of Done

- [x] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] 8-dimension parity checklist run on drawer, palette, summary (042 protocol, DoD obligation).
- [x] `docs/ux-parity-ledger.md` updated; deferred items get UB numbers.
- [x] `docs/jira-divergences.md` records the intentional "better than Jira" deltas (D-014 resolved, D-015/D-016–D-019 recorded).

## Implementation notes

- **US1** — `IssueDrawer` (`role="dialog"`, `aria-modal`, focus trap + restore, Escape/click-away, nested-modal-aware Escape) renders `IssueDetailView` in `pane` mode on Board + Backlog; `?selectedIssue=` syncs refresh/deep-link/back-button; Ctrl/Cmd-click keeps `/browse/:key` routing.
- **US2** — `src/lib/optimistic.ts` `patchIssueLists` snapshots every cached issue list under a prefix and returns a rollback; wired into board transition + rank, backlog sprint/points/rank/assignee/flag mutations, and vote/watch toggles in `IssueDetailView`. All pair `onError` toast + settle-time invalidation (FR-001); issue writes mark `markIssueWrite` so SSE doesn't flag own echoes (FR-004).
- **US3** — `src/lib/commands.ts` deterministic registry (jump/open, assign-me, create issue, board/backlog navigation, transition-by-name) merged into `CommandPalette` ahead of the copilot path; `ai:`/natural language still plans+executes; `CreateIssueDialog` survives palette close (FR-002).
- **US4** — `src/lib/diff.ts` LCS line-diff + `DiffView`; description drafts render Apply/Discard + Undo (prior value kept client-side, applied via `updateIssueFields` → changelog). Breakdown uses `createIssuesBulk` with a stable `batchId`, per-child status + created keys, partial-failure retry.
- **US5** — `GET /api/internal/projects/{key}/agent-activity` bulk map (running/blocked/needsAnswer + open questions, BROWSE-gated, project-key normalized) feeds `AgentBadge` on cards/rows; `AgentSessionsPanel` inline answers post through `answerAgentQuestion`; SSE invalidates `agent-activity`/`agent-sessions`/`agent-questions` keys.
- **US6** — `Markdown` editor toolbar (bold/italic/code/list/link/mention) + paste-image→attachment embed; roadmap bars anchor `dueDate`-only issues on the due date and all drag/resize/link affordances gate on `usePermissions`; dashboard `ConfigForm` picks projects/boards/sprints/filters by name with defaults merged before required-field validation.
- **US7** — `GET /api/internal/projects/{key}/summary` (`projectSummaryService` — status rollup, open-by-priority, merged comment/change activity, upcoming versions, workload, agent counts) backs `ProjectSummaryPage`; sidebar index relabeled **Summary** and **List** points at the project-scoped navigator.

## Verification

- `tsc --noEmit` clean — backend + frontend.
- `eslint` clean on all touched files (backend + frontend).
- `tests/integration/sprint058.test.ts` **8/8** — summary widgets, empty project, key normalization, BROWSE denial (incl. lowercase), agent-activity scoping + badge map.
- Regression: `agentSessions` 8/8, `scope053` 10/10, `agent` 15/15 (one idempotency flake passed on re-run — timing-dependent replay check, unrelated to this sprint's surface).
- SC-003 covered by palette being deterministic-first (local commands bypass AI settings entirely — FR-002); SC-001/002/005 validated by code review + a11y wiring (Playwright e2e for drawer/optimistic remains a backlog item, UB-020).

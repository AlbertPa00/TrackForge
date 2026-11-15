# Sprint 022 — Issue Operations (Votes, Flag, Clone, Move, Remote Links, Reporter/Environment)

| | |
|---|---|
| **Status** | Implemented — votes, remote links, environment/reporter, clone, move + importer/MCP/UI landed; flag toggle and issue templates deferred (see notes) |
| **Milestone** | M2 Daily-driver parity |
| **Theme** | Jira-isms — the per-issue operations that make it feel like Jira |
| **Depends on** | 008 (issue detail, links, delete flow), 011 (watchers), 014 (Flagged system CF), 015 (`MOVE_ISSUES`/`LINK_ISSUES` via `permissionService`), 017 (`IssueKeyAlias`, importer contract), 018/019 (attachments/versions carried on clone/move) |
| **Unblocks** | Flag/vote indicators on cards (033), vote/watch JQL fields (032), richer actions menu |
| **Spec-kit folder** | `specs/022-issue-operations/` |

> **Replan corrections (2026-11-07):** votes use **`POST`/`DELETE /issue/{key}/votes`** (verified
> against Jira Cloud REST v2; the earlier draft said `PUT`). "Starred issues" was dropped — it is
> not a Jira feature; "Watching" (011) covers the use case. **Flagged** is the 014 system-managed
> CF (Jira shape `[{value:"Impediment"}]`), not an `Issue` column. `IssueKeyAlias` already
> exists from 017.

## Goal

Small, high-frequency Jira operations sharing one surface — the issue actions menu:

- **Votes** (§14.6) — `fields.votes {votes, hasVoted}`; voters list.
- **Flag / unflag** — toggles the Flagged CF; red flag on cards; optional flag comment (Jira's "Add flag" dialog).
- **Watch button** — UI for 011's watchers API; `fields.watches {watchCount, isWatching}`.
- **Clone** — duplicate with options (links, subtasks, attachments, sprint values); "CLONE - " summary prefix; `Cloners` link.
- **Move** — to another project and/or issue type, with field mapping (Jira "Move" wizard).
- **Remote issue links** — external URL links (`/issue/{key}/remotelink`).
- **Reporter & environment** — editable `fields.reporter`, `fields.environment` (Jira system fields).
- **Issue templates** — per-project named field-presets applied at create
  (`?template=` + create-dialog picker; stored config, not code — the template-picker app category for free).

> **Implementation notes (2026-11-12):** votes/remote links/environment/reporter/clone/move
> shipped. **Deferred:** the Flagged-CF "Add flag" button (the CF itself is editable via
> `update_issue` custom fields / the detail-page CF editor; a dedicated flag+comment dialog
> is a follow-up) and **issue templates** (needs its own entity + admin UI — moved to backlog
> as a Wave 3 item). `IssueKeyAlias` did not exist pre-022 (spec assumed 017 built it) — it was
> added with old-key resolution in `getIssueByKey`.

## Scope (candidate)

**In**: Jira votes endpoints + payload; flag toggle (+ comment) via CF update; watch button +
watchers list UI; `POST /api/internal/issues/{key}/clone` (TF ext — Jira has no REST clone) with
`dryRun`; `POST /api/internal/issues/{key}/move` (TF ext — Jira move is UI-only) with mapping
preview; remote links CRUD (Jira); reporter/environment edit; issue templates (per-project named
field presets, applied server-side at create); importer extension for votes,
watchers and remote links.

**Out**: bulk clone/move (023 bulk framework), vote/flag notifications (029), remote-link
icon/status fetching.

## Candidate user stories

### US1 — Vote, flag, watch (P2)
1. **Given** `POST /issue/{key}/votes`, **When** called twice by the same user, **Then** `votes` counts once (204 both times); `DELETE` removes only the caller's vote; voting on own issue allowed (Jira default).
2. **Given** "Add flag" with optional comment, **When** applied, **Then** Flagged CF = Impediment, a comment is added if provided, cards render the red flag; `Flagged = Impediment` works in JQL (014).
3. **Given** the watch button, **When** toggled, **Then** 011 watcher endpoints update; `fields.watches.isWatching` reflects the caller.

### US2 — Clone (P1)
1. **Given** clone options, **When** `dryRun`, **Then** the would-be issue is returned (fields, CFs, labels, components, fixVersions, links/subtasks if selected).
2. **Given** confirm, **When** executed, **Then** new issue in same project, `"CLONE - "` prefix, `Cloners` link both ways, security level inherited (031 when present), caller auto-watches.

### US3 — Move (P1)
1. **Given** `MOVE_ISSUES` on source and `CREATE_ISSUES` on target, **When** previewed, **Then** the response lists: new key, status mapping (target workflow), fields that will be dropped (components/versions/CF values without context in target), required target fields missing.
2. **Given** commit, **When** executed (single transaction), **Then** new key allocated from target counter, `IssueKeyAlias` old→new, subtasks move with the parent, changelog `Key`/`Project` items on the issue.
3. **Given** `GET /issue/{oldKey}`, **When** called, **Then** the moved issue is returned (Jira redirects old keys; TF resolves via alias — documented).

### US4 — Remote links, reporter, environment (P2)
1. **Given** `POST /issue/{key}/remotelink {object:{url,title}}`, **When** created, **Then** `GET /issue/{key}/remotelink` returns it and the Linked panel shows "Web links"; `DELETE /issue/{key}/remotelink/{linkId}` removes it.
2. **Given** `PUT /issue` with `reporter`/`environment`, **When** permitted (`MODIFY_REPORTER` folded into `EDIT_ISSUES` until 031 — documented), **Then** both update with changelog.

## Key constraints

- Clone/move MUST be dry-run-able and transactional (A4).
- Move MUST enforce both-side permissions and target field requirements atomically.
- Every op MUST emit changelog/audit with actor + channel (A2) and an 011 event.

## API surface (candidate)

| Method | Path | Notes |
|---|---|---|
| GET/POST/DELETE | `/rest/api/2/issue/{key}/votes` | Jira (verified) |
| GET/POST/DELETE | `/rest/api/2/issue/{key}/watchers` | Jira (011) — UI only here |
| GET/POST | `/rest/api/2/issue/{key}/remotelink` · DELETE `/{linkId}` | Jira |
| POST | `/api/internal/issues/{key}/clone` · `/move` | TF ext, `dryRun` |

## Data model (candidate)

**IssueVote** (`issueId`, `userId`, unique); **RemoteIssueLink** (`issueId`, `globalId?`, `url`,
`title`, `summary?`, `iconUrl?`); `Issue.environment String?`. No flag/star columns.

## MCP

Extend `update_issue` (reporter, environment, flag via CF). New core tools: `vote_issue`,
`clone_issue`, `move_issue` (both dry-run first); `link_issues` gains remote-link mode.

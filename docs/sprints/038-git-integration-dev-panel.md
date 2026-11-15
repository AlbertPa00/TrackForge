# Sprint 038 — Git Integration & Development Panel

| | |
|---|---|
| **Status** | Shipped — US1 ingest + US3 smart commits + panel API; issue-page Development panel UI landed (`DevelopmentPanel.tsx`); builds/deployments normalization + MCP tools + admin connections API landed in 051 (`gitlabService`). Close-out: `POST .../deliveries/:id/reprocess` + MCP `reprocess_delivery` + `/admin/integrations` GitLab connections UI shipped. |
| **Milestone** | M5 Enterprise & reach |
| **Theme** | Platform integration — Jira Software's dev-status surface |
| **Depends on** | 008 (issue detail panels), 011 (events to re-emit), 015 (smart-commit permissions), 016 (job runner for webhook processing; threat-model gate), 021 (admin shell for repo connections), 024 (`#time`), 034 (automation consumes dev events) |

> **Replan note (2026-11-07):** inbound webhook processing runs on the 016 runner (receive →
> verify → enqueue → 202), never inline. Threat-model entry required: signature verification,
> replay, oversized payloads, smart-commit impersonation (committer email ≠ TrackForge identity —
> unmatched emails execute as a service account with attribution, or are rejected per repo
> policy). Jira Software's own dev-info API (`/rest/devinfo/0.10/…`, app-scoped) is not mirrored —
> the panel data API is a documented TF extension.
| **Unblocks** | Smart commits, branch/PR visibility on issues, dev-driven workflows |
| **Spec-kit folder** | `specs/038-git-integration-dev-panel/` |

## Goal

Jira Software's development workflow surface — the "Development" panel that shows what
code relates to each issue:

- **Inbound ingest**: signed webhook receivers for GitHub / GitLab / Bitbucket (push, PR/MR,
  branch create, build/deploy status) mapped to issues via issue keys in branch names,
  commit messages, PR titles.
- **Development panel** on the issue page: branches, commits, pull requests (state, CI),
  builds/deployments — with links back to the repo.
- **Smart commits**: `TF-1 #comment ...`, `TF-1 #time 2h`, `TF-1 #done` execute issue ops
  from commit messages (Jira feature).
- **Events**: dev items emit TrackForge events (034 automation can react: "PR merged →
  transition to Done").
- **Admin**: repository connections (URL, provider, token/secret, project mapping).

## Why now

This is an "advanced/future" item in DESIGN (Phase 8) that's cheap now because the plumbing
(events, secrets, panels, automation) all exists. It's also the single feature dev teams
associate with Jira Software beyond boards.

## Scope

**In**: `DevRepository` connections (provider, base URL, webhook secret, project key
mapping) admin UI + API; signed receivers `/api/internal/dev/github|gitlab|bitbucket`
(HMAC verification, replay dedupe); entity extraction: `DevelopmentItem` rows
(branch|commit|pull_request|build|deployment) linked to issues by key scan;
issue page Development panel (grouped sections, counts, status badges, deep links);
smart-commit processor (`#comment`/`#time`/`#transition-name`/`#done`) executed as the
pushing user where mappable, else the connection's service account; `GET /rest/dev-status/`
-aligned native endpoints for panel data; MCP `get_dev_status`.

**Out**: two-way sync (TrackForge → repo comments — v2), GitHub App / OAuth app installation
flow (v1 = webhook + PAT style, documented), repo browsing inside TrackForge, VCS-specific
features beyond the shared model (e.g. Gerrit, Azure DevOps — adapter slots exist),
`#resolve`/`#close` aliases beyond documented commands.

---

## User stories

### US1 — Ingest (P1)

As a dev team, I want commits/branches/PRs to land on issues automatically.

**Independent test**: push `feat/TF-9-login` + commit `"TF-9 add oauth flow"` +
PR titled `TF-9 oauth` → issue panel shows all three within seconds.

**Acceptance scenarios**

1. **Given** a GitHub webhook + secret, **When** push/PR events arrive, **Then** HMAC verifies, payloads dedupe (delivery id), items persist linked to every issue key found (regex `[A-Z]+-\d+` in branch/commit/PR text).
2. **Given** GitLab/Bitbucket receivers, **When** their shapes arrive, **Then** provider adapters normalize into `DevelopmentItem` — panel code never branches on provider.
3. **Given** no matching key, **When** items ingest, **Then** they're stored unattributed (visible in repo admin view) — not dropped (re-linking later possible).
4. **Given** replay/forged payloads, **When** verified, **Then** bad signatures 401; duplicate deliveries idempotent.

### US2 — Development panel (P1)

As a user, I want code status on the issue.

**Acceptance scenarios**

1. **Given** the panel, **When** rendered, **Then** sections show: branches (name, repo, link), commits (sha, message, author, ago, link), PRs (title, state, reviewers?, link), builds/deployments (name, status, link) — Jira layout.
2. **Given** status changes (PR merged, build failed), **When** webhook updates arrive, **Then** items update in place; `dev_status_changed` event emits (034 can consume).
3. **Given** a merged PR on an open issue, **When** automation has a rule (034), **Then** e.g. "transition to In Review" can fire — the integration composes.

### US3 — Smart commits (P2)

As a dev, I want commit commands to do issue work.

**Acceptance scenarios**

1. **Given** `TF-9 #comment fixed the token path`, **When** pushed, **Then** a comment lands on TF-9 authored as the mapped committer (email→user match, else service account with attribution note).
2. **Given** `TF-9 #time 2h` / `TF-9 #done`, **When** processed, **Then** worklog (024) / transition (009) execute with `channel:'smartcommit'`; invalid commands don't fail the ingest — they log to the repo admin view.
3. **Given** commands on issues the user can't touch (015), **When** evaluated, **Then** denied commands are logged visible-to-admin, not silently executed.

### US4 — Admin (P2)

**Acceptance scenarios**

1. **Given** `/admin/development`, **When** adding a repo, **Then** provider+URL+webhook-secret+project map collected; a per-repo setup snippet shows the webhook URL+secret to paste into GitHub/GitLab.
2. **Given** a repo row, **When** viewed, **Then** recent deliveries, parse failures, unattributed items are listed for debugging.

---

## Edge cases

- Issue key collisions across projects (`TF-9` only exists once — keys are global, safe).
- Commit mentions N issues → item links to all.
- Deleted issue → dev items remain, panel hidden (existence protection).
- Webhook secret rotation → per-repo secrets, no global.
- `#time` before worklogs exist → graceful if 024 not yet installed (feature-flag).

## Functional requirements

- **FR-001**: Ingest MUST be signature-verified + replay-safe (delivery-id dedupe).
- **FR-002**: Providers MUST normalize into one `DevelopmentItem` model — adapters per §21 pattern.
- **FR-003**: Smart-commit execution MUST run as resolved user with `channel:'smartcommit'` and full audit (A2).
- **FR-004**: Dev items MUST emit TrackForge events for automation/realtime (A6).
- **FR-005**: The panel MUST degrade gracefully when no repos are connected (hidden/empty state, not errors).

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/dev/github` · `/gitlab` · `/bitbucket` | Signed receivers |
| GET/POST/PUT/DELETE | `/api/internal/dev/repositories` | Admin connections |
| GET | `/api/internal/dev/repositories/{id}/deliveries` | Debug view |
| GET | `/rest/api/2/issue/{key}` | `devSummary` in payload (Jira's aggregated dev-status shape, subset) |
| GET | `/api/internal/issues/{key}/development` | Panel data (branches/PRs/commits/builds) |

## Data model changes

- **DevRepository**: `id`, `provider`, `baseUrl`, `webhookSecret`, `projectKeyMap Jsonb`, `enabled`.
- **DevelopmentItem**: `id`, `repoId`, `type`, `externalId`, `title`, `url`, `authorName?`,
  `authorEmail?`, `state`, `payload Jsonb`, `createdAt`.
- **DevelopmentItemIssue**: `itemId`, `issueId` (many-to-many link).
- **DevDelivery** (receipt log: delivery id, status, error) for dedupe/debug.

## MCP tools added

`get_dev_status` (issue → branches/PRs/builds summary), `manage_dev_repositories` (admin),
`reprocess_delivery` (admin re-link/debug).

## AI-native checklist

- [ ] Dev data fully API-readable — panel renders what `get_dev_status` returns (A1).
- [ ] Ingest failures inspectable via API (A2/A8).
- [ ] Smart-commit actions appear in changelog/audit with attribution (A2).

## Success criteria

- **SC-001**: GitHub push+PR → panel populated; signature rejection verified.
- **SC-002**: `TF-9 #time 1h` + `TF-9 #done` produce worklog + transition with smartcommit attribution.
- **SC-003**: Merged PR emits event consumable by a 034 rule.
- **SC-004**: Agent eval: "what's the PR status on TF-9" returns live truth.

## Risks

| Risk | Mitigation |
|---|---|
| Provider payload drift | Versioned provider adapters + delivery log for replay/debug |
| Secret management | Webhook secrets server-side only, never echoed after save (006 secrets discipline) |
| Feature-flag dependency on 024/034 | Commands/events degrade gracefully when those sprints haven't shipped |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Docs: per-provider webhook setup guide.
- [ ] Demo fixture: scripted fake GitHub payloads for e2e.

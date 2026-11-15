# Sprint 019 — Components, Versions & Release Hub

| | |
|---|---|
| **Status** | Done — backend, importer, UI, MCP, CF pickers landed |
| **Milestone** | M1 Parity MVP |
| **Theme** | Jira parity — release management (DESIGN P1; required by most Jira projects being migrated) |
| **Depends on** | 015 (component leads via roles; `ADMINISTER_PROJECT`), 014 (version/component picker CF types), 010 (JQL fields added here), 011 (`version_released` event), 017 (importer contract) |
| **Unblocks** | Version/epic reports (027/028), version notifications (029), roadmap version pins (041), component/version import |
| **Spec-kit folder** | `specs/019-components-versions-release-hub/` |

> **Replan additions (2026-11-07):** (1) ship `EntityImporter`s for Jira components and
> versions (incl. issue `components`/`fixVersions`/`versions` fields and component default
> assignee); (2) Jira's issue field for affected versions is `versions` (UI label "Affects
> versions") — the payload uses `versions`, not `affectsVersions`; (3) version-picker and
> component-picker CF types close 014's deferred list.

## Goal

Jira's release model — what turns an issue tracker into release management:

- **Components**: named project sub-areas with a lead and optional default assignee;
  `components[]` on issues.
- **Versions**: named releases with `released`/`archived`/`startDate`/`releaseDate`/order;
  `fixVersions[]` and `affectsVersions[]` on issues.
- **Release hub**: per-version page — progress bar, issue list by status, "Release" action
  (stamps `releaseDate`), release notes/changelog generation.
- New JQL fields/functions: `component`, `fixVersion`, `affectedVersion`,
  `releasedVersions()`, `unreleasedVersions()`, `earliestUnreleasedVersion()`.
- Version/component **picker CF types** from 014's deferred list.

## Why now

Every later feature treats versions as real data: version/epic reports (027),
`version_released` notifications (029), migration import (017/039 imports components/versions
faithfully), and CF pickers need the entities to exist first.

## Scope

**In**: Jira endpoints `POST/GET/PUT/DELETE /component`, `GET /project/{key}/components`;
`POST/GET/PUT/DELETE /version`, `GET /project/{key}/versions`, `POST /version/{id}/move`,
`GET /version/{id}/relatedIssueCounts|unresolvedIssueCount`; issue fields
`components[]`/`fixVersions[]`/`affectsVersions[]` editable (update ops add/remove/set);
UI: Components page + Versions page in project sidebar, pickers on create/edit/detail,
release page (progress, issue grouping, release button, release notes export markdown/CSV);
JQL additions; archived versions hidden from pickers but renderable.

**Out**: version **start dates in a timeline UI** (041 roadmap view consumes dates later),
parallel version work tracking, dependency mapping between versions, auto-generated release
notes formats beyond md/CSV.

---

## User stories

### US1 — Components (P1)

As a project lead, I want components so work files under the right area with a clear owner.

**Independent test**: create component "Auth" w/ lead + default assignee; create issue
w/ component; JQL `component = Auth` finds it; detail shows component chips.

**Acceptance scenarios**

1. **Given** `POST /component {name, project, leadUserName?, assigneeType?}`, **When** created, **Then** it's Jira-shaped (`{id, name, project, lead, assigneeType}`); `GET /project/{key}/components` lists with issue counts.
2. **Given** component with `assigneeType: COMPONENT_LEAD`, **When** a new issue sets only that component, **Then** assignee defaults to the lead (Jira behaviour, documented).
3. **Given** the issue page, **When** `components` row, **Then** chips link to a filtered list; multi-select picker edits add/remove via update ops.

### US2 — Versions & release hub (P1)

As a release manager, I want versions and a release page so shipping is a first-class act.

**Acceptance scenarios**

1. **Given** `POST /version {name, project, released?, archived?, dates?}`, **When** created, **Then** ordering via `POST /version/{id}/move {position}`; `GET /project/{key}/versions` returns ordered list; archived versions excluded from pickers.
2. **Given** a version page, **When** rendered, **Then** progress bar (% resolved), counts (done/in-progress/todo), grouped issue list, start/release dates; "Release" stamps `releaseDate`, emits `version_released` event (029), and offers "release notes" (done issues as markdown/CSV grouped by type).
3. **Given** `fields.fixVersions`/`affectsVersions`, **When** edited, **Then** arrays of version refs work via set/add/remove ops with changelog; JQL `fixVersion = 1.2.0`, `affectedVersion in unreleasedVersions("TF")` resolve.
4. **Given** `fixVersion in releasedVersions()` semantics, **When** queried, **Then** only `released=true` versions match.

### US3 — CF pickers & admin (P2)

As an admin, I want version/component pickers as CF types so fields can reference releases.

**Acceptance scenarios**

1. **Given** CF types `version_picker`/`component_picker`, **When** created, **Then** they validate against project entities and render dropdown widgets (014 framework).
2. **Given** project settings, **When** Components/Versions tabs (021 stubs), **Then** full CRUD UI lives there (no separate admin console needed).

---

## Edge cases

- Deleting a component/version in use → Jira offers "remove refs" or "swap to another" — implement swap-or-remove dialog.
- Release an already-released version → idempotent no-op (Jira returns it as released).
- Issue in two projects can't share versions — pickers are project-scoped by construction.
- `fixVersions` on resolved issues with no `resolved` status → release notes still group by status category, not resolution field (documented choice).
- Moving an issue (022) to another project clears its components/versions with changelog.

## Functional requirements

- **FR-001**: Versions/components MUST be first-class entities with Jira-shaped endpoints — not label-like strings (migration fidelity, IV).
- **FR-002**: `version_released`/`component_*`/`version_*` MUST emit events for 011/029 (A6).
- **FR-003**: Component default-assignee MUST apply through create + bulk create + clone.
- **FR-004**: JQL fields MUST support `=`, `IN`, `IS EMPTY` + the three functions; archived≠released semantics enforced.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST/GET/PUT/DELETE | `/rest/api/2/component` · `/{id}` | Jira |
| GET | `/rest/api/2/project/{key}/components` | + issue counts |
| POST/GET/PUT/DELETE | `/rest/api/2/version` · `/{id}` | Jira |
| POST | `/rest/api/2/version/{id}/move` | Ordering |
| GET | `/rest/api/2/project/{key}/versions` | Ordered |
| GET | `/rest/api/2/version/{id}/relatedIssueCounts` · `/unresolvedIssueCount` | Jira |
| — | `fields.components[]`, `fixVersions[]`, `affectsVersions[]` | Payload + JQL |

## Data model changes

- **Component**: `id`, `projectId`, `name` (unique per project), `description?`, `leadId?`, `assigneeType?`.
- **Version**: `id`, `projectId`, `name` (unique per project), `description?`, `released`, `archived`, `startDate?`, `releaseDate?`, `sequence`.
- **IssueComponent** (`issueId`,`componentId`); **IssueVersion** (`issueId`,`versionId`,`kind: fix|affects`).

## MCP tools added

`manage_components`, `manage_versions`, `release_version` (dry-run shows issue rollup),
`get_release_notes`, `set_issue_versions` / `set_issue_components` via `update_issue`.

## AI-native checklist

- [ ] Release runs dry-run-able with the rollup it would produce (A4/A7).
- [ ] Version/component entities discoverable via pickers + createmeta (A3).
- [ ] `version_released` event emitted for agents/webhooks (A6).

## Success criteria

- **SC-001**: Create→assign→query→release→release-notes round-trip works UI + API + MCP.
- **SC-002**: JQL: `fixVersion in unreleasedVersions("TF") AND statusCategory != done` returns the release blocker list.
- **SC-003**: Component default-assignee applies on create/bulk/clone.
- **SC-004**: Agent eval: "release TF 1.2 and give me the notes" returns correct rollup markdown.

## Implementation status (slice 1 — backend, landed)

- **Schema** (migration `20261109020000_019_components_versions`): `Component`, `Version`,
  `IssueComponent`, `IssueVersion(issueId,versionId,kind: fix|affects)`; unique
  `(projectId,name)` on both entities.
- **Jira API surface**: full component CRUD + `relatedIssueCounts` + `?moveIssuesTo=` swap;
  full version CRUD + `move` (position/`after` ordering) + `release` (stamps `releaseDate`,
  emits `jira:version_released`) + `releasenotes` (done issues grouped by issue type) +
  `relatedIssueCounts`/`unresolvedIssueCount`; `GET /project/{k}/components|versions`.
- **Issue fields**: `components`/`fixVersions`/`versions` writable on create + update
  (fields-form = set; update-ops `set`/`add`/`remove` with changelog entries);
  serialized Jira-shaped on GET. Component `assigneeType: COMPONENT_LEAD` default-assignee
  applies when `assignee` is omitted on create.
- **JQL**: `component`, `fixVersion`, `affectedVersion` fields (`=`/`!=`/`IN`/`NOT IN`/
  `IS EMPTY`) + `releasedVersions([project])`, `unreleasedVersions(project)`,
  `earliestUnreleasedVersion(project)`, `latestReleasedVersion(project)` functions;
  `component`/`fixVersions`/`versions` exposed in createmeta/editmeta.
- **Importer**: `componentImporter`/`versionImporter` registered before `issueImporter`;
  issue apply resolves `components`/`fixVersions`/`versions` refs via `ExternalIdMap` with
  project-scoped name fallback.
- **Tests**: `tests/integration/components.test.ts` — 7 cases covering CRUD, ordering,
  default assignee, JQL, release notes, swap-on-delete, fixture import.

## Implementation status (slice 2 — UI, MCP & CF pickers, landed)

- **UI**: `/projects/:key/releases` — release hub: ordered version cards with progress
  bars (done/total via `relatedIssueCounts`), expandable issue groups by status category
  (`fixVersion` JQL), Release action, release notes viewer + markdown/CSV export,
  create/edit/archive/delete (swap-or-remove dialog), ↑↓ move ordering.
  `/projects/:key/components` — Jira-style CRUD table (name, lead, default assignee,
  issue counts, swap-on-delete). Sidebar gains Releases + Components nav items.
- **Issue pickers**: `EntityRefPicker` (chips + dropdown multi-select) on the issue
  detail sidebar (Components / Fix versions / Affects versions rows) and the create
  dialog; archived versions excluded from options but renderable when already set.
- **MCP**: `manage_components`, `manage_versions` (list/create/update/delete/move),
  `release_version` (dry_run returns the issue rollup), `get_release_notes`.
- **CF types**: `version_picker` / `component_picker` — project-scoped entity
  validation, denormalized `{id,name}` storage refreshed on read, dropdown editors
  in create dialog + issue detail.
- **compat.ts**: component/version endpoint families added to the matrix.

**Remaining**: issue-move cross-project ref clearing (022); timeline start-date UI (041).

## Risks

| Risk | Mitigation |
|---|---|
| Version ordering semantics (sequence vs date) | Explicit `sequence` int + `move` endpoint; UI drag maps to it |
| Release notes quality | v1 = grouped-by-type markdown; iteration later — honest scope |
| Affects vs fix confusion | Separate join kind; distinct pickers labeled Jira-style |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Sidebar gains Components/Versions links; 021 stub tabs now live.
- [ ] `compat.ts` extended for the component/version endpoint families.

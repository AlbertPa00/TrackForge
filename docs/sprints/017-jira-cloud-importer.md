# Sprint 017 — Jira Cloud Importer v1 & Importer-Extension Contract

| | |
|---|---|
| **Status** | Core complete — all v1 entities landed: `ImportJob`/`ExternalIdMap` schema, `EntityImporter` contract (discover→map→plan→apply→verify), ADF→Markdown, rate-limited Jira client + fixture source, stage machine on the durable runner, REST API + `/admin/migration` wizard, 3 MCP tools, delta `updated>=` wiring. Importers: user, group+members, project roles+actors, project, metadata, workflow shells (statuses+transitions name-matched; scheme assignment 031), custom fields+contexts+options+per-issue values, issue (labels/due/parent/points/flagged/ADF), comment, issue links+types, watcher, board+columns, sprint, filter. Fixture e2e: dry-run purity, provenance, idempotent rerun, resume, cred safety. Deferred by design: attachments (018), components/versions (019), remote links (022), worklogs (024), dashboards (026), notification schemes (029), scheme-level workflow config (031), Server/DC XML + CSV sources (039). |
| **Milestone** | M1 Parity MVP |
| **Theme** | Adoption unlock (constitution IV) — moved early; grows every sprint after |
| **Depends on** | 014 (CF registry + import contract), 015 (groups/roles/schemes contract), 016 (job runner, perf fixture), 009–013 (workflows, boards, sprints, story points) |
| **Unblocks** | Real pilots from Jira; a real-data parity harness for every later sprint |
| **Spec-kit folder** | `specs/017-jira-cloud-importer/` |

## Goal

Make it possible to move a real team from **Jira Cloud** to TrackForge at the end of M1, and
turn every later sprint into an importer extension instead of a big-bang migration sprint:

- **Staged, resumable import job** from a live Jira Cloud site (REST v2/v3 read, API-token auth).
- **Entity coverage v1** — everything TrackForge has by now: users, groups, project roles &
  actors, projects (+lead, category name kept as label until 021), issue types, statuses,
  priorities, resolutions, workflows (status mapping onto existing workflows), custom fields
  (+contexts/options/values for the 12 supported types), issues (summary, description,
  type, status, priority, resolution, assignee/reporter, labels, due date, parent/subtasks/epic
  children, story points, flagged, start date, created/updated), comments (+author, timestamps;
  ADF→markdown basic converter), issue links + link types, watchers (011), sprints +
  membership + boards (default board + column mapping) and filters (JQL string preserved,
  validated against our grammar with warnings).
- **Mapping step**, **dry-run report**, **commit**, **validation report** (§20.8).
- **`ExternalIdMap`** (D15): Jira id ↔ TrackForge id for every imported row — enables resume,
  idempotent re-import (delta runs), and provenance for agents.
- **Importer-extension contract**: an `EntityImporter` interface (`discover`, `map`, `plan`,
  `apply`, `verify`) that every later sprint implements for its entities (DoD item, roadmap §4).

## Why now (and not last)

The old plan put migration at the end. That delayed adoption by ~16 sprints and meant real Jira
data would only test the data model after everything was built on it. Importing early makes
real data the parity test from M1 onward; each later sprint adds its entities.

## Scope

**In**: as above; UI wizard (source → discovery summary → mapping → dry-run report → import
progress → validation report) under `/admin/migration`; ADF→markdown converter for the common
node set (paragraph, text marks, headings, lists, code, quote, rule, hardBreak, link, mention →
`[~accountId:]`, table; others degrade to text with a warning) — reused and extended by 040;
rate-limit aware fetching (honour `Retry-After`, concurrency cap); delta re-run (only changed
issues since last run via `updated >= lastRun`).

**Out** (with owner): attachments → **018**; components/versions → **019**; worklogs/time
tracking → **024**; votes/remote links → **022**; dashboards → **026**; notification schemes →
**029**; screens/field configs/issue security/workflow schemes → **031**; Jira Server/DC XML and
CSV sources + export → **039**; history (changelog) import beyond a boundary marker → **039**.
Unsupported entities appear in the report as "not yet supported (sprint NNN)" — never silently
dropped.

---

## User stories

### US1 — Staged, resumable job (P1)

As an admin, I want migration to be a safe, inspectable operation, not a script.

**Independent test**: import a fixture Jira Cloud site (recorded HTTP fixtures in CI; live
site optional) → kill the worker mid-commit → resume → validation report shows zero
unexplained differences.

**Acceptance scenarios**

1. **Given** `POST /api/internal/migration/jira-cloud {baseUrl, email, apiToken(secret ref), projectKeys[]}`, **When** started, **Then** a job progresses `discovering → mapping → planned → importing → verifying → done|failed`, with per-entity counts at each stage (`GET /migration/{id}`).
2. **Given** the planned stage, **When** the dry-run report is produced, **Then** nothing has been written to domain tables; the report lists creates/updates/skips/warnings/errors per entity type (A4/A7).
3. **Given** a crash during `importing`, **When** resumed, **Then** already-applied items are skipped via `ExternalIdMap`; no duplicates (idempotent per external id).
4. **Given** a second run later (`mode: delta`), **When** executed, **Then** only issues/comments updated since the last run are re-applied.

### US2 — Mapping (P1)

As an admin, I want control over how Jira things become TrackForge things.

**Acceptance scenarios**

1. **Given** discovery, **When** the mapping step opens, **Then** auto-proposals are shown (by name/key) for statuses, issue types, priorities, resolutions, link types, CFs, users (by email); each is overridable: map-to-existing / create-new / skip.
2. **Given** Jira statuses with no counterpart in the target workflow, **When** mapping, **Then** the admin must choose a target status per source status (009 mapping rules); the wizard blocks until resolved.
3. **Given** users, **When** mapped, **Then** options are: link to existing (email match), create (inactive or active), or map to a service account with attribution preserved in a `migratedFrom` note. Groups/roles/permission grants are **always explicit** (no silent defaults on security-relevant mappings).
4. **Given** unsupported CF types, **When** mapping, **Then** they can be skipped or mapped to text (lossy, flagged in the report).

### US3 — Faithful issues (P1)

As a team, I want my issues to arrive intact.

**Acceptance scenarios**

1. **Given** imported issues, **When** compared with the source, **Then** keys are preserved when the project key is free (`TF-123` stays `TF-123`; `Project.issueCounter` set to max+1); otherwise the admin picks a new key and an `IssueKeyAlias` maps old→new (022 alias table introduced here).
2. **Given** ADF descriptions/comments, **When** converted, **Then** supported nodes map to markdown, mentions become `[~accountId:<mapped id>]`, unsupported nodes degrade with a per-issue warning.
3. **Given** original authors/timestamps, **When** imported, **Then** comments keep original author (mapped) and `created`; issues keep `created`/`updated`; changelog gets one "Imported from Jira" boundary entry with `channel: 'import'`.
4. **Given** sprints and boards, **When** imported, **Then** sprint states/dates/goals and membership are preserved; the default board's column mapping reproduces the source board columns where statuses are mapped.

### US4 — Validation report & extension contract (P1)

1. **Given** completion, **When** `GET /migration/{id}/report`, **Then** a §20.8 report returns: per-entity source vs imported counts, field-level diff samples, warnings (lossy conversions), unsupported entities with the sprint that will add them, and errors with remediation hints; downloadable as JSON/CSV.
2. **Given** the `EntityImporter` interface, **When** a later sprint adds an entity, **Then** it registers an importer and the report automatically includes it — enforced by a test that every registry entity with `importable: true` has an importer.

---

## Edge cases

- Jira API rate limits → exponential backoff honouring `Retry-After`; job remains resumable.
- Deleted/anonymised Jira users ("Former user") → mapped to a placeholder inactive user.
- Issues the API token can't see → reported as "not visible to the importing account" (not errors).
- Project key collision with an existing TrackForge project → choose: merge into existing (issue number collisions resolved by alias) or new key.
- Very large projects (100k issues) → paged streaming; perf budget: ≥ 50 issues/s on the 016 baseline hardware with comments.

## Functional requirements

- **FR-001**: Imports MUST be dry-run-able end-to-end before any domain write (A4/A7).
- **FR-002**: All writes MUST go through domain services (validation, permissions as a privileged `import` actor, changelog/audit with `channel: 'import'`, events) — no raw inserts into domain tables.
- **FR-003**: Every imported row MUST have an `ExternalIdMap` entry; re-runs MUST be idempotent.
- **FR-004**: Secrets (Jira API token) MUST be stored as encrypted refs, never logged or returned (016 log test covers it).
- **FR-005**: Every sprint after 017 that adds an importable entity MUST ship its `EntityImporter` (roadmap §4 DoD).

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/migration/jira-cloud` | Create job (DESIGN §18.5 names `jira-api`; alias kept) |
| GET | `/api/internal/migration/{id}` · `/report` | Status + §20.8 report |
| PUT | `/api/internal/migration/{id}/mapping` | Save mapping decisions |
| POST | `/api/internal/migration/{id}/{plan|commit|resume|cancel}` | Stage control |
| GET | `/api/internal/migration` | Job list (admin) |

## Data model changes

- **MigrationJob** (`id`, `actorId`, `source`, `config Jsonb` (no secrets), `secretRef`, `stage`, `stats Jsonb`, `mapping Jsonb`, `report Jsonb`, `status`, `createdAt`, `finishedAt?`).
- **ExternalIdMap** (`source`, `entityType`, `externalId`, `internalId`, `jobId`, unique `(source, entityType, externalId)`).
- **IssueKeyAlias** (`oldKey` unique, `issueId`) — resolved by `parseIssueKey`.

## MCP tools

Admin toolset: `start_migration`, `get_migration`, `get_migration_report`, `commit_migration`
(refuses unless a dry-run report exists for the current mapping — A7).

## AI-native checklist

- [ ] Every stage observable via API — an agent can babysit a migration (A1).
- [ ] Report is machine-readable with remediation hints (A8).
- [ ] Commit is gated on a reviewed dry-run (A7); re-runs are safe (A4).

## Success criteria

- **SC-001**: Recorded-fixture Jira Cloud project (≥ 500 issues, CFs, sprints, comments, links, subtasks, epics) imports with zero unexplained diffs.
- **SC-002**: Kill-and-resume produces no duplicates; delta run applies only changes.
- **SC-003**: Pilot: one real internal Jira Cloud project imported and used for a week (feeds 020 gate).
- **SC-004**: Agent eval: "import project ABC from Jira and summarise what couldn't map" returns an accurate report.

## Risks

| Risk | Mitigation |
|---|---|
| Jira Cloud API shape drift | Recorded fixtures + contract tests; adapter per resource |
| ADF fidelity | Supported-node table, warnings per issue; full converter in 040 |
| Status/workflow mapping complexity | Mandatory explicit mapping for unmapped statuses; reuses 009 mapping logic |
| Scope creep toward "import everything" | Unsupported entities reported with their owning sprint; extension contract carries them |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Threat-model entry: outbound requests to a customer-provided base URL (SSRF guard), secret storage.
- [ ] `docs/migration.md` — supported entities, mapping rules, known lossy conversions, extension contract.

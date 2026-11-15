# Sprint 039 — Importers II (Server/DC XML, CSV, Full History) & Round-Trip Export

| | |
|---|---|
| **Status** | Epic (draft) — Wave 5; scenarios are candidates, re-validate at wave planning |
| **Milestone** | M5 Enterprise & reach |
| **Theme** | Migration completeness — constitution IV, DESIGN §20 |
| **Depends on** | 017 (job engine, mapping wizard, `ExternalIdMap`, `EntityImporter` contract — every entity importer shipped since), 023 (CSV serializer), 031 (scheme objects), 036 (identity linking for user mapping) |
| **Unblocks** | Jira Server/Data Center migrations; TrackForge backup/restore; GA migration claim (046) |
| **New dependencies (justify in plan)** | `fast-xml-parser` or a SAX parser (streaming `entities.xml`), `yauzl` (streamed zip), `papaparse` (CSV) |
| **Spec-kit folder** | `specs/039-importers-xml-csv-export/` |

> **Replan note (2026-11-07):** the former "migration last" sprint was split. The Jira **Cloud**
> importer, the job engine, mapping wizard and validation report moved to **017** (M1), and every
> sprint since added its own `EntityImporter`. This epic adds the **remaining sources**,
> **full changelog import**, and **export** — all reusing the 017 engine.
>
> **Replan note 2 (2026-11-07):** sprint **048** adds a live-REST `jira-server` source
> (Server/DC `/rest/api/2` adapter), covering the common Server migration path ahead of this
> epic. The XML backup source here remains for air-gapped/export-only instances — scope unchanged.

## Goal

- **Jira Server/DC XML backup** source: streamed zip (`entities.xml` + attachments directory),
  parsed into the same discovery → mapping → plan → commit pipeline.
- **CSV** source: Jira CSV semantics (Issue key, Summary, Issue Type, Parent, Sprint, multi-value
  columns, attachment URLs), column-mapping step, preview of the first N rows.
- **Full history import**: Jira changelogs imported as native `ChangeHistory`/`ChangeItem`
  rows (author, timestamp, field items) where fields map; unmapped items kept as text items;
  replaces 017's single boundary marker for projects re-imported with history.
- **Export**: project export (JSON + attachments archive) for backup/restore; issue export
  (CSV/JSON — 023 serializer); **Jira-compatible XML** export of the entities Jira can consume.
- **Round-trip proof**: TrackForge → export → re-import into a clean instance → diff report ≈ 0.

## Candidate user stories

### US1 — Server/DC XML (P1)
1. **Given** a 2 GB backup zip, **When** uploaded, **Then** it is streamed (bounded memory), discovered, and goes through the 017 mapping and dry-run steps; attachments are read from the zip.
2. **Given** Jira versions 8.x–10.x XML, **When** parsed, **Then** a versioned parser handles each; unknown entities are reported, not fatal.

### US2 — CSV (P2)
1. **Given** a CSV, **When** columns are mapped (with auto-proposals by header name), **Then** a preview shows the first 20 issues as they would be created; commit uses the same job engine.
2. **Given** parent/subtask rows referencing each other by key or id, **When** imported, **Then** hierarchy is reconstructed in dependency order.

### US3 — History (P2)
1. **Given** changelog import enabled, **When** imported, **Then** the issue's History tab shows original authors/timestamps; reports (027/028) can use imported history (flagged as imported in data-confidence notes).

### US4 — Export & round-trip (P1)
1. **Given** `GET /api/internal/export/project/{key}`, **When** run (as a job), **Then** a JSON + files archive contains everything the 017/039 importers need to restore the project.
2. **Given** export → import into a clean instance, **When** diffed, **Then** entity counts and core fields match; differences are listed with reasons.
3. **Given** `POST /api/internal/export/project/{key}/xml`, **When** produced, **Then** Jira-parseable XML is emitted for Jira-representable entities; TF-native entities are listed as skipped.

## Key constraints

- Reuse the 017 engine — no second job model, mapping UI or report format.
- Streaming everywhere (zip, XML, CSV, export) — memory bounded independent of size.
- Upload limits and zip-bomb/path-traversal protection (threat-model entry required).
- Imports idempotent via `ExternalIdMap` keyed by source (`jira-server:<serverId>`, `csv:<file hash>`).

## API surface (candidate)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/migration/jira-xml` · `/csv` | DESIGN §18.5 |
| GET | `/api/internal/export/project/{key}` · `/export/project/{key}/issues` | Backup / CSV-JSON |
| POST | `/api/internal/export/project/{key}/xml` | Jira-compatible XML |

## MCP

Reuses 017's admin migration tools with new `source` values; adds `export_project` (admin).


---

## Implementation status — Done (backend-complete)

- **US-XML**: `xmlSource.ts` — yauzl zip stream → `entities.xml` (fast-xml-parser)
  → Jira-Cloud-shaped fixture map; users/projects/issues/comments/links/
  components/versions/worklogs/changelog normalized; `POST /migration/jira-server-xml`.
- **US-CSV**: `csvSource.ts` — RFC-4180 parser (quoted commas/quotes/newlines),
  repeated multi-value headers, `;`-packed comments, Parent, Sprint column
  (synthetic agile fixture + IssueSprint link at issue apply), attachment URLs
  (fixture getBinary fetches http(s) w/ 15s timeout + 25MB cap); `POST /migration/csv`
  + `POST /migration/csv/preview` (header→field mapping + first-N rows).
- **US-HIST**: `historyImporter` — `fields.changelog.histories` → native
  `ChangeHistory`/`ChangeItem` (channel='import', imported author+timestamp,
  unmapped fields preserved as text items).
- **US-EXP**: `GET /migration/export/{projectKey}` → same fixture map; feeds
  straight back into `POST /migration/jira-cloud` — verified full round-trip.
- Import order changed: board → sprint → issue (sprints attach to the real
  board, CSV sprint cells resolve at issue apply).
- Tests: csvImport 6/6, xmlImport 3/3, exportRoundTrip 2/2, import regression 6/6.
- **Deferred**: XML attachments inside the zip (paths recorded, not fetched —
  needs zip-binary plumbing into the source); XML sprint tables (AO_60DB71_*
  agile schema); CSV custom-field column syntax beyond story-points/flagged;
  migration UI wizard (API-only this sprint).

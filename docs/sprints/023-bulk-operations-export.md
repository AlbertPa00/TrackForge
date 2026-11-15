# Sprint 023 — Bulk Operations & Export

| | |
|---|---|
| **Status** | Implemented — bulk ops, jobs, retry, CSV/print export, and the navigator wizard UI (see notes) |

> **Implementation notes (2026-11-12):** `BulkJob` + `POST /api/internal/bulk/{op}`,
> `GET /job/{id}`, `POST /job/{id}/retry`, `GET /export/issues?format=csv|print`,
> `GET /export/issue/{key}?format=print` shipped. Ops run per-issue through the
> same service paths (FR-001) on the durable runner; missing/out-of-scope keys
> fail per item rather than rejecting the request (SC-002). MCP tools
> `bulk_change`/`get_bulk_job`/`export_issues`/`print_issue` added; `bulk_change`
> enforces plan-first via its description + dry_run.
> **Navigator UI (2026-11-12b):** checkbox selection on `IssueTable` (header =
> select-page), bulk-action bar with "select all N matching this search" → JQL
> selection, `BulkWizard` modal (operation → payload → dry-run plan → execute →
> polled progress + per-item results + retry-failures), and an Export dropdown
> (CSV / printable view) next to the column chooser. Transition ops accept a
> `statusName` resolved per issue's workflow (no shared transition id needed).
> **Still deferred per scope:** >500 chunked batches, XLSX binary, scheduled
> bulk ops, Shift/Ctrl+click range-select, per-screen field-map filtering (the
> wizard edits common fields only), job revisit-by-id page.
| **Milestone** | M2 Daily-driver parity |
| **Theme** | Jira parity — list-view power features (DESIGN P1) |
| **Depends on** | 010 (JQL for selection), 013 (multi-select interaction model), 015 (per-item permissions), 016 (**job runner** — bulk jobs run on it, not in-process), 022 (move/clone ops reuse), 011 (SSE for progress) |
| **Unblocks** | Operational tooling; export parity; 039 export reuses the CSV serializer |

> **Replan corrections (2026-11-07):** jobs run on the 016 `JobRunner` (D20) — the "in-process
> runner now, BullMQ later" wording below is superseded. `BulkJob` rows remain the
> user-facing record (results table, retry-failures); execution state lives in the runner.
| **Spec-kit folder** | `specs/023-bulk-operations-export/` |

## Goal

Jira's "bulk change" is how real teams maintain a tracker at scale — and the biggest
list-view hole left. This sprint adds:

- **Bulk change wizard**: select issues (checkboxes on the navigator or a JQL) → choose
  operation → map fields → preview → run → results table.
- Operations: **edit fields, transition, move project, delete, assign, add/remove labels,
  comment, watch/unwatch, link issues** — each permission-checked per issue.
- An async **bulk job** model (dry-run plan → execute with progress → per-item result table)
  because hundreds of writes can't sit in one request.
- **Export**: CSV / Excel-friendly CSV / printable view from the navigator (respecting the
  active JQL + columns + permissions), plus print-friendly single-issue view.

## Why now

The navigator can't maintain more than a toy dataset without bulk ops; and export is both a
Jira-parity feature and half the plumbing migration export (017/039) reuses.

## Scope

**In**: checkbox selection + "all matching JQL" selection (with cap, default 500);
`POST /api/internal/bulk/{edit|transition|move|delete|comment|watch|link}` per §18.5 — each
accepts `{issueKeys? | jql}`, a payload, `dryRun`; returns `jobId`; `GET /api/internal/bulk/{jobId}`
streams status `{total, done, succeeded, failed, errors[]}` via SSE or polling;
wizard UI (3 steps + results, Jira layout); per-op field-map step reusing 014 screens/CFs and
022 move mapping; export `GET /api/internal/export/issues?jql=&format=csv|xlsx|print&columns=`
and `/export/issue/{key}?format=print`; column-aware CSV (labels→comma-quoted, CFs included).

**Out**: bulk edit >500 issues/chunked batches (job supports it; UI caps — documented),
scheduled/recurring bulk ops, Jira's `/rest/api/2/bulk/issues/*` endpoints (no such public API —
TrackForge native only, documented), XLSX binary (CSV opens in Excel — format alias documented).

---

## User stories

### US1 — Select & plan (P1)

As a user, I want to pick issues precisely and preview the change before it happens.

**Independent test**: select 5 issues by checkbox + 200 by "all matching JQL"; edit shows the
affected count; dry-run lists every per-issue effect.

**Acceptance scenarios**

1. **Given** navigator rows, **When** checkboxes/Shift+click/Ctrl+A select, **Then** a bulk bar shows count and "all N matching the JQL" option.
2. **Given** an operation chosen, **When** the wizard advances, **Then** the field-map step renders only fields valid for all selected issues' screens/types (014) — invalid combos excluded with reasons.
3. **Given** `dryRun`, **When** posted, **Then** the response is a per-issue plan `{key, changes, errors[]}` — permission failures, validation failures, and skips all named (A4/A8).

### US2 — Execute & report (P1)

As a user, I want bulk changes to run safely and tell me exactly what happened.

**Acceptance scenarios**

1. **Given** a confirmed plan, **When** the job runs, **Then** each issue is written through the *same service paths* as single-issue ops (changelogs, audit, events, idempotent) — never raw bulk SQL.
2. **Given** job progress, **When** the UI polls/SSEs, **Then** a live progress bar + per-item status table renders; the page can be left and revisited by job id.
3. **Given** per-item failures, **When** the job completes, **Then** successes committed and failures listed with reasons; no partial silence; a "retry failures" option replays just those.

### US3 — The operations (P1)

**Acceptance scenarios**

1. **Edit**: set/append/remove scalar fields + labels + CFs — per-op validation identical to `PUT /issue`.
2. **Transition**: one transition id applied where valid per issue's workflow; issues where invalid are failed-named not silently skipped.
3. **Move**: shared target project+type (022 move engine); required-field map collected once, applied per issue.
4. **Delete**: uses the 008 delete-preview/confirm flow per issue (subtask rules enforced); `DELETE_ISSUES` checked per issue.
5. **Comment/watch/link/assign/labels**: thin wrappers over existing endpoints, batched.

### US4 — Export (P1)

As a user, I want the filtered list out of the tool.

**Acceptance scenarios**

1. **Given** `GET /export/issues?jql=...&format=csv&columns=key,summary,status`, **When** downloaded, **Then** CSV rows respect JQL result set **and** security filtering (015); CF columns included when requested; UTF-8 BOM for Excel.
2. **Given** `format=print`, **When** opened, **Then** a print-friendly HTML view renders the same columns.
3. **Given** `export/issue/{key}?format=print`, **When** viewed, **Then** a clean single-issue print page (fields + description + comments) exists for PDF-print workflows.

---

## Edge cases

- Selection exceeds cap → explicit message with the cap and JQL-narrowing hint (Jira caps at 1000).
- Issue locked mid-job by another change → per-item conflict failure, doesn't abort the job.
- Job actor token expires mid-run → job continues (server-side actor), attribution preserved.
- Export of huge result → streamed response; cap 10k rows with notice.
- Labels with commas → RFC-4180 quoting (the 008 `join(',')` bug pattern avoided).

## Functional requirements

- **FR-001**: Bulk jobs MUST reuse per-issue service paths — identical validation, changelog, events, permissions per item.
- **FR-002**: Every bulk op MUST support `dryRun` returning the full per-item plan (A4).
- **FR-003**: Jobs MUST be resumable/inspectable by id and survive server restarts (persisted rows, not in-memory).
- **FR-004**: Export MUST apply identical permission/JQL filtering as `/search` — no data exfil channel.
- **FR-005**: Bulk ops MUST emit one audit event per affected issue + one summary event.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/bulk/{edit|transition|move|delete|comment|watch|link}` | `{issueKeys?|jql, payload, dryRun}` → `jobId` or plan |
| GET | `/api/internal/bulk/{jobId}` | Status + per-item results; SSE upgrade |
| POST | `/api/internal/bulk/{jobId}/retry` | Failures only |
| GET | `/api/internal/export/issues?jql=&format=csv|print&columns=` | Navigator export |
| GET | `/api/internal/export/issue/{key}?format=print` | Single issue print |

## Data model changes

- **BulkJob**: `id`, `actorId`, `op`, `selection Jsonb`, `payload Jsonb`, `status`, `total`, `done`, `succeeded`, `failed`, `results Jsonb`, `createdAt`, `finishedAt?`.

## MCP tools added

`bulk_change` (op + selection + payload; always plans first, confirms before execute — A7),
`get_bulk_job`, `export_issues` (CSV to file path), `print_issue`.

## AI-native checklist

- [ ] Agents must preview (`dryRun`) before execute — enforced for `bulk_change` (A4/A7).
- [ ] Job results are machine-readable per item (A8).
- [ ] `Idempotency-Key` on job creation prevents double-runs (A4).

## Success criteria

- **SC-001**: Bulk-transition 50 issues → changelogs/events identical to 50 single transitions.
- **SC-002**: Mixed-permission selection → ineligible issues fail-named, rest succeed; retry-failures works.
- **SC-003**: CSV export of a JQL matches on-screen rows incl. CF and label columns.
- **SC-004**: Agent eval: "label all unresolved TF bugs 'triage'" — plan shown, confirmed, executed, failures reported.

## Risks

| Risk | Mitigation |
|---|---|
| Job engine complexity (queues) | Runs on the 016 `JobRunner`/BullMQ (D20); `BulkJob` rows are the user-facing record |
| Long jobs hold transactions | Per-issue transactions; job row tracks progress between them |
| Export encoding edge cases | Central CSV serializer; tested with commas/quotes/unicode/CFs |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] §18.5 export/bulk matrix updated in `compat.ts` (marked native).
- [ ] Load test: 500-issue bulk edit completes with linear-ish timing and no lock errors.

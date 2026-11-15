# Sprint 048 — Jira Server/DC Importer (Live REST Source)

| | |
|---|---|
| **Status** | In progress — US1–US5 shipped + all local SCs green: `jira-server` source (api/3→api/2 adapter + override table), PAT/basic + credential confinement + SSRF guard, user-bean normalization + union discovery, preflight + field-alias resolution, route + MCP tool, `insecureSkipVerify` wired via lazy undici dispatcher, docs/migration.md. Verified: SC-001 (500-issue recorded fixture e2e, zero diffs), SC-002/003/004/005. Open: SC-006 pilot (needs a real Server/DC instance). |
| **Milestone** | M2 Daily-driver parity — scheduled by need; can start as soon as pulled forward |
| **Theme** | Adoption unlock (constitution IV) — "migrate from any Jira", sibling to 039's XML/CSV sources |
| **Depends on** | 017 (job engine, `JiraSource` contract, `ExternalIdMap`, dry-run/report pipeline); entity importers shipped in 018 (attachments), 019 (components/versions), 024 (worklogs) |
| **Unblocks** | Jira Server/Data Center → TrackForge migrations over live REST; narrows 039's XML source to offline/export-only cases |
| **New dependencies (justify in plan)** | none — pure adapter over the existing `JiraSource` contract |
| **Spec-kit folder** | `specs/048-jira-server-dc-importer/` |

## Goal

A `jira-server` source that runs the 017 pipeline (`discover → map → plan → apply → verify`,
dry-run, resume, delta, idempotent `ExternalIdMap`) against a **live Jira Server or Data Center**
instance over `/rest/api/2` and `/rest/agile/1.0`, with two hard guarantees:

- **Nothing silently lost** — every reachable entity is imported or appears in the report with a
  reason and remediation; every importer-emitted path is covered by an explicit Server mapping
  (contract-tested, no silent 404s).
- **Nothing leaked** — credentials are only ever sent to the configured origin; secrets are held
  via `secretRef`/job creds, never in reports, logs, or the wizard.

## Why a REST adapter (and why now)

039 designs a Server/DC **XML backup** importer for M5. Most Server migrations can happen much
earlier: the 017 pipeline is source-agnostic (`JiraSource` = `get`/`paged`/`getBinary`), and
Server's v2 shapes are near-identical to the Cloud v2/v3 payloads the importers already consume.
A path-rewrite + identity-normalization adapter unlocks Server/DC with a fraction of the XML
effort. The XML source remains in 039 for air-gapped/export-only instances.

## Verified Server/DC divergences (official Atlassian docs)

Everything below is confirmed against the Server/DC REST reference
(`developer.atlassian.com/server/jira/platform/rest/`, `docs.atlassian.com/software/jira`) — the
"no data lost" contract is only as good as this table:

| # | Cloud assumption in the 017 importer | Server/DC reality | Handling |
|---|---|---|---|
| 1 | All calls use `/rest/api/3/*` (32 sites in `importers.ts`) | Server/DC serves **`/rest/api/2` only**; api/3 → 404 | Source-level path rewrite `api/3 → api/2`; per-endpoint overrides for the rows below; contract test enumerates every path the registry can emit |
| 2 | Users keyed by `accountId` | No `accountId` exists. Users have `key` (stable across username renames) and `name` | Normalize user beans at the source: inject `accountId = key ?? name`. Also add `accountId ?? key ?? name` fallbacks in the ~8 mapper sites that read `?.accountId` only (assignee/reporter, comment & worklog author, watchers, filter owner, role actors) — today these silently import without attribution |
| 3 | Basic `email:apiToken` | Basic `username:password` (all versions); **PAT `Authorization: Bearer`** on Jira ≥ 8.14 (confluence.atlassian.com/enterprise PAT docs) | `authMode: 'basic' \| 'pat'`; basic reuses existing cred plumbing; PAT adds a Bearer header mode |
| 4 | Descriptions/comments are ADF JSON | Server v2 returns **wiki-markup text** (rendered HTML via `expand=renderedFields`) | `adfToMarkdown` already passes strings through verbatim — import wiki text as-is, flagged in the report as lossy (wiki ≠ markdown; conversion not promised here) |
| 5 | `GET /rest/api/3/workflow/search` (paged) | Cloud-only. Server: `GET /rest/api/2/workflow` returns **all** workflows, full steps; requires admin permission | Override: single fetch, client-side filter; on 403 degrade to statuses-only import with a warning |
| 6 | `GET /rest/api/3/filter/search` | **No filter enumeration exists on Server** — only `GET /rest/api/2/filter/favourite` (caller's favourites) and `GET /rest/api/2/filter/{id}` | Import service-account favourites + every filter id referenced by imported board configs; report the rest as non-enumerable with remediation ("favourite the filter as the import user") |
| 7 | `GET /rest/api/3/field/{id}/context` (+options) | No contexts API on Server. Option values are enumerable via **`createmeta`/`editmeta` `allowedValues`** per project+issuetype, plus values observed on issues | CF importer on a server source gathers `allowedValues` from `GET /rest/api/2/issue/createmeta?expand=projects.issuetypes.fields`; per-project field configs collapse to a global context with a warning |
| 8 | `GET /rest/api/3/users/search` | `GET /rest/api/2/user/search?username=.&includeInactive=true` — **first-1000 cap**; pre-8.20.6 bug JSWSERVER-21156 caps ~100 | Union of three strategies: `user/search`, `/rest/api/2/group/member` for configured `groups[]`, and `GET /rest/api/2/user?key=` lookups for every user ref seen on issues/comments/worklogs/watchers. Version gate warns on <8.20.6 |
| 9 | CF ids hardcoded: story points `customfield_10016`, flagged `customfield_10021` | Cloud conventions; Server ids are instance-specific (Epic Link/Name, Sprint, Story Points, Flagged vary) | Resolve by name via `GET /rest/api/2/field` at job start → `fieldAliases` map in stageData; admin-overridable in the start payload |
| 10 | Cloud 429 + `Retry-After` | Server has no built-in rate limiting; DC rate limiting (optional, admin-set) returns 429 | Existing client handles both; keep conservative concurrency |
| 11 | Changelog out of scope | `expand=changelog` **works on Server search** — full history is reachable | Still 039 scope (native ChangeHistory import); 048 keeps the single boundary marker and reports `history: not yet supported (sprint 039)` |
| 12 | `/rest/agile/1.0/*` | Identical on Jira Software Server/DC | No change — boards, sprints, board configuration work as-is |
| 13 | Absolute URLs are same-origin (`self`, attachment `content`, agile `nextPage`) | Mostly same-origin, but Server responses can carry off-origin absolute URLs | **Credential confinement**: `Authorization` only attached when `url.origin === configuredBaseUrl.origin`; off-origin fetches go bare + warning (see US4) |
| 14 | — | `GET /rest/api/2/serverInfo` returns version, buildNumber, baseUrl — `deploymentType` absent on Server/DC | Preflight probe: refuses Cloud URLs on the `jira-server` endpoint (and vice versa), records version in the job for the compat gate |

## User stories

### US1 — Server source & auth (P1)

As an admin, I want to point the importer at my self-hosted Jira with safe credentials.

**Acceptance scenarios**

1. **Given** `POST /api/internal/migration/jira-server {baseUrl, authMode:'basic', username, apiToken|secretRef, projectKeys[], dryRun:true}`, **When** started, **Then** a preflight `GET /rest/api/2/serverInfo` confirms Server/DC, records the version, and the job enters `discovering`.
2. **Given** `authMode:'pat'`, **When** the source makes any request, **Then** it sends `Authorization: Bearer <token>` (never Basic); PAT is stored as `secretRef`/job cred only — never in report, logs, or `GET /migration/{id}` output.
3. **Given** a Cloud `*.atlassian.net` baseUrl on the jira-server endpoint, **When** preflight runs, **Then** it fails with a remediation hint pointing at `/migration/jira-cloud` (and symmetrically).

### US2 — Path adaptation at the boundary (P1)

As a maintainer, I want one choke point for Server differences, not 30 edited importers.

**Acceptance scenarios**

1. **Given** any importer calling `/rest/api/3/x`, **When** the server source handles it, **Then** the request goes out as `/rest/api/2/x` (query unchanged) unless a declared override exists.
2. **Given** the override table (users/search, workflow, filter/search, field contexts, groups picker), **When** a Cloud-only path is hit, **Then** the override's Server strategy runs or a declared-unsupported op is planned with reason — never an unhandled 404.
3. **Given** a registry contract test, **When** it enumerates every path pattern any importer can emit, **Then** each has a rewrite or override entry; the test fails when a new importer adds an unmapped path.

### US3 — Identity & entity fidelity (P1)

As an admin, attribution and fields survive the move.

**Acceptance scenarios**

1. **Given** Server user beans (`key`, `name`, no `accountId`), **When** any entity references a user, **Then** the source normalizes `accountId := key ?? name` so assignee/reporter/comment/worklog/watcher/role-actor/filter-owner attribution imports identically to Cloud jobs.
2. **Given** a user renamed between runs, **When** re-importing, **Then** no duplicate user is created (`key` is the external id; `name` changes update the same row).
3. **Given** a >1000-user instance, **When** `user/search` truncates, **Then** `groups[]` member enumeration + issue-ref lookups still resolve every referenced user; unresolved refs map to a placeholder inactive user with a warning — never silently dropped.
4. **Given** `fieldAliases` resolved from `/rest/api/2/field`, **When** issues carry Story Points/Epic Link/Flagged under instance-specific ids, **Then** they land on the right TrackForge fields; unresolvable aliases are skipped with warnings.
5. **Given** a select CF whose options exist only per project config, **When** imported, **Then** values observed on issues + `allowedValues` from createmeta populate the field; a warning notes the context collapse.
6. **Given** wiki-markup descriptions/comments, **When** imported, **Then** text is preserved verbatim and the report lists it as a lossy conversion (sample diffs included).

### US4 — No leaks: credential confinement & SSRF (P1)

As a security reviewer, outbound requests to a customer URL must not leak anything.

**Acceptance scenarios**

1. **Given** an attachment `content` URL (or `self`/`nextPage` link) pointing at a different origin than `baseUrl`, **When** fetched, **Then** no `Authorization` header is sent and a warning is recorded.
2. **Given** `baseUrl` validation, **When** the job starts, **Then** non-HTTP(S) schemes are rejected; loopback/link-local/private-range targets require explicit opt-in (SSRF guard inherited from 017's threat model); plain `http://` warns.
3. **Given** any job output (report, `GET /migration/{id}`, logs, MCP `get_migration`), **When** inspected, **Then** no credential material appears (extends 016's log test to server-source jobs).

### US5 — Resume & delta parity (P2)

**Acceptance scenarios**

1. **Given** a killed server-import, **When** resumed, **Then** `ExternalIdMap` convergence produces no duplicates — identical to Cloud jobs.
2. **Given** `deltaFrom`, **When** re-running, **Then** `updated >= "…"` JQL narrows discovery on Server exactly as on Cloud.

## Edge cases

- `baseUrl` with a context path (`https://host/jira`) — joining must preserve the path prefix.
- Self-signed/private-CA TLS on intranet instances — default-reject; documented opt-in
  `insecureSkipVerify` flag recorded on the job + warning.
- LDAP/external-directory users without email → `jira-<key>@import.local` placeholders (existing behavior).
- DC-anonymized users ("Former user" style `key`s) → placeholder inactive user.
- Service account without admin perms → `/rest/api/2/workflow` 403 → statuses-only fallback + warning (board/sprint/project data unaffected).
- Issues invisible to the service account (issue security, permissions) → reported, not errors.
- `groups[]` omitted on a large instance → user/search cap warning in the report, not a hard fail.

## Functional requirements

- **FR-001**: every path pattern the importer registry can emit MUST have a Server rewrite or a
  declared override — enforced by a contract test (the "no silent 404" guarantee).
- **FR-002**: `Authorization` MUST be attached only when the request origin equals the configured
  `baseUrl` origin; off-origin absolute URLs (`content`, `self`, `nextPage`) fetch bare + warn.
- **FR-003**: user identity MUST key on Jira `key` (stable) with `name` fallback; renames MUST NOT
  duplicate users across re-runs.
- **FR-004**: unsupported or non-enumerable entities (filters beyond favourites/boards, history,
  votes, screens, permission/notification schemes) MUST appear in the report with reason +
  remediation — never silently dropped.
- **FR-005**: dry-run MUST work end-to-end before any domain write (inherited from 017).
- **FR-006**: user discovery MUST union `user/search` + `groups[]` members + issue-ref lookups so
  the 1000-user cap cannot silently truncate.
- **FR-007**: custom-field ids MUST resolve by name via `/rest/api/2/field`; hardcoded Cloud ids
  MUST NOT be assumed on a server source.
- **FR-008**: credential material MUST never reach reports, logs, API responses, or MCP output.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/migration/jira-server` | `{baseUrl, authMode:'basic'\|'pat', username?, apiToken?|secretRef?, projectKeys[], dryRun?, deltaFrom?, fieldAliases?, groups[]?, insecureSkipVerify?}` — `username` required iff basic |
| GET | `/api/internal/migration/{id}` · `/report` · `/resume` · `/migration` | Reused unchanged |
| — | `ImportJob.source` | new value `jira-server`; `ExternalIdMap` source key `jira-server:<normalized-baseUrl>` (039's convention) |
| — | stageData additions | `authMode`, `fieldAliases`, `groups`, `serverInfo` (version/build) — all non-secret |

## Data model changes

None — `ImportJob.source` gains a value; server config lives in `stageData` (non-secret fields only).

## MCP tools

`start_migration` gains `source: 'jira-server'` + server-specific fields; `get_migration`,
`get_migration_report`, `commit_migration`, `resume_migration` work unchanged. Deterministic
checks added in `apps/mcp/eval/run.ts`.

## AI-native checklist

- [ ] Server preflight result (version, deploymentType, resolved fieldAliases) is machine-readable on the job.
- [ ] Report distinguishes *imported* / *skipped-with-reason* / *non-enumerable* / *unsupported(sprint)* — an agent can answer "what didn't come over and why".
- [ ] An agent can babysit a Server migration end-to-end via MCP with zero UI.

## Success criteria

- **SC-001**: recorded-fixture Jira Server 9.x site (≥ 500 issues, CFs incl. instance-specific ids,
  sprints, comments, attachments, worklogs, watchers, links) imports with zero unexplained diffs.
- **SC-002**: PAT auth e2e (recorded fixture or test instance) — Bearer on every request, never Basic.
- **SC-003**: credential-confinement test — foreign-origin attachment `content` fetched without
  `Authorization` + warning.
- **SC-004**: user-rename re-run produces no duplicates.
- **SC-005**: registry coverage contract test green; adding an unmapped path fails CI.
- **SC-006**: pilot — one real Server/DC project imported, report reviewed, feeds the MVP-gate evidence.

## Risks

| Risk | Mitigation |
|---|---|
| Shape drift across Server 8.x–9.x/DC | Recorded fixtures per major version; `serverInfo` gate + compat table |
| 1000-user enumeration cap silently truncating | Three-strategy union (FR-006) + explicit cap warning |
| Admin-only endpoints (workflow, group/member) 403 | Degrade-with-warning paths defined per endpoint; report tells the admin exactly which permission unlocks full fidelity |
| Wiki-markup fidelity expectations | Verbatim import + report flagging; full wiki→markdown conversion explicitly out of scope (would be 039/040) |
| Intranet instances (http, self-signed, context paths) | Documented; insecure options are opt-in flags recorded on the job |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Threat-model entry: PAT/basic storage parity with 017, credential confinement (FR-002), SSRF on user-provided `baseUrl`, `insecureSkipVerify` audit.
- [ ] `docs/migration.md` created/extended — Server/DC supported entities, the divergence table, known lossy conversions, admin-prep checklist (service-account perms, PAT creation, `groups[]` guidance, version floor).
- [ ] Recorded Server/DC fixtures committed under `apps/backend/tests/fixtures/` for the contract suite.

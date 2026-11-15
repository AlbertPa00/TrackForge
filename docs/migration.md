# Migrating to TrackForge

Three import sources share the same staged pipeline (`discover → map → plan → apply → verify`),
dry-run, resume, delta re-runs, and idempotent `ExternalIdMap` convergence:

| Source | Endpoint | When |
|---|---|---|
| Jira Cloud (live) | `POST /api/internal/migration/jira-cloud` | `*.atlassian.net` sites |
| **Jira Server / DC (live)** | `POST /api/internal/migration/jira-server` | Self-hosted Jira ≥ 8.x over `/rest/api/2` |
| Jira Server XML backup | `POST /api/internal/migration/jira-server-xml` | Air-gapped / export-only instances |
| CSV | `POST /api/internal/migration/csv` | Flat issue lists |

Always start with `dryRun: true` and review the job report before applying.
`GET /api/internal/migration/{id}` exposes stage, per-entity plan counts,
unsupported entities (with reason + remediation), warnings, apply errors, and
verify diffs. One entity's broken endpoint degrades to a report error — it
never aborts the whole job. `stage: done` means the pipeline finished; check
`report.applyErrors` + `report.verify[].diffs` for what didn't land — those
ops stay retryable and are re-attempted on the next run.

## Jira Server / DC

```json
POST /api/internal/migration/jira-server
{
  "baseUrl": "https://jira.corp.example.com",
  "authMode": "pat",                  // or "basic"
  "username": "svc-import",           // required iff basic
  "apiToken": "<pat-or-password>",    // or "secretRef": "ENV_VAR_NAME"
  "projectKeys": ["PLAT"],
  "dryRun": true,
  "groups": ["jira-software-users"],  // user-discovery union on large instances
  "fieldAliases": {"storyPoints": "customfield_10030"},  // optional overrides
  "allowPrivate": false,
  "insecureSkipVerify": false
}
```

- **Auth** — `basic` sends `Authorization: Basic base64(username:password|token)`;
  `pat` sends `Bearer` and needs no username (Jira ≥ 8.14). Credentials are
  attached **only** to requests whose origin matches `baseUrl` — off-origin
  absolute URLs (attachment `content`, `self`, `nextPage`) fetch bare + warn.
- **Preflight** — `GET /rest/api/2/serverInfo` confirms Server/DC (a Cloud
  `deploymentType` is refused with remediation), records the version on the
  job, warns below 8.20.6 (JSWSERVER-21156 user-search cap), and resolves
  instance-specific custom-field ids via `/rest/api/2/field`: `schema.custom`
  suffix first (locale-independent — 'Enlace de épica' still ends in
  `gh-epic-link`), English name second, `fieldAliases` overrides last.
  Re-resolved every run so jobs pick up newly supported mappings. Every
  `*:labels`-type CF id is also collected (`labelsFieldIds`) — their values
  merge into `Issue.labels` at apply.
- **Identity** — Server has no `accountId`; the source injects
  `accountId = key ?? name` so attribution (assignee, reporter, comment/worklog
  author, watchers, role actors, filter owner) lands identically to Cloud jobs.
  `key` is stable across username renames — re-runs never duplicate users.
- **User enumeration** — Server `user/search` caps at 1000 (≈100 pre-8.20.6).
  Discovery unions three strategies: `user/search`, group members, and
  `assignee/reporter/creator` refs on every imported issue. The group arm is
  automatic: `groups/picker` results are always enumerated so member users
  resolve without configuration; `groups[]` extends that list for groups the
  picker omits (system groups such as `jira-software-users`). Groups that
  still can't be enumerated warn — their members are typically covered anyway
  via `user/search` + issue refs. Unresolved refs map to
  `jira-<key>@import.local` placeholders with a warning.
- **SSRF** — `baseUrl` must be http(s); loopback/private/link-local targets
  require `allowPrivate: true`; plain `http://` warns. `insecureSkipVerify`
  covers self-signed intranet TLS and is recorded on the job.

### What maps differently on Server

| Cloud-only | Server strategy |
|---|---|
| `/users/search` (accountIds) | `user/search?username=.` + picker-union groups + issue-ref union; `key→accountId` |
| `/workflow/search` | `GET /workflow` returns `steps` as a *count* — no step detail exists via Server REST. The importer reconstructs each project's effective workflow from `/project/{key}/statuses` and **attaches it to the project** (unless a workflow/scheme is already assigned), synthesizing Jira Simplified-Workflow semantics: one global transition per status named after its target, with `setResolution`/`clearResolution` post-functions by target category — so transitions show the imported status names, never the seeded `Simple` set. Other workflows stay name-only (XML backup is the full-fidelity path) |
| `/filter/search` | No enumeration exists — favourites + board-referenced filters only; report says so |
| `/field/{id}/context` + options | `createmeta` `allowedValues` unioned across projects — **collapses to a global context** (warning) |
| `/fieldconfigurations*` | No REST API — declared-unsupported in the report, never a silent 404 |
| `fields.parent` epic links | Server stores them in the `gh-epic-link` CF holding the epic **key** — resolved by alias into `Issue.parentId` exactly like Cloud `fields.parent` (Epic Name back-fills an empty summary). Issue discovery emits parents before children so a child imported ahead of its epic still links; `verify` compares remote epic-link coverage against local parentage. Sprint CF rides the same alias → `Issue.sprintId` + `IssueSprint` |
| Greenhopper plugin CFs | **Native, not generic custom fields.** `gh-lexo-rank` → `Issue.rank` verbatim (lib/lexorank decodes the `0\|…` format, preserving backlog order); `*-story-points` → `Issue.storyPoints`; `gh-flagged` → the seeded `flagged` system CF; `jpo-parent` (Portfolio) → `Issue.parentId`, with parent types promoted to `childLevel + 1` so epic→initiative chains land at level 2; `gh-epic-status`/`gh-epic-color` and `jpo-*` (original story points, baseline dates) import as real custom fields. `*:labels` CFs merge into `Issue.labels`. Unrepresentable plugin fields (`devsummary`, Portfolio teams, `project` pickers) stay `unsupported` in the report — never silent |
| Wiki-markup text | Imported verbatim; the report flags it as lossy (no wiki→markdown conversion) |

Known non-importable entities (all reported, never silently dropped): permission
schemes, notification schemes, screens/screen schemes, votes, dashboards,
change history (sprint 039 scope — XML backup source does carry it).

### Service-account checklist

1. Create a dedicated account (e.g. `svc-import`) with Browse on all migrated
   projects — admin additionally unlocks `/workflow` and `group/member`
   enumeration for full fidelity.
2. Jira ≥ 8.14: create a PAT (Profile → Personal Access Tokens) — prefer `pat`
   over storing a password.
3. Favourite every filter you want imported; only favourites + board filters
   are reachable on Server.
4. Pass `groups` only for groups the picker omits (system groups like
   `jira-software-users`) — picker results are enumerated automatically.
5. Dry-run, read the report's `warnings` + `unsupported` + `applyErrors`
   lists, then run for real. Re-running is safe — `ExternalIdMap` converges,
   and failed ops are never recorded as imported, so a retry heals whatever
   the first run couldn't apply. A dead process or DB restart leaves the job
   resumable: `POST /api/internal/migration/{id}/resume` or
   `pnpm --filter backend import:run <jobId>` re-drives it end-to-end outside
   the HTTP server.

## Credentials & reports

`apiToken` is stored only in the job's stageData for resumability (or pulled
fresh from `secretRef` each run). It never appears in `GET /migration/{id}`,
reports, logs, or MCP output. Deleting the job row removes the credential.

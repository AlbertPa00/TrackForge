# Sprint 009 — API contract changes

## Breaking changes

### Transition ids are workflow ids, not status ids

Since Sprint 002, `GET /issue/{key}/transitions` returned one pseudo-transition per target
status and the `id` *was* the status id; `POST` moved straight to that status.

From Sprint 009 each project follows a persisted **workflow**. `GET` now returns the
workflow's named transitions — stable ids, names like "Start Progress", and per-transition
metadata:

```json
{
  "transitions": [{
    "id": "<transitionId>",
    "name": "Done",
    "hasScreen": true,
    "isGlobal": false,
    "isConditional": false,
    "fields": { "resolution": { "required": true, "name": "Resolution",
                                "schema": { "type": "resolution" }, "operations": ["set"] } },
    "to": { "id": "<statusId>", "name": "Done",
            "statusCategory": { "key": "done", "name": "Done" } }
  }]
}
```

Only transitions valid **from the issue's current status** *and* passing conditions for the
caller are listed. `hasScreen`/`fields` advertise transitions that need user input.

### `PUT /issue/{key}` rejects `fields.status`

Status is now owned by the workflow. `PUT` with `fields.status` returns `400`:

```json
{ "errorMessages": [], "errors": { "status": "Field 'status' cannot be set. Use transitions." } }
```

### `POST /issue/{key}/transitions` accepts screen fields

```json
{
  "transition": { "id": "<transitionId>" },
  "fields":     { "resolution": { "name": "Done" } },
  "update":     { "comment": [{ "add": { "body": "closing" } }] }
}
```

Validators reject with a Jira field error (`400 { errors: { resolution: "Resolution is required." } }`),
conditions with `400`, unreachable/unknown transitions with `404`. `dryRun=true` returns the
preview (changelog items + resolved transition) without persisting.

## New endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/api/2/project/{key}/statuses` | Jira: valid statuses per issue type |
| GET | `/rest/api/2/workflow` | Jira: `{values:[{name,default}]}` |
| GET | `/rest/agile/1.0/board/{id}` | Persisted board; accepts board id **or legacy project key** |
| GET/PUT | `/rest/agile/1.0/board/{id}/configuration` | Column→status map, `min`/`max` WIP, `unmapped` list |
| PUT | `/rest/agile/1.0/issue/rank` | `{issues[], rankBeforeIssue \| rankAfterIssue}` (exactly one) — LexoRank |
| GET/POST | `/api/internal/workflows` | Editor API (admin) |
| GET/PUT | `/api/internal/workflows/{id}` | Full definition incl. rules; `PUT` bumps `version` |
| POST | `/api/internal/projects/{key}/workflow` | `{workflowId, mapping{oldStatusId→newStatusId}}` — admin or project lead |

## Board compatibility

- `GET /board?projectKeyOrId=K` still resolves to the project's persisted board.
- `GET /board/{id}/issue` is **rank-ordered** (`rank, issueNumber`) and keeps the Sprint 004
  behaviour of scoping to the active sprint when one exists.

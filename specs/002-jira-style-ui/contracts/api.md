# API Contracts — Sprint 002 Additions

All endpoints under `/rest/api/2`. Error responses unchanged (Jira `{errorMessages, errors}` shape).

## Metadata

### `GET /status`
```json
[{ "id": "…", "name": "To Do", "statusCategory": { "key": "new", "name": "To Do" } }]
```
Category mapping: `todo → new`, `inprogress → indeterminate`, `done → done`.

### `GET /priority`
```json
[{ "id": "…", "name": "Medium", "statusColor": "#f6c342" }]
```

### `GET /issuetype`
```json
[{ "id": "…", "name": "Task", "description": "", "subtask": false, "hierarchyLevel": 0 }]
```

### `GET /myself`
```json
{ "accountId": "trackforge-admin", "displayName": "TrackForge Admin", "emailAddress": "admin@trackforge.local", "active": true }
```

## Transitions

### `GET /issue/:key/transitions`
```json
{ "transitions": [ { "id": "<statusId>", "name": "In Progress",
  "to": { "id": "<statusId>", "name": "In Progress",
          "statusCategory": { "key": "indeterminate", "name": "In Progress" } } } ] }
```
Returns every status except the issue's current status (any-direction workflow this sprint).

### `POST /issue/:key/transitions`
Request: `{ "transition": { "id": "<statusId>" } }` → `204 No Content`.
Unknown transition id → `404` Jira error.

## Search (extended JQL-lite)

`GET /search?jql=...&startAt=0&maxResults=50`

Grammar (case-insensitive keywords, quoted or bare values):
```
project = KEY
  [ AND status     = "Name" ]
  [ AND issuetype  = "Name" ]
  [ AND priority   = "Name" ]
  [ AND summary    ~ "text" ]   (case-insensitive substring; "" = no filter)
  [ ORDER BY created|updated|key ASC|DESC ]
```

Response (Jira search shape):
```json
{ "expand": "schema,names", "startAt": 0, "maxResults": 50, "total": 12,
  "issues": [ { "id": "…", "key": "PROJ-1", "fields": { "summary": "…",
    "issuetype": {"id":"…","name":"Task"},
    "status":    {"id":"…","name":"To Do","statusCategory":{"key":"new"}},
    "priority":  {"id":"…","name":"Medium"},
    "assignee": null,
    "reporter": {"displayName":"TrackForge Admin"},
    "created": "…", "updated": "…" } } ] }
```

`total` reflects the filtered count, not the page size.

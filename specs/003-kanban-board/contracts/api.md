# API Contracts — Sprint 003 (Jira Agile Board)

Base path: `/rest/agile/1.0`. Board `id` = project key (divergence: Jira uses numeric ids).

## `GET /board?projectKeyOrId=TF`

```json
{
  "maxResults": 50,
  "startAt": 0,
  "total": 1,
  "isLast": true,
  "values": [
    {
      "id": "TF",
      "self": "http://localhost:3000/rest/agile/1.0/board/TF",
      "name": "TrackForge Platform board",
      "type": "kanban",
      "location": { "projectKey": "TF", "projectName": "TrackForge Platform" }
    }
  ]
}
```
Unknown key → `404` Jira error. Missing param → `400`.

## `GET /board/{id}/configuration`

```json
{
  "id": "TF",
  "name": "TrackForge Platform board",
  "type": "kanban",
  "columnConfig": {
    "columns": [
      { "name": "To Do",
        "statuses": [{ "id": "<statusId>", "name": "To Do",
                       "statusCategory": { "key": "new", "name": "To Do" } }] },
      { "name": "In Progress", "statuses": [ … indeterminate … ] },
      { "name": "Done", "statuses": [ … done … ] }
    ]
  }
}
```
Columns derive 1:1 from statuses ordered by `sequence`.

## `GET /board/{id}/issue?startAt=0&maxResults=200`

Jira search-shaped page of **all** issues in the board's project, ordered by key asc:

```json
{ "startAt": 0, "maxResults": 200, "total": 4, "issues": [ { "key": "TF-1", "fields": { … } } ] }
```
`maxResults` capped at 200.

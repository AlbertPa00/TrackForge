# API Contracts — Sprint 004 (Sprints & Backlog)

Base path: `/rest/agile/1.0`. Sprint shape (Jira Agile v1):

```json
{ "id": "<uuid>", "self": "…/sprint/<uuid>", "state": "future|active|closed",
  "name": "TF Sprint 1", "goal": "…?", "originBoardId": "TF",
  "startDate": "…?", "endDate": "…?" }
```

## `POST /sprint`
Body: `{ "originBoardId": "TF", "name"?, "goal"? }` → `201` sprint.
Missing `name` → auto `{KEY} Sprint {n}` (count of project's sprints + 1).
Unknown board → `404`.

## `GET /board/{id}/sprint?state=future,active`
→ `{ maxResults, startAt, total, isLast, values: [sprint…] }` ordered: active, then future by `createdAt`. Unknown board → `404`.

## `POST /sprint/{id}`  (partial update)
Body subset: `{ "name"?, "goal"?, "state"? , "startDate"?, "endDate"? }` → `200` sprint.
- `state: "active"` → `400` if another sprint in the project is active.
- `state: "closed"` → moves all non-`done`-category issues back to backlog; sets `endDate` if absent.
- Illegal transitions (`closed→active`, `closed→future`) → `400`.

## `GET /sprint/{id}/issue?startAt&maxResults`
→ `{ startAt, maxResults, total, issues: [issue…] }` ordered by key.

## `POST /sprint/{id}/issue`
Body: `{ "issues": ["TF-1", "TF-2"] }` → `204`. Rejects closed sprints (`400`) and unknown issue keys (`400` naming the key).

## `POST /backlog/issue`
Body: `{ "issues": ["TF-1"] }` → `204`. Clears `sprintId`.

## Changes to existing endpoints

- `GET /rest/agile/1.0/board/{id}/issue` — returns active-sprint issues when the project has an `active` sprint; all project issues otherwise.
- Issue `fields` gain `sprint: { "id": "…", "name": "TF Sprint 1" } | null`.

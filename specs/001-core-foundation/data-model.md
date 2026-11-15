# Phase 1 Data Model & API Design: Core Foundation

## Database Schema

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Project {
  id          String   @id @default(uuid())
  key         String   @unique
  name        String
  description String?
  projectType String   @default("software")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  issues      Issue[]

  @@index([key])
}

model IssueType {
  id          String @id @default(uuid())
  name        String @unique
  description String?
  hierarchyLevel Int @default(0)
  isSubtask   Boolean @default(false)
}

model Status {
  id          String @id @default(uuid())
  name        String @unique
  category    String // "todo" | "inprogress" | "done"
  sequence    Int    @default(0)
}

model Priority {
  id          String @id @default(uuid())
  name        String @unique
  color       String?
  sequence    Int    @default(0)
}

model Issue {
  id          String   @id @default(uuid())
  projectId   String
  issueNumber Int
  summary     String
  description String?
  issueTypeId String
  statusId    String
  priorityId  String
  assigneeId  String?
  reporterId  String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  project  Project   @relation(fields: [projectId], references: [id])
  issueType IssueType @relation(fields: [issueTypeId], references: [id])
  status    Status    @relation(fields: [statusId], references: [id])
  priority  Priority  @relation(fields: [priorityId], references: [id])

  @@unique([projectId, issueNumber])
  @@index([projectId])
}
```

## Key Generation

Issue keys are composed as `{PROJECT_KEY}-{ISSUE_NUMBER}`. Issue numbers are per-project auto-incrementing integers starting at 1. The database enforces uniqueness of `(projectId, issueNumber)`.

## API Contracts

### Create Project

**Request**: `POST /rest/api/2/project`
```json
{
  "key": "PROJ",
  "name": "Sample Project",
  "description": "A sample project for testing",
  "projectTypeKey": "software"
}
```

**Response**: `201 Created`
```json
{
  "id": "uuid",
  "key": "PROJ",
  "name": "Sample Project",
  "description": "A sample project for testing",
  "projectTypeKey": "software",
  "self": "http://localhost:3000/rest/api/2/project/PROJ"
}
```

### List Projects

**Request**: `GET /rest/api/2/project`

**Response**: `200 OK`
```json
[
  {
    "id": "uuid",
    "key": "PROJ",
    "name": "Sample Project",
    "projectTypeKey": "software"
  }
]
```

### Create Issue

**Request**: `POST /rest/api/2/issue`
```json
{
  "fields": {
    "project": { "key": "PROJ" },
    "summary": "First issue",
    "description": "This is the first issue",
    "issuetype": { "name": "Task" },
    "priority": { "name": "Medium" }
  }
}
```

**Response**: `201 Created`
```json
{
  "id": "uuid",
  "key": "PROJ-1",
  "self": "http://localhost:3000/rest/api/2/issue/PROJ-1",
  "fields": {
    "summary": "First issue",
    "description": "This is the first issue",
    "issuetype": { "id": "uuid", "name": "Task" },
    "status": { "id": "uuid", "name": "To Do" },
    "priority": { "id": "uuid", "name": "Medium" },
    "created": "2026-06-20T12:00:00.000Z",
    "updated": "2026-06-20T12:00:00.000Z"
  }
}
```

### Get Issue

**Request**: `GET /rest/api/2/issue/{issueKey}`

**Response**: `200 OK` with the same shape as the create issue response.

### Update Issue / Transition Status

**Request**: `PUT /rest/api/2/issue/{issueKey}`
```json
{
  "fields": {
    "summary": "Updated summary",
    "status": { "name": "In Progress" }
  }
}
```

**Response**: `204 No Content` on success, or `400 Bad Request` if the status is invalid.

### List Issues by Project

**Request**: `GET /rest/api/2/search?jql=project=PROJ`

**Response**: `200 OK`
```json
{
  "expand": "schema,names",
  "startAt": 0,
  "maxResults": 50,
  "total": 1,
  "issues": [ /* issue objects */ ]
}
```

## Error Handling

- Validation errors: `400 Bad Request` with `{ "errorMessages": [], "errors": { "field": "message" } }`
- Not found: `404 Not Found` with `{ "errorMessages": ["Issue does not exist or you do not have permission to see it."] }`
- Duplicate project key: `400 Bad Request` with `{ "errors": { "key": "A project with that key already exists." } }`

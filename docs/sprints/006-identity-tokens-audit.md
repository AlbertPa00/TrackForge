# Sprint 006 — Identity, Tokens & Audit

| | |
|---|---|
| **Status** | Done |
| **Theme** | Jira parity + AI foundation |
| **Depends on** | 005 |
| **Unblocks** | 007 (agent auth), 008 (comments, mentions), 010 (`currentUser()`), 011 (notifications, webhooks), 012 (approvals) |
| **Spec-kit folder** | `specs/006-identity-tokens-audit/` |
| **Open decisions** | D4 (session mechanism), D5 (native API prefix) |

## Goal

Introduce real people and real agents. Users log in, issues have real reporters and assignees, agents
authenticate with scoped tokens under their own identity, and every change to an issue is recorded in
a Jira-compatible changelog that says who did it and through which channel.

## Why now

Assignment, comments, mentions, notifications, permissions, webhooks and safe agent access all depend
on identity and history. Today the API is unauthenticated with open CORS, so it cannot be exposed to
any agent or network. Every feature built before this sprint would need rework.

## Scope

**In**: user accounts (human + agent), login/logout, admin user management, assignee/reporter, user
search endpoints, personal access tokens with scopes, Jira-compatible Basic and Bearer auth, issue
changelog, security audit log, CORS lock-down, rate limiting.

**Out**: SSO/OIDC, 2FA, groups, project roles, permission schemes, issue security (see roadmap
"Later"); password reset by email (no mail transport yet — admins reset passwords).

---

## User stories

### US1 — Users can sign in (P1)

As a user, I want to sign in with my own account so that my actions are attributed to me.

**Independent test**: create a user as admin, sign in as that user, see their name and avatar in the top nav; `/myself` returns them.

**Acceptance scenarios**

1. **Given** a fresh install, **When** the backend starts with `ADMIN_EMAIL`/`ADMIN_PASSWORD` set and no users exist, **Then** an admin user is created once.
2. **Given** valid credentials, **When** a user submits the login page, **Then** a session is established (D4), they land on `/`, and `GET /rest/api/2/myself` returns their `accountId`, `displayName`, `emailAddress`, `active`, `timeZone`.
3. **Given** no session, **When** any page other than `/login` is opened, **Then** the user is redirected to `/login?next=<path>`.
4. **Given** an admin, **When** they open Settings → Users, **Then** they can create, edit (name, email, admin flag), deactivate and reset the password of users.
5. **Given** the last active admin, **When** someone tries to deactivate or demote them, **Then** the action is rejected with a clear error.

### US2 — Issues have real reporters and assignees (P1)

As a user, I want to assign issues to people so that ownership is clear.

**Independent test**: create an issue (reporter = me), assign it to a colleague from the detail page, filter the list by "Assignee = colleague".

**Acceptance scenarios**

1. **Given** an authenticated user creates an issue, **When** it is saved, **Then** `fields.reporter` is that user (persisted `reporterId`).
2. **Given** an issue, **When** `PUT /rest/api/2/issue/{key}/assignee` is called with `{ "accountId": "…" }` (or `null` to unassign), **Then** the assignee changes and the response is `204`.
3. **Given** an issue, **When** `PUT /rest/api/2/issue/{key}` includes `fields.assignee: { accountId }`, **Then** the assignee changes.
4. **Given** the detail page, **When** a user clicks Assignee, **Then** a searchable user picker (backed by `/user/assignable/search`) appears, including "Assign to me" and "Unassigned".
5. **Given** the issue list, **When** a user picks an assignee filter, **Then** JQL-lite `assignee = <accountId> | currentUser() | EMPTY` is used.
6. **Given** a deactivated user, **When** they are an issue's assignee, **Then** they remain displayed (marked inactive) but cannot be newly assigned.

### US3 — Agents authenticate with scoped tokens (P1)

As a user, I want to create API tokens and agent accounts so that scripts and AI agents can act with limited, revocable permissions under an identity I control.

**Independent test**: create an agent account "triage-bot" with a read-only token limited to project TF; it can search TF, cannot read MOB, cannot create issues; revoke it and every call returns 401.

**Acceptance scenarios**

1. **Given** Profile → API tokens, **When** a user creates a token with a name, scopes (`read`, `write`, `admin`), optional project allow-list and optional expiry, **Then** the token secret (prefix `tfp_`) is shown exactly once and only its hash is stored.
2. **Given** a token, **When** a request sends `Authorization: Bearer <token>`, **Then** it authenticates as the token's owner, constrained by the token's scopes and projects.
3. **Given** a token, **When** a request sends `Authorization: Basic base64(email:token)` (Jira Cloud style), **Then** it authenticates identically.
4. **Given** a user, **When** they create an **agent account** (type `agent`, owned by them), **Then** the agent can only authenticate with tokens, cannot sign in to the UI, and its display shows an "agent" badge everywhere its name appears.
5. **Given** a token with `read` scope, **When** it calls a write endpoint, **Then** the response is `403` with a Jira-shaped error naming the missing scope.
6. **Given** a revoked or expired token, **When** it is used, **Then** the response is `401`.
7. **Given** Settings → Users (admin), **When** viewing a user, **Then** their tokens (name, scopes, last used, created) are listed and can be revoked.

### US4 — Every issue change is recorded (P1)

As a user (or an agent supervisor), I want to see the full history of an issue so that I know who changed what, when and how.

**Independent test**: change status, priority and assignee via UI and via a token; open the History tab and see each change with author, channel and before/after values.

**Acceptance scenarios**

1. **Given** any mutation of an issue field (create, summary, description, status, priority, assignee, type), **When** it commits, **Then** a history entry is written in the same transaction with `author`, `created`, `channel` (`ui` | `api` | `mcp` | `copilot`), `tokenId` (if any) and `items[]` of `{ field, fieldtype, from, fromString, to, toString }`.
2. **Given** `GET /rest/api/2/issue/{key}?expand=changelog`, **When** called, **Then** the response contains `changelog.histories[]` in Jira shape.
3. **Given** `GET /rest/api/2/issue/{key}/changelog?startAt&maxResults`, **When** called, **Then** a paged list of histories is returned.
4. **Given** the detail page, **When** a user opens Activity → History, **Then** entries are listed newest-first with avatar, agent badge where applicable, and a human-readable diff.

### US5 — The API is safe to expose (P2)

As an operator, I want the API locked down so that it can be reached by agents and other networks.

**Acceptance scenarios**

1. **Given** `CORS_ORIGINS`, **When** a browser request comes from another origin, **Then** it is rejected.
2. **Given** a token or session, **When** it exceeds the configured rate (default 1000 req/min), **Then** responses are `429` with `Retry-After`; all responses include `X-RateLimit-Limit`/`-Remaining`.
3. **Given** security events (login success/failure, token created/revoked, user created/deactivated, admin changes), **When** they occur, **Then** they are written to an audit log viewable by admins at Settings → Audit log and via `GET /api/internal/audit`.

---

## Edge cases

- Email uniqueness is case-insensitive.
- Changing a user's display name does not rewrite history; history stores `accountId` and resolves names at read time.
- A token whose project allow-list excludes a project gets `404` (not `403`) for that project's issues, matching Jira's "does not exist or you do not have permission" behaviour.
- Agent accounts whose owner is deactivated are deactivated too.
- `/rest/api/2/serverInfo` (added in 007) and `/login` are the only unauthenticated routes.

## Functional requirements

- **FR-001**: All `/rest/*` and `/api/internal/*` routes MUST require authentication (session, Bearer PAT or Basic email:token).
- **FR-002**: Passwords MUST be hashed with a memory-hard algorithm; tokens MUST be stored hashed and compared in constant time.
- **FR-003**: Tokens MUST support scopes `read`, `write`, `admin`, an optional project allow-list and optional expiry.
- **FR-004**: Users MUST have `type` = `human` | `agent`; agent users MUST have an owner and MUST NOT use password login.
- **FR-005**: Reporter MUST be set from the authenticated actor; assignee MUST be settable via `PUT /issue/{key}` and `PUT /issue/{key}/assignee`.
- **FR-006**: Every issue mutation MUST write a changelog entry atomically with the change, including channel and token id.
- **FR-007**: `GET /user/search`, `GET /user?accountId=`, `GET /user/assignable/search?project=&query=` MUST return Jira-shaped users.
- **FR-008**: JQL-lite MUST accept `assignee = <accountId> | currentUser() | EMPTY` and `reporter = …`.
- **FR-009**: CORS MUST be restricted to configured origins; rate limiting MUST apply per principal.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/api/internal/auth/login` · `/logout` | UI session (D4) |
| GET | `/rest/api/2/myself` | Real user |
| GET | `/rest/api/2/user?accountId=` | Jira |
| GET | `/rest/api/2/user/search?query=` | Jira |
| GET | `/rest/api/2/user/assignable/search?project=&query=` | Jira |
| PUT | `/rest/api/2/issue/{key}/assignee` | Jira, body `{accountId}` |
| GET | `/rest/api/2/issue/{key}?expand=changelog` | Jira |
| GET | `/rest/api/2/issue/{key}/changelog` | Jira (paged) |
| GET/POST/DELETE | `/api/internal/tokens[/{id}]` | Native; secret returned once on POST |
| GET/POST/PUT | `/api/internal/users[/{accountId}]` | Native admin user management, agent accounts |
| GET | `/api/internal/audit` | Native, admin only |

## Data model changes

- **User**: `accountId`, `email` (unique, case-insensitive), `displayName`, `passwordHash?`, `type` (`human`|`agent`), `ownerId?` (agents), `isAdmin`, `active`, `timeZone`, timestamps.
- **ApiToken**: `id`, `userId`, `name`, `prefix`, `hash`, `scopes[]`, `projectIds[]?`, `expiresAt?`, `lastUsedAt?`, `revokedAt?`.
- **Issue**: `reporterId`, `assigneeId` become real foreign keys to User.
- **ChangeHistory**: `id`, `issueId`, `authorId`, `channel`, `tokenId?`, `createdAt`; **ChangeItem**: `historyId`, `field`, `fieldtype`, `from`, `fromString`, `to`, `toString`.
- **AuditEvent**: `id`, `actorId?`, `action`, `entityType`, `entityId`, `details` (JSON), `ip`, `userAgent`, `createdAt`.

## AI-native checklist

- [ ] A2 Attributable — changelog captures actor + channel + token for every write.
- [ ] A5 Scoped — scopes, project allow-list, expiry, revocation all enforced and tested.
- [ ] Agent identity is first-class (type, owner, badge) — prerequisite for 007 and 012.

## Success criteria

- **SC-001**: 100% of issue-mutating endpoints write a changelog entry (enforced by a test that iterates all write routes).
- **SC-002**: An unauthenticated request to any protected route returns 401 (route-table test).
- **SC-003**: A read-only, project-scoped agent token cannot read other projects or write anywhere (integration tests).
- **SC-004**: A user can sign in, assign an issue to a colleague and see the change in History in under 1 minute of clicks.

## Risks

| Risk | Mitigation |
|---|---|
| Auth breaks all existing tests and the e2e smoke test | Test helper that creates a user + token per suite; Playwright login fixture |
| Scope creep into permission schemes | Explicitly out of scope; only global `isAdmin` + token scopes this sprint |
| Changelog writes forgotten on new code paths | Centralise mutations in a service that diffs before/after and writes history; route-table test (SC-001) |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Seed creates demo users (2 humans, 1 agent) and assigns seeded issues.
- [ ] Quickstart documents admin bootstrap env vars and how to create a token.

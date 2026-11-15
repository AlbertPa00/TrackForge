# Sprint 007 — Agent-Ready API & MCP Server

| | |
|---|---|
| **Status** | **Done** |
| **Theme** | AI-native |
| **Depends on** | 006 (users, tokens, changelog) |
| **Unblocks** | Every later sprint's MCP tools; 012 (copilot reuses the tool registry) |
| **Spec-kit folder** | `specs/007-agent-api-and-mcp/` |
| **New dependencies (to justify in plan)** | `@modelcontextprotocol/sdk` (MCP server); an OpenAPI generator for zod schemas |

## Goal

Make TrackForge something an AI agent can operate correctly on its first try. The API describes
itself (OpenAPI, field and create/edit metadata), writes are safe to retry and previewable, and a
first-party MCP server exposes TrackForge's capabilities as well-described tools authenticated by the
agent tokens from Sprint 006.

## Why now

From this sprint on, every new feature must ship with its MCP tools (roadmap DoD). Building the MCP
server now costs one sprint; building it last would mean retrofitting tools, metadata and idempotency
onto many sprints of features.

## Scope

**In**: OpenAPI document, `/field`, `createmeta`, `editmeta`, `serverInfo`, `fields`/`expand`
selection, `POST /search`, `Idempotency-Key`, `dryRun`, bulk create, MCP server (stdio + HTTP) with
tools for all existing capabilities, a Jira-client compatibility test harness.

**Out**: in-app AI features (012), approval workflow for agent writes (012), event subscriptions (011).

---

## User stories

### US1 — The API describes itself (P1)

As an agent developer, I want machine-readable descriptions of endpoints, fields and valid values so
that an agent never has to guess.

**Independent test**: an agent reads `createmeta` for project TF and issue type Bug, then creates a valid Bug using only values it discovered.

**Acceptance scenarios**

1. **Given** `GET /rest/api/2/openapi.json` (TrackForge extension), **When** called, **Then** an OpenAPI 3.1 document generated from the same zod schemas used for validation is returned; CI fails if it drifts from the routes.
2. **Given** `GET /rest/api/2/field`, **When** called, **Then** every system field is listed in Jira shape (`id`, `name`, `custom`, `orderable`, `navigable`, `searchable`, `schema`).
3. **Given** `GET /rest/api/2/issue/createmeta/{projectKey}/issuetypes` and `/issuetypes/{issueTypeId}`, **When** called, **Then** issue types and their fields with `required`, `schema` and `allowedValues` (priorities, assignable users link, etc.) are returned in Jira shape.
4. **Given** `GET /rest/api/2/issue/{key}/editmeta`, **When** called, **Then** editable fields and allowed operations (`set`, and `add`/`remove` where applicable) are returned.
5. **Given** `GET /rest/api/2/serverInfo`, **When** called unauthenticated, **Then** `baseUrl`, `version`, `deploymentType: "Server"`, `serverTitle` are returned.

### US2 — Responses are compact and selectable (P1)

As an agent, I want to request only the fields I need so that responses fit in my context window.

**Acceptance scenarios**

1. **Given** `GET /issue/{key}?fields=summary,status`, **When** called, **Then** only those fields are present under `fields`.
2. **Given** `GET|POST /rest/api/2/search` with `fields` and `expand` (`changelog`, `names`, `schema`), **When** called, **Then** selection and expansion are honoured; `POST /search` accepts `{ jql, startAt, maxResults, fields, expand }`.
3. **Given** `fields=*all` or `*navigable`, **When** called, **Then** Jira semantics apply.

### US3 — Writes are safe to retry and preview (P1)

As an agent, I want idempotent, previewable writes so that retries never duplicate work and I can show a human what will happen.

**Independent test**: send the same create request twice with the same `Idempotency-Key`; exactly one issue exists and both responses are identical. Send `?dryRun=true`; nothing is persisted and the response shows the would-be result.

**Acceptance scenarios**

1. **Given** a write (`POST`/`PUT`/`DELETE`) with header `Idempotency-Key`, **When** the same key + same principal + same body is replayed within 24 h, **Then** the original status and body are returned without re-executing.
2. **Given** the same key with a *different* body, **When** replayed, **Then** the response is `422` with an explanatory Jira-shaped error.
3. **Given** `?dryRun=true` on create, edit, assign or transition, **When** called, **Then** validation runs, nothing is persisted, and the response contains the would-be issue plus a `changes[]` diff in changelog-item shape; the status is `200` and the header `X-TrackForge-DryRun: true` is set.
4. **Given** an invalid write, **When** rejected, **Then** the Jira error includes valid alternatives where they exist (e.g. `"Priority 'Urgent' not found. Allowed: Highest, High, Medium, Low, Lowest"`).

### US4 — First-party MCP server (P1)

As an AI agent user, I want to connect any MCP-capable agent to TrackForge so that it can read and change work with my token's permissions.

**Independent test**: configure an MCP client with the server (stdio) and a `write` token; ask the agent to "create three tasks in TF from this meeting note, assign the API one to Ana and start it". It succeeds with zero invalid tool calls, and History shows the changes as made by the agent via `mcp`.

**Acceptance scenarios**

1. **Given** `apps/mcp`, **When** started with `TRACKFORGE_URL` and `TRACKFORGE_TOKEN`, **Then** it serves MCP over stdio; with `--http` it serves Streamable HTTP and accepts the token per connection.
2. **Given** a connected client, **When** it lists tools, **Then** at least these are present, each with an LLM-oriented description and JSON schema:

   | Tool | Purpose |
   |---|---|
   | `whoami` | Current principal, scopes, allowed projects |
   | `list_projects` / `get_project` | Discover projects |
   | `get_create_meta` | Issue types, fields, allowed values for a project |
   | `search_issues` | JQL search with `fields`, `limit`, cursor |
   | `get_issue` | Issue with optional changelog |
   | `create_issue` | Create (supports `dry_run`, `idempotency_key`) |
   | `update_issue` | Edit fields (supports `dry_run`) |
   | `assign_issue` | Assign by accountId, email or "me" |
   | `get_transitions` / `transition_issue` | Transition by transition id **or** target status name |
   | `find_users` | Resolve people by name/email |
   | `bulk_create_issues` | Up to 50 issues in one call |

3. **Given** resources, **When** the client lists them, **Then** `trackforge://project/{key}` and `trackforge://issue/{key}` are readable.
4. **Given** any tool call, **When** it writes, **Then** the request carries `channel=mcp` so the changelog records it (A2).
5. **Given** a tool error, **When** returned, **Then** it is a structured, actionable message (what was wrong, valid values, suggested next tool), never a raw stack trace.
6. **Given** a token without `write`, **When** the client lists tools, **Then** write tools are omitted or marked read-only.

### US5 — Bulk create (P2)

**Acceptance scenarios**

1. **Given** `POST /rest/api/2/issue/bulk` with `issueUpdates[]` (max 50), **When** called, **Then** the response is Jira-shaped `{ issues[], errors[] }` with per-item failures, and valid items are created.

### US6 — Compatibility harness (P2)

As the team, we want proof that off-the-shelf Jira clients work against TrackForge so that "Jira-compatible" is measured, not claimed.

**Acceptance scenarios**

1. **Given** a CI job, **When** it runs a maintained third-party Jira REST client library against a seeded TrackForge, **Then** it performs: get myself, list projects, create issue, get issue, edit, assign, get/execute transitions, search with JQL.
2. **Given** the run, **When** it finishes, **Then** a compatibility matrix (pass/fail per call) is written to `docs/compatibility.md`.

---

## Edge cases

- Idempotency keys are scoped per principal; two agents may reuse the same key independently.
- `dryRun` on transition still evaluates transition validity.
- `fields=` with an unknown field id is ignored (Jira behaviour), not an error.
- MCP server must not log token values; logs redact `Authorization`.
- MCP `search_issues` must cap results (default 20, max 100) and return a cursor, to protect context windows.

## Functional requirements

- **FR-001**: OpenAPI 3.1 MUST be generated from the validation schemas and checked in CI.
- **FR-002**: `/field`, `createmeta` (per-project/issuetype form), `editmeta` and `serverInfo` MUST be implemented in Jira shape.
- **FR-003**: `fields` and `expand` MUST be honoured on issue GET and search; `POST /search` MUST be supported.
- **FR-004**: All write endpoints MUST support `Idempotency-Key` (24 h retention) and `dryRun=true`.
- **FR-005**: Validation errors MUST list allowed values when the field has a finite domain.
- **FR-006**: The MCP server MUST authenticate exclusively via TrackForge tokens and inherit their scopes.
- **FR-007**: Every capability available in the REST API at sprint end MUST have a corresponding MCP tool or resource.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/rest/api/2/openapi.json` | TrackForge extension |
| GET | `/rest/api/2/serverInfo` | Jira, unauthenticated |
| GET | `/rest/api/2/field` | Jira |
| GET | `/rest/api/2/issue/createmeta/{projectIdOrKey}/issuetypes[/{issueTypeId}]` | Jira |
| GET | `/rest/api/2/issue/{key}/editmeta` | Jira |
| POST | `/rest/api/2/search` | Jira |
| POST | `/rest/api/2/issue/bulk` | Jira |
| — | `Idempotency-Key` header, `dryRun` query param | TrackForge extensions (documented divergences) |

## Data model changes

- **IdempotencyRecord**: `principalId`, `key`, `requestHash`, `status`, `responseBody`, `createdAt` (TTL 24 h).

## AI-native checklist

- [ ] A3 Discoverable — metadata endpoints + MCP `get_create_meta`.
- [ ] A4 Safe to retry — idempotency + dry-run on every write.
- [ ] A8 Token-efficient — field selection, capped MCP outputs, actionable errors.
- [ ] Scripted agent evaluation (below) passes.

## Success criteria

- **SC-001**: Scripted agent evaluation: a fixed set of 10 natural-language tasks executed by an MCP-connected agent completes ≥ 9/10 correctly with 0 duplicate writes. The task set is checked into `apps/mcp/eval/`.
- **SC-002**: 100% of REST write endpoints pass the idempotency replay test and the dry-run no-persist test.
- **SC-003**: Compatibility harness passes all core calls listed in US6.
- **SC-004**: `search_issues` with `fields=summary,status` returns ≥ 70% fewer bytes than the full payload for 20 issues.

## Risks

| Risk | Mitigation |
|---|---|
| Tool descriptions are poor and agents misuse tools | Treat descriptions as product copy; iterate against the eval set (SC-001) |
| OpenAPI generation forces a big validation refactor | Generate incrementally per router; CI check only for migrated routers this sprint, all routers by sprint end |
| MCP spec evolves | Pin SDK version; isolate transport code |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `apps/mcp/README.md` with setup for common MCP clients (stdio and HTTP).
- [ ] `docs/compatibility.md` generated by the harness.

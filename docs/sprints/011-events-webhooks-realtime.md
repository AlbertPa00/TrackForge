# Sprint 011 — Events, Webhooks & Real-time

| | |
|---|---|
| **Status** | Done |
| **Theme** | AI-native + collaboration |
| **Depends on** | 006 (actors, changelog), 008 (comments, mentions); soft dependency on 010 — webhook and event-feed JQL filters use the full JQL engine if 010 has shipped, otherwise the JQL-lite subset |
| **Unblocks** | 012 (copilot reacts to events; approval notifications) |
| **Spec-kit folder** | `specs/011-events-webhooks-realtime/` |

## Goal

Make TrackForge reactive. Every change becomes a durable domain event; external systems and agents
subscribe via Jira-compatible webhooks or a cursor-based event feed; the UI updates live; and users get
in-app notifications for the things that concern them, plus a "Your work" home page.

## Why now

Agents today can only poll search to notice change — slow, expensive, and lossy. Humans also see stale
boards until they reload. Comments and mentions (008) create the first real need for notifications.

## Scope

**In**: transactional outbox of domain events, Jira-shaped webhooks with HMAC signatures and retries,
an event feed API, a server-sent events (SSE) stream for the UI, watchers, in-app notifications,
"Your work" page.

**Out**: email notifications (needs SMTP configuration — P3 if time allows), notification schemes
(per-project rules), Slack/Teams integrations, Redis/BullMQ (deferred until multi-instance
deployment; constitution allows file/DB equivalents early).

---

## User stories

### US1 — Every change is a durable event (P1)

As a platform, we need a single, reliable record of changes so that webhooks, live UI, notifications and agents all see the same facts.

**Acceptance scenarios**

1. **Given** any mutation (issue created/updated/deleted, comment created/updated/deleted, issue link created/deleted, board configuration changed), **When** its transaction commits, **Then** an event row is written in the *same* transaction (transactional outbox) with `id` (monotonic), `type`, `occurredAt`, `actor`, `channel`, `projectId`, `issueId?`, and a payload containing the changelog items.
2. **Given** a worker process, **When** it runs, **Then** it dispatches undispatched events to webhooks, the SSE hub and the notification generator, at-least-once, in order per issue.
3. **Given** event retention, **When** events are older than 30 days (configurable), **Then** they are pruned.

### US2 — Webhooks for integrations and agents (P1)

As an integrator, I want to register webhooks filtered by event type and JQL so that my system or agent is notified of relevant changes.

**Independent test**: register a webhook for `jira:issue_updated` with JQL `project = TF AND priority = Highest`; raise TF-3 to Highest; the endpoint receives one signed Jira-shaped payload; a failing endpoint is retried with backoff and shows in the delivery log.

**Acceptance scenarios**

1. **Given** `POST /rest/webhooks/1.0/webhook` with `{ name, url, events[], filters: { "issue-related-events-section": "<JQL>" }, enabled, secret? }`, **When** called by an admin or a token with `admin` scope, **Then** the webhook is created (Jira Server shape); `GET|PUT|DELETE /rest/webhooks/1.0/webhook/{id}` manage it.
2. **Given** a matching event, **When** delivered, **Then** the POST body follows Jira's shape (`timestamp`, `webhookEvent` e.g. `jira:issue_created` | `jira:issue_updated` | `jira:issue_deleted` | `comment_created` | `comment_updated` | `comment_deleted`, `user`, `issue`, `changelog`, `comment`) and includes headers `X-TrackForge-Event-Id` and `X-Hub-Signature-256` (HMAC-SHA256 of the body with the webhook secret).
3. **Given** a non-2xx response or timeout (10 s), **When** delivery fails, **Then** it retries with exponential backoff (up to 8 attempts over ~24 h) and the webhook is auto-disabled after 50 consecutive failures, with an audit entry.
4. **Given** Settings → Webhooks, **When** an admin opens a webhook, **Then** a delivery log shows recent attempts (status, latency, response snippet) with "Redeliver".
5. **Given** a webhook URL pointing to private/loopback addresses, **When** registered, **Then** it is rejected unless `WEBHOOK_ALLOW_PRIVATE=true` (SSRF protection).

### US3 — Event feed for pull-based agents (P1)

As an agent that cannot receive inbound HTTP, I want to fetch events since a cursor so that I never miss a change.

**Acceptance scenarios**

1. **Given** `GET /api/internal/events?after=<cursor>&jql=<optional>&types=<optional>&limit=100`, **When** called with a token, **Then** events visible to that token are returned in order with `nextCursor`.
2. **Given** an expired cursor (older than retention), **When** used, **Then** the response is `410` with guidance to resync via search.

### US4 — Live UI (P1)

As a user, I want boards, lists and issue pages to update when others change things so that I never act on stale data.

**Independent test**: open the TF board in two browsers; drag a card in one; it moves in the other within 2 seconds without reload.

**Acceptance scenarios**

1. **Given** an authenticated browser, **When** the app loads, **Then** it connects to `GET /api/internal/events/stream` (SSE) and receives events it is allowed to see.
2. **Given** an event, **When** received, **Then** the relevant TanStack Query caches are invalidated (issue, lists, board, comments); the user's own optimistic changes are not double-applied.
3. **Given** the issue page, **When** another user edits the issue, **Then** a subtle "Updated by Ana just now" notice appears; if the current user is mid-edit on the same field, their draft is preserved and a conflict notice is shown.
4. **Given** a lost connection, **When** it reconnects, **Then** it resumes from the last event id (`Last-Event-ID`).

### US5 — Watchers and in-app notifications (P2)

As a user, I want to be notified when I'm assigned, mentioned, or when issues I watch change so that I don't miss what matters.

**Acceptance scenarios**

1. **Given** `GET|POST|DELETE /rest/api/2/issue/{key}/watchers`, **When** called, **Then** watchers are managed per Jira (POST body is the accountId string).
2. **Given** an issue, **When** a user creates it, is assigned to it, or comments on it, **Then** they are auto-watched.
3. **Given** events, **When** a user is assigned, mentioned, or a watched issue gets a comment/status change by someone else, **Then** an in-app notification is created; the top-nav bell shows an unread count updated live.
4. **Given** the notification panel, **When** opened, **Then** notifications are grouped by issue, can be marked read individually or all at once, and link to the issue.
5. **Given** an agent account, **When** it is mentioned or assigned, **Then** no in-app notification is created; instead the event is available via webhooks/feed (agents don't have inboxes).

### US6 — "Your work" home page (P2)

As a user, I want a personal home page so that I start the day with what's mine.

**Acceptance scenarios**

1. **Given** `/your-work`, **When** opened, **Then** tabs show **Assigned to me** (unresolved), **Recently viewed**, **Watching**, and an activity stream of recent changes in my projects.
2. **Given** the top nav, **When** rendered, **Then** "Your work" links to this page and is enabled.

---

## Edge cases

- A single transaction producing multiple changes emits one `jira:issue_updated` event with all changelog items (not one per field).
- Events for deleted issues still deliver with the last known issue snapshot.
- Webhook JQL filters are evaluated at dispatch time against the post-change issue.
- SSE behind proxies: send heartbeats every 25 s; disable response buffering.
- Event visibility respects token project allow-lists.

## Functional requirements

- **FR-001**: Events MUST be written transactionally with the change (outbox) and dispatched at-least-once.
- **FR-002**: Webhooks MUST be Jira Server-shaped, HMAC-signed, retried with backoff, and protected against SSRF.
- **FR-003**: An authenticated cursor-based event feed and an SSE stream MUST be available.
- **FR-004**: Watchers MUST be Jira-compatible; notifications MUST be generated for assign, mention, and watched-issue changes, excluding the actor's own actions.
- **FR-005**: No new infrastructure dependency (Redis) unless justified in the plan.
- **FR-006** *(amendment, 2026-11-07 replan — D20)*: The outbox dispatcher MUST sit behind a
  `JobRunner`/`Scheduler` port with an in-process adapter, so Sprint 016 can move dispatch,
  retries and pruning onto the shared Redis+BullMQ runner without touching event producers.
  Scheduled work (pruning, retries) MUST be safe under multiple instances (DB advisory lock
  until 016).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/rest/webhooks/1.0/webhook` | Jira Server |
| GET/PUT/DELETE | `/rest/webhooks/1.0/webhook/{id}` | Jira Server |
| GET | `/api/internal/webhooks/{id}/deliveries` · POST `…/redeliver` | Native |
| GET | `/api/internal/events?after=` | Native event feed |
| GET | `/api/internal/events/stream` | Native SSE |
| GET/POST/DELETE | `/rest/api/2/issue/{key}/watchers` | Jira |
| GET/PUT | `/api/internal/notifications` · `/notifications/read` | Native |

## Data model changes

- **DomainEvent** (outbox): `id` (bigint, monotonic), `type`, `occurredAt`, `actorId`, `channel`, `projectId`, `issueId?`, `payload` JSON, `dispatchedAt?`.
- **Webhook**: `id`, `name`, `url`, `events[]`, `jqlFilter?`, `secretHash`, `enabled`, `failureCount`, `createdById`.
- **WebhookDelivery**: `webhookId`, `eventId`, `attempt`, `status`, `responseCode?`, `latencyMs`, `responseSnippet`, `nextAttemptAt?`.
- **Watcher**: `issueId`, `userId`.
- **Notification**: `id`, `userId`, `eventId`, `reason` (assigned|mentioned|watching), `readAt?`.
- **RecentView**: `userId`, `issueId`, `viewedAt`.

## MCP tools added

`get_events` (cursor + JQL filter — lets agents "catch up"), `register_webhook` / `list_webhooks`
(admin scope), `watch_issue` / `unwatch_issue`, `get_my_work` (assigned, watching). MCP resource
subscriptions emit `notifications/resources/updated` for subscribed `trackforge://issue/{key}`
resources when the event stream reports a change.

## AI-native checklist

- [ ] A6 Reactive — webhooks, cursor feed and MCP resource updates available to agents.
- [ ] Events carry actor + channel so agents can ignore their own changes and avoid loops (A2).
- [ ] Loop guard: a webhook can be configured to exclude events caused by a given agent account.

## Success criteria

- **SC-001**: Zero lost events in a chaos test (worker killed mid-dispatch, DB restart): every committed change is delivered at least once.
- **SC-002**: Two-browser live update latency p95 < 2 s.
- **SC-003**: Webhook payloads validate against Jira payload fixtures for the six event types.
- **SC-004**: Agent eval: an agent subscribed via feed responds to a new Highest-priority bug (e.g. triages and comments) within one polling interval.

## Risks

| Risk | Mitigation |
|---|---|
| Webhook SSRF | Private-range block by default, DNS rebinding check at send time |
| Agent feedback loops (agent reacts to its own events) | Actor/channel in every event; per-webhook actor exclusion |
| Single-process worker limits scale | Outbox design allows swapping in BullMQ/Redis later without changing producers |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Webhook signature verification example (Node and Python) in `docs/webhooks.md`.
- [ ] Top nav "Your work" enabled; notification bell live.

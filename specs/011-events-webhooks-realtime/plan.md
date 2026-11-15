# Plan — Sprint 011 Events, Webhooks & Real-time

## Architecture

```
mutation + recordChange changelog ──┐ (same Prisma transaction)
                              DomainEvent outbox (BigInt id)
                                    │
                        JobRunner 'dispatch' job (500ms)
                          pg_try_advisory_xact_lock
                    ┌───────────────┼────────────────┐
              matchWebhooks    generateNotifications  sseBroadcast
                    │            (assignee/mention/      (in-proc hub)
              WebhookDelivery    watcher fan-out)
              (pending queue)         │
             'deliver' job (1s)   GET /me/notifications
              fetch + HMAC +
              retry/backoff          SSE: GET /events/stream
                                     (Last-Event-ID resume)
                Feed: GET /events?after= (410 expired cursor)
```

## Decisions

- **Outbox inside the domain transaction** — `emitEvent` takes the tx client
  beside `recordChange`, so no mutation can commit without its event. The
  dispatcher never races producers.
- **BigInt monotonic ids as the cursor** — `after=<id>` is the durable
  position; feed returns 410 when it predates the retained window (prune job,
  `EVENT_RETENTION_DAYS`).
- **Event payload carries snapshots** — `issueKey`/`projectKey`/changelog/items
  are denormalized into `payload`, so `jira:issue_deleted` stays useful after
  `issueId` is nulled by FK cleanup.
- **In-process JobRunner behind a port** — Sprint 016 can swap in
  Redis+BullMQ without touching producers. Multi-instance safety comes from a
  transaction-scoped advisory lock (`pg_try_advisory_xact_lock` inside
  `prisma.$transaction` — guaranteed single connection, auto-release; a
  session-level lock can leak across pooled connections, which stalled the
  first implementation).
- **SSRF checked twice** — URL validation at registration and again per
  delivery (DNS can change). Loopback/RFC-1918/link-local blocked unless
  `WEBHOOK_ALLOW_PRIVATE=true`.
- **Cookie auth for SSE + scoped query token** — `EventSource` can't set
  headers; sessions ride the cookie, and `?access_token=` is honoured on
  `/events/stream` only (tokens in URLs are never accepted elsewhere).
- **Targeted query invalidation** — `useEventStream` maps event types to
  React Query keys (issue→`issue`/`issues`, sprint→`sprints`/`backlog`…)
  instead of refetching everything; issue detail also shows an "updated
  elsewhere" conflict notice.
- **Notifications fan out at dispatch**, not at request time — watchers,
  assignees, and `accountId:` mentions produce one deduped `Notification` per
  (user, event, reason); actors never notify themselves and `agent`-channel
  mutations don't generate noise.
- **MCP subscriptions ride the same SSE endpoint** — `registerSubscriptions`
  opens one stream per MCP server session and emits
  `notifications/resources/updated` for `trackforge://events` when matching
  events arrive.

## Risk areas covered by tests

- Cursor expiry → 410 vs never-existed → normal paging
- Token `projectKeys` visibility on feed + stream + single-event lookup
- Watcher add/remove/auth + `isWatching` flip
- Notification dedupe (self-skip, agent-skip, watcher+mention)
- Webhook SSRF (link-local, private ranges), CRUD, secret round-trip
- Recent-view upsert ordering + merge semantics

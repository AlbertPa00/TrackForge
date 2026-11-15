# Sprint 011 spec — Events, Webhooks & Real-time

Source: `docs/sprints/011-events-webhooks-realtime.md`. Status: **Done**.

## Delivered

| US | Deliverable |
|---|---|
| US1 | Transactional outbox: `DomainEvent` (BigInt id, type, occurredAt, actorId, channel, projectId, issueId, payload, dispatchedAt). `emitEvent` writes inside the same Prisma transaction as the mutation + `recordChange` changelog — issue create/update/delete (snapshot retained on delete), comments, issue links, workflow transitions, board config, rank, sprint lifecycle. Payload carries `projectKey`, `issueKey`, changelog items, comment/link/sprint/board extras. |
| US2 | `JobRunner` port in `lib/jobs.ts` with in-process adapter: staggered start, per-job interval loops, `runOnce` for tests. `withAdvisoryLock` uses `pg_try_advisory_xact_lock` inside an interactive transaction — single-connection lock, auto-release, pool-safe. `dispatchEvents` fans each event to webhooks → notifications → SSE, then stamps `dispatchedAt`. `prune` job enforces `EVENT_RETENTION_DAYS` (default 30). |
| US3 | Jira-compatible webhooks: `/rest/webhooks/1.0/webhook` CRUD (`name`, `url`, `events[]`, `jqlFilter`, `secret`, `enabled`, `excludeActorIds`), `WebhookDelivery` records with `attempt`/`nextAttemptAt`/`responseCode`/`latencyMs`, exponential-backoff retries, `failureCount` on the webhook, `X-TrackForge-Signature: sha256=` HMAC, SSRF block on registration *and* delivery (`WEBHOOK_ALLOW_PRIVATE` escape hatch), JQL filter evaluated per event, loop guard via `excludeActorIds`. Admin UI at `/settings/webhooks`; deliveries + redeliver under `/api/internal/webhooks/{id}/deliveries`. |
| US4 | Cursor event feed: `GET /api/internal/events?after=&types=&projects=&limit=` — 410 when `after` predates the retained window, token `projectKeys` intersects the `projects` filter, `nextCursor`/`hasMore` paging, `GET /api/internal/events/{id}` self link. |
| US5 | SSE: `GET /api/internal/events/stream` — `Last-Event-ID`/`?after=` resume with ≤500-event backfill, 25s heartbeat comments, visibility-scoped fan-out, session-cookie auth for `EventSource`, `?access_token=` accepted on stream endpoints only. |
| US6 | Watchers: Jira `GET/POST/DELETE /issue/{key}/watchers` (`watchCount`, `isWatching`), auto-watch on create (reporter) and comment; `Watcher` unique (issue,user). |
| US7 | Notifications: generator fans events to assignees/mentioned users/watchers (skips self + `agent` channel actors), `Notification` rows deduped per (user,event,reason); `/api/internal/me/notifications` list + unread count + `POST /read-all` + `POST /{id}/read`. |
| US8 | Server-side recents: `RecentView` (user,issue,viewedAt) upserted by `POST /me/recent/{key}`; `GET /me/recent` merges with the localStorage list on the client. |
| US9 | Your work: `GET /api/internal/me/work` (assigned/watching/reported/recent + unread notifications), `/your-work` page, live nav entry. |
| US10 | Frontend live layer: `useEventStream` SSE hook → targeted React Query invalidation (`issue`, `issues`, `board`, `backlog`, `sprints`, `notifications`, `work`), reconnect/cleanup; issue-detail "updated elsewhere" notice + watch toggle; TopNav notification bell with unread badge + dropdown. |
| US11 | MCP: `get_events` (cursor feed), `get_event`, `register_webhook`, `list_webhooks`, `delete_webhook`, `watch_issue`, `unwatch_issue`, `get_notifications`, `mark_notifications_read`, `get_my_work`; `trackforge://events` + `trackforge://webhook/{id}` resources; SSE-backed `resources/subscribe` → `notifications/resources/updated` on matching domain events. |

## Verification

- **24/24** Sprint 011 integration tests + full backend suite green (325 tests).
- MCP eval **52/52** live (incl. SSRF block, webhook CRUD, feed cursor resume, watch cycle).
- Live-verified: HMAC deliveries to a local receiver (`match:true` ×3 incl. backlog retry), SSE stream backfill + live events, 410 expired cursor.
- Frontend typecheck/lint/build green.

## Out of scope (per sprint doc)

Vote/watch counts on search results, email delivery (029), push notifications,
attachment events (018), external job runner (016 swaps the adapter), per-user
notification preferences.

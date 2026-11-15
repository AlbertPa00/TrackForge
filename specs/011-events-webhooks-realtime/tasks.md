# Tasks — Sprint 011

- [x] T1 Schema: `DomainEvent` (bigint outbox), `Webhook`, `WebhookDelivery`,
      `Watcher`, `Notification`, `RecentView` + migration (dev + test DBs)
- [x] T2 `eventService.emitEvent` — same-tx outbox writes beside `recordChange`;
      `toEventResponse` Jira-shaped serialization
- [x] T3 `lib/jobs.ts` — JobRunner port, in-process adapter, xact advisory lock,
      SSE hub (`sseSubscribe`/`sseBroadcast`)
- [x] T4 `dispatchService` — dispatch (webhooks+notifications+SSE),
      deliver (pending deliveries), prune jobs
- [x] T5 `webhookService` — registration SSRF check, JQL/event/actor filters,
      HMAC signing, retry/backoff, `failureCount`, redeliver
- [x] T6 Routes: `/rest/webhooks/1.0/webhook` CRUD, `/api/internal/webhooks`
      deliveries, `/api/internal/events` feed + `/stream` + `/{id}`,
      `/issue/{key}/watchers`, `/api/internal/me` (notifications/recent/work)
- [x] T7 `requireAuth` — `?access_token=` on `/events/stream` only
- [x] T8 Event wiring: issue create/update/delete, comments, links,
      transitions, board config/rank, sprint create/update/moves
- [x] T9 `notificationService` — assignee/mention/watcher fan-out, self+agent
      skip, dedupe
- [x] T10 Frontend: `useEventStream`→query invalidation, bell+dropdown,
      `/your-work`, `/settings/webhooks`, watch toggle, live-update notice,
      server-side recents
- [x] T11 MCP: 10 new tools, `events`/`webhook` resources, SSE-backed
      `resources/subscribe`
- [x] T12 Tests: `events.test.ts` 24/24 (feed, 410, SSE, watchers,
      notifications, webhooks SSRF/CRUD, recents, my-work)
- [x] T13 Docs: `docs/webhooks.md` (HMAC Node+Python, retry, SSRF), spec/plan/
      tasks, sprint doc → Done
- [ ] T14 Compat matrix + full verification + commit

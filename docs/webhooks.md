# Webhooks

TrackForge delivers Jira-compatible webhooks for every domain event (issue,
comment, link, board, sprint, workflow changes). Deliveries are signed,
retried with backoff, and protected against SSRF.

## Managing webhooks

Jira-compatible API under `/rest/webhooks/1.0/webhook` (admin scope required):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/rest/webhooks/1.0/webhook` | Register `{ name, url, events[], jqlFilter?, secret?, excludeActorIds? }` |
| `GET` | `/rest/webhooks/1.0/webhook` | List registered webhooks |
| `GET` | `/rest/webhooks/1.0/webhook/{id}` | Fetch one |
| `PUT` | `/rest/webhooks/1.0/webhook/{id}` | Update (url/events/secret/enabled/filters) |
| `DELETE` | `/rest/webhooks/1.0/webhook/{id}` | Delete |

Admins also get a UI at **Settings → Webhooks** (`/settings/webhooks`), and
per-webhook delivery history lives under `GET /api/internal/webhooks/{id}/deliveries`
with `POST .../deliveries/{deliveryId}/redeliver` to replay one.

`events` accepts Jira-style names: `jira:issue_created`, `jira:issue_updated`,
`jira:issue_deleted`, `comment_created`, `comment_updated`, `comment_deleted`,
`issuelink_created`, `issuelink_deleted`, `board_configuration_changed`,
`issue_rank_changed`, `sprint_created`, `sprint_updated`, `sprint_issues_moved`,
`option_watching_changed`. `jqlFilter` optionally restricts issue events with a
JQL expression evaluated against the event's issue snapshot.
`excludeActorIds` prevents loops (e.g. don't fire on your own bot user).

## Payload

Deliveries `POST` a Jira-shaped JSON body:

```json
{
  "timestamp": 1794064442687,
  "webhookEvent": "jira:issue_updated",
  "user": { "accountId": "…", "displayName": "TrackForge Admin" },
  "issue": { "id": "…", "key": "TF-68", "self": "…/rest/api/2/issue/TF-68", "fields": { … } },
  "changelog": { "items": [ { "field": "summary", "fromString": "old", "toString": "new" } ] }
}
```

Comment events carry `comment`, link events carry `issueLink`, and delete
events carry the final issue snapshot — payloads stay meaningful after the
issue row is gone.

## Signature verification

When `secret` is set, deliveries include `X-TrackForge-Signature: sha256=<hex>`
— HMAC-SHA256 of the raw request body. Verify it before parsing:

**Node:**

```js
const crypto = require('crypto');
const sig = req.headers['x-trackforge-signature'];
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return 401;
```

**Python:**

```py
import hmac, hashlib
sig = request.headers.get('X-TrackForge-Signature', '')
expected = 'sha256=' + hmac.new(SECRET.encode(), request.body, hashlib.sha256).hexdigest()
if not hmac.compare_digest(sig, expected):
    return 401
```

## Retry & failure policy

Failed deliveries (network error or non-2xx) retry with exponential backoff
(`attempt` counter on each `WebhookDelivery`). After repeated failures the
webhook's `failureCount` rises — Jira-compatible clients should poll
`GET /rest/webhooks/1.0/webhook` and re-enable or delete stale hooks.
Successful deliveries record `responseCode` and `latencyMs`.

## SSRF protection

Webhook URLs must be `http(s)`. Registration and delivery reject URLs that
resolve to loopback, link-local, or RFC-1918 addresses (`127.0.0.0/8`,
`169.254.0.0/16`, `10/8`, `172.16/12`, `192.168/16`, IPv6 `::1`/`fc00::/7`).
Set `WEBHOOK_ALLOW_PRIVATE=true` to allow private targets in dev/trusted
deployments — only when you control the target network.

## Real-time alternatives

For consumers on the same network, `GET /api/internal/events` offers a
cursor-paged feed of the same outbox (`after=<id>`, `types=`, `projects=`),
and `GET /api/internal/events/stream` is a Server-Sent-Events stream with
`Last-Event-ID` resume and a 25s heartbeat. Session-cookie auth works for
browser `EventSource`; token clients may pass `?access_token=tfp_…` on the
stream endpoint only.

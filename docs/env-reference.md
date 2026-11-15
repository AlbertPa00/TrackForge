# Environment reference

Generated from `apps/backend/src/config.ts` — the single source of truth.
Every setting also accepts a `*_FILE` variant whose **file contents** become
the value (Docker secrets / k8s mounted secrets). Example:
`SESSION_SECRET_FILE=/run/secrets/session_secret`.

## Required in production

| Variable | Format | Why |
|---|---|---|
| `DATABASE_URL` | `postgres://user:pass@host:5432/db` | PostgreSQL connection string |
| `SESSION_SECRET` | string ≥ 32 chars | HMAC secret for session JWTs |

In development both fall back to safe local defaults; in production
`validateEnv()` fails the boot with a readable table before any traffic is
served.

## First-run bootstrap

Used once — only while zero users exist. The bootstrap locks itself after the
first admin is created.

| Variable | Format | Why |
|---|---|---|
| `TF_ADMIN_EMAIL` | email | Initial administrator login (alias: `ADMIN_EMAIL`) |
| `TF_ADMIN_PASSWORD` | string | Initial admin password (`TF_ADMIN_PASSWORD_FILE` recommended) |

## HTTP

| Variable | Default | Why |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | External URL in emails/webhooks |
| `TRUST_PROXY` | unset | `express` trust-proxy value (e.g. `1`, `loopback`) — set behind a reverse proxy so rate limits/secure cookies see the real client IP |
| `CORS_ORIGINS` | `http://localhost:5173` | Dev only — prod is single-origin |
| `FRONTEND_DIST` | `apps/frontend/dist` | Built SPA root for single-origin serving |
| `FRONTEND_URL` | `PUBLIC_BASE_URL` (prod) · `http://localhost:5173` (dev) | SPA origin for browser redirects — the OAuth authorize page bounces here for login when unauthenticated |
| `MCP_RATE_LIMIT` | `600` | Requests/min per IP on `/mcp` before the bearer token resolves |
| `MCP_INTERNAL_URL` | `http://127.0.0.1:$PORT` | Loopback base URL the mounted `/mcp` tools call — override in tests or when REST listens elsewhere |
| `RATE_LIMIT` | `1000` | Requests/min per actor |
| `PRE_AUTH_RATE_LIMIT` | `1200` | Requests/min per IP on `/rest` + `/api/internal` before auth resolves |
| `AUTH_RATE_LIMIT` | `20` | Requests/min per IP on `/api/internal/auth` (login attempts) |
| `SESSION_TTL_HOURS` | `12` | Session JWT lifetime |
| `LOG_LEVEL` | `info` | `debug\|info\|warn\|error` |

## Storage

| Variable | Default | Why |
|---|---|---|
| `ATTACHMENT_STORAGE` | `fs` | `fs` local dir · `s3` S3-compatible (RustFS in compose; MinIO API) · `memory` tests |
| `ATTACHMENT_DIR` | `./attachments` | Root for the `fs` backend |
| `ATTACHMENT_MAX_BYTES` | — | Per-file upload cap |
| `S3_ENDPOINT` | — | Required when `ATTACHMENT_STORAGE=s3` (compose default: `http://s3:9000` RustFS) |
| `S3_BUCKET` | — | Required when `ATTACHMENT_STORAGE=s3` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | S3 credentials (`S3_SECRET_KEY_FILE` ok) |
| `S3_REGION` | `us-east-1` | SigV4 region |

## Infra

| Variable | Default | Why |
|---|---|---|
| `REDIS_URL` | — | Redis queue/pub-sub scale-out |
| `EVENT_RETENTION_DAYS` | `90` | Domain-event retention |

## Backups (044)

| Variable | Default | Why |
|---|---|---|
| `BACKUP_ENABLED` | on in prod, off in dev | Scheduled `backup.run` durable job |
| `BACKUP_DIR` | `./backups` (`/backups` image) | Timestamped backup sets |
| `BACKUP_KEEP` | `14` | Sets retained (prune policy) |
| `BACKUP_INTERVAL_MS` | `86400000` | Schedule interval |

## Operations (044)

| Variable | Default | Why |
|---|---|---|
| `METRICS_BEARER` | unset | Bearer token required on `/metrics` when set — monitoring profile passes it to Prometheus |
| `METRICS_RATE_LIMIT` | `120` | Requests/min per IP on `/metrics` |
| `DEV_WEBHOOK_RATE_LIMIT` | `600` | Requests/min per IP on the `/api/internal/dev` provider receivers |
| `SCIM_RATE_LIMIT` | `600` | Requests/min per IP on `/scim/v2` |
| `AGENT_SESSION_STALE_MS` | `1800000` | Agent sessions idle longer than this are swept to `blocked`; expired questions fail |
| `TOKEN_CACHE_TTL_MS` | `30000` | PAT lookup cache lifetime — a revoked token stays accepted at most this long |
| `TOKEN_TOUCH_INTERVAL_MS` | `300000` | Min interval between `lastUsedAt` writes per token |
| `TOKEN_CACHE_MAX` | `10000` | Max cached principals in the token lookup LRU |
| `TF_DISABLE_UI_RESTORE` | unset | Set to hide the in-UI restore affordance (restore stays CLI/API-only) |
| `TRACKFORGE_SECRET_REF_ALLOW` | unset | Comma-separated env-name allowlist for `secretRef` fields (imports/OAuth) — unset denies all refs |
| `DOCS_DIR` | repo `docs/` | Override the directory served by the docs surface |
| `DOCS_PUBLIC` | unset | `on` serves docs without authentication |
| `UPDATE_CHECK_ENABLED` | `false` | Opt-in: daily durable job polls releases endpoint |
| `UPDATE_CHECK_URL` | repo releases/latest | Endpoint returning `{tag_name}` |
| `UPDATE_CHECK_INTERVAL_MS` | `86400000` | Poll interval |

## Mail

`SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`,
`SMTP_TLS` (`true|false`). `BASE_URL` optionally overrides the link base used
in generated emails (else `PUBLIC_BASE_URL` / the stored mail config).

## OAuth / OIDC

| Variable | Default | Why |
|---|---|---|
| `OAUTH_DCR_ENABLED` | `true` | RFC 7591 dynamic client registration endpoint (`/oauth/register`) |
| `OAUTH_DCR_RATE_LIMIT` | `60` | Requests/min per IP on DCR |

## Misc

| Variable | Default | Why |
|---|---|---|
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Allow webhooks to RFC1918/loopback — dev only (SSRF guard) |
| `TF_VERSION` / `TF_BUILD_DATE` / `TF_BUILD_NUMBER` / `TF_SCM_REVISION` | image-injected | Surfaced on `/rest/api/{2,3}/serverInfo` |

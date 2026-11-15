# Threat model

STRIDE review of TrackForge's attack surfaces (Sprint 016 / FR-005).
**Every sprint that adds attack surface (uploads, inbound webhooks, OIDC,
email, rule execution) MUST extend this file before it can be Done.**

## Surfaces

| Surface | Threats | Mitigations (where) |
|---|---|---|
| Auth (session + PAT) | Spoofing, token theft | Bcrypt hashes; tokens stored as SHA-256 hash only (returned once); session cookie httpOnly; per-request sliding-window rate limit (`auth.ts`) |
| PAT scope bypass | Elevation | `scopes` checked per write/admin; `projectKeys` allow-list → 404 (`projectAllowed`); MCP channel requires token |
| Permissions (015) | Tampering, priv-esc | Single `permissionService` funnel; site-admin bypass audited; last-Administrators guard; architecture test fails on unprotected write path |
| Webhooks (011) | SSRF, secret leak | Target URL validated (http(s) only, no private ranges); HMAC secret per subscription; deliveries async via outbox; secrets never returned after create |
| Markdown/comments (012) | XSS | Server+client render via sanitized Markdown (no raw HTML passthrough); XSS vectors covered in tests |
| Idempotency | Replay, double-apply | `Idempotency-Key` + body-hash check-then-act inside transaction; key scoped per principal |
| Proposals (012) | Confused-deputy writes | Gated principals park writes; approval replays through full route stack with signed `x-trackforge-internal`; approver recorded on changelog |
| MCP/agent | Prompt injection → writes | `requireApproval` principals → proposals; copilot executes confirmed plans only; rationale header audited; agents can self-check via `get_my_permissions` |
| JQL | Injection, perf DoS | Parser whitelist of fields/operators — no raw SQL; value binding via Prisma params; perf budget in CI |
| Issue/CF values | Stored data injection | Zod schemas + per-type validators; JSONB storage; allowed-value enforcement |
| Ops surface (016) | Metric/job data leak | `/admin/jobs` admin-only; `/metrics` restricted to ops networks in deploy docs; `/healthz`/`/readyz` reveal only check names |
| Audit | Repudiation | Mutating admin ops call `audit()` (actor, action, entity, details); changelog records author + channel + approver |
| OAuth 2.1 AS (049) | Redirect-URI abuse, PKCE downgrade, code/refresh replay, DCR abuse, consent CSRF | Exact-match redirect URIs (no wildcards); S256 mandatory — `plain`/absent rejected before consent renders; codes single-use ≤60s bound to client+verifier+URI (transactional claim); refresh rotation with RFC 9700 reuse detection — replayed token revokes the whole grant chain + audit row; `iss` authorization response param (RFC 9207 mix-up defense); consent POST is session-only (bearer can't mint grants) + SameSite=Lax cookie blocks cross-site POST; DCR is public-clients-only, per-IP bucketed (`OAUTH_DCR_RATE_LIMIT`), `OAUTH_DCR_ENABLED` toggle; token endpoint accepts Basic or body client auth, secrets stored hashed |
| SCIM endpoints (049) | Flood, token theft, deprovision-storm | Per-connection bearer (SHA-256 hashed, rotatable, shown once); per-connection rate bucket (`SCIM_RATE_LIMIT`, default 600/min) + global limiter — IdPs ignore 429s so protection is architectural; group member lists bounded at 1500; deprovision deactivates never deletes (provenance) and revokes sessions/PATs/OAuth grants atomically; unknown member ids logged to `syncStatus`, not dropped silently |
| LDAP/directory (049) | Filter injection, plaintext transport, bind-secret leak, downgrade | `tls:none` refused at the admin API — ldaps or starttls only; bind secret via `secretRef: env:VAR` only (never inline, never re-emitted); all `{login}` interpolation RFC 4515-escaped; zero/multiple DN matches fail closed; user rebind failure is an ordinary 401 (no oracle); all-hosts-down returns 503 'directory unavailable' rather than wrong-password; `insecureSkipVerify` opt-in and recorded on the connection |
| Docs portal (050) | Markdown XSS, admin-content leakage, spec disclosure, path traversal | All rendered markdown passes marked→sanitize-html server-side (allowlist tags/schemes, no raw HTML passthrough) *and* DOMPurify for client-rendered content; `audience` enforced server-side — `admin` pages 404 (not 403) for non-admins under any `DOCS_PUBLIC`, so existence isn't leaked; `DOCS_PUBLIC` only widens `authed`→anonymous, never `admin`; `/docs/openapi.json` gated as authed audience (spec discloses the API surface — not served anonymously unless opted in); manifest `source` paths resolved + confined to `docs/` root (traversal rejected); `/docs` SPA excluded from the login-redirect so anonymous readers aren't bounced |
| GitLab add-on (051) | Token theft, webhook forgery, replay/reordering, credential exfiltration via baseUrl, secret echo | API token stored as `env:VAR` reference only — never in DB/responses (`hasSigningToken`/`hasWebhookSecret` booleans leak existence, not values); webhook receiver accepts `X-Gitlab-Token` == webhookSecret *or* `signingToken` (timing-safe compare) and dedupes on `X-Gitlab-Event-Uuid`; `updateSequenceId` is monotonic per connection — stale payloads skipped not reverted; devinfo receiver requires a scoped Bearer PAT; `baseUrl` is admin-configured (admin already holds token authority) and `verifySsl:false` is opt-in + recorded; connection CRUD + outbound branch/MR calls are audit-logged; outbound name/title inputs bounded by zod (≤200–300 chars) |
| Project rollup reads (058) | Cross-project info disclosure via `/projects/{key}/summary` + `/projects/{key}/agent-activity` aggregates | `projectAllowed` token allow-list + `BROWSE_PROJECTS` on the project itself; denial is existence-hiding 404; project key normalized before lookup (lowercase can't bypass); aggregates are projectId-scoped `groupBy`/`findMany` — no cross-project fan-out; denial+scoping covered in `sprint058.test.ts` |
| Agent claim (063) | Double-pickup races across agent fleets; privilege escalation via `delegate` ref; claim bypassing approval policy | `FOR UPDATE SKIP LOCKED` row lock + re-check inside one tx (distinct claims return distinct issues); `isAssignableAgent` + token `projectKeys` + permissions verified before lock; `approvalPolicy: always` routes the claim through the proposal path (`INTERNAL_REST_CLASS`); actor/channel attributed |
| Composite issue PUT (063) | Partial-apply surprise on multi-op request; a later step smuggling a `status` write or bypassing validation | Validate-all-then-apply ordering; `fields.status` still rejected in composite bodies; `dryRun` previews every step before anything writes; changelog emitted per applied op; documented divergence — independently transactional services, not one DB tx |
| MCP readonly toolset (063) | Mutation tools advertised/usable on a read-only endpoint (the mcp-atlassian GHSA failure mode) | `if (write)` gate on every `wtool` registration; readonly server exposes zero `MUTATION_REGISTRY` keys in `tools/list` **and** refuses direct `tools/call`; eval asserts the registry∩list intersection is empty + source scan fails on ungated writes |
| `GET /llms.txt` (063) | Info disclosure on an unauthenticated route | Static onboarding index only — doc paths + endpoint names, no data, no auth surface; nothing dynamic rendered |
| Admin token mint (063) | `POST /api/internal/users/{accountId}/tokens` — admin mints a PAT for another user → elevation/impersonation; token theft in transit/logs | `admin` scope required; minted token inherits the target's own permissions (no elevation beyond the target); secret shown once, stored SHA-256 only; mint recorded via `audit()` with actor |

## Known residuals (accepted / queued)

- `/metrics` is unauthenticated by design (Prometheus pull) — restrict at the
  network layer per deploy docs; it exposes only counters, no payload data.
- SSE `/events/stream` accepts `?access_token=` (EventSource can't set
  headers) — token appears in access logs; short-lived tokens recommended.
- Webhook delivery errors are retried; a hostile endpoint can cost queue
  time — mitigated by per-job attempt caps (dead-letter via `/admin/jobs`).

## Review cadence

- Updated at each sprint adding a surface (see table owners).
- Full re-review at milestone gates (016 H1, 020 H2).

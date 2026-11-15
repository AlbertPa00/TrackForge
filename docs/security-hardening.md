# Security hardening checklist

What's already enforced vs what an operator should still do. App-level
controls shipped in 035 (auth hardening) and 043 (secrets/config).

## Already enforced in-app

- **Passwords** scrypt (async, memory-hard); **TOTP 2FA** (036); session JWT
  httpOnly cookies + `tfp_*` PATs (hashed, scoped, revocable)
- **Rate limiting** on `/rest` + `/api/internal` (`RATE_LIMIT`, default 1000/min)
  plus tighter pre-auth/login/metrics/dev-receiver budgets (065)
- **Permission schemes** + issue-level security (031) — checks are
  server-side on every route, not UI hiding
- **SSRF guard** on webhooks — private/loopback targets blocked unless
  `WEBHOOK_ALLOW_PRIVATE=true` (029)
- **Outbound HTML** sanitized (renderedFields; sanitize-html)
- **Import secrets** redacted in logs; support zip carries no secret values
  (044, tested)
- **Container** runs as non-root `trackforge`, digest-pinned base, no
  dev `.env` in the image
- **Env validation** fails closed on boot (043) — no silent bad config

## Operator must-do

| Step | Why |
|---|---|
| `SESSION_SECRET` ≥ 32 chars, never the dev default | session forgery |
| `*_FILE` for secrets (compose `secrets:` / k8s mounts) | keeps secrets out of `.env` on disk |
| TLS in front (reverse proxy / LB) | app speaks HTTP; `PUBLIC_BASE_URL` must be `https://` |
| Set `METRICS_BEARER` | `/metrics` is unauthenticated by design for scrapers |
| Keep infra ports closed | compose ships them closed — don't re-publish pg/redis/s3 |
| Restrict `/admin` by network if possible | admin surface is cookie-auth'd but extra firewall costs nothing |
| `UPDATE_CHECK_ENABLED` left off if egress is restricted | opt-in phone-home |
| Quarterly: restore drill (`docs/backup-restore.md`) + dependency sweep | backups you can't restore aren't backups |

## Reporting

See `SECURITY.md` — private disclosure, response targets, scope.

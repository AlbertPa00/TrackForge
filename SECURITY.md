# Security policy

## Reporting

Report vulnerabilities privately via GitHub Security Advisories on this
repository. Do not open public issues for security reports. We aim to
acknowledge within 72 hours.

## Supported versions

| Version | Supported |
|---|---|
| latest tag | ✅ |
| older tags | ❌ — upgrade |

## Support matrix

| Component | Version |
|---|---|
| Node.js (runtime) | 20.x (image: `node:20-alpine`) |
| PostgreSQL | 16 |
| Redis | 7 |
| MinIO | `latest` compose pin — pin a digest in production |
| pnpm (build) | 9.15.0 |

## Hardening notes

- Container runs as non-root `trackforge` user; healthcheck on `/healthz`.
- Boot fails closed: `validateEnv()` rejects missing/weak production config
  (see `docs/env-reference.md`).
- Secrets support the `*_FILE` convention — never bake them into the image.
- Inbound webhooks/avatars are SSRF-guarded (`WEBHOOK_ALLOW_PRIVATE=false`).
- Release pipeline: Trivy gate on HIGH/CRITICAL, Syft SBOM attached to each
  release, cosign keyless signatures — verify per `VERIFY.md`.
- gitleaks runs in CI to keep secrets out of history.

## Operator checklist (pre-production, sprint 064)

- **`SESSION_SECRET`** — required, ≥32 random bytes; boot fails closed without
  it in every mode. Rotating it invalidates all sessions (acceptable).
- **`trust proxy`** — if you run behind a LB/reverse proxy, set Express
  `trust proxy` deliberately (e.g. `TRUST_PROXY=1` or a CIDR hop count). Left
  unset, `req.ip` is the proxy address: rate-limit buckets collapse into one
  and audit logs record proxy IPs.
- **`TRACKFORGE_SECRET_REF_ALLOW`** — optional comma-separated env-var names
  that LDAP `secretRef` / GitLab `apiTokenRef` / import `secretRef` may
  reference. TrackForge-internal secrets (`DATABASE_URL`, `SESSION_SECRET`,
  `REDIS_URL`, `METRICS_BEARER`) are refused regardless.
- **`METRICS_BEARER`** — set it or `/metrics` is open.
- **`WEBHOOK_ALLOW_PRIVATE`** — keep `false` unless webhooks must reach
  in-LAN targets; when `true`, every outbound webhook URL is still
  scheme-validated and redirect-hops are re-checked.
- **Rotate** any credential that ever lived in a shared `.env`
  (import tokens like `JIRA_TOKEN`, SMTP passwords, OAuth client secrets).
- **MCP `--http`** — every request needs its own `Authorization: Bearer`;
  there is no daemon-token fallback anymore. Terminate TLS in front of it.
- **Rate limiting** is in-memory per replica (bounded LRU). For multi-replica
  deployments, front the app with an edge limiter or accept per-replica
  budgets; a Redis-backed store is on the hardening backlog.

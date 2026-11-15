# Feature Specification: Identity, Tokens & Audit

**Source doc**: [`docs/sprints/006-identity-tokens-audit.md`](../../docs/sprints/006-identity-tokens-audit.md) — full user stories/FRs there.

## Scope decisions (D4, D5 from roadmap)

- **D4**: JWT session in httpOnly cookie (`tf_session`), dependency `jsonwebtoken`.
- **D5**: native API prefix `/api/internal/*`.
- Passwords: `crypto.scrypt` (memory-hard, zero deps); tokens `tfp_` + sha256 + timingSafeEqual.
- Implemented: US1–US5 (login/logout, admin user mgmt, assignee, tokens+scopes+project allow-list, changelog, audit log, CORS lock-down, rate limit).
- Deferred within scope: password reset emails (admin resets instead), groups/roles, 2FA/OIDC.

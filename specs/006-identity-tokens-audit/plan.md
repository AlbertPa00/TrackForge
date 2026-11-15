# Implementation Plan — Sprint 006: Identity, Tokens & Audit

## Architecture

```
POST /api/internal/auth/login ──► scrypt verify ──► signSession(JWT) ──► tf_session httpOnly cookie
POST /api/internal/auth/logout ──► clear cookie

requireAuth middleware (all /rest + /api/internal):
  Bearer tfp_* → sha256 lookup → user (+scopes, projectKeys, expiry, revokedAt, lastUsedAt)
  Basic base64(email:token) → same token path (Jira-compatible)
  tf_session cookie → JWT verify → user
  ──► req.actor = { user, token?, channel: 'ui'|'api' }

Write paths (issues, sprints, backlog):
  mutation + ChangeHistory{author=actor, channel, tokenId} + ChangeItems  (single transaction)

Admin surface (/api/internal): users CRUD, tokens, audit log (requireAdmin + admin scope)
```

## Key decisions

- **D4** JWT cookie session (no server session store); PATs for API/agents.
- **D5** `/api/internal/*` for native endpoints; `/rest/api/2/user*` stays Jira-shaped.
- scrypt for passwords (memory-hard, zero deps); `tfp_` + sha256 + `timingSafeEqual` for tokens.
- Token project allow-list → 404 (not 403) to avoid leaking project existence, mirroring Jira.
- `ChangeHistory`/`ChangeItem` shipped here (planned for 008 as `IssueChange`) because
  attribution (A2) required it now.
- Reporter comes from `req.actor`, never from request body.

## Files

Backend: `lib/auth.ts`, `middleware/auth.ts`, `services/{user,token,changelog,audit}Service.ts`,
`routes/{auth,users}.ts`, edits to `issueService`, `issues`, `search`, `meta`, `main`, `seed`,
`schema.prisma` (5 new models). Frontend: `LoginPage`, `RequireAuth`, `UserMenu` (in TopNav),
`AssigneePicker`, History section, assignee list filter, `/api` proxy, 401→login redirect.

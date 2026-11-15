# Tasks — Sprint 006: Identity, Tokens & Audit

## Done

- [x] Schema: `User` (human/agent, owner, admin, active), `ApiToken` (hash, scopes, projectKeys, expiry, revocation), `ChangeHistory`/`ChangeItem`, `AuditEvent`; `Issue.assigneeId`/`reporterId` → real user relations
- [x] Auth: scrypt passwords, JWT httpOnly cookie (`tf_session`), Bearer `tfp_` PATs, Basic auth (token as password)
- [x] Middleware: `requireAuth` on `/rest` + `/api/internal`, write-scope check, `requireAdmin`, per-principal rate limit, token project allow-list → 404
- [x] Endpoints: `POST /api/internal/auth/login|logout`, `GET /myself`, `GET /user`, `/user/search`, `/user/assignable/search`, CRUD `GET/POST/PUT /api/internal/users`, `GET/POST/DELETE /api/internal/tokens`, `GET /api/internal/audit`, `PUT /issue/:key/assignee`, `GET /issue/:key/changelog`, `expand=changelog`
- [x] Changelog on all issue mutations (create, update, assignee, transition, sprint move) — actor + channel + token id, atomic with the write
- [x] JQL-lite: `assignee|reporter = <id|email>`, `currentUser()`, `assignee = EMPTY`
- [x] Admin rules: last active admin cannot be demoted/deactivated; agents cannot log in; agent requires owner
- [x] CORS: `CORS_ORIGINS` allow-list + credentials; secret returned once at token creation
- [x] Frontend: `/login` + `RequireAuth` redirect (`?next=`), user menu with logout, AssigneePicker (search, "Assign to me", "Unassigned"), History section on issue detail, assignee filter on List view, `/api` vite proxy
- [x] Seed: admin + 2 humans + 1 agent (`seedUsers`); bootstrap via `ADMIN_EMAIL`/`ADMIN_PASSWORD`
- [x] Tests: `auth.test.ts` (13 tests: login, scopes, allow-list, revocation, assignee, changelog, JQL, admin, agent) + all existing suites authed — **60/60 green**

## Deferred (per spec scope)

- [ ] Admin user-management UI (API-complete; UI later)
- [ ] Token self-service UI (API-complete)
- [ ] Audit log viewer UI (API-complete)

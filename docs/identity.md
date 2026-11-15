# Identity (Sprint 036)

Profiles, password lifecycle, TOTP 2FA, and OIDC SSO.

## Profile & preferences

- `GET /api/internal/me` — identity card + open assigned issues + recent comments.
- `PUT /api/internal/me` — `displayName`, `locale` (e.g. `en_US`), `timezone` (IANA), `dateFormat`.
  Stored on `User` now; rendering/formatting is wired in Sprint 037 (i18n).
- Notification prefs stay under `/api/internal/me/preferences` (Sprint 029 surface).

## Sessions

Every UI login creates a `Session` row; the session JWT carries its `sid`.
`GET /api/internal/me/sessions` enumerates active sessions (`current` flagged);
`DELETE /api/internal/me/sessions/:id` revokes. Password change and admin reset
revoke all *other* sessions (US2-1). Legacy JWTs without `sid` are accepted until
they expire (≤12h) — deployment note, not a gap.

## Password lifecycle

- `PUT /api/internal/me/password` — `{current, new}` (min 8 chars) → other sessions revoked.
- `POST /api/internal/auth/reset-request` — `{email}` → always 204 (no account enumeration).
  In non-SMTP dev environments the token rides the `x-reset-token` response header.
- `POST /api/internal/auth/reset-confirm` — `{token, newPassword}` → token is single-use, 1h TTL.
- `adminResetPassword(userId)` — sets `mustChangePassword`, clears TOTP, revokes sessions,
  returns a reset token the admin can deliver (or that rides the 029 mail outbox).

## TOTP 2FA (RFC 6238, SHA-1/30s, ±1 step skew)

1. `POST /api/internal/me/totp` → `{secret, otpauthUrl}` (not enabled yet — FR-004).
2. `POST /api/internal/me/totp/verify` `{code}` → enables, returns **10 backup codes once**
   (stored SHA-256 hashed, one-use).
3. `DELETE /api/internal/me/totp` `{code}` → disables. `POST /me/totp/backup-codes` `{code}` regenerates.
4. Login: password auth returns `{totpRequired, pending}` (5-minute JWT, `kind:'2fa'`).
   `POST /api/internal/auth/login/totp` `{pending, code}` accepts a TOTP or backup code.

## OIDC SSO

Admin CRUD at `/api/internal/admin/idps` (site-admin only):

```json
{ "name": "corp", "issuer": "https://idp.example.com", "clientId": "...",
  "clientSecret": "...", "scopes": "openid email profile",
  "claimMap": { "email": "email", "emailVerified": "email_verified", "name": "name",
                "tokenEndpoint": "…", "userinfoEndpoint": "…", "authorizationEndpoint": "…" },
  "autoProvision": true, "enabled": true }
```

Flow: `GET /api/internal/auth/oidc/{name}` → authorization-code + PKCE (S256) + state/nonce
→ `/callback` exchanges the code, reads `id_token` claims (or `userinfo` when only an
access token is returned), and:

1. returns the already-linked user (`OidcIdentity.idpId+subject`),
2. links to an existing user **only when the email claim is verified** (FR-002 — never
   auto-merge unverified identities),
3. provisions a new verified user when `autoProvision` is on (else 403).

`GET /api/internal/auth/idps` lists enabled providers for login-page buttons.

### Security notes

- `id_token` signature is checked only when the IdP is configured with a `jwksUri`
  (claimMap); otherwise the token is trusted over the TLS + PKCE channel — documented
  deployment caveat, JWKS verification is a follow-up.
- SSO accounts get a random unknown password; password login for them is impossible
  unless a reset is issued.
- State entries expire after 10 minutes (in-memory — single-process deployment).
- Secrets: `clientSecret` is stored plaintext today; a secret-store reference is a TODO.

## Audit

`login.success`/`login.failure`, `login.oidc`, `identity.reset.request/confirm`,
`identity.idp.*` all write audit rows (FR-005).

## Policy flags

- **Per-group 2FA requirement** — `Group.requireTotp`. Members without TOTP get a session
  but every `requireAuth` endpoint returns 403 `totpEnrollRequired` until they enroll;
  allowlisted: `/me/totp*`, `GET /me`, `/auth/logout`, `/auth/whoami`.
- **SSO-only mode** — `SystemSetting['auth.ssoOnly']` (`setSsoOnly`). Password login
  returns 403 for non-admins; site-admins keep break-glass password access.

## Directory integration (Sprint 049, Track A)

Pick per environment — these are *alternatives* to local provisioning, not additions to it:

| Environment | Authentication | Provisioning |
|---|---|---|
| OIDC-capable IdP (Entra, Okta, Keycloak, Google) | OIDC (036) | **SCIM (049-A1)** |
| LDAP/AD only, no IdP bridge | **LDAP bind (049-A2)** | **LDAP sync (049-A2)** |
| Neither | Local passwords + 2FA (036) | Admin UI |

### SCIM 2.0 service provider (RFC 7643/7644)

Create a connection: `POST /api/internal/admin/directory`
`{type:'scim', name:'Okta', enabled:true}` → response carries `scimToken` **once**
(rotation: `POST /:id/scim-tokens`, revoke: `DELETE …/scim-tokens/:tokenId`).

Point the IdP at `https://<host>/scim/v2` with that bearer. Supported: Users
(create/upsert keyed by `externalId`, PUT, tolerant PATCH `replace`, filter
`userName|externalId eq`, startIndex/count paging), Groups (membership replace
converges; lists bounded at 1500; unknown member ids warn in `syncStatus.log`),
discovery (`/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` — patch+filter
advertised, no bulk).

- **Deprovisioning**: `active:false` or DELETE → user deactivated, sessions +
  PATs + OAuth grants revoked — never deleted (provenance).
- **Rename-safe**: users match by `externalId` identity row, never by name.
  First sync links pre-existing local users by email, then keys by externalId.
- Provisioned users get `passwordHash='!external'` — directory-managed, no local
  password login. Rate limit: `SCIM_RATE_LIMIT` per connection (default 600/min).

### LDAP/AD bind auth + sync

`POST /api/internal/admin/directory` `{type:'ldap', name:'AD', enabled:false, secretRef:'env:LDAP_BIND_PW', config:{…}}`:

```json
{ "hosts": ["dc1.corp.local", "dc2.corp.local"], "port": 636, "tls": "ldaps",
  "bindDn": "cn=svc-trackforge,ou=svc,dc=corp,dc=local", "baseDn": "dc=corp,dc=local",
  "userFilter": "(&(objectClass=person)(sAMAccountName={login}))",
  "attrMap": { "login": "sAMAccountName", "email": "mail",
    "displayName": "displayName", "entryUuid": "objectGUID",
    "disabled": "userAccountControl", "memberOf": "memberOf" },
  "groupMap": { "jira-users": "dev-team" }, "syncIntervalSec": 900 }
```

OpenLDAP variant: `tls:'starttls'`, port 389, `login:'uid'`, `entryUuid:'entryUUID'`.
`insecureSkipVerify: true` exists for self-signed labs (recorded on the connection).

- **Before enabling**: `POST …/directory/:id/test` `{sampleLogin}` → bind +
  sample resolution report. Then set `enabled:true`.
- **Login flow**: service-bind → DN search → rebind-as-user; on success a shadow
  user is provisioned/updated (`passwordHash='!external'` — LDAP passwords are
  never stored). Directory-down → `503 directory unavailable`, not wrong-password.
- **Sync**: `POST …/directory/:id/sync` on demand + scheduled sweep per
  `syncIntervalSec`. Users converge by `entryUuid`/`objectGUID` (rename-safe);
  `userAccountControl` bit 2 or your `attrMap.disabled` → deactivate + revoke;
  `groupMap` ldap-group→TrackForge-group membership applied.
- `tls:'none'` is rejected — no plaintext opt-out. `secretRef` must be `env:VAR`.

## OAuth 2.1 provider (Sprint 049, Track B)

TrackForge is an authorization server for delegated, consented, revocable access.
Discovery: `GET /.well-known/oauth-authorization-server` (RFC 8414); JWKS at
`/oauth/jwks` (RS256); protected-resource metadata at
`/.well-known/oauth-protected-resource` (RFC 9728) and on the MCP HTTP transport.

Grants: `authorization_code` (S256 PKCE mandatory), `refresh_token` (rotating,
RFC 9700 reuse detection kills the chain), `client_credentials` (confidential
clients only, bound `serviceUserId`), `urn:ietf:params:oauth:grant-type:device_code`
(RFC 8628). Implicit and ROPC do not exist.

### Registering a client

- **Pre-registered (admin)**: `POST /api/internal/admin/oauth/clients`
  `{name, redirectUris, grantTypes, allowedScopes, allowedProjectKeys,
  confidential, serviceUserId?, enabled}` → `clientSecret` returned once when
  confidential. Update/delete via `PUT/DELETE …/clients/:id`.
- **Client ID Metadata Document** (MCP): pass an https URL as `client_id` —
  TrackForge fetches + validates the document on first authorize, then caches it.
- **DCR** (`POST /oauth/register`, RFC 7591): public clients only, per-IP
  bucketed (`OAUTH_DCR_RATE_LIMIT`, default 60/min), toggle `OAUTH_DCR_ENABLED`.

### MCP client walkthrough

1. Client hits the MCP HTTP transport without a token → `401` +
   `WWW-Authenticate: Bearer resource_metadata="…/oauth-protected-resource"`.
2. Fetches metadata → `authorization_servers` → AS metadata.
3. Registers (pre-registered → metadata document → DCR, in that priority).
4. `authorization_code`+PKCE (browser consent — **human-only**, a PAT cannot
   mint grants) or `client_credentials` for service accounts; headless CLIs use
   the device grant (`POST /oauth/device` → user approves at `verification_uri`).
5. `Bearer <access-token>` on MCP calls — resolves to the same `Actor` shape as
   a PAT (scopes, project allow-list; FR-001). Tokens are 15-minute JWTs.
6. Users review/revoke at `GET/DELETE /api/internal/me/grants[/id]` — revocation
   kills the refresh chain instantly.

## Deferred

- SAML; outbound SCIM; DPoP/mTLS sender-constrained tokens (P2).
- JWKS signature verification on *inbound* OIDC id_tokens; admin UI page for
  IdPs (directory connections + OAuth clients have admin UI — `AdminIdentityPage`, 049).
- mustChangePassword redirect guard on the frontend (backend flag is set + enforced by revoke).

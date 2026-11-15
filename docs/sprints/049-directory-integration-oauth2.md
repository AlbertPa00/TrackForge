# Sprint 049 — Directory Integration (SCIM/LDAP) & OAuth2 Provider

| | |
|---|---|
| **Status** | Shipped (backend-complete, all local SCs). Track B OAuth 2.1 AS (`21adc7a`, `d0336dc`, `d01ca60`): discovery/JWKS RS256, session-only S256 consent, all four grants incl. RFC 8628 device, rotation + reuse detection, revoke/introspect, DCR + Client ID Metadata Documents, /me/grants, admin CRUD — SC-003 8/8. Track A (`0b8f7e5`, `9d8e87c`): SCIM Users/Groups/discovery + per-conn bearer + deprovision-revoke (SC-001 6/6); LDAP bind-auth + test/sync + scheduled sweep vs real OpenLDAP container (SC-002 4/4, idempotent). MCP transport RFC 9728 + grant tools, SC-004 contract test, SC-005 flood buckets (`5b54803`). Threat-model + docs/identity.md extended. **783/783 suite green.** Admin UI shipped: `/admin/identity` — OAuth client CRUD (grants/scopes/confidential secret one-shot), directory connections (SCIM mint-token banner, LDAP test/sync/enable, `tls:none` refused client-side too). Open follow-ups: DPoP/mTLS (P2), outbound SCIM (out of scope by design). |
| **Milestone** | M5 Enterprise & reach (pull-forward allowed once 036's `IdentityProvider`/`OidcIdentity` model exists) |
| **Theme** | Platform hardening — enterprise identity, both directions: users **in** (directory) and apps **out** (OAuth2 AS) |
| **Depends on** | 006 (auth/token store — shipped), 015 (groups/roles for mapping), 036 (`IdentityProvider`/identity-linking model), 029 (mail for admin alerts); durable runner (016) for LDAP sync jobs |
| **Unblocks** | Directory-managed deployments (AD/LDAP, Entra, Okta); OAuth clients for the MCP HTTP transport and third-party integrations (DESIGN backlog item "OAuth2 provider support") |
| **New dependencies (justify in plan)** | `ldapts` (modern LDAP client), `jose` (asymmetric JWT + JWKS — `jsonwebtoken` is HS-only today) |
| **Spec-kit folder** | `specs/049-directory-integration-oauth2/` |

## Goal

Two independently shippable tracks, each an **alternative** to an existing path — a deployment
chooses per environment:

- **Track A — directory integration**: inbound user lifecycle without hand-managed accounts.
  *A1* SCIM 2.0 service provider (IdP-pushed provisioning — the modern path, RFC 7643/7644).
  *A2* LDAP/AD bind authentication + scheduled sync (the legacy path, for orgs with no
  OIDC-capable IdP — exactly the self-hosted/legacy deployments Workos et al. say LDAP is for).
- **Track B — OAuth2 provider**: TrackForge becomes an OAuth 2.1 authorization server so
  third-party apps and **MCP clients** get delegated, revocable, consented access instead of
  user-bound PATs.

## Alternatives matrix (what a deployment picks)

| Environment | Authentication | Lifecycle/provisioning |
|---|---|---|
| OIDC-capable IdP (Entra, Okta, Keycloak, Google) | OIDC — **036** | **SCIM (049-A1)** |
| LDAP/AD only, no IdP bridge | **LDAP bind (049-A2)** | **LDAP sync (049-A2)** |
| Neither | Local passwords + 2FA (036) | Admin UI |

| External-app need | Mechanism |
|---|---|
| Personal automation / agent acting *as* a user | PAT (006) — unchanged |
| Third-party app acting on a user's behalf (delegated) | **OAuth2 auth-code + PKCE (049-B)** |
| Machine/service account (no user context) | **OAuth2 client_credentials (049-B)** |
| Headless CLI / agent on a box with no browser | **OAuth2 device grant (049-B)** |

## State of the art (verified — drives the design)

- **OAuth 2.1** (draft-ietf-oauth-v2-1-14, Oct 2025) + **RFC 9700** Security BCP (Jan 2025):
  PKCE **mandatory** for all auth-code clients (S256 only); implicit & ROPC grants **do not
  exist**; exact redirect-URI matching; `iss` authorization response param (RFC 9207) against
  mix-up; rotating refresh tokens with **reuse detection** (a replayed refresh token kills the
  grant chain); sender-constrained tokens (DPoP/mTLS) recommended — P2 here.
- **MCP authorization spec** (2025-11-25+): an MCP server is an OAuth 2.1 *resource server* and
  **MUST** serve Protected Resource Metadata (**RFC 9728**); discovery via AS Metadata
  (**RFC 8414**) or OIDC Discovery; `resource` indicators (**RFC 8707**); registration priority
  is *pre-registered → Client ID Metadata Documents → DCR (RFC 7591, deprecated but kept for
  back-compat)*. TrackForge's `apps/mcp` gains real delegated auth through this track — the
  concrete driver, not spec-chasing.
- **SCIM 2.0** (RFC 7643 schema / 7644 protocol): IdP pushes `/Users`, `/Groups` CRUD to us.
  Realities to design for: IdPs **ignore 429s** (flood control must be architectural — bounded
  payload sizes, per-client buckets, async-able bulk), group payloads can carry huge member
  lists, `email` is not guaranteed — `externalId`/`userName` is the stable key, and
  deprovisioning arrives as `active:false` — **deactivate, never delete** (provenance).
- **LDAP/AD** (RFC 4511): the application pattern is *service-bind → search user DN → rebind
  as user*; LDAPS or STARTTLS only (plaintext rejected); AD specifics — `sAMAccountName`/
  `userPrincipalName`, `userAccountControl` disable bit, `memberOf` for groups; failover host
  list + pooled connections.

## User stories

### US1 — SCIM service provider (P1, Track A1)

As an IdP admin, I want users/groups pushed into TrackForge from Entra/Okta/Keycloak.

**Acceptance scenarios**

1. **Given** `POST /scim/v2/Users` with a per-connection bearer token, **When** a user arrives,
   **Then** a TrackForge user is created/linked (`ExternalIdentity(provider:'scim', externalId)`);
   `userName`↔login, `emails[primary]`↔email, `active:false` deactivates + revokes sessions/tokens.
2. **Given** `PUT/PATCH` updates and `?filter=userName eq "…"` / `externalId eq` queries with
   `startIndex`/`count` paging, **When** replayed, **Then** operations are idempotent (same
   externalId converges — no duplicates).
3. **Given** `/scim/v2/Groups` membership replaces, **When** applied, **Then** TrackForge `Group`
   membership converges; unknown users are skipped with a warning entry in the connection's sync log.
4. **Given** `/ServiceProviderConfig` `/ResourceTypes` `/Schemas`, **When** fetched, **Then** they
   accurately advertise supported features (patch, filter, no bulk in v1 unless cheap).
5. **Given** a misbehaving IdP flooding requests or a giant group payload, **When** limits hit,
   **Then** per-connection rate limiting + bounded member lists apply — the API stays up.

### US2 — LDAP/AD bind auth + sync (P1, Track A2)

As an admin on an AD/LDAP shop with no OIDC IdP, I want users to log in with directory credentials.

**Acceptance scenarios**

1. **Given** a `DirectoryConnection` (hosts, port, `tls: ldaps|starttls`, bind DN + `secretRef`,
   base DN, user filter, attribute map, group mapping), **When** `POST …/directory/test` runs,
   **Then** it reports bind/search success and a sample user resolution — before being enabled.
2. **Given** an enabled connection, **When** a user logs in, **Then** service-bind → DN search →
   rebind-as-user authenticates; on success a shadow user is provisioned/updated
   (`passwordHash` stays `!external` — LDAP passwords are never stored).
3. **Given** a scheduled sync job, **When** it runs, **Then** renamed users converge (keyed by
   immutable id — `objectGUID` on AD / `entryUUID` elsewhere), disabled accounts
   (`userAccountControl`) deactivate, and group mappings apply.
4. **Given** LDAP filter config, **When** user input enters a filter, **Then** it is escaped per
   RFC 4515 — no filter injection.
5. **Given** `tls: none` or plaintext attempted, **When** saved, **Then** rejected with a
   remediation hint (no opt-out in v1).

### US3 — OAuth2.1 authorization server (P1, Track B)

As a third-party/MCP client, I want delegated access without holding a user's PAT.

**Acceptance scenarios**

1. **Given** `/.well-known/oauth-authorization-server` (RFC 8414), **When** discovered, **Then**
   authorize/token/revoke/register endpoints, `S256` PKCE methods, grant types, and
   `client_id_metadata_document_supported` are advertised; the MCP HTTP transport serves
   `/.well-known/oauth-protected-resource` (RFC 9728) pointing here.
2. **Given** an admin-registered `OAuthClient` (redirect URIs, grant types, allowed scopes),
   **When** `GET /oauth/authorize?response_type=code&code_challenge=…` runs, **Then** a consent
   page shows client name + scopes + project scope → code issued → `POST /oauth/token` (with
   `code_verifier`) returns a short-lived JWT access token + rotating refresh token.
3. **Given** a used refresh token, **When** rotated, **Then** the new pair issues and the old
   refresh token dies; a **replayed** old token revokes the whole grant chain (RFC 9700) + audit.
4. **Given** `grant_type=client_credentials` on a confidential client, **When** exchanged,
   **Then** an access token for the client-bound service user issues with the client's allowed
   scopes — same `Actor`/scope enforcement as PATs (`hasScope`, `projectAllowed`).
5. **Given** `grant_type=urn:ietf:params:oauth:grant-type:device_code` (RFC 8628), **When** a
   headless CLI starts the flow, **Then** the user approves via the device page and the CLI
   polls for its token.
6. **Given** RFC 7591 `POST /oauth/register` (toggleable, default on with rate limits) and
   Client ID Metadata Documents support, **When** MCP clients connect, **Then** the spec's
   registration priority (pre-registered → metadata document → DCR) works end-to-end.
7. **Given** `resource` parameters (RFC 8707), **When** present, **Then** tokens are audience-
   restricted; missing/unknown audiences are rejected.

### US4 — Grants, revocation & observability (P2)

1. **Given** `/me/grants`, **When** listed, **Then** the user sees consented clients + scopes and
   can revoke → grant chain dies instantly (access tokens are short-lived; refresh dies now).
2. **Given** `/oauth/revoke` (RFC 7009) and `/oauth/introspect` (RFC 7662, admin-scoped), **When**
   called, **Then** tokens revoke / report active state.
3. **Given** any directory or OAuth event (sync diff, client registration, grant issued/revoked,
   refresh replay detected), **When** audited, **Then** it lands in `AuditEvent` with actor.

## Edge cases

- SCIM `externalId` vs `userName` drift (IdP renames) → converge on `externalId`; conflict → report, never merge silently.
- SCIM user with no email → allowed only if `userName` stable; login name = `userName`.
- LDAP bind succeeds but DN search finds zero/multiple users → fail closed, log, surface in connection test.
- LDAP user later provisioned via SCIM/OIDC → `ExternalIdentity` rows coexist; one `User`, many provider links.
- OAuth redirect URIs: exact match only, `localhost` allowed for native clients (RFC 8252), no wildcards.
- Auth codes: single-use, ≤60s TTL, bound to client + PKCE verifier + redirect URI.
- Confidential vs public clients: secret required iff confidential; public clients are PKCE-only.
- LDAP failover: host list tried in order; all-down → local-password users still log in, directory users get a clear "directory unavailable" — not a wrong-password error.
- Token leakage: client secrets, refresh tokens, LDAP bind secret stored hashed/`secretRef` — never in API responses, reports, or logs.

## Functional requirements

- **FR-001**: OAuth access tokens MUST resolve to the same `Actor` shape as PATs — identical
  scope (`read`/`write`/`admin`), `projectKeys` allow-list, and channel attribution; no parallel
  authorization model.
- **FR-002**: OAuth2.1 profile only — auth-code+PKCE(S256), refresh rotation + reuse detection,
  client_credentials, device grant. Implicit/ROPC MUST NOT exist.
- **FR-003**: SCIM deprovisioning MUST deactivate (never delete) and revoke that user's sessions,
  PATs, and OAuth grants.
- **FR-004**: directory users MUST carry `ExternalIdentity` links; a user is matched by immutable
  external id, never by mutable name/email alone (rename-safe).
- **FR-005**: LDAP connections MUST refuse plaintext; bind secret MUST be `secretRef`; filter
  interpolation MUST be RFC 4515-escaped.
- **FR-006**: every inbound attack surface (SCIM endpoints, DCR, authorize, token, device,
  directory admin) MUST be rate-limited, audited, and covered by the threat-model entry.
- **FR-007**: nothing directory- or client-secret-related MUST appear in reports/logs/API output.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/POST/PUT/PATCH/DELETE | `/scim/v2/Users[/{id}]` · `/scim/v2/Groups[/{id}]` | RFC 7644 core; bearer-token auth per connection |
| GET | `/scim/v2/ServiceProviderConfig` · `/ResourceTypes` · `/Schemas` | Discovery |
| GET/POST/PUT/DELETE | `/api/internal/admin/directory[/:id]` · `/test` · `/sync` | LDAP connection admin + on-demand sync |
| GET | `/.well-known/oauth-authorization-server` · `/.well-known/oauth-protected-resource` · `/oauth/jwks` | Discovery + keys |
| GET/POST | `/oauth/authorize` · `/oauth/token` · `/oauth/device` · `/oauth/revoke` · `/oauth/introspect` · `/oauth/register` | AS endpoints (DCR toggleable) |
| GET/POST/PUT/DELETE | `/api/internal/admin/oauth/clients[/:id]` | Client admin (redirects, grants, allowed scopes, service user) |
| GET/DELETE | `/api/internal/me/grants[/:id]` | User consent management |

## Data model changes

- **DirectoryConnection**: `id`, `type: 'ldap'|'scim'`, `name`, config Jsonb (hosts, tls, baseDn,
  filters, attrMap, groupMap — non-secret), `secretRef`, `enabled`, `lastSyncAt`, `syncStatus Jsonb`.
- **ExternalIdentity**: `userId`, `provider: 'ldap'|'scim'|'oidc'` (036's OidcIdentity folds into
  this shape or stays — decide in plan), `externalId`, `directoryConnectionId`, unique
  `(provider, connectionId, externalId)`.
- **ScimToken**: per-connection hashed bearer + rotation metadata (or reuse ApiToken machinery
  with a `scim` marker — decide in plan).
- **OAuthClient**: `id`, `clientId`, `clientSecretHash?` (null = public), `name`, `redirectUris`,
  `grantTypes`, `allowedScopes`, `allowedProjectKeys`, `serviceUserId?` (client_credentials),
  `metadataDocumentUrl?`, `registrationType`, `enabled`.
- **OAuthAuthorizationCode**: hash, `clientId`, `userId`, `redirectUri`, `scopes`, `codeChallenge`,
  `expiresAt` — single-use.
- **OAuthGrant**: `id`, `clientId`, `userId?`, `scopes`, `projectKeys`, `createdAt`, `revokedAt`
  + `OAuthRefreshToken` (hash, grantId, rotatedToId, expiresAt, revokedAt, `reuseDetected` flag).
- Access tokens: short-lived JWT (asymmetric — `jose`, JWKS endpoint); introspection table not
  needed if JWTs carry scope claims.

## MCP tools

Directory/OAuth **admin** stays API-only (human-governed, same stance as 036). User-facing:
`list_my_grants`, `revoke_grant`. The `apps/mcp` HTTP transport serves RFC 9728 metadata so MCP
clients can complete OAuth against TrackForge.

## AI-native checklist

- [ ] An agent holding a scoped OAuth token is indistinguishable from a PAT actor downstream (A1).
- [ ] Connection test + sync status are machine-readable — an agent can diagnose a broken LDAP link.
- [ ] Consent/device approval is human-only by design (documented; agents use client_credentials or device grant).

## Success criteria

- **SC-001**: SCIM round-trip vs recorded IdP fixture (Okta-style payloads): provision → update →
  deactivate → sessions/tokens revoked; idempotent replay.
- **SC-002**: LDAP e2e vs a containerized OpenLDAP (+ AD-flavored attrMap fixture): bind auth,
  provision, rename-converge, disable → deactivate; plaintext config rejected.
- **SC-003**: OAuth e2e: register client → authorize+PKCE → token → API call → refresh rotation →
  replayed-refresh kills chain → revoke → introspect inactive.
- **SC-004**: MCP HTTP transport completes the spec's discovery + registration priority against a
  stock MCP OAuth client (contract test).
- **SC-005**: flood test — SCIM bulk-ish burst + DCR hammering stay within the 016 rate-limit
  envelope with no API degradation.

## Risks

| Risk | Mitigation |
|---|---|
| OAuth2 AS is a large attack surface | OAuth2.1 profile only (no legacy grants), RFC 9700 checklist as DoD items, threat-model entry mandatory |
| IdP SCIM dialects differ (spec is loose) | Recorded fixtures per IdP; conservative schema subset; tolerant PATCH parsing |
| LDAP deployment variance (AD vs OpenLDAP vs FreeIPA) | Attribute map is config, not code; containerized fixture matrix in tests |
| Scope creep toward full IdP | User provisioning only — no outbound SCIM, no group-scheme authoring, no SAML |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] Threat-model entry: AS endpoints (redirect validation, PKCE, code/refresh replay, DCR abuse,
  consent CSRF), SCIM flood + token storage, LDAP injection/TLS/secretRef.
- [ ] `docs/identity.md` extended: alternatives matrix, per-connection setup guides (AD, OpenLDAP,
  Entra SCIM, Okta SCIM, generic LDAP), OAuth client registration guide, MCP-client walkthrough.
- [ ] Integration tests in `apps/backend/tests/integration/` for all four flows; fixtures committed.

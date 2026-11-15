# Sprint 036 — Identity: Profiles, Password Lifecycle, 2FA & SSO

| | |
|---|---|
| **Status** | Done — US1/US2/US3 + policy flags shipped (18090d7, +policy). Deferred: IdP admin UI page, mustChangePassword frontend guard, JWKS signature verification, secret-store refs (documented in identity.md) |
| **Milestone** | M5 Enterprise & reach |
| **Theme** | Platform hardening — enterprise identity (DESIGN Phase 7) |
| **Depends on** | 006 (auth, tokens), 015 (roles for 2FA policy), 021 (admin console shell), 029 (email for password reset + prefs) |
| **Unblocks** | SSO deployments, self-service account management; 039 user-mapping can link SSO identities |
| **New dependencies (justify in plan)** | `openid-client` (OIDC), `otplib` (TOTP 2FA) |
| **Spec-kit folder** | `specs/036-identity-sso-2fa/` |

> **Replan note (2026-11-07):** i18n and accessibility were split into **037** (two distinct
> skill sets; the i18n sweep alone touches every page). US4 below moved there. Threat-model entry
> required: OIDC (state/nonce/PKCE, issuer validation, account-linking takeover), TOTP brute
> force (rate limit + lockout), reset-token handling.

## Goal

The last identity gaps between "internal demo" and "deployable product":

- **User profiles**: `/profile` — activity view, avatar, preferences (timezone, date format,
  email digest — wiring 029 prefs), session list with revoke.
- **Password lifecycle**: change-own-password + admin reset + self-service reset via email
  token (029 mail path).
- **SSO**: OIDC adapter (Google/Microsoft/generic IdP) with account linking and per-IdP
  config; login page "Sign in with …" alongside password.
- **2FA**: optional TOTP (enroll → verify → backup codes) enforced at login; admin can
  require it per-role (015).
- **Preferences** include `locale`/`timezone`/date format (stored here; rendering in 037).

## Why now

SSO/2FA are deployment blockers for many orgs; profiles/preferences are promised by §15.5
and referenced by 029 (prefs) and 036 (locale). i18n is in DESIGN's NFRs and gets harder the
longer it's deferred — do the scaffolding while the surface is still manageable.

## Scope

**In**: profile page + preferences API (`/api/internal/me`, `/me/preferences`); password
change/reset flows; OIDC config entity + `/auth/oidc/{idp}` flow (authorization-code) +
account linking by verified email + admin IdP config page; TOTP enroll/verify/login-challenge +
backup codes + per-role enforcement flag; session enumeration/revoke (`/me/sessions`);
`User.locale` + `User.timezone` stored (DESIGN schema).

**Out**: i18n + a11y → **037**; SAML (OIDC covers the common case — documented), LDAP/SCIM
provisioning → **049**; OAuth2 authorization-server for external apps/MCP clients → **049**;
social auth beyond OIDC, mobile app.

---

## User stories

### US1 — Profile & preferences (P1)

As a user, I want my own account page.

**Independent test**: set timezone + digest pref + locale; sessions list shows current
device; revoke another session → it dies.

**Acceptance scenarios**

1. **Given** `/profile`, **When** rendered, **Then** identity card, recent activity (my issues/comments — existing queries), preferences (timezone, date format, locale, email digest, auto-watch — 029), security section (password change, 2FA, sessions, PATs shortcut to 021 view of own tokens).
2. **Given** `PUT /me/preferences`, **When** saved, **Then** `User.locale/timezone/prefs` persist and drive UI formatting + email language.
3. **Given** `GET/DELETE /me/sessions`, **When** revoked, **Then** the JWT session is invalidated (006 token store).

### US2 — Password & 2FA (P1)

As a user/admin, I want complete credential lifecycle.

**Acceptance scenarios**

1. **Given** change-password (current+new), **When** posted, **Then** other sessions revoked; admin "reset password" forces `mustChangePassword` + optional email reset-link (029).
2. **Given** `/me/reset-request`, **When** emailed, **Then** a one-time expiring token link resets the password without login (Jira parity).
3. **Given** TOTP enroll (secret → QR → verify code), **When** enabled, **Then** login challenges for a code; backup codes (10, one-use, hashed) regenerate-able; `required` flag per role forces enrollment.

### US3 — SSO (P1)

As an admin, I want OIDC SSO so people use company identity.

**Acceptance scenarios**

1. **Given** `/admin/identity` IdP config (issuer, client id/secret, scopes, claim map), **When** enabled, **Then** `/auth/oidc/{idp}` runs the auth-code flow and provisions/links users by verified email claim; `autoProvision` toggle controls first-login account creation.
2. **Given** an existing password user with same verified email, **When** SSO logins occur, **Then** accounts link (`OidcIdentity` row) — no duplicate users.
3. **Given** SSO-only policy flag, **When** set, **Then** password login hides/disables (Jira Cloud parity where IdP governs).

---

## Edge cases

- OIDC email mismatch with existing unverified user → explicit link-required state (never auto-merge unverified).
- TOTP lockout → admin reset path; backup codes honored.
- Password reset token reuse/expiry → invalidated on use + 1h TTL.
- `mustChangePassword` users can't do anything but change it (redirect guard).

## Functional requirements

- **FR-001**: Password/OIDC/TOTP flows MUST NOT weaken 006 token/session guarantees (single audit trail, same token store).
- **FR-002**: OIDC account linking MUST require verified-email claim — documented claim-map per IdP.
- **FR-004**: 2FA enrollment MUST verify a code before enabling (never enable blind).
- **FR-005**: All new endpoints audit-logged (§15.6 security events).

## API surface

| Method | Path | Notes |
|---|---|---|
| GET/PUT | `/api/internal/me` · `/me/preferences` · `/me/password` | Profile |
| GET/DELETE | `/api/internal/me/sessions` | Session management |
| POST | `/api/internal/auth/reset-request` · `/reset-confirm` | Reset flow |
| GET | `/api/internal/auth/oidc/{idp}` · `/auth/oidc/{idp}/callback` | SSO flow |
| GET/POST/PUT/DELETE | `/api/internal/admin/idps` | IdP config |
| POST/DELETE | `/api/internal/me/totp` · `/me/totp/verify` | 2FA |

## Data model changes

- **User**: `locale`, `timezone`, `prefs Jsonb` (029 prefs fold in), `mustChangePassword`, `totpSecret?`, `totpEnabled`, `backupCodes Jsonb?`.
- **OidcIdentity**: `userId`, `idpId`, `subject`, `email`.
- **IdentityProvider**: `id`, `name`, `issuer`, `clientId`, `clientSecretRef`, `claimMap Jsonb`, `autoProvision`, `enabled`.
- **Session** table (or reuse token store) for enumeration/revoke.

## MCP tools added

`get_profile`; `update_preferences` (from 029) gains `locale`/`timezone`/date format.
Identity admin (IdPs, 2FA policy) stays API-only — human-governed by design.

## AI-native checklist

- [ ] Prefs/profile API-complete (A1); agents can read user locale/timezone for formatting (A3).
- [ ] Reset/2FA flows are human-only by design (documented — agents use PATs, not passwords) (A5).
- [ ] Security events audited (A2).

## Success criteria

- **SC-001**: OIDC round-trip: configure → login → linked account → sessions list shows it.
- **SC-002**: TOTP enroll → challenge → backup-code path works; role-forced 2FA enforced.
- **SC-004**: Agent eval: "what are my notification prefs" reads truth via API.

## Risks

| Risk | Mitigation |
|---|---|
| OIDC edge cases per IdP | claim-map config + documented tested IdPs (Google, Entra) |
| 2FA lockout support burden | Backup codes + admin reset path documented |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [x] `docs/identity.md` — IdP setup, claim maps, 2FA policy.

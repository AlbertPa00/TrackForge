// Sprint 036: profile, password lifecycle, sessions, TOTP 2FA, OIDC SSO.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hashPassword, verifyPassword, type Actor } from '../lib/auth.js';
import { sessionSecret } from '../config.js';
import { encryptSecret, readSecret } from '../lib/ai.js';
import { projectAllowed } from '../middleware/auth.js';
import { Prisma } from '../lib/pc.js';
import type { User } from '@prisma/client';

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? '12') * 3600 * 1000;

// ---------- sessions ----------

export async function createSession(
  userId: string,
  req?: { headers?: Record<string, unknown>; ip?: string },
  ttlMs: number = SESSION_TTL_MS
) {
  const s = await prisma.session.create({
    data: {
      userId,
      userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 300) || null,
      ip: req?.ip ?? null,
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return s;
}

export async function touchSession(id: string) {
  await prisma.session.update({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => {});
}

export async function sessionAlive(id: string | undefined | null): Promise<boolean> {
  // 065 audit A1 — sid is mandatory: a session JWT without one (forged or the
  // pre-TOTP 'pending' token) must never authenticate. Old sid-less cookies
  // are invalidated — users log in again.
  if (!id) return false;
  const s = await prisma.session.findUnique({ where: { id } });
  return !!s && !s.revokedAt && s.expiresAt > new Date();
}

export async function listSessions(userId: string, currentSid?: string) {
  const rows = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: 'desc' },
  });
  return rows.map((s) => ({
    id: s.id,
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    current: s.id === currentSid,
  }));
}

export async function revokeSession(userId: string, sessionId: string) {
  const s = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!s || s.userId !== userId) throw new JiraApiError(404, jiraError(['Session not found.']));
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}

export async function revokeOtherSessions(userId: string, keepSid?: string) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(keepSid ? { id: { not: keepSid } } : {}) },
    data: { revokedAt: new Date() },
  });
}

// ---------- profile / preferences ----------

export async function getProfile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const [issues, comments] = await Promise.all([
    prisma.issue.findMany({
      where: { assigneeId: userId, status: { category: { not: 'done' } } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      include: { project: true, status: true, issueType: true },
    }),
    prisma.comment.findMany({
      where: { authorId: userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { issue: { include: { project: true } } },
    }),
  ]);
  return {
    user: pub(user),
    openIssues: issues.map((i) => ({
      id: i.id,
      key: `${i.project.key}-${i.issueNumber}`,
      summary: i.summary,
      status: i.status.name,
      type: i.issueType.name,
    })),
    recentComments: comments.map((c) => ({
      id: c.id,
      issueKey: `${c.issue.project.key}-${c.issue.issueNumber}`,
      body: c.body.slice(0, 200),
      createdAt: c.createdAt,
    })),
  };
}

export async function updateProfile(
  userId: string,
  body: { displayName?: string; locale?: string; timezone?: string; dateFormat?: string; avatarEmoji?: string | null }
) {
  const data: Record<string, unknown> = {};
  if (body.displayName !== undefined) data.displayName = String(body.displayName).slice(0, 200);
  if (body.locale !== undefined) data.locale = String(body.locale).slice(0, 20);
  if (body.timezone !== undefined) data.timeZone = String(body.timezone).slice(0, 60);
  if (body.dateFormat !== undefined) data.dateFormat = String(body.dateFormat).slice(0, 30);
  // Single emoji (grapheme) or null to reset to the name-hash default.
  if (body.avatarEmoji !== undefined) {
    const e = body.avatarEmoji;
    data.avatarEmoji = e === null ? null : [...String(e)].slice(0, 4).join('');
  }
  const u = await prisma.user.update({ where: { id: userId }, data });
  return pub(u);
}

function pub(u: User) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    active: u.active,
    locale: u.locale,
    timezone: u.timeZone,
    dateFormat: u.dateFormat,
    totpEnabled: u.totpEnabled,
    mustChangePassword: u.mustChangePassword,
    avatarEmoji: u.avatarEmoji,
  };
}

/**
 * Read-only profile of any user (Jira ViewProfile parity): identity,
 * locale/timezone prefs, open assigned issues grouped by project, and recent
 * comments. Issue/comment lists are filtered by the caller's token project
 * allow-list, same as JQL search.
 */
export async function getPublicProfile(accountId: string, actor: Actor) {
  const user = await prisma.user.findUnique({ where: { id: accountId } });
  if (!user) throw new JiraApiError(404, jiraError(['User not found.']));
  // Jira shows the Groups box to admins (and on your own profile).
  const showGroups = actor.user.isAdmin || actor.user.id === accountId;
  // 064 US3 — profile issue/comment lists honor BROWSE + allow-list + security.
  const { visibleIssueWhere } = await import('./visibilityService.js');
  const vis = await visibleIssueWhere(actor);
  const [issues, comments, memberships] = await Promise.all([
    prisma.issue.findMany({
      where: { assigneeId: accountId, status: { category: { not: 'done' } }, AND: [vis] },
      orderBy: [{ project: { key: 'asc' } }, { priority: { sequence: 'asc' } }, { issueNumber: 'asc' }],
      take: 200,
      include: { project: true, status: true, issueType: true, priority: true },
    }),
    prisma.comment.findMany({
      where: { authorId: accountId, issue: vis },
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: { issue: { include: { project: true } } },
    }),
    showGroups
      ? prisma.groupMember.findMany({ where: { userId: accountId }, include: { group: true } })
      : Promise.resolve([]),
  ]);
  const byProject = new Map<
    string,
    {
      project: { key: string; name: string };
      issues: {
        key: string;
        summary: string;
        status: string;
        statusCategory: string;
        type: string;
        priority: string | null;
      }[];
    }
  >();
  for (const i of issues) {
    if (!projectAllowed(actor, i.project.key)) continue;
    let g = byProject.get(i.project.key);
    if (!g) byProject.set(i.project.key, (g = { project: { key: i.project.key, name: i.project.name }, issues: [] }));
    g.issues.push({
      key: `${i.project.key}-${i.issueNumber}`,
      summary: i.summary,
      status: i.status.name,
      statusCategory: i.status.category,
      type: i.issueType.name,
      priority: i.priority?.name ?? null,
    });
  }
  return {
    user: {
      accountId: user.id,
      displayName: user.displayName,
      emailAddress: user.email,
      active: user.active,
      ...(user.type === 'agent' ? { agent: true } : {}),
      locale: user.locale,
      timezone: user.timeZone,
      dateFormat: user.dateFormat,
      avatarEmoji: user.avatarEmoji,
      ...(showGroups ? { groups: memberships.map((m) => m.group.name).sort() } : {}),
    },
    openIssuesByProject: [...byProject.values()],
    recentComments: comments
      .filter((c) => projectAllowed(actor, c.issue.project.key))
      .slice(0, 10)
      .map((c) => ({
        id: c.id,
        issueKey: `${c.issue.project.key}-${c.issue.issueNumber}`,
        body: c.body.slice(0, 200),
        createdAt: c.createdAt,
      })),
  };
}

// ---------- password lifecycle ----------

export async function changePassword(user: User, current: string, next: string, keepSid?: string) {
  if (!user.passwordHash || !(await verifyPassword(current, user.passwordHash))) {
    throw new JiraApiError(400, jiraError([], { current: 'Current password is incorrect.' }));
  }
  if (next.length < 8) throw new JiraApiError(400, jiraError([], { new: 'Password must be at least 8 characters.' }));
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(next), mustChangePassword: false },
  });
  await revokeOtherSessions(user.id, keepSid); // US2-1: other sessions die
}

export async function adminResetPassword(adminId: string, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new JiraApiError(404, jiraError(['User not found.']));
  await prisma.user.update({
    where: { id: userId },
    data: { mustChangePassword: true, totpEnabled: false, totpSecret: null, backupCodes: Prisma.JsonNull },
  });
  await revokeOtherSessions(userId);
  return issueResetToken(userId); // returns the link for admin-delivered or emailed reset
}

// 065 audit G2 — invites reuse reset tokens but need days, not an hour;
// password resets keep the tight window.
export async function issueResetToken(userId: string, ttlMs = 3600_000) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.passwordResetToken.create({
    data: {
      userId,
      hash: crypto.createHash('sha256').update(raw).digest('hex'),
      expiresAt: new Date(Date.now() + ttlMs),
    },
  });
  return raw;
}

export async function requestReset(email: string): Promise<string | null> {
  // Never reveal whether the account exists — return token only for internal/test use.
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !user.active) return null;
  return issueResetToken(user.id);
}

export async function confirmReset(token: string, newPassword: string) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const t = await prisma.passwordResetToken.findUnique({ where: { hash } });
  if (!t || t.usedAt || t.expiresAt < new Date()) {
    throw new JiraApiError(400, jiraError(['Reset link is invalid or expired.']));
  }
  if (newPassword.length < 8)
    throw new JiraApiError(400, jiraError([], { newPassword: 'Password must be at least 8 characters.' }));
  await prisma.passwordResetToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  await prisma.user.update({
    where: { id: t.userId },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
  });
  await revokeOtherSessions(t.userId);
}

/** 060 US5 — accepting an invite is a password reset that also activates the
    account (invitees are created inactive). */
export async function confirmInvite(token: string, newPassword: string) {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const t = await prisma.passwordResetToken.findUnique({ where: { hash } });
  if (!t || t.usedAt || t.expiresAt < new Date()) {
    throw new JiraApiError(400, jiraError(['Invite link is invalid or expired.']));
  }
  if (newPassword.length < 8)
    throw new JiraApiError(400, jiraError([], { newPassword: 'Password must be at least 8 characters.' }));
  // 061 US2 — invite-accept only activates a pending invitee. Without this a
  // password-reset token presented to /invite/:token could silently re-activate
  // an account an admin deactivated.
  const target = await prisma.user.findUniqueOrThrow({ where: { id: t.userId } });
  if (!target.invitedAt) {
    throw new JiraApiError(400, jiraError(['Invite link is invalid or expired.']));
  }
  await prisma.passwordResetToken.update({ where: { id: t.id }, data: { usedAt: new Date() } });
  const user = await prisma.user.update({
    where: { id: t.userId },
    data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false, active: true, invitedAt: null },
  });
  await revokeOtherSessions(t.userId);
  return user;
}

// ---------- TOTP (RFC 6238, no external dep) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function genSecret(): string {
  const b = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 32; i++) {
    const byte = b[Math.floor((i * 5) / 8)] ?? 0;
    const next = b[Math.floor((i * 5) / 8) + 1] ?? 0;
    const shift = (i * 5) % 8;
    const val = (((byte << 8) | next) >> (11 - shift)) & 31;
    out += B32[val];
  }
  return out;
}

function b32decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bits = clean
    .split('')
    .map((c) => B32.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret: string, at = Date.now()): string {
  const counter = Math.floor(at / 30000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function totpOk(secret: string, code: string): boolean {
  for (const skew of [-30000, 0, 30000]) {
    if (totpCode(secret, Date.now() + skew) === code) return true;
  }
  return false;
}

// 065 audit A4 — backup codes were unsalted sha256 (DB leak → offline brute
// force of the 32-bit code space). v2 is an HMAC keyed by SESSION_SECRET: the
// key lives in env, not the DB. v1 kept for rows hashed before this change.
function hashCode(c: string) {
  return crypto.createHash('sha256').update(c).digest('hex');
}
function hashCodeV2(c: string) {
  return crypto.createHmac('sha256', sessionSecret()).update(`backup:${c}`).digest('hex');
}

// 065 audit A4 — /me/totp/* re-check the TOTP, so they share the login
// endpoint's attempt budget: 5 misses per 5 min per user.
const mgmtAttempts = new Map<string, { count: number; reset: number }>();
const MGMT_MAX_ATTEMPTS = 5;
function assertMgmtAttempt(userId: string) {
  const a = mgmtAttempts.get(userId);
  if (a && a.reset > Date.now() && a.count >= MGMT_MAX_ATTEMPTS) {
    throw new JiraApiError(429, jiraError(['Too many attempts — try again later.']));
  }
}
function recordMgmtFailure(userId: string) {
  const now = Date.now();
  const a = mgmtAttempts.get(userId);
  if (!a || a.reset <= now) mgmtAttempts.set(userId, { count: 1, reset: now + 5 * 60_000 });
  else a.count += 1;
}

export async function totpEnroll(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.totpEnabled) throw new JiraApiError(400, jiraError(['2FA is already enabled.']));
  const secret = genSecret();
  await prisma.user.update({ where: { id: userId }, data: { totpSecret: secret } });
  const label = encodeURIComponent(`TrackForge:${user.email}`);
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=TrackForge` };
}

export async function totpVerify(userId: string, code: string) {
  assertMgmtAttempt(userId);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpSecret || !totpOk(user.totpSecret, code)) {
    recordMgmtFailure(userId);
    throw new JiraApiError(400, jiraError([], { code: 'Invalid code.' }));
  }
  mgmtAttempts.delete(userId);
  const backup = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex'));
  await prisma.user.update({
    where: { id: userId },
    data: { totpEnabled: true, backupCodes: backup.map(hashCodeV2) },
  });
  return { backupCodes: backup }; // shown once (FR-004: verified before enabling)
}

export async function totpDisable(userId: string, code: string) {
  assertMgmtAttempt(userId);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpEnabled) return;
  if (!user.totpSecret || !totpOk(user.totpSecret, code)) {
    recordMgmtFailure(userId);
    throw new JiraApiError(400, jiraError([], { code: 'Invalid code.' }));
  }
  mgmtAttempts.delete(userId);
  await prisma.user.update({
    where: { id: userId },
    data: { totpEnabled: false, totpSecret: null, backupCodes: Prisma.JsonNull },
  });
}

export async function regenerateBackupCodes(userId: string, code: string) {
  assertMgmtAttempt(userId);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.totpEnabled || !user.totpSecret || !totpOk(user.totpSecret, code)) {
    recordMgmtFailure(userId);
    throw new JiraApiError(400, jiraError([], { code: 'Invalid code.' }));
  }
  mgmtAttempts.delete(userId);
  const backup = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex'));
  await prisma.user.update({ where: { id: userId }, data: { backupCodes: backup.map(hashCodeV2) } });
  return { backupCodes: backup };
}

/** Second-factor check at login. Returns true when the code (TOTP or one-use backup) passes. */
export async function consumeSecondFactor(user: User, code: string): Promise<boolean> {
  if (user.totpSecret && totpOk(user.totpSecret, code)) return true;
  const codes = (user.backupCodes as string[] | null) ?? [];
  // Accept v1 (legacy sha256) or v2 (HMAC) hashes…
  const h = [hashCodeV2(code), hashCode(code)].find((x) => codes.includes(x));
  if (!h) return false;
  // 065 audit A4 — atomic consume: read→splice→write let two concurrent
  // requests spend the same code. The @> membership check makes the UPDATE
  // a no-op when the code was already consumed (0 rows → reject).
  const removed = await prisma.$executeRaw`
    UPDATE "User" SET "backupCodes" = (
      SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
      FROM jsonb_array_elements_text("backupCodes") e WHERE e <> ${h}
    )
    WHERE id = ${user.id} AND "backupCodes" @> to_jsonb(${h}::text)`;
  return removed === 1;
}

// ---------- OIDC ----------

export interface IdpPublic {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  scopes: string;
  autoProvision: boolean;
  enabled: boolean;
  claimMap: Record<string, string>;
}

export async function listIdps(): Promise<IdpPublic[]> {
  const rows = await prisma.identityProvider.findMany({ orderBy: { name: 'asc' } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    issuer: r.issuer,
    clientId: r.clientId,
    scopes: r.scopes,
    autoProvision: r.autoProvision,
    enabled: r.enabled,
    claimMap: (r.claimMap as Record<string, string>) ?? {},
  }));
}

export async function upsertIdp(body: Record<string, unknown>, id?: string): Promise<IdpPublic> {
  if (id) {
    // 065 audit A6 — PUT is a PARTIAL update: untouched fields keep their
    // values (a {enabled:false} PATCH previously wiped name/issuer/clientId
    // and reset autoProvision). clientSecret only changes when provided.
    const data: Record<string, unknown> = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.issuer !== undefined) data.issuer = String(body.issuer);
    if (body.clientId !== undefined) data.clientId = String(body.clientId);
    // 065 F3 — secrets are AES-256-GCM encrypted at rest (readSecret handles
    // legacy plaintext rows).
    if (body.clientSecret !== undefined)
      data.clientSecret = body.clientSecret == null ? null : encryptSecret(String(body.clientSecret));
    if (body.scopes !== undefined) data.scopes = String(body.scopes);
    if (body.claimMap !== undefined) data.claimMap = body.claimMap as object;
    if (body.autoProvision !== undefined) data.autoProvision = body.autoProvision !== false;
    if (body.enabled !== undefined) data.enabled = body.enabled !== false;
    if (!Object.keys(data).length) {
      throw new JiraApiError(400, jiraError(['No fields to update.']));
    }
    const row = await prisma.identityProvider.update({ where: { id }, data }).catch(() => {
      throw new JiraApiError(404, jiraError(['Identity provider not found.']));
    });
    return (await listIdps()).find((i) => i.id === row.id)!;
  }
  const data = {
    name: String(body.name ?? ''),
    issuer: String(body.issuer ?? ''),
    clientId: String(body.clientId ?? ''),
    clientSecret: body.clientSecret != null ? encryptSecret(String(body.clientSecret)) : undefined,
    scopes: String(body.scopes ?? 'openid email profile'),
    claimMap: (body.claimMap ?? {}) as object,
    autoProvision: body.autoProvision !== false,
    enabled: body.enabled !== false,
  };
  if (!data.name || !data.issuer || !data.clientId) {
    throw new JiraApiError(400, jiraError(['name, issuer and clientId are required.']));
  }
  const row = await prisma.identityProvider.create({ data: data as never });
  return (await listIdps()).find((i) => i.id === row.id)!;
}

// In-memory OIDC flow state (state → {idpId, nonce, verifier, redirectUri}).
// Single-process only — fine for v1. redirectUri is bound at authorize time
// and re-checked at callback (065 A6): a swapped redirect_uri never reaches
// the token exchange.
export const oidcStates = new Map<
  string,
  { idpId: string; nonce: string; verifier: string; redirectUri: string; at: number; next?: string }
>();

export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export async function beginOidc(idpName: string, redirectUri: string, next?: string) {
  const idp = await prisma.identityProvider.findUnique({ where: { name: idpName } });
  if (!idp || !idp.enabled) throw new JiraApiError(404, jiraError(['Identity provider not found.']));
  const state = crypto.randomBytes(16).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const { verifier, challenge } = pkce();
  oidcStates.set(state, { idpId: idp.id, nonce, verifier, redirectUri, at: Date.now(), next });
  for (const [k, v] of oidcStates) if (Date.now() - v.at > 10 * 60_000) oidcStates.delete(k);
  const cm = (idp.claimMap as Record<string, string>) ?? {};
  const authBase = cm.authorizationEndpoint ?? `${idp.issuer.replace(/\/$/, '')}/authorize`;
  const u = new URL(authBase);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', idp.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', idp.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return { redirectTo: u.toString(), state };
}

interface OidcClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  iss?: string;
  aud?: string | string[];
  nonce?: string;
}

// 064 US5 — OIDC id_tokens were decoded but never verified. Now: signature
// via the IdP's JWKS (or HS256 with the client secret), iss/aud/exp checks,
// and a mandatory nonce match (startOidc always sends one).
const JWKS_CACHE = new Map<string, { at: number; keys: { kid?: string }[] }>();
const LOCAL_ISSUER_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

async function jwksKeys(jwksUri: string): Promise<{ kid?: string }[]> {
  const hit = JWKS_CACHE.get(jwksUri);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.keys;
  const res = await fetch(jwksUri, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new JiraApiError(400, jiraError(['IdP JWKS fetch failed.']));
  const keys = ((await res.json()) as { keys?: { kid?: string }[] }).keys ?? [];
  JWKS_CACHE.set(jwksUri, { at: Date.now(), keys });
  return keys;
}

async function discoverJwksUri(issuer: string): Promise<string | null> {
  try {
    const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { jwks_uri?: string }).jwks_uri ?? null;
  } catch {
    return null;
  }
}

function assertIssuerTransport(issuer: string) {
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    throw new JiraApiError(400, jiraError(['SSO issuer is not a valid URL.']));
  }
  if (u.protocol !== 'https:' && !LOCAL_ISSUER_HOSTS.includes(u.hostname)) {
    throw new JiraApiError(400, jiraError(['SSO issuer must be https.']));
  }
}

async function verifyOidcIdToken(
  idp: { issuer: string; clientId: string; clientSecret: string | null; claimMap: unknown },
  idToken: string,
  expectedNonce: string
): Promise<OidcClaims> {
  const cm = (idp.claimMap as Record<string, string>) ?? {};
  const decoded = jwt.decode(idToken, { complete: true }) as { header: { alg?: string; kid?: string } } | null;
  if (!decoded?.header) throw new JiraApiError(400, jiraError(['Invalid id_token.']));
  const alg = decoded.header.alg ?? 'RS256';
  let claims: OidcClaims;
  if (alg === 'HS256') {
    if (!idp.clientSecret) {
      throw new JiraApiError(400, jiraError(['HS256 id_token but no client secret configured.']));
    }
    claims = jwt.verify(idToken, readSecret(idp.clientSecret), { algorithms: ['HS256'] }) as OidcClaims;
  } else {
    const jwksUri = cm.jwksUri ?? (await discoverJwksUri(idp.issuer));
    if (!jwksUri) {
      throw new JiraApiError(400, jiraError(['IdP publishes no JWKS URI — id_token cannot be verified.']));
    }
    const keys = await jwksKeys(jwksUri);
    const jwk = keys.find((k) => k.kid === decoded.header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
    if (!jwk) throw new JiraApiError(400, jiraError(['IdP key not found in JWKS.']));
    const pem = crypto
      .createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' })
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const allowed = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
    if (!allowed.includes(alg)) throw new JiraApiError(400, jiraError([`Unsupported id_token algorithm '${alg}'.`]));
    claims = jwt.verify(idToken, pem, { algorithms: [alg as jwt.Algorithm] }) as OidcClaims;
  }
  // 065 audit A6 — iss and aud are REQUIRED claims (OIDC Core §3.1.3.7):
  // absent claims previously skipped the comparison entirely.
  if (!claims.iss || claims.iss.replace(/\/+$/, '') !== idp.issuer.replace(/\/+$/, '')) {
    throw new JiraApiError(400, jiraError(['id_token issuer mismatch.']));
  }
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(idp.clientId) : claims.aud === idp.clientId;
  if (!claims.aud || !audOk) throw new JiraApiError(400, jiraError(['id_token audience mismatch.']));
  if (claims.nonce !== expectedNonce) {
    throw new JiraApiError(400, jiraError(['Nonce mismatch.']));
  }
  return claims;
}

/** Exchange the code, verify the id_token, link/provision the user. Returns the TrackForge user. */
export async function finishOidc(idpName: string, code: string, state: string, redirectUri: string): Promise<User> {
  const pending = oidcStates.get(state);
  oidcStates.delete(state);
  if (!pending) throw new JiraApiError(400, jiraError(['Invalid or expired SSO state.']));
  const idp = await prisma.identityProvider.findUnique({ where: { name: idpName } });
  if (!idp || idp.id !== pending.idpId) throw new JiraApiError(400, jiraError(['SSO flow mismatch.']));
  // 065 A6 — the callback's redirect_uri must equal the authorize leg's;
  // the token exchange always uses the bound value, not the caller's.
  if (redirectUri !== pending.redirectUri) {
    throw new JiraApiError(400, jiraError(['SSO redirect_uri mismatch.']));
  }
  const cm = (idp.claimMap as Record<string, string>) ?? {};
  assertIssuerTransport(idp.issuer);
  const tokenEndpoint = cm.tokenEndpoint ?? `${idp.issuer.replace(/\/$/, '')}/token`;

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(10_000), // 065 A6 — a stalled IdP wedged the login worker
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: idp.clientId,
      code_verifier: pending.verifier,
      ...(idp.clientSecret ? { client_secret: readSecret(idp.clientSecret) } : {}),
    }),
  });
  if (!resp.ok) throw new JiraApiError(400, jiraError(['SSO token exchange failed.']));
  const tokens = (await resp.json()) as { id_token?: string; access_token?: string };

  let claims: OidcClaims;
  if (tokens.id_token) {
    // 064 US5 — signature + iss/aud/nonce verified; plain decode was a forgery path.
    claims = await verifyOidcIdToken(idp, tokens.id_token, pending.nonce);
  } else if (tokens.access_token) {
    const ui = await fetch(cm.userinfoEndpoint ?? `${idp.issuer.replace(/\/$/, '')}/userinfo`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!ui.ok) throw new JiraApiError(400, jiraError(['SSO userinfo failed.']));
    claims = (await ui.json()) as OidcClaims;
  } else {
    throw new JiraApiError(400, jiraError(['SSO returned no identity.']));
  }

  const emailClaim = cm.email ?? 'email';
  const verifiedClaim = cm.emailVerified ?? 'email_verified';
  const email = String((claims as unknown as Record<string, unknown>)[emailClaim] ?? '').toLowerCase();
  const verified = Boolean((claims as unknown as Record<string, unknown>)[verifiedClaim]);
  if (!email || !claims.sub) throw new JiraApiError(400, jiraError(['IdP did not return subject/email claims.']));
  // FR-002: account linking requires the verified-email claim.
  if (!verified) throw new JiraApiError(403, jiraError(['IdP email claim is not verified — cannot link account.']));

  // 1. existing linked identity
  const linked = await prisma.oidcIdentity.findUnique({
    where: { idpId_subject: { idpId: idp.id, subject: claims.sub } },
    include: { user: true },
  });
  if (linked) return linked.user;

  // 2. link to existing verified user by email
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    await prisma.oidcIdentity.create({ data: { userId: existing.id, idpId: idp.id, subject: claims.sub, email } });
    return existing;
  }

  // 3. provision
  if (!idp.autoProvision)
    throw new JiraApiError(403, jiraError(['No account exists and auto-provisioning is disabled.']));
  const user = await prisma.user.create({
    data: {
      email,
      displayName: String((claims as unknown as Record<string, unknown>)[cm.name ?? 'name'] ?? email.split('@')[0]),
      passwordHash: await hashPassword(crypto.randomBytes(24).toString('hex')), // SSO-only account
      emailVerified: true,
    },
  });
  await prisma.oidcIdentity.create({ data: { userId: user.id, idpId: idp.id, subject: claims.sub, email } });
  return user;
}

// ---------- policy flags (036 US2-3/US3-3) ----------

/** Groups that force 2FA enrollment — member lookup per login/gate. */
export async function userNeedsTotpEnroll(userId: string): Promise<boolean> {
  const n = await prisma.groupMember.count({
    where: { userId, group: { requireTotp: true } },
  });
  return n > 0;
}

export async function isSsoOnly(): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'auth.ssoOnly' } });
  return row?.value === true;
}

export async function setSsoOnly(v: boolean) {
  await prisma.systemSetting.upsert({
    where: { key: 'auth.ssoOnly' },
    create: { key: 'auth.ssoOnly', value: v },
    update: { value: v },
  });
}

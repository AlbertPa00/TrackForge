import type { NextFunction, Request, Response } from 'express';
import type { ApiToken } from '@prisma/client';
import { prisma } from '../prisma.js';
import { actorFromAccessToken } from '../services/oauthService.js';
import {
  Actor,
  INTERNAL_HEADER,
  SESSION_COOKIE,
  hashToken,
  parseCookies,
  verifyInternalActor,
  verifySession,
} from '../lib/auth.js';
import { jiraError, JiraApiError } from '../lib/errors.js';
import { parseIssueKeyParts } from '../lib/issueKey.js';
import { hasPermission } from '../services/permissionService.js';
import { canSeeIssue } from '../services/issueSecurityService.js';
import { lookupApiToken, storeApiToken, markTokenTouched } from '../lib/tokenCache.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      sessionId?: string; // 036 — Session row id carried by the session JWT
      needsTotpEnroll?: boolean; // 036 — group policy forces 2FA enrollment
      mustChangePassword?: boolean; // 065 A7 — admin reset forces a password change
    }
  }
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function hasScope(actor: Actor, scope: 'read' | 'write' | 'admin'): boolean {
  const scopes = actor.token?.scopes;
  if (!scopes) return true; // session = full user rights
  if (scopes.includes('admin')) return true;
  if (scope === 'write') return scopes.includes('write') || scopes.includes('admin');
  if (scope === 'admin') return scopes.includes('admin');
  return scopes.includes('read') || scopes.includes('write');
}

async function actorFromBearer(header: string): Promise<Actor | null> {
  const hash = hashToken(header);
  // 070 — cached {token,user} pair; a fleet of agents no longer pays a
  // findUnique per request, and lastUsedAt collapses to ≤1 write per
  // TOKEN_TOUCH_INTERVAL_MS instead of one per request.
  const hit = lookupApiToken(hash);
  const token = hit?.token ?? (await prisma.apiToken.findUnique({ where: { hash }, include: { user: true } }));
  if (token && !token.revokedAt && (!token.expiresAt || token.expiresAt >= new Date())) {
    if (!token.user.active) return null;
    if (!hit) storeApiToken(hash, token);
    if (!hit || hit.touchDue) {
      markTokenTouched(hash);
      // update lastUsedAt fire-and-forget
      void prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return { user: token.user, token, channel: 'api' };
  }
  // 049 — OAuth 2.1 access tokens (RS256 JWT) resolve to the same Actor shape (FR-001).
  const oauth = await actorFromAccessToken(header).catch(() => null);
  if (!oauth) return null;
  const user = await prisma.user.findUnique({ where: { id: oauth.userId } });
  if (!user || !user.active) return null;
  // ApiToken-shaped virtual token: same scopes/projectKeys/policy fields downstream code reads.
  const virtualToken = {
    id: oauth.grantId,
    userId: user.id,
    name: 'oauth',
    prefix: 'oauth',
    hash: '',
    scopes: oauth.scopes,
    projectKeys: oauth.projectKeys,
    requireApproval: false,
    approvalPolicy: 'never',
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date(0),
  } as ApiToken;
  return { user, token: virtualToken, channel: 'api' };
}

async function actorFromBasic(header: string): Promise<Actor | null> {
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return actorFromBearer(decoded.slice(idx + 1));
  } catch {
    return null;
  }
}

async function actorFromSession(req: Request): Promise<Actor | null> {
  const cookies = parseCookies(req.headers.cookie);
  const session = cookies[SESSION_COOKIE];
  if (!session) return null;
  const payload = verifySession(session);
  if (!payload) return null;
  const { sessionAlive, touchSession } = await import('../services/identityService.js');
  if (!(await sessionAlive(payload.sid))) return null;
  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user || !user.active) return null;
  req.sessionId = payload.sid;
  if (payload.sid) void touchSession(payload.sid);
  // 036 policy gate: members of requireTotp groups must enroll before anything else.
  if (!user.totpEnabled) {
    const { userNeedsTotpEnroll } = await import('../services/identityService.js');
    if (await userNeedsTotpEnroll(user.id)) req.needsTotpEnroll = true;
  }
  // 065 A7 — admin password resets set mustChangePassword; enforce it or the
  // flag is decorative (old password still logs in otherwise).
  if (user.mustChangePassword) req.mustChangePassword = true;
  return { user, channel: 'ui' };
}

async function actorFromInternal(header: string): Promise<Actor | null> {
  const claims = verifyInternalActor(header);
  if (!claims) return null;
  const user = await prisma.user.findUnique({ where: { id: claims.uid } });
  if (!user || !user.active) return null;
  // 065 audit B3 — resolve the signed token id back to a live row. A cited
  // token that no longer resolves (revoked/expired/foreign) fails closed:
  // the dispatch dies rather than silently widening to session rights.
  let token: ApiToken | undefined;
  if (claims.tok) {
    const t = await prisma.apiToken.findUnique({ where: { id: claims.tok } });
    if (t && t.userId === user.id && !t.revokedAt && (!t.expiresAt || t.expiresAt >= new Date())) {
      token = t;
    } else {
      const g = await prisma.oAuthGrant.findUnique({ where: { id: claims.tok } });
      if (!g || g.userId !== user.id || g.revokedAt) return null;
      token = {
        id: g.id,
        userId: user.id,
        name: 'oauth',
        prefix: 'oauth',
        hash: '',
        scopes: g.scopes,
        projectKeys: g.projectKeys,
        requireApproval: false,
        approvalPolicy: 'never',
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(0),
      } as ApiToken;
    }
  }
  return {
    user,
    token,
    channel: claims.ch,
    internal: { bypassApproval: claims.bypassApproval, approvedById: claims.approvedById },
  };
}

const TOTP_ENROLL_ALLOWLIST = /^\/api\/internal\/(me\/totp|auth\/(logout|whoami)|me$)/;
// 065 A7 — while mustChangePassword is set, session users get only the
// password-change + identity read endpoints (PATs are machine creds and
// keep working — Jira parity: the flag gates interactive logins).
const MUST_CHANGE_ALLOWLIST = /^\/api\/internal\/(me(\/password)?|auth\/(logout|whoami))$/;

export async function resolveRequestActor(req: Request): Promise<Actor | null> {
  const authHeader = req.headers.authorization ?? '';
  let actor: Actor | null = null;

  const internal = req.headers[INTERNAL_HEADER];
  if (typeof internal === 'string' && internal) {
    actor = await actorFromInternal(internal);
  } else if (authHeader.startsWith('Bearer ')) {
    actor = await actorFromBearer(authHeader.slice(7).trim());
  } else if (authHeader.startsWith('Basic ')) {
    actor = await actorFromBasic(authHeader.slice(6).trim());
  } else {
    actor = await actorFromSession(req);
  }

  // SSE streams: EventSource cannot set headers — accept ?access_token= only
  // for GETs on stream endpoints (session cookies also work).
  if (!actor && req.method === 'GET' && req.path.endsWith('/stream')) {
    const qt = req.query.access_token;
    if (typeof qt === 'string' && qt) actor = await actorFromBearer(qt);
  }
  return actor;
}

// 050: actor-if-present for audience-filtered surfaces (the docs portal).
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const actor = await resolveRequestActor(req);
    if (actor) req.actor = actor;
  } catch (err) {
    next(err);
    return;
  }
  next();
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Express 4 never catches async rejections — a throw here (cookie decode,
  // Prisma hiccup) used to crash the process. Resolve inside try/catch.
  let actor: Actor | null = null;
  try {
    actor = await resolveRequestActor(req);
  } catch (err) {
    next(err);
    return;
  }

  if (!actor) {
    res.status(401).json(jiraError(['You are not authenticated.']));
    return;
  }

  // Token-authenticated callers may declare their channel (e.g. the MCP server
  // sends X-TrackForge-Channel: mcp) so the changelog records the true surface.
  const declared = String(req.headers['x-trackforge-channel'] ?? '').toLowerCase();
  if (actor.token && declared === 'mcp') {
    actor.channel = declared;
  }

  if (actor.token && WRITE_METHODS.has(req.method) && !hasScope(actor, 'write')) {
    res.status(403).json(jiraError([], { scope: "Missing required scope 'write'." }));
    return;
  }

  // 036: group-policy 2FA enforcement — everything except the enrollment path.
  if (req.needsTotpEnroll && !TOTP_ENROLL_ALLOWLIST.test(req.originalUrl.split('?')[0])) {
    res.status(403).json(jiraError([], { totpEnrollRequired: 'Your group policy requires two-factor enrollment.' }));
    return;
  }

  // 065 A7: forced password rotation — session users are confined to the
  // change-password + identity surface until they rotate.
  if (req.mustChangePassword && actor.channel === 'ui' && !MUST_CHANGE_ALLOWLIST.test(req.originalUrl.split('?')[0])) {
    res.status(403).json(jiraError([], { mustChangePassword: 'Password change required before continuing.' }));
    return;
  }

  req.actor = actor;
  next();
}

/** Returns 404 if the actor's token project allow-list excludes the project key. */
export function projectAllowed(actor: Actor, projectKey: string): boolean {
  const allow = actor.token?.projectKeys;
  if (!allow || allow.length === 0) return true;
  return allow.includes(projectKey.toUpperCase());
}

export function requireProjectScope(paramKey = 'projectKey') {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.params[paramKey] ?? (req.query.project as string | undefined);
    if (key && req.actor && !projectAllowed(req.actor, key)) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    next();
  };
}

/**
 * Enforce issue-key project scope (issue keys embed the project key) AND
 * BROWSE_PROJECTS — inaccessible issues 404 rather than leak existence
 * (FR-003). The token allow-list remains the outer layer.
 * Throws JiraApiError(404) on denial; resolves when the scope check passes
 * (issue existence remains the route's own lookup — 065 US5 contract).
 */
export async function enforceIssueScope(issueKey: string, actor: Actor): Promise<void> {
  const deny = (): never => {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  };
  // 053 US1 — normalize first: many routes forward the raw param, and a
  // lowercase project segment must not make the project lookup miss (which
  // previously skipped BOTH checks below).
  const normalized = issueKey.toUpperCase();
  const parts = parseIssueKeyParts(normalized);
  const projectKey = parts?.projectKey ?? normalized.split('-')[0];
  const issueNumber = parts?.issueNumber ?? Number.NaN;
  if (!projectKey || !projectAllowed(actor, projectKey)) deny();

  // Resolve the real issue — including IssueKeyAlias, so an issue moved into
  // a restricted project can't be read through its old public key (053 US1).
  const issueSelect = {
    id: true,
    effSecurityLevelId: true,
    reporterId: true,
    assigneeId: true,
    projectId: true,
    archived: true, // 060 US7 — canSeeIssue hides archived issues (404)
    project: { select: { key: true } },
  } as const;
  const direct = Number.isInteger(issueNumber)
    ? await prisma.issue.findFirst({
        where: { issueNumber, project: { key: projectKey } },
        select: issueSelect,
      })
    : null;
  const issue =
    direct ??
    (
      await prisma.issueKeyAlias.findUnique({
        where: { oldKey: normalized },
        include: { issue: { select: issueSelect } },
      })
    )?.issue ??
    null;

  // Nothing found → let the route produce its own 404 (same shape).
  if (!issue) return;
  // A moved issue's CURRENT project can differ from the requested key's —
  // the token allow-list and BROWSE_PROJECTS apply to where it lives now.
  if (issue.project.key !== projectKey && !projectAllowed(actor, issue.project.key)) deny();
  // Pass the resolved issue so issue-scoped holders (reporter / assignee /
  // *CustomField) can grant BROWSE on this issue — Jira treats those grants
  // as browse-the-project-for-matching-issues.
  if (!(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: issue.projectId, issue }))) deny();
  // 031: issue security — a levelled issue the actor isn't a member of 404s
  // on every issue-scoped route (existence-hiding, same as BROWSE_PROJECTS).
  if (!(await canSeeIssue(actor, issue))) deny();
}

/**
 * Board/sprint variant of enforceIssueScope: resolves the entity's project and
 * applies the token allow-list + BROWSE_PROJECTS. Out-of-scope entities 404 so
 * scoped tokens can't even confirm their existence (Sprint 020 G5 leak gate).
 */
export async function enforceBoardScope(boardIdOrKey: string, actor: Actor): Promise<void> {
  const board = await prisma.board.findFirst({
    where: {
      OR: [{ id: boardIdOrKey }, { project: { key: boardIdOrKey.toUpperCase() } }, { projectId: boardIdOrKey }],
    },
    include: { project: { select: { id: true, key: true } } },
  });
  if (
    !board ||
    !projectAllowed(actor, board.project.key) ||
    !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: board.project.id }))
  ) {
    throw new JiraApiError(404, jiraError(['Board does not exist or you do not have permission to see it.']));
  }
}

export async function enforceSprintScope(sprintId: string, actor: Actor): Promise<void> {
  const sprint = await prisma.sprint.findUnique({
    where: { id: sprintId },
    include: { project: { select: { id: true, key: true } } },
  });
  if (
    !sprint ||
    !projectAllowed(actor, sprint.project.key) ||
    !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: sprint.project.id }))
  ) {
    throw new JiraApiError(404, jiraError(['Sprint does not exist or you do not have permission to see it.']));
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const actor = req.actor;
  if (!actor?.user.isAdmin) {
    res.status(403).json(jiraError(['You do not have permission to perform this operation.']));
    return;
  }
  if (actor.token && !hasScope(actor, 'admin')) {
    res.status(403).json(jiraError([], { scope: "Missing required scope 'admin'." }));
    return;
  }
  next();
}

// --- rate limiting (sliding 1-minute window) ---

const WINDOW_MS = 60_000;
const LIMIT = Number(process.env.RATE_LIMIT ?? 1000);
const buckets = new Map<string, { count: number; reset: number }>();
// Unbounded bucket growth is a memory-DoS vector (one entry per principal/IP).
const MAX_BUCKETS = 50_000;

function sweep(buckets: Map<string, { count: number; reset: number }>, now: number) {
  for (const [k, b] of buckets) {
    if (b.reset < now) buckets.delete(k);
  }
  // Still over cap → evict oldest insertions (Map preserves insertion order).
  if (buckets.size > MAX_BUCKETS) {
    let drop = buckets.size - MAX_BUCKETS;
    for (const k of buckets.keys()) {
      buckets.delete(k);
      if (--drop <= 0) break;
    }
  }
}

function hit(buckets: Map<string, { count: number; reset: number }>, key: string, now: number) {
  if (buckets.size > MAX_BUCKETS) sweep(buckets, now);
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + WINDOW_MS };
    buckets.set(key, b);
  }
  return (b.count += 1);
}

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const principal = req.actor?.token?.id ?? req.actor?.user.id ?? req.ip ?? 'anon';
  const now = Date.now();
  const count = hit(buckets, principal, now);
  res.setHeader('X-RateLimit-Limit', String(LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, LIMIT - count)));
  if (count > LIMIT) {
    const b = buckets.get(principal)!;
    res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
    res.status(429).json(jiraError(['Rate limit exceeded.']));
    return;
  }
  next();
}

// Strict per-IP limiter for the unauthenticated auth surface (login, reset,
// TOTP). These routes mount before requireAuth, so req.actor never exists —
// principal is the client address. ~20/min: enough for real users, useless
// for credential stuffing.
const AUTH_LIMIT = Number(process.env.AUTH_RATE_LIMIT ?? 20);
const authBuckets = new Map<string, { count: number; reset: number }>();

// 065 audit E2 — coarse per-IP limiter for surfaces that run BEFORE auth:
// bad bearer tokens otherwise get unlimited free 401s (each costing a DB
// hit), /metrics is scrapeable by anyone, and the dev-webhook receiver wrote
// a DevDelivery row per forged signature.
export function ipRateLimit(limit: number) {
  const ipBuckets = new Map<string, { count: number; reset: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === 'test' || limit <= 0) return next();
    const principal = req.ip ?? 'anon';
    const now = Date.now();
    const count = hit(ipBuckets, principal, now);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
    if (count > limit) {
      const b = ipBuckets.get(principal)!;
      res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      res.status(429).json(jiraError(['Too many requests — try again later.']));
      return;
    }
    next();
  };
}

export function authRateLimit(req: Request, res: Response, next: NextFunction) {
  // Test suite exercises auth flows in a tight loop from one IP — the limit is
  // a deployment control, not a correctness rule; AUTH_RATE_LIMIT can also
  // tune/disable it per environment.
  if (process.env.NODE_ENV === 'test' || AUTH_LIMIT <= 0) return next();
  const principal = req.ip ?? 'anon';
  const now = Date.now();
  const count = hit(authBuckets, principal, now);
  res.setHeader('X-RateLimit-Limit', String(AUTH_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, AUTH_LIMIT - count)));
  if (count > AUTH_LIMIT) {
    const b = authBuckets.get(principal)!;
    res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
    res.status(429).json(jiraError(['Too many attempts — try again later.']));
    return;
  }
  next();
}

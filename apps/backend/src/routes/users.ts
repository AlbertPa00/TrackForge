import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import {
  getUserByAccountId,
  searchUsers,
  searchAssignable,
  listUsers,
  listUsersFiltered,
  listAdminUsersPage,
  createUser,
  updateUser,
  toUserResponse,
  previewAnonymizeUser,
  anonymizeUser,
} from '../services/userService.js';
import { createToken, listTokens, listAllTokens, revokeToken, toTokenResponse } from '../services/tokenService.js';
import { listAuditEvents, auditEventRows, distinctAuditActions } from '../services/auditService.js';
import { issueResetToken } from '../services/identityService.js';
import { getMailAdapter, getMailConfig } from '../services/mailService.js';
import { requireAdmin } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import { jiraError } from '../lib/errors.js';
import { ah, sendCsv, isDryRun, pageParams } from '../lib/http.js';
import { prisma } from '../prisma.js';
import type { User } from '@prisma/client';
import { z } from 'zod';
import { qs, createUserSchema, createTokenSchema, formatZodErrors } from '../lib/validation.js';
import crypto from 'node:crypto';

export const userRouter: RouterType = Router();
export const internalRouter: RouterType = Router();

// ---- Jira-shaped user endpoints (/rest/api/2/user*) ----

userRouter.get(
  '/',
  ah(async (req, res) => {
    const accountId = String(qs(req.query.accountId) ?? '');
    const user = await getUserByAccountId(accountId);
    res.json(toUserResponse(user));
  })
);

userRouter.get(
  '/search',
  ah(async (req, res) => {
    const users = await searchUsers(String(qs(req.query.query) ?? ''));
    res.json(users.map(toUserResponse));
  })
);

userRouter.get(
  '/assignable/search',
  ah(async (req, res) => {
    const project = String(qs(req.query.project) ?? '');
    // absent vs empty matters: the picker calls with no query (Jira parity);
    // ?query=a is an enumeration attempt (065 C5).
    const query = qs(req.query.query) === undefined ? undefined : String(qs(req.query.query));
    const users = await searchAssignable(project, query, String(qs(req.query.agents) ?? '') === 'true');
    res.json(users.map(toUserResponse));
  })
);

// ---- People directory (/api/internal/people) ----

/** The People page's directory surface: every authenticated user may browse
 *  it (Jira parity — the user roster is visible to clients), paginated, with
 *  server-computed open-issue counts. `/user/search` stays the Jira-shaped
 *  picker surface with its ≥2-char anti-enumeration guard for agents. */
internalRouter.get(
  '/people',
  ah(async (req, res) => {
    const query = String(qs(req.query.query) ?? '').trim();
    const { startAt, maxResults } = pageParams(req, { cap: 200, default: 50 });
    const where = query
      ? {
          OR: [
            { displayName: { contains: query, mode: 'insensitive' as const } },
            { email: { contains: query, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const [total, users, openCounts] = await prisma.$transaction([
      prisma.user.count({ where }),
      prisma.user.findMany({ where, orderBy: { displayName: 'asc' }, skip: startAt, take: maxResults }),
      prisma.issue.groupBy({
        by: ['assigneeId'],
        where: { assigneeId: { not: null }, status: { category: { not: 'done' } } },
        _count: true,
        orderBy: { assigneeId: 'asc' },
      }),
    ]);
    const openByUser = new Map(openCounts.map((r) => [r.assigneeId, r._count]));
    res.json({
      startAt,
      maxResults,
      total,
      isLast: startAt + users.length >= total,
      values: users.map((u) => ({ ...toUserResponse(u), openIssueCount: openByUser.get(u.id) ?? 0 })),
    });
  })
);

// ---- Native admin user management (/api/internal/users) ----

/** Admin row enrichment — groups + source directory, scoped to the given
 *  users so the paged route doesn't scan every membership row. */
async function decorateAdminUsers(users: User[]) {
  const scope = { userId: { in: users.map((u) => u.id) } };
  const [memberships, externals] = await Promise.all([
    prisma.groupMember.findMany({ where: scope, include: { group: { select: { name: true } } } }),
    prisma.externalIdentity.findMany({ where: scope, include: { connection: { select: { name: true } } } }),
  ]);
  const groupsByUser = new Map<string, string[]>();
  for (const m of memberships) {
    groupsByUser.set(m.userId, [...(groupsByUser.get(m.userId) ?? []), m.group.name]);
  }
  const dirByUser = new Map<string, string>();
  for (const e of externals) {
    if (!dirByUser.has(e.userId)) dirByUser.set(e.userId, e.connection.name);
  }
  return users.map((u) => ({
    ...toUserResponse(u),
    isAdmin: u.isAdmin,
    lastLoginAt: u.lastLoginAt,
    invitedAt: u.invitedAt,
    groups: groupsByUser.get(u.id) ?? [],
    directory: dirByUser.get(u.id) ?? 'Internal',
  }));
}

// 060 US5 — Jira "Usuarios" surface: status/type/group filters + last-login,
// groups, and source directory columns.
internalRouter.get(
  '/users',
  requireAdmin,
  ah(async (req, res) => {
    const { status, type, group, query } = req.query as Record<string, string | undefined>;
    const users =
      status || type || group || query ? await listUsersFiltered({ status, type, group, query }) : await listUsers();
    res.json(await decorateAdminUsers(users));
  })
);

// Paginated variant for the /admin/users table — same filters, PageBean out.
// The flat route above stays the list contract for pickers and MCP tools.
internalRouter.get(
  '/admin/users',
  requireAdmin,
  ah(async (req, res) => {
    const { status, type, group, query } = req.query as Record<string, string | undefined>;
    const { startAt, maxResults } = pageParams(req, { cap: 200, default: 50 });
    const { total, users } = await listAdminUsersPage({ status, type, group, query }, startAt, maxResults);
    const values = await decorateAdminUsers(users);
    res.json({ startAt, maxResults, total, isLast: startAt + users.length >= total, values });
  })
);

// 060 US5 — Jira "Invitar usuarios": create an inactive account, mint an
// invite token (reset-token model), and email the accept link.
const inviteSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).optional(),
  groups: z.array(z.string()).optional(),
});

async function inviteLink(token: string) {
  const cfg = await getMailConfig();
  return `${cfg.baseUrl}/invite/${token}`;
}

async function sendInviteMail(email: string, displayName: string, link: string) {
  await getMailAdapter().send({
    to: email,
    subject: "You've been invited to TrackForge",
    text: `Hi ${displayName},\n\nYou've been invited to TrackForge. Set your password to activate your account:\n\n${link}\n\nThis link expires in 1 hour.`,
    html: `<p>Hi ${displayName},</p><p>You've been invited to TrackForge. Set your password to activate your account:</p><p><a href="${link}">${link}</a></p><p>This link expires in 1 hour.</p>`,
  });
}

internalRouter.post(
  '/users/invite',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const { email, displayName, groups } = parsed.data;
    const created = await createUser({
      email,
      displayName: displayName ?? email.split('@')[0]!,
      password: crypto.randomBytes(24).toString('hex'),
    });
    const user = await prisma.user.update({
      where: { id: created.id },
      data: { active: false, invitedAt: new Date() },
    });
    if (groups?.length) {
      const gs = await prisma.group.findMany({ where: { name: { in: groups } } });
      await prisma.groupMember.createMany({
        data: gs.map((g) => ({ groupId: g.id, userId: user.id })),
        skipDuplicates: true,
      });
    }
    // 065 audit G2 — a 1-hour invite dies before real onboarding; 7 days.
    const token = await issueResetToken(user.id, 7 * 24 * 3600_000);
    const link = await inviteLink(token);
    let mailSent = false;
    try {
      await sendInviteMail(user.email, user.displayName, link);
      mailSent = true;
    } catch {
      /* SMTP unconfigured — admin can still copy the invite link */
    }
    await audit(req, 'user.invited', 'user', user.id, { email: user.email, mailSent });
    res
      .setHeader('x-invite-token', process.env.NODE_ENV === 'production' ? '' : token)
      .status(201)
      .json({ ...toUserResponse(user), invited: true, mailSent, inviteUrl: link });
  })
);

// Re-invite a pending-invite account — mints a fresh token (old one keeps its
// expiry). 061 US2: restricted to never-activated invitees (invitedAt set) so
// re-invite can't re-activate an account an admin deactivated.
internalRouter.post(
  '/users/:accountId/invite',
  requireAdmin,
  ah(async (req, res) => {
    const user = await getUserByAccountId(ps(req.params.accountId));
    if (user.active || !user.invitedAt) {
      res.status(400).json(jiraError(['Only accounts with a pending invite can be re-invited.']));
      return;
    }
    const token = await issueResetToken(user.id, 7 * 24 * 3600_000);
    await prisma.user.update({ where: { id: user.id }, data: { invitedAt: new Date() } });
    const link = await inviteLink(token);
    let mailSent = false;
    try {
      await sendInviteMail(user.email, user.displayName, link);
      mailSent = true;
    } catch {
      /* SMTP unconfigured */
    }
    await audit(req, 'user.reinvited', 'user', user.id, { mailSent });
    res.json({ invited: true, mailSent, inviteUrl: link });
  })
);

// 065 audit A7 — admin-initiated password reset: flags mustChangePassword,
// clears 2FA (account-recovery posture), revokes sessions, and delivers a
// reset link by mail (or returns it for admin delivery when SMTP is down).
internalRouter.post(
  '/users/:accountId/password-reset',
  requireAdmin,
  ah(async (req, res) => {
    const user = await getUserByAccountId(ps(req.params.accountId));
    const { adminResetPassword } = await import('../services/identityService.js');
    const token = await adminResetPassword(req.actor!.user.id, user.id);
    const cfg = await getMailConfig();
    const link = `${cfg.baseUrl}/login?resetToken=${encodeURIComponent(token)}`;
    let mailSent = false;
    try {
      await getMailAdapter().send({
        to: user.email,
        subject: 'Your TrackForge password was reset',
        text: `An administrator reset your TrackForge password. Choose a new one here:\n\n${link}\n\nThe link expires in 1 hour.`,
        html: `<p>An administrator reset your TrackForge password. Choose a new one here:</p><p><a href="${link}">${link}</a></p><p>The link expires in 1 hour.</p>`,
      });
      mailSent = true;
    } catch {
      /* SMTP unconfigured — admin still gets the link */
    }
    await audit(req, 'user.password_reset', 'user', user.id, { mailSent });
    res.json({ reset: true, mailSent, resetUrl: link });
  })
);

internalRouter.post(
  '/users',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const user = await createUser(parsed.data);
    await audit(req, 'user.created', 'user', user.id, { email: user.email, type: user.type });
    res.status(201).json(toUserResponse(user));
  })
);

const updateUserHandler = async (req: any, res: any, next: any) => {
  try {
    const user = await updateUser(ps(req.params.accountId), req.body ?? {});
    // 065 audit F1 — log which fields changed, never the values: req.body can
    // carry a plaintext password and this row lands in the admin audit page,
    // the CSV export and every backup.
    await audit(req, 'user.updated', 'user', user.id, { fields: Object.keys(req.body ?? {}) });
    res.json(toUserResponse(user));
  } catch (err) {
    next(err);
  }
};
internalRouter.put('/users/:accountId', requireAdmin, updateUserHandler);
// 021 — PATCH alias for partial updates (active flag, password reset).
internalRouter.patch('/users/:accountId', requireAdmin, updateUserHandler);

// 060 US6 — GDPR anonymization, two-step: ?dryRun=true returns a preview +
// confirmToken; the real call requires that token. Irreversible.
internalRouter.post(
  '/users/:accountId/anonymize',
  requireAdmin,
  ah(async (req, res) => {
    const user = await getUserByAccountId(ps(req.params.accountId));
    if (user.id === req.actor!.user.id) {
      res.status(400).json(jiraError(['You cannot anonymize your own account.']));
      return;
    }
    if (isDryRun(req)) {
      res.json(await previewAnonymizeUser(user.id));
      return;
    }
    const confirmToken = String(qs(req.query.confirmToken) ?? req.headers['x-confirm-token'] ?? '') || undefined;
    const result = await anonymizeUser(user.id, confirmToken);
    await audit(req, 'user.anonymized', 'user', user.id, { anonymizedTo: result.anonymized.displayName });
    res.status(204).end();
  })
);

// Public profile view (Jira ViewProfile parity) — any authenticated user, no admin.
internalRouter.get(
  '/users/:accountId/profile',
  ah(async (req, res) => {
    const { getPublicProfile } = await import('../services/identityService.js');
    res.json(await getPublicProfile(ps(req.params.accountId), req.actor!));
  })
);

// 061 US5 — one query replaces the per-user fetchUserTokens fan-out on /admin/tokens.
internalRouter.get(
  '/admin/tokens',
  requireAdmin,
  ah(async (_req, res) => {
    const tokens = await listAllTokens();
    res.json(
      tokens.map((t) => ({
        ...toTokenResponse(t),
        owner: {
          accountId: t.userId,
          emailAddress: t.user.email,
          displayName: t.user.displayName,
          active: t.user.active,
          accountType: t.user.type,
        },
      }))
    );
  })
);

internalRouter.get(
  '/users/:accountId/tokens',
  requireAdmin,
  ah(async (req, res) => {
    const tokens = await listTokens(ps(req.params.accountId));
    res.json(tokens.map(toTokenResponse));
  })
);

// 063 US3 — admin mints a PAT for another account. Agent accounts can't
// session-login (type !== 'human'), so their first token must be issued
// out-of-band by an admin; the secret is returned exactly once.
internalRouter.post(
  '/users/:accountId/tokens',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = createTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const target = await getUserByAccountId(ps(req.params.accountId));
    if (!target.active) {
      res.status(400).json(jiraError(['Cannot mint a token for an inactive account.']));
      return;
    }
    const { token, secret } = await createToken(target.id, {
      ...parsed.data,
      projectKeys: parsed.data.projectKeys?.map((k) => k.toUpperCase()),
    });
    await audit(req, 'token.created', 'token', token.id, {
      name: token.name,
      scopes: token.scopes,
      onBehalfOf: target.id,
    });
    res.status(201).json({ ...toTokenResponse(token), secret });
  })
);

// ---- Tokens (/api/internal/tokens) — self-service ----

internalRouter.get(
  '/tokens',
  ah(async (req, res) => {
    const tokens = await listTokens(req.actor!.user.id);
    res.json(tokens.map(toTokenResponse));
  })
);

internalRouter.post(
  '/tokens',
  ah(async (req, res) => {
    // 065 audit B1 — token creation is session-only: a scoped or
    // approval-gated token could otherwise mint an unrestricted token for the
    // same user and escape every limit placed on it (also outliving grant
    // revocation). Browser session required; agents get tokens via admin mint
    // at POST /users/:id/tokens.
    if (req.actor!.token) {
      res.status(403).json(jiraError(['Tokens cannot create API tokens — use a browser session.']));
      return;
    }
    const parsed = createTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const { token, secret } = await createToken(req.actor!.user.id, {
      ...parsed.data,
      projectKeys: parsed.data.projectKeys?.map((k) => k.toUpperCase()),
    });
    await audit(req, 'token.created', 'token', token.id, { name: token.name, scopes: token.scopes });
    // secret is returned exactly once — never stored
    res.status(201).json({ ...toTokenResponse(token), secret });
  })
);

internalRouter.delete(
  '/tokens/:id',
  ah(async (req, res) => {
    await revokeToken(ps(req.params.id), req.actor!.user.id, req.actor!.user.isAdmin);
    await audit(req, 'token.revoked', 'token', ps(req.params.id));
    res.status(204).end();
  })
);

// ---- Audit log (admin) ----

// 061 US7 — feeds the Action filter datalist on /admin/audit.
internalRouter.get(
  '/audit/actions',
  requireAdmin,
  ah(async (_req, res) => {
    res.json({ actions: await distinctAuditActions() });
  })
);

internalRouter.get(
  '/audit',
  requireAdmin,
  ah(async (req, res) => {
    const filter = {
      actorId: qs(req.query.actorId) ? String(qs(req.query.actorId)) : undefined,
      action: qs(req.query.action) ? String(qs(req.query.action)) : undefined,
      entityType: qs(req.query.entityType) ? String(qs(req.query.entityType)) : undefined,
      entityId: qs(req.query.entityId) ? String(qs(req.query.entityId)) : undefined,
      from: qs(req.query.from) ? new Date(String(qs(req.query.from))) : undefined,
      to: qs(req.query.to) ? new Date(String(qs(req.query.to))) : undefined,
    };
    const { startAt, maxResults } = pageParams(req, { cap: 1000 });
    const { total, events } = await listAuditEvents(startAt, maxResults, filter);
    if (String(qs(req.query.format) ?? '') === 'csv') {
      sendCsv(res, 'audit', auditEventRows(events));
      return;
    }
    res.json({
      total,
      events: events.map((e) => ({
        id: e.id,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        details: e.details,
        ip: e.ip,
        createdAt: e.createdAt.toISOString(),
        actor: e.actor
          ? { accountId: e.actor.id, displayName: e.actor.displayName, agent: e.actor.type === 'agent' }
          : null,
      })),
    });
  })
);

// ---- User preferences (Sprint 010 — column chooser persistence) ----

internalRouter.get(
  '/preferences',
  ah(async (req, res) => {
    const prefs = await prisma.userPreference.findMany({
      where: { userId: req.actor!.user.id },
    });
    res.json(Object.fromEntries(prefs.map((p) => [p.key, p.value])));
  })
);

internalRouter.put(
  '/preferences/:key',
  ah(async (req, res) => {
    const key = ps(req.params.key);
    if (!/^[a-z0-9_.-]{1,64}$/i.test(key)) {
      res.status(400).json(jiraError(['Invalid preference key.']));
      return;
    }
    const pref = await prisma.userPreference.upsert({
      where: { userId_key: { userId: req.actor!.user.id, key } },
      create: { userId: req.actor!.user.id, key, value: req.body?.value ?? null },
      update: { value: req.body?.value ?? null },
    });
    res.json({ [pref.key]: pref.value });
  })
);

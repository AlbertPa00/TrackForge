import type { User } from '../lib/pc.js';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { issueConfirmToken, consumeConfirmToken } from '../lib/confirmToken.js';
import { sessionSecret } from '../config.js';
import { userSelf } from '../lib/http.js';

/** 065 US4 — resolve any of the three user-ref spellings (accountId, email,
 *  displayName) to an ACTIVE user, or null. The JQL compiler, the assignee
 *  resolver, and automation actor validation each hand-rolled an OR-set with
 *  slightly different case-sensitivity — this is the one. */
export async function resolveUserRef(raw: string): Promise<User | null> {
  return prisma.user.findFirst({
    where: {
      OR: [
        { id: raw },
        { email: { equals: raw, mode: 'insensitive' } },
        { displayName: { equals: raw, mode: 'insensitive' } },
      ],
      active: true,
    },
  });
}

export function toUserResponse(user: User) {
  return {
    self: userSelf(user.id),
    accountId: user.id,
    accountType: user.type === 'agent' ? 'atlassian' : 'customer',
    displayName: user.displayName,
    emailAddress: user.email,
    active: user.active,
    timeZone: user.timeZone,
    avatarEmoji: user.avatarEmoji,
    // 065 audit C5 — isAdmin is not part of Jira's user bean and it identifies
    // privileged accounts to every caller; self + admin surfaces add it back.
    ...(user.type === 'agent'
      ? { agent: true, isAssignableAgent: user.isAssignableAgent, approvalPolicy: user.approvalPolicy }
      : {}),
  };
}

export function getMyself(user: User) {
  return { ...toUserResponse(user), ...(user.isAdmin ? { isAdmin: true } : {}) };
}

// 065 audit A5 — per-account lockout: 5 consecutive bad passwords locks the
// account for 15 minutes (counter resets on success or after the window).
const LOGIN_LOCK_AFTER = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

export async function login(email: string, password: string): Promise<User> {
  let user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (user?.loginLockedUntil && user.loginLockedUntil > new Date()) {
    throw new JiraApiError(
      429,
      jiraError(['Too many failed attempts — this account is temporarily locked. Try again later.'])
    );
  }
  const passwordOk = Boolean(user?.passwordHash && (await verifyPassword(password, user!.passwordHash!)));
  if (!user || !passwordOk) {
    // 049 — enabled LDAP connections get a bind-auth attempt before 401.
    const { authenticateViaDirectory } = await import('./directoryService.js');
    const dir = await authenticateViaDirectory(email, password);
    if (dir && 'error' in dir) {
      throw new JiraApiError(503, jiraError(['Directory unavailable — try again later or use local credentials.']));
    }
    if (dir?.user) user = dir.user;
    else {
      if (user) {
        const failures = user.loginFailures + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            loginFailures: failures,
            ...(failures >= LOGIN_LOCK_AFTER
              ? { loginLockedUntil: new Date(Date.now() + LOGIN_LOCK_MS), loginFailures: 0 }
              : {}),
          },
        });
      }
      throw new JiraApiError(401, jiraError(['Invalid email or password.']));
    }
  }
  if (!user.active || user.type !== 'human') {
    throw new JiraApiError(403, jiraError(['This account cannot sign in.']));
  }
  // 032: login tracking for JQL currentLogin()/previousLogin()/lastLogin().
  return prisma.user.update({
    where: { id: user.id },
    data: { previousLoginAt: user.lastLoginAt, lastLoginAt: new Date(), loginFailures: 0, loginLockedUntil: null },
  });
}

export async function listUsers() {
  return prisma.user.findMany({ orderBy: { displayName: 'asc' } });
}

export interface AdminUserFilters {
  status?: string;
  type?: string;
  group?: string;
  query?: string;
}

/** 060 US5 — Jira admin filter row: status, account type, group, free text. */
function adminUserWhere(f: AdminUserFilters) {
  return {
    ...(f.status === 'active' ? { active: true } : f.status === 'inactive' ? { active: false } : {}),
    ...(f.type === 'human' || f.type === 'agent' ? { type: f.type } : {}),
    ...(f.group ? { groupMemberships: { some: { group: { name: f.group } } } } : {}),
    ...(f.query
      ? {
          OR: [
            { displayName: { contains: f.query, mode: 'insensitive' as const } },
            { email: { contains: f.query, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
}

export async function listUsersFiltered(f: AdminUserFilters) {
  return prisma.user.findMany({ where: adminUserWhere(f), orderBy: { displayName: 'asc' } });
}

/** Paginated variant for the /admin/users table — same filters + total. */
export async function listAdminUsersPage(f: AdminUserFilters, startAt: number, maxResults: number) {
  const where = adminUserWhere(f);
  const [total, users] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { displayName: 'asc' }, skip: startAt, take: maxResults }),
  ]);
  return { total, users };
}

export async function getUserByAccountId(accountId: string) {
  const user = await prisma.user.findUnique({ where: { id: accountId } });
  if (!user) throw new JiraApiError(404, jiraError(['User not found.']));
  return user;
}

export async function searchUsers(query: string) {
  // 064 US6 — an empty/1-char query enumerates the org's user list for any
  // authenticated caller; require ≥2 chars (Jira-compatible behavior).
  if (query.trim().length < 2) return [];
  return prisma.user.findMany({
    where: {
      OR: [
        { displayName: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } },
      ],
    },
    take: 50,
    orderBy: { displayName: 'asc' },
  });
}

export async function searchAssignable(projectKey: string, query: string | undefined, agentsOnly = false) {
  // 065 audit C5 — a present-but-short query enumerates the assignable list
  // (Jira's picker legitimately calls with NO query, which stays supported).
  if (query !== undefined && query.trim().length < 2) return [];
  const users = await prisma.user.findMany({
    where: {
      active: true,
      // 047 — delegate picker only offers agent accounts flagged assignable.
      ...(agentsOnly ? { type: 'agent', isAssignableAgent: true } : {}),
      ...(query
        ? {
            OR: [
              { displayName: { contains: query, mode: 'insensitive' } },
              { email: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    take: 50,
    orderBy: { displayName: 'asc' },
  });
  // Jira: the picker only offers users holding ASSIGNABLE_USER on the project.
  if (projectKey) {
    const project = await prisma.project.findUnique({
      where: { key: projectKey.toUpperCase() },
      select: { id: true },
    });
    if (project) {
      const { usersWithPermission } = await import('./permissionService.js');
      const allowed = await usersWithPermission('ASSIGNABLE_USER', project.id);
      return users.filter((u) => allowed.has(u.id) || u.isAdmin);
    }
  }
  return users;
}

export async function createUser(data: {
  email: string;
  displayName: string;
  password?: string;
  isAdmin?: boolean;
  type?: 'human' | 'agent';
  ownerId?: string;
  isAssignableAgent?: boolean;
  approvalPolicy?: 'always' | 'destructiveOnly' | 'never';
}) {
  const email = data.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new JiraApiError(400, jiraError([], { email: 'A user with this email already exists.' }));
  }
  if (data.type === 'agent' && !data.ownerId) {
    throw new JiraApiError(400, jiraError([], { ownerId: 'Agent accounts require an owner.' }));
  }
  if (data.type !== 'agent' && !data.password) {
    throw new JiraApiError(400, jiraError([], { password: 'Password is required for human accounts.' }));
  }
  return prisma.user.create({
    data: {
      email,
      displayName: data.displayName,
      passwordHash: data.type === 'agent' ? null : await hashPassword(data.password!),
      type: data.type ?? 'human',
      ownerId: data.ownerId,
      isAdmin: data.isAdmin ?? false,
      isAssignableAgent: data.isAssignableAgent ?? false,
      approvalPolicy: data.approvalPolicy ?? 'never',
    },
  });
}

export async function updateUser(
  accountId: string,
  data: {
    displayName?: string;
    email?: string;
    isAdmin?: boolean;
    active?: boolean;
    password?: string;
    requireApproval?: boolean;
    isAssignableAgent?: boolean;
    approvalPolicy?: 'always' | 'destructiveOnly' | 'never';
  }
) {
  const user = await getUserByAccountId(accountId);
  if ((data.isAdmin === false || data.active === false) && user.isAdmin && user.active) {
    const otherAdmins = await prisma.user.count({
      where: { isAdmin: true, active: true, id: { not: user.id }, type: 'human' },
    });
    if (otherAdmins === 0) {
      throw new JiraApiError(400, jiraError(['Cannot deactivate or demote the last active admin.']));
    }
  }
  if (data.email !== undefined) {
    const email = data.email.toLowerCase();
    const dup = await prisma.user.findUnique({ where: { email } });
    if (dup && dup.id !== accountId) {
      throw new JiraApiError(400, jiraError([], { email: 'A user with this email already exists.' }));
    }
  }
  // 065 audit A5 — the admin password-set path bypassed the ≥8 policy and left
  // the user's existing sessions live; apply both like a self-service change.
  if (data.password !== undefined && data.password.length < 8) {
    throw new JiraApiError(400, jiraError([], { password: 'Password must be at least 8 characters.' }));
  }
  const updated = await prisma.user.update({
    where: { id: accountId },
    data: {
      ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
      ...(data.email !== undefined ? { email: data.email.toLowerCase() } : {}),
      ...(data.isAdmin !== undefined ? { isAdmin: data.isAdmin } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      // 061 US2 — explicit reactivation ends pending-invite status; an admin
      // deliberate "Reactivate" is not an invite acceptance.
      ...(data.active === true ? { invitedAt: null } : {}),
      ...(data.password !== undefined ? { passwordHash: await hashPassword(data.password) } : {}),
      ...(data.requireApproval !== undefined ? { requireApproval: data.requireApproval } : {}),
      ...(data.isAssignableAgent !== undefined ? { isAssignableAgent: data.isAssignableAgent } : {}),
      ...(data.approvalPolicy !== undefined ? { approvalPolicy: data.approvalPolicy } : {}),
    },
  });
  if (data.password !== undefined) {
    // A new credential must not coexist with sessions minted under the old one.
    await prisma.session.updateMany({ where: { userId: accountId, revokedAt: null }, data: { revokedAt: new Date() } });
    await prisma.user.update({
      where: { id: accountId },
      data: { mustChangePassword: false, loginFailures: 0, loginLockedUntil: null },
    });
  }
  // 070 — deactivation must not ride out the PAT cache TTL; the cached
  // {token,user} still carries user.active=true until evicted.
  if (data.active === false) {
    const { invalidateApiTokens } = await import('../lib/tokenCache.js');
    invalidateApiTokens({ userId: accountId });
  }
  // 047 edge — deactivating an agent fails its open sessions, clears delegate.
  if (data.active === false && user.type === 'agent') {
    const { deactivateAgent } = await import('./agentSessionService.js');
    await deactivateAgent(accountId);
  }
  return updated;
}

/** Bootstrap: create admin from env once when no users exist; also deactivate agents of inactive owners. */
export async function ensureBootstrap() {
  const count = await prisma.user.count();
  // 043 — TF_ADMIN_* aliases + mounted-secret files (*_FILE) per the env contract.
  const secret = (name: string) => {
    const f = process.env[`${name}_FILE`];
    if (f) {
      try {
        return readFileSync(f, 'utf8').trim();
      } catch {
        return undefined;
      }
    }
    return process.env[name];
  };
  const email = secret('TF_ADMIN_EMAIL') ?? secret('ADMIN_EMAIL');
  const password = secret('TF_ADMIN_PASSWORD') ?? secret('ADMIN_PASSWORD');
  if (count === 0 && email && password) {
    // 065 audit A3 — refuse the documented example password (or a weak one) in
    // production: an admin seeded with a known credential is a day-one breach.
    if (process.env.NODE_ENV === 'production' && (password === 'change-me-admin' || password.length < 12)) {
      throw new Error(
        'TF_ADMIN_PASSWORD must be at least 12 characters and not the .env.example placeholder in production.'
      );
    }
    await createUser({
      email,
      displayName: 'Administrator',
      password,
      isAdmin: true,
    });
  }
}

// ---------- 060 US6 — user anonymization (GDPR erasure, two-step) ----------

/** Single-use, expiring token authorising anonymization after a dryRun
    preview — binds the account's email so a changed identity invalidates it
    (065 audit F4). */
export function anonymizePreviewToken(userId: string, email: string) {
  return issueConfirmToken('anonymize', `${userId}:${email}`);
}

function tombstoneFor(user: { id: string; email: string }) {
  const tag = createHmac('sha256', sessionSecret()).update(`tomb:${user.id}:${user.email}`).digest('hex').slice(0, 10);
  return { displayName: `user-${tag}`, email: `user-${tag}@anonymized.invalid` };
}

export async function previewAnonymizeUser(accountId: string) {
  const user = await getUserByAccountId(accountId);
  const [sessions, tokens, externalIdentities, oidcIdentities, resetTokens] = await Promise.all([
    prisma.session.count({ where: { userId: user.id, revokedAt: null } }),
    prisma.apiToken.count({ where: { userId: user.id, revokedAt: null } }),
    prisma.externalIdentity.count({ where: { userId: user.id } }),
    prisma.oidcIdentity.count({ where: { userId: user.id } }),
    prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } }),
  ]);
  const tomb = tombstoneFor(user);
  return {
    accountId: user.id,
    displayName: user.displayName,
    emailAddress: user.email,
    willScrub: {
      displayName: tomb.displayName,
      emailAddress: tomb.email,
      activeSessions: sessions,
      apiTokens: tokens,
      externalIdentities,
      oidcIdentities,
      passwordResetTokens: resetTokens,
      deactivates: true,
      authoredContent: 'keeps attribution to the anonymized account',
    },
    confirmToken: await anonymizePreviewToken(user.id, user.email),
  };
}

/**
 * Irreversible PII scrub — Jira anonymize semantics: profile fields become a
 * tombstone, credentials + external identities are destroyed, the account is
 * deactivated, and authored content keeps the (now-anonymized) principal.
 */
export async function anonymizeUser(accountId: string, confirmToken: string | undefined) {
  const user = await getUserByAccountId(accountId);
  if (user.isAdmin && user.active) {
    const others = await prisma.user.count({
      where: { isAdmin: true, active: true, id: { not: user.id } },
    });
    if (others === 0) {
      throw new JiraApiError(400, jiraError(['The last active administrator cannot be anonymized.']));
    }
  }
  if (!(await consumeConfirmToken('anonymize', `${user.id}:${user.email}`, confirmToken))) {
    throw new JiraApiError(
      400,
      jiraError([], {
        confirmToken: 'Anonymization requires a confirmToken from a ?dryRun=true preview of this same user.',
      })
    );
  }
  const tomb = tombstoneFor(user);
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: tomb.displayName,
        email: tomb.email,
        passwordHash: null,
        active: false,
        isAdmin: false,
        emailVerified: false,
        mustChangePassword: false,
        isAssignableAgent: false,
        approvalPolicy: 'never',
        invitedAt: null,
        totpSecret: null,
        totpEnabled: false,
        backupCodes: [],
      },
    }),
    prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.apiToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.externalIdentity.deleteMany({ where: { userId: user.id } }),
    prisma.oidcIdentity.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
  ]);
  const { invalidateApiTokens } = await import('../lib/tokenCache.js');
  invalidateApiTokens({ userId: user.id }); // 070 — evict cached PATs now, not at TTL
  return { anonymized: tomb };
}

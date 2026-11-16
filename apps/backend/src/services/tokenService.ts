import type { ApiToken } from '../lib/pc.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { generateToken } from '../lib/auth.js';
import { invalidateApiTokens } from '../lib/tokenCache.js';

const SCOPES = new Set(['read', 'write', 'admin']);

export function toTokenResponse(t: ApiToken) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes,
    projectKeys: t.projectKeys,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    requireApproval: t.requireApproval,
    approvalPolicy: t.approvalPolicy,
    createdAt: t.createdAt.toISOString(),
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

export async function createToken(
  userId: string,
  data: {
    name: string;
    scopes: string[];
    projectKeys?: string[];
    expiresAt?: string;
    requireApproval?: boolean;
    approvalPolicy?: 'always' | 'destructiveOnly' | 'never';
  }
) {
  const bad = data.scopes.filter((s) => !SCOPES.has(s));
  if (bad.length) {
    throw new JiraApiError(400, jiraError([], { scopes: `Invalid scopes: ${bad.join(', ')}.` }));
  }
  const { plain, prefix, hash } = generateToken();
  const token = await prisma.apiToken.create({
    data: {
      userId,
      name: data.name,
      prefix,
      hash,
      scopes: data.scopes,
      projectKeys: data.projectKeys ?? [],
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      requireApproval: data.requireApproval ?? false,
      // legacy flag maps onto the new column so both reads agree
      approvalPolicy: data.approvalPolicy ?? (data.requireApproval ? 'always' : 'never'),
    },
  });
  return { token, secret: plain };
}

export function listTokens(userId: string) {
  return prisma.apiToken.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

/** 061 US5 — every token with its owner in one query (replaces the /admin/tokens N+1). */
export function listAllTokens() {
  return prisma.apiToken.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { email: true, displayName: true, type: true, active: true } } },
  });
}

export async function revokeToken(id: string, requestorId: string, isAdmin: boolean) {
  const token = await prisma.apiToken.findUnique({ where: { id } });
  if (!token || (token.userId !== requestorId && !isAdmin)) {
    throw new JiraApiError(404, jiraError(['Token not found.']));
  }
  const revoked = await prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
  invalidateApiTokens({ tokenId: id }); // 070 — revoke takes effect immediately, not at cache TTL
  return revoked;
}

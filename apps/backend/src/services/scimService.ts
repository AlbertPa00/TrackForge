// Sprint 049 Track A1 — SCIM 2.0 service provider (RFC 7643/7644).
// IdP pushes Users/Groups CRUD to us. Realities handled per spec:
//   - externalId/userName is the stable key, email optional
//   - active:false → deactivate, NEVER delete (provenance) + revoke credentials
//   - group member lists bounded; unknown members skipped with sync-log warnings
//   - PATCH parsing tolerant (Entra/Okta dialects differ)
import { prisma } from '../prisma.js';
import { hashToken } from '../lib/auth.js';
import type { DirectoryConnection } from '../lib/pc.js';

const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const MAX_GROUP_MEMBERS = 1500; // bounded member lists — IdPs ignore 429s
const MAX_SYNC_LOG = 200;

export class ScimError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function scimErrorBody(status: number, detail: string) {
  return { schemas: [ERROR_SCHEMA], status: String(status), detail };
}

async function syncLog(connectionId: string, level: 'info' | 'warn', msg: string): Promise<void> {
  const conn = await prisma.directoryConnection.findUnique({ where: { id: connectionId } });
  const status = (conn?.syncStatus ?? {}) as { log?: { ts: string; level: string; msg: string }[] };
  const log = [...(Array.isArray(status.log) ? status.log : []), { ts: new Date().toISOString(), level, msg }].slice(
    -MAX_SYNC_LOG
  );
  await prisma.directoryConnection
    .update({
      where: { id: connectionId },
      data: { syncStatus: { ...(status as object), log } },
    })
    .catch(() => undefined);
}

/** FR-003 — deprovisioning deactivates and revokes every credential surface. */
export async function revokeAllCredentials(userId: string): Promise<void> {
  const now = new Date();
  await Promise.all([
    prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.apiToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.oAuthGrant.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  const { invalidateApiTokens } = await import('../lib/tokenCache.js');
  invalidateApiTokens({ userId }); // 070 — evict cached PATs immediately
}

interface ScimUserInput {
  externalId?: string;
  userName?: string;
  displayName?: string;
  email?: string;
  active: boolean;
}

function parseScimUser(body: Record<string, unknown>): ScimUserInput {
  const name = (body.name ?? {}) as Record<string, unknown>;
  const emails = Array.isArray(body.emails) ? (body.emails as { value?: string; primary?: boolean }[]) : [];
  const primary = emails.find((e) => e.primary) ?? emails[0];
  const userName = typeof body.userName === 'string' ? body.userName : undefined;
  return {
    externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
    userName,
    displayName: (body.displayName as string) ?? (name.displayName as string) ?? (name.formatted as string) ?? userName,
    email: primary?.value ?? userName, // edge case: no email → login name IS userName
    active: body.active !== false,
  };
}

export function userToScim(
  user: { id: string; email: string; displayName: string; active: boolean },
  externalId?: string
) {
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    ...(externalId ? { externalId } : {}),
    userName: user.email,
    displayName: user.displayName,
    emails: [{ value: user.email, primary: true }],
    active: user.active,
    meta: { resourceType: 'User' },
  };
}

/** Find the linked user for an incoming SCIM entity — externalId identity first (rename-safe). */
async function findLinkedUser(
  conn: DirectoryConnection,
  input: ScimUserInput
): Promise<{ userId: string; via: string } | null> {
  if (input.externalId) {
    const ident = await prisma.externalIdentity.findUnique({
      where: {
        provider_directoryConnectionId_externalId: {
          provider: 'scim',
          directoryConnectionId: conn.id,
          externalId: input.externalId,
        },
      },
    });
    if (ident) return { userId: ident.userId, via: 'externalId' };
  }
  // 064 US4 — no first-sync email linking: an IdP asserting an email must not
  // silently claim a pre-existing local account (it could then deactivate it
  // and revoke all credentials). Only identities provisioned by this
  // connection are managed; admins link existing accounts explicitly.
  return null;
}

async function applyUserAttrs(userId: string, input: ScimUserInput): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const data: Record<string, unknown> = {};
  if (input.displayName && input.displayName !== user.displayName) data.displayName = input.displayName.slice(0, 200);
  if (input.email && input.email !== user.email) data.email = input.email;
  const nowActive = input.active;
  if (nowActive !== user.active) {
    data.active = nowActive;
    if (!nowActive) await revokeAllCredentials(userId); // FR-003
  }
  if (Object.keys(data).length) await prisma.user.update({ where: { id: userId }, data });
}

export async function upsertScimUser(
  conn: DirectoryConnection,
  body: Record<string, unknown>
): Promise<{ scim: object; status: number }> {
  const input = parseScimUser(body);
  if (!input.externalId && !input.userName) throw new ScimError(400, 'externalId or userName required');
  const linked = await findLinkedUser(conn, input);
  let userId: string;
  if (linked) {
    userId = linked.userId;
    await applyUserAttrs(userId, input);
  } else {
    const user = await prisma.user.create({
      data: {
        email: input.email ?? input.userName!,
        displayName: input.displayName ?? input.userName!,
        passwordHash: '!external',
        active: input.active,
      },
    });
    userId = user.id;
  }
  if (input.externalId) {
    await prisma.externalIdentity.upsert({
      where: {
        provider_directoryConnectionId_externalId: {
          provider: 'scim',
          directoryConnectionId: conn.id,
          externalId: input.externalId,
        },
      },
      update: { userId },
      create: { provider: 'scim', directoryConnectionId: conn.id, externalId: input.externalId, userId },
    });
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await syncLog(
    conn.id,
    'info',
    `${linked ? 'updated' : 'provisioned'} user ${user.email} (externalId=${input.externalId ?? '-'})`
  );
  return { scim: userToScim(user, input.externalId), status: linked ? 200 : 201 };
}

/** PATCH — tolerant: Entra sends {Operations:[{op:'Replace',path:'active',value:'False'}]}. */
export async function patchScimUser(
  conn: DirectoryConnection,
  userId: string,
  body: Record<string, unknown>
): Promise<object> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ScimError(404, 'User not found');
  const ops = Array.isArray(body.Operations)
    ? (body.Operations as { op?: string; path?: string; value?: unknown }[])
    : [];
  const merged: Record<string, unknown> = {};
  for (const o of ops) {
    if ((o.op ?? '').toLowerCase() !== 'replace') continue; // v1: replace only
    const path = (o.path ?? '').toLowerCase();
    if (!path && typeof o.value === 'object' && o.value) Object.assign(merged, o.value);
    else if (['active', 'username', 'displayname', 'emails'].includes(path)) {
      merged[path === 'username' ? 'userName' : path === 'displayname' ? 'displayName' : path] = o.value;
    }
  }
  if (typeof merged.active === 'string') merged.active = !/^(false|0)$/i.test(merged.active);
  const input = parseScimUser({ userName: user.email, ...merged, active: merged.active ?? user.active });
  await applyUserAttrs(userId, { ...input, active: (merged.active as boolean) ?? user.active });
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return userToScim(updated);
}

export async function listScimUsers(
  conn: DirectoryConnection,
  query: { filter?: string; startIndex?: string; count?: string }
): Promise<object> {
  const startIndex = Math.max(1, parseInt(query.startIndex ?? '1', 10) || 1);
  const count = Math.min(200, Math.max(1, parseInt(query.count ?? '100', 10) || 100));
  let where: Record<string, unknown> = {};
  const filter = query.filter ?? '';
  const m = /^\s*(userName|externalId)\s+eq\s+"([^"]+)"\s*$/i.exec(filter);
  if (m) {
    if (m[1].toLowerCase() === 'username') where = { email: m[2] };
    else {
      const ident = await prisma.externalIdentity.findUnique({
        where: {
          provider_directoryConnectionId_externalId: {
            provider: 'scim',
            directoryConnectionId: conn.id,
            externalId: m[2],
          },
        },
      });
      where = { id: ident?.userId ?? 'no-match' };
    }
  } else if (filter) {
    throw new ScimError(400, `Unsupported filter: ${filter}`);
  }
  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, orderBy: { email: 'asc' }, skip: startIndex - 1, take: count }),
  ]);
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: users.length,
    Resources: users.map((u) => userToScim(u)),
  };
}

export async function getScimUser(userId: string): Promise<object> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ScimError(404, 'User not found');
  const ident = await prisma.externalIdentity.findFirst({ where: { userId, provider: 'scim' } });
  return userToScim(user, ident?.externalId);
}

export async function deactivateScimUser(conn: DirectoryConnection, userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ScimError(404, 'User not found');
  await prisma.user.update({ where: { id: userId }, data: { active: false } });
  await revokeAllCredentials(userId);
  await syncLog(conn.id, 'info', `deprovisioned user ${user.email}`);
}

// ---------- Groups ----------

export function groupToScim(group: { id: string; name: string }, members: { userId: string }[]) {
  return {
    schemas: [GROUP_SCHEMA],
    id: group.id,
    displayName: group.name,
    members: members.map((m) => ({ value: m.userId })),
    meta: { resourceType: 'Group' },
  };
}

export async function upsertScimGroup(
  conn: DirectoryConnection,
  body: Record<string, unknown>,
  existingId?: string
): Promise<{ scim: object; status: number }> {
  const displayName = String(body.displayName ?? '').trim();
  if (!displayName) throw new ScimError(400, 'displayName required');
  const members = Array.isArray(body.members) ? (body.members as { value?: string }[]) : [];
  if (members.length > MAX_GROUP_MEMBERS) throw new ScimError(400, `members exceeds the ${MAX_GROUP_MEMBERS} limit`);
  const group = existingId
    ? await prisma.group.update({ where: { id: existingId }, data: { name: displayName } }).catch(() => null)
    : await prisma.group.upsert({ where: { name: displayName }, update: {}, create: { name: displayName } });
  if (!group) throw new ScimError(404, 'Group not found');
  const wanted = new Set(members.map((m) => m.value).filter(Boolean) as string[]);
  const known = await prisma.user.findMany({ where: { id: { in: [...wanted] } }, select: { id: true } });
  const knownIds = new Set(known.map((u) => u.id));
  const skipped = [...wanted].filter((id) => !knownIds.has(id));
  if (skipped.length) {
    await syncLog(
      conn.id,
      'warn',
      `group ${displayName}: ${skipped.length} unknown member id(s) skipped: ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? '…' : ''}`
    );
  }
  await prisma.$transaction([
    prisma.groupMember.deleteMany({ where: { groupId: group.id } }),
    prisma.groupMember.createMany({ data: [...knownIds].map((userId) => ({ groupId: group.id, userId })) }),
  ]);
  const final = await prisma.groupMember.findMany({ where: { groupId: group.id }, select: { userId: true } });
  return { scim: groupToScim(group, final), status: existingId ? 200 : 201 };
}

export async function listScimGroups(query: { startIndex?: string; count?: string }): Promise<object> {
  const startIndex = Math.max(1, parseInt(query.startIndex ?? '1', 10) || 1);
  const count = Math.min(200, Math.max(1, parseInt(query.count ?? '100', 10) || 100));
  const [total, groups] = await Promise.all([
    prisma.group.count(),
    prisma.group.findMany({
      orderBy: { name: 'asc' },
      skip: startIndex - 1,
      take: count,
      include: { members: { select: { userId: true } } },
    }),
  ]);
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: groups.length,
    Resources: groups.map((g) => groupToScim(g, g.members)),
  };
}

export async function getScimGroup(id: string): Promise<object> {
  const group = await prisma.group.findUnique({ where: { id }, include: { members: { select: { userId: true } } } });
  if (!group) throw new ScimError(404, 'Group not found');
  return groupToScim(group, group.members);
}

/** Per-connection bearer → connectionId, or null. */
export async function resolveScimToken(raw: string): Promise<DirectoryConnection | null> {
  const tok = await prisma.scimToken.findUnique({
    where: { hash: hashToken(raw) },
    include: { connection: true },
  });
  if (!tok || tok.revokedAt || !tok.connection.enabled || tok.connection.type !== 'scim') return null;
  void prisma.scimToken.update({ where: { id: tok.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return tok.connection;
}

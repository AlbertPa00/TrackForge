// 032 US3/US4 — share-scope visibility for saved filters. Leaf module (no imports
// of the JQL compiler) so both filterService and the JQL compiler can use it.
// Sharing is row-based (FilterSharePermission) mirroring DashboardPermission.
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { nonBrowsableProjectIds } from './permissionService.js';
import type { Actor } from '../lib/auth.js';

export interface SharePermRow {
  id: string;
  type: string;
  target: string | null;
  target2: string | null;
}

export interface FilterLike {
  ownerId: string;
  visibility: string;
  sharePerms: SharePermRow[];
}

/** Whether `actor` may see (and thus reference) the filter — Jira share scope. */
export async function canSeeFilter(f: FilterLike, actor: Actor): Promise<boolean> {
  if (f.ownerId === actor.user.id || actor.user.isAdmin) return true;
  if (f.visibility === 'all') return true;
  for (const p of f.sharePerms) {
    if (await permMatches(p, actor)) return true;
  }
  return false;
}

async function permMatches(p: SharePermRow, actor: Actor): Promise<boolean> {
  switch (p.type) {
    case 'global':
    case 'authenticated':
      return true;
    case 'user':
      return p.target === actor.user.id;
    case 'group': {
      if (!p.target) return false;
      const gm = await prisma.groupMember.findFirst({
        where: { userId: actor.user.id, group: { name: { equals: p.target, mode: 'insensitive' } } },
        select: { userId: true },
      });
      return !!gm;
    }
    case 'project': {
      if (!p.target) return false;
      const excluded = await nonBrowsableProjectIds(actor);
      return !excluded.includes(p.target);
    }
    case 'projectrole': {
      if (!p.target || !p.target2) return false;
      const row = await prisma.projectRoleActor.findFirst({
        where: {
          roleId: p.target,
          projectId: p.target2,
          OR: [{ userId: actor.user.id }, { group: { members: { some: { userId: actor.user.id } } } }],
        },
        select: { id: true },
      });
      return !!row;
    }
    default:
      return false;
  }
}

/** Stored type → Jira sharePermission response shape. */
export function toJiraSharePerm(p: SharePermRow) {
  switch (p.type) {
    case 'global':
      return { id: p.id, type: 'global' };
    case 'authenticated':
      return { id: p.id, type: 'authenticated' };
    case 'group':
      return { id: p.id, type: 'group', groupname: p.target };
    case 'project':
      return { id: p.id, type: 'project', projectId: p.target };
    case 'projectrole':
      return { id: p.id, type: 'projectRole', projectId: p.target2, roleId: p.target };
    case 'user':
      return { id: p.id, type: 'user', userKey: p.target };
    default:
      return { id: p.id, type: p.type };
  }
}

/** Batch-resolve id targets to display names (projectKey/roleName/userDisplayName)
 *  — one query per entity kind regardless of row count. */
export async function annotateSharePerms(perms: SharePermRow[]) {
  const projectIds = new Set<string>();
  const roleIds = new Set<string>();
  const userIds = new Set<string>();
  for (const p of perms) {
    if (p.type === 'project' && p.target) projectIds.add(p.target);
    if (p.type === 'projectrole') {
      if (p.target) roleIds.add(p.target);
      if (p.target2) projectIds.add(p.target2);
    }
    if (p.type === 'user' && p.target) userIds.add(p.target);
  }
  const [projects, roles, users] = await Promise.all([
    projectIds.size
      ? prisma.project.findMany({ where: { id: { in: [...projectIds] } }, select: { id: true, key: true, name: true } })
      : [],
    roleIds.size
      ? prisma.projectRole.findMany({ where: { id: { in: [...roleIds] } }, select: { id: true, name: true } })
      : [],
    userIds.size
      ? prisma.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, displayName: true } })
      : [],
  ]);
  const projBy = new Map(projects.map((p) => [p.id, p]));
  const roleBy = new Map(roles.map((r) => [r.id, r.name]));
  const userBy = new Map(users.map((u) => [u.id, u.displayName]));
  return perms.map((p) => {
    const base = toJiraSharePerm(p) as Record<string, unknown>;
    const proj = p.target2 ? projBy.get(p.target2) : p.target ? projBy.get(p.target) : undefined;
    if (proj && (p.type === 'project' || p.type === 'projectrole')) {
      base.projectKey = proj.key;
      base.projectName = proj.name;
    }
    if (p.type === 'projectrole') base.roleName = roleBy.get(p.target ?? '') ?? null;
    if (p.type === 'user') base.userDisplayName = userBy.get(p.target ?? '') ?? null;
    return base;
  });
}

export interface SharePermInput {
  type?: string;
  groupname?: string;
  group?: { name?: string };
  projectId?: string;
  projectKey?: string;
  project?: { id?: string; key?: string };
  roleId?: string;
  roleName?: string;
  role?: { id?: string; name?: string };
  userKey?: string;
  accountId?: string;
  user?: { id?: string; email?: string; displayName?: string };
  target?: string;
  target2?: string;
}

const TYPE_ALIASES: Record<string, string> = {
  all: 'global',
  everyone: 'global',
  global: 'global',
  authenticated: 'authenticated',
  loggedin: 'authenticated',
  group: 'group',
  project: 'project',
  projectrole: 'projectrole',
  'project-role': 'projectrole',
  user: 'user',
};

/** Jira sharePermission input → {type,target,target2} row data (targets resolved to ids). */
export async function normalizeSharePerm(input: SharePermInput): Promise<{
  type: string;
  target: string | null;
  target2: string | null;
}> {
  const raw = String(input?.type ?? '')
    .toLowerCase()
    .replace(/[\s_]/g, '');
  const type = TYPE_ALIASES[raw];
  if (!type) {
    throw new JiraApiError(400, jiraError([`Invalid share permission type '${input?.type}'.`]));
  }
  const need = (msg: string) => new JiraApiError(400, jiraError([msg]));
  switch (type) {
    case 'global':
    case 'authenticated':
      return { type, target: null, target2: null };
    case 'group': {
      const name = input.groupname ?? input.group?.name ?? input.target;
      if (!name) throw need(`Share permission type 'group' requires a groupname.`);
      return { type, target: name, target2: null };
    }
    case 'project': {
      const ref = input.projectId ?? input.projectKey ?? input.project?.id ?? input.project?.key ?? input.target;
      if (!ref) throw need(`Share permission type 'project' requires a projectId or projectKey.`);
      const p = await prisma.project.findFirst({
        where: { OR: [{ id: ref }, { key: { equals: ref, mode: 'insensitive' } }] },
        select: { id: true },
      });
      if (!p) throw need(`Share permission references an unknown project '${ref}'.`);
      return { type, target: p.id, target2: null };
    }
    case 'projectrole': {
      const pRef = input.projectId ?? input.projectKey ?? input.project?.id ?? input.project?.key ?? input.target2;
      const rRef = input.roleId ?? input.roleName ?? input.role?.id ?? input.role?.name ?? input.target;
      if (!pRef || !rRef) {
        throw need(`Share permission type 'projectRole' requires projectId/projectKey and roleId/roleName.`);
      }
      const p = await prisma.project.findFirst({
        where: { OR: [{ id: pRef }, { key: { equals: pRef, mode: 'insensitive' } }] },
        select: { id: true },
      });
      if (!p) throw need(`Share permission references an unknown project '${pRef}'.`);
      const r = await prisma.projectRole.findFirst({
        where: { OR: [{ id: rRef }, { name: { equals: rRef, mode: 'insensitive' } }] },
        select: { id: true },
      });
      if (!r) throw need(`Share permission references an unknown project role '${rRef}'.`);
      return { type, target: r.id, target2: p.id };
    }
    case 'user': {
      const ref =
        input.userKey ??
        input.accountId ??
        input.user?.id ??
        input.user?.email ??
        input.user?.displayName ??
        input.target;
      if (!ref) throw need(`Share permission type 'user' requires a userKey/accountId.`);
      const u = await prisma.user.findFirst({
        where: {
          OR: [
            { id: ref },
            { email: { equals: ref, mode: 'insensitive' } },
            { displayName: { equals: ref, mode: 'insensitive' } },
          ],
        },
        select: { id: true },
      });
      if (!u) throw need(`Share permission references an unknown user '${ref}'.`);
      return { type, target: u.id, target2: null };
    }
  }
  throw need(`Invalid share permission type '${input?.type}'.`);
}

/** TF legacy sharedScope/sharedTarget input → sharePerm inputs (compat). */
export function scopeToPermInputs(sharedScope: string, sharedTarget?: string | null): SharePermInput[] {
  switch (sharedScope) {
    case 'all':
      return [{ type: 'global' }];
    case 'group':
      return [{ type: 'group', groupname: sharedTarget ?? undefined }];
    case 'project':
      return [{ type: 'project', projectKey: sharedTarget ?? undefined }];
    case 'projectrole': {
      const i = (sharedTarget ?? '').indexOf(':');
      return [
        {
          type: 'projectRole',
          projectKey: i > 0 ? sharedTarget!.slice(0, i) : undefined,
          roleName: i > 0 ? sharedTarget!.slice(i + 1) : undefined,
        },
      ];
    }
    case 'private':
      return [];
    default:
      throw new JiraApiError(400, jiraError([], { sharePermissions: `Invalid share scope '${sharedScope}'.` }));
  }
}

interface FilterClause {
  type: 'condition' | 'and' | 'or' | 'not';
  field?: { name: string };
  operand?: { kind: string; items?: unknown[]; value?: unknown; raw?: string };
  clause?: FilterClause;
  clauses?: FilterClause[];
}

const SHARE_INCLUDE = { sharePerms: true } as const;

/** Save-time check: every `filter =` operand resolves + no circular refs. */
export async function assertFilterRefsValid(actor: Actor, jql: string, selfId?: string) {
  const { parseJql } = await import('../jql/parser.js');
  const stack = new Set<string>(selfId ? [selfId] : []);

  const walk = async (c: FilterClause | null): Promise<void> => {
    if (!c) return;
    if (c.type === 'not') return walk(c.clause ?? null);
    if (c.type === 'and' || c.type === 'or') {
      for (const x of c.clauses ?? []) await walk(x);
      return;
    }
    if (c.field?.name !== 'filter') return;
    const items =
      c.operand?.kind === 'list'
        ? (c.operand.items as { raw?: string; value?: unknown }[])
        : [c.operand as { raw?: string; value?: unknown }];
    for (const i of items ?? []) {
      const raw = String(i?.value ?? i?.raw ?? '');
      const f = await prisma.filter.findFirst({
        where: { OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }] },
        include: SHARE_INCLUDE,
      });
      if (!f || !(await canSeeFilter(f, actor))) {
        throw new JiraApiError(400, jiraError([`A value with name '${raw}' does not exist for the field 'filter'.`]));
      }
      if (stack.has(f.id)) {
        throw new JiraApiError(400, jiraError([`The filter '${f.name}' creates a circular filter reference.`]));
      }
      stack.add(f.id);
      try {
        await walk(parseJql(f.jql).where as FilterClause | null);
      } finally {
        stack.delete(f.id);
      }
    }
  };

  await walk(parseJql(jql).where as FilterClause | null);
}

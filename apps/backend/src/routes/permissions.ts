import { ps } from '../lib/validation.js';
import { qs } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import { prisma } from '../prisma.js';
import { audit } from '../services/auditService.js';
import { requireAdmin, projectAllowed } from '../middleware/auth.js';
import { DEFAULT_SCHEME_NAME, HOLDER_TYPES, PERMISSIONS, myPermissions } from '../services/permissionService.js';
import { resolveUserRef } from '../services/userService.js';
import { ah, isDryRun, markDryRun, pageParams, resourceSelf } from '../lib/http.js';
import { projectByKeyOr404 } from '../services/projectService.js';
import {
  notFound,
  badReq,
  userShape,
  roleShape,
  grantShape,
  schemeShape,
  requireProjectAdmin,
  roleActorsResponse,
  resolveActorRefs,
  guardLastAdmin,
  grantImpactPreview,
  userByRefOr404,
} from '../services/permissionDomainService.js';

/** Jira v2 permission routes: /group*, /role*, /project/{k}/role*, /permissionscheme*, /mypermissions. */
export const permissionRouter: RouterType = Router();
export const projectPermissionRouter: RouterType = Router({ mergeParams: true });

// ---------- groups (Jira requires admin for all group endpoints) ----------

permissionRouter.post(
  '/group',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw badReq('Group name is required.');
    if (await prisma.group.findUnique({ where: { name } })) throw badReq(`Group '${name}' already exists.`);
    const g = await prisma.group.create({ data: { name } });
    await audit(req, 'group.create', 'group', g.id, { name });
    res.status(201).json({ name: g.name, self: resourceSelf(`/rest/api/2/group?groupname=${g.name}`) });
  })
);

// 021 — group listing for the admin console (Jira's /rest/api/2/groups/picker).
// startAt + real total added so admin pickers page past the first 100 groups.
permissionRouter.get(
  '/groups/picker',
  requireAdmin,
  ah(async (req, res) => {
    const query = String(qs(req.query.query) ?? '').toLowerCase();
    const { startAt, maxResults } = pageParams(req, { cap: 1000, default: 100 });
    const where = query ? { name: { contains: query, mode: 'insensitive' as const } } : {};
    const [total, groups] = await prisma.$transaction([
      prisma.group.count({ where }),
      prisma.group.findMany({
        where,
        include: { _count: { select: { members: true } } },
        orderBy: { name: 'asc' },
        skip: startAt,
        take: maxResults,
      }),
    ]);
    res.json({ groups: groups.map((g) => ({ name: g.name, memberCount: g._count.members })), total });
  })
);

permissionRouter.get(
  '/group',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(qs(req.query.groupname) ?? '');
    const g = await prisma.group.findUnique({ where: { name }, include: { _count: { select: { members: true } } } });
    if (!g) throw notFound(`Group '${name}' not found.`);
    res.json({
      name: g.name,
      self: resourceSelf(`/rest/api/2/group?groupname=${g.name}`),
      users: { size: g._count.members },
      requireTotp: g.requireTotp,
    });
  })
);

// 065 audit A7 — group policy flags: requireTotp existed in the schema (and
// the login gate reads it) but nothing could set it. Jira has no group
// update — TrackForge divergence, admin-only.
permissionRouter.put(
  '/group',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(qs(req.query.groupname) ?? req.body?.groupname ?? '');
    if (!name) throw badReq('groupname is required.');
    const requireTotp = (req.body as { requireTotp?: unknown } | undefined)?.requireTotp;
    if (typeof requireTotp !== 'boolean') throw badReq('requireTotp (boolean) is required.');
    const g = await prisma.group.update({ where: { name }, data: { requireTotp } }).catch(() => null);
    if (!g) throw notFound(`Group '${name}' not found.`);
    await audit(req, 'group.policy.update', 'group', g.id, { name, requireTotp });
    res.json({ name: g.name, requireTotp: g.requireTotp });
  })
);

permissionRouter.delete(
  '/group',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(qs(req.query.groupname) ?? '');
    const g = await prisma.group.findUnique({
      where: { name },
      include: {
        _count: { select: { members: true, roleActors: true } },
        roleActors: { select: { project: { select: { key: true } }, role: { select: { name: true } } } },
      },
    });
    if (!g) throw notFound(`Group '${name}' not found.`);
    const grants = await prisma.permissionGrant.findMany({
      where: { holderType: 'group', holderParam: name },
      include: { scheme: { select: { name: true } } },
    });
    if (isDryRun(req)) {
      markDryRun(res);
      res.json({
        group: g.name,
        members: g._count.members,
        roleActors: g.roleActors.map((a) => ({ project: a.project.key, role: a.role.name })),
        schemeGrants: grants.map((gr) => ({ scheme: gr.scheme.name, permission: gr.permission })),
      });
      return;
    }
    // Confirm removes dependents (edge case from sprint doc).
    await prisma.$transaction([
      prisma.permissionGrant.deleteMany({ where: { holderType: 'group', holderParam: name } }),
      prisma.group.delete({ where: { id: g.id } }),
    ]);
    await audit(req, 'group.delete', 'group', g.id, { name, removedGrants: grants.length });
    res.status(204).send();
  })
);

permissionRouter.get(
  '/group/member',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(qs(req.query.groupname) ?? '');
    const g = await prisma.group.findUnique({ where: { name } });
    if (!g) throw notFound(`Group '${name}' not found.`);
    const { startAt, maxResults } = pageParams(req, { cap: 100, default: 50 });
    // TF extension: ?query= filters members server-side (Jira ignores extras).
    const query = String(qs(req.query.query) ?? '').trim();
    const memberWhere = {
      groupId: g.id,
      ...(query
        ? {
            user: {
              OR: [
                { displayName: { contains: query, mode: 'insensitive' as const } },
                { email: { contains: query, mode: 'insensitive' as const } },
              ],
            },
          }
        : {}),
    };
    const [total, rows] = await prisma.$transaction([
      prisma.groupMember.count({ where: memberWhere }),
      prisma.groupMember.findMany({
        where: memberWhere,
        include: { user: true },
        orderBy: { userId: 'asc' },
        skip: startAt,
        take: maxResults,
      }),
    ]);
    res.json({
      self: resourceSelf(`/rest/api/2/group/member?groupname=${name}`),
      startAt,
      maxResults,
      total,
      isLast: startAt + rows.length >= total,
      values: rows.map((r) => userShape(r.user)),
    });
  })
);

permissionRouter.post(
  '/group/user',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(qs(req.query.groupname) ?? req.body?.groupname ?? '');
    const g = await prisma.group.findUnique({ where: { name } });
    if (!g) throw notFound(`Group '${name}' not found.`);
    const ref = String(req.body?.accountId ?? req.body?.name ?? '');
    const user = await userByRefOr404(ref);
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: g.id, userId: user.id } },
      create: { groupId: g.id, userId: user.id },
      update: {},
    });
    await audit(req, 'group.member.add', 'group', g.id, { name, userId: user.id });
    res.status(201).json({ name: g.name, self: resourceSelf(`/rest/api/2/group?groupname=${g.name}`) });
  })
);

permissionRouter.delete(
  '/group/user',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(qs(req.query.groupname) ?? '');
    const g = await prisma.group.findUnique({ where: { name } });
    if (!g) throw notFound(`Group '${name}' not found.`);
    const ref = String(qs(req.query.accountId) ?? qs(req.query.username) ?? '');
    const user = await userByRefOr404(ref);
    await prisma.groupMember.deleteMany({ where: { groupId: g.id, userId: user.id } });
    await audit(req, 'group.member.remove', 'group', g.id, { name, userId: user.id });
    res.status(204).send();
  })
);

// ---------- project role definitions ----------

// Role names/ids stay readable for any logged-in user — the filter/dashboard
// share pickers need them (Jira restricts /role to admins; documented
// divergence in compatibility.md). Actor lists below are project-admin only.
permissionRouter.get(
  '/role',
  ah(async (_req, res) => {
    const roles = await prisma.projectRole.findMany({ orderBy: { name: 'asc' } });
    res.json(roles.map(roleShape));
  })
);

permissionRouter.post(
  '/role',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw badReq('Role name is required.');
    if (await prisma.projectRole.findUnique({ where: { name } })) throw badReq(`Role '${name}' already exists.`);
    const r = await prisma.projectRole.create({ data: { name, description: String(req.body?.description ?? '') } });
    await audit(req, 'role.create', 'projectRole', r.id, { name });
    res.status(201).json(roleShape(r));
  })
);

permissionRouter.get(
  '/role/:id',
  ah(async (req, res) => {
    const r = await prisma.projectRole.findUnique({ where: { id: ps(req.params.id) } });
    if (!r) throw notFound('Role not found.');
    res.json(roleShape(r));
  })
);

permissionRouter.put(
  '/role/:id',
  requireAdmin,
  ah(async (req, res) => {
    const r = await prisma.projectRole.update({
      where: { id: ps(req.params.id) },
      data: { name: req.body?.name, description: req.body?.description },
    });
    await audit(req, 'role.update', 'projectRole', r.id, { name: r.name });
    res.json(roleShape(r));
  })
);

permissionRouter.delete(
  '/role/:id',
  requireAdmin,
  ah(async (req, res) => {
    await prisma.projectRole.delete({ where: { id: ps(req.params.id) } });
    await audit(req, 'role.delete', 'projectRole', ps(req.params.id), {});
    res.status(204).send();
  })
);

// ---------- project role actors (/project/{key}/role) ----------

async function projectByKey(key: string) {
  const p = await prisma.project.findUnique({
    where: { key: key.toUpperCase() },
    select: { id: true, key: true, leadId: true },
  });
  if (!p) throw notFound('Project does not exist or you do not have permission to see it.');
  return p;
}

projectPermissionRouter.get(
  '/:key/role',
  ah(async (req, res) => {
    const p = await projectByKey(ps(req.params.key));
    if (!projectAllowed(req.actor!, p.key))
      throw notFound('Project does not exist or you do not have permission to see it.');
    await requireProjectAdmin(req, p.id);
    const roles = await prisma.projectRole.findMany({ orderBy: { name: 'asc' } });
    const out: Record<string, string> = {};
    for (const r of roles) out[r.name] = resourceSelf(`/rest/api/2/project/${p.key}/role/${r.id}`);
    res.json(out);
  })
);

projectPermissionRouter.get(
  '/:key/role/:id',
  ah(async (req, res) => {
    const p = await projectByKey(ps(req.params.key));
    if (!projectAllowed(req.actor!, p.key))
      throw notFound('Project does not exist or you do not have permission to see it.');
    await requireProjectAdmin(req, p.id);
    res.json(await roleActorsResponse(p, ps(req.params.id)));
  })
);

projectPermissionRouter.post(
  '/:key/role/:id',
  ah(async (req, res) => {
    const p = await projectByKey(ps(req.params.key));
    await requireProjectAdmin(req, p.id);
    const role = await prisma.projectRole.findUnique({ where: { id: ps(req.params.id) } });
    if (!role) throw notFound('Role not found.');
    const { userIds, groupIds } = await resolveActorRefs(req.body ?? {});
    await prisma.projectRoleActor.createMany({
      data: [
        ...userIds.map((userId) => ({ roleId: role.id, projectId: p.id, userId })),
        ...groupIds.map((groupId) => ({ roleId: role.id, projectId: p.id, groupId })),
      ],
      skipDuplicates: true,
    });
    await audit(req, 'role.actors.add', 'project', p.id, { role: role.name, userIds, groupIds });
    res.json(await roleActorsResponse(p, role.id));
  })
);

projectPermissionRouter.put(
  '/:key/role/:id',
  ah(async (req, res) => {
    const p = await projectByKey(ps(req.params.key));
    await requireProjectAdmin(req, p.id);
    const role = await prisma.projectRole.findUnique({ where: { id: ps(req.params.id) } });
    if (!role) throw notFound('Role not found.');
    const { userIds, groupIds } = await resolveActorRefs(req.body ?? {});
    await prisma.$transaction(async (tx) => {
      const existing = await tx.projectRoleActor.findMany({ where: { projectId: p.id, roleId: role.id } });
      const toRemove = existing.filter(
        (a) => !(a.userId && userIds.includes(a.userId)) && !(a.groupId && groupIds.includes(a.groupId))
      );
      if (role.name === 'Administrators' && toRemove.length === existing.length) {
        throw badReq('Cannot remove the last Administrators actor from a project — site administrators retain access.');
      }
      await tx.projectRoleActor.deleteMany({ where: { id: { in: toRemove.map((a) => a.id) } } });
      await tx.projectRoleActor.createMany({
        data: [
          ...userIds.map((userId) => ({ roleId: role.id, projectId: p.id, userId })),
          ...groupIds.map((groupId) => ({ roleId: role.id, projectId: p.id, groupId })),
        ],
        skipDuplicates: true,
      });
    });
    await audit(req, 'role.actors.set', 'project', p.id, { role: role.name, userIds, groupIds });
    res.json(await roleActorsResponse(p, role.id));
  })
);

projectPermissionRouter.delete(
  '/:key/role/:id',
  ah(async (req, res) => {
    const p = await projectByKey(ps(req.params.key));
    await requireProjectAdmin(req, p.id);
    const role = await prisma.projectRole.findUnique({ where: { id: ps(req.params.id) } });
    if (!role) throw notFound('Role not found.');
    const userRef = qs(req.query.user) as string | undefined;
    const groupRef = qs(req.query.group) as string | undefined;
    if (!userRef && !groupRef) throw badReq('Provide ?user= or ?group=.');
    const user = userRef ? await resolveUserRef(userRef) : null;
    const group = groupRef ? await prisma.group.findUnique({ where: { name: groupRef } }) : null;
    await guardLastAdmin(p.id, role.id, user ? [user.id] : [], group ? [group.id] : []);
    await prisma.projectRoleActor.deleteMany({
      where: {
        projectId: p.id,
        roleId: role.id,
        ...(user ? { userId: user.id } : {}),
        ...(group ? { groupId: group.id } : {}),
      },
    });
    await audit(req, 'role.actors.remove', 'project', p.id, { role: role.name, user: userRef, group: groupRef });
    res.status(204).send();
  })
);

// ---------- permission schemes ----------

permissionRouter.get(
  '/permissionscheme',
  requireAdmin,
  ah(async (req, res) => {
    const expand = String(qs(req.query.expand) ?? '');
    const schemes = await prisma.permissionScheme.findMany({
      orderBy: { name: 'asc' },
      include: expand.includes('permissions') ? { grants: true } : undefined,
    });
    res.json({ permissionSchemes: schemes.map((s) => schemeShape(s, (s as { grants?: never[] }).grants)) });
  })
);

permissionRouter.post(
  '/permissionscheme',
  requireAdmin,
  ah(async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw badReq('Scheme name is required.');
    const s = await prisma.permissionScheme.create({
      data: { name, description: String(req.body?.description ?? '') },
    });
    await audit(req, 'scheme.create', 'permissionScheme', s.id, { name });
    res.status(201).json(schemeShape(s));
  })
);

permissionRouter.get(
  '/permissionscheme/:id',
  requireAdmin,
  ah(async (req, res) => {
    const s = await prisma.permissionScheme.findUnique({ where: { id: ps(req.params.id) }, include: { grants: true } });
    if (!s) throw notFound('Permission scheme not found.');
    res.json(schemeShape(s, s.grants));
  })
);

permissionRouter.put(
  '/permissionscheme/:id',
  requireAdmin,
  ah(async (req, res) => {
    const s = await prisma.permissionScheme.update({
      where: { id: ps(req.params.id) },
      data: { name: req.body?.name, description: req.body?.description },
    });
    await audit(req, 'scheme.update', 'permissionScheme', s.id, { name: s.name });
    res.json(schemeShape(s));
  })
);

permissionRouter.delete(
  '/permissionscheme/:id',
  requireAdmin,
  ah(async (req, res) => {
    const s = await prisma.permissionScheme.findUnique({
      where: { id: ps(req.params.id) },
      include: { projects: { select: { key: true } }, _count: { select: { grants: true } } },
    });
    if (!s) throw notFound('Permission scheme not found.');
    if (s.name === DEFAULT_SCHEME_NAME) throw badReq('The default permission scheme cannot be deleted.');
    if (isDryRun(req)) {
      markDryRun(res);
      res.json({
        scheme: s.name,
        grants: s._count.grants,
        projects: s.projects.map((p) => p.key),
        wouldReassignTo: DEFAULT_SCHEME_NAME,
      });
      return;
    }
    const def = await prisma.permissionScheme.findFirst({ where: { name: DEFAULT_SCHEME_NAME } });
    await prisma.$transaction([
      prisma.project.updateMany({ where: { permissionSchemeId: s.id }, data: { permissionSchemeId: def?.id ?? null } }),
      prisma.permissionScheme.delete({ where: { id: s.id } }),
    ]);
    await audit(req, 'scheme.delete', 'permissionScheme', s.id, {
      name: s.name,
      reassigned: s.projects.map((p) => p.key),
    });
    res.status(204).send();
  })
);

permissionRouter.get(
  '/permissionscheme/:id/permission',
  requireAdmin,
  ah(async (req, res) => {
    const grants = await prisma.permissionGrant.findMany({ where: { schemeId: ps(req.params.id) } });
    res.json({ permissions: grants.map(grantShape) });
  })
);

permissionRouter.post(
  '/permissionscheme/:id/permission',
  requireAdmin,
  ah(async (req, res) => {
    const s = await prisma.permissionScheme.findUnique({ where: { id: ps(req.params.id) } });
    if (!s) throw notFound('Permission scheme not found.');
    const permission = String(req.body?.permission ?? '').toUpperCase();
    const holder = req.body?.holder ?? {};
    const holderType = String(holder.type ?? '');
    const holderParam = holder.parameter != null ? String(holder.parameter) : null;
    if (!(PERMISSIONS as readonly string[]).includes(permission)) throw badReq(`Unknown permission '${permission}'.`);
    if (!(HOLDER_TYPES as readonly string[]).includes(holderType)) throw badReq(`Unknown holder type '${holderType}'.`);
    if (['user', 'group', 'projectRole', 'userCustomField', 'groupCustomField'].includes(holderType) && !holderParam)
      throw badReq(`Holder type '${holderType}' requires a parameter.`);
    const g = await prisma.permissionGrant.create({ data: { schemeId: s.id, permission, holderType, holderParam } });
    await audit(req, 'scheme.grant.add', 'permissionScheme', s.id, { permission, holderType, holderParam });
    res.status(201).json(grantShape(g));
  })
);

permissionRouter.delete(
  '/permissionscheme/:id/permission/:permissionId',
  requireAdmin,
  ah(async (req, res) => {
    const g = await prisma.permissionGrant.findUnique({ where: { id: ps(req.params.permissionId) } });
    if (!g || g.schemeId !== ps(req.params.id)) throw notFound('Grant not found.');
    await prisma.permissionGrant.delete({ where: { id: g.id } });
    await audit(req, 'scheme.grant.remove', 'permissionScheme', g.schemeId, { permission: g.permission });
    res.status(204).send();
  })
);

// 021 US3-3 — grant impact preview: the count of distinct users a grant would
// directly reach across the scheme's bound projects (dynamic holders like
// reporter/assignee can't be counted — reported as dynamic).
permissionRouter.post(
  '/permissionscheme/:id/permission/preview',
  requireAdmin,
  ah(async (req, res) => {
    const s = await prisma.permissionScheme.findUnique({ where: { id: ps(req.params.id) } });
    if (!s) throw notFound('Permission scheme not found.');
    const holderType = String(req.body?.holder?.type ?? '');
    const holderParam = req.body?.holder?.parameter != null ? String(req.body.holder.parameter) : null;
    if (!(HOLDER_TYPES as readonly string[]).includes(holderType)) throw badReq(`Unknown holder type '${holderType}'.`);

    res.json(await grantImpactPreview(s.id, holderType, holderParam));
  })
);

// ---------- project ↔ scheme assignment ----------

projectPermissionRouter.get(
  '/:key/permissionscheme',
  ah(async (req, res) => {
    const p = await prisma.project.findUnique({
      where: { key: ps(req.params.key).toUpperCase() },
      include: { scheme: true },
    });
    if (!p) throw notFound('Project does not exist or you do not have permission to see it.');
    if (!projectAllowed(req.actor!, p.key))
      throw notFound('Project does not exist or you do not have permission to see it.');
    await requireProjectAdmin(req, p.id);
    res.json(p.scheme ? schemeShape(p.scheme) : { name: DEFAULT_SCHEME_NAME });
  })
);

projectPermissionRouter.put(
  '/:key/permissionscheme',
  ah(async (req, res) => {
    const p = await projectByKeyOr404(ps(req.params.key));
    await requireProjectAdmin(req, p.id);
    const schemeId = String(req.body?.id ?? '');
    const s = await prisma.permissionScheme.findUnique({ where: { id: schemeId } });
    if (!s) throw notFound('Permission scheme not found.');
    if (isDryRun(req)) {
      const users = await prisma.user.count({ where: { active: true } });
      markDryRun(res);
      res.json({ project: p.key, from: p.permissionSchemeId, to: s.id, potentiallyAffectedUsers: users });
      return;
    }
    await prisma.project.update({ where: { id: p.id }, data: { permissionSchemeId: s.id } });
    await audit(req, 'scheme.assign', 'project', p.id, { scheme: s.name });
    res.json(schemeShape(s));
  })
);

// ---------- /mypermissions ----------

permissionRouter.get(
  '/mypermissions',
  ah(async (req, res) => {
    const perms = String(qs(req.query.permissions) ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!perms.length) throw badReq('The permissions parameter is required.');
    let scope: {
      projectId?: string;
      issue?: { projectId: string; reporterId?: string | null; assigneeId?: string | null };
    } = {};
    if (qs(req.query.issueKey)) {
      const key = String(qs(req.query.issueKey)).toUpperCase();
      const num = Number(key.split('-')[1]);
      const issue = await prisma.issue.findFirst({
        where: { issueNumber: num, project: { key: key.split('-')[0] } },
        select: { id: true, projectId: true, reporterId: true, assigneeId: true },
      });
      if (issue) scope = { issue };
    } else if (qs(req.query.projectKey) || qs(req.query.projectId)) {
      const p = await prisma.project.findFirst({
        where: qs(req.query.projectKey)
          ? { key: String(qs(req.query.projectKey)).toUpperCase() }
          : { id: String(qs(req.query.projectId)) },
        select: { id: true },
      });
      if (p) scope = { projectId: p.id };
    }
    res.json(await myPermissions(req.actor!, scope, perms));
  })
);

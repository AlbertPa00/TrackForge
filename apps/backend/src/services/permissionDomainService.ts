// 065 US5 — group/role/scheme domain logic extracted from routes/permissions.ts:
// mappers, the project-admin gate, actor resolution, last-admin guard and the
// grant-impact preview. Routes keep parse→authz→service→shape.
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { resourceSelf } from '../lib/http.js';
import { hasPermission } from './permissionService.js';
import { resolveUserRef } from './userService.js';

export const notFound = (msg: string) => new JiraApiError(404, jiraError([msg]));
export const badReq = (msg: string) => new JiraApiError(400, jiraError([msg]));

export const userShape = (u: { id: string; email: string; displayName: string; active: boolean }) => ({
  self: resourceSelf(`/rest/api/2/user?accountId=${u.id}`),
  accountId: u.id,
  name: u.email,
  emailAddress: u.email,
  displayName: u.displayName,
  active: u.active,
});

export const roleShape = (r: { id: string; name: string; description: string }) => ({
  self: resourceSelf(`/rest/api/2/role/${r.id}`),
  id: r.id,
  name: r.name,
  description: r.description,
});

export const actorShape = (a: {
  id: string;
  userId: string | null;
  groupId: string | null;
  user?: { id: string; email: string; displayName: string } | null;
  group?: { name: string } | null;
}) =>
  a.user
    ? {
        id: a.id,
        displayName: a.user.displayName,
        type: 'atlassian-user-role-actor',
        name: a.user.email,
        actorUser: { accountId: a.user.id },
      }
    : { id: a.id, displayName: a.group?.name ?? '', type: 'atlassian-group-role-actor', name: a.group?.name ?? '' };

export const grantShape = (g: { id: string; permission: string; holderType: string; holderParam: string | null }) => ({
  id: g.id,
  permission: g.permission,
  holder: { type: g.holderType, ...(g.holderParam ? { parameter: g.holderParam } : {}), expand: '' },
});

export const schemeShape = (
  s: { id: string; name: string; description: string },
  grants?: { id: string; permission: string; holderType: string; holderParam: string | null }[]
) => ({
  id: s.id,
  self: resourceSelf(`/rest/api/2/permissionscheme/${s.id}`),
  name: s.name,
  description: s.description,
  ...(grants ? { permissions: grants.map(grantShape) } : {}),
});

/** Project-admin gate: site admin OR ADMINISTER_PROJECTS on the project. */
export async function requireProjectAdmin(req: { actor?: Express.Request['actor'] }, projectId: string) {
  const actor = req.actor!;
  if (actor.user.isAdmin) return;
  if (!(await hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId }))) {
    throw new JiraApiError(
      403,
      jiraError(["Missing required permission 'ADMINISTER_PROJECTS'."], {
        permission: "Missing required permission 'ADMINISTER_PROJECTS'.",
      })
    );
  }
}

export async function roleActorsResponse(project: { id: string; key: string }, roleId: string) {
  const role = await prisma.projectRole.findUnique({ where: { id: roleId } });
  if (!role) throw notFound('Role not found.');
  const actors = await prisma.projectRoleActor.findMany({
    where: { projectId: project.id, roleId },
    include: { user: true, group: true },
  });
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    self: resourceSelf(`/rest/api/2/project/${project.key}/role/${role.id}`),
    actors: actors.map((a) => actorShape(a)),
  };
}

/** Resolve Jira `user`/`group` body refs to ids (user refs go through the
 *  shared accountId|email|displayName resolver — 065 US4). */
export async function resolveActorRefs(body: { user?: string[]; group?: string[] }) {
  const userIds: string[] = [];
  for (const ref of body.user ?? []) {
    const u = await resolveUserRef(ref);
    if (!u) throw badReq(`User '${ref}' not found.`);
    userIds.push(u.id);
  }
  const groupIds: string[] = [];
  for (const name of body.group ?? []) {
    const g = await prisma.group.findUnique({ where: { name } });
    if (!g) throw badReq(`Group '${name}' not found.`);
    groupIds.push(g.id);
  }
  return { userIds, groupIds };
}

/** Single user ref used by group member add/remove (same resolver). */
export async function userByRefOr404(ref: string) {
  const u = await resolveUserRef(ref);
  if (!u) throw notFound('User not found.');
  return u;
}

/** US4.2 — refuse to strip the last actor that grants Administrators membership. */
export async function guardLastAdmin(projectId: string, roleId: string, removeUserIds: string[], removeGroupIds: string[]) {
  const role = await prisma.projectRole.findUnique({ where: { id: roleId } });
  if (role?.name !== 'Administrators') return;
  const remaining = await prisma.projectRoleActor.findMany({
    where: {
      projectId,
      roleId,
      NOT: [
        ...(removeUserIds.length ? [{ userId: { in: removeUserIds } }] : []),
        ...(removeGroupIds.length ? [{ groupId: { in: removeGroupIds } }] : []),
      ] as never[],
    },
  });
  const nonTargetActors = remaining.filter(
    (a) => !(a.userId && removeUserIds.includes(a.userId)) && !(a.groupId && removeGroupIds.includes(a.groupId))
  );
  if (nonTargetActors.length === 0) {
    throw badReq('Cannot remove the last Administrators actor from a project — site administrators retain access.');
  }
}

/** 021 US3-3 — grant impact preview: distinct users a grant would directly
 *  reach across the scheme's bound projects (dynamic holders can't be
 *  counted — reported as dynamic). */
export async function grantImpactPreview(schemeId: string, holderType: string, holderParam: string | null) {
  const bound = await prisma.project.findMany({
    where: { permissionSchemeId: schemeId },
    select: { id: true, key: true, leadId: true },
  });
  const projectIds = bound.map((p) => p.id);
  let users: Set<string> | null = null;
  let dynamic = false;
  let detail = '';

  switch (holderType) {
    case 'applicationRole': {
      const rows = await prisma.user.findMany({ where: { active: true }, select: { id: true } });
      users = new Set(rows.map((u) => u.id));
      detail = 'every active user';
      break;
    }
    case 'user': {
      const u = holderParam ? await prisma.user.findUnique({ where: { id: holderParam } }) : null;
      if (!u) throw badReq('User not found.');
      users = new Set([u.id]);
      detail = u.displayName;
      break;
    }
    case 'group': {
      const g = holderParam
        ? await prisma.group.findUnique({ where: { name: holderParam }, include: { members: { select: { userId: true } } } })
        : null;
      if (!g) throw badReq(`Group '${holderParam}' not found.`);
      users = new Set(g.members.map((m) => m.userId));
      detail = `${users.size} member(s) of ${g.name}`;
      break;
    }
    case 'projectRole': {
      const role = holderParam ? await prisma.projectRole.findUnique({ where: { id: holderParam } }) : null;
      if (!role) throw badReq('Project role not found.');
      const actors = await prisma.projectRoleActor.findMany({
        where: { roleId: role.id, projectId: { in: projectIds } },
        select: { userId: true, groupId: true },
      });
      users = new Set(actors.map((a) => a.userId).filter((x): x is string => Boolean(x)));
      const groupIds = actors.map((a) => a.groupId).filter((x): x is string => Boolean(x));
      if (groupIds.length) {
        const members = await prisma.groupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } });
        for (const m of members) users.add(m.userId);
      }
      detail = `role '${role.name}' across ${bound.length} project(s)`;
      break;
    }
    case 'projectLead': {
      users = new Set(bound.map((p) => p.leadId).filter((x): x is string => Boolean(x)));
      detail = `lead(s) of ${bound.length} project(s)`;
      break;
    }
    case 'reporter':
    case 'assignee':
    case 'userCustomField':
    case 'groupCustomField':
      dynamic = true;
      detail = 'varies per issue — cannot be counted ahead of time';
      break;
  }

  return {
    holder: { type: holderType, parameter: holderParam ?? undefined },
    projects: bound.map((p) => p.key),
    directUserCount: users?.size ?? null,
    dynamic,
    detail,
  };
}

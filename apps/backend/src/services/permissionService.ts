import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { jiraError, JiraApiError } from '../lib/errors.js';

/**
 * Sprint 015 — the single authorization funnel (FR-001). Every read/write of
 * project or issue data resolves permissions through here; token scopes and
 * project allow-lists remain a separate outer layer that intersects.
 */

// Jira Server/DC project permission catalog (FR-001). ARCHIVE_/RESTORE_ISSUES
// are enforced by archiveIssue/restoreIssue (issueService) — archived issues
// are read-only until restored.
export const PERMISSIONS = [
  'ADMINISTER_PROJECTS',
  'BROWSE_PROJECTS',
  'MANAGE_SPRINTS',
  'VIEW_DEV_TOOLS',
  'VIEW_READONLY_WORKFLOW',
  'ASSIGNABLE_USER',
  'ASSIGN_ISSUES',
  'CLOSE_ISSUES',
  'CREATE_ISSUES',
  'DELETE_ISSUES',
  'EDIT_ISSUES',
  'LINK_ISSUES',
  'MODIFY_REPORTER',
  'MOVE_ISSUES',
  'RESOLVE_ISSUES',
  'SCHEDULE_ISSUES',
  'SET_ISSUE_SECURITY',
  'TRANSITION_ISSUES',
  'MANAGE_WATCHERS',
  'VIEW_VOTERS_AND_WATCHERS',
  'ADD_COMMENTS',
  'EDIT_ALL_COMMENTS',
  'EDIT_OWN_COMMENTS',
  'DELETE_ALL_COMMENTS',
  'DELETE_OWN_COMMENTS',
  'CREATE_ATTACHMENTS',
  'DELETE_ALL_ATTACHMENTS',
  'DELETE_OWN_ATTACHMENTS',
  'WORK_ON_ISSUES',
  'EDIT_ALL_WORKLOGS',
  'EDIT_OWN_WORKLOGS',
  'DELETE_ALL_WORKLOGS',
  'DELETE_OWN_WORKLOGS',
  'ARCHIVE_ISSUES',
  'RESTORE_ISSUES',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

// Jira holder types. `anyone` (anonymous) is omitted — authentication is
// required for every request.
export const HOLDER_TYPES = [
  'applicationRole', // any logged-in user
  'user', // param = userId
  'group', // param = group name
  'projectRole', // param = roleId
  'projectLead',
  'reporter',
  'assignee',
  'userCustomField', // param = customfield_NNNNN (user-type field on the issue)
  'groupCustomField', // param = customfield_NNNNN (group-type field on the issue)
] as const;
export type HolderType = (typeof HOLDER_TYPES)[number];

export const DEFAULT_SCHEME_NAME = 'Default Permission Scheme';
export const DEFAULT_ROLES = ['Administrators', 'Developers', 'Users'] as const;
export const DEFAULT_GROUPS = ['jira-administrators', 'jira-software-users'] as const;

const PERMISSION_PHRASES: Record<string, string> = {
  ADMINISTER_PROJECTS: 'administer this project',
  BROWSE_PROJECTS: 'browse this project',
  MANAGE_SPRINTS: 'manage sprints in this project',
  VIEW_DEV_TOOLS: 'view development tools in this project',
  VIEW_READONLY_WORKFLOW: 'view the workflow in this project',
  CREATE_ISSUES: 'create issues in this project',
  EDIT_ISSUES: 'edit issues in this project',
  TRANSITION_ISSUES: 'transition issues in this project',
  RESOLVE_ISSUES: 'resolve issues in this project',
  CLOSE_ISSUES: 'close issues in this project',
  SCHEDULE_ISSUES: 'schedule issues in this project',
  MOVE_ISSUES: 'move issues in this project',
  DELETE_ISSUES: 'delete issues in this project',
  LINK_ISSUES: 'link issues in this project',
  ASSIGN_ISSUES: 'assign issues in this project',
  ASSIGNABLE_USER: 'be assigned issues in this project',
  MODIFY_REPORTER: 'modify the reporter of issues in this project',
  SET_ISSUE_SECURITY: 'set the security level of issues in this project',
  ADD_COMMENTS: 'comment on issues in this project',
  EDIT_ALL_COMMENTS: 'edit all comments in this project',
  EDIT_OWN_COMMENTS: 'edit own comments in this project',
  DELETE_ALL_COMMENTS: 'delete all comments in this project',
  DELETE_OWN_COMMENTS: 'delete own comments in this project',
  MANAGE_WATCHERS: 'manage watchers in this project',
  VIEW_VOTERS_AND_WATCHERS: 'view voters and watchers in this project',
  WORK_ON_ISSUES: 'log work on issues in this project',
  EDIT_OWN_WORKLOGS: 'edit own worklogs in this project',
  EDIT_ALL_WORKLOGS: 'edit all worklogs in this project',
  DELETE_OWN_WORKLOGS: 'delete own worklogs in this project',
  DELETE_ALL_WORKLOGS: 'delete all worklogs in this project',
  CREATE_ATTACHMENTS: 'create attachments in this project',
  DELETE_OWN_ATTACHMENTS: 'delete own attachments in this project',
  DELETE_ALL_ATTACHMENTS: 'delete all attachments in this project',
  ARCHIVE_ISSUES: 'archive issues in this project',
  RESTORE_ISSUES: 'restore issues in this project',
};

interface IssuePermCtx {
  id?: string;
  projectId?: string;
  reporterId?: string | null;
  assigneeId?: string | null;
}

// --- request-scoped memo (edge case: no cross-request cache) ---
interface ActorPermState {
  checks: Map<string, boolean>;
  groupIds?: Set<string>;
  groupNames?: Set<string>;
  roleActors: Map<string, { byUser: Set<string>; byGroup: Set<string> }>; // `${projectId}:${roleId}`
  projectCtx: Map<string, { schemeId: string | null; leadId: string | null }>;
}
const memo = new WeakMap<Actor, ActorPermState>();
function stateFor(actor: Actor): ActorPermState {
  let s = memo.get(actor);
  if (!s) {
    s = { checks: new Map(), roleActors: new Map(), projectCtx: new Map() };
    memo.set(actor, s);
  }
  return s;
}

async function actorGroups(actor: Actor, s: ActorPermState) {
  if (!s.groupIds) {
    const rows = await prisma.groupMember.findMany({
      where: { userId: actor.user.id },
      include: { group: { select: { id: true, name: true } } },
    });
    s.groupIds = new Set(rows.map((r) => r.group.id));
    s.groupNames = new Set(rows.map((r) => r.group.name));
  }
  return { ids: s.groupIds, names: s.groupNames! };
}

async function projectCtx(projectId: string, s: ActorPermState) {
  let ctx = s.projectCtx.get(projectId);
  if (!ctx) {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { permissionSchemeId: true, leadId: true },
    });
    ctx = { schemeId: p?.permissionSchemeId ?? null, leadId: p?.leadId ?? null };
    if (!ctx.schemeId) ctx.schemeId = await defaultSchemeId();
    s.projectCtx.set(projectId, ctx);
  }
  return ctx;
}

async function roleActors(projectId: string, roleId: string, s: ActorPermState) {
  const key = `${projectId}:${roleId}`;
  let set = s.roleActors.get(key);
  if (!set) {
    const rows = await prisma.projectRoleActor.findMany({
      where: { projectId, roleId },
      select: { userId: true, groupId: true },
    });
    set = {
      byUser: new Set(rows.map((r) => r.userId).filter(Boolean) as string[]),
      byGroup: new Set(rows.map((r) => r.groupId).filter(Boolean) as string[]),
    };
    s.roleActors.set(key, set);
  }
  return set;
}

export async function defaultSchemeId(): Promise<string | null> {
  const s = await prisma.permissionScheme.findFirst({
    where: { name: DEFAULT_SCHEME_NAME },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  return s?.id ?? null;
}

async function holderMatches(
  holderType: string,
  holderParam: string | null,
  actor: Actor,
  ctx: { leadId: string | null },
  issue: IssuePermCtx | undefined,
  s: ActorPermState,
  projectId: string
): Promise<boolean> {
  switch (holderType) {
    case 'applicationRole':
      // Any logged-in user (deactivated users cannot authenticate at all).
      return true;
    case 'user':
      return holderParam === actor.user.id;
    case 'group': {
      const g = await actorGroups(actor, s);
      return g.names.has(holderParam ?? '');
    }
    case 'projectRole': {
      if (!holderParam) return false;
      const actors = await roleActors(projectId, holderParam, s);
      if (actors.byUser.has(actor.user.id)) return true;
      const g = await actorGroups(actor, s);
      for (const gid of actors.byGroup) if (g.ids.has(gid)) return true;
      return false;
    }
    case 'projectLead':
      return ctx.leadId === actor.user.id;
    case 'reporter':
      return !!issue && issue.reporterId === actor.user.id;
    case 'assignee':
      return !!issue && issue.assigneeId === actor.user.id;
    case 'userCustomField': {
      // Jira "User Custom Field Value" — holderParam is the customfield id;
      // the grant reaches whoever the issue's user-picker field holds.
      if (!issue?.id || !holderParam) return false;
      const v = await prisma.customFieldValue.findUnique({
        where: { issueId_fieldId: { issueId: issue.id, fieldId: holderParam } },
        select: { value: true },
      });
      // user CFs store the denormalized {accountId, displayName, …} shape.
      const held =
        typeof v?.value === 'object' && v.value !== null ? (v.value as { accountId?: string }).accountId : v?.value;
      return held === actor.user.id;
    }
    case 'groupCustomField': {
      // Same for group-picker fields — the value stores the group name.
      if (!issue?.id || !holderParam) return false;
      const v = await prisma.customFieldValue.findUnique({
        where: { issueId_fieldId: { issueId: issue.id, fieldId: holderParam } },
        select: { value: true },
      });
      if (typeof v?.value !== 'string') return false;
      const g = await actorGroups(actor, s);
      return g.names.has(v.value);
    }
    default:
      return false;
  }
}

/** Core check — Jira semantics: site admin bypasses project permissions. */
export async function hasPermission(
  actor: Actor,
  permission: Permission | string,
  ctx: { projectId: string; issue?: IssuePermCtx }
): Promise<boolean> {
  if (actor.user.isAdmin) return true;
  const s = stateFor(actor);
  const issue = ctx.issue;
  const key = `${ctx.projectId}:${permission}:${issue?.id ?? ''}:${issue?.reporterId ?? ''}:${issue?.assigneeId ?? ''}`;
  const hit = s.checks.get(key);
  if (hit !== undefined) return hit;

  const pctx = await projectCtx(ctx.projectId, s);
  let result = false;
  if (pctx.schemeId) {
    const grants = await prisma.permissionGrant.findMany({
      where: { schemeId: pctx.schemeId, permission },
      select: { holderType: true, holderParam: true },
    });
    for (const g of grants) {
      if (await holderMatches(g.holderType, g.holderParam, actor, pctx, issue, s, ctx.projectId)) {
        result = true;
        break;
      }
    }
  }
  s.checks.set(key, result);
  return result;
}

/** 403 Jira-shaped denial naming the permission (FR-003/A8). */
export async function requirePermission(
  actor: Actor,
  permission: Permission | string,
  ctx: { projectId: string; issue?: IssuePermCtx }
): Promise<void> {
  if (await hasPermission(actor, permission, ctx)) return;
  const phrase = PERMISSION_PHRASES[permission] ?? permission.toLowerCase().replace(/_/g, ' ');
  throw new JiraApiError(
    403,
    jiraError([`You do not have permission to ${phrase}.`], {
      permission: `Missing required permission '${permission}'.`,
    })
  );
}

/** Convenience: same check against an issue row that carries projectId. */
export async function requireIssuePermission(
  actor: Actor,
  permission: Permission | string,
  issue: IssuePermCtx & { projectId: string }
): Promise<void> {
  return requirePermission(actor, permission, { projectId: issue.projectId, issue });
}

/** 065 US4 — authored-resource modify check, Jira semantics:
 *  `{VERB}_ALL_{KIND}` covers your own rows too (ALL ⊃ OWN). commentService
 *  and worklogService each hand-rolled this fork — worklog's version (either
 *  grant suffices) is the correct one. */
export async function canModifyAuthored(
  actor: Actor,
  row: { authorId: string },
  kind: 'COMMENTS' | 'WORKLOGS',
  verb: 'EDIT' | 'DELETE',
  ctx: { projectId: string; issue?: IssuePermCtx }
): Promise<boolean> {
  if (row.authorId === actor.user.id && (await hasPermission(actor, `${verb}_OWN_${kind}`, ctx))) return true;
  return hasPermission(actor, `${verb}_ALL_${kind}`, ctx);
}

/** Role-membership check used by workflow conditions and role admin guards. */
export async function userInProjectRole(actor: Actor, projectId: string, roleNameOrId: string): Promise<boolean> {
  if (actor.user.isAdmin) return true;
  const s = stateFor(actor);
  const role = await prisma.projectRole.findFirst({
    where: { OR: [{ id: roleNameOrId }, { name: roleNameOrId }] },
    select: { id: true },
  });
  if (!role) return false;
  const actors = await roleActors(projectId, role.id, s);
  if (actors.byUser.has(actor.user.id)) return true;
  const g = await actorGroups(actor, s);
  for (const gid of actors.byGroup) if (g.ids.has(gid)) return true;
  return false;
}

export async function userInGroup(actor: Actor, groupName: string): Promise<boolean> {
  if (actor.user.isAdmin) return true;
  const g = await actorGroups(actor, stateFor(actor));
  return g.names.has(groupName);
}

/**
 * Inverse check for pickers: which users hold `permission` on `projectId` via
 * statically enumerable holders (applicationRole, user, group, projectRole,
 * projectLead). Dynamic holders (reporter/assignee/userCustomField) bind per
 * issue and can't be enumerated — callers scope to project level (Jira does
 * the same for its assignable picker).
 */
export async function usersWithPermission(permission: Permission | string, projectId: string): Promise<Set<string>> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { permissionSchemeId: true, leadId: true },
  });
  let schemeId = project?.permissionSchemeId ?? null;
  if (!schemeId) schemeId = await defaultSchemeId();
  const grants = schemeId
    ? await prisma.permissionGrant.findMany({
        where: { schemeId, permission },
        select: { holderType: true, holderParam: true },
      })
    : [];
  const out = new Set<string>();
  for (const g of grants) {
    switch (g.holderType) {
      case 'applicationRole': {
        for (const u of await prisma.user.findMany({ where: { active: true }, select: { id: true } })) out.add(u.id);
        break;
      }
      case 'user':
        if (g.holderParam) out.add(g.holderParam);
        break;
      case 'group': {
        const grp = g.holderParam ? await prisma.group.findUnique({ where: { name: g.holderParam } }) : null;
        if (grp) {
          for (const m of await prisma.groupMember.findMany({ where: { groupId: grp.id }, select: { userId: true } }))
            out.add(m.userId);
        }
        break;
      }
      case 'projectRole': {
        if (!g.holderParam) break;
        const actors = await prisma.projectRoleActor.findMany({
          where: { projectId, roleId: g.holderParam },
          select: { userId: true, groupId: true },
        });
        const groupIds: string[] = [];
        for (const a of actors) {
          if (a.userId) out.add(a.userId);
          if (a.groupId) groupIds.push(a.groupId);
        }
        if (groupIds.length) {
          for (const m of await prisma.groupMember.findMany({
            where: { groupId: { in: groupIds } },
            select: { userId: true },
          }))
            out.add(m.userId);
        }
        break;
      }
      case 'projectLead':
        if (project?.leadId) out.add(project.leadId);
        break;
      // reporter / assignee / userCustomField: issue-scoped, not enumerable.
    }
  }
  return out;
}

/** Project ids the actor cannot browse — for search/list scoping (FR-003). */
export async function nonBrowsableProjectIds(actor: Actor): Promise<string[]> {
  if (actor.user.isAdmin) return [];
  const projects = await prisma.project.findMany({ select: { id: true } });
  const denied: string[] = [];
  for (const p of projects) {
    if (!(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: p.id }))) denied.push(p.id);
  }
  return denied;
}

/** /mypermissions response for a project or issue context. */
export async function myPermissions(
  actor: Actor,
  scope: { projectId?: string; issue?: IssuePermCtx & { projectId: string } },
  permissions: string[]
) {
  const projectId = scope.issue?.projectId ?? scope.projectId;
  const out: Record<
    string,
    { id: string; key: string; name: string; type: string; description: string; havePermission: boolean }
  > = {};
  for (const p of permissions) {
    const perm = p.trim().toUpperCase();
    out[perm] = {
      id: String(PERMISSIONS.indexOf(perm as Permission)),
      key: perm,
      name: perm
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      type: 'PROJECT',
      description: '',
      havePermission: projectId
        ? await hasPermission(actor, perm, { projectId, issue: scope.issue })
        : actor.user.isAdmin,
    };
  }
  return { permissions: out };
}

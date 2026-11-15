// Sprint 031 — issue security schemes & levels (US4).
// A project may bind an IssueSecurityScheme; issues stamped `securityLevelId`
// are visible only to that level's members. Subtasks inherit the parent's
// effective level (Jira semantics — a subtask never carries its own).
//
// FR: filtering is ONE query-layer predicate — `securityGateWhere(actor)` —
// shared by search/boards/reports/exports, plus `canSeeIssue` for single
// issue loads inside enforceIssueScope. Both consult the same membership eval.
// 065 US1 — renamed from `visibleIssuesWhere`: this predicate is ONLY the
// security-level gate (064 gate 3). Callers assembling a full read predicate
// must AND it with the project gates — or use visibilityService's
// `visibleIssueWhere` (all three gates) for multi-project queries.

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import type { Actor } from '../lib/auth.js';
import type { Prisma } from '@prisma/client';
import { projectByKeyOr404 } from './projectService.js';

export type MemberKind = 'user' | 'group' | 'projectrole' | 'reporter' | 'assignee' | 'projectlead';
export const MEMBER_KINDS: MemberKind[] = ['user', 'group', 'projectrole', 'reporter', 'assignee', 'projectlead'];

// ---------- membership resolution helpers ----------

async function actorContext(actor: Actor) {
  const uid = actor.user.id;
  const groupMemberships = await prisma.groupMember.findMany({
    where: { userId: uid },
    select: { groupId: true, group: { select: { name: true } } },
  });
  const groupNames = groupMemberships.map((g) => g.group.name);
  const groupIds = groupMemberships.map((g) => g.groupId);
  const roleRows = await prisma.projectRoleActor.findMany({
    where: { OR: [{ userId: uid }, ...(groupIds.length ? [{ groupId: { in: groupIds } }] : [])] },
    select: { projectId: true, roleId: true },
  });
  const rolesByProject = new Map<string, Set<string>>();
  for (const r of roleRows) {
    const s = rolesByProject.get(r.projectId) ?? new Set<string>();
    s.add(r.roleId);
    rolesByProject.set(r.projectId, s);
  }
  const allRoleIds = [...new Set(roleRows.map((r) => r.roleId))];
  const roleNames = allRoleIds.length
    ? await prisma.projectRole.findMany({ where: { id: { in: allRoleIds } }, select: { id: true, name: true } })
    : [];
  const roleNameById = new Map(roleNames.map((r) => [r.id, r.name]));
  const roleNamesByProject = new Map<string, Set<string>>();
  for (const [pid, ids] of rolesByProject) {
    roleNamesByProject.set(pid, new Set([...ids].map((i) => roleNameById.get(i)).filter((n): n is string => !!n)));
  }
  return { uid, groupNames, rolesByProject, roleNamesByProject };
}

/**
 * FR predicate — AND this into every issue read.
 * Visible iff effective level (own ?? parent's, denormalized to
 * `effSecurityLevelId`) is null or the level has a member covering the actor.
 *
 * PERF (031 gate): membership is resolved ONCE per query into level-id sets —
 * the predicate is pure scalar columns + small IN lists, zero relation joins.
 * The earlier relation-chain form (`securityLevel.members.some`, parent hop)
 * compiled to ~25 LEFT JOINs and seq-scanned before the rank sort (4.5s page
 * on the 50k fixture vs 15ms here).
 */
export async function securityGateWhere(actor: Actor): Promise<Prisma.IssueWhereInput> {
  const ctx = await actorContext(actor);
  const allRoleIds = [...new Set([...ctx.rolesByProject.values()].flatMap((s) => [...s]))];
  const memberRows = await prisma.securityLevelMember.findMany({
    where: {
      OR: [
        { kind: 'user', ref: ctx.uid },
        ...(ctx.groupNames.length ? [{ kind: 'group', ref: { in: ctx.groupNames } }] : []),
        ...(allRoleIds.length ? [{ kind: 'projectrole', ref: { in: allRoleIds } }] : []),
        { kind: { in: ['reporter', 'assignee', 'projectlead'] } },
      ],
    },
    select: { levelId: true, kind: true, ref: true },
  });
  const staticIds: string[] = [];
  const dynIds: Record<'reporter' | 'assignee' | 'projectlead', string[]> = {
    reporter: [],
    assignee: [],
    projectlead: [],
  };
  const roleLevelIds = new Map<string, string[]>();
  for (const m of memberRows) {
    if (m.kind === 'user' || m.kind === 'group') staticIds.push(m.levelId);
    else if (m.kind === 'projectrole') roleLevelIds.set(m.ref!, [...(roleLevelIds.get(m.ref!) ?? []), m.levelId]);
    else dynIds[m.kind as 'reporter' | 'assignee' | 'projectlead'].push(m.levelId);
  }

  const clauses: Prisma.IssueWhereInput[] = [{ effSecurityLevelId: null }];
  if (staticIds.length) clauses.push({ effSecurityLevelId: { in: staticIds } });
  if (dynIds.reporter.length) clauses.push({ reporterId: ctx.uid, effSecurityLevelId: { in: dynIds.reporter } });
  if (dynIds.assignee.length) clauses.push({ assigneeId: ctx.uid, effSecurityLevelId: { in: dynIds.assignee } });
  if (dynIds.projectlead.length) {
    const led = await prisma.project.findMany({ where: { leadId: ctx.uid }, select: { id: true } });
    if (led.length)
      clauses.push({ projectId: { in: led.map((p) => p.id) }, effSecurityLevelId: { in: dynIds.projectlead } });
  }
  for (const [projectId, roleIds] of ctx.rolesByProject) {
    const lvlIds = [...new Set([...roleIds].flatMap((r) => roleLevelIds.get(r) ?? []))];
    if (lvlIds.length) clauses.push({ projectId, effSecurityLevelId: { in: lvlIds } });
  }
  // 060 US7 — single composed archive predicate: every read surface that
  // ANDs this in hides archived issues (Jira DC — they live only in the
  // dedicated archived-issues view + restore path).
  return { AND: [{ OR: clauses }, { archived: false }] };
}

/**
 * Children without their own level mirror the parent's effective level —
 * call with the parent's NEW eff after its security/parent changed.
 * Recursive: every unsecured descendant inherits the propagated eff; a
 * child carrying its own level keeps it and cuts the descent (its own
 * unsecured children already mirror that level, which did not change).
 */
export async function cascadeEffectiveSecurity(
  parentId: string,
  eff: string | null,
  tx: Pick<typeof prisma, 'issue'> = prisma
): Promise<void> {
  const seen = new Set([parentId]); // guards a malformed parentId cycle
  let frontier = [parentId];
  while (frontier.length) {
    const rows = await tx.issue.findMany({
      where: { parentId: { in: frontier }, securityLevelId: null },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id).filter((id) => !seen.has(id));
    if (!ids.length) break;
    await tx.issue.updateMany({ where: { id: { in: ids } }, data: { effSecurityLevelId: eff } });
    for (const id of ids) seen.add(id);
    frontier = ids;
  }
}

/** Single-issue check used by enforceIssueScope — 404 existence-hiding.
    060 US7: archived issues are hidden too — restore goes through the
    dedicated /issue/{key}/restore route which bypasses this check. */
export async function canSeeIssue(
  actor: Actor,
  issue: {
    id: string;
    effSecurityLevelId: string | null;
    reporterId: string | null;
    assigneeId: string | null;
    projectId: string;
    archived?: boolean;
  }
): Promise<boolean> {
  if (issue.archived === true) return false;
  const levelId = issue.effSecurityLevelId;
  if (!levelId) return true;
  const members = await prisma.securityLevelMember.findMany({ where: { levelId } });
  if (!members.length) return false;
  const ctx = await actorContext(actor);
  for (const m of members) {
    switch (m.kind as MemberKind) {
      case 'user':
        if (m.ref === ctx.uid) return true;
        break;
      case 'group':
        if (m.ref && ctx.groupNames.includes(m.ref)) return true;
        break;
      case 'reporter':
        if (issue.reporterId === ctx.uid) return true;
        break;
      case 'assignee':
        if (issue.assigneeId === ctx.uid) return true;
        break;
      case 'projectlead': {
        const p = await prisma.project.findUnique({ where: { id: issue.projectId }, select: { leadId: true } });
        if (p?.leadId === ctx.uid) return true;
        break;
      }
      case 'projectrole': {
        const roles = ctx.rolesByProject.get(issue.projectId);
        if (m.ref && roles?.has(m.ref)) return true;
        break;
      }
    }
  }
  return false;
}

/** Resolve `fields.security` input ({id}|{name}|name-string|null) within the project's scheme. */
export async function resolveLevelInput(projectId: string, input: unknown): Promise<string | null | undefined> {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const nameOrId =
    typeof input === 'string'
      ? input
      : ((input as { id?: string; name?: string })?.id ?? (input as { name?: string })?.name);
  if (!nameOrId) return undefined;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { issueSecuritySchemeId: true },
  });
  if (!project?.issueSecuritySchemeId) {
    throw new JiraApiError(400, jiraError(['Project has no issue security scheme; security level cannot be set.']));
  }
  const level = await prisma.securityLevel.findFirst({
    where: { schemeId: project.issueSecuritySchemeId, OR: [{ id: nameOrId }, { name: String(nameOrId) }] },
  });
  if (!level)
    throw new JiraApiError(400, jiraError([`The security level '${nameOrId}' does not exist for this project.`]));
  return level.id;
}

/** Project default level — applied on create when no explicit level is given. */
export async function defaultLevelId(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { issueSecuritySchemeId: true } });
  if (!p?.issueSecuritySchemeId) return null;
  const d = await prisma.securityLevel.findFirst({ where: { schemeId: p.issueSecuritySchemeId, isDefault: true } });
  return d?.id ?? null;
}

// ---------- comment/worklog visibility (Jira role|group restriction) ----------

export type Visibility = {
  type: 'role' | 'group';
  value: string;
  // string-valued index signature → assignable to Prisma.InputJsonValue
  [k: string]: string;
};

/** Parse+validate a Jira `visibility` input; null clears, undefined untouched. */
export function parseVisibility(input: unknown): Visibility | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  const v = input as { type?: string; value?: string };
  if (v?.type !== 'role' && v?.type !== 'group') {
    throw new JiraApiError(400, jiraError([], { visibility: "visibility.type must be 'role' or 'group'." }));
  }
  if (!v.value?.trim()) {
    throw new JiraApiError(400, jiraError([], { visibility: 'visibility.value is required.' }));
  }
  return { type: v.type, value: v.value.trim() };
}

/** Verify the referenced group/role exists (Jira validates the target). */
export async function assertVisibilityTarget(vis: Visibility) {
  if (vis.type === 'group') {
    const g = await prisma.group.findFirst({ where: { name: vis.value } });
    if (!g) throw new JiraApiError(400, jiraError([], { visibility: `The group '${vis.value}' does not exist.` }));
  } else {
    const r = await prisma.projectRole.findFirst({ where: { name: vis.value } });
    if (!r)
      throw new JiraApiError(400, jiraError([], { visibility: `The project role '${vis.value}' does not exist.` }));
  }
}

type CtxVisibility = Awaited<ReturnType<typeof actorContext>>;

function visibilityPasses(vis: Visibility | null | undefined, ctx: CtxVisibility, projectId: string): boolean {
  if (!vis) return true;
  if (vis.type === 'group') return ctx.groupNames.includes(vis.value);
  return ctx.roleNamesByProject.get(projectId)?.has(vis.value) ?? false;
}

/**
 * Filter comment/worklog rows by Jira visibility — a restricted row is
 * visible to its author and to members of the named group/project role.
 */
export async function filterByVisibility<T extends { authorId: string; visibility: unknown }>(
  rows: T[],
  actor: Actor,
  projectId: string
): Promise<T[]> {
  if (!rows.some((r) => r.visibility)) return rows;
  const ctx = await actorContext(actor);
  return rows.filter(
    (r) => !r.visibility || r.authorId === actor.user.id || visibilityPasses(r.visibility as Visibility, ctx, projectId)
  );
}

/** Single-row check for getComment-style endpoints → 404 existence-hiding. */
export async function canSeeVisibility(
  row: { authorId: string; visibility: unknown },
  actor: Actor,
  projectId: string
): Promise<boolean> {
  if (!row.visibility || row.authorId === actor.user.id) return true;
  const ctx = await actorContext(actor);
  return visibilityPasses(row.visibility as Visibility, ctx, projectId);
}

// ---------- scheme / level CRUD ----------

export async function listSchemes() {
  return prisma.issueSecurityScheme.findMany({
    include: { levels: { include: { members: true } }, _count: { select: { projects: true } } },
    orderBy: { name: 'asc' },
  });
}

export async function createScheme(input: {
  name: string;
  description?: string;
  levels?: {
    name: string;
    description?: string;
    isDefault?: boolean;
    members?: { kind: MemberKind; ref?: string }[];
  }[];
}) {
  return prisma.issueSecurityScheme.create({
    data: {
      name: input.name,
      description: input.description,
      levels: {
        create: (input.levels ?? []).map((l) => ({
          name: l.name,
          description: l.description,
          isDefault: l.isDefault ?? false,
          members: { create: (l.members ?? []).map((m) => ({ kind: m.kind, ref: m.ref ?? null })) },
        })),
      },
    },
    include: { levels: { include: { members: true } } },
  });
}

export async function updateScheme(id: string, input: { name?: string; description?: string }) {
  const s = await prisma.issueSecurityScheme.findUnique({ where: { id } });
  if (!s) throw new JiraApiError(404, jiraError(['Issue security scheme does not exist.']));
  return prisma.issueSecurityScheme.update({ where: { id }, data: input });
}

export async function deleteScheme(id: string) {
  const s = await prisma.issueSecurityScheme.findUnique({
    where: { id },
    include: { _count: { select: { projects: true } } },
  });
  if (!s) throw new JiraApiError(404, jiraError(['Issue security scheme does not exist.']));
  await prisma.issueSecurityScheme.delete({ where: { id } });
}

export async function addLevel(
  schemeId: string,
  input: { name: string; description?: string; isDefault?: boolean; members?: { kind: MemberKind; ref?: string }[] }
) {
  const s = await prisma.issueSecurityScheme.findUnique({ where: { id: schemeId } });
  if (!s) throw new JiraApiError(404, jiraError(['Issue security scheme does not exist.']));
  return prisma.securityLevel.create({
    data: {
      schemeId,
      name: input.name,
      description: input.description,
      isDefault: input.isDefault ?? false,
      members: { create: (input.members ?? []).map((m) => ({ kind: m.kind, ref: m.ref ?? null })) },
    },
    include: { members: true },
  });
}

export async function updateLevel(
  levelId: string,
  input: { name?: string; description?: string; isDefault?: boolean; members?: { kind: MemberKind; ref?: string }[] }
) {
  const level = await prisma.securityLevel.findUnique({ where: { id: levelId } });
  if (!level) throw new JiraApiError(404, jiraError(['Security level does not exist.']));
  await prisma.$transaction(async (tx) => {
    await tx.securityLevel.update({
      where: { id: levelId },
      data: {
        name: input.name,
        description: input.description,
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      },
    });
    if (input.members) {
      await tx.securityLevelMember.deleteMany({ where: { levelId } });
      await tx.securityLevelMember.createMany({
        data: input.members.map((m) => ({ levelId, kind: m.kind, ref: m.ref ?? null })),
      });
    }
  });
  return prisma.securityLevel.findUnique({ where: { id: levelId }, include: { members: true } });
}

export async function deleteLevel(levelId: string) {
  const level = await prisma.securityLevel.findUnique({
    where: { id: levelId },
    include: { _count: { select: { issues: true } } },
  });
  if (!level) throw new JiraApiError(404, jiraError(['Security level does not exist.']));
  if (level._count.issues > 0)
    throw new JiraApiError(
      400,
      jiraError([`Level still protects ${level._count.issues} issue(s) — remove their security first.`])
    );
  await prisma.securityLevel.delete({ where: { id: levelId } });
}

export async function assignScheme(projectKey: string, schemeId: string | null) {
  const project = await projectByKeyOr404(projectKey);
  if (schemeId) {
    const s = await prisma.issueSecurityScheme.findUnique({ where: { id: schemeId } });
    if (!s) throw new JiraApiError(404, jiraError(['Issue security scheme does not exist.']));
  }
  return prisma.project.update({ where: { id: project.id }, data: { issueSecuritySchemeId: schemeId } });
}

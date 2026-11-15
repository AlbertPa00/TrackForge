import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { emitEvent } from './eventService.js';
import type { Prisma } from '@prisma/client';
import { jiraDate, resourceSelf, userSelf } from '../lib/http.js';

/** Sprint 019 — components & versions (Jira release model). */

type Actor = {
  user: { id: string; displayName: string; type?: string };
  channel: string;
  token?: { id: string } | null;
};
type Tx = Prisma.TransactionClient;

export const COMPONENT_ASSIGNEE_TYPES = ['PROJECT_DEFAULT', 'COMPONENT_LEAD', 'PROJECT_LEAD', 'UNASSIGNED'] as const;

/* ------------------------------ serializers ----------------------------- */

export function toComponentResponse(c: {
  id: string;
  name: string;
  description: string | null;
  projectId: string;
  assigneeType: string;
  lead?: { id: string; displayName: string } | null;
  project?: { key: string };
  _count?: { issues: number };
}) {
  return {
    id: c.id,
    self: resourceSelf(`/rest/api/2/component/${c.id}`),
    name: c.name,
    description: c.description ?? undefined,
    project: c.project?.key,
    projectId: c.projectId,
    lead: c.lead ? { accountId: c.lead.id, displayName: c.lead.displayName, self: userSelf(c.lead.id) } : undefined,
    assigneeType: c.assigneeType,
    realAssigneeType: c.assigneeType,
    isAssigneeTypeValid: c.assigneeType !== 'PROJECT_DEFAULT' || true,
    ...(c._count ? { issueCount: c._count.issues } : {}),
  };
}

export function toVersionResponse(v: {
  id: string;
  name: string;
  description: string | null;
  projectId: string;
  released: boolean;
  archived: boolean;
  startDate: Date | null;
  releaseDate: Date | null;
  sequence: number;
  project?: { key: string };
}) {
  return {
    id: v.id,
    self: resourceSelf(`/rest/api/2/version/${v.id}`),
    name: v.name,
    description: v.description ?? undefined,
    project: v.project?.key,
    projectId: v.projectId,
    released: v.released,
    archived: v.archived,
    startDate: v.startDate ? jiraDate(v.startDate) : undefined,
    releaseDate: v.releaseDate ? jiraDate(v.releaseDate) : undefined,
    sequence: v.sequence,
    overdue: v.releaseDate && !v.released ? v.releaseDate.getTime() < Date.now() : undefined,
  };
}

/* ------------------------------ components ------------------------------ */

const componentInclude = {
  lead: { select: { id: true, displayName: true } },
  project: { select: { key: true } },
} as const;

export async function createComponent(
  projectId: string,
  data: { name: string; description?: string; leadUserName?: string; leadAccountId?: string; assigneeType?: string },
  actor: Actor
) {
  const name = String(data.name ?? '').trim();
  if (!name) throw new JiraApiError(400, jiraError([], { name: 'Component name is required.' }));
  if (data.assigneeType && !COMPONENT_ASSIGNEE_TYPES.includes(data.assigneeType as never)) {
    throw new JiraApiError(
      400,
      jiraError([], {
        assigneeType: `Invalid assigneeType '${data.assigneeType}'. Valid: ${COMPONENT_ASSIGNEE_TYPES.join(', ')}.`,
      })
    );
  }
  let leadId: string | null = null;
  const leadRef = data.leadAccountId ?? data.leadUserName;
  if (leadRef) {
    const lead = await prisma.user.findFirst({ where: { OR: [{ id: leadRef }, { displayName: leadRef }] } });
    if (!lead) throw new JiraApiError(400, jiraError([], { lead: `User '${leadRef}' does not exist.` }));
    leadId = lead.id;
  }
  const dup = await prisma.component.findUnique({ where: { projectId_name: { projectId, name } } });
  if (dup)
    throw new JiraApiError(
      400,
      jiraError([], { name: `A component with name '${name}' already exists in this project.` })
    );
  const c = await prisma.component.create({
    data: {
      projectId,
      name,
      description: data.description ?? null,
      leadId,
      assigneeType: data.assigneeType ?? 'PROJECT_DEFAULT',
    },
    include: componentInclude,
  });
  await emitEvent(prisma, actor, {
    type: 'jira:component_created',
    projectId,
    payload: { component: toComponentResponse(c) },
  });
  return c;
}

export async function updateComponent(
  id: string,
  data: {
    name?: string;
    description?: string | null;
    leadUserName?: string;
    leadAccountId?: string | null;
    assigneeType?: string;
  },
  actor: Actor
) {
  const existing = await prisma.component.findUnique({ where: { id } });
  if (!existing) throw new JiraApiError(404, jiraError([`Component '${id}' does not exist.`], {}));
  const upd: Prisma.ComponentUpdateInput = {};
  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) throw new JiraApiError(400, jiraError([], { name: 'Component name is required.' }));
    const dup = await prisma.component.findFirst({ where: { projectId: existing.projectId, name, NOT: { id } } });
    if (dup)
      throw new JiraApiError(
        400,
        jiraError([], { name: `A component with name '${name}' already exists in this project.` })
      );
    upd.name = name;
  }
  if (data.description !== undefined) upd.description = data.description;
  if (data.assigneeType !== undefined) {
    if (!COMPONENT_ASSIGNEE_TYPES.includes(data.assigneeType as never)) {
      throw new JiraApiError(400, jiraError([], { assigneeType: `Invalid assigneeType '${data.assigneeType}'.` }));
    }
    upd.assigneeType = data.assigneeType;
  }
  const leadRef = data.leadAccountId !== undefined ? data.leadAccountId : data.leadUserName;
  if (leadRef !== undefined) {
    if (leadRef === null) upd.lead = { disconnect: true };
    else {
      const lead = await prisma.user.findFirst({ where: { OR: [{ id: leadRef }, { displayName: leadRef }] } });
      if (!lead) throw new JiraApiError(400, jiraError([], { lead: `User '${leadRef}' does not exist.` }));
      upd.lead = { connect: { id: lead.id } };
    }
  }
  const c = await prisma.component.update({ where: { id }, data: upd, include: componentInclude });
  await emitEvent(prisma, actor, {
    type: 'jira:component_updated',
    projectId: existing.projectId,
    payload: { component: toComponentResponse(c) },
  });
  return c;
}

/** Jira delete: optional `moveIssuesTo` swaps all issue refs to another component. */
export async function deleteComponent(id: string, moveIssuesTo: string | undefined, actor: Actor) {
  const existing = await prisma.component.findUnique({ where: { id } });
  if (!existing) throw new JiraApiError(404, jiraError([`Component '${id}' does not exist.`], {}));
  await prisma.$transaction(async (tx) => {
    if (moveIssuesTo) {
      const target = await tx.component.findUnique({ where: { id: moveIssuesTo } });
      if (!target || target.projectId !== existing.projectId) {
        throw new JiraApiError(
          400,
          jiraError([], { moveIssuesTo: 'Target component does not exist in this project.' })
        );
      }
      const refs = await tx.issueComponent.findMany({ where: { componentId: id } });
      for (const r of refs) {
        await tx.issueComponent.upsert({
          where: { issueId_componentId: { issueId: r.issueId, componentId: moveIssuesTo } },
          update: {},
          create: { issueId: r.issueId, componentId: moveIssuesTo },
        });
      }
    }
    await tx.issueComponent.deleteMany({ where: { componentId: id } });
    await tx.component.delete({ where: { id } });
    await emitEvent(tx, actor, {
      type: 'jira:component_deleted',
      projectId: existing.projectId,
      payload: { component: { id, name: existing.name }, moveIssuesTo: moveIssuesTo ?? null },
    });
  });
}

export async function listComponents(projectId: string) {
  return prisma.component.findMany({
    where: { projectId },
    include: { ...componentInclude, _count: { select: { issues: true } } },
    orderBy: { name: 'asc' },
  });
}

/* ------------------------------- versions ------------------------------- */

export async function createVersion(
  projectId: string,
  data: {
    name: string;
    description?: string;
    released?: boolean;
    archived?: boolean;
    startDate?: string;
    releaseDate?: string;
  },
  actor: Actor
) {
  const name = String(data.name ?? '').trim();
  if (!name) throw new JiraApiError(400, jiraError([], { name: 'Version name is required.' }));
  const dup = await prisma.version.findUnique({ where: { projectId_name: { projectId, name } } });
  if (dup)
    throw new JiraApiError(
      400,
      jiraError([], { name: `A version with name '${name}' already exists in this project.` })
    );
  const max = await prisma.version.aggregate({ where: { projectId }, _max: { sequence: true } });
  const v = await prisma.version.create({
    data: {
      projectId,
      name,
      description: data.description ?? null,
      released: data.released ?? false,
      archived: data.archived ?? false,
      startDate: data.startDate ? new Date(data.startDate) : null,
      releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
      sequence: (max._max.sequence ?? -1) + 1,
    },
    include: { project: { select: { key: true } } },
  });
  await emitEvent(prisma, actor, {
    type: 'jira:version_created',
    projectId,
    payload: { version: toVersionResponse(v) },
  });
  return v;
}

export async function updateVersion(
  id: string,
  data: {
    name?: string;
    description?: string | null;
    released?: boolean;
    archived?: boolean;
    startDate?: string | null;
    releaseDate?: string | null;
  },
  actor: Actor
) {
  const existing = await prisma.version.findUnique({ where: { id } });
  if (!existing) throw new JiraApiError(404, jiraError([`Version '${id}' does not exist.`], {}));
  const upd: Prisma.VersionUpdateInput = {};
  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) throw new JiraApiError(400, jiraError([], { name: 'Version name is required.' }));
    const dup = await prisma.version.findFirst({ where: { projectId: existing.projectId, name, NOT: { id } } });
    if (dup)
      throw new JiraApiError(
        400,
        jiraError([], { name: `A version with name '${name}' already exists in this project.` })
      );
    upd.name = name;
  }
  if (data.description !== undefined) upd.description = data.description;
  if (data.released !== undefined) upd.released = data.released;
  if (data.archived !== undefined) upd.archived = data.archived;
  if (data.startDate !== undefined) upd.startDate = data.startDate ? new Date(data.startDate) : null;
  if (data.releaseDate !== undefined) upd.releaseDate = data.releaseDate ? new Date(data.releaseDate) : null;
  const v = await prisma.version.update({ where: { id }, data: upd, include: { project: { select: { key: true } } } });
  await emitEvent(prisma, actor, {
    type: 'jira:version_updated',
    projectId: existing.projectId,
    payload: { version: toVersionResponse(v) },
  });
  return v;
}

/** Jira move: `{position: 'Earlier'|'Later'|'First'|'Last', after?: selfUrl}` — v1
 *  supports position + `after` url parsing into a sequence re-order. */
export async function moveVersion(
  id: string,
  position: string | undefined,
  afterUrl: string | undefined,
  actor: Actor
) {
  const v = await prisma.version.findUnique({ where: { id } });
  if (!v) throw new JiraApiError(404, jiraError([`Version '${id}' does not exist.`], {}));
  const siblings = await prisma.version.findMany({
    where: { projectId: v.projectId, NOT: { id } },
    orderBy: { sequence: 'asc' },
  });
  let insertAt = siblings.length;
  const afterId = afterUrl?.match(/\/version\/([^/]+)/)?.[1];
  if (afterId) {
    const idx = siblings.findIndex((s) => s.id === afterId);
    if (idx === -1)
      throw new JiraApiError(400, jiraError([], { after: 'Target version does not exist in this project.' }));
    insertAt = idx + 1;
  } else if (position === 'First' || position === 'Earlier') {
    insertAt = position === 'First' ? 0 : Math.max(0, siblings.length - 1);
  } else if (position && position !== 'Last' && position !== 'Later') {
    throw new JiraApiError(400, jiraError([], { position: `Invalid position '${position}'.` }));
  }
  const reordered = [...siblings.slice(0, insertAt), v, ...siblings.slice(insertAt)];
  await prisma.$transaction(
    reordered.map((s, i) => prisma.version.update({ where: { id: s.id }, data: { sequence: i } }))
  );
  await emitEvent(prisma, actor, {
    type: 'jira:version_moved',
    projectId: v.projectId,
    payload: { version: toVersionResponse({ ...v, sequence: insertAt, project: undefined }) },
  });
  return { ...v, sequence: insertAt };
}

export async function deleteVersion(
  id: string,
  moveFixIssuesTo: string | undefined,
  moveAffectedIssuesTo: string | undefined,
  actor: Actor
) {
  const existing = await prisma.version.findUnique({ where: { id } });
  if (!existing) throw new JiraApiError(404, jiraError([`Version '${id}' does not exist.`], {}));
  await prisma.$transaction(async (tx) => {
    for (const [kind, targetId] of [
      ['fix', moveFixIssuesTo],
      ['affects', moveAffectedIssuesTo],
    ] as const) {
      if (!targetId) continue;
      const target = await tx.version.findUnique({ where: { id: targetId } });
      if (!target || target.projectId !== existing.projectId) {
        throw new JiraApiError(400, jiraError([], { moveIssuesTo: 'Target version does not exist in this project.' }));
      }
      const refs = await tx.issueVersion.findMany({ where: { versionId: id, kind } });
      for (const r of refs) {
        await tx.issueVersion.upsert({
          where: { issueId_versionId_kind: { issueId: r.issueId, versionId: targetId, kind } },
          update: {},
          create: { issueId: r.issueId, versionId: targetId, kind },
        });
      }
      await tx.issueVersion.deleteMany({ where: { versionId: id, kind } });
    }
    await tx.issueVersion.deleteMany({ where: { versionId: id } });
    await tx.version.delete({ where: { id } });
    await emitEvent(tx, actor, {
      type: 'jira:version_deleted',
      projectId: existing.projectId,
      payload: { version: { id, name: existing.name } },
    });
  });
}

export async function listVersions(projectId: string) {
  return prisma.version.findMany({
    where: { projectId },
    include: { project: { select: { key: true } } },
    orderBy: { sequence: 'asc' },
  });
}

const RESOLVED_CATEGORY = 'done';

export async function versionIssueCounts(versionId: string) {
  const [issues, done, unresolved] = await Promise.all([
    prisma.issueVersion.count({ where: { versionId, kind: 'fix' } }),
    prisma.issueVersion.count({
      where: { versionId, kind: 'fix', issue: { status: { category: RESOLVED_CATEGORY } } },
    }),
    prisma.issueVersion.count({
      where: { versionId, kind: 'fix', issue: { status: { category: { not: RESOLVED_CATEGORY } } } },
    }),
  ]);
  return {
    issuesFixedCount: issues,
    issuesDoneCount: done,
    issuesUnresolvedCount: unresolved,
    issuesAffectedCount: await prisma.issueVersion.count({ where: { versionId, kind: 'affects' } }),
  };
}

/** Stamp releaseDate + flip released; idempotent no-op when already released. */
export async function releaseVersion(id: string, releaseDate: string | undefined, actor: Actor, tx?: Tx) {
  const db = tx ?? prisma;
  const v = await db.version.findUnique({ where: { id }, include: { project: { select: { key: true } } } });
  if (!v) throw new JiraApiError(404, jiraError([`Version '${id}' does not exist.`], {}));
  if (v.released) return v;
  const updated = await db.version.update({
    where: { id },
    data: { released: true, releaseDate: releaseDate ? new Date(releaseDate) : new Date() },
    include: { project: { select: { key: true } } },
  });
  const counts = await versionIssueCounts(id);
  await emitEvent(db, actor, {
    type: 'jira:version_released',
    projectId: v.projectId,
    payload: { version: toVersionResponse(updated), counts },
  });
  return updated;
}

/** Release notes v1: done-category fix-versioned issues grouped by issue type. */
export async function releaseNotes(versionId: string) {
  const v = await prisma.version.findUnique({
    where: { id: versionId },
    include: { project: { select: { key: true, name: true } } },
  });
  if (!v) throw new JiraApiError(404, jiraError([`Version '${versionId}' does not exist.`], {}));
  const refs = await prisma.issueVersion.findMany({
    where: { versionId, kind: 'fix', issue: { status: { category: RESOLVED_CATEGORY } } },
    include: { issue: { include: { issueType: true, status: true, project: { select: { key: true } } } } },
    orderBy: { issue: { issueNumber: 'asc' } },
  });
  const byType = new Map<string, { key: string; summary: string }[]>();
  for (const r of refs) {
    const t = r.issue.issueType.name;
    const arr = byType.get(t) ?? [];
    arr.push({ key: `${r.issue.project.key}-${r.issue.issueNumber}`, summary: r.issue.summary });
    byType.set(t, arr);
  }
  return {
    version: toVersionResponse(v),
    project: v.project,
    groups: [...byType.entries()].map(([type, issues]) => ({ type, issues })),
  };
}

/* --------------------------- issue field writes ------------------------- */

type Ref = { id?: string; name?: string } | string;

async function resolveComponentRef(projectId: string, ref: Ref) {
  const where =
    typeof ref === 'string' ? { OR: [{ id: ref }, { name: ref }] } : ref.id ? { id: ref.id } : { name: ref.name! };
  const c = await prisma.component.findFirst({ where: { ...where, projectId } as never });
  if (!c)
    throw new JiraApiError(
      400,
      jiraError([], {
        components: `Component '${typeof ref === 'string' ? ref : (ref.id ?? ref.name)}' does not exist in this project.`,
      })
    );
  return c;
}

async function resolveVersionRef(projectId: string, ref: Ref) {
  const where =
    typeof ref === 'string' ? { OR: [{ id: ref }, { name: ref }] } : ref.id ? { id: ref.id } : { name: ref.name! };
  const v = await prisma.version.findFirst({ where: { ...where, projectId } as never });
  if (!v)
    throw new JiraApiError(
      400,
      jiraError([], {
        versions: `Version '${typeof ref === 'string' ? ref : (ref.id ?? ref.name)}' does not exist in this project.`,
      })
    );
  return v;
}

export async function resolveComponentRefs(projectId: string, refs: Ref[] | undefined) {
  if (!refs?.length) return [] as { id: string; name: string }[];
  return Promise.all(refs.map((r) => resolveComponentRef(projectId, r)));
}

export async function resolveVersionRefs(projectId: string, refs: Ref[] | undefined) {
  if (!refs?.length) return [] as { id: string; name: string }[];
  return Promise.all(refs.map((r) => resolveVersionRef(projectId, r)));
}

/** Diff-aware join sync. `ops` are Jira update-form {set?, add?, remove?}; when
 *  `set` is present it wins (Jira treats set as replace). Returns changelog
 *  items for fields.components / Fix Version/s / Affects Version/s. */
export async function syncIssueCollections(
  tx: Tx,
  issueId: string,
  projectId: string,
  input: {
    components?: { set?: Ref[]; add?: Ref[]; remove?: Ref[] };
    fixVersions?: { set?: Ref[]; add?: Ref[]; remove?: Ref[] };
    affectsVersions?: { set?: Ref[]; add?: Ref[]; remove?: Ref[] };
  },
  items: { field: string; fromString?: string | null; toString?: string | null }[]
) {
  for (const [kind, fieldLabel, resolver, model] of [
    ['components', 'Component', resolveComponentRef, 'issueComponent'],
    ['fixVersions', 'Fix Version/s', resolveVersionRef, 'issueVersion'],
    ['affectsVersions', 'Affects Version/s', resolveVersionRef, 'issueVersion'],
  ] as const) {
    const ops = input[kind as 'components' | 'fixVersions' | 'affectsVersions'];
    if (!ops) continue;
    const vKind = kind === 'components' ? null : kind === 'fixVersions' ? 'fix' : 'affects';
    const current =
      model === 'issueComponent'
        ? await tx.issueComponent
            .findMany({ where: { issueId }, include: { component: true } })
            .then((rs) => rs.map((r) => ({ id: r.componentId, name: r.component.name })))
        : await tx.issueVersion
            .findMany({ where: { issueId, kind: vKind! }, include: { version: true } })
            .then((rs) => rs.map((r) => ({ id: r.versionId, name: r.version.name })));

    let next: { id: string; name: string }[];
    if (ops.set !== undefined) {
      next = await Promise.all(ops.set.map((r) => resolver(projectId, r)));
    } else {
      const add = ops.add?.length ? await Promise.all(ops.add.map((r) => resolver(projectId, r))) : [];
      const removeIds = new Set(
        ops.remove?.length ? (await Promise.all(ops.remove.map((r) => resolver(projectId, r)))).map((x) => x.id) : []
      );
      const merged = [...current];
      for (const a of add) if (!merged.some((m) => m.id === a.id)) merged.push(a);
      next = merged.filter((m) => !removeIds.has(m.id));
    }

    const curIds = new Set(current.map((c) => c.id));
    const nextIds = new Set(next.map((n) => n.id));
    const added = next.filter((n) => !curIds.has(n.id));
    const removed = current.filter((c) => !nextIds.has(c.id));
    if (!added.length && !removed.length) continue;

    if (model === 'issueComponent') {
      if (removed.length) {
        await tx.issueComponent.deleteMany({ where: { issueId, componentId: { in: removed.map((r) => r.id) } } });
      }
      for (const a of added) {
        await tx.issueComponent.create({ data: { issueId, componentId: a.id } });
      }
    } else {
      if (removed.length) {
        await tx.issueVersion.deleteMany({
          where: { issueId, kind: vKind!, versionId: { in: removed.map((r) => r.id) } },
        });
      }
      for (const a of added) {
        await tx.issueVersion.create({ data: { issueId, versionId: a.id, kind: vKind! } });
      }
    }
    items.push({
      field: fieldLabel,
      fromString: current.map((c) => c.name).join(' ') || null,
      toString: next.map((n) => n.name).join(' ') || null,
    });
  }
}

/** Jira default-assignee resolution (FR-003): if no explicit assignee and a
 *  selected component declares a default, that wins. Order of precedence
 *  across multiple components = first match in input order. */
export async function defaultAssigneeFromComponents(
  projectId: string,
  components: { id: string }[]
): Promise<{ id: string; displayName: string; type: string } | null> {
  if (!components.length) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, include: { lead: true } });
    return p?.lead ?? null;
  }
  const comps = await prisma.component.findMany({
    where: { id: { in: components.map((c) => c.id) } },
    include: { lead: true },
  });
  const byId = new Map(comps.map((c) => [c.id, c]));
  for (const ref of components) {
    const c = byId.get(ref.id);
    if (!c) continue;
    if (c.assigneeType === 'COMPONENT_LEAD' && c.lead) return c.lead;
    if (c.assigneeType === 'PROJECT_LEAD') {
      const p = await prisma.project.findUnique({ where: { id: projectId }, include: { lead: true } });
      if (p?.lead) return p.lead;
    }
    if (c.assigneeType === 'UNASSIGNED') return null;
    if (c.assigneeType === 'PROJECT_DEFAULT') {
      const p = await prisma.project.findUnique({ where: { id: projectId }, include: { lead: true } });
      if (p?.lead) return p.lead;
      return null;
    }
  }
  return null;
}

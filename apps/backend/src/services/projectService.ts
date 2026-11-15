import { invalidateJqlCtxCache } from '../jql/ctxCache.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { toStatusCategory } from './metaService.js';
import { resourceSelf } from '../lib/http.js';

export async function createProject(data: {
  key: string;
  name: string;
  description?: string;
  projectTypeKey?: string;
  projectTemplateKey?: string;
  categoryId?: string | null;
}) {
  const existing = await prisma.project.findUnique({ where: { key: data.key } });
  if (existing) {
    throw new JiraApiError(400, jiraError([], { key: 'A project with that key already exists.' }));
  }
  if (data.categoryId) {
    const cat = await prisma.projectCategory.findUnique({ where: { id: data.categoryId } });
    if (!cat) throw new JiraApiError(400, jiraError([], { categoryId: 'Project category not found.' }));
  }

  const simple = await prisma.workflow.findUnique({ where: { name: 'Simple' } });
  invalidateJqlCtxCache();
  const project = await prisma.project.create({
    data: {
      key: data.key,
      name: data.name,
      description: data.description,
      projectType: data.projectTypeKey ?? 'software',
      workflowId: simple?.id,
      categoryId: data.categoryId ?? null,
    },
  });
  const { ensureProjectBoard, seedPermissionDefaults } = await import('../seed.js');
  const board = await ensureProjectBoard(project.id);
  // 021 — projectTemplateKey: 'scrum' seeds a scrum board; kanban/basic → kanban.
  if (board && data.projectTemplateKey?.toLowerCase().includes('scrum')) {
    await prisma.board.update({ where: { id: board.id }, data: { type: 'scrum' } });
  }
  // Wire the new project into the permission model (015): default scheme +
  // group actors + lead in Administrators.
  await seedPermissionDefaults();
  return project;
}

/** Jira GET /project/{key}/statuses — statuses per issue type for the project's workflow. */
export async function getProjectStatuses(key: string) {
  const project = await getProjectByKey(key);
  const { getProjectWorkflow } = await import('./workflowService.js');
  const wf = await getProjectWorkflow(project.id);
  const issueTypes = await prisma.issueType.findMany({ orderBy: { hierarchyLevel: 'desc' } });
  const statuses = wf.statuses.map((ws) => ({
    id: ws.statusId,
    name: ws.status.name,
    statusCategory: toStatusCategory(ws.status.category),
  }));
  return issueTypes.map((t) => ({
    id: t.id,
    name: t.name,
    statuses,
    subtask: t.isSubtask,
  }));
}

/** 062 US4 — types usable in this project (Jira `GET /project/{key}` issueTypes).
 * Scheme-bound projects get the scheme's ordered types; unbound projects fall
 * back to every type — matching createmeta's global list. */
export async function projectIssueTypes(project: { issueTypeSchemeId?: string | null }) {
  if (project.issueTypeSchemeId) {
    const items = await prisma.issueTypeSchemeItem.findMany({
      where: { schemeId: project.issueTypeSchemeId },
      orderBy: { position: 'asc' },
      include: { issueType: true },
    });
    return items.map((it) => ({
      id: it.issueType.id,
      name: it.issueType.name,
      description: it.issueType.description ?? undefined,
      subtask: it.issueType.isSubtask,
      hierarchyLevel: it.issueType.hierarchyLevel,
    }));
  }
  const types = await prisma.issueType.findMany({ orderBy: [{ hierarchyLevel: 'desc' }, { name: 'asc' }] });
  return types.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? undefined,
    subtask: t.isSubtask,
    hierarchyLevel: t.hierarchyLevel,
  }));
}

export async function listProjects(opts: { includeArchived?: boolean; categoryId?: string } = {}) {
  return prisma.project.findMany({
    where: {
      ...(opts.includeArchived ? {} : { archived: false }),
      ...(opts.categoryId ? { categoryId: opts.categoryId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    include: { category: true, lead: true },
  });
}

/** 065 US4 — lean findUnique+404 used across ~10 services; key is normalized
 *  to uppercase. The message stays deliberately ambiguous (existence-hiding). */
export async function projectByKeyOr404(key: string) {
  const project = await prisma.project.findUnique({ where: { key: key.toUpperCase() } });
  if (!project) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  return project;
}

export async function getProjectByKey(key: string) {
  const project = await prisma.project.findUnique({
    where: { key },
    include: { lead: true, workflow: true, category: true },
  });
  if (!project) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  return project;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  leadAccountId?: string | null;
  avatarColor?: string | null;
  aiEnabled?: boolean;
  agentGuidance?: string | null; // 047 US4-3 — project-scoped agent instructions
  categoryId?: string | null;
}

export async function updateProject(key: string, data: UpdateProjectInput) {
  const project = await getProjectByKey(key);
  let leadId: string | null | undefined;
  if (data.leadAccountId !== undefined) {
    if (data.leadAccountId === null) {
      leadId = null;
    } else {
      const lead = await prisma.user.findFirst({
        where: { OR: [{ id: data.leadAccountId }, { email: data.leadAccountId }] },
      });
      if (!lead) {
        throw new JiraApiError(400, jiraError([], { lead: 'Lead user not found.' }));
      }
      leadId = lead.id;
    }
  }
  if (data.categoryId) {
    const cat = await prisma.projectCategory.findUnique({ where: { id: data.categoryId } });
    if (!cat) throw new JiraApiError(400, jiraError([], { categoryId: 'Project category not found.' }));
  }
  invalidateJqlCtxCache();
  return prisma.project.update({
    where: { id: project.id },
    data: {
      name: data.name,
      description: data.description,
      avatarColor: data.avatarColor,
      aiEnabled: data.aiEnabled,
      ...(data.agentGuidance !== undefined ? { agentGuidance: data.agentGuidance } : {}),
      leadId,
      ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
    },
    include: { lead: true, category: true },
  });
}

// 021 — Jira archive/restore. Archived projects are read-only and hidden
// from project lists unless includeArchived is requested.
export async function archiveProject(key: string) {
  const project = await getProjectByKey(key);
  if (project.archived) throw new JiraApiError(400, jiraError([], { project: 'Project is already archived.' }));
  invalidateJqlCtxCache();
  return prisma.project.update({ where: { id: project.id }, data: { archived: true }, include: { category: true } });
}

export async function restoreProject(key: string) {
  const project = await getProjectByKey(key);
  if (!project.archived) throw new JiraApiError(400, jiraError([], { project: 'Project is not archived.' }));
  invalidateJqlCtxCache();
  return prisma.project.update({ where: { id: project.id }, data: { archived: false }, include: { category: true } });
}

/** Throws when the project is archived — call before any project-scoped write. */
export async function assertProjectWritable(projectId: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { archived: true, key: true } });
  if (p?.archived) {
    throw new JiraApiError(403, jiraError([], { project: `Project ${p.key} is archived (read-only).` }));
  }
}

/** 060 US7 — project-write guard + Jira DC archived-issue write gate in one
    call. Mutating issue paths use this instead of assertProjectWritable so
    archived issues are read-only even when reached via bulk/secondary ops. */
export async function assertIssueWritable(issue: { projectId: string; archived?: boolean }) {
  await assertProjectWritable(issue.projectId);
  if (issue.archived) {
    throw new JiraApiError(400, jiraError(['Issue is archived — restore it before making changes.']));
  }
}

export async function deleteProject(key: string) {
  const project = await getProjectByKey(key);
  const issueCount = await prisma.issue.count({ where: { projectId: project.id } });
  await prisma.$transaction(async (tx) => {
    const ids = (await tx.issue.findMany({ where: { projectId: project.id }, select: { id: true } })).map((i) => i.id);
    if (ids.length) {
      const histories = await tx.changeHistory.findMany({ where: { issueId: { in: ids } }, select: { id: true } });
      await tx.changeItem.deleteMany({ where: { historyId: { in: histories.map((h) => h.id) } } });
      await tx.changeHistory.deleteMany({ where: { issueId: { in: ids } } });
      // Other projects' issues may link INTO this project's issues — drop those links.
      await tx.issueLink.deleteMany({ where: { OR: [{ outwardId: { in: ids } }, { inwardId: { in: ids } }] } });
      await tx.issue.updateMany({ where: { parentId: { in: ids } }, data: { parentId: null } });
      await tx.issue.deleteMany({ where: { projectId: project.id } });
    }
    await tx.sprint.deleteMany({ where: { projectId: project.id } });
    invalidateJqlCtxCache();
    await tx.project.delete({ where: { id: project.id } });
  });
  return { key, deletedIssues: issueCount };
}

export function toProjectResponse(project: {
  id: string;
  key: string;
  name: string;
  description: string | null;
  projectType: string;
  avatarColor?: string | null;
  archived?: boolean;
  categoryId?: string | null;
  category?: { id: string; name: string; description: string | null } | null;
  lead?: { id: string; displayName: string; email: string } | null;
  workflow?: { id: string; name: string } | null;
  issueSecuritySchemeId?: string | null;
  issueTypeScreenSchemeId?: string | null;
  fieldConfigurationSchemeId?: string | null;
  issueTypeSchemeId?: string | null;
  workflowSchemeId?: string | null;
  notificationSchemeId?: string | null;
  permissionSchemeId?: string | null;
  agentGuidance?: string | null;
}) {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description ?? undefined,
    projectTypeKey: project.projectType,
    avatarColor: project.avatarColor ?? undefined,
    archived: project.archived ?? false,
    projectCategory: project.category
      ? { id: project.category.id, name: project.category.name, description: project.category.description ?? undefined }
      : undefined,
    lead: project.lead
      ? { accountId: project.lead.id, displayName: project.lead.displayName, emailAddress: project.lead.email }
      : undefined,
    workflow: project.workflow ? { id: project.workflow.id, name: project.workflow.name } : undefined,
    agentGuidance: project.agentGuidance ?? null,
    // 031 TF-native: which schemes are bound to this project (null = unbound)
    schemeIds: {
      issueSecurity: project.issueSecuritySchemeId ?? null,
      issueTypeScreen: project.issueTypeScreenSchemeId ?? null,
      fieldConfiguration: project.fieldConfigurationSchemeId ?? null,
      issueType: project.issueTypeSchemeId ?? null,
      workflow: project.workflowSchemeId ?? null,
      notification: project.notificationSchemeId ?? null,
      permission: project.permissionSchemeId ?? null,
    },
    self: resourceSelf(`/rest/api/2/project/${project.key}`),
  };
}

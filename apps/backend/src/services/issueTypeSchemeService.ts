// Sprint 031 (US3) — issue type schemes: which issue types a project offers.
// A project with no bound scheme offers all issue types (pre-031 behavior).
// Bound schemes restrict createmeta listings AND create-time writes.
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';

/** Issue types a project offers — all types when no scheme is bound. */
export async function typesForProject(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { issueTypeSchemeId: true },
  });
  if (!project?.issueTypeSchemeId) {
    return prisma.issueType.findMany({ orderBy: { hierarchyLevel: 'desc' } });
  }
  const items = await prisma.issueTypeSchemeItem.findMany({
    where: { schemeId: project.issueTypeSchemeId },
    orderBy: { position: 'asc' },
    include: { issueType: true },
  });
  return items.map((i) => i.issueType);
}

/**
 * Create-time gate: reject issue types outside the project's scheme with
 * Jira's canonical `The issue type selected is invalid.` error.
 */
export async function assertIssueTypeAllowed(projectId: string, issueType: { id: string; name: string }) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { issueTypeSchemeId: true },
  });
  if (!project?.issueTypeSchemeId) return;
  const inScheme = await prisma.issueTypeSchemeItem.findFirst({
    where: { schemeId: project.issueTypeSchemeId, issueTypeId: issueType.id },
  });
  if (!inScheme) {
    throw new JiraApiError(400, jiraError([], { issuetype: 'The issue type selected is invalid.' }));
  }
}

// ---------- admin CRUD ----------

const itemInclude = {
  items: {
    orderBy: { position: 'asc' as const },
    include: { issueType: { select: { id: true, name: true, isSubtask: true } } },
  },
};

export async function listSchemes() {
  const schemes = await prisma.issueTypeScheme.findMany({
    include: { ...itemInclude, _count: { select: { projects: true } } },
    orderBy: { name: 'asc' },
  });
  return schemes.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    issueTypeIds: s.items.map((i) => i.issueTypeId),
    issueTypes: s.items.map((i) => i.issueType),
    projectsUsed: s._count.projects,
  }));
}

export async function createScheme(input: { name: string; description?: string; issueTypeIds?: string[] }) {
  const scheme = await prisma.issueTypeScheme.create({
    data: {
      name: input.name,
      description: input.description,
      items: {
        create: (input.issueTypeIds ?? []).map((t, i) => ({ issueTypeId: t, position: i })),
      },
    },
    include: itemInclude,
  });
  return { id: scheme.id, name: scheme.name, issueTypeIds: scheme.items.map((i) => i.issueTypeId) };
}

export async function updateScheme(
  id: string,
  input: { name?: string; description?: string; issueTypeIds?: string[] }
) {
  const existing = await prisma.issueTypeScheme.findUnique({ where: { id } });
  if (!existing) throw new JiraApiError(404, jiraError(['Issue type scheme not found.']));
  if (input.issueTypeIds) {
    await prisma.issueTypeSchemeItem.deleteMany({ where: { schemeId: id } });
    await prisma.issueTypeSchemeItem.createMany({
      data: input.issueTypeIds.map((t, i) => ({ schemeId: id, issueTypeId: t, position: i })),
    });
  }
  await prisma.issueTypeScheme.update({
    where: { id },
    data: { name: input.name, description: input.description },
  });
  return { id };
}

export async function deleteScheme(id: string) {
  const used = await prisma.project.count({ where: { issueTypeSchemeId: id } });
  if (used > 0) {
    throw new JiraApiError(400, jiraError([`Issue type scheme is associated with ${used} project(s).`]));
  }
  await prisma.issueTypeScheme.delete({ where: { id } });
}

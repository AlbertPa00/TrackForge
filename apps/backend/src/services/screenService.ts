// Sprint 031 — screens, tabs, screen schemes, issue-type screen schemes (US1).
// Jira resolution chain: project.issueTypeScreenScheme →
//   mapping[issueType] ?? defaultScheme → ScreenScheme.items[op ?? 'default']
//   → Screen → tabs → ordered field ids.
//
// Enforcement is opt-in: a project with NO issue-type screen scheme is
// unrestricted (pre-sprint behaviour). Once bound, the resolved screen's
// field set gates createmeta/editmeta output AND issue writes with Jira's
// canonical "cannot be set" error.

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import type { Prisma } from '../lib/pc.js';
import { projectByKeyOr404 } from './projectService.js';

export type ScreenOp = 'create' | 'edit' | 'view';
const OPS = ['create', 'edit', 'view', 'default'] as const;

// --------------------------- resolution ---------------------------

const screenInclude = {
  tabs: {
    orderBy: { position: 'asc' as const },
    include: { fields: { orderBy: { position: 'asc' as const } } },
  },
} as const;

/** Ordered registry field ids for a resolved screen (deduped across tabs). */
function screenFieldKeys(screen: { tabs: { fields: { fieldId: string }[] }[] }): Set<string> {
  const keys = new Set<string>();
  for (const t of screen.tabs) for (const f of t.fields) keys.add(f.fieldId);
  return keys;
}

/**
 * Resolve the field set for (project, issueType, op).
 * Returns null when the project binds no ITSS or resolution finds no screen —
 * callers treat null as "unrestricted" (default behaviour, SC).
 */
export async function screenFieldSet(
  projectId: string,
  issueTypeId: string | null,
  op: ScreenOp
): Promise<Set<string> | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { issueTypeScreenSchemeId: true },
  });
  if (!project?.issueTypeScreenSchemeId) return null;
  const itss = await prisma.issueTypeScreenScheme.findUnique({
    where: { id: project.issueTypeScreenSchemeId },
    include: { mappings: true },
  });
  if (!itss) return null;
  const mapped = issueTypeId ? itss.mappings.find((m) => m.issueTypeId === issueTypeId) : undefined;
  const schemeId = mapped?.screenSchemeId ?? itss.defaultSchemeId;
  if (!schemeId) return null;
  // exact op item wins; 'default' is the fallback (Jira semantics)
  const findItem = (operation: string) =>
    prisma.screenSchemeItem.findFirst({
      where: { schemeId, operation },
      include: { screen: { include: screenInclude } },
    });
  const item = (await findItem(op)) ?? (await findItem('default'));
  if (!item) return null;
  return screenFieldKeys(item.screen);
}

/** Fields never gated by screens (Jira keeps these implicit on create/edit). */
const ALWAYS_ALLOWED = new Set(['project', 'summary', 'issuetype', 'parent']);

/**
 * Throw Jira's canonical screen error for every provided field key that is
 * absent from the resolved screen. No-op when unrestricted.
 */
export async function assertScreenFieldsAllowed(
  projectId: string,
  issueTypeId: string | null,
  op: ScreenOp,
  providedKeys: string[]
): Promise<void> {
  const allowed = await screenFieldSet(projectId, issueTypeId, op);
  if (allowed === null) return;
  const errors: Record<string, string> = {};
  for (const k of new Set(providedKeys)) {
    if (ALWAYS_ALLOWED.has(k)) continue;
    if (!allowed.has(k)) {
      errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
    }
  }
  if (Object.keys(errors).length) throw new JiraApiError(400, jiraError([], errors));
}

// ------------------------------ CRUD -------------------------------

export async function listScreens() {
  return prisma.screen.findMany({ include: screenInclude, orderBy: { name: 'asc' } });
}

export async function createScreen(input: {
  name: string;
  description?: string;
  tabs?: { name: string; fields?: string[] }[];
}) {
  return prisma.screen.create({
    data: {
      name: input.name,
      description: input.description,
      tabs: {
        create: (input.tabs ?? [{ name: 'Tab 1', fields: [] }]).map((t, i) => ({
          name: t.name,
          position: i,
          fields: { create: (t.fields ?? []).map((f, j) => ({ fieldId: f, position: j })) },
        })),
      },
    },
    include: screenInclude,
  });
}

export async function updateScreen(id: string, input: { name?: string; description?: string }) {
  const s = await prisma.screen.findUnique({ where: { id } });
  if (!s) throw new JiraApiError(404, jiraError(['Screen does not exist.']));
  return prisma.screen.update({ where: { id }, data: input });
}

export async function deleteScreen(id: string) {
  const s = await prisma.screen.findUnique({
    where: { id },
    include: { _count: { select: { items: true } } },
  });
  if (!s) throw new JiraApiError(404, jiraError(['Screen does not exist.']));
  if (s._count.items > 0) {
    throw new JiraApiError(400, jiraError(['Screen is in use by a screen scheme — remove the mapping first.']));
  }
  await prisma.screen.delete({ where: { id } });
}

export async function setScreenTabs(screenId: string, tabs: { name: string; fields?: string[] }[]) {
  const s = await prisma.screen.findUnique({ where: { id: screenId } });
  if (!s) throw new JiraApiError(404, jiraError(['Screen does not exist.']));
  await prisma.$transaction(async (tx) => {
    await tx.screenTab.deleteMany({ where: { screenId } });
    for (const [i, t] of tabs.entries()) {
      await tx.screenTab.create({
        data: {
          screenId,
          name: t.name,
          position: i,
          fields: { create: (t.fields ?? []).map((f, j) => ({ fieldId: f, position: j })) },
        },
      });
    }
  });
  return prisma.screen.findUnique({ where: { id: screenId }, include: screenInclude });
}

export async function listScreenSchemes() {
  return prisma.screenScheme.findMany({
    include: { items: { include: { screen: { select: { id: true, name: true } } } } },
    orderBy: { name: 'asc' },
  });
}

export async function createScreenScheme(input: {
  name: string;
  description?: string;
  items?: { operation: string; screenId: string }[];
}) {
  for (const it of input.items ?? []) {
    if (!OPS.includes(it.operation as (typeof OPS)[number])) {
      throw new JiraApiError(400, jiraError([`operation must be one of ${OPS.join('|')}`]));
    }
  }
  return prisma.screenScheme.create({
    data: {
      name: input.name,
      description: input.description,
      items: { create: (input.items ?? []).map((i) => ({ operation: i.operation, screenId: i.screenId })) },
    },
    include: { items: true },
  });
}

export async function updateScreenScheme(
  id: string,
  input: { name?: string; description?: string; items?: { operation: string; screenId: string }[] }
) {
  const s = await prisma.screenScheme.findUnique({ where: { id } });
  if (!s) throw new JiraApiError(404, jiraError(['Screen scheme does not exist.']));
  await prisma.$transaction(async (tx) => {
    await tx.screenScheme.update({
      where: { id },
      data: { name: input.name, description: input.description },
    });
    if (input.items) {
      for (const it of input.items) {
        if (!OPS.includes(it.operation as (typeof OPS)[number])) {
          throw new JiraApiError(400, jiraError([`operation must be one of ${OPS.join('|')}`]));
        }
      }
      await tx.screenSchemeItem.deleteMany({ where: { schemeId: id } });
      await tx.screenSchemeItem.createMany({
        data: input.items.map((i) => ({ schemeId: id, operation: i.operation, screenId: i.screenId })),
      });
    }
  });
  return prisma.screenScheme.findUnique({ where: { id }, include: { items: true } });
}

export async function deleteScreenScheme(id: string) {
  const s = await prisma.screenScheme.findUnique({
    where: { id },
    include: {
      _count: { select: { typeSchemeMappings: true, defaultForSchemes: true } },
    },
  });
  if (!s) throw new JiraApiError(404, jiraError(['Screen scheme does not exist.']));
  if (s._count.typeSchemeMappings + s._count.defaultForSchemes > 0) {
    throw new JiraApiError(400, jiraError(['Screen scheme is in use by an issue type screen scheme.']));
  }
  await prisma.screenScheme.delete({ where: { id } });
}

export async function listIssueTypeScreenSchemes() {
  return prisma.issueTypeScreenScheme.findMany({
    include: {
      defaultScheme: { select: { id: true, name: true } },
      mappings: {
        include: {
          screenScheme: { select: { id: true, name: true } },
          issueType: { select: { id: true, name: true } },
        },
      },
      _count: { select: { projects: true } },
    },
    orderBy: { name: 'asc' },
  });
}

export async function createIssueTypeScreenScheme(input: {
  name: string;
  description?: string;
  defaultSchemeId?: string | null;
  mappings?: { issueTypeId: string; screenSchemeId: string }[];
}) {
  return prisma.issueTypeScreenScheme.create({
    data: {
      name: input.name,
      description: input.description,
      defaultSchemeId: input.defaultSchemeId ?? null,
      mappings: {
        create: (input.mappings ?? []).map((m) => ({
          issueTypeId: m.issueTypeId,
          screenSchemeId: m.screenSchemeId,
        })),
      },
    },
    include: { mappings: true },
  });
}

export async function updateIssueTypeScreenScheme(
  id: string,
  input: {
    name?: string;
    description?: string;
    defaultSchemeId?: string | null;
    mappings?: { issueTypeId: string; screenSchemeId: string }[];
  }
) {
  const s = await prisma.issueTypeScreenScheme.findUnique({ where: { id } });
  if (!s) throw new JiraApiError(404, jiraError(['Issue type screen scheme does not exist.']));
  await prisma.$transaction(async (tx) => {
    const data: Prisma.IssueTypeScreenSchemeUpdateInput = {
      name: input.name,
      description: input.description,
    };
    if (input.defaultSchemeId !== undefined)
      data.defaultScheme = input.defaultSchemeId ? { connect: { id: input.defaultSchemeId } } : { disconnect: true };
    await tx.issueTypeScreenScheme.update({ where: { id }, data });
    if (input.mappings) {
      await tx.screenSchemeMapping.deleteMany({ where: { schemeId: id } });
      await tx.screenSchemeMapping.createMany({
        data: input.mappings.map((m) => ({
          schemeId: id,
          issueTypeId: m.issueTypeId,
          screenSchemeId: m.screenSchemeId,
        })),
      });
    }
  });
  return prisma.issueTypeScreenScheme.findUnique({ where: { id }, include: { mappings: true } });
}

export async function deleteIssueTypeScreenScheme(id: string) {
  const s = await prisma.issueTypeScreenScheme.findUnique({
    where: { id },
    include: { _count: { select: { projects: true } } },
  });
  if (!s) throw new JiraApiError(404, jiraError(['Issue type screen scheme does not exist.']));
  if (s._count.projects > 0) {
    throw new JiraApiError(400, jiraError([`Scheme still bound to ${s._count.projects} project(s).`]));
  }
  await prisma.issueTypeScreenScheme.delete({ where: { id } });
}

export async function assignIssueTypeScreenScheme(projectKey: string, schemeId: string | null) {
  const project = await projectByKeyOr404(projectKey);
  if (schemeId) {
    const s = await prisma.issueTypeScreenScheme.findUnique({ where: { id: schemeId } });
    if (!s) throw new JiraApiError(404, jiraError(['Issue type screen scheme does not exist.']));
  }
  return prisma.project.update({ where: { id: project.id }, data: { issueTypeScreenSchemeId: schemeId } });
}

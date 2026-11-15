import { prisma } from '../prisma.js';
import { FIELD_DEFS, FIELD_NAME_MAP, type FieldDef } from '../lib/systemFields.js';
import { allFields } from './fieldRegistry.js';

const CATEGORY_MAP: Record<string, { key: string; name: string }> = {
  todo: { key: 'new', name: 'To Do' },
  inprogress: { key: 'indeterminate', name: 'In Progress' },
  done: { key: 'done', name: 'Done' },
};

export function toStatusCategory(category: string) {
  return CATEGORY_MAP[category] ?? { key: 'new', name: 'To Do' };
}

export async function listStatuses() {
  const statuses = await prisma.status.findMany({ orderBy: { sequence: 'asc' } });
  return statuses.map((s) => ({
    id: s.id,
    name: s.name,
    statusCategory: toStatusCategory(s.category),
  }));
}

export async function listPriorities() {
  const priorities = await prisma.priority.findMany({ orderBy: { sequence: 'asc' } });
  return priorities.map((p) => ({
    id: p.id,
    name: p.name,
    statusColor: p.color ?? undefined,
  }));
}

export async function listIssueTypes() {
  const types = await prisma.issueType.findMany({
    orderBy: { hierarchyLevel: 'desc' },
  });
  return types.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description ?? '',
    subtask: t.isSubtask,
    hierarchyLevel: t.hierarchyLevel,
  }));
}

// ---- Field registry (system defs live in lib/systemFields; CFs from DB) ----

export { FIELD_DEFS, FIELD_NAME_MAP };
export type { FieldDef };

/** GET /rest/api/2/field — Jira field list incl. custom fields. */
export async function listFields() {
  const registry = await allFields();
  return registry.map((f, i) => ({
    id: f.id,
    name: f.name,
    custom: f.custom,
    orderable: f.orderable,
    navigable: f.navigable,
    searchable: f.searchable,
    clauseNames: f.clauseNames,
    schema: f.schema,
    untranslatedName: f.name,
    key: f.id,
    self: undefined,
    scope: undefined,
    order: i + 1,
  }));
}

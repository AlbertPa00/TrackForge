// Sprint 031 — field configurations & schemes (US2).
// Jira resolution chain: project.fieldConfigurationScheme →
//   mapping[issueType] ?? defaultConfig → items[fieldId].
//
// Item semantics per field: required (create must carry a value; edit may
// not clear), hidden (cannot be set / absent from meta), description,
// defaultValue (applied on create when unprovided), plus conditional
// rules evaluated against the issue's effective field values.
//
// Like screens, enforcement is opt-in: no scheme → unrestricted.

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import type { Prisma } from '../lib/pc.js';
import { Prisma as PrismaV } from '../lib/pc.js';
import { projectByKeyOr404 } from './projectService.js';

type Item = {
  fieldId: string;
  required: boolean;
  hidden: boolean;
  description: string | null;
  defaultValue: unknown;
  rules: unknown;
};

type Rule = {
  when?: { field: string; is?: unknown; in?: unknown[]; isNot?: unknown; empty?: boolean };
  required?: boolean;
  hidden?: boolean;
  defaultValue?: unknown;
};

/** Effective behaviour for one field under a value context (rules applied). */
export interface EffectiveField {
  required: boolean;
  hidden: boolean;
  description?: string;
  defaultValue?: unknown;
}

// --------------------------- resolution ---------------------------

export async function resolveFieldConfig(
  projectId: string,
  issueTypeId: string | null
): Promise<Map<string, Item> | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { fieldConfigurationSchemeId: true },
  });
  if (!project?.fieldConfigurationSchemeId) return null;
  const scheme = await prisma.fieldConfigurationScheme.findUnique({
    where: { id: project.fieldConfigurationSchemeId },
    include: { mappings: true },
  });
  if (!scheme) return null;
  const mapped = issueTypeId ? scheme.mappings.find((m) => m.issueTypeId === issueTypeId) : undefined;
  const configId = mapped?.configId ?? scheme.defaultConfigId;
  if (!configId) return null;
  const items = await prisma.fieldConfigurationItem.findMany({ where: { configId } });
  return new Map(items.map((i) => [i.fieldId, i]));
}

// --------------------------- rule engine ---------------------------

function norm(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map((x) => norm(x)).join(',');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.name ?? o.id ?? o.value ?? JSON.stringify(v));
  }
  return String(v);
}

function ruleMatches(when: NonNullable<Rule['when']>, ctx: Record<string, unknown>): boolean {
  const val = ctx[when.field];
  if (when.empty !== undefined) {
    const isEmpty = val === null || val === undefined || val === '' || (Array.isArray(val) && !val.length);
    return isEmpty === when.empty;
  }
  if (when.is !== undefined) {
    if (Array.isArray(val)) return val.some((x) => norm(x) === norm(when.is));
    return norm(val) === norm(when.is);
  }
  if (when.in !== undefined) {
    const set = new Set(when.in.map(norm));
    if (Array.isArray(val)) return val.some((x) => set.has(norm(x)));
    return set.has(norm(val));
  }
  if (when.isNot !== undefined) return norm(val) !== norm(when.isNot);
  return false;
}

/** Base item + conditional rules → effective flags for the given values. */
export function effectiveField(item: Item | undefined, ctx: Record<string, unknown>): EffectiveField | null {
  if (!item) return null;
  const eff: EffectiveField = {
    required: item.required,
    hidden: item.hidden,
    description: item.description ?? undefined,
    defaultValue: item.defaultValue ?? undefined,
  };
  for (const r of (item.rules as Rule[] | null) ?? []) {
    if (r.when && ruleMatches(r.when, ctx)) {
      if (r.required !== undefined) eff.required = r.required;
      if (r.hidden !== undefined) eff.hidden = r.hidden;
      if (r.defaultValue !== undefined) eff.defaultValue = r.defaultValue;
    }
  }
  return eff;
}

// ------------------------- write enforcement -------------------------

/**
 * Create-path check. `provided` = client-supplied registry ids;
 * `ctx` = effective values AFTER defaults are applied.
 * Throws hidden→cannot-be-set and required-but-empty errors.
 */
export async function assertFieldConfigCreate(
  projectId: string,
  issueTypeId: string,
  provided: string[],
  ctx: Record<string, unknown>
): Promise<void> {
  const items = await resolveFieldConfig(projectId, issueTypeId);
  if (!items) return;
  const errors: Record<string, string> = {};
  for (const k of provided) {
    const eff = effectiveField(items.get(k), ctx);
    if (eff?.hidden) {
      errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
    }
  }
  for (const [fieldId, item] of items) {
    const eff = effectiveField(item, ctx);
    if (!eff?.required) continue;
    const v = ctx[fieldId];
    const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (empty) errors[fieldId] = `${itemName(item)} is required.`;
  }
  if (Object.keys(errors).length) throw new JiraApiError(400, jiraError([], errors));
}

function itemName(item: Item) {
  return `Field '${item.fieldId}'`;
}

/**
 * Edit-path check. Hidden fields may not be set at all; required fields
 * may not be cleared. `provided` maps fieldId → incoming value.
 */
export async function assertFieldConfigEdit(
  projectId: string,
  issueTypeId: string,
  provided: Map<string, unknown>,
  ctx: Record<string, unknown>
): Promise<void> {
  const items = await resolveFieldConfig(projectId, issueTypeId);
  if (!items) return;
  const errors: Record<string, string> = {};
  for (const [k, v] of provided) {
    const eff = effectiveField(items.get(k), ctx);
    if (eff?.hidden) {
      errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
    } else if (eff?.required && (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length))) {
      errors[k] = `Field '${k}' is required.`;
    }
  }
  if (Object.keys(errors).length) throw new JiraApiError(400, jiraError([], errors));
}

/** Field-id → value map used by create/update paths for rule eval + required checks. */
export async function fieldConfigDefaults(
  projectId: string,
  issueTypeId: string,
  providedKeys: Set<string>,
  ctx: Record<string, unknown>
): Promise<Map<string, unknown>> {
  const items = await resolveFieldConfig(projectId, issueTypeId);
  const out = new Map<string, unknown>();
  if (!items) return out;
  for (const [fieldId, item] of items) {
    if (providedKeys.has(fieldId)) continue;
    const eff = effectiveField(item, ctx);
    if (eff && !eff.hidden && eff.defaultValue !== undefined && eff.defaultValue !== null) {
      out.set(fieldId, eff.defaultValue);
    }
  }
  return out;
}

// ------------------------------ CRUD -------------------------------

export type FieldConfigItemInput = {
  fieldId: string;
  required?: boolean;
  hidden?: boolean;
  description?: string;
  defaultValue?: unknown;
  rules?: Rule[];
};

export async function listFieldConfigurations() {
  return prisma.fieldConfiguration.findMany({
    include: { items: { orderBy: { fieldId: 'asc' } } },
    orderBy: { name: 'asc' },
  });
}

export async function createFieldConfiguration(input: {
  name: string;
  description?: string;
  items?: FieldConfigItemInput[];
}) {
  return prisma.fieldConfiguration.create({
    data: {
      name: input.name,
      description: input.description,
      items: {
        create: (input.items ?? []).map((i) => ({
          fieldId: i.fieldId,
          required: i.required ?? false,
          hidden: i.hidden ?? false,
          description: i.description ?? null,
          defaultValue: i.defaultValue === undefined ? undefined : (i.defaultValue as Prisma.InputJsonValue),
          rules: i.rules === undefined ? undefined : (i.rules as unknown as Prisma.InputJsonValue),
        })),
      },
    },
    include: { items: true },
  });
}

export async function updateFieldConfiguration(
  id: string,
  input: { name?: string; description?: string; items?: FieldConfigItemInput[] }
) {
  const c = await prisma.fieldConfiguration.findUnique({ where: { id } });
  if (!c) throw new JiraApiError(404, jiraError(['Field configuration does not exist.']));
  await prisma.$transaction(async (tx) => {
    await tx.fieldConfiguration.update({
      where: { id },
      data: { name: input.name, description: input.description },
    });
    if (input.items) {
      await tx.fieldConfigurationItem.deleteMany({ where: { configId: id } });
      await tx.fieldConfigurationItem.createMany({
        data: input.items.map((i) => ({
          configId: id,
          fieldId: i.fieldId,
          required: i.required ?? false,
          hidden: i.hidden ?? false,
          description: i.description ?? null,
          defaultValue: i.defaultValue === undefined ? PrismaV.DbNull : (i.defaultValue as Prisma.InputJsonValue),
          rules: i.rules === undefined ? PrismaV.DbNull : (i.rules as unknown as Prisma.InputJsonValue),
        })),
      });
    }
  });
  return prisma.fieldConfiguration.findUnique({ where: { id }, include: { items: true } });
}

export async function deleteFieldConfiguration(id: string) {
  const c = await prisma.fieldConfiguration.findUnique({
    where: { id },
    include: { _count: { select: { schemeMappings: true, defaultForSchemes: true } } },
  });
  if (!c) throw new JiraApiError(404, jiraError(['Field configuration does not exist.']));
  if (c._count.schemeMappings + c._count.defaultForSchemes > 0) {
    throw new JiraApiError(400, jiraError(['Field configuration is in use by a scheme.']));
  }
  await prisma.fieldConfiguration.delete({ where: { id } });
}

export async function listFieldConfigurationSchemes() {
  return prisma.fieldConfigurationScheme.findMany({
    include: {
      defaultConfig: { select: { id: true, name: true } },
      mappings: {
        include: { config: { select: { id: true, name: true } }, issueType: { select: { id: true, name: true } } },
      },
      _count: { select: { projects: true } },
    },
    orderBy: { name: 'asc' },
  });
}

export async function createFieldConfigurationScheme(input: {
  name: string;
  description?: string;
  defaultConfigId?: string | null;
  mappings?: { issueTypeId: string; configId: string }[];
}) {
  return prisma.fieldConfigurationScheme.create({
    data: {
      name: input.name,
      description: input.description,
      defaultConfigId: input.defaultConfigId ?? null,
      mappings: {
        create: (input.mappings ?? []).map((m) => ({ issueTypeId: m.issueTypeId, configId: m.configId })),
      },
    },
    include: { mappings: true },
  });
}

export async function updateFieldConfigurationScheme(
  id: string,
  input: {
    name?: string;
    description?: string;
    defaultConfigId?: string | null;
    mappings?: { issueTypeId: string; configId: string }[];
  }
) {
  const s = await prisma.fieldConfigurationScheme.findUnique({ where: { id } });
  if (!s) throw new JiraApiError(404, jiraError(['Field configuration scheme does not exist.']));
  await prisma.$transaction(async (tx) => {
    const data: Prisma.FieldConfigurationSchemeUpdateInput = {
      name: input.name,
      description: input.description,
    };
    if (input.defaultConfigId !== undefined) {
      data.defaultConfig = input.defaultConfigId ? { connect: { id: input.defaultConfigId } } : { disconnect: true };
    }
    await tx.fieldConfigurationScheme.update({ where: { id }, data });
    if (input.mappings) {
      await tx.fieldConfigMapping.deleteMany({ where: { schemeId: id } });
      await tx.fieldConfigMapping.createMany({
        data: input.mappings.map((m) => ({ schemeId: id, issueTypeId: m.issueTypeId, configId: m.configId })),
      });
    }
  });
  return prisma.fieldConfigurationScheme.findUnique({ where: { id }, include: { mappings: true } });
}

export async function deleteFieldConfigurationScheme(id: string) {
  const s = await prisma.fieldConfigurationScheme.findUnique({
    where: { id },
    include: { _count: { select: { projects: true } } },
  });
  if (!s) throw new JiraApiError(404, jiraError(['Field configuration scheme does not exist.']));
  if (s._count.projects > 0) {
    throw new JiraApiError(400, jiraError([`Scheme still bound to ${s._count.projects} project(s).`]));
  }
  await prisma.fieldConfigurationScheme.delete({ where: { id } });
}

export async function assignFieldConfigurationScheme(projectKey: string, schemeId: string | null) {
  const project = await projectByKeyOr404(projectKey);
  if (schemeId) {
    const s = await prisma.fieldConfigurationScheme.findUnique({ where: { id: schemeId } });
    if (!s) throw new JiraApiError(404, jiraError(['Field configuration scheme does not exist.']));
  }
  return prisma.project.update({ where: { id: project.id }, data: { fieldConfigurationSchemeId: schemeId } });
}

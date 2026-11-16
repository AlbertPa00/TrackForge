import { invalidateJqlCtxCache } from '../jql/ctxCache.js';
/**
 * Custom field definitions + contexts + values.
 *
 * Storage: definitions in CustomField/Context/Option tables; issue values in
 * CustomFieldValue (JSONB) — except `systemManaged` fields, whose adapters map
 * onto existing storage (story_points → Issue.storyPoints, D19).
 */
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { cfTypeDef, searcherFor, CF_TYPES, type CfOption } from '../lib/cfTypes.js';
import type { Prisma } from '../lib/pc.js';

export const SYSTEM_FIELD_ALIASES = ['story_points', 'flagged', 'startdate'] as const;
export type SystemAlias = (typeof SYSTEM_FIELD_ALIASES)[number];

export type FieldWithContexts = Prisma.CustomFieldGetPayload<{
  include: { contexts: { include: { projects: true; options: { orderBy: { position: 'asc' } } } } };
}>;

export async function listFields(includeInactive = false): Promise<FieldWithContexts[]> {
  return prisma.customField.findMany({
    where: includeInactive ? {} : { active: true },
    orderBy: { seq: 'asc' },
    include: {
      contexts: {
        include: { projects: true, options: { orderBy: { position: 'asc' } } },
      },
    },
  });
}

export async function getField(idOrAlias: string): Promise<FieldWithContexts> {
  const field = await prisma.customField.findFirst({
    where: { OR: [{ id: idOrAlias }, { alias: idOrAlias }] },
    include: {
      contexts: {
        include: { projects: true, options: { orderBy: { position: 'asc' } } },
      },
    },
  });
  if (!field) throw new JiraApiError(404, jiraError([`Custom field '${idOrAlias}' not found.`]));
  return field;
}

/** All contexts for a field that apply to a project (global ∪ project-listed). */
export function contextsForProject(field: FieldWithContexts, projectId: string) {
  return field.contexts.filter((c) => c.isGlobal || c.projects.some((p) => p.projectId === projectId));
}

/** Options visible in a project (deduped by id across applicable contexts). */
export function optionsForProject(field: FieldWithContexts, projectId: string): CfOption[] {
  const seen = new Map<string, CfOption>();
  for (const ctx of contextsForProject(field, projectId)) {
    for (const o of ctx.options) {
      seen.set(o.id, {
        id: o.id,
        value: o.value,
        parentId: o.parentId,
        disabled: o.disabled,
        position: o.position,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.position - b.position);
}

/** Options merged across ALL contexts (used when no project scope applies — admin, JQL by name). */
export function allOptions(field: FieldWithContexts): CfOption[] {
  const seen = new Map<string, CfOption>();
  for (const ctx of field.contexts) {
    for (const o of ctx.options) {
      seen.set(o.id, { id: o.id, value: o.value, parentId: o.parentId, disabled: o.disabled, position: o.position });
    }
  }
  return [...seen.values()].sort((a, b) => a.position - b.position);
}

/** Fields visible in a project = system-managed ∪ fields with an applicable context. */
export function fieldsForProject(fields: FieldWithContexts[], projectId: string) {
  return fields.filter((f) => f.systemManaged || contextsForProject(f, projectId).length > 0);
}

export async function createField(input: {
  name: string;
  type: string;
  description?: string;
}): Promise<FieldWithContexts> {
  const name = input.name.trim();
  if (!name) throw new JiraApiError(400, jiraError(['Field name is required.']));
  if (!CF_TYPES.includes(input.type)) {
    throw new JiraApiError(
      400,
      jiraError([`Unknown custom field type '${input.type}'.`, `Allowed: ${CF_TYPES.join(', ')}`])
    );
  }
  if (await prisma.customField.findUnique({ where: { name } })) {
    throw new JiraApiError(400, jiraError([`A custom field named '${name}' already exists.`]));
  }
  const max = await prisma.customField.aggregate({ _max: { seq: true } });
  const seq = (max._max.seq ?? 9999) + 1;
  invalidateJqlCtxCache();
  const field = await prisma.customField.create({
    data: {
      id: `customfield_${seq}`,
      seq,
      name,
      type: input.type,
      searcherType: searcherFor(input.type),
      description: input.description?.trim() || null,
    },
  });
  return getField(field.id);
}

export async function updateField(
  id: string,
  input: { name?: string; description?: string | null; active?: boolean }
): Promise<FieldWithContexts> {
  const field = await getField(id);
  if (field.systemManaged && input.name && input.name !== field.name) {
    throw new JiraApiError(400, jiraError(['System-managed fields cannot be renamed.']));
  }
  if (input.name && input.name !== field.name) {
    const clash = await prisma.customField.findUnique({ where: { name: input.name.trim() } });
    if (clash) {
      throw new JiraApiError(400, jiraError([`A custom field named '${input.name}' already exists.`]));
    }
  }
  invalidateJqlCtxCache();
  await prisma.customField.update({
    where: { id: field.id },
    data: {
      name: input.name?.trim() || undefined,
      description: input.description === undefined ? undefined : input.description,
      active: input.active === undefined ? undefined : input.active,
    },
  });
  return getField(field.id);
}

/** Affected-issue count for a prospective delete (dryRun) or actual soft-delete. */
export async function deleteField(id: string, dryRun: boolean) {
  const field = await getField(id);
  if (field.systemManaged) {
    throw new JiraApiError(400, jiraError(['System-managed fields cannot be deleted.']));
  }
  const affected = await prisma.customFieldValue.count({ where: { fieldId: field.id } });
  if (dryRun) return { affectedIssues: affected, deleted: false };
  // Jira hard-deletes; TrackForge soft-deletes so values/changelog stay auditable.
  invalidateJqlCtxCache();
  await prisma.customField.update({ where: { id: field.id }, data: { active: false } });
  return { affectedIssues: affected, deleted: true };
}

// ---- Contexts & options ----

export async function upsertContext(
  fieldId: string,
  input: { isGlobal?: boolean; projectKeys?: string[]; options?: { value: string; children?: string[] }[] }
) {
  const field = await getField(fieldId);
  const isGlobal = input.isGlobal === true || !input.projectKeys?.length;
  const projects = input.projectKeys?.length
    ? await prisma.project.findMany({ where: { key: { in: input.projectKeys.map((k) => k.toUpperCase()) } } })
    : [];
  if (input.projectKeys?.length && projects.length !== input.projectKeys.length) {
    const found = new Set(projects.map((p) => p.key));
    const missing = input.projectKeys.filter((k) => !found.has(k.toUpperCase()));
    throw new JiraApiError(404, jiraError([`Unknown project(s): ${missing.join(', ')}`]));
  }
  const ctx = await prisma.customFieldContext.create({
    data: {
      fieldId: field.id,
      isGlobal,
      projects: { create: projects.map((p) => ({ projectId: p.id })) },
    },
  });
  // Two passes: parents first so cascading children can reference them.
  for (const [i, o] of (input.options ?? []).entries()) {
    const parent = await prisma.customFieldOption.create({
      data: { contextId: ctx.id, value: o.value, position: i },
    });
    for (const c of o.children ?? []) {
      await prisma.customFieldOption.create({
        data: { contextId: ctx.id, value: c, position: i, parentId: parent.id },
      });
    }
  }
  return getField(field.id);
}

export async function updateContext(
  fieldId: string,
  contextId: string,
  input: { options?: { id?: string; value: string; disabled?: boolean; children?: string[] }[] }
) {
  await getField(fieldId);
  const ctx = await prisma.customFieldContext.findFirst({ where: { id: contextId, fieldId } });
  if (!ctx) throw new JiraApiError(404, jiraError(['Context not found.']));
  if (input.options) {
    let pos = 0;
    for (const o of input.options) {
      if (o.id) {
        await prisma.customFieldOption.update({
          where: { id: o.id },
          data: { value: o.value, disabled: o.disabled ?? undefined, position: pos++ },
        });
      } else {
        const created = await prisma.customFieldOption.create({
          data: { contextId, value: o.value, position: pos++ },
        });
        for (const c of o.children ?? []) {
          await prisma.customFieldOption.create({
            data: { contextId, value: c, parentId: created.id, position: pos },
          });
        }
      }
    }
  }
  return getField(fieldId);
}

export async function deleteContext(fieldId: string, contextId: string) {
  await getField(fieldId);
  const ctx = await prisma.customFieldContext.findFirst({ where: { id: contextId, fieldId } });
  if (!ctx) throw new JiraApiError(404, jiraError(['Context not found.']));
  await prisma.customFieldContext.delete({ where: { id: ctx.id } });
  return getField(fieldId);
}

// ---- Issue values ----

/** Stored value for one field on an issue (adapter-aware for system-managed). */
export async function readValue(
  field: FieldWithContexts,
  issue: { id: string; storyPoints?: number | null }
): Promise<unknown> {
  if (field.alias === 'story_points') return issue.storyPoints ?? null;
  const row = await prisma.customFieldValue.findUnique({
    where: { issueId_fieldId: { issueId: issue.id, fieldId: field.id } },
  });
  return row?.value ?? null;
}

export async function writeValue(
  tx: Prisma.TransactionClient,
  field: FieldWithContexts,
  issue: { id: string },
  stored: unknown
) {
  if (field.alias === 'story_points') {
    await tx.issue.update({
      where: { id: issue.id },
      data: { storyPoints: stored === null ? null : Number(stored) },
    });
    return;
  }
  if (stored === null || stored === undefined) {
    await tx.customFieldValue.deleteMany({
      where: { issueId: issue.id, fieldId: field.id },
    });
    return;
  }
  await tx.customFieldValue.upsert({
    where: { issueId_fieldId: { issueId: issue.id, fieldId: field.id } },
    create: { issueId: issue.id, fieldId: field.id, value: stored as Prisma.InputJsonValue },
    update: { value: stored as Prisma.InputJsonValue },
  });
}

/**
 * Validate + normalize a client value for a field against the project's
 * context options. Returns the storage JSON to persist.
 */
export async function validateInput(field: FieldWithContexts, projectId: string, input: unknown): Promise<unknown> {
  const def = cfTypeDef(field.type);
  const opts = optionsForProject(field, projectId);
  if (field.type === 'user' && input !== null && input !== undefined) {
    const raw = def.parse(input, opts, field.id) as string | null;
    if (!raw) return null;
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { id: raw },
          { email: { equals: raw, mode: 'insensitive' } },
          { displayName: { equals: raw, mode: 'insensitive' } },
        ],
      },
    });
    if (!user) throw new JiraApiError(400, jiraError([], { [field.id]: `User '${raw}' not found.` }));
    // Denormalized Jira user shape (refresh-on-read in serializeValue).
    return {
      accountId: user.id,
      displayName: user.displayName,
      emailAddress: user.email,
      active: user.active,
    };
  }
  if (field.type === 'group' && input !== null && input !== undefined) {
    const raw = def.parse(input, opts, field.id) as string | null;
    if (!raw) return null;
    const group = await prisma.group.findUnique({ where: { name: raw } });
    if (!group) throw new JiraApiError(400, jiraError([], { [field.id]: `Group '${raw}' not found.` }));
    return group.name;
  }
  // Sprint 019 entity pickers: resolve by id or name within the project.
  for (const [type, model, label] of [
    ['version_picker', 'version', 'Version'],
    ['component_picker', 'component', 'Component'],
  ] as const) {
    if (field.type === type && input !== null && input !== undefined) {
      const raw = def.parse(input, opts, field.id) as string | null;
      if (!raw) return null;
      const entity = await (prisma as Record<string, any>)[model].findFirst({
        where: { projectId, OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }] },
      });
      if (!entity) {
        throw new JiraApiError(400, jiraError([], { [field.id]: `${label} '${raw}' not found in this project.` }));
      }
      return { id: entity.id, name: entity.name };
    }
  }
  if (
    (field.type === 'select' ||
      field.type === 'radio' ||
      field.type === 'multiselect' ||
      field.type === 'checkbox' ||
      field.type === 'cascading') &&
    input !== null &&
    input !== undefined
  ) {
    if (!opts.length) {
      throw new JiraApiError(
        400,
        jiraError([], { [field.id]: `Field '${field.name}' has no options configured for this project.` })
      );
    }
  }
  return def.parse(input, opts, field.id);
}

/**
 * Apply one Jira `update` op to a stored value. `set` replaces; `add`/`remove`
 * merge array-of-refs by option id (multi types only).
 */
export async function applyFieldOp(
  field: FieldWithContexts,
  projectId: string,
  current: unknown,
  op: 'set' | 'add' | 'remove',
  operand: unknown
): Promise<unknown> {
  const def = cfTypeDef(field.type);
  if (op === 'set') return validateInput(field, projectId, operand);
  if (!def.updateOps.includes(op)) {
    throw new JiraApiError(
      400,
      jiraError([], { [field.id]: `Operation '${op}' is not supported by field '${field.name}'.` })
    );
  }
  const curArr = Array.isArray(current) ? [...(current as { id: string }[])] : [];
  const operands = (Array.isArray(operand) ? operand : [operand]).filter((o) => o !== null && o !== undefined);
  const parsed: { id: string }[] = [];
  for (const o of operands) {
    const v = (await validateInput(field, projectId, o)) as { id: string }[] | { id: string } | null;
    if (v === null) continue;
    parsed.push(...(Array.isArray(v) ? v : [v]));
  }
  const next =
    op === 'add'
      ? [...curArr, ...parsed.filter((p) => !curArr.some((c) => c.id === p.id))]
      : curArr.filter((c) => !parsed.some((p) => p.id === c.id));
  return next.length ? next : null;
}

/** Storage JSON → Jira-shaped field value for issue responses. */
export async function serializeValue(field: FieldWithContexts, projectId: string, stored: unknown): Promise<unknown> {
  if (stored === null || stored === undefined) return null;
  const def = cfTypeDef(field.type);
  const opts = optionsForProject(field, projectId);
  // Refresh denormalized user refs so renames/deactivations show correctly.
  if (field.type === 'user' && typeof stored === 'object' && stored !== null) {
    const s = stored as { accountId?: string };
    if (s.accountId) {
      const u = await prisma.user.findUnique({ where: { id: s.accountId } });
      if (u) {
        return {
          accountId: u.id,
          displayName: u.active ? u.displayName : `${u.displayName} (inactive)`,
          emailAddress: u.email,
          active: u.active,
        };
      }
    }
    return stored;
  }
  // Refresh denormalized entity refs so renames/deletes show correctly.
  for (const [type, model] of [
    ['version_picker', 'version'],
    ['component_picker', 'component'],
  ] as const) {
    if (field.type === type && typeof stored === 'object' && stored !== null) {
      const s = stored as { id?: string; name?: string };
      if (!s.id) return stored;
      const entity = await (prisma as Record<string, any>)[model].findUnique({ where: { id: s.id } });
      return entity ? { id: entity.id, name: entity.name } : stored;
    }
  }
  return def.serialize(stored, opts, null);
}

/** Changelog display string for a stored value. */
export async function displayValue(
  field: FieldWithContexts,
  projectId: string,
  stored: unknown
): Promise<string | null> {
  const def = cfTypeDef(field.type);
  const opts = optionsForProject(field, projectId);
  return def.toDisplay(stored, opts, null);
}

// ---- Issue serialization (batched) ----

export interface CfValueCarrier {
  id: string;
  projectId: string;
  storyPoints?: number | null;
  cfValues?: { fieldId: string; value: unknown }[];
}

/**
 * Custom-field values for a batch of issues: `{customfield_NNNNN: jiraValue}` —
 * every field applicable to the issue's project, `null` when unset. Loads field
 * defs once per call (pass `defs` to reuse across calls).
 */
export async function cfFieldsForIssues(
  issues: CfValueCarrier[],
  defs?: FieldWithContexts[]
): Promise<Map<string, Record<string, unknown>>> {
  const fields = (defs ?? (await listFields())).filter((f) => f.active);
  const out = new Map<string, Record<string, unknown>>();
  for (const issue of issues) {
    const applicable = fieldsForProject(fields, issue.projectId);
    const cur = new Map((issue.cfValues ?? []).map((v) => [v.fieldId, v.value]));
    const fieldsObj: Record<string, unknown> = {};
    for (const f of applicable) {
      const stored = f.alias === 'story_points' ? (issue.storyPoints ?? null) : (cur.get(f.id) ?? null);
      fieldsObj[f.id] = await serializeValue(f, issue.projectId, stored);
      if (f.alias) fieldsObj[f.alias] = fieldsObj[f.id]; // 033 — stable alias keys (flagged/startdate)
    }
    out.set(issue.id, fieldsObj);
  }
  return out;
}

/** Single-issue convenience wrapper. */
export async function cfFieldsForIssue(
  issue: CfValueCarrier,
  defs?: FieldWithContexts[]
): Promise<Record<string, unknown>> {
  return (await cfFieldsForIssues([issue], defs)).get(issue.id) ?? {};
}

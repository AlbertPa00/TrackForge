import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';

import { fieldsForProjectScoped, type RegistryEntry } from './fieldRegistry.js';
import { optionsForProject } from './customFieldService.js';
import { resourceSelf } from '../lib/http.js';
import { projectByKeyOr404 } from './projectService.js';

const EDITABLE = new Set([
  'summary',
  'description',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'delegate', // 047
  'labels',
  'duedate',
  'resolution',
  'parent',
  'story_points',
  'reporter',
  'timetracking',
]);

async function allowedValuesForField(fieldId: string, projectId?: string) {
  switch (fieldId) {
    case 'issuetype': {
      // 031: project's issue type scheme bounds the offered types
      const types = projectId
        ? await (await import('./issueTypeSchemeService.js')).typesForProject(projectId)
        : await prisma.issueType.findMany({ orderBy: { hierarchyLevel: 'desc' } });
      return types.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? '',
        subtask: t.isSubtask,
      }));
    }
    case 'status': {
      const statuses = await prisma.status.findMany({ orderBy: { sequence: 'asc' } });
      return statuses.map((s) => ({ id: s.id, name: s.name }));
    }
    case 'priority': {
      const priorities = await prisma.priority.findMany({ orderBy: { sequence: 'asc' } });
      return priorities.map((p) => ({ id: p.id, name: p.name }));
    }
    case 'resolution': {
      const rs = await prisma.resolution.findMany({ orderBy: { sequence: 'asc' } });
      return rs.map((r) => ({ id: r.id, name: r.name, description: r.description ?? '' }));
    }
    case 'reporter':
    case 'assignee':
      // Jira signals "query the assignable search endpoint".
      return undefined;
    default:
      return undefined;
  }
}

function cfAllowedValues(entry: RegistryEntry, projectId: string) {
  if (!entry.cf) return undefined;
  if (!['select', 'radio', 'multiselect', 'checkbox', 'cascading'].includes(entry.cf.type)) {
    return undefined;
  }
  const opts = optionsForProject(entry.cf, projectId).filter((o) => !o.disabled);
  const top = opts.filter((o) => !o.parentId);
  return top.map((o) => ({
    id: o.id,
    value: o.value,
    ...(entry.cf!.type === 'cascading'
      ? {
          children: opts.filter((c) => c.parentId === o.id).map((c) => ({ id: c.id, value: c.value })),
        }
      : {}),
  }));
}

async function fieldMeta(entry: RegistryEntry, projectId: string, projectKey?: string) {
  const meta: Record<string, unknown> = {
    required: entry.custom ? false : (entry.system?.required ?? false),
    schema: entry.schema,
    name: entry.name,
    fieldId: entry.id,
    key: entry.id,
    operations: entry.operations,
  };
  if (!entry.custom) {
    if ((entry.id === 'assignee' || entry.id === 'reporter') && projectKey) {
      meta.autoCompleteUrl = resourceSelf(`/rest/api/2/user/assignable/search?project=${projectKey}&query=`);
    }
    // 047 — delegate autocomplete is agents-only.
    if (entry.id === 'delegate' && projectKey) {
      meta.autoCompleteUrl = resourceSelf(`/rest/api/2/user/assignable/search?agents=true&query=`);
    }
    const allowed = await allowedValuesForField(entry.id, projectId);
    if (allowed) meta.allowedValues = allowed;
  } else {
    const allowed = cfAllowedValues(entry, projectId);
    if (allowed) meta.allowedValues = allowed;
  }
  return meta;
}

export async function getCreateMetaForProject(projectKey: string, issueTypeId?: string) {
  const project = await projectByKeyOr404(projectKey);

  // 031: issue type scheme bounds which types a project offers
  const { typesForProject } = await import('./issueTypeSchemeService.js');
  const types = await typesForProject(project.id);

  if (!issueTypeId) {
    return {
      expand: 'issuetypes',
      project: { id: project.id, key: project.key, name: project.name },
      issuetypes: types.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description ?? '',
        subtask: t.isSubtask,
        expand: 'fields',
        self: resourceSelf(`/rest/api/2/issue/createmeta/${project.key}/issuetypes/${t.id}`),
      })),
    };
  }

  const type = types.find((t) => t.id === issueTypeId);
  if (!type) {
    throw new JiraApiError(404, jiraError([`Issue type '${issueTypeId}' not found.`]));
  }
  const values: Record<string, unknown>[] = [];
  const registry = await fieldsForProjectScoped(project.id);
  const SKIP = new Set([
    'created',
    'updated',
    'reporter',
    'status',
    'sprint',
    'subtasks',
    'issuelinks',
    'resolutiondate',
    'timespent',
    'timeestimate',
    'timeoriginalestimate',
    'worklog',
  ]);
  // 031: project-bound screen scheme gates which fields are offered
  const { screenFieldSet } = await import('./screenService.js');
  const onScreen = await screenFieldSet(project.id, type.id, 'create');
  // 031: field configuration — hidden removed, required/description merged
  const { resolveFieldConfig, effectiveField } = await import('./fieldConfigService.js');
  const fcItems = await resolveFieldConfig(project.id, type.id);
  for (const f of registry) {
    if (!f.custom && SKIP.has(f.id)) continue;
    if (f.custom && !f.cf!.active) continue;
    // parent is required for subtasks, hidden otherwise (Jira surfaces it via field meta)
    if (f.id === 'parent' && !type.isSubtask) continue;
    if (onScreen !== null && !onScreen.has(f.id) && f.id !== 'summary' && f.id !== 'parent' && f.id !== 'issuetype')
      continue;
    const fcEff = fcItems ? effectiveField(fcItems.get(f.id), {}) : null;
    if (fcEff?.hidden) continue;
    const meta = await fieldMeta(f, project.id, project.key);
    if (fcEff?.required) meta.required = true;
    if (fcEff?.description) meta.description = fcEff.description;
    if (fcEff?.defaultValue !== undefined && fcEff.defaultValue !== null) meta.defaultValue = fcEff.defaultValue;
    if (f.id === 'parent' && type.isSubtask) meta.required = true;
    values.push(meta);
  }
  return { expand: 'values', values };
}

export async function getEditMeta(projectKey: string, issueTypeId?: string) {
  const project = await prisma.project.findUnique({ where: { key: projectKey } });
  const fields: Record<string, unknown> = {};
  const registry = project ? await fieldsForProjectScoped(project.id) : [];
  const { screenFieldSet } = await import('./screenService.js');
  const onScreen = project ? await screenFieldSet(project.id, issueTypeId ?? null, 'edit') : null;
  const { resolveFieldConfig, effectiveField } = await import('./fieldConfigService.js');
  const fcItems = project ? await resolveFieldConfig(project.id, issueTypeId ?? null) : null;
  for (const f of registry) {
    if (onScreen !== null && !onScreen.has(f.id) && f.id !== 'summary' && f.id !== 'issuetype') continue;
    const fcEff = fcItems ? effectiveField(fcItems.get(f.id), {}) : null;
    if (fcEff?.hidden) continue;
    const meta = f.custom
      ? await fieldMeta(f, project!.id, projectKey)
      : !EDITABLE.has(f.id)
        ? null
        : await fieldMeta(f, project?.id ?? '', projectKey);
    if (!meta) continue;
    if (fcEff?.required) meta.required = true;
    if (fcEff?.description) meta.description = fcEff.description;
    fields[f.id] = meta;
  }
  return { fields };
}

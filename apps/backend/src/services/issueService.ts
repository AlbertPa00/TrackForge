import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { parseIssueKeyParts } from '../lib/issueKey.js';
import { issueConfirmToken, consumeConfirmToken } from '../lib/confirmToken.js';
import { toStatusCategory, FIELD_DEFS, FIELD_NAME_MAP } from './metaService.js';
import { fieldsForProject as fieldsForProjectLocal } from './customFieldService.js';
import { toUserResponse, resolveUserRef } from './userService.js';
import { recordChange, getChangelog, toHistoryResponse } from './changelogService.js';
import { emitEvent } from './eventService.js';
import { timeTrackingFields } from './worklogService.js';
import { addWatcher, autowatchAllowed } from './notificationService.js';
import { requirePermission, hasPermission } from './permissionService.js';
import { assertIssueWritable } from './projectService.js';
import { toAttachmentResponse } from './attachmentService.js';
import type { Attachment, Prisma, User } from '@prisma/client';
import { Prisma as PrismaRt } from '../lib/pc.js';
import type { Actor } from '../lib/auth.js';
import { securityGateWhere, cascadeEffectiveSecurity } from './issueSecurityService.js';
import { canSeeProjectId } from './visibilityService.js';
import { jiraDate, resourceSelf, issueSelf } from '../lib/http.js';

type AttachmentWithAuthor = Attachment & { author: User };

export const issueInclude = {
  project: true,
  issueType: true,
  status: true,
  priority: true,
  sprint: true,
  assignee: true,
  delegate: true,
  reporter: true,
  resolution: true,
  parent: {
    include: { project: true, issueType: true, status: true, securityLevel: { select: { id: true, name: true } } },
  },
  securityLevel: { select: { id: true, name: true } },
  children: {
    include: { project: true, issueType: true, status: true },
    orderBy: { issueNumber: 'asc' as const },
  },
  outLinks: { include: { type: true, inwardIssue: { include: { project: true, status: true } } } },
  inLinks: { include: { type: true, outwardIssue: { include: { project: true, status: true } } } },
  cfValues: true,
  components: { include: { component: true } },
  versionRefs: { include: { version: true } },
  attachments: { include: { author: true }, orderBy: { createdAt: 'asc' as const } },
  watchers: { select: { userId: true } },
  votes: { select: { userId: true } },
  remoteLinks: true,
} as const;

/** Field keys toIssueResponse can emit without touching cfValues/alias keys.
 *  A `?fields=` entry outside this set is treated as a custom field. */
const BUILTIN_FIELD_KEYS = new Set(
  [
    'id', 'key', 'self', 'summary', 'description', 'project', 'issuetype', 'status', 'priority',
    'assignee', 'delegate', 'reporter', 'sprint', 'labels', 'duedate', 'resolution', 'resolutiondate',
    'story_points', 'components', 'fixversions', 'versions', 'attachment', 'parent', 'subtasks',
    'issuelinks', 'watches', 'votes', 'environment', 'statuschangedate', 'comment', 'issuelinkcount',
    'attachmentcount', 'security', 'created', 'updated', 'timetracking', 'timeoriginalestimate',
    'timeestimate', 'progress', 'worklog', 'workratio', 'timespent', 'aggregatetimespent',
    'aggregatetimeoriginalestimate', 'aggregatetimeestimate', 'aggregateprogress', 'aggregatesprogress',
  ]
);

/**
 * Slim include for `?fields=` searches: Jira omits unlisted fields from the
 * response, so hydrating their relations is pure cost — a `fields=key,summary`
 * search currently loads ~20 relations per issue anyway. When `fields` is
 * absent or `*all`/`*navigable` the full include is returned unchanged.
 * `needsCf` mirrors the cfValues decision so callers can skip cfFieldsForIssues.
 */
export function issueIncludeForFields(fields?: string[]): { include: typeof issueInclude; needsCf: boolean } {
  if (!fields?.length || fields.some((f) => f === '*all' || f === '*navigable')) {
    return { include: issueInclude, needsCf: true };
  }
  const wanted = new Set(fields.map((f) => f.toLowerCase()));
  const needsCf = [...wanted].some((f) => !BUILTIN_FIELD_KEYS.has(f));
  // project/issueType/status/priority are dereferenced unconditionally by
  // toIssueResponse (and `key`/`self` need project.key) — always loaded.
  const slim: Prisma.IssueInclude = { project: true, issueType: true, status: true, priority: true };
  if (wanted.has('assignee')) slim.assignee = true;
  if (wanted.has('delegate')) slim.delegate = true;
  if (wanted.has('reporter')) slim.reporter = true;
  if (wanted.has('sprint')) slim.sprint = true;
  if (wanted.has('resolution')) slim.resolution = true;
  if (wanted.has('security')) slim.securityLevel = { select: { id: true, name: true } };
  // `security` inherits the parent's level — the parent row is needed for it
  // even when `parent` itself isn't requested.
  if (wanted.has('parent') || wanted.has('security')) {
    slim.parent = {
      include: { project: true, issueType: true, status: true, securityLevel: { select: { id: true, name: true } } },
    };
  }
  if (wanted.has('subtasks')) {
    slim.children = {
      include: { project: true, issueType: true, status: true },
      orderBy: { issueNumber: 'asc' },
    };
  }
  if (wanted.has('issuelinks')) {
    slim.outLinks = { include: { type: true, inwardIssue: { include: { project: true, status: true } } } };
    slim.inLinks = { include: { type: true, outwardIssue: { include: { project: true, status: true } } } };
  }
  if (needsCf) slim.cfValues = true;
  if (wanted.has('components')) slim.components = { include: { component: true } };
  if (wanted.has('fixversions') || wanted.has('versions')) slim.versionRefs = { include: { version: true } };
  if (wanted.has('attachment')) {
    slim.attachments = { include: { author: true }, orderBy: { createdAt: 'asc' } };
  }
  if (wanted.has('watches')) slim.watchers = { select: { userId: true } };
  if (wanted.has('votes')) slim.votes = { select: { userId: true } };
  const countSelect: Record<string, true> = {};
  if (wanted.has('comment')) countSelect.comments = true;
  if (wanted.has('issuelinkcount')) {
    countSelect.outLinks = true;
    countSelect.inLinks = true;
  }
  if (wanted.has('attachmentcount')) countSelect.attachments = true;
  if (Object.keys(countSelect).length) slim._count = { select: countSelect };
  // remoteLinks is deliberately absent — toIssueResponse never serializes it.
  // The payload type stays `typeof issueInclude`: every consumer treats the
  // trimmed relations as optional (`?? []` / null guards) — they just read
  // as absent, which is what an unrequested field serializes as anyway.
  return { include: slim as unknown as typeof issueInclude, needsCf };
}

export function toIssueKey(projectKey: string, issueNumber: number) {
  return `${projectKey}-${issueNumber}`;
}

export async function parseIssueKey(issueKey: string) {
  const parts = parseIssueKeyParts(issueKey);
  if (!parts) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }
  return parts;
}

// --- validation helpers (allowed-value errors, FR-005) ---

async function invalidEnum(field: string, value: string, names: string[]) {
  throw new JiraApiError(
    400,
    jiraError([], {
      [field]: `'${value}' is not valid. Allowed: ${names.join(', ')}.`,
    })
  );
}

export interface AssigneeRef {
  accountId?: string;
  name?: string;
}

async function resolveAssigneeRef(ref: AssigneeRef | null | undefined, field = 'assignee') {
  if (!ref) return null;
  // 053 US3 — an empty ref must 400, not fall through to an unscoped lookup
  // which silently matches the first user in the table.
  if (!ref.accountId && !ref.name) {
    throw new JiraApiError(400, jiraError([], { [`fields.${field}`]: 'Specify accountId or name.' }));
  }
  const u =
    (ref.accountId ? await resolveUserRef(ref.accountId) : null) ?? (ref.name ? await resolveUserRef(ref.name) : null);
  if (!u) {
    throw new JiraApiError(400, jiraError([], { [`fields.${field}`]: 'User not found or inactive.' }));
  }
  return u;
}

// 047 US1 — delegates must be flagged assignable agents (app:assignable-style
// opt-in). Delegation changes triggering, never authorization (FR-001).
export async function resolveDelegateRef(ref: AssigneeRef | null | undefined) {
  if (!ref) return null;
  const u = await resolveAssigneeRef(ref, 'delegate');
  if (u && !u.isAssignableAgent) {
    throw new JiraApiError(400, jiraError([], { 'fields.delegate': `'${u.displayName}' is not an assignable agent.` }));
  }
  return u;
}

// --- labels (Jira rules: no spaces, ≤255 chars) ---

function validateLabels(labels: string[]): string[] {
  const clean = labels.map((l) => String(l).trim()).filter(Boolean);
  for (const l of clean) {
    if (/\s/.test(l)) {
      throw new JiraApiError(
        400,
        jiraError([], { 'fields.labels': `Label '${l}' is invalid — labels cannot contain spaces.` })
      );
    }
    if (l.length > 255) {
      throw new JiraApiError(400, jiraError([], { 'fields.labels': 'Labels must be 255 characters or fewer.' }));
    }
  }
  return [...new Set(clean)];
}

// --- hierarchy validation (FR-003) ---

async function resolveParentRef(
  parentKey: string | null | undefined,
  project: { id: string; key: string },
  issueType: { name: string; hierarchyLevel: number; isSubtask: boolean },
  selfId?: string
) {
  if (issueType.isSubtask && parentKey === null) {
    throw new JiraApiError(400, jiraError([], { 'fields.parent': 'Subtasks require a parent.' }));
  }
  if (parentKey === undefined || parentKey === null) return { parent: null, set: parentKey === null };

  const { projectKey, issueNumber } = await parseIssueKey(parentKey);
  const parent = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    include: { issueType: true, project: true, status: true, securityLevel: { select: { id: true, name: true } } },
  });
  if (!parent || parent.projectId !== project.id) {
    throw new JiraApiError(
      400,
      jiraError([], { 'fields.parent': `Parent '${parentKey}' not found in project ${project.key}.` })
    );
  }
  if (selfId && parent.id === selfId) {
    throw new JiraApiError(400, jiraError([], { 'fields.parent': 'An issue cannot be its own parent.' }));
  }
  if (parent.issueType.hierarchyLevel !== issueType.hierarchyLevel + 1) {
    const msg = issueType.isSubtask
      ? `Subtask parent must be a standard issue type, not '${parent.issueType.name}'.`
      : `'${issueType.name}' can only be a child of an Epic, not '${parent.issueType.name}'.`;
    throw new JiraApiError(400, jiraError([], { 'fields.parent': msg }));
  }
  return { parent, set: true };
}

/** Jira `fields.timetracking` — duration strings per instance config (024). */
export interface TimeTrackingInput {
  originalEstimate?: string | null;
  remainingEstimate?: string | null;
}

export interface CreateIssueInput {
  projectKey: string;
  summary: string;
  description?: string | null;
  issueTypeName?: string;
  priorityName?: string;
  assignee?: AssigneeRef | null;
  delegate?: AssigneeRef | null; // 047
  labels?: string[];
  dueDate?: string | null;
  parentKey?: string | null;
  storyPoints?: number | null;
  reporter?: AssigneeRef | null;
  environment?: string | null;
  timeTracking?: TimeTrackingInput;
  /** 019: Jira `fields.components` — [{name}|{id}] refs, project-scoped. */
  components?: { id?: string; name?: string }[];
  /** 019: Jira `fields.fixVersions`. */
  fixVersions?: { id?: string; name?: string }[];
  /** 019: Jira `fields.versions` (UI label "Affects versions"). */
  affectsVersions?: { id?: string; name?: string }[];
  /** customfield_NNNNN / alias → raw client value (Jira `fields` passthrough). */
  customFields?: Record<string, unknown>;
  /** 031: Jira `fields.security` — {id|name} object or level name; null clears. */
  security?: unknown;
}

export interface CfOp {
  op: 'set' | 'add' | 'remove';
  value: unknown;
}

interface CfWrite {
  field: import('./customFieldService.js').FieldWithContexts;
  stored: unknown;
}

/**
 * Resolve `fields.customfield_*`/alias inputs + `update.customfield_*` ops into
 * validated storage writes + changelog items. Shared by create/update plans.
 */
async function planCfWrites(
  projectId: string,
  setInputs: Record<string, unknown> | undefined,
  opInputs: Record<string, CfOp[]> | undefined,
  current: Map<string, unknown>,
  items: { field: string; fieldtype?: string; fromString?: string | null; toString?: string | null }[],
  storyPoints?: number | null
): Promise<CfWrite[]> {
  const cf = await import('./customFieldService.js');
  const writes = new Map<string, CfWrite>();
  if (!setInputs && !opInputs) return [];
  const defs = fieldsForProjectLocal(await cf.listFields(), projectId);
  const spField = defs.find((f) => f.alias === 'story_points');
  if (spField && storyPoints !== undefined) current.set(spField.id, storyPoints);
  const resolve = (key: string) => {
    const k = key.toLowerCase();
    return defs.find((f) => f.active && (f.id === key || f.alias === key || f.name.toLowerCase() === k));
  };
  const pushWrite = async (field: (typeof defs)[number], stored: unknown) => {
    const prev = current.get(field.id);
    if (JSON.stringify(prev ?? null) === JSON.stringify(stored ?? null)) return;
    writes.set(field.id, { field, stored });
    // `update` ops run after `fields` sets (Jira semantics) — ops on the same
    // field must compose onto the just-set value, not the pre-request one.
    current.set(field.id, stored);
    items.push({
      field: field.name,
      fieldtype: 'custom',
      fromString: await cf.displayValue(field, projectId, prev ?? null),
      toString: await cf.displayValue(field, projectId, stored),
    });
  };
  for (const [key, raw] of Object.entries(setInputs ?? {})) {
    const field = resolve(key);
    if (!field) {
      throw new JiraApiError(
        400,
        jiraError([], { [key]: `Field '${key}' cannot be set. It is not on the appropriate screen, or unknown.` })
      );
    }
    await pushWrite(field, await cf.validateInput(field, projectId, raw));
  }
  for (const [key, ops] of Object.entries(opInputs ?? {})) {
    const field = resolve(key);
    if (!field) {
      throw new JiraApiError(
        400,
        jiraError([], { [key]: `Field '${key}' cannot be set. It is not on the appropriate screen, or unknown.` })
      );
    }
    let next: unknown = current.get(field.id) ?? null;
    for (const { op, value } of ops) {
      next = await cf.applyFieldOp(field, projectId, next, op, value);
    }
    await pushWrite(field, next);
  }
  return [...writes.values()];
}

/**
 * Parse `fields.timetracking` durations → estimate columns + changelog items.
 * `timeSpent` inside timetracking is rejected — it only moves via worklogs
 * (Jira parity: you cannot set timeSpent as a field).
 */
async function planTimeTracking(
  tt: TimeTrackingInput | undefined,
  curOriginal: number | null,
  curRemaining: number | null,
  items: { field: string; fieldtype?: string; fromString?: string | null; toString?: string | null }[]
) {
  const out: { originalEstimateSec?: number | null; remainingEstimateSec?: number | null } = {};
  if (!tt) return out;
  const { getTimeTrackingConfig } = await import('./settingsService.js');
  const { parseDuration, formatDuration } = await import('../lib/duration.js');
  const cfg = await getTimeTrackingConfig();
  if ('timeSpent' in (tt as Record<string, unknown>)) {
    throw new JiraApiError(
      400,
      jiraError([], { 'fields.timetracking': "'timeSpent' cannot be set — log work via the worklog endpoint." })
    );
  }
  if (tt.originalEstimate !== undefined) {
    const sec = tt.originalEstimate === null ? null : parseDuration(tt.originalEstimate, cfg);
    if (tt.originalEstimate !== null && sec === null) {
      throw new JiraApiError(
        400,
        jiraError([], {
          'fields.timetracking.originalEstimate': `Invalid duration '${tt.originalEstimate}' (e.g. "1w 2d 3h").`,
        })
      );
    }
    if (sec !== curOriginal) {
      out.originalEstimateSec = sec;
      items.push({
        field: 'timeoriginalestimate',
        fromString: formatDuration(curOriginal, cfg) ?? null,
        toString: formatDuration(sec, cfg) ?? null,
      });
    }
  }
  if (tt.remainingEstimate !== undefined) {
    const sec = tt.remainingEstimate === null ? null : parseDuration(tt.remainingEstimate, cfg);
    if (tt.remainingEstimate !== null && sec === null) {
      throw new JiraApiError(
        400,
        jiraError([], {
          'fields.timetracking.remainingEstimate': `Invalid duration '${tt.remainingEstimate}' (e.g. "1w 2d 3h").`,
        })
      );
    }
    if (sec !== curRemaining) {
      out.remainingEstimateSec = sec;
      items.push({
        field: 'timeestimate',
        fromString: formatDuration(curRemaining, cfg) ?? null,
        toString: formatDuration(sec, cfg) ?? null,
      });
    }
  }
  return out;
}

async function planCreate(data: CreateIssueInput, actor: Actor) {
  const project = await prisma.project.findUnique({ where: { key: data.projectKey } });
  if (!project) {
    throw new JiraApiError(400, jiraError([], { 'fields.project': 'Project not found.' }));
  }
  await requirePermission(actor, 'CREATE_ISSUES', { projectId: project.id });
  // Jira: filing as another reporter or presetting a security level needs the
  // dedicated permissions, not just CREATE_ISSUES.
  if (data.reporter !== undefined && data.reporter !== null) {
    await requirePermission(actor, 'MODIFY_REPORTER', { projectId: project.id });
  }
  if (data.security !== undefined) {
    await requirePermission(actor, 'SET_ISSUE_SECURITY', { projectId: project.id });
  }

  const issueTypeName = data.issueTypeName ?? 'Task';
  const issueType = await prisma.issueType.findUnique({ where: { name: issueTypeName } });
  if (!issueType) {
    const types = await prisma.issueType.findMany({ select: { name: true } });
    await invalidEnum(
      'fields.issuetype',
      issueTypeName,
      types.map((t) => t.name)
    );
  }
  if (issueType!.isSubtask && !data.parentKey) {
    throw new JiraApiError(400, jiraError([], { 'fields.parent': 'Subtasks require a parent.' }));
  }
  // 031: project-bound issue type scheme restricts creatable types
  const { assertIssueTypeAllowed } = await import('./issueTypeSchemeService.js');
  await assertIssueTypeAllowed(project.id, issueType!);
  const { parent } = await resolveParentRef(data.parentKey, project, issueType!);

  // 031: field-configuration defaults — applied before field resolution so
  // a configured default priority/labels/etc participates in validation.
  const { fieldConfigDefaults } = await import('./fieldConfigService.js');
  const createCtx = () => ({
    summary: data.summary,
    description: data.description,
    issuetype: issueTypeName,
    priority: data.priorityName,
    assignee: typeof data.assignee === 'object' ? (data.assignee as { name?: string })?.name : data.assignee,
    reporter: typeof data.reporter === 'object' ? (data.reporter as { name?: string })?.name : data.reporter,
    labels: data.labels,
    duedate: data.dueDate,
    environment: data.environment,
    security: data.security,
    story_points: data.storyPoints,
    ...(data.customFields ?? {}),
  });
  const providedKeys = new Set<string>();
  if (data.description !== undefined) providedKeys.add('description');
  if (data.priorityName !== undefined) providedKeys.add('priority');
  if (data.assignee !== undefined) providedKeys.add('assignee');
  if (data.reporter !== undefined) providedKeys.add('reporter');
  if (data.labels !== undefined) providedKeys.add('labels');
  if (data.dueDate !== undefined) providedKeys.add('duedate');
  if (data.environment !== undefined) providedKeys.add('environment');
  if (data.components !== undefined) providedKeys.add('components');
  if (data.fixVersions !== undefined) providedKeys.add('fixVersions');
  if (data.affectsVersions !== undefined) providedKeys.add('versions');
  if (data.security !== undefined) providedKeys.add('security');
  if (data.timeTracking !== undefined) providedKeys.add('timetracking');
  if (data.storyPoints !== undefined) providedKeys.add('story_points');
  for (const k of Object.keys(data.customFields ?? {})) providedKeys.add(k);
  const applyDefault = (k: string, v: unknown) => {
    switch (k) {
      case 'description':
        data.description = String(v);
        break;
      case 'priority':
        data.priorityName = String(v);
        break;
      case 'labels':
        data.labels = Array.isArray(v) ? v.map(String) : [String(v)];
        break;
      case 'duedate':
        data.dueDate = String(v);
        break;
      case 'environment':
        data.environment = String(v);
        break;
      case 'assignee':
        data.assignee = typeof v === 'object' ? (v as { name?: string }) : { name: String(v) };
        break;
      case 'reporter':
        data.reporter = typeof v === 'object' ? (v as { name?: string }) : { name: String(v) };
        break;
      case 'security':
        data.security = v;
        break;
      case 'story_points':
        data.storyPoints = Number(v);
        break;
      case 'timetracking':
        data.timeTracking = v as TimeTrackingInput;
        break;
      default:
        (data.customFields ??= {})[k] = v;
    }
  };
  // two passes: defaults can themselves satisfy other rules' `when` clauses
  for (let pass = 0; pass < 2; pass++) {
    const defaults = await fieldConfigDefaults(project.id, issueType!.id, providedKeys, createCtx());
    if (!defaults.size) break;
    for (const [k, v] of defaults) {
      applyDefault(k, v);
      providedKeys.add(k);
    }
  }

  const priorityName = data.priorityName ?? 'Medium';
  const priority = await prisma.priority.findUnique({ where: { name: priorityName } });
  if (!priority) {
    const all = await prisma.priority.findMany({ select: { name: true }, orderBy: { sequence: 'asc' } });
    await invalidEnum(
      'fields.priority',
      priorityName,
      all.map((p) => p.name)
    );
  }

  const labels = data.labels ? validateLabels(data.labels) : [];
  const dueDate = data.dueDate ? new Date(data.dueDate) : null;
  if (dueDate && Number.isNaN(dueDate.getTime())) {
    throw new JiraApiError(400, jiraError([], { 'fields.duedate': 'Due date must be a valid date (YYYY-MM-DD).' }));
  }

  // Initial status comes from the project's workflow (009).
  const { initialStatusForProject } = await import('./workflowService.js');
  const defaultStatus = await initialStatusForProject(project.id, issueType!.id);

  // 019: component/version refs — resolved against this project only.
  const { resolveComponentRefs, resolveVersionRefs, defaultAssigneeFromComponents } =
    await import('./componentVersionService.js');
  const components = await resolveComponentRefs(project.id, data.components);
  const fixVersions = await resolveVersionRefs(project.id, data.fixVersions);
  const affectsVersions = await resolveVersionRefs(project.id, data.affectsVersions);

  // 053 US3 — an explicit assignee on create needs ASSIGN_ISSUES on the actor
  // + ASSIGNABLE_USER on the target, the same gate PUT /issue applies
  // (checkAssign resolves the ref, so its return doubles as the user lookup).
  // assignee:null = explicit unassigned — no permission needed.
  let assignee = data.assignee
    ? await checkAssign(actor, { projectId: project.id }, data.assignee)
    : await resolveAssigneeRef(data.assignee);
  // Jira default-assignee (FR-003): only when the field wasn't provided.
  if (!assignee && data.assignee === undefined) {
    const def = await defaultAssigneeFromComponents(project.id, components);
    if (def) assignee = def as unknown as typeof assignee;
  }
  // 047: delegate on create — assignable agents only.
  const delegate =
    data.delegate !== undefined && data.delegate !== null ? await resolveDelegateRef(data.delegate) : undefined;

  // 022: explicit reporter on create; defaults to the actor. The
  // MODIFY_REPORTER gate sits at the top of planCreate so field-config
  // defaults (applied above) can't demand a user-supplied permission.
  const reporter = data.reporter != null ? await resolveAssigneeRef(data.reporter, 'reporter') : undefined;
  const effectiveReporter = reporter ?? { id: actor.user.id, displayName: actor.user.displayName };

  const items: {
    field: string;
    fieldtype?: string;
    from?: string | null;
    fromString?: string | null;
    to?: string | null;
    toString?: string | null;
  }[] = [
    { field: 'summary', toString: data.summary },
    { field: 'status', to: defaultStatus.id, toString: defaultStatus.name },
    { field: 'issuetype', to: issueType!.id, toString: issueType!.name },
    { field: 'priority', to: priority!.id, toString: priority!.name },
    { field: 'reporter', to: effectiveReporter.id, toString: effectiveReporter.displayName },
    ...(assignee ? [{ field: 'assignee', to: assignee.id, toString: assignee.displayName }] : []),
    ...(delegate ? [{ field: 'delegate', to: delegate.id, toString: delegate.displayName }] : []),
    ...(labels.length ? [{ field: 'labels', toString: labels.join(' ') }] : []),
    ...(dueDate ? [{ field: 'duedate', toString: jiraDate(dueDate) }] : []),
    ...(parent ? [{ field: 'parent', to: parent.id, toString: toIssueKey(project.key, parent.issueNumber) }] : []),
    ...(data.storyPoints !== undefined && data.storyPoints !== null
      ? [{ field: 'Story Points', toString: String(data.storyPoints) }]
      : []),
    ...(components.length ? [{ field: 'Component', toString: components.map((c) => c.name).join(' ') }] : []),
    ...(fixVersions.length ? [{ field: 'Fix Version/s', toString: fixVersions.map((v) => v.name).join(' ') }] : []),
    ...(affectsVersions.length
      ? [{ field: 'Affects Version/s', toString: affectsVersions.map((v) => v.name).join(' ') }]
      : []),
  ];

  // 031: screen gating — fields offered by the resolved create screen only
  const { assertScreenFieldsAllowed } = await import('./screenService.js');
  await assertScreenFieldsAllowed(project.id, issueType!.id, 'create', [
    ...(data.description !== undefined ? ['description'] : []),
    ...(data.priorityName !== undefined ? ['priority'] : []),
    ...(data.assignee !== undefined ? ['assignee'] : []),
    ...(data.labels !== undefined ? ['labels'] : []),
    ...(data.dueDate !== undefined ? ['duedate'] : []),
    ...(data.reporter !== undefined ? ['reporter'] : []),
    ...(data.environment !== undefined ? ['environment'] : []),
    ...(data.components !== undefined ? ['components'] : []),
    ...(data.fixVersions !== undefined ? ['fixVersions'] : []),
    ...(data.affectsVersions !== undefined ? ['versions'] : []),
    ...(data.security !== undefined ? ['security'] : []),
    ...(data.timeTracking !== undefined ? ['timetracking'] : []),
    ...(data.storyPoints !== undefined ? ['story_points'] : []),
    ...Object.keys(data.customFields ?? {}),
  ]);

  // 031: field config — hidden rejected, required must carry a value
  const { assertFieldConfigCreate } = await import('./fieldConfigService.js');
  await assertFieldConfigCreate(project.id, issueType!.id, [...providedKeys], createCtx());

  const cfWrites = await planCfWrites(project.id, data.customFields, undefined, new Map(), items);

  const estimates = await planTimeTracking(data.timeTracking, null, null, items);

  // 031: explicit `fields.security` or the scheme's default level.
  const { resolveLevelInput, defaultLevelId } = await import('./issueSecurityService.js');
  const securityLevelId =
    data.security !== undefined
      ? ((await resolveLevelInput(project.id, data.security)) ?? null)
      : await defaultLevelId(project.id);
  const securityLevel = securityLevelId
    ? await prisma.securityLevel.findUnique({ where: { id: securityLevelId }, select: { id: true, name: true } })
    : null;
  if (securityLevel) {
    items.push({ field: 'security', toString: securityLevel.name });
  }

  return {
    project,
    issueType: issueType!,
    priority: priority!,
    defaultStatus,
    assignee,
    delegate,
    labels,
    dueDate,
    parent,
    items,
    cfWrites,
    estimates,
    components,
    fixVersions,
    affectsVersions,
    effectiveReporter,
    securityLevelId,
    securityLevel,
  };
}

type CounterClient = Pick<typeof prisma, 'issue' | 'project'>;

/** Highest issueNumber in a project — the source of truth when issueCounter
 *  is stale (seed/import/migration paths can write issues without advancing
 *  it; observed: 500 bypass-seeded issues, counter=2 → every create 500'd on
 *  the (projectId, issueNumber) unique constraint). */
export async function issueNumberMax(projectId: string, client: Pick<typeof prisma, 'issue'> = prisma) {
  return (await client.issue.aggregate({ where: { projectId }, _max: { issueNumber: true } }))._max.issueNumber ?? 0;
}

/** Conditional issueCounter heal: bump to the real max only when behind.
 *  issueCounter is the last-allocated number (increment-then-use), so a
 *  healthy counter already equals maxNum — the strict < guard leaves it
 *  untouched and never regresses a counter advanced by a concurrent create.
 *  Pass `tx` to run inside a transaction. */
export async function healIssueCounter(projectId: string, client: CounterClient = prisma) {
  const maxNum = await issueNumberMax(projectId, client);
  await client.project.updateMany({
    where: { id: projectId, issueCounter: { lt: maxNum } },
    data: { issueCounter: maxNum },
  });
  return maxNum;
}

export async function createIssue(data: CreateIssueInput, actor: Actor) {
  const {
    project,
    issueType,
    priority,
    defaultStatus,
    assignee,
    delegate,
    labels,
    dueDate,
    parent,
    items,
    cfWrites,
    estimates,
    components,
    fixVersions,
    affectsVersions,
    effectiveReporter,
    securityLevelId,
  } = await planCreate(data, actor);
  if ((project as { archived?: boolean }).archived) {
    throw new JiraApiError(403, jiraError([], { project: `Project ${project.key} is archived (read-only).` }));
  }

  // 070 — the counter is healed on collision (P2002) only. A stale counter is
  // an import/seed/migration artifact; paying a MAX() aggregate on every
  // create was dead cost on the single row that already serializes creates.
  const { rankAfter, initialRank } = await import('../lib/lexorank.js');
  for (let attempt = 0; ; attempt++) {
    // Atomic single-statement increment: issueCounter = issueCounter + 1 is
    // evaluated server-side, so concurrent creates get distinct numbers.
    const counter = await prisma.project.update({
      where: { id: project.id },
      data: { issueCounter: { increment: 1 } },
      select: { issueCounter: true },
    });

    // Append to the end of the project's rank space (009).
    const last = await prisma.issue.findFirst({
      where: { projectId: project.id, rank: { not: '' } },
      orderBy: { rank: 'desc' },
      select: { rank: true },
    });
    const rank = last ? rankAfter(last.rank) : initialRank(1);

    let issue: Prisma.IssueGetPayload<{ include: typeof issueInclude }>;
    try {
      issue = await prisma.$transaction(async (tx) => {
    const created = await tx.issue.create({
      data: {
        projectId: project.id,
        issueNumber: counter.issueCounter,
        rank,
        summary: data.summary,
        description: data.description,
        issueTypeId: issueType.id,
        statusId: defaultStatus.id,
        statusChangedAt: new Date(),
        priorityId: priority.id,
        reporterId: effectiveReporter.id,
        assigneeId: assignee?.id,
        delegateId: delegate?.id, // 047
        environment: data.environment ?? undefined,
        securityLevelId: securityLevelId ?? undefined,
        // denormalized effective level: own ?? parent's (031 perf predicate)
        effSecurityLevelId: securityLevelId ?? parent?.effSecurityLevelId ?? undefined,
        labels,
        dueDate,
        parentId: parent?.id,
        storyPoints: data.storyPoints ?? undefined,
        ...(estimates.originalEstimateSec !== undefined ? { originalEstimateSec: estimates.originalEstimateSec } : {}),
        ...(estimates.remainingEstimateSec !== undefined
          ? { remainingEstimateSec: estimates.remainingEstimateSec }
          : {}),
      },
      include: issueInclude,
    });
    // 019: issue ↔ component/version joins
    for (const c of components) {
      await tx.issueComponent.create({ data: { issueId: created.id, componentId: c.id } });
    }
    for (const v of fixVersions) {
      await tx.issueVersion.create({ data: { issueId: created.id, versionId: v.id, kind: 'fix' } });
    }
    for (const v of affectsVersions) {
      await tx.issueVersion.create({ data: { issueId: created.id, versionId: v.id, kind: 'affects' } });
    }
    const { writeValue } = await import('./customFieldService.js');
    for (const w of cfWrites) {
      await writeValue(tx, w.field, created, w.stored);
      // Keep the returned row in sync — it was fetched before the writes.
      if (w.field.alias === 'story_points') {
        created.storyPoints = w.stored === null ? null : Number(w.stored);
      } else {
        const row = { fieldId: w.field.id, value: w.stored } as (typeof created.cfValues)[number];
        const idx = created.cfValues.findIndex((v) => v.fieldId === w.field.id);
        if (w.stored === null || w.stored === undefined) {
          if (idx >= 0) created.cfValues.splice(idx, 1);
        } else if (idx >= 0) created.cfValues[idx] = row;
        else created.cfValues.push(row);
      }
    }
    await recordChange(tx, created.id, actor, items);
    // 057 US1 — delegate-on-create is the same contract as delegate-on-update:
    // spawn the agent session + event (previously only updateIssue did this).
    if (delegate) {
      await tx.agentSession.create({
        data: { issueId: created.id, agentUserId: delegate.id, delegatorId: actor.user.id, trigger: 'delegate' },
      });
      await emitEvent(tx, actor, {
        type: 'agent_session.created',
        projectId: project.id,
        issueId: created.id,
        payload: { issueKey: toIssueKey(project.key, created.issueNumber), delegateId: delegate.id },
      });
    }
    await emitEvent(tx, actor, {
      type: 'jira:issue_created',
      projectId: project.id,
      issueId: created.id,
      payload: {
        issueKey: toIssueKey(project.key, created.issueNumber),
        projectKey: project.key,
        issue: toIssueResponse(created, {
          cfFields: Object.fromEntries(
            cfWrites.filter((w) => w.field.alias !== 'story_points').map((w) => [w.field.id, w.stored])
          ),
        }),
        changelog: { items },
      },
    });
    return created;
      });
    } catch (e) {
      if (attempt === 0 && e instanceof PrismaRt.PrismaClientKnownRequestError && e.code === 'P2002') {
        // Stale issueCounter (import/seed wrote issues without advancing it) —
        // bump to the real max and retry the whole create once.
        await healIssueCounter(project.id);
        continue;
      }
      throw e;
    }

    // Auto-watch: creator and (if human) assignee follow new issues — gated by
    // each user's own autowatch preference (066; Jira parity).
    if (await autowatchAllowed(actor.user.id, 'create')) await addWatcher(issue.id, actor.user.id);
    if (assignee && assignee.id !== actor.user.id && assignee.type === 'human') {
      if (await autowatchAllowed(assignee.id, 'assign')) await addWatcher(issue.id, assignee.id);
    }
    return issue;
  }
}

/** Validates + computes a create without persisting (dryRun). */
export async function previewCreateIssue(data: CreateIssueInput, actor: Actor) {
  const {
    project,
    issueType,
    priority,
    defaultStatus,
    assignee,
    labels,
    dueDate,
    parent,
    items,
    cfWrites,
    components,
    fixVersions,
    affectsVersions,
    securityLevel,
  } = await planCreate(data, actor);
  // Same write gate as createIssue — a dryRun must fail where the write would.
  if ((project as { archived?: boolean }).archived) {
    throw new JiraApiError(403, jiraError([], { project: `Project ${project.key} is archived (read-only).` }));
  }
  // Projected key must match what the create will actually get — a stale
  // counter (issues written outside createIssue) otherwise previews an
  // already-taken key, as it did live (BENCH00-1 shown, real next = 501).
  const maxNum = await issueNumberMax(project.id);
  const previewNumber = Math.max(project.issueCounter + 1, maxNum + 1);
  // Planned CF values render verbatim — they are already Jira-shaped.
  const cfFields = Object.fromEntries(
    cfWrites.filter((w) => w.field.alias !== 'story_points').map((w) => [w.field.id, w.stored])
  );
  const fake = {
    id: 'preview',
    issueNumber: previewNumber,
    summary: data.summary,
    description: data.description ?? null,
    labels,
    dueDate,
    resolution: null,
    resolutionDate: null,
    parent,
    children: [],
    outLinks: [],
    inLinks: [],
    cfValues: [],
    components: components.map((component) => ({ component })),
    versionRefs: [
      ...fixVersions.map((version) => ({ kind: 'fix', version })),
      ...affectsVersions.map((version) => ({ kind: 'affects', version })),
    ],
    environment: data.environment ?? null,
    securityLevel,
    createdAt: new Date(),
    updatedAt: new Date(),
    project,
    issueType,
    status: defaultStatus,
    priority,
    sprint: null,
    assignee,
    reporter: actor.user,
    storyPoints:
      data.storyPoints ??
      (cfWrites.find((w) => w.field.alias === 'story_points')?.stored as number | null | undefined) ??
      null,
  };
  return { issue: toIssueResponse(fake as never, { cfFields }), changes: items };
}

export async function getIssueByKey(issueKey: string) {
  const { projectKey, issueNumber } = await parseIssueKey(issueKey);
  let issue = await prisma.issue.findFirst({
    where: {
      issueNumber,
      project: { key: projectKey },
    },
    include: issueInclude,
  });

  // 022: moved issues resolve via their old key (IssueKeyAlias) like Jira.
  if (!issue) {
    const alias = await prisma.issueKeyAlias.findUnique({
      where: { oldKey: issueKey.toUpperCase() },
      include: { issue: { include: issueInclude } },
    });
    issue = alias?.issue ?? null;
  }

  if (!issue) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }

  return issue;
}

export async function getIssueTransitions(issueKey: string, actor: Actor) {
  const issue = await getIssueByKey(issueKey);
  const { listAvailableTransitions } = await import('./workflowService.js');
  return listAvailableTransitions(issue, actor);
}

export interface TransitionBody {
  fields?: {
    resolution?: { name?: string; id?: string } | null;
    assignee?: { name?: string; accountId?: string } | null;
  };
  update?: {
    comment?: { add?: { body?: string } }[];
  };
}

export async function executeTransition(
  issueKey: string,
  transitionId: string,
  actor: Actor,
  body: TransitionBody = {}
) {
  const issue = await getIssueByKey(issueKey);
  const { performTransition } = await import('./workflowService.js');
  return performTransition(issue, transitionId, actor, body);
}

export interface UpdateIssueInput {
  summary?: string;
  description?: string | null;
  statusName?: string;
  priorityName?: string;
  issueTypeName?: string;
  assignee?: AssigneeRef | null; // undefined = untouched; null = unassign
  delegate?: AssigneeRef | null; // 047 — undefined = untouched; null = clear
  labels?: string[]; // set semantics
  labelsAdd?: string[]; // Jira `update` ops
  labelsRemove?: string[];
  dueDate?: string | null;
  resolutionName?: string | null;
  parentKey?: string | null;
  storyPoints?: number | null;
  reporter?: AssigneeRef | null; // undefined = untouched
  environment?: string | null; // undefined = untouched; null = clear
  timeTracking?: TimeTrackingInput;
  /** customfield_NNNNN / alias → value (Jira `fields` set semantics). */
  customFields?: Record<string, unknown>;
  /** customfield_NNNNN / alias → Jira `update` ops (add/remove/set). */
  customFieldOps?: Record<string, CfOp[]>;
  /** 019: merged fields+update ops for the three release collections. */
  componentOps?: {
    set?: { id?: string; name?: string }[];
    add?: { id?: string; name?: string }[];
    remove?: { id?: string; name?: string }[];
  };
  fixVersionOps?: {
    set?: { id?: string; name?: string }[];
    add?: { id?: string; name?: string }[];
    remove?: { id?: string; name?: string }[];
  };
  affectsVersionOps?: {
    set?: { id?: string; name?: string }[];
    add?: { id?: string; name?: string }[];
    remove?: { id?: string; name?: string }[];
  };
  /** 031: Jira `fields.security` / `update.security[].set` — {id|name}|null. */
  security?: unknown;
}

async function planUpdate(issue: Awaited<ReturnType<typeof getIssueByKey>>, data: UpdateIssueInput) {
  const updateData: {
    summary?: string;
    description?: string | null;
    statusId?: string;
    priorityId?: string;
    issueTypeId?: string;
    assigneeId?: string | null;
    reporterId?: string;
    environment?: string | null;
    labels?: string[];
    dueDate?: Date | null;
    resolutionId?: string | null;
    resolutionDate?: Date | null;
    parentId?: string | null;
    storyPoints?: number | null;
    originalEstimateSec?: number | null;
    remainingEstimateSec?: number | null;
    securityLevelId?: string | null;
    effSecurityLevelId?: string | null;
    delegateId?: string | null; // 047
  } = {};
  const items: Parameters<typeof recordChange>[3] = [];
  let priority: { id: string; name: string } | undefined;
  let issueType: { id: string; name: string } | undefined;
  let resolution: { id: string; name: string } | null | undefined;
  let parent: { id: string; issueNumber: number } | null | undefined;
  let assignee: Awaited<ReturnType<typeof resolveAssigneeRef>> | null | undefined;

  if (data.summary !== undefined && data.summary !== issue.summary) {
    if (!data.summary.trim()) {
      throw new JiraApiError(400, jiraError([], { 'fields.summary': 'Summary is required.' }));
    }
    updateData.summary = data.summary;
    items.push({ field: 'summary', fromString: issue.summary, toString: data.summary });
  }
  if (data.description !== undefined && data.description !== issue.description) {
    updateData.description = data.description;
    items.push({ field: 'description', fromString: issue.description, toString: data.description });
  }

  if (data.issueTypeName !== undefined) {
    const t = await prisma.issueType.findUnique({ where: { name: data.issueTypeName } });
    if (!t) {
      const all = await prisma.issueType.findMany({ select: { name: true } });
      await invalidEnum(
        'fields.issuetype',
        data.issueTypeName,
        all.map((x) => x.name)
      );
    }
    if (t!.id !== issue.issueTypeId) {
      // Re-validate hierarchy against the new type's level.
      if (t!.isSubtask && !issue.parentId) {
        throw new JiraApiError(400, jiraError([], { 'fields.parent': 'Subtasks require a parent.' }));
      }
      // Same scheme gate create applies — a type outside the project's scheme
      // is just as invalid via update.
      const { assertIssueTypeAllowed } = await import('./issueTypeSchemeService.js');
      await assertIssueTypeAllowed(issue.projectId, t!);
      await resolveParentRef(
        issue.parentId ? toIssueKey(issue.project.key, issue.parent!.issueNumber) : undefined,
        issue.project,
        t!,
        issue.id
      );
      issueType = t!;
      updateData.issueTypeId = t!.id;
      items.push({
        field: 'issuetype',
        from: issue.issueTypeId,
        fromString: issue.issueType.name,
        to: t!.id,
        toString: t!.name,
      });
    }
  }

  if (data.statusName !== undefined) {
    throw new JiraApiError(400, jiraError([], { status: "Field 'status' cannot be set. Use transitions." }));
  }

  if (data.priorityName !== undefined) {
    const p = await prisma.priority.findUnique({ where: { name: data.priorityName } });
    if (!p) {
      const all = await prisma.priority.findMany({ select: { name: true }, orderBy: { sequence: 'asc' } });
      await invalidEnum(
        'fields.priority',
        data.priorityName,
        all.map((x) => x.name)
      );
    }
    if (p!.id !== issue.priorityId) {
      priority = p!;
      updateData.priorityId = p!.id;
      items.push({
        field: 'priority',
        from: issue.priorityId,
        fromString: issue.priority.name,
        to: p!.id,
        toString: p!.name,
      });
    }
  }

  if (data.assignee !== undefined) {
    if (data.assignee === null) {
      if (issue.assigneeId !== null) {
        assignee = null;
        updateData.assigneeId = null;
        items.push({
          field: 'assignee',
          from: issue.assigneeId,
          fromString: issue.assignee?.displayName ?? null,
          to: null,
          toString: null,
        });
      }
    } else {
      const u = await resolveAssigneeRef(data.assignee);
      if (u && u.id !== issue.assigneeId) {
        assignee = u;
        updateData.assigneeId = u.id;
        items.push({
          field: 'assignee',
          from: issue.assigneeId,
          fromString: issue.assignee?.displayName ?? null,
          to: u.id,
          toString: u.displayName,
        });
      }
    }
  }

  // 047 US1 — delegate field. On change: history item + agent_session spawn.
  if (data.delegate !== undefined) {
    if (data.delegate === null) {
      if (issue.delegateId !== null) {
        updateData.delegateId = null;
        items.push({
          field: 'delegate',
          from: issue.delegateId,
          fromString: issue.delegate?.displayName ?? null,
          to: null,
          toString: null,
        });
      }
    } else {
      const u = await resolveDelegateRef(data.delegate);
      if (u && u.id !== issue.delegateId) {
        updateData.delegateId = u.id;
        items.push({
          field: 'delegate',
          from: issue.delegateId,
          fromString: issue.delegate?.displayName ?? null,
          to: u.id,
          toString: u.displayName,
        });
      }
    }
  }

  // 022: reporter + environment (Jira system fields; permission folded into EDIT_ISSUES per spec)
  if (data.reporter !== undefined && data.reporter !== null) {
    const u = await resolveAssigneeRef(data.reporter);
    if (u && u.id !== issue.reporterId) {
      updateData.reporterId = u.id;
      items.push({
        field: 'reporter',
        from: issue.reporterId,
        fromString: issue.reporter?.displayName ?? null,
        to: u.id,
        toString: u.displayName,
      });
    }
  }

  if (data.environment !== undefined) {
    const next = data.environment === null ? null : String(data.environment);
    const cur = issue.environment ?? null;
    if (next !== cur) {
      updateData.environment = next;
      items.push({ field: 'environment', fromString: cur, toString: next });
    }
  }

  // 031: fields.security / update.security[].set — level within project's scheme
  if (data.security !== undefined) {
    const { resolveLevelInput } = await import('./issueSecurityService.js');
    const next = (await resolveLevelInput(issue.projectId, data.security)) ?? null;
    if (next !== issue.securityLevelId) {
      updateData.securityLevelId = next;
      const nameOf = async (id: string | null) =>
        id ? ((await prisma.securityLevel.findUnique({ where: { id }, select: { name: true } }))?.name ?? id) : null;
      items.push({
        field: 'security',
        fromString: await nameOf(issue.securityLevelId),
        toString: await nameOf(next),
      });
    }
  }

  // labels: set, or add/remove ops (Jira `update` form)
  const labelsSet = data.labels !== undefined ? validateLabels(data.labels) : undefined;
  const labelsAdd = data.labelsAdd?.length ? validateLabels(data.labelsAdd) : [];
  const labelsRemove = data.labelsRemove?.length ? validateLabels(data.labelsRemove) : [];
  if (labelsSet !== undefined || labelsAdd.length || labelsRemove.length) {
    const cur = new Set(issue.labels);
    const next =
      labelsSet !== undefined
        ? new Set(labelsSet)
        : new Set([...cur, ...labelsAdd].filter((l) => !labelsRemove.includes(l)));
    const nextArr = [...next];
    if (nextArr.join(',') !== [...cur].join(',')) {
      updateData.labels = nextArr;
      items.push({ field: 'labels', fromString: [...cur].join(' ') || null, toString: nextArr.join(' ') || null });
    }
  }

  if (data.dueDate !== undefined) {
    const d = data.dueDate === null ? null : new Date(data.dueDate);
    if (d && Number.isNaN(d.getTime())) {
      throw new JiraApiError(400, jiraError([], { 'fields.duedate': 'Due date must be a valid date (YYYY-MM-DD).' }));
    }
    const curDue = issue.dueDate ? jiraDate(issue.dueDate) : null;
    const nextDue = d ? jiraDate(d) : null;
    if (curDue !== nextDue) {
      updateData.dueDate = d;
      items.push({ field: 'duedate', fromString: curDue, toString: nextDue });
    }
  }

  if (data.resolutionName !== undefined) {
    if (data.resolutionName === null) {
      if (issue.resolutionId) {
        resolution = null;
        updateData.resolutionId = null;
        updateData.resolutionDate = null;
        items.push({
          field: 'resolution',
          from: issue.resolutionId,
          fromString: issue.resolution?.name ?? null,
          to: null,
          toString: null,
        });
      }
    } else {
      const r = await prisma.resolution.findUnique({ where: { name: data.resolutionName } });
      if (!r) {
        const all = await prisma.resolution.findMany({ select: { name: true } });
        await invalidEnum(
          'fields.resolution',
          data.resolutionName,
          all.map((x) => x.name)
        );
      }
      if (r!.id !== issue.resolutionId) {
        resolution = r!;
        updateData.resolutionId = r!.id;
        updateData.resolutionDate = new Date();
        items.push({
          field: 'resolution',
          from: issue.resolutionId,
          fromString: issue.resolution?.name ?? null,
          to: r!.id,
          toString: r!.name,
        });
      }
    }
  }

  if (data.storyPoints !== undefined) {
    const pts = data.storyPoints === null ? null : Number(data.storyPoints);
    if (pts !== null && (!Number.isFinite(pts) || pts < 0)) {
      throw new JiraApiError(
        400,
        jiraError([], { 'fields.story_points': 'Story Points must be a non-negative number.' })
      );
    }
    if (pts !== issue.storyPoints) {
      updateData.storyPoints = pts;
      items.push({
        field: 'Story Points',
        fromString: issue.storyPoints === null ? null : String(issue.storyPoints),
        toString: pts === null ? null : String(pts),
      });
    }
  }

  if (data.parentKey !== undefined) {
    const { parent: p, set } = await resolveParentRef(data.parentKey, issue.project, issue.issueType, issue.id);
    if (set) {
      const nextId = p?.id ?? null;
      if (nextId !== issue.parentId) {
        parent = p;
        updateData.parentId = nextId;
        const toKey = p ? toIssueKey(issue.project.key, p.issueNumber) : null;
        const fromKey = issue.parent ? toIssueKey(issue.project.key, issue.parent.issueNumber) : null;
        items.push({ field: 'parent', from: issue.parentId, fromString: fromKey, to: nextId, toString: toKey });
      }
    }
  }

  // 031: keep the denormalized effective level in step with security/parent.
  if (updateData.securityLevelId !== undefined || updateData.parentId !== undefined) {
    const nextSecurity =
      updateData.securityLevelId !== undefined ? (updateData.securityLevelId as string | null) : issue.securityLevelId;
    const nextParentId = updateData.parentId !== undefined ? (updateData.parentId as string | null) : issue.parentId;
    let parentEff: string | null = null;
    if (nextParentId) {
      parentEff =
        nextParentId === issue.parentId
          ? ((issue.parent as { effSecurityLevelId?: string | null } | null)?.effSecurityLevelId ?? null)
          : ((await prisma.issue.findUnique({ where: { id: nextParentId }, select: { effSecurityLevelId: true } }))
              ?.effSecurityLevelId ?? null);
    }
    updateData.effSecurityLevelId = nextSecurity ?? parentEff;
  }

  const cfWrites = await planCfWrites(
    issue.projectId,
    data.customFields,
    data.customFieldOps,
    new Map((issue.cfValues ?? []).map((v) => [v.fieldId, v.value])),
    items,
    issue.storyPoints
  );

  const estimates = await planTimeTracking(
    data.timeTracking,
    issue.originalEstimateSec,
    issue.remainingEstimateSec,
    items
  );
  if (estimates.originalEstimateSec !== undefined) updateData.originalEstimateSec = estimates.originalEstimateSec;
  if (estimates.remainingEstimateSec !== undefined) updateData.remainingEstimateSec = estimates.remainingEstimateSec;

  // 031: screen gating — provided fields must be on the edit screen
  const { assertScreenFieldsAllowed } = await import('./screenService.js');
  await assertScreenFieldsAllowed(issue.projectId, issue.issueTypeId, 'edit', [
    ...(data.summary !== undefined ? ['summary'] : []),
    ...(data.description !== undefined ? ['description'] : []),
    ...(data.priorityName !== undefined ? ['priority'] : []),
    ...(data.issueTypeName !== undefined ? ['issuetype'] : []),
    ...(data.assignee !== undefined ? ['assignee'] : []),
    ...(data.labels !== undefined || data.labelsAdd?.length || data.labelsRemove?.length ? ['labels'] : []),
    ...(data.dueDate !== undefined ? ['duedate'] : []),
    ...(data.resolutionName !== undefined ? ['resolution'] : []),
    ...(data.reporter !== undefined ? ['reporter'] : []),
    ...(data.environment !== undefined ? ['environment'] : []),
    ...(data.security !== undefined ? ['security'] : []),
    ...(data.timeTracking !== undefined ? ['timetracking'] : []),
    ...(data.storyPoints !== undefined ? ['story_points'] : []),
    ...(data.parentKey !== undefined ? ['parent'] : []),
    ...(data.componentOps ? ['components'] : []),
    ...(data.fixVersionOps ? ['fixVersions'] : []),
    ...(data.affectsVersionOps ? ['versions'] : []),
    ...Object.keys(data.customFields ?? {}),
    ...Object.keys(data.customFieldOps ?? {}),
  ]);

  // 031: field config — hidden rejected; required fields may not be cleared
  const { assertFieldConfigEdit } = await import('./fieldConfigService.js');
  const updProvided = new Map<string, unknown>();
  if (data.summary !== undefined) updProvided.set('summary', data.summary);
  if (data.description !== undefined) updProvided.set('description', data.description);
  if (data.priorityName !== undefined) updProvided.set('priority', data.priorityName);
  if (data.issueTypeName !== undefined) updProvided.set('issuetype', data.issueTypeName);
  if (data.assignee !== undefined) updProvided.set('assignee', data.assignee);
  if (data.delegate !== undefined) updProvided.set('delegate', data.delegate);
  if (data.labels !== undefined) updProvided.set('labels', data.labels);
  if (data.dueDate !== undefined) updProvided.set('duedate', data.dueDate);
  if (data.resolutionName !== undefined) updProvided.set('resolution', data.resolutionName);
  if (data.reporter !== undefined) updProvided.set('reporter', data.reporter);
  if (data.environment !== undefined) updProvided.set('environment', data.environment);
  if (data.security !== undefined) updProvided.set('security', data.security);
  if (data.storyPoints !== undefined) updProvided.set('story_points', data.storyPoints);
  for (const [k, v] of Object.entries(data.customFields ?? {})) updProvided.set(k, v);
  for (const k of Object.keys(data.customFieldOps ?? {})) if (!updProvided.has(k)) updProvided.set(k, 'ops');
  const cfMerged = new Map<string, unknown>((issue.cfValues ?? []).map((v) => [v.fieldId, v.value]));
  for (const [k, v] of Object.entries(data.customFields ?? {})) cfMerged.set(k, v);
  const updCtx: Record<string, unknown> = {
    summary: updateData.summary !== undefined ? updateData.summary : issue.summary,
    description: updateData.description !== undefined ? updateData.description : issue.description,
    priority: priority?.name ?? issue.priority?.name,
    issuetype: issueType?.name ?? issue.issueType?.name,
    labels: updateData.labels ?? issue.labels,
    assignee: assignee ? assignee.displayName : issue.assignee?.displayName,
    duedate: updateData.dueDate !== undefined ? updateData.dueDate : issue.dueDate,
    environment: updateData.environment !== undefined ? updateData.environment : issue.environment,
    story_points: updateData.storyPoints !== undefined ? updateData.storyPoints : issue.storyPoints,
    ...Object.fromEntries(cfMerged),
  };
  await assertFieldConfigEdit(issue.projectId, issue.issueTypeId, updProvided, updCtx);

  return { updateData, items, priority, issueType, resolution, parent, assignee, cfWrites };
}

/** Jira field-level gates layered on EDIT_ISSUES (022/031 spec fields). */
async function checkFieldPermissions(
  actor: Actor,
  issue: { id: string; projectId: string; reporterId: string | null },
  data: UpdateIssueInput
) {
  if (data.reporter !== undefined && data.reporter !== null) {
    await requirePermission(actor, 'MODIFY_REPORTER', { projectId: issue.projectId, issue });
  }
  if (data.security !== undefined) {
    await requirePermission(actor, 'SET_ISSUE_SECURITY', { projectId: issue.projectId, issue });
  }
}

export async function updateIssue(issueKey: string, data: UpdateIssueInput, actor: Actor) {
  const issue = await getIssueByKey(issueKey);
  await assertIssueWritable(issue);
  await requirePermission(actor, 'EDIT_ISSUES', { projectId: issue.projectId, issue });
  await checkFieldPermissions(actor, issue, data);
  if (data.assignee !== undefined) await checkAssign(actor, issue, data.assignee);
  const { updateData, items, assignee, cfWrites } = await planUpdate(issue, data);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.issue.update({
      where: { id: issue.id },
      data: updateData,
      include: issueInclude,
    });
    // 031: unsecured descendants mirror the parent's new effective level.
    if (updateData.effSecurityLevelId !== undefined) {
      await cascadeEffectiveSecurity(issue.id, u.effSecurityLevelId, tx);
    }
    const { writeValue } = await import('./customFieldService.js');
    for (const w of cfWrites) {
      await writeValue(tx, w.field, u, w.stored);
      if (w.field.alias === 'story_points') {
        u.storyPoints = w.stored === null ? null : Number(w.stored);
      } else {
        const row = { fieldId: w.field.id, value: w.stored } as (typeof u.cfValues)[number];
        const idx = u.cfValues.findIndex((v) => v.fieldId === w.field.id);
        if (w.stored === null || w.stored === undefined) {
          if (idx >= 0) u.cfValues.splice(idx, 1);
        } else if (idx >= 0) u.cfValues[idx] = row;
        else u.cfValues.push(row);
      }
    }
    // 019: component/version collection ops (appends changelog items in-place)
    if (data.componentOps || data.fixVersionOps || data.affectsVersionOps) {
      const { syncIssueCollections } = await import('./componentVersionService.js');
      await syncIssueCollections(
        tx,
        issue.id,
        issue.projectId,
        {
          components: data.componentOps,
          fixVersions: data.fixVersionOps,
          affectsVersions: data.affectsVersionOps,
        },
        items
      );
    }
    await recordChange(tx, issue.id, actor, items);
    // 047 US1-2 — delegation spawns a session + event. The agent acts under
    // its own auth/policy — delegation changes triggering, never powers (FR-001).
    if (updateData.delegateId) {
      await tx.agentSession.create({
        data: {
          issueId: issue.id,
          agentUserId: updateData.delegateId,
          delegatorId: actor.user.id,
          trigger: 'delegate',
        },
      });
      await emitEvent(tx, actor, {
        type: 'agent_session.created',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: { issueKey, delegateId: updateData.delegateId },
      });
    }
    const fresh =
      data.componentOps || data.fixVersionOps || data.affectsVersionOps
        ? await tx.issue.findUniqueOrThrow({ where: { id: issue.id }, include: issueInclude })
        : u;
    await emitEvent(tx, actor, {
      type: 'jira:issue_updated',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issueKey,
        projectKey: issue.project.key,
        issue: toIssueResponse(fresh, {
          cfFields: {
            ...Object.fromEntries(
              (issue.cfValues ?? [])
                .filter((v) => !cfWrites.some((w) => w.field.id === v.fieldId))
                .map((v) => [v.fieldId, v.value])
            ),
            ...Object.fromEntries(
              cfWrites.filter((w) => w.field.alias !== 'story_points').map((w) => [w.field.id, w.stored])
            ),
          },
        }),
        changelog: { items },
      },
    });
    return u;
  });
  // Auto-watch: new assignee follows the issue (their own autowatch pref — 066).
  if (assignee && assignee.type === 'human' && assignee.id !== actor.user.id) {
    if (await autowatchAllowed(assignee.id, 'assign')) await addWatcher(issue.id, assignee.id);
  }
  return updated;
}

/** Validates + computes an update without persisting (dryRun). */
export async function previewUpdateIssue(issueKey: string, data: UpdateIssueInput, actor: Actor) {
  const issue = await getIssueByKey(issueKey);
  await assertIssueWritable(issue);
  await requirePermission(actor, 'EDIT_ISSUES', { projectId: issue.projectId, issue });
  await checkFieldPermissions(actor, issue, data);
  if (data.assignee !== undefined) await checkAssign(actor, issue, data.assignee);
  const { updateData, items, priority, issueType, resolution, parent, assignee, cfWrites } = await planUpdate(
    issue,
    data
  );
  const spWrite = cfWrites.find((w) => w.field.alias === 'story_points');
  const cfFields = {
    ...Object.fromEntries(
      (issue.cfValues ?? [])
        .filter((v) => !cfWrites.some((w) => w.field.id === v.fieldId))
        .map((v) => [v.fieldId, v.value])
    ),
    ...Object.fromEntries(cfWrites.filter((w) => w.field.alias !== 'story_points').map((w) => [w.field.id, w.stored])),
  };
  const fake = {
    ...issue,
    summary: updateData.summary ?? issue.summary,
    description: updateData.description !== undefined ? updateData.description : issue.description,
    labels: updateData.labels ?? issue.labels,
    dueDate: updateData.dueDate !== undefined ? updateData.dueDate : issue.dueDate,
    storyPoints: spWrite
      ? (spWrite.stored as number | null)
      : updateData.storyPoints !== undefined
        ? updateData.storyPoints
        : issue.storyPoints,
    status: issue.status,
    priority: priority ?? issue.priority,
    issueType: issueType ?? issue.issueType,
    resolution: resolution === undefined ? issue.resolution : resolution,
    resolutionDate: updateData.resolutionDate !== undefined ? updateData.resolutionDate : issue.resolutionDate,
    parent: parent === undefined ? issue.parent : parent,
    assignee: assignee === undefined ? issue.assignee : assignee,
    reporter: issue.reporter ?? actor.user,
    updatedAt: new Date(),
  };
  void actor;
  return { issue: toIssueResponse(fake as never, { cfFields }), changes: items };
}

/** ASSIGN_ISSUES on the actor; ASSIGNABLE_USER on the resolved target (Jira).
 *  Returns the resolved target user (null when ref is null — unassign). */
export async function checkAssign(actor: Actor, issue: { projectId: string }, ref: AssigneeRef | null) {
  await requirePermission(actor, 'ASSIGN_ISSUES', { projectId: issue.projectId });
  if (!ref) return null;
  const target = await resolveAssigneeRef(ref);
  if (
    target &&
    !(await hasPermission({ user: target, channel: actor.channel } as Actor, 'ASSIGNABLE_USER', {
      projectId: issue.projectId,
    }))
  ) {
    throw new JiraApiError(
      403,
      jiraError([], { assignee: `User '${target.displayName}' cannot be assigned issues in this project.` })
    );
  }
  return target;
}

export async function assignIssue(issueKey: string, assignee: AssigneeRef | null, actor: Actor) {
  return updateIssue(issueKey, { assignee }, actor);
}

export async function previewAssignIssue(issueKey: string, assignee: AssigneeRef | null, actor: Actor) {
  return previewUpdateIssue(issueKey, { assignee }, actor);
}

/** Child issues of a parent (epic children or subtasks). */
export async function listChildren(issueId: string, projectId: string, actor?: Actor) {
  // Single-project surface: parents and children share a project
  // (resolveParentRef rejects cross-project parents), so the 064 pattern is
  // one canSeeProjectId check + the security-only predicate.
  if (actor && !(await canSeeProjectId(actor, projectId))) {
    return [];
  }
  return prisma.issue.findMany({
    where: actor ? { AND: [{ parentId: issueId }, await securityGateWhere(actor)] } : { parentId: issueId },
    orderBy: { issueNumber: 'asc' },
    include: issueInclude,
  });
}

/** Single-use, expiring token authorising a delete after a dryRun preview
    (065 audit F4 — replaces the deterministic never-expiring HMAC). */
export function deletePreviewToken(issueId: string, subtaskIds: string[]) {
  return issueConfirmToken('delete', `${issueId}:${subtaskIds.sort().join(',')}`);
}

/**
 * Jira delete semantics: subtasks require deleteSubtasks=true; children that are
 * epic-children get parent cleared (changelog written) — they are not deleted.
 */
export async function planDelete(issueKey: string, deleteSubtasks: boolean) {
  const issue = await getIssueByKey(issueKey);
  await assertIssueWritable(issue);
  const subtasks = issue.children.filter((c) => c.issueType.isSubtask);
  const epicChildren = issue.children.filter((c) => !c.issueType.isSubtask);
  if (subtasks.length && !deleteSubtasks) {
    throw new JiraApiError(
      400,
      jiraError([], {
        deleteSubtasks: `Issue has ${subtasks.length} subtask(s). Pass deleteSubtasks=true to delete them too.`,
      })
    );
  }
  return { issue, subtasks, epicChildren };
}

export async function previewDeleteIssue(issueKey: string, deleteSubtasks: boolean) {
  const { issue, subtasks, epicChildren } = await planDelete(issueKey, deleteSubtasks);
  return {
    key: issueKey,
    deletesSubtasks: subtasks.map((c) => toIssueKey(issue.project.key, c.issueNumber)),
    clearsParentOn: epicChildren.map((c) => toIssueKey(issue.project.key, c.issueNumber)),
    confirmToken: await deletePreviewToken(
      issue.id,
      subtasks.map((c) => c.id)
    ),
  };
}

export async function deleteIssue(
  issueKey: string,
  deleteSubtasks: boolean,
  confirmToken: string | undefined,
  actor: Actor
) {
  const { issue, subtasks, epicChildren } = await planDelete(issueKey, deleteSubtasks);
  await requirePermission(actor, 'DELETE_ISSUES', { projectId: issue.projectId, issue });
  const consumed = await consumeConfirmToken(
    'delete',
    `${issue.id}:${subtasks
      .map((c) => c.id)
      .sort()
      .join(',')}`,
    confirmToken
  );
  if (!consumed) {
    throw new JiraApiError(
      400,
      jiraError([], {
        confirmToken: 'Deletions require a confirmToken from a ?dryRun=true preview of this same delete.',
      })
    );
  }

  const key = toIssueKey(issue.project.key, issue.issueNumber);
  const issueSnapshot = toIssueResponse(issue);
  const attRows = await prisma.$transaction(async (tx) => {
    // Epic children lose their parent (changelog + event on the child).
    for (const child of epicChildren) {
      await tx.issue.update({
        where: { id: child.id },
        data: { parentId: null, effSecurityLevelId: child.securityLevelId },
      });
      // The child's own unsecured descendants mirror its new effective level.
      await cascadeEffectiveSecurity(child.id, child.securityLevelId, tx);
      const items = [{ field: 'parent', from: issue.id, fromString: key, to: null, toString: null }];
      await recordChange(tx as never, child.id, actor, items);
      const childIssue = await tx.issue.findUnique({ where: { id: child.id }, include: issueInclude });
      await emitEvent(tx, actor, {
        type: 'jira:issue_updated',
        projectId: issue.projectId,
        issueId: child.id,
        payload: {
          issueKey: toIssueKey(issue.project.key, child.issueNumber),
          projectKey: issue.project.key,
          issue: childIssue ? toIssueResponse(childIssue) : null,
          changelog: { items },
        },
      });
    }
    const ids = [issue.id, ...subtasks.map((s) => s.id)];
    // Emit delete events BEFORE removing rows — events survive (payload snapshot).
    await emitEvent(tx, actor, {
      type: 'jira:issue_deleted',
      projectId: issue.projectId,
      issueId: null,
      payload: {
        issueKey: key,
        projectKey: issue.project.key,
        issue: issueSnapshot,
        deletedSubtasks: subtasks.map((s) => toIssueKey(issue.project.key, s.issueNumber)),
      },
    });
    // ChangeHistory.issueId is Restrict — remove histories before the issues.
    // Notifications/Watchers/RecentViews cascade via FK; DomainEvents persist.
    const histories = await tx.changeHistory.findMany({
      where: { issueId: { in: ids } },
      select: { id: true },
    });
    await tx.changeItem.deleteMany({ where: { historyId: { in: histories.map((h) => h.id) } } });
    await tx.changeHistory.deleteMany({ where: { issueId: { in: ids } } });
    // Capture stored-bytes keys before the FK cascade removes the rows (018 —
    // bytes can't be deleted inside the tx or a rollback would lose them).
    const attRows = await tx.attachment.findMany({
      where: { issueId: { in: ids } },
      select: { storagePath: true, thumbPath: true },
    });
    await tx.issue.deleteMany({ where: { id: { in: ids } } });
    return attRows;
  });
  const keys = attRows.flatMap((a) => [a.storagePath, a.thumbPath].filter((k): k is string => Boolean(k)));
  if (keys.length) {
    const { getDurableRunner } = await import('../lib/jobs.js');
    await getDurableRunner()
      .enqueue('attachment:purge', { keys }, { key: `attachment:purge:${issue.id}` })
      .catch(() => undefined);
  }
  return { key, deleted: 1 + subtasks.length, reparented: epicChildren.length };
}

/** Validates transition + returns the would-be changes without persisting. */
export async function previewTransition(
  issueKey: string,
  transitionId: string,
  actor: Actor,
  body: TransitionBody = {}
) {
  const issue = await getIssueByKey(issueKey);
  const { performTransition } = await import('./workflowService.js');
  return performTransition(issue, transitionId, actor, body, { dryRun: true });
}

export interface IssueViewOptions {
  /** Jira field ids to include; undefined / *all = all fields; *navigable = navigable set. */
  fields?: string[];
  /** 'changelog' | 'names' | 'schema' (changelog is attached by expandIssueResponse). */
  expand?: string[];
  /** Caller user id — personalizes watches.isWatching / votes.hasVoted. */
  actorId?: string;
  /** Ids of embedded related issues (parent/children/link targets) the caller
   *  may see — from visibilityService.visibleIssueIds. When provided, hidden
   *  relations are omitted: invisible subtasks/link targets drop out and an
   *  invisible parent renders as absent (existence-hiding, Jira parity). */
  visibleRelIds?: ReadonlySet<string>;
  /** Precomputed customfield_NNNNN → Jira value (from cfFieldsForIssues). */
  cfFields?: Record<string, unknown>;
  /** Precomputed worklog sums + config (worklogService.issueTimeData) — without
   *  it only the estimate columns are emitted and spent-derived keys are omitted. */
  tt?: {
    selfSpentSec?: number;
    childrenSpentSec: number;
    childrenOriginalSec: number;
    childrenRemainingSec: number;
    worklogTotal: number;
    worklogs?: import('@prisma/client').Worklog[];
    cfg: import('../lib/duration.js').TimeTrackingConfig;
  };
}

/** Ids of every issue embedded in these rows' relations — feed to
 *  visibilityService.visibleIssueIds for the visibleRelIds render option. */
export function relatedIssueIds(
  issues: readonly {
    parent?: { id: string } | null;
    children?: { id: string }[];
    outLinks?: { inwardIssue?: { id: string } | null }[];
    inLinks?: { outwardIssue?: { id: string } | null }[];
  }[]
): string[] {
  const ids = new Set<string>();
  for (const i of issues) {
    if (i.parent) ids.add(i.parent.id);
    for (const c of i.children ?? []) ids.add(c.id);
    for (const l of i.outLinks ?? []) if (l.inwardIssue) ids.add(l.inwardIssue.id);
    for (const l of i.inLinks ?? []) if (l.outwardIssue) ids.add(l.outwardIssue.id);
  }
  return [...ids];
}

export function toIssueResponse(
  issue: {
    id: string;
    issueNumber: number;
    summary: string;
    description: string | null;
    createdAt: Date;
    updatedAt: Date;
    project: { id: string; key: string; name: string; projectType: string };
    issueType: { id: string; name: string; isSubtask: boolean; hierarchyLevel: number };
    status: { id: string; name: string; category: string };
    priority: { id: string; name: string };
    sprint?: { id: string; name: string } | null;
    assignee?: {
      id: string;
      displayName: string;
      email: string;
      type: string;
      active: boolean;
      timeZone: string;
    } | null;
    delegate?: {
      id: string;
      displayName: string;
      email: string;
      type: string;
      active: boolean;
      timeZone: string;
    } | null;
    reporter?: {
      id: string;
      displayName: string;
      email: string;
      type: string;
      active: boolean;
      timeZone: string;
    } | null;
    labels?: string[];
    dueDate?: Date | null;
    storyPoints?: number | null;
    originalEstimateSec?: number | null;
    remainingEstimateSec?: number | null;
    resolution?: { id: string; name: string } | null;
    resolutionDate?: Date | null;
    parent?: {
      id: string;
      issueNumber: number;
      summary?: string;
      project: { key: string };
      issueType?: { id: string; name: string; isSubtask: boolean; hierarchyLevel: number };
      status?: { id: string; name: string; category: string };
    } | null;
    children?: {
      id: string;
      issueNumber: number;
      summary: string;
      originalEstimateSec?: number | null;
      remainingEstimateSec?: number | null;
      project: { key: string };
      issueType: { id: string; name: string; isSubtask: boolean; hierarchyLevel: number };
      status?: { id: string; name: string; category: string };
    }[];
    outLinks?: {
      id: string;
      type: { id: string; name: string; inward: string; outward: string };
      inwardIssue: {
        id: string;
        issueNumber: number;
        project: { key: string };
        status?: { id: string; name: string; category: string };
      };
    }[];
    inLinks?: {
      id: string;
      type: { id: string; name: string; inward: string; outward: string };
      outwardIssue: {
        id: string;
        issueNumber: number;
        project: { key: string };
        status?: { id: string; name: string; category: string };
      };
    }[];
    components?: { component: { id: string; name: string; description?: string | null } }[];
    versionRefs?: {
      kind: string;
      version: {
        id: string;
        name: string;
        description?: string | null;
        released: boolean;
        archived: boolean;
        releaseDate?: Date | null;
      };
    }[];
    attachments?: AttachmentWithAuthor[];
    watchers?: { userId: string }[];
    votes?: { userId: string }[];
    remoteLinks?: unknown[];
    environment?: string | null;
  },
  opts: IssueViewOptions = {}
) {
  const allFields: Record<string, unknown> = {
    summary: issue.summary,
    description: issue.description ?? undefined,
    project: {
      id: issue.project.id,
      key: issue.project.key,
      name: issue.project.name,
      projectTypeKey: issue.project.projectType,
    },
    issuetype: {
      id: issue.issueType.id,
      name: issue.issueType.name,
      subtask: issue.issueType.isSubtask,
      hierarchyLevel: issue.issueType.hierarchyLevel,
    },
    status: {
      id: issue.status.id,
      name: issue.status.name,
      statusCategory: toStatusCategory(issue.status.category),
    },
    priority: { id: issue.priority.id, name: issue.priority.name },
    assignee: issue.assignee ? toUserResponse(issue.assignee as never) : null,
    delegate: issue.delegate ? toUserResponse(issue.delegate as never) : null,
    reporter: issue.reporter ? toUserResponse(issue.reporter as never) : null,
    sprint: issue.sprint ? { id: issue.sprint.id, name: issue.sprint.name } : null,
    labels: issue.labels ?? [],
    duedate: issue.dueDate ? jiraDate(issue.dueDate) : null,
    resolution: issue.resolution ? { id: issue.resolution.id, name: issue.resolution.name } : null,
    resolutiondate: issue.resolutionDate?.toISOString() ?? null,
    story_points: issue.storyPoints ?? null,
    components: (issue.components ?? []).map((r) => ({
      id: r.component.id,
      name: r.component.name,
      description: r.component.description ?? undefined,
      self: resourceSelf(`/rest/api/2/component/${r.component.id}`),
    })),
    fixVersions: (issue.versionRefs ?? [])
      .filter((r) => r.kind === 'fix')
      .map((r) => ({
        id: r.version.id,
        name: r.version.name,
        description: r.version.description ?? undefined,
        released: r.version.released,
        archived: r.version.archived,
        releaseDate: r.version.releaseDate ? jiraDate(r.version.releaseDate) : undefined,
        self: resourceSelf(`/rest/api/2/version/${r.version.id}`),
      })),
    versions: (issue.versionRefs ?? [])
      .filter((r) => r.kind === 'affects')
      .map((r) => ({
        id: r.version.id,
        name: r.version.name,
        description: r.version.description ?? undefined,
        released: r.version.released,
        archived: r.version.archived,
        releaseDate: r.version.releaseDate ? jiraDate(r.version.releaseDate) : undefined,
        self: resourceSelf(`/rest/api/2/version/${r.version.id}`),
      })),
    attachment: (issue.attachments ?? []).map(toAttachmentResponse),
    parent:
      issue.parent && (!opts.visibleRelIds || opts.visibleRelIds.has(issue.parent.id))
        ? {
            id: issue.parent.id,
            key: toIssueKey(issue.parent.project.key, issue.parent.issueNumber),
            fields: {
              summary: issue.parent.summary,
              issuetype: issue.parent.issueType
                ? {
                    id: issue.parent.issueType.id,
                    name: issue.parent.issueType.name,
                    subtask: issue.parent.issueType.isSubtask,
                    hierarchyLevel: issue.parent.issueType.hierarchyLevel,
                  }
                : undefined,
              status: issue.parent.status
                ? {
                    id: issue.parent.status.id,
                    name: issue.parent.status.name,
                    statusCategory: toStatusCategory(issue.parent.status.category),
                  }
                : undefined,
            },
          }
        : undefined,
    subtasks: (issue.children ?? [])
      .filter((c) => c.issueType.isSubtask && (!opts.visibleRelIds || opts.visibleRelIds.has(c.id)))
      .map((c) => ({
        id: c.id,
        key: toIssueKey(c.project.key, c.issueNumber),
        fields: {
          summary: c.summary,
          issuetype: {
            id: c.issueType.id,
            name: c.issueType.name,
            subtask: c.issueType.isSubtask,
            hierarchyLevel: c.issueType.hierarchyLevel,
          },
          status: c.status
            ? { id: c.status.id, name: c.status.name, statusCategory: toStatusCategory(c.status.category) }
            : undefined,
        },
      })),
    issuelinks: [
      ...(issue.outLinks ?? [])
        .filter((l) => !opts.visibleRelIds || opts.visibleRelIds.has(l.inwardIssue.id))
        .map((l) => ({
          id: l.id,
          type: { id: l.type.id, name: l.type.name, inward: l.type.inward, outward: l.type.outward },
          inwardIssue: {
            id: l.inwardIssue.id,
            key: toIssueKey(l.inwardIssue.project.key, l.inwardIssue.issueNumber),
            fields: l.inwardIssue.status
              ? {
                  status: {
                    id: l.inwardIssue.status.id,
                    name: l.inwardIssue.status.name,
                    statusCategory: toStatusCategory(l.inwardIssue.status.category),
                  },
                }
              : undefined,
          },
        })),
      ...(issue.inLinks ?? [])
        .filter((l) => !opts.visibleRelIds || opts.visibleRelIds.has(l.outwardIssue.id))
        .map((l) => ({
          id: l.id,
          type: { id: l.type.id, name: l.type.name, inward: l.type.inward, outward: l.type.outward },
          outwardIssue: {
            id: l.outwardIssue.id,
            key: toIssueKey(l.outwardIssue.project.key, l.outwardIssue.issueNumber),
            fields: l.outwardIssue.status
              ? {
                  status: {
                    id: l.outwardIssue.status.id,
                    name: l.outwardIssue.status.name,
                    statusCategory: toStatusCategory(l.outwardIssue.status.category),
                  },
                }
              : undefined,
          },
        })),
    ],
    watches: {
      self: resourceSelf(`/rest/api/2/issue/${toIssueKey(issue.project.key, issue.issueNumber)}/watchers`),
      watchCount: (issue.watchers ?? []).length,
      isWatching: (issue.watchers ?? []).some((w) => w.userId === opts.actorId),
    },
    votes: {
      self: resourceSelf(`/rest/api/2/issue/${toIssueKey(issue.project.key, issue.issueNumber)}/votes`),
      votes: (issue.votes ?? []).length,
      hasVoted: (issue.votes ?? []).some((v) => v.userId === opts.actorId),
    },
    environment: issue.environment ?? undefined,
    // 033 — board card indicators: days-in-column + aggregate counts
    statuschangedate: ((issue as { statusChangedAt?: Date | null }).statusChangedAt ?? issue.createdAt).toISOString(),
    comment: (issue as { _count?: { comments: number } })._count
      ? { total: (issue as { _count?: { comments: number } })._count!.comments }
      : undefined,
    issuelinkCount: (issue as { _count?: { outLinks: number; inLinks: number } })._count
      ? (issue as { _count?: { outLinks: number; inLinks: number } })._count!.outLinks +
        (issue as { _count?: { outLinks: number; inLinks: number } })._count!.inLinks
      : undefined,
    attachmentCount: (issue as { _count?: { attachments: number } })._count?.attachments,
    // 031: effective security level = own ?? inherited from parent (Jira)
    security:
      (issue as { securityLevel?: { id: string; name: string } | null }).securityLevel ??
      (issue as { parent?: { securityLevel?: { id: string; name: string } | null } }).parent?.securityLevel ??
      undefined,
    created: issue.createdAt.toISOString(),
    updated: issue.updatedAt.toISOString(),
    ...timeFields(issue, opts, toIssueKey(issue.project.key, issue.issueNumber)),
    ...(opts.cfFields ?? {}),
  };

  let fields = allFields;
  if (opts.fields?.length) {
    const wanted = new Set(opts.fields.map((f) => f.toLowerCase()));
    if (wanted.has('*all')) {
      // all fields — no-op
    } else if (wanted.has('*navigable')) {
      fields = Object.fromEntries(Object.entries(allFields).filter(([k]) => k !== 'sprint'));
    } else {
      fields = Object.fromEntries(Object.entries(allFields).filter(([k]) => wanted.has(k)));
    }
  }

  return {
    id: issue.id,
    key: toIssueKey(issue.project.key, issue.issueNumber),
    self: issueSelf(toIssueKey(issue.project.key, issue.issueNumber)),
    fields,
  };
}

/** Jira timetracking/progress/worklog fields — columns always; spent keys only when tt provided. */
function timeFields(
  issue: { id: string; originalEstimateSec?: number | null; remainingEstimateSec?: number | null },
  opts: IssueViewOptions,
  issueKey: string
) {
  if (!opts.tt) {
    // Estimates are on the row — emit them; spent-derived keys stay absent.
    const orig = issue.originalEstimateSec ?? null;
    const rem = issue.remainingEstimateSec ?? null;
    if (orig === null && rem === null) return { timetracking: {} };
    return { timetracking: {}, timeoriginalestimate: orig, timeestimate: rem };
  }
  return timeTrackingFields(issue, opts.tt as never, opts.tt.cfg, issueKey);
}

/**
 * Custom-field values for one issue row (from issueInclude's cfValues) shaped
 * for toIssueResponse's cfFields option — every applicable field, null-filled.
 */
export async function cfFieldsForIssue(
  issue: {
    id: string;
    projectId: string;
    storyPoints?: number | null;
    cfValues?: { fieldId: string; value: unknown }[];
  },
  defs?: import('./customFieldService.js').FieldWithContexts[]
): Promise<Record<string, unknown>> {
  const { cfFieldsForIssue: impl } = await import('./customFieldService.js');
  return impl(issue, defs);
}

/** toIssueResponse + custom-field values (async because field defs are DB-backed). */
export async function toIssueResponseWithCf(
  issue: Parameters<typeof toIssueResponse>[0] & {
    id: string;
    projectId: string;
    storyPoints?: number | null;
    cfValues?: { fieldId: string; value: unknown }[];
    children?: { id: string }[];
  },
  opts: IssueViewOptions = {},
  defs?: import('./customFieldService.js').FieldWithContexts[]
) {
  const cfFields = opts.cfFields ?? (await cfFieldsForIssue(issue, defs));
  const tt =
    opts.tt ??
    (await import('./worklogService.js').then(async (m) => {
      const { data, cfg } = await m.issueTimeData(issue);
      return { ...data, cfg };
    }));
  return toIssueResponse(issue, { ...opts, cfFields, tt });
}

/**
 * Attaches requested expansions (changelog, names, schema) to a Jira issue
 * response produced by toIssueResponse.
 */
export async function expandIssueResponse(
  response: Record<string, unknown>,
  issue: { id: string },
  expand: string[] | undefined,
  prefetched?: {
    changelog?: { total: number; histories: Awaited<ReturnType<typeof getChangelog>>['histories'] };
    cfDefs?: import('./customFieldService.js').FieldWithContexts[];
  }
) {
  if (!expand?.length) return response;

  if (expand.includes('changelog')) {
    const maxResults = 50;
    const { total, histories } = prefetched?.changelog ?? (await getChangelog(issue.id, 0, maxResults));
    response.changelog = {
      startAt: 0,
      maxResults,
      total,
      histories: histories.map(toHistoryResponse),
    };
  }
  const fieldsObj = (response.fields ?? {}) as Record<string, unknown>;
  const wantsNames = expand.includes('names');
  const wantsSchema = expand.includes('schema');
  let cfDefs = prefetched?.cfDefs;
  if (!cfDefs && (wantsNames || wantsSchema) && Object.keys(fieldsObj).some((k) => k.startsWith('customfield_'))) {
    const { listFields } = await import('./customFieldService.js');
    cfDefs = await listFields();
  }
  if (wantsNames) {
    const names: Record<string, string> = {};
    for (const k of Object.keys(fieldsObj)) {
      if (FIELD_NAME_MAP[k]) names[k] = FIELD_NAME_MAP[k];
      else if (k.startsWith('customfield_')) {
        const f = cfDefs?.find((d) => d.id === k);
        if (f) names[k] = f.name;
      }
    }
    response.names = names;
  }
  if (wantsSchema) {
    const schema: Record<string, unknown> = {};
    for (const f of FIELD_DEFS) {
      if (f.id in fieldsObj) schema[f.id] = f.schema;
    }
    for (const k of Object.keys(fieldsObj)) {
      if (k.startsWith('customfield_')) {
        const f = cfDefs?.find((d) => d.id === k);
        if (f) {
          const { cfSchema } = await import('../lib/cfTypes.js');
          schema[k] = cfSchema(f);
        }
      }
    }
    response.schema = schema;
  }
  return response;
}

/** Parse Jira `fields`/`expand` params — accepts comma string or array. */
export function parseSelection(input: unknown): string[] | undefined {
  if (!input) return undefined;
  const arr = Array.isArray(input) ? input : String(input).split(',');
  const cleaned = arr.map((s) => String(s).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
}

// ---------- 060 US7 — issue archiving (Jira DC) ----------

/**
 * Jira DC archive: the issue leaves every read surface (securityGateWhere
 * ANDs `archived:false`; canSeeIssue 404s single reads + writes) and becomes
 * read-only. Restorable via /issue/{key}/restore — the only path allowed to
 * see an archived issue.
 */
export async function archiveIssue(issueKey: string, actor: Actor, dryRun = false) {
  const issue = await getIssueByKey(issueKey);
  await requirePermission(actor, 'ARCHIVE_ISSUES', { projectId: issue.projectId, issue });
  if (issue.archived) {
    throw new JiraApiError(400, jiraError(['Issue is already archived.']));
  }
  if (dryRun) return { key: issueKey, wouldArchive: true };
  await prisma.$transaction(async (tx) => {
    await tx.issue.update({
      where: { id: issue.id },
      data: { archived: true, archivedAt: new Date(), archivedById: actor.user.id },
    });
    await emitEvent(tx, actor, {
      type: 'issue.archived',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issueKey },
    });
  });
}

export async function restoreIssue(issueKey: string, actor: Actor, dryRun = false) {
  const issue = await getIssueByKey(issueKey);
  await requirePermission(actor, 'RESTORE_ISSUES', { projectId: issue.projectId, issue });
  if (!issue.archived) {
    throw new JiraApiError(400, jiraError(['Issue is not archived.']));
  }
  if (dryRun) return { key: issueKey, wouldRestore: true };
  await prisma.$transaction(async (tx) => {
    await tx.issue.update({
      where: { id: issue.id },
      data: { archived: false, archivedAt: null, archivedById: null },
    });
    await emitEvent(tx, actor, {
      type: 'issue.restored',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issueKey },
    });
  });
}

/** Archived-issue browse for the project settings "Archived" section —
    Jira DC's Incidencias archivadas list. RESTORE_ISSUES-gated at the route. */
export async function listArchivedIssues(projectId: string, query?: string) {
  const issues = await prisma.issue.findMany({
    where: {
      projectId,
      archived: true,
      ...(query ? { summary: { contains: query, mode: 'insensitive' as const } } : {}),
    },
    select: {
      id: true,
      issueNumber: true,
      summary: true,
      archivedAt: true,
      archivedById: true,
      issueType: { select: { name: true } },
      status: { select: { name: true } },
      project: { select: { key: true } },
    },
    orderBy: { archivedAt: 'desc' },
    take: 500,
  });
  const actorIds = [...new Set(issues.map((i) => i.archivedById).filter((x): x is string => !!x))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } })
    : [];
  const nameById = new Map(actors.map((a) => [a.id, a.displayName]));
  return issues.map((i) => ({
    ...i,
    archivedBy: i.archivedById ? { displayName: nameById.get(i.archivedById) ?? i.archivedById } : null,
  }));
}

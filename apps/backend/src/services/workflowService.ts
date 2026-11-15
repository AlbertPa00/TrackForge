import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { toStatusCategory } from './metaService.js';
import { recordChange } from './changelogService.js';
import { emitEvent } from './eventService.js';
import { checkAssign, issueInclude, toIssueResponse } from './issueService.js';
import { toUserResponse } from './userService.js';
import type { Actor } from '../lib/auth.js';
import type { Prisma } from '@prisma/client';
import { requirePermission, hasPermission, userInProjectRole, userInGroup } from './permissionService.js';
import { assertIssueWritable, projectByKeyOr404 } from './projectService.js';

export const workflowInclude = {
  statuses: { include: { status: true }, orderBy: { position: 'asc' as const } },
  transitions: {
    include: { fromStatus: true, toStatus: true, rules: true },
    orderBy: { position: 'asc' as const },
  },
} as const;

export type WorkflowFull = Prisma.WorkflowGetPayload<{ include: typeof workflowInclude }>;
export type TransitionFull = WorkflowFull['transitions'][number];

/**
 * The workflow governing an issue type in a project (031 US3):
 * workflowScheme -> mapping[issueType] ?? scheme.default -> project.workflowId
 * (legacy single binding) -> 'Simple' fallback.
 */
export async function getProjectWorkflow(projectId: string, issueTypeId?: string | null): Promise<WorkflowFull> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  let id: string | null | undefined;
  if (project?.workflowSchemeId) {
    const scheme = await prisma.workflowScheme.findUnique({
      where: { id: project.workflowSchemeId },
      include: { items: true },
    });
    id =
      (issueTypeId ? scheme?.items.find((i) => i.issueTypeId === issueTypeId)?.workflowId : undefined) ??
      scheme?.defaultWorkflowId;
  } else {
    id = project?.workflowId;
  }
  const workflow = id
    ? await prisma.workflow.findUnique({ where: { id }, include: workflowInclude })
    : await prisma.workflow.findUnique({ where: { name: 'Simple' }, include: workflowInclude });
  if (!workflow) {
    throw new JiraApiError(500, jiraError(['No workflow configured for this project.']));
  }
  return workflow;
}

/** Initial status for a project (workflow initial, else first todo status). */
export async function initialStatusForProject(projectId: string, issueTypeId?: string | null) {
  const wf = await getProjectWorkflow(projectId, issueTypeId);
  const initial = wf.statuses.find((s) => s.isInitial)?.status ?? wf.statuses[0]?.status;
  if (initial) return initial;
  const fallback = await prisma.status.findFirst({ where: { category: 'todo' }, orderBy: { sequence: 'asc' } });
  if (!fallback) throw new JiraApiError(500, jiraError(['Default status not configured.']));
  return fallback;
}

// --- rules ---

interface IssueCtx {
  id: string;
  statusId: string;
  issueTypeId?: string;
  assigneeId: string | null;
  reporterId: string | null;
  resolutionId: string | null;
}

async function conditionPasses(
  rule: { type: string; config?: unknown },
  issue: IssueCtx & { projectId?: string },
  actor: Actor,
  leadId?: string | null
): Promise<boolean> {
  const cfg = (rule.config ?? {}) as { role?: string; group?: string; permission?: string };
  switch (rule.type) {
    case 'onlyAssignee':
      return issue.assigneeId === actor.user.id;
    case 'onlyReporter':
      return issue.reporterId === actor.user.id;
    case 'onlyAdmin':
      return actor.user.isAdmin;
    // Jira "Only Project Lead" — the ACTOR must be the lead. Reporter being
    // the lead must not open the transition to everyone (053 US2).
    case 'onlyProjectLead':
      return actor.user.isAdmin || leadId === actor.user.id;
    case 'userInRole':
      return issue.projectId ? userInProjectRole(actor, issue.projectId, cfg.role ?? '') : false;
    case 'userInGroup':
      return userInGroup(actor, cfg.group ?? '');
    case 'hasPermission':
      return issue.projectId
        ? hasPermission(actor, cfg.permission ?? '', { projectId: issue.projectId, issue })
        : false;
    case 'allowAll':
    default:
      return true;
  }
}

export function transitionScreenFields(t: TransitionFull) {
  const resolutionRequired = t.rules.some((r) => r.kind === 'validator' && r.type === 'resolutionRequired');
  const fields: Record<string, unknown> = {};
  for (const f of t.screenFields) {
    if (f === 'resolution') {
      fields.resolution = {
        required: resolutionRequired,
        name: 'Resolution',
        schema: { type: 'resolution' },
        operations: ['set'],
      };
    } else if (f === 'comment') {
      fields.comment = { required: false, name: 'Comment', schema: { type: 'string' }, operations: ['add'] };
    } else if (f === 'assignee') {
      fields.assignee = { required: false, name: 'Assignee', schema: { type: 'user' }, operations: ['set'] };
    }
  }
  return Object.keys(fields).length ? fields : undefined;
}

function toTransitionResponse(t: TransitionFull) {
  return {
    id: t.id,
    name: t.name,
    hasScreen: t.screenFields.length > 0,
    isGlobal: t.fromStatusId === null,
    isInitial: false,
    isAvailable: true,
    isConditional: t.rules.some((r) => r.kind === 'condition'),
    fields: transitionScreenFields(t),
    to: {
      id: t.toStatus.id,
      name: t.toStatus.name,
      description: '',
      iconUrl: '',
      statusCategory: toStatusCategory(t.toStatus.category),
    },
  };
}

/** Transitions valid from the issue's status AND passing conditions for this actor. */
export async function listAvailableTransitions(issue: IssueCtx & { projectId: string }, actor: Actor) {
  const workflow = await getProjectWorkflow(issue.projectId, issue.issueTypeId);
  // Jira: without TRANSITION_ISSUES the picker is empty.
  if (!(await hasPermission(actor, 'TRANSITION_ISSUES', { projectId: issue.projectId, issue }))) return [];
  const project = await prisma.project.findUnique({ where: { id: issue.projectId }, select: { leadId: true } });
  const candidates = workflow.transitions.filter(
    (t) => t.fromStatusId === issue.statusId || (t.fromStatusId === null && t.toStatusId !== issue.statusId)
  );
  const out = [];
  for (const t of candidates) {
    let pass = true;
    for (const r of t.rules.filter((x) => x.kind === 'condition')) {
      if (!(await conditionPasses(r, issue, actor, project?.leadId))) {
        pass = false;
        break;
      }
    }
    if (pass) out.push(toTransitionResponse(t));
  }
  return out;
}

interface TransitionBody {
  fields?: {
    resolution?: { name?: string; id?: string } | null;
    assignee?: { name?: string; accountId?: string } | null;
  };
  update?: {
    comment?: { add?: { body?: string } }[];
  };
}

async function runValidators(t: TransitionFull, issue: IssueCtx, body: TransitionBody) {
  for (const r of t.rules.filter((x) => x.kind === 'validator')) {
    if (r.type === 'resolutionRequired') {
      const provided = body.fields?.resolution && (body.fields.resolution.name || body.fields.resolution.id);
      if (!provided && !issue.resolutionId) {
        throw new JiraApiError(400, jiraError([], { resolution: 'Resolution is required.' }));
      }
    } else if (r.type === 'fieldRequired') {
      const field = (r.config as { field?: string } | null)?.field ?? 'field';
      const v = (body.fields as Record<string, unknown> | undefined)?.[field];
      if (v === undefined || v === null || v === '') {
        throw new JiraApiError(400, jiraError([], { [field]: `${field} is required.` }));
      }
    }
  }
}

/**
 * Executes a real workflow transition: conditions → validators → field updates
 * → status move → post-functions → comment → changelog, all in one tx.
 */
export async function performTransition(
  issue: IssueCtx & {
    projectId: string;
    status: { name: string };
    issueNumber: number;
    project: { key: string };
    resolution?: { name: string } | null;
    assignee?: { displayName: string } | null;
  },
  transitionId: string,
  actor: Actor,
  body: TransitionBody = {},
  opts: { dryRun?: boolean } = {}
) {
  const workflow = await getProjectWorkflow(issue.projectId, issue.issueTypeId);
  await assertIssueWritable(issue);
  const project = await prisma.project.findUnique({ where: { id: issue.projectId }, select: { leadId: true } });
  const t = workflow.transitions.find((x) => x.id === transitionId);
  const valid =
    t && (t.fromStatusId === issue.statusId || (t.fromStatusId === null && t.toStatusId !== issue.statusId));
  if (!t || !valid) {
    throw new JiraApiError(
      404,
      jiraError(['Transition id is invalid or the issue cannot transition to the target status.'])
    );
  }
  await requirePermission(actor, 'TRANSITION_ISSUES', { projectId: issue.projectId, issue });
  // Jira stacks RESOLVE_ISSUES / CLOSE_ISSUES on top of TRANSITION_ISSUES by
  // target status: resolving (or reopening out of done) needs RESOLVE_ISSUES;
  // landing on a 'Closed' status needs CLOSE_ISSUES.
  {
    const source = await prisma.status.findUnique({ where: { id: issue.statusId }, select: { category: true } });
    const toDone = t.toStatus.category === 'done';
    const fromDone = source?.category === 'done';
    if (t.toStatus.name.toLowerCase() === 'closed') {
      await requirePermission(actor, 'CLOSE_ISSUES', { projectId: issue.projectId, issue });
    } else if (toDone || (fromDone && !toDone)) {
      await requirePermission(actor, 'RESOLVE_ISSUES', { projectId: issue.projectId, issue });
    }
  }
  for (const r of t.rules.filter((x) => x.kind === 'condition')) {
    if (!(await conditionPasses(r, issue, actor, project?.leadId))) {
      throw new JiraApiError(400, jiraError([`You do not have permission to execute the '${t.name}' transition.`]));
    }
  }
  await runValidators(t, issue, body);

  // Field updates from the transition screen.
  const items: Parameters<typeof recordChange>[3] = [];
  const data: Prisma.IssueUpdateInput = {};
  let resolutionObj: { id: string; name: string } | null | undefined;
  if (body.fields?.resolution !== undefined && body.fields.resolution !== null) {
    const ref = body.fields.resolution;
    const r = await prisma.resolution.findFirst({
      where: ref.id ? { id: ref.id } : { name: ref.name ?? '' },
    });
    if (!r) {
      const all = await prisma.resolution.findMany({ select: { name: true } });
      throw new JiraApiError(
        400,
        jiraError([], {
          resolution: `'${ref.name ?? ref.id}' is not valid. Allowed: ${all.map((x) => x.name).join(', ')}.`,
        })
      );
    }
    resolutionObj = r;
  }
  let assigneeObj: { id: string; displayName: string } | null | undefined;
  if (body.fields?.assignee !== undefined) {
    // 053 US3 — a transition-screen assign carries the same gate as PUT
    // fields.assignee: ASSIGN_ISSUES on the actor + ASSIGNABLE_USER on the
    // target. null unassigns; checkAssign returns the resolved target.
    const target = await checkAssign(actor, issue, body.fields.assignee);
    assigneeObj = target ? { id: target.id, displayName: target.displayName } : null;
  }

  const commentBody = body.update?.comment?.map((c) => c.add?.body).find(Boolean);

  // Post-functions.
  for (const r of t.rules.filter((x) => x.kind === 'postFunction')) {
    if (r.type === 'setResolution') {
      const res = resolutionObj ?? (await prisma.resolution.findUnique({ where: { name: 'Done' } }));
      if (res && issue.resolutionId !== res.id) {
        resolutionObj = res;
      }
    } else if (r.type === 'clearResolution') {
      if (issue.resolutionId) {
        data.resolution = { disconnect: true };
        data.resolutionDate = null;
        items.push({ field: 'resolution', from: issue.resolutionId, to: null, toString: null });
      }
      resolutionObj = undefined; // explicit field wins otherwise
    } else if (r.type === 'assignToCurrentUser') {
      if (issue.assigneeId !== actor.user.id) {
        assigneeObj = { id: actor.user.id, displayName: actor.user.displayName };
      }
    }
  }

  if (resolutionObj !== undefined) {
    if (resolutionObj === null || resolutionObj.id !== issue.resolutionId) {
      data.resolution = resolutionObj ? { connect: { id: resolutionObj.id } } : { disconnect: true };
      data.resolutionDate = resolutionObj ? new Date() : null;
      items.push({
        field: 'resolution',
        from: issue.resolutionId,
        fromString: issue.resolution?.name ?? null,
        to: resolutionObj?.id ?? null,
        toString: resolutionObj?.name ?? null,
      });
    }
  }
  if (assigneeObj !== undefined && (assigneeObj?.id ?? null) !== issue.assigneeId) {
    data.assignee = assigneeObj ? { connect: { id: assigneeObj.id } } : { disconnect: true };
    items.push({
      field: 'assignee',
      from: issue.assigneeId,
      fromString: issue.assignee?.displayName ?? null,
      to: assigneeObj?.id ?? null,
      toString: assigneeObj?.displayName ?? null,
    });
  }

  data.status = { connect: { id: t.toStatusId } };
  data.statusChangedAt = new Date(); // 033 — days-in-column indicator
  items.push({
    field: 'status',
    from: issue.statusId,
    fromString: issue.status?.name ?? null,
    to: t.toStatusId,
    toString: t.toStatus.name,
  });

  if (opts.dryRun) {
    return { changes: items, transition: toTransitionResponse(t) };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.issue.update({
      where: { id: issue.id },
      data,
      include: issueInclude,
    });
    const commentRow = commentBody
      ? await tx.comment.create({
          data: { issueId: issue.id, authorId: actor.user.id, body: commentBody, channel: actor.channel },
          include: { author: true },
        })
      : null;
    await recordChange(tx, issue.id, actor, items);
    const issueKey = `${issue.project.key}-${issue.issueNumber}`;
    await emitEvent(tx, actor, {
      type: 'jira:issue_updated',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issueKey,
        projectKey: issue.project.key,
        issue: toIssueResponse(u),
        changelog: { items },
        transition: toTransitionResponse(t),
      },
    });
    if (commentRow) {
      const c = commentRow;
      await emitEvent(tx, actor, {
        type: 'comment_created',
        projectId: issue.projectId,
        issueId: issue.id,
        payload: {
          issueKey,
          projectKey: issue.project.key,
          comment: {
            id: c.id,
            author: toUserResponse(c.author),
            body: c.body,
            created: c.createdAt.toISOString(),
            updated: c.updatedAt.toISOString(),
            channel: c.channel,
          },
        },
      });
    }
    return u;
  });
  return updated;
}

// --- workflow CRUD (editor API) ---

export function toWorkflowResponse(w: WorkflowFull) {
  return {
    id: w.id,
    name: w.name,
    version: w.version,
    statuses: w.statuses.map((s) => ({
      id: s.statusId,
      name: s.status.name,
      isInitial: s.isInitial,
      statusCategory: toStatusCategory(s.status.category),
    })),
    transitions: w.transitions.map((t) => ({
      id: t.id,
      name: t.name,
      from: t.fromStatus ? { id: t.fromStatus.id, name: t.fromStatus.name } : null,
      to: { id: t.toStatus.id, name: t.toStatus.name },
      screenFields: t.screenFields,
      rules: t.rules.map((r) => ({ kind: r.kind, type: r.type, config: r.config })),
    })),
  };
}

export async function listWorkflows() {
  const wfs = await prisma.workflow.findMany({ include: workflowInclude, orderBy: { name: 'asc' } });
  return wfs.map(toWorkflowResponse);
}

export async function getWorkflow(idOrName: string) {
  const w = await prisma.workflow.findFirst({
    where: { OR: [{ id: idOrName }, { name: idOrName }] },
    include: workflowInclude,
  });
  if (!w) throw new JiraApiError(404, jiraError(['Workflow not found.']));
  return toWorkflowResponse(w);
}

export interface WorkflowInput {
  name: string;
  statuses: { statusId: string; isInitial?: boolean; position?: number }[];
  transitions: {
    id?: string;
    name: string;
    fromStatusId?: string | null;
    toStatusId: string;
    screenFields?: string[];
    rules?: { kind: string; type: string; config?: object }[];
  }[];
}

async function validateWorkflowShape(input: WorkflowInput) {
  const ids = new Set(input.statuses.map((s) => s.statusId));
  if (!input.statuses.length) {
    throw new JiraApiError(400, jiraError([], { statuses: 'A workflow needs at least one status.' }));
  }
  if (input.statuses.filter((s) => s.isInitial).length !== 1) {
    throw new JiraApiError(400, jiraError([], { statuses: 'Exactly one status must be marked initial.' }));
  }
  const statusRows = await prisma.status.findMany({ where: { id: { in: [...ids] } } });
  const categoryById = new Map(statusRows.map((s) => [s.id, s.category]));
  for (const t of input.transitions) {
    if (!ids.has(t.toStatusId) || (t.fromStatusId && !ids.has(t.fromStatusId))) {
      throw new JiraApiError(
        400,
        jiraError([], { transitions: `Transition '${t.name}' references a status not in this workflow.` })
      );
    }
  }
  // Reachability: BFS from initial over transitions (global edges from every node).
  const initial = input.statuses.find((s) => s.isInitial)!.statusId;
  const edges = new Map<string | null, string[]>();
  for (const t of input.transitions) {
    const k = t.fromStatusId ?? null;
    edges.set(k, [...(edges.get(k) ?? []), t.toStatusId]);
  }
  const seen = new Set<string>([initial]);
  const queue = [initial];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of [...(edges.get(cur) ?? []), ...(edges.get(null) ?? [])]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  const unreachable = input.statuses.filter((s) => !seen.has(s.statusId));
  if (unreachable.length) {
    const names = statusRows.filter((s) => unreachable.some((u) => u.statusId === s.id)).map((s) => s.name);
    throw new JiraApiError(
      400,
      jiraError([], { statuses: `Statuses unreachable from the initial status: ${names.join(', ')}.` })
    );
  }
  // Non-done statuses need an outgoing transition.
  for (const s of input.statuses) {
    if (categoryById.get(s.statusId) === 'done') continue;
    const hasOut = input.transitions.some((t) => t.fromStatusId === s.statusId || t.fromStatusId === null);
    if (!hasOut) {
      const name = statusRows.find((x) => x.id === s.statusId)?.name ?? s.statusId;
      throw new JiraApiError(400, jiraError([], { transitions: `Status '${name}' has no outgoing transition.` }));
    }
  }
}

export async function createWorkflow(input: WorkflowInput) {
  await validateWorkflowShape(input);
  const w = await prisma.workflow.create({
    data: {
      name: input.name,
      statuses: {
        create: input.statuses.map((s, i) => ({
          statusId: s.statusId,
          isInitial: !!s.isInitial,
          position: s.position ?? i,
        })),
      },
      transitions: {
        create: input.transitions.map((t, i) => ({
          name: t.name,
          fromStatusId: t.fromStatusId ?? null,
          toStatusId: t.toStatusId,
          screenFields: t.screenFields ?? [],
          position: i,
          rules: {
            create: (t.rules ?? []).map((r) => ({ kind: r.kind, type: r.type, config: r.config ?? undefined })),
          },
        })),
      },
    },
    include: workflowInclude,
  });
  return toWorkflowResponse(w);
}

export async function updateWorkflow(id: string, input: WorkflowInput) {
  const existing = await prisma.workflow.findUnique({ where: { id }, include: { projects: true } });
  if (!existing) throw new JiraApiError(404, jiraError(['Workflow not found.']));
  await validateWorkflowShape(input);

  // Statuses being removed must not be in use by issues in bound projects.
  const nextIds = new Set(input.statuses.map((s) => s.statusId));
  const removed = await prisma.workflowStatus.findMany({
    where: { workflowId: id, statusId: { notIn: [...nextIds] } },
  });
  if (removed.length && existing.projects.length) {
    const counts = await prisma.issue.groupBy({
      by: ['statusId'],
      where: {
        projectId: { in: existing.projects.map((p) => p.id) },
        statusId: { in: removed.map((r) => r.statusId) },
      },
      _count: true,
    });
    if (counts.length) {
      const names = await prisma.status.findMany({
        where: { id: { in: counts.map((c) => c.statusId) } },
        select: { name: true, id: true },
      });
      const detail = counts.map((c) => `${names.find((n) => n.id === c.statusId)?.name}: ${c._count}`).join(', ');
      throw new JiraApiError(400, jiraError([], { statuses: `Cannot remove statuses in use by issues (${detail}).` }));
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.transitionRule.deleteMany({ where: { transition: { workflowId: id } } });
    await tx.workflowTransition.deleteMany({ where: { workflowId: id } });
    await tx.workflowStatus.deleteMany({ where: { workflowId: id } });
    await tx.workflow.update({
      where: { id },
      data: {
        name: input.name,
        version: { increment: 1 },
        statuses: {
          create: input.statuses.map((s, i) => ({
            statusId: s.statusId,
            isInitial: !!s.isInitial,
            position: s.position ?? i,
          })),
        },
        transitions: {
          create: input.transitions.map((t, i) => ({
            name: t.name,
            fromStatusId: t.fromStatusId ?? null,
            toStatusId: t.toStatusId,
            screenFields: t.screenFields ?? [],
            position: i,
            rules: {
              create: (t.rules ?? []).map((r) => ({ kind: r.kind, type: r.type, config: r.config ?? undefined })),
            },
          })),
        },
      },
    });
  });
  return getWorkflow(id);
}

/** Switch a project's workflow, remapping existing issues via `mapping` (old→new statusId). */
export async function assignWorkflowToProject(
  projectKey: string,
  workflowId: string,
  mapping: Record<string, string>,
  actor: Actor
) {
  const project = await projectByKeyOr404(projectKey);
  const wf = await prisma.workflow.findUnique({ where: { id: workflowId }, include: workflowInclude });
  if (!wf) throw new JiraApiError(404, jiraError(['Workflow not found.']));
  const validStatusIds = new Set(wf.statuses.map((s) => s.statusId));

  const issues = await prisma.issue.findMany({
    where: { projectId: project.id },
    select: { id: true, statusId: true, status: { select: { name: true } } },
  });
  const unmapped = issues.filter((i) => !validStatusIds.has(i.statusId) && !mapping[i.statusId]);
  if (unmapped.length) {
    const names = [...new Set(unmapped.map((i) => i.status.name))];
    throw new JiraApiError(400, jiraError([], { statuses: `Status mapping required for: ${names.join(', ')}.` }));
  }
  for (const [, to] of Object.entries(mapping)) {
    if (!validStatusIds.has(to)) {
      throw new JiraApiError(400, jiraError([], { statuses: 'Mapping target must be a status in the new workflow.' }));
    }
  }

  const moved = await prisma.$transaction(async (tx) => {
    await tx.project.update({ where: { id: project.id }, data: { workflowId } });
    let count = 0;
    for (const i of issues) {
      const target = validStatusIds.has(i.statusId) ? i.statusId : mapping[i.statusId];
      if (target && target !== i.statusId) {
        await tx.issue.update({ where: { id: i.id }, data: { statusId: target } });
        count++;
      }
    }
    return count;
  });

  return { workflow: toWorkflowResponse(wf), remappedIssues: moved, actor: actor.user.id };
}

// ---------- 031: workflow schemes ----------

const schemeInclude = {
  items: { include: { issueType: { select: { id: true, name: true } } } },
  defaultWorkflow: { select: { id: true, name: true } },
  _count: { select: { projects: true } },
} as const;

function toSchemeResponse(s: Prisma.WorkflowSchemeGetPayload<{ include: typeof schemeInclude }>) {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    defaultWorkflow: s.defaultWorkflow,
    mappings: s.items.map((i) => ({ issueType: i.issueType, workflowId: i.workflowId })),
    projectsUsed: s._count.projects,
  };
}

export async function listWorkflowSchemes() {
  const schemes = await prisma.workflowScheme.findMany({
    include: schemeInclude,
    orderBy: { name: 'asc' },
  });
  return schemes.map(toSchemeResponse);
}

export async function getWorkflowScheme(id: string) {
  const scheme = await prisma.workflowScheme.findUnique({ where: { id }, include: schemeInclude });
  if (!scheme) throw new JiraApiError(404, jiraError(['Workflow scheme not found.']));
  return toSchemeResponse(scheme);
}

export async function createWorkflowScheme(input: {
  name: string;
  description?: string;
  defaultWorkflowId: string;
  mappings?: Record<string, string>; // issueTypeId -> workflowId
}) {
  const scheme = await prisma.workflowScheme.create({
    data: {
      name: input.name,
      description: input.description,
      defaultWorkflowId: input.defaultWorkflowId,
      items: {
        create: Object.entries(input.mappings ?? {}).map(([issueTypeId, workflowId]) => ({
          issueTypeId,
          workflowId,
        })),
      },
    },
  });
  return { id: scheme.id };
}

export async function updateWorkflowScheme(
  id: string,
  input: { name?: string; description?: string; defaultWorkflowId?: string; mappings?: Record<string, string> }
) {
  const existing = await prisma.workflowScheme.findUnique({ where: { id } });
  if (!existing) throw new JiraApiError(404, jiraError(['Workflow scheme not found.']));
  if (input.mappings) {
    await prisma.workflowSchemeItem.deleteMany({ where: { schemeId: id } });
    await prisma.workflowSchemeItem.createMany({
      data: Object.entries(input.mappings).map(([issueTypeId, workflowId]) => ({
        schemeId: id,
        issueTypeId,
        workflowId,
      })),
    });
  }
  await prisma.workflowScheme.update({
    where: { id },
    data: {
      name: input.name,
      description: input.description,
      defaultWorkflowId: input.defaultWorkflowId,
    },
  });
  return { id };
}

/**
 * 060 US1 — delete a workflow definition. Refused while bound: projects using
 * it directly, schemes using it as default, or scheme items mapping to it.
 * TransitionRule rows cascade from WorkflowTransition (schema onDelete).
 */
export async function deleteWorkflow(id: string) {
  const wf = await prisma.workflow.findUnique({ where: { id } });
  if (!wf) throw new JiraApiError(404, jiraError(['Workflow not found.']));
  const [projectCount, defaultCount, itemCount] = await Promise.all([
    prisma.project.count({ where: { workflowId: id } }),
    prisma.workflowScheme.count({ where: { defaultWorkflowId: id } }),
    prisma.workflowSchemeItem.count({ where: { workflowId: id } }),
  ]);
  const used = projectCount + defaultCount + itemCount;
  if (used > 0) {
    throw new JiraApiError(
      400,
      jiraError([
        `Workflow is in use (${projectCount} project(s), ${defaultCount} scheme default(s), ${itemCount} scheme mapping(s)).`,
      ])
    );
  }
  await prisma.$transaction([
    prisma.workflowTransition.deleteMany({ where: { workflowId: id } }),
    prisma.workflowStatus.deleteMany({ where: { workflowId: id } }),
    prisma.workflow.delete({ where: { id } }),
  ]);
}

export async function deleteWorkflowScheme(id: string) {
  const used = await prisma.project.count({ where: { workflowSchemeId: id } });
  if (used > 0) {
    throw new JiraApiError(400, jiraError([`Workflow scheme is associated with ${used} project(s).`]));
  }
  await prisma.workflowScheme.delete({ where: { id } });
}

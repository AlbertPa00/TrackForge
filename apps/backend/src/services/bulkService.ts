// Sprint 023: bulk operations — per-issue writes through the same service
// paths as single ops (FR-001), job record persisted in BulkJob (FR-003),
// dryRun returns the full per-item plan (FR-002).
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hasPermission } from './permissionService.js';
import { canSeeIssue } from './issueSecurityService.js';
import { visibleIssueWhere, visibleProjectScope, canSeeProject } from './visibilityService.js';
import { emitEvent } from './eventService.js';
import { getDurableRunner } from '../lib/jobs.js';
import { issueKeyToWhere } from '../lib/issueKey.js';

export const BULK_CAP = 500;
const OPS = ['edit', 'transition', 'move', 'delete', 'comment', 'watch', 'link'] as const;
export type BulkOp = (typeof OPS)[number];

const OP_PERMISSION: Record<BulkOp, string | null> = {
  edit: 'EDIT_ISSUES',
  transition: 'TRANSITION_ISSUES',
  move: 'MOVE_ISSUES',
  delete: 'DELETE_ISSUES',
  comment: 'ADD_COMMENTS',
  watch: null,
  link: 'LINK_ISSUES',
};

interface SelectedIssue {
  id: string;
  issueNumber: number;
  projectId: string;
  effSecurityLevelId: string | null;
  reporterId: string | null;
  assigneeId: string | null;
  archived: boolean;
  project: { key: string };
}
const toKey = (i: SelectedIssue) => `${i.project.key}-${i.issueNumber}`;

interface ResolvedSelection {
  issues: SelectedIssue[];
  missingKeys: string[];
}

async function resolveSelection(actor: Actor, sel: { issueKeys?: string[]; jql?: string }): Promise<ResolvedSelection> {
  // 064 US3 — selection honors all three gates: token allow-list + BROWSE +
  // issue security. The JQL branch ANDs the shared predicate; the key branch
  // checks per issue.
  const [scope, vis] = await Promise.all([visibleProjectScope(actor), visibleIssueWhere(actor)]);
  const selectFields = {
    id: true,
    issueNumber: true,
    projectId: true,
    effSecurityLevelId: true,
    reporterId: true,
    assigneeId: true,
    archived: true,
    project: { select: { key: true } },
  } as const;

  if (sel.jql) {
    const { parseJql } = await import('../jql/parser.js');
    const { compileJql } = await import('../jql/compiler.js');
    const { where } = await compileJql(parseJql(sel.jql), actor);
    const rows = await prisma.issue.findMany({
      where: { AND: [where as object, vis] } as never,
      select: selectFields,
      take: BULK_CAP + 1,
      orderBy: { issueNumber: 'asc' },
    });
    if (rows.length > BULK_CAP) {
      throw new JiraApiError(
        400,
        jiraError([`Selection matches more than ${BULK_CAP} issues — narrow the JQL (cap ${BULK_CAP}).`])
      );
    }
    return { issues: rows, missingKeys: [] };
  }

  const keys = [...new Set((sel.issueKeys ?? []).map((k) => k.toUpperCase()))];
  if (!keys.length) throw new JiraApiError(400, jiraError(['Provide issueKeys or jql.']));
  if (keys.length > BULK_CAP) {
    throw new JiraApiError(400, jiraError([`Selection exceeds the ${BULK_CAP}-issue cap — narrow the selection.`]));
  }
  const rows: SelectedIssue[] = [];
  const missing: string[] = [];
  for (const key of keys) {
    const where = issueKeyToWhere(key);
    if (!where) {
      missing.push(key);
      continue;
    }
    const issue = await prisma.issue.findFirst({ where, select: selectFields });
    // Missing or out-of-scope → fail-named per item (SC-002), not a request error.
    if (issue && !issue.archived && canSeeProject(scope, issue.projectId) && (await canSeeIssue(actor, issue)))
      rows.push(issue);
    else missing.push(key);
  }
  return { issues: rows, missingKeys: missing };
}

interface PlanItem {
  key: string;
  ok: boolean;
  changes?: string[];
  error?: string;
}

// Resolves a target status name → transition id per issue (transitions are
// workflow-scoped, so a shared name must resolve per issue — wizard UX).
async function transitionIdFor(issue: SelectedIssue, statusName?: string): Promise<string | null> {
  if (!statusName) return null;
  const full = await prisma.issue.findUnique({
    where: { id: issue.id },
    select: { statusId: true, status: { select: { name: true } } },
  });
  if (full?.status?.name?.toLowerCase() === statusName.toLowerCase()) return '__same__';
  const rows = await prisma.workflowTransition.findMany({
    where: {
      OR: [{ fromStatusId: full!.statusId }, { fromStatusId: null }],
      toStatus: { name: { equals: statusName, mode: 'insensitive' } },
    },
    select: { id: true },
    take: 1,
  });
  return rows[0]?.id ?? null;
}

async function planItem(op: BulkOp, issue: SelectedIssue, payload: any, actor: Actor): Promise<PlanItem> {
  const key = toKey(issue);
  const perm = OP_PERMISSION[op];
  if (perm && !(await hasPermission(actor, perm as never, { projectId: issue.projectId }))) {
    return { key, ok: false, error: `Missing permission ${perm}` };
  }
  // 064 US3 — issue security is a per-issue gate, not just a selection filter:
  // a level applied between selection and execution must still block the op.
  if (issue.archived || !(await canSeeIssue(actor, issue))) {
    return { key, ok: false, error: 'Issue is not visible to you' };
  }
  try {
    switch (op) {
      case 'edit':
        if (!payload?.fields && !payload?.update) return { key, ok: false, error: 'No fields/update payload' };
        return { key, ok: true, changes: Object.keys({ ...payload.fields, ...payload.update }).map((f) => `set ${f}`) };
      case 'transition': {
        const tid = payload?.transitionId ?? (await transitionIdFor(issue, payload?.statusName));
        if (!tid) return { key, ok: false, error: `No transition to '${payload?.statusName ?? ''}'` };
        if (tid === '__same__') return { key, ok: true, changes: ['already in status'] };
        const { previewTransition } = await import('./issueService.js');
        await previewTransition(key, String(tid), actor);
        return { key, ok: true, changes: [`transition → ${payload.statusName ?? tid}`] };
      }
      case 'move': {
        if (!payload?.target?.projectKey) return { key, ok: false, error: 'target.projectKey required' };
        const { getIssueByKey } = await import('./issueService.js');
        const { moveIssue } = await import('./issueOpsService.js');
        const src = await getIssueByKey(key);
        const preview = await moveIssue(src, { ...payload.target, dryRun: true }, actor);
        const nk = 'newKey' in preview ? preview.newKey : preview.key;
        return { key, ok: true, changes: [`move → ${nk ?? payload.target.projectKey}`] };
      }
      case 'delete': {
        const { planDelete } = await import('./issueService.js');
        const d = await planDelete(key, Boolean(payload?.deleteSubtasks));
        return { key, ok: true, changes: [`delete (${d.subtasks.length} subtasks)`] };
      }
      case 'comment':
        return payload?.body ? { key, ok: true, changes: ['comment'] } : { key, ok: false, error: 'body required' };
      case 'watch':
        return { key, ok: true, changes: [payload?.unwatch ? 'unwatch' : 'watch'] };
      case 'link':
        if (!payload?.type || !payload?.inwardKey) return { key, ok: false, error: 'type + inwardKey required' };
        return { key, ok: true, changes: [`${payload.type} → ${payload.inwardKey}`] };
    }
  } catch (e: any) {
    return { key, ok: false, error: e?.message?.slice(0, 300) ?? 'Plan failed' };
  }
}

async function applyItem(op: BulkOp, issue: SelectedIssue, payload: any, actor: Actor): Promise<void> {
  const key = toKey(issue);
  switch (op) {
    case 'edit': {
      const { updateIssue } = await import('./issueService.js');
      // payload.fields is UpdateIssueInput-shaped (internal API — same shape the
      // route converter produces from Jira bodies).
      await updateIssue(key, payload.fields as never, actor);
      return;
    }
    case 'transition': {
      const tid = payload.transitionId ?? (await transitionIdFor(issue, payload.statusName));
      if (!tid) throw new JiraApiError(400, jiraError(['No matching transition for the requested status.']));
      if (tid === '__same__') return;
      const { executeTransition } = await import('./issueService.js');
      await executeTransition(key, String(tid), actor, payload.body ?? {});
      return;
    }
    case 'move': {
      const { getIssueByKey } = await import('./issueService.js');
      const { moveIssue } = await import('./issueOpsService.js');
      await moveIssue(await getIssueByKey(key), { ...payload.target, dryRun: false }, actor);
      return;
    }
    case 'delete': {
      const { planDelete, deleteIssue, deletePreviewToken } = await import('./issueService.js');
      const { issue: src, subtasks } = await planDelete(key, Boolean(payload?.deleteSubtasks));
      await deleteIssue(
        key,
        Boolean(payload?.deleteSubtasks),
        await deletePreviewToken(
          src.id,
          subtasks.map((s) => s.id)
        ),
        actor
      );
      return;
    }
    case 'comment': {
      const { addComment } = await import('./commentService.js');
      await addComment(key, payload.body, actor);
      return;
    }
    case 'watch': {
      const { addWatcher, removeWatcher } = await import('./notificationService.js');
      const uid = payload.userId ?? actor.user.id;
      if (payload.unwatch) await removeWatcher(issue.id, uid);
      else await addWatcher(issue.id, uid);
      return;
    }
    case 'link': {
      const { createLink } = await import('./linkService.js');
      await createLink(String(payload.type), key, String(payload.inwardKey).toUpperCase(), actor);
      return;
    }
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== 'queued') return;
  // Server-side actor (edge case: the issuing token may expire mid-run —
  // attribution stays on the original user; channel 'api' matches request-time behavior).
  const fullActor = await prisma.user.findUnique({ where: { id: job.actorId } });
  const actor = { user: fullActor!, channel: 'api' } as Actor;
  const { issues, missingKeys } = await resolveSelection(actor, job.selection as never);
  const results: PlanItem[] = missingKeys.map((key) => ({ key, ok: false, error: 'Issue not found or not visible' }));
  let succeeded = 0;
  let failed = results.length;
  await prisma.bulkJob.update({
    where: { id: jobId },
    data: { status: 'running', total: issues.length + missingKeys.length },
  });
  for (const issue of issues) {
    const key = toKey(issue);
    try {
      await applyItem(job.op as BulkOp, issue, job.payload, actor);
      results.push({ key, ok: true });
      succeeded++;
    } catch (e: any) {
      results.push({ key, ok: false, error: e?.message?.slice(0, 300) ?? 'Failed' });
      failed++;
    }
    await prisma.bulkJob.update({
      where: { id: jobId },
      data: { done: results.length, succeeded, failed, results: results as never },
    });
  }
  await prisma.bulkJob.update({
    where: { id: jobId },
    data: {
      status: 'done',
      finishedAt: new Date(),
      done: results.length,
      succeeded,
      failed,
      results: results as never,
    },
  });
  // FR-005: one audit/summary event per job (per-issue events come from the per-op paths).
  await emitEvent(prisma, actor, {
    type: 'jira:bulk_change',
    payload: { jobId, op: job.op, total: issues.length, succeeded, failed },
  });
}

export function registerBulkHandlers() {
  getDurableRunner()?.register('bulk:run', async (payload) => {
    const { jobId } = payload as { jobId: string };
    await runJob(jobId);
  });
}

export async function createBulkJob(
  op: string,
  selection: { issueKeys?: string[]; jql?: string },
  payload: unknown,
  dryRun: boolean,
  actor: Actor
) {
  if (!OPS.includes(op as BulkOp)) {
    throw new JiraApiError(400, jiraError([`Unknown op '${op}'. Allowed: ${OPS.join(', ')}`]));
  }
  const { issues, missingKeys } = await resolveSelection(actor, selection);
  const job = await prisma.bulkJob.create({
    data: {
      actorId: actor.user.id,
      op,
      selection: selection as never,
      payload: payload as never,
      status: 'planned',
      total: issues.length + missingKeys.length,
    },
  });
  const plan: PlanItem[] = missingKeys.map((key) => ({ key, ok: false, error: 'Issue not found or not visible' }));
  for (const issue of issues) {
    plan.push(await planItem(op as BulkOp, issue, payload, actor));
  }
  await prisma.bulkJob.update({ where: { id: job.id }, data: { results: plan as never[] } });
  const total = issues.length + missingKeys.length;
  if (dryRun) {
    return { jobId: job.id, dryRun: true, total, plan };
  }
  await prisma.bulkJob.update({ where: { id: job.id }, data: { status: 'queued' } });
  await getDurableRunner()?.enqueue('bulk:run', { jobId: job.id });
  return { jobId: job.id, dryRun: false, total, plan };
}

export async function getBulkJob(jobId: string, actor: Actor) {
  const job = await prisma.bulkJob.findUnique({ where: { id: jobId } });
  if (!job || job.actorId !== actor.user.id) {
    throw new JiraApiError(404, jiraError(['Bulk job not found.']));
  }
  return job;
}

export async function retryBulkJob(jobId: string, dryRun: boolean, actor: Actor) {
  const job = await getBulkJob(jobId, actor);
  const failed = (job.results as unknown as PlanItem[]).filter((r) => !r.ok).map((r) => r.key);
  if (!failed.length) throw new JiraApiError(400, jiraError(['No failed items to retry.']));
  return createBulkJob(job.op, { issueKeys: failed }, job.payload, dryRun, actor);
}

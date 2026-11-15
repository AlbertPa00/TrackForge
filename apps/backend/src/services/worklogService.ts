// Sprint 024 — worklogs + timetracking. Jira v2 semantics:
//   POST /issue/{key}/worklog  ?adjustEstimate=auto|leave|new|manual
//   GET/PUT/DELETE             /issue/{key}/worklog/{id}
//   GET /worklog/updated|deleted  POST /worklog/list   (incremental sync)
// `timeSpent` is always derived from Worklog rows — never stored (FR-003).

import type { Prisma, Worklog } from '@prisma/client';
import { Prisma as PrismaV } from '../lib/pc.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { formatDuration, parseDuration, type TimeTrackingConfig } from '../lib/duration.js';
import { getTimeTrackingConfig } from './settingsService.js';
import { recordChange, type ChangeItemInput } from './changelogService.js';
import { emitEvent } from './eventService.js';
import { canModifyAuthored, hasPermission, requirePermission } from './permissionService.js';
import { assertIssueWritable } from './projectService.js';
import { toUserResponse } from './userService.js';
import type { Actor } from '../lib/auth.js';
import { resourceSelf } from '../lib/http.js';

type WorklogWithAuthor = Worklog & { author: Parameters<typeof toUserResponse>[0] };

// ---------- serialization ----------

export function toWorklogResponse(w: WorklogWithAuthor, issueKey: string, cfg: TimeTrackingConfig) {
  return {
    self: resourceSelf(`/rest/api/2/issue/${issueKey}/worklog/${w.id}`),
    author: toUserResponse(w.author),
    updateAuthor: toUserResponse(w.author),
    comment: w.comment ?? undefined,
    created: w.createdAt.toISOString(),
    updated: w.updatedAt.toISOString(),
    started: w.started.toISOString(),
    timeSpent: formatDuration(w.timeSpentSec, cfg),
    timeSpentSeconds: w.timeSpentSec,
    billable: w.billable,
    id: w.id,
    issueId: w.issueId,
    // 031: Jira visibility — emitted only when restricted
    ...(w.visibility ? { visibility: w.visibility } : {}),
  };
}

/** Jira `fields.worklog` block (first page) for single-issue payloads. */
export function worklogField(worklogs: WorklogWithAuthor[], total: number, issueKey: string, cfg: TimeTrackingConfig) {
  return {
    startAt: 0,
    maxResults: 20,
    total,
    worklogs: worklogs.map((w) => toWorklogResponse(w, issueKey, cfg)),
  };
}

/** timetracking/progress/aggregate fields for toIssueResponse (sync once sums known). */
export function timeTrackingFields(
  issue: { id: string; originalEstimateSec?: number | null; remainingEstimateSec?: number | null },
  data: {
    /** undefined = spent unknown (list/preview paths) → spent-derived keys omitted. */
    selfSpentSec?: number;
    childrenSpentSec: number;
    childrenOriginalSec: number;
    childrenRemainingSec: number;
    worklogTotal: number;
    worklogs?: WorklogWithAuthor[];
  },
  cfg: TimeTrackingConfig,
  issueKey: string
) {
  const orig = issue.originalEstimateSec ?? null;
  const rem = issue.remainingEstimateSec ?? null;
  const spent = data.selfSpentSec;
  const hasAny = orig !== null || rem !== null || (spent ?? 0) > 0;
  const progressTotal = (spent ?? 0) + (rem ?? 0);
  const spentKnown = spent !== undefined;

  return {
    timetracking: hasAny
      ? {
          ...(orig !== null ? { originalEstimate: formatDuration(orig, cfg), originalEstimateSeconds: orig } : {}),
          ...(rem !== null ? { remainingEstimate: formatDuration(rem, cfg), remainingEstimateSeconds: rem } : {}),
          ...((spent ?? 0) > 0 ? { timeSpent: formatDuration(spent, cfg), timeSpentSeconds: spent } : {}),
        }
      : {},
    timeestimate: rem,
    timeoriginalestimate: orig,
    ...(spentKnown
      ? {
          timespent: spent || null,
          progress: {
            progress: spent,
            total: progressTotal,
            ...(progressTotal > 0 ? { percent: Math.round((spent! / progressTotal) * 100) } : {}),
          },
          workratio: orig && orig > 0 ? Math.round((spent! / orig) * 100) : -1,
          ...aggregateFields(issue, data, cfg),
          ...(data.worklogs !== undefined
            ? { worklog: worklogField(data.worklogs, data.worklogTotal, issueKey, cfg) }
            : {}),
        }
      : {}),
  };
}

function aggregateFields(
  issue: { originalEstimateSec?: number | null; remainingEstimateSec?: number | null },
  data: {
    selfSpentSec?: number;
    childrenSpentSec: number;
    childrenOriginalSec: number;
    childrenRemainingSec: number;
  },
  _cfg: TimeTrackingConfig
) {
  const rem = issue.remainingEstimateSec ?? null;
  const orig = issue.originalEstimateSec ?? null;
  const aggregateSpent = (data.selfSpentSec ?? 0) + data.childrenSpentSec;
  const aggregateRemaining = (rem ?? 0) + data.childrenRemainingSec;
  const aggregateOriginal = (orig ?? 0) + data.childrenOriginalSec;
  const aggregateTotal = aggregateSpent + aggregateRemaining;
  const hasAggregate = aggregateSpent > 0 || aggregateOriginal > 0 || aggregateRemaining > 0;
  return {
    aggregatetimespent: hasAggregate ? aggregateSpent : null,
    aggregatetimeestimate: hasAggregate ? aggregateRemaining : null,
    aggregatetimeoriginalestimate: hasAggregate ? aggregateOriginal : null,
    aggregateprogress: {
      progress: aggregateSpent,
      total: aggregateTotal,
      ...(aggregateTotal > 0 ? { percent: Math.round((aggregateSpent / aggregateTotal) * 100) } : {}),
    },
  };
}

/** Self + children worklog sums (+ first-page rows) for one hydrated issue. */
export async function issueTimeData(issue: { id: string; children?: { id: string }[] }) {
  const childIds = (issue.children ?? []).map((c) => c.id);
  const [sums, childEstimates, worklogs, cfg] = await Promise.all([
    prisma.worklog.groupBy({
      by: ['issueId'],
      where: { issueId: { in: [issue.id, ...childIds] } },
      _sum: { timeSpentSec: true },
      _count: { _all: true },
    }),
    childIds.length
      ? prisma.issue.findMany({
          where: { id: { in: childIds } },
          select: { originalEstimateSec: true, remainingEstimateSec: true },
        })
      : Promise.resolve([]),
    prisma.worklog.findMany({
      where: { issueId: issue.id },
      orderBy: { started: 'asc' },
      take: 20,
      include: { author: true },
    }),
    getTimeTrackingConfig(),
  ]);
  const byIssue = new Map(sums.map((s) => [s.issueId, s]));
  const self = byIssue.get(issue.id);
  const childSet = new Set(childIds);
  const childrenSpent = sums
    .filter((s) => childSet.has(s.issueId))
    .reduce((acc, s) => acc + (s._sum.timeSpentSec ?? 0), 0);
  return {
    data: {
      selfSpentSec: self?._sum.timeSpentSec ?? 0,
      childrenSpentSec: childrenSpent,
      childrenOriginalSec: childEstimates.reduce((a, c) => a + (c.originalEstimateSec ?? 0), 0),
      childrenRemainingSec: childEstimates.reduce((a, c) => a + (c.remainingEstimateSec ?? 0), 0),
      worklogTotal: self?._count._all ?? 0,
      worklogs,
    },
    cfg,
  };
}

/** Batched spent-seconds + count for many issues (search/list pages). */
export async function worklogStatsFor(issueIds: string[]) {
  if (!issueIds.length) return new Map<string, { spent: number; count: number }>();
  const rows = await prisma.worklog.groupBy({
    by: ['issueId'],
    where: { issueId: { in: issueIds } },
    _sum: { timeSpentSec: true },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.issueId, { spent: r._sum.timeSpentSec ?? 0, count: r._count._all }]));
}

// ---------- queries ----------

export async function listWorklogs(
  issue: { id: string; projectId?: string },
  key: string,
  opts: {
    startAt?: number;
    maxResults?: number;
    startedAfter?: number;
    startedBefore?: number;
  },
  cfg?: TimeTrackingConfig,
  actor?: Actor
) {
  const config = cfg ?? (await getTimeTrackingConfig());
  const where = {
    issueId: issue.id,
    ...(opts.startedAfter || opts.startedBefore
      ? {
          started: {
            ...(opts.startedAfter ? { gte: new Date(opts.startedAfter) } : {}),
            ...(opts.startedBefore ? { lte: new Date(opts.startedBefore) } : {}),
          },
        }
      : {}),
  };
  // 031: visibility-restricted worklogs filtered post-fetch so `total`
  // counts only what the actor may see.
  const all = await prisma.worklog.findMany({
    where,
    orderBy: { started: 'asc' },
    include: { author: true },
  });
  const { filterByVisibility } = await import('./issueSecurityService.js');
  const visible = actor && issue.projectId ? await filterByVisibility(all, actor, issue.projectId) : all;
  const rows = visible.slice(opts.startAt ?? 0, (opts.startAt ?? 0) + Math.min(1000, opts.maxResults ?? 100));
  return {
    startAt: opts.startAt ?? 0,
    maxResults: rows.length,
    total: visible.length,
    worklogs: rows.map((w) => toWorklogResponse(w, key, config)),
  };
}

async function getWorklogForIssue(issueId: string, worklogId: string, actor?: Actor, projectId?: string) {
  const w = await prisma.worklog.findFirst({
    where: { id: worklogId, issueId },
    include: { author: true },
  });
  if (!w) {
    throw new JiraApiError(404, jiraError(['The worklog does not exist or you do not have permission to see it.']));
  }
  if (actor && projectId) {
    const { canSeeVisibility } = await import('./issueSecurityService.js');
    if (!(await canSeeVisibility(w, actor, projectId))) {
      throw new JiraApiError(404, jiraError(['The worklog does not exist or you do not have permission to see it.']));
    }
  }
  return w;
}

// ---------- write path ----------

export type AdjustEstimate = 'auto' | 'leave' | 'new' | 'manual';

export interface WorklogInput {
  timeSpent?: string;
  timeSpentSeconds?: number;
  started?: string;
  comment?: string | null;
  billable?: boolean;
  /** 031: Jira `visibility` — {type:'role'|'group', value} or null to clear. */
  visibility?: unknown;
}

function parseTimeSpent(input: WorklogInput, cfg: TimeTrackingConfig, fieldPrefix: string): number {
  let sec: number | null = null;
  if (input.timeSpentSeconds !== undefined && input.timeSpentSeconds !== null) {
    sec = Math.round(Number(input.timeSpentSeconds));
    if (!Number.isFinite(sec)) sec = null;
  } else if (input.timeSpent !== undefined && input.timeSpent !== null) {
    sec = parseDuration(input.timeSpent, cfg);
  }
  if (sec === null) {
    throw new JiraApiError(
      400,
      jiraError([], { [fieldPrefix]: `Specify the time spent in a valid format (e.g. "3h 30m") or seconds.` })
    );
  }
  if (sec <= 0) {
    throw new JiraApiError(400, jiraError([], { [fieldPrefix]: 'Time spent must be greater than zero.' }));
  }
  return sec;
}

function parseStarted(input: unknown): Date {
  // `started` defaults to now — Jira requires it, but agents/UIs that omit it
  // mean "this work happened just now" (a superset of the Jira contract).
  if (input === undefined || input === null) return new Date();
  const d = new Date(String(input));
  if (Number.isNaN(d.getTime())) {
    throw new JiraApiError(400, jiraError([], { 'fields.started': 'Started date must be an ISO date-time.' }));
  }
  return d;
}

/** Resolve the target remainingEstimateSec after a worklog write. */
async function applyAdjust(
  adjust: AdjustEstimate,
  opts: { newEstimate?: string; reduceBy?: string },
  issue: { originalEstimateSec: number | null; remainingEstimateSec: number | null },
  deltaSec: number,
  cfg: TimeTrackingConfig
): Promise<number | null> {
  const rem = issue.remainingEstimateSec;
  switch (adjust) {
    case 'leave':
      return rem;
    case 'auto':
      // Jira: subtract the logged delta; untouched when no estimate exists.
      return rem === null ? null : Math.max(0, rem - deltaSec);
    case 'new': {
      const sec = parseDuration(opts.newEstimate ?? '', cfg);
      if (sec === null) {
        throw new JiraApiError(
          400,
          jiraError([], { newEstimate: 'newEstimate is required (e.g. "1d 4h") when adjustEstimate=new.' })
        );
      }
      return sec;
    }
    case 'manual': {
      const sec = parseDuration(opts.reduceBy ?? '', cfg);
      if (sec === null) {
        throw new JiraApiError(
          400,
          jiraError([], { reduceBy: 'reduceBy is required (e.g. "2h") when adjustEstimate=manual.' })
        );
      }
      return Math.max(0, (rem ?? 0) - sec);
    }
  }
}

function estimateChangeItems(
  before: { originalEstimateSec: number | null; remainingEstimateSec: number | null },
  afterRemaining: number | null,
  spentBefore: number,
  spentAfter: number,
  cfg: TimeTrackingConfig
): ChangeItemInput[] {
  const items: ChangeItemInput[] = [];
  if (spentAfter !== spentBefore) {
    items.push({
      field: 'timespent',
      fromString: formatDuration(spentBefore, cfg) ?? null,
      toString: formatDuration(spentAfter, cfg) ?? null,
    });
  }
  if ((before.remainingEstimateSec ?? null) !== afterRemaining) {
    items.push({
      field: 'timeestimate',
      fromString: formatDuration(before.remainingEstimateSec, cfg) ?? null,
      toString: formatDuration(afterRemaining, cfg) ?? null,
    });
  }
  return items;
}

export interface AdjustOptions {
  adjustEstimate?: string;
  newEstimate?: string;
  reduceBy?: string;
}

function parseAdjust(opts: AdjustOptions): AdjustEstimate {
  const a = (opts.adjustEstimate ?? 'auto').toLowerCase();
  if (!['auto', 'leave', 'new', 'manual'].includes(a)) {
    throw new JiraApiError(
      400,
      jiraError([], { adjustEstimate: `Invalid adjustEstimate '${a}'. Allowed: auto, leave, new, manual.` })
    );
  }
  return a as AdjustEstimate;
}

/** Preview or persist a worklog creation. Returns response pieces for both. */
export async function planAddWorklog(
  issue: { id: string; projectId: string; originalEstimateSec: number | null; remainingEstimateSec: number | null },
  input: WorklogInput,
  opts: AdjustOptions,
  actor: Actor
) {
  await requirePermission(actor, 'WORK_ON_ISSUES', { projectId: issue.projectId, issue });
  const cfg = await getTimeTrackingConfig();
  const sec = parseTimeSpent(input, cfg, 'fields.timeSpent');
  const started = parseStarted(input.started);
  const adjust = parseAdjust(opts);
  const spentBefore =
    (await prisma.worklog.aggregate({ where: { issueId: issue.id }, _sum: { timeSpentSec: true } }))._sum
      .timeSpentSec ?? 0;
  const afterRemaining = await applyAdjust(adjust, opts, issue, sec, cfg);
  const items = estimateChangeItems(issue, afterRemaining, spentBefore, spentBefore + sec, cfg);
  items.push({ field: 'Worklog', toString: formatDuration(sec, cfg) ?? String(sec) });
  return { cfg, sec, started, afterRemaining, spentBefore, items };
}

export async function addWorklog(
  issue: { id: string; projectId: string; originalEstimateSec: number | null; remainingEstimateSec: number | null },
  issueKey: string,
  input: WorklogInput,
  opts: AdjustOptions,
  actor: Actor
) {
  await assertIssueWritable(issue);
  const { cfg, sec, started, afterRemaining, items } = await planAddWorklog(issue, input, opts, actor);
  const { parseVisibility, assertVisibilityTarget } = await import('./issueSecurityService.js');
  const visibility = parseVisibility(input.visibility);
  if (visibility) await assertVisibilityTarget(visibility);
  const worklog = await prisma.$transaction(async (tx) => {
    const w = await tx.worklog.create({
      data: {
        issueId: issue.id,
        authorId: actor.user.id,
        timeSpentSec: sec,
        started,
        comment: input.comment ?? null,
        billable: input.billable === true,
        channel: actor.channel,
        tokenId: actor.token?.id ?? null,
        ...(visibility !== undefined && visibility !== null ? { visibility } : {}),
      },
      include: { author: true },
    });
    if (afterRemaining !== issue.remainingEstimateSec) {
      await tx.issue.update({ where: { id: issue.id }, data: { remainingEstimateSec: afterRemaining } });
    }
    await recordChange(tx, issue.id, actor, items);
    await emitEvent(tx, actor, {
      type: 'worklog_created',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issueKey,
        worklog: toWorklogResponse(w, issueKey, cfg),
        changelog: { items },
      },
    });
    return w;
  });
  return { worklog, cfg };
}

async function checkWorklogWrite(
  actor: Actor,
  issue: { projectId: string; reporterId?: string | null; assigneeId?: string | null },
  worklog: Worklog,
  verb: 'edit' | 'delete'
) {
  if (
    await canModifyAuthored(actor, worklog, 'WORKLOGS', verb === 'edit' ? 'EDIT' : 'DELETE', {
      projectId: issue.projectId,
      issue,
    })
  )
    return;
  await requirePermission(actor, verb === 'edit' ? 'EDIT_ALL_WORKLOGS' : 'DELETE_ALL_WORKLOGS', {
    projectId: issue.projectId,
    issue,
  });
}

export async function updateWorklog(
  issue: {
    id: string;
    projectId: string;
    originalEstimateSec: number | null;
    remainingEstimateSec: number | null;
    reporterId?: string | null;
    assigneeId?: string | null;
  },
  issueKey: string,
  worklogId: string,
  input: WorklogInput,
  opts: AdjustOptions,
  actor: Actor
) {
  await assertIssueWritable(issue);
  const worklog = await getWorklogForIssue(issue.id, worklogId, actor, issue.projectId);
  await checkWorklogWrite(actor, issue, worklog, 'edit');
  const cfg = await getTimeTrackingConfig();

  const adjust = parseAdjust(opts);
  const explicitAdjust = opts.adjustEstimate !== undefined;
  const patch: Prisma.WorklogUpdateInput = {};
  let deltaSec = 0;
  if (input.timeSpent !== undefined || input.timeSpentSeconds !== undefined) {
    const sec = parseTimeSpent(input, cfg, 'fields.timeSpent');
    deltaSec = sec - worklog.timeSpentSec;
    patch.timeSpentSec = sec;
  }
  if (input.started !== undefined) patch.started = parseStarted(input.started);
  if (input.comment !== undefined) patch.comment = input.comment ?? null;
  if (input.billable !== undefined) patch.billable = input.billable === true;
  if (input.visibility !== undefined) {
    const { parseVisibility, assertVisibilityTarget } = await import('./issueSecurityService.js');
    const vis = parseVisibility(input.visibility);
    if (vis) await assertVisibilityTarget(vis);
    patch.visibility = vis === null ? PrismaV.DbNull : (vis as object);
  }

  // Jira never re-adjusts remaining on edit unless asked (edge-case contract);
  // when asked, `auto` shifts remaining by the spent delta.
  const spentBefore =
    (await prisma.worklog.aggregate({ where: { issueId: issue.id }, _sum: { timeSpentSec: true } }))._sum
      .timeSpentSec ?? 0;
  const afterRemaining = explicitAdjust
    ? await applyAdjust(adjust, opts, issue, deltaSec, cfg)
    : issue.remainingEstimateSec;
  const items = estimateChangeItems(issue, afterRemaining, spentBefore, spentBefore + deltaSec, cfg);
  if (input.timeSpent !== undefined || input.timeSpentSeconds !== undefined) {
    items.push({
      field: 'Worklog',
      fromString: formatDuration(worklog.timeSpentSec, cfg),
      toString: formatDuration(patch.timeSpentSec as number, cfg),
    });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const w = await tx.worklog.update({ where: { id: worklog.id }, data: patch, include: { author: true } });
    if (afterRemaining !== issue.remainingEstimateSec) {
      await tx.issue.update({ where: { id: issue.id }, data: { remainingEstimateSec: afterRemaining } });
    }
    await recordChange(tx, issue.id, actor, items);
    await emitEvent(tx, actor, {
      type: 'worklog_updated',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issueKey, worklog: toWorklogResponse(w, issueKey, cfg), changelog: { items } },
    });
    return w;
  });
  return { worklog: updated, cfg };
}

export async function deleteWorklog(
  issue: {
    id: string;
    projectId: string;
    originalEstimateSec: number | null;
    remainingEstimateSec: number | null;
    reporterId?: string | null;
    assigneeId?: string | null;
  },
  issueKey: string,
  worklogId: string,
  opts: AdjustOptions,
  actor: Actor
) {
  await assertIssueWritable(issue);
  const worklog = await getWorklogForIssue(issue.id, worklogId, actor, issue.projectId);
  await checkWorklogWrite(actor, issue, worklog, 'delete');
  const cfg = await getTimeTrackingConfig();
  const adjust = parseAdjust(opts);
  const explicitAdjust = opts.adjustEstimate !== undefined;

  const spentBefore =
    (await prisma.worklog.aggregate({ where: { issueId: issue.id }, _sum: { timeSpentSec: true } }))._sum
      .timeSpentSec ?? 0;
  // Jira delete default (auto) hands the logged time back to remaining.
  const effectiveAdjust = explicitAdjust ? adjust : 'auto';
  const afterRemaining =
    effectiveAdjust === 'auto' && issue.remainingEstimateSec !== null
      ? issue.remainingEstimateSec + worklog.timeSpentSec
      : explicitAdjust
        ? await applyAdjust(adjust, opts, issue, -worklog.timeSpentSec, cfg)
        : issue.remainingEstimateSec;
  const items = estimateChangeItems(issue, afterRemaining, spentBefore, spentBefore - worklog.timeSpentSec, cfg);
  items.push({ field: 'Worklog', fromString: formatDuration(worklog.timeSpentSec, cfg), toString: null });

  await prisma.$transaction(async (tx) => {
    await tx.worklog.delete({ where: { id: worklog.id } });
    await tx.deletedWorklog.create({ data: { worklogId: worklog.id, issueId: issue.id } });
    if (afterRemaining !== issue.remainingEstimateSec) {
      await tx.issue.update({ where: { id: issue.id }, data: { remainingEstimateSec: afterRemaining } });
    }
    await recordChange(tx, issue.id, actor, items);
    await emitEvent(tx, actor, {
      type: 'worklog_deleted',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issueKey, worklog: toWorklogResponse({ ...worklog }, issueKey, cfg), changelog: { items } },
    });
  });
}

// ---------- incremental sync (Jira /worklog/updated|deleted|list) ----------

function sinceParam(req: { query: unknown }): number {
  const q = req.query as Record<string, unknown>;
  return Math.max(0, Number(q.since ?? 0) || 0);
}

export async function worklogsUpdated(sinceMs: number, scopedIds?: string[]) {
  const since = new Date(sinceMs);
  const rows = await prisma.worklog.findMany({
    where: { updatedAt: { gte: since }, ...(scopedIds ? { issueId: { in: scopedIds } } : {}) },
    orderBy: { updatedAt: 'asc' },
    take: 1000,
    select: { id: true, updatedAt: true },
  });
  const until = rows.length ? rows[rows.length - 1]!.updatedAt.getTime() + 1 : Date.now();
  return {
    self: resourceSelf(`/rest/api/2/worklog/updated?since=${sinceMs}`),
    since: sinceMs,
    until,
    lastPage: rows.length < 1000,
    nextPage: rows.length < 1000 ? undefined : resourceSelf(`/rest/api/2/worklog/updated?since=${until}`),
    values: rows.map((r) => ({ worklogId: r.id, updatedTime: r.updatedAt.getTime(), properties: [] })),
  };
}

export async function worklogsDeleted(sinceMs: number, scopedIds?: string[]) {
  const since = new Date(sinceMs);
  const rows = await prisma.deletedWorklog.findMany({
    where: { deletedAt: { gte: since }, ...(scopedIds ? { issueId: { in: scopedIds } } : {}) },
    orderBy: { deletedAt: 'asc' },
    take: 1000,
  });
  const until = rows.length ? rows[rows.length - 1]!.deletedAt.getTime() + 1 : Date.now();
  return {
    self: resourceSelf(`/rest/api/2/worklog/deleted?since=${sinceMs}`),
    since: sinceMs,
    until,
    lastPage: rows.length < 1000,
    nextPage: rows.length < 1000 ? undefined : resourceSelf(`/rest/api/2/worklog/deleted?since=${until}`),
    values: rows.map((r) => ({ worklogId: r.worklogId, deletedTime: r.deletedAt.getTime(), properties: [] })),
  };
}

export { sinceParam };

/** POST /worklog/list — issues the actor cannot browse are filtered out (404-safe). */
export async function worklogsByIds(ids: string[], actor: Actor) {
  const cfg = await getTimeTrackingConfig();
  const rows = await prisma.worklog.findMany({
    where: { id: { in: ids } },
    include: { author: true, issue: { include: { project: { select: { key: true, id: true } } } } },
    take: Math.min(1000, ids.length),
  });
  const out = [];
  for (const w of rows) {
    if (!(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: w.issue.project.id }))) continue;
    const key = `${w.issue.project.key}-${w.issue.issueNumber}`;
    out.push(toWorklogResponse(w, key, cfg));
  }
  return out;
}

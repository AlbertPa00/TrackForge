// Sprint reports — velocity + burndown reconstructed from IssueSprint
// membership intervals and changelog (status + Story Points field changes).

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { toIssueKey, parseIssueKey } from './issueService.js';
import { toSprintResponse } from './sprintService.js';
import { resolveBoard } from './boardService.js';
import { executeSearch } from './searchService.js';
import { visibleIssueWhere, canSeeProjectId, canSeeIssueFull } from './visibilityService.js';
import { securityGateWhere } from './issueSecurityService.js';
import type { Actor } from '../lib/auth.js';
import { jiraDate } from '../lib/http.js';

const DAY_MS = 86_400_000;

/** 031: ids from `issueIds` that the actor may see (issue-security level). */
async function visibleIds(actor: Actor, issueIds: string[]) {
  if (!issueIds.length) return new Set<string>();
  const rows = await prisma.issue.findMany({
    where: { AND: [{ id: { in: issueIds } }, await visibleIssueWhere(actor)] },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

async function doneStatusNames() {
  const rows = await prisma.status.findMany({ where: { category: 'done' }, select: { name: true } });
  return new Set(rows.map((r) => r.name));
}

interface MemberHistory {
  issueId: string;
  intervals: { addedAt: Date; removedAt: Date | null }[];
  /** current scalar state */
  points: number | null;
  statusName: string;
  statusCategory: string;
  /** chronological field changes */
  pointChanges: { at: Date; from: number | null; to: number | null }[];
  statusChanges: { at: Date; to: string }[];
}

async function memberHistories(sprintId: string): Promise<MemberHistory[]> {
  const memberships = await prisma.issueSprint.findMany({
    where: { sprintId },
    include: {
      issue: { select: { id: true, storyPoints: true, status: { select: { name: true, category: true } } } },
    },
    orderBy: { addedAt: 'asc' },
  });
  if (!memberships.length) return [];
  const issueIds = [...new Set(memberships.map((m) => m.issueId))];
  const changes = await prisma.changeHistory.findMany({
    where: { issueId: { in: issueIds }, items: { some: { field: { in: ['Sprint', 'status', 'Story Points'] } } } },
    include: { items: true },
    orderBy: { createdAt: 'asc' },
  });
  const byIssue = new Map<string, MemberHistory>();
  for (const m of memberships) {
    const h =
      byIssue.get(m.issueId) ??
      ({
        issueId: m.issueId,
        intervals: [],
        points: m.issue.storyPoints,
        statusName: m.issue.status.name,
        statusCategory: m.issue.status.category,
        pointChanges: [],
        statusChanges: [],
      } satisfies MemberHistory);
    h.intervals.push({ addedAt: m.addedAt, removedAt: m.removedAt });
    byIssue.set(m.issueId, h);
  }
  for (const ch of changes) {
    const h = byIssue.get(ch.issueId);
    if (!h) continue;
    for (const item of ch.items) {
      if (item.field === 'Story Points') {
        h.pointChanges.push({
          at: ch.createdAt,
          from: item.fromString === null ? null : Number(item.fromString),
          to: item.toString === null ? null : Number(item.toString),
        });
      } else if (item.field === 'status') {
        h.statusChanges.push({ at: ch.createdAt, to: item.toString ?? '' });
      }
    }
  }
  return [...byIssue.values()];
}

/**
 * Membership at instant t. `removedAt >= t` (inclusive) so issues carried out
 * at sprint close still count at the close instant — matching Jira's
 * commitment/remaining semantics.
 */
function memberAt(h: MemberHistory, t: number) {
  return h.intervals.some((i) => i.addedAt.getTime() <= t && (i.removedAt === null || i.removedAt.getTime() >= t));
}

/** Points value at instant t: latest change ≤ t decides; no changes → current. */
function pointsAt(h: MemberHistory, t: number): number {
  let v: number | null = null;
  let seen = false;
  for (const c of h.pointChanges) {
    if (c.at.getTime() <= t) {
      v = c.to;
      seen = true;
    } else break;
  }
  if (seen) return v ?? 0;
  return h.points ?? 0;
}

function doneAt(h: MemberHistory, t: number, doneNames: Set<string>): boolean {
  let name: string | null = null;
  let seen = false;
  for (const c of h.statusChanges) {
    if (c.at.getTime() <= t) {
      name = c.to;
      seen = true;
    } else break;
  }
  if (seen) return doneNames.has(name ?? '');
  return h.statusCategory === 'done';
}

/** GET velocity — committed vs completed points per closed sprint on the board. */
export async function getVelocity(actor: Actor, boardIdOrKey: string) {
  const board = await resolveBoard(boardIdOrKey);
  const sprints = await prisma.sprint.findMany({
    where: { boardId: board.id, state: 'closed' },
    orderBy: { completeDate: 'asc' },
    include: { project: { select: { key: true } } },
  });
  const doneNames = await doneStatusNames();
  const values = [];
  for (const s of sprints) {
    const closedAt = (s.completeDate ?? s.endDate ?? s.startDate)?.getTime() ?? Date.now();
    const all = await memberHistories(s.id);
    const vis = await visibleIds(
      actor,
      all.map((h) => h.issueId)
    );
    const histories = all.filter((h) => vis.has(h.issueId));
    let committed = 0;
    let completed = 0;
    let estimatedCommitted = 0;
    for (const h of histories) {
      if (!memberAt(h, closedAt)) continue;
      const p = pointsAt(h, closedAt);
      committed += p;
      if (h.points === null) estimatedCommitted++;
      if (doneAt(h, closedAt, doneNames)) completed += p;
    }
    values.push({
      sprint: toSprintResponse(s, s.project.key),
      committedPoints: Math.round(committed * 100) / 100,
      completedPoints: Math.round(completed * 100) / 100,
      issueCount: histories.filter((h) => memberAt(h, closedAt)).length,
      unestimatedCount: estimatedCommitted,
    });
  }
  return { boardId: board.id, sprints: values };
}

/** GET burndown — daily remaining-points series for a sprint (default: active). */
export async function getBurndown(actor: Actor, boardIdOrKey: string, sprintId?: string) {
  const board = await resolveBoard(boardIdOrKey);
  const sprint = sprintId
    ? await prisma.sprint.findFirst({ where: { id: sprintId, boardId: board.id } })
    : await prisma.sprint.findFirst({ where: { boardId: board.id, state: 'active' } });
  if (!sprint) {
    throw new JiraApiError(404, jiraError(['No matching sprint found on this board.']));
  }
  const project = await prisma.project.findUnique({ where: { id: sprint.projectId }, select: { key: true } });

  const start = sprint.startDate?.getTime() ?? sprint.completeDate?.getTime() ?? Date.now();
  const hardEnd = sprint.endDate?.getTime() ?? start + 14 * DAY_MS;
  const dataEnd = Math.min(sprint.completeDate?.getTime() ?? Date.now(), Date.now());
  const end = Math.max(hardEnd, dataEnd);

  const allHistories = await memberHistories(sprint.id);
  const visIds = await visibleIds(
    actor,
    allHistories.map((h) => h.issueId)
  );
  const histories = allHistories.filter((h) => visIds.has(h.issueId));
  const doneNames = await doneStatusNames();

  const series: { date: string; remaining: number; scope: number; done: number }[] = [];
  const bucketAt = (t: number) => {
    let remaining = 0;
    let scope = 0;
    let done = 0;
    for (const h of histories) {
      if (!memberAt(h, t)) continue;
      const p = pointsAt(h, t);
      scope += p;
      if (doneAt(h, t, doneNames)) done += p;
      else remaining += p;
    }
    series.push({
      date: new Date(t).toISOString(),
      remaining: Math.round(remaining * 100) / 100,
      scope: Math.round(scope * 100) / 100,
      done: Math.round(done * 100) / 100,
    });
  };
  for (let t = start; t < end; t += DAY_MS) bucketAt(t);
  // Always sample the end instant (close/now) even when the sprint is < 1 day.
  bucketAt(end);

  // Un-estimated issues still count toward issue totals.
  const issueCount = histories.filter((h) => memberAt(h, dataEnd)).length;

  return {
    sprint: toSprintResponse(sprint, project?.key),
    boardId: board.id,
    startDate: new Date(start).toISOString(),
    endDate: new Date(hardEnd).toISOString(),
    issueCount,
    series,
  };
}

/** Issue list for a sprint with per-issue report metadata. */
export async function getSprintReport(actor: Actor, boardIdOrKey: string, sprintId: string) {
  const board = await resolveBoard(boardIdOrKey);
  const sprint = await prisma.sprint.findFirst({ where: { id: sprintId, boardId: board.id } });
  if (!sprint) {
    throw new JiraApiError(404, jiraError(['No matching sprint found on this board.']));
  }
  const project = await prisma.project.findUnique({ where: { id: sprint.projectId }, select: { key: true } });
  const closedAt = (sprint.completeDate ?? sprint.endDate ?? undefined)?.getTime() ?? Date.now();
  const allHistories = await memberHistories(sprint.id);
  const vis = await visibleIds(
    actor,
    allHistories.map((h) => h.issueId)
  );
  const histories = allHistories.filter((h) => vis.has(h.issueId));
  const doneNames = await doneStatusNames();
  const rows = await prisma.issue.findMany({
    where: { id: { in: histories.map((h) => h.issueId) } },
    include: { issueType: true, status: true },
  });
  const numById = new Map(rows.map((r) => [r.id, r]));
  const issues = histories
    .filter((h) => memberAt(h, closedAt))
    .map((h) => {
      const row = numById.get(h.issueId)!;
      return {
        key: toIssueKey(project?.key ?? '', row.issueNumber),
        summary: row.summary,
        type: row.issueType.name,
        status: row.status.name,
        points: pointsAt(h, closedAt),
        done: doneAt(h, closedAt, doneNames),
        addedAfterStart: h.intervals.some((i) => i.addedAt.getTime() > (sprint.startDate?.getTime() ?? 0)),
      };
    });
  return { sprint: toSprintResponse(sprint, project?.key), issues };
}

// ---------- Sprint 027: epic report, CFD, control chart, registry ----------

interface StatusTrack {
  issueId: string;
  currentName: string;
  changes: { at: Date; from: string | null; to: string }[];
}

// SQLite tops out at 32767 bind vars, Postgres at 65535 — a big board's
// issueIds blow past both. Chunk every `in` clause instead.
const IN_CHUNK = 5000;

async function statusTracks(issueIds: string[]): Promise<StatusTrack[]> {
  const issues: { id: string; status: { name: string } }[] = [];
  const changes: {
    issueId: string;
    createdAt: Date;
    items: { field: string; fromString: string | null; toString: string | null }[];
  }[] = [];
  for (let i = 0; i < issueIds.length; i += IN_CHUNK) {
    const chunk = issueIds.slice(i, i + IN_CHUNK);
    const [is, chs] = await Promise.all([
      prisma.issue.findMany({
        where: { id: { in: chunk } },
        select: { id: true, status: { select: { name: true } } },
      }),
      prisma.changeHistory.findMany({
        where: { issueId: { in: chunk }, items: { some: { field: 'status' } } },
        include: { items: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    issues.push(...is);
    changes.push(...chs);
  }
  const tracks = new Map<string, StatusTrack>();
  for (const i of issues) tracks.set(i.id, { issueId: i.id, currentName: i.status.name, changes: [] });
  for (const ch of changes) {
    const t = tracks.get(ch.issueId);
    if (!t) continue;
    for (const item of ch.items) {
      if (item.field === 'status') {
        t.changes.push({ at: ch.createdAt, from: item.fromString, to: item.toString ?? '' });
      }
    }
  }
  return [...tracks.values()];
}

const DAY = 86400_000;
const REPORT_RANGE_CAP_DAYS = 365;

async function boardIssueTracks(actor: Actor, boardIdOrKey: string) {
  const board = await resolveBoard(boardIdOrKey);
  // 064 US3 — a board in a non-browsable project must not exist for this actor.
  if (!(await canSeeProjectId(actor, board.projectId))) {
    throw new JiraApiError(404, jiraError(['Board does not exist or you do not have permission to see it.']));
  }
  // Project gate proven above — the security-only predicate avoids the
  // all-projects enumeration inside visibleIssueWhere on this hot path.
  const issues = await prisma.issue.findMany({
    where: { AND: [{ projectId: board.projectId }, await securityGateWhere(actor)] },
    select: { id: true, project: { select: { key: true } }, issueNumber: true, summary: true },
  });
  const tracks = await statusTracks(issues.map((i) => i.id));
  const meta = new Map(issues.map((i) => [i.id, i]));
  return { board, issues, tracks, meta };
}

/** CFD — daily end-of-day counts per board column (status → column mapping).
 * Sweep-line: only in-window status items + a per-column difference array —
 * O(issues + changes + days) instead of O(days × issues × changes). */
export async function getCfd(actor: Actor, boardIdOrKey: string, days = 30) {
  const board = await resolveBoard(boardIdOrKey);
  // 064 US3 — board in a non-browsable project must not exist for this actor,
  // and the single-project gate lets the query use the cheap security-only
  // predicate instead of enumerating every project per call.
  if (!(await canSeeProjectId(actor, board.projectId))) {
    throw new JiraApiError(404, jiraError(['Board does not exist or you do not have permission to see it.']));
  }
  const columns = await prisma.boardColumn.findMany({
    where: { boardId: board.id },
    orderBy: { position: 'asc' },
    include: { statuses: { include: { status: { select: { name: true } } } } },
  });
  const colOf = new Map<string, string>();
  for (const c of columns) for (const s of c.statuses) colOf.set(s.status.name, c.name);
  const names = columns.map((c) => c.name);
  const d = Math.min(REPORT_RANGE_CAP_DAYS, Math.max(1, days));
  const end = Date.now();
  const start = end - d * DAY;

  // Issues that never changed inside the window contribute a constant
  // per-column count for every day — aggregate them in SQL, never fetch rows.
  const vis = await securityGateWhere(actor);
  const [byStatus, statusRows, histories] = await Promise.all([
    prisma.issue.groupBy({ by: ['statusId'], where: { AND: [{ projectId: board.projectId }, vis] }, _count: true }),
    prisma.status.findMany({ select: { id: true, name: true } }),
    prisma.changeHistory.findMany({
      where: { createdAt: { gt: new Date(start) }, issue: { AND: [{ projectId: board.projectId }, vis] } },
      select: { id: true, issueId: true, createdAt: true },
    }),
  ]);
  const nameOf = new Map(statusRows.map((s) => [s.id, s.name]));

  // Flat item lookup per history chunk — avoids an items.some EXISTS on the big join.
  const byIssue = new Map<string, { at: number; from: string; to: string }[]>();
  const histOf = new Map(histories.map((h) => [h.id, h]));
  const histIds = histories.map((h) => h.id);
  for (let i = 0; i < histIds.length; i += IN_CHUNK) {
    const items = await prisma.changeItem.findMany({
      where: { historyId: { in: histIds.slice(i, i + IN_CHUNK) }, field: 'status' },
      select: { historyId: true, fromString: true, toString: true },
    });
    for (const it of items) {
      const h = histOf.get(it.historyId)!;
      const list = byIssue.get(h.issueId) ?? [];
      list.push({ at: h.createdAt.getTime(), from: it.fromString ?? '', to: it.toString ?? '' });
      byIssue.set(h.issueId, list);
    }
  }

  // diff[day][col] — enter/leave deltas; day 0 seeds each issue's status at window start.
  const bucket = (name: string) => colOf.get(name) ?? null;
  const diff: Map<string | null, number>[] = Array.from({ length: d + 1 }, () => new Map());
  const bump = (day: number, col: string | null, delta: number) => {
    const m = diff[Math.min(d, Math.max(0, day))];
    m.set(col, (m.get(col) ?? 0) + delta);
  };
  const atStart = new Map<string | null, number>();
  for (const g of byStatus) {
    const col = bucket(nameOf.get(g.statusId) ?? '');
    atStart.set(col, (atStart.get(col) ?? 0) + g._count);
  }
  for (const [, chs0] of byIssue) {
    const chs = chs0.sort((a, b) => a.at - b.at);
    // groupBy counted this issue at its CURRENT status (= last in-window `to`,
    // since the window ends at now); re-home it to the status it held at
    // window start (earliest in-window `from`).
    const cur = bucket(chs[chs.length - 1].to);
    const col0 = bucket(chs[0].from || chs[chs.length - 1].to);
    atStart.set(cur, (atStart.get(cur) ?? 0) - 1);
    atStart.set(col0, (atStart.get(col0) ?? 0) + 1);
    let col = col0;
    for (const c of chs) {
      const day = Math.floor((c.at - start) / DAY);
      bump(day, col, -1);
      col = bucket(c.to);
      bump(day, col, 1);
    }
  }
  for (const [col, n] of atStart) bump(0, col, n);

  const series = [];
  const running = new Map<string | null, number>();
  for (let day = 0; day <= d; day++) {
    for (const [col, delta] of diff[day]) running.set(col, (running.get(col) ?? 0) + delta);
    const counts: Record<string, number> = {};
    for (const n of names) counts[n] = running.get(n) ?? 0;
    series.push({
      date: new Date(start + day * DAY).toISOString(),
      counts,
      unmapped: running.get(null) ?? 0,
    });
  }
  return { board: { id: board.id, name: board.name }, days: d, columns: names, series };
}

/** Control chart — cycle time per issue: first entry to in-progress → last entry to done. */
export async function getControlChart(actor: Actor, boardIdOrKey: string, days = 30, window = 7) {
  const { board, tracks, meta } = await boardIssueTracks(actor, boardIdOrKey);
  const cats = new Map(
    (await prisma.status.findMany({ select: { name: true, category: true } })).map((s) => [s.name, s.category])
  );
  const end = Date.now();
  const start = end - Math.min(REPORT_RANGE_CAP_DAYS, Math.max(1, days)) * DAY;
  const points: { key: string; summary: string; cycleDays: number; completedAt: string }[] = [];
  for (const tr of tracks) {
    const m = meta.get(tr.issueId)!;
    let started: number | null = null;
    let completed: number | null = null;
    for (const c of tr.changes) {
      const cat = cats.get(c.to);
      if (cat === 'inprogress' && started === null) started = c.at.getTime();
      if (cat === 'done') completed = c.at.getTime();
    }
    if (started === null || completed === null || completed <= started) continue;
    if (completed < start || completed > end) continue;
    points.push({
      key: toIssueKey(m.project.key, m.issueNumber),
      summary: m.summary,
      cycleDays: Math.round(((completed - started) / DAY) * 100) / 100,
      completedAt: new Date(completed).toISOString(),
    });
  }
  points.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const vals = points.map((p) => p.cycleDays);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  const variance = vals.length ? vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length : 0;
  const w = Math.max(1, window);
  const rolling = points.map((p, i) => {
    const slice = vals.slice(Math.max(0, i - w + 1), i + 1);
    return {
      completedAt: p.completedAt,
      avg: Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 100) / 100,
    };
  });
  return {
    board: { id: board.id, name: board.name },
    days,
    window: w,
    issues: points,
    mean: Math.round(mean * 100) / 100,
    stddev: Math.round(Math.sqrt(variance) * 100) / 100,
    rolling,
  };
}

/** Epic report — progress + remaining + velocity-derived forecast. */
export async function getEpicReport(actor: Actor, epicKey: string) {
  const { projectKey, issueNumber } = await parseIssueKey(epicKey);
  const epic = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey }, issueType: { hierarchyLevel: 1 } },
    select: { id: true, summary: true, projectId: true, effSecurityLevelId: true, reporterId: true, assigneeId: true },
  });
  if (!epic || !(await canSeeIssueFull(actor, epic)))
    throw new JiraApiError(404, jiraError([`Epic '${epicKey}' does not exist.`]));
  const doneNames = await doneStatusNames();
  const children = await prisma.issue.findMany({
    where: { AND: [{ parentId: epic.id }, await visibleIssueWhere(actor)] },
    select: {
      id: true,
      issueNumber: true,
      summary: true,
      storyPoints: true,
      status: { select: { name: true } },
      issueType: { select: { name: true } },
    },
  });
  const total = children.length;
  let completed = 0,
    totalPts = 0,
    completedPts = 0;
  const remaining: { key: string; summary: string; status: string; points: number | null }[] = [];
  for (const c of children) {
    const pts = c.storyPoints ?? 0;
    totalPts += pts;
    if (doneNames.has(c.status.name)) {
      completed++;
      completedPts += pts;
    } else
      remaining.push({
        key: toIssueKey(projectKey, c.issueNumber),
        summary: c.summary,
        status: c.status.name,
        points: c.storyPoints,
      });
  }
  // Forecast heuristic: avg completed points across the last 3 closed sprints on
  // the project's board; remainingPts / velocity → sprint estimate (documented
  // in sprint doc; Jira uses a similar rolling heuristic).
  const board = await prisma.board.findFirst({ where: { projectId: epic.projectId } });
  let velocity: number | null = null;
  if (board) {
    const closed = await prisma.sprint.findMany({
      where: { boardId: board.id, state: 'closed' },
      orderBy: { completeDate: 'desc' },
      take: 3,
    });
    const sums: number[] = [];
    for (const s of closed) {
      const all = await memberHistories(s.id);
      const vis = await visibleIds(
        actor,
        all.map((h) => h.issueId)
      );
      const histories = all.filter((h) => vis.has(h.issueId));
      const closedAt = (s.completeDate ?? s.endDate)?.getTime() ?? Date.now();
      sums.push(
        histories
          .filter((h) => memberAt(h, closedAt) && doneAt(h, closedAt, doneNames))
          .reduce((a, h) => a + pointsAt(h, closedAt), 0)
      );
    }
    if (sums.length) velocity = Math.round((sums.reduce((a, b) => a + b, 0) / sums.length) * 100) / 100;
  }
  const remainingPts = totalPts - completedPts;
  return {
    epic: { key: epicKey, summary: epic.summary },
    total,
    completed,
    totalPoints: totalPts,
    completedPoints: completedPts,
    remainingPoints: remainingPts,
    percentComplete: total ? Math.round((completed / total) * 100) : 0,
    remainingIssues: remaining,
    forecast:
      velocity && velocity > 0
        ? { velocityPerSprint: velocity, sprintsRemaining: Math.ceil(remainingPts / velocity) }
        : { velocityPerSprint: velocity, sprintsRemaining: null },
  };
}

// ---------- registry (sprint 027) ----------

export const REPORT_REGISTRY = [
  {
    type: 'sprint',
    path: '/api/internal/reports/board/{boardId}/sprint/{sprintId}/report',
    scope: 'sprint',
    params: { boardId: 'board', sprintId: 'sprint' },
    formats: ['json', 'csv'],
    title: 'Sprint Report',
  },
  {
    type: 'epic',
    path: '/api/internal/reports/epic/{epicKey}',
    scope: 'epic',
    params: { epicKey: 'issue key' },
    formats: ['json', 'csv'],
    title: 'Epic Report',
  },
  {
    type: 'burndown',
    path: '/api/internal/reports/board/{boardId}/burndown',
    scope: 'sprint',
    params: { boardId: 'board', sprintId: 'optional sprint' },
    formats: ['json', 'csv'],
    title: 'Sprint Burndown',
  },
  {
    type: 'velocity',
    path: '/api/internal/reports/board/{boardId}/velocity',
    scope: 'board',
    params: { boardId: 'board' },
    formats: ['json', 'csv'],
    title: 'Velocity Chart',
  },
  {
    type: 'cfd',
    path: '/api/internal/reports/cfd/{boardId}',
    scope: 'board',
    params: { boardId: 'board', days: '1-365' },
    formats: ['json', 'csv'],
    title: 'Cumulative Flow Diagram',
  },
  {
    type: 'control',
    path: '/api/internal/reports/control/{boardId}',
    scope: 'board',
    params: { boardId: 'board', days: '1-365', window: 'rolling-avg issues' },
    formats: ['json', 'csv'],
    title: 'Control Chart',
  },
  {
    type: 'pie',
    path: '/api/internal/reports/pie',
    scope: 'filter',
    params: { jql: 'filter', statType: 'group field' },
    formats: ['json', 'csv'],
    title: 'Pie Chart',
  },
  {
    type: 'twoDimensional',
    path: '/api/internal/reports/two-dimensional',
    scope: 'filter',
    params: { jql: 'filter', xstatType: 'x field', ystatType: 'y field' },
    formats: ['json', 'csv'],
    title: 'Two-Dimensional Statistics',
  },
  {
    type: 'createdVsResolved',
    path: '/api/internal/reports/created-vs-resolved',
    scope: 'filter',
    params: { jql: 'filter', days: '1-365', cumulative: 'bool' },
    formats: ['json', 'csv'],
    title: 'Created vs Resolved',
  },
  {
    type: 'workload',
    path: '/api/internal/reports/workload',
    scope: 'project',
    params: { projectKey: 'optional' },
    formats: ['json', 'csv'],
    title: 'User Workload',
  },
  {
    type: 'averageAge',
    path: '/api/internal/reports/average-age',
    scope: 'filter',
    params: { jql: 'default unresolved', weeks: 'buckets' },
    formats: ['json', 'csv'],
    title: 'Average Age',
  },
  {
    type: 'resolutionTime',
    path: '/api/internal/reports/resolution-time',
    scope: 'filter',
    params: { jql: 'default resolved', groupBy: 'field' },
    formats: ['json', 'csv'],
    title: 'Resolution Time',
  },
  {
    type: 'timeTracking',
    path: '/api/internal/reports/time-tracking',
    scope: 'version|sprint|project',
    params: { versionId: 'version', sprintId: 'sprint', projectKey: 'project' },
    formats: ['json', 'csv'],
    title: 'Time Tracking',
  },
  {
    type: 'timesheet',
    path: '/api/internal/reports/timesheet',
    scope: 'user',
    params: { userId: 'optional (default caller)', projectKey: 'optional', from: 'ISO', to: 'ISO' },
    formats: ['json', 'csv'],
    title: 'Timesheet',
  },
  {
    type: 'version',
    path: '/api/internal/reports/version/{id}',
    scope: 'version',
    params: { id: 'version id' },
    formats: ['json', 'csv'],
    title: 'Version Report',
  },
  {
    type: 'project',
    path: '/api/internal/reports/project/{key}',
    scope: 'project',
    params: { key: 'project key' },
    formats: ['json', 'csv'],
    title: 'Project Summary',
  },
  {
    type: 'org',
    path: '/api/internal/reports/org',
    scope: 'instance',
    params: {},
    formats: ['json', 'csv'],
    title: 'Org Metrics (admin)',
    adminOnly: true,
  },
];

// ---------- Sprint 028: general, time & release reports ----------

async function searchAll(actor: import('../lib/auth.js').Actor, jql: string, fields?: string[]) {
  const r = await executeSearch(actor, { jql, startAt: 0, maxResults: 5000, fields });
  return { issues: r.issues, total: r.total, truncated: r.total > r.issues.length };
}

const STAT: Record<string, (f: Record<string, unknown>) => string> = {
  status: (f) => (f.status as { name?: string })?.name ?? 'None',
  priority: (f) => (f.priority as { name?: string })?.name ?? 'None',
  issuetype: (f) => (f.issuetype as { name?: string })?.name ?? 'None',
  assignee: (f) => (f.assignee as { displayName?: string })?.displayName ?? 'Unassigned',
  reporter: (f) => (f.reporter as { displayName?: string })?.displayName ?? 'None',
  project: (f) => (f.project as { key?: string })?.key ?? 'None',
  resolution: (f) => (f.resolution as { name?: string })?.name ?? 'Unresolved',
};

export async function getPie(actor: import('../lib/auth.js').Actor, jql: string, statType: string) {
  const get = STAT[statType];
  if (!get) throw new JiraApiError(400, jiraError([`Cannot group by '${statType}'.`]));
  const { issues, total, truncated } = await searchAll(actor, jql);
  const counts = new Map<string, number>();
  for (const i of issues)
    counts.set(
      get(i.fields as Record<string, unknown>),
      (counts.get(get(i.fields as Record<string, unknown>)) ?? 0) + 1
    );
  return {
    statType,
    total,
    truncated,
    groups: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };
}

export async function getTwoDimensional(actor: import('../lib/auth.js').Actor, jql: string, x: string, y: string) {
  const gx = STAT[x];
  const gy = STAT[y];
  if (!gx || !gy) throw new JiraApiError(400, jiraError(['Axis fields must be grouping-capable.']));
  const { issues, total, truncated } = await searchAll(actor, jql);
  const cells = new Map<string, number>();
  const xs = new Set<string>();
  const ys = new Set<string>();
  for (const i of issues) {
    const a = gx(i.fields as Record<string, unknown>);
    const b = gy(i.fields as Record<string, unknown>);
    xs.add(a);
    ys.add(b);
    const k = JSON.stringify([a, b]);
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }
  return {
    xstatType: x,
    ystatType: y,
    total,
    truncated,
    xLabels: [...xs],
    yLabels: [...ys],
    cells: Object.fromEntries(cells),
  };
}

export async function getCreatedVsResolved(
  actor: import('../lib/auth.js').Actor,
  jql: string,
  days = 30,
  cumulative = false
) {
  const { issues, truncated } = await searchAll(actor, jql, ['created', 'resolutiondate']);
  const since = new Date(Date.now() - Math.min(365, days) * DAY);
  const created = new Map<string, number>();
  const resolved = new Map<string, number>();
  const day = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);
  for (const i of issues) {
    const f = i.fields as { created?: string; resolutiondate?: string };
    const c = day(f.created);
    if (c && new Date(c) >= since) created.set(c, (created.get(c) ?? 0) + 1);
    const rd = day(f.resolutiondate);
    if (rd && new Date(rd) >= since) resolved.set(rd, (resolved.get(rd) ?? 0) + 1);
  }
  let cCum = 0;
  let rCum = 0;
  const series = [...new Set([...created.keys(), ...resolved.keys()])].sort().map((d) => {
    cCum += created.get(d) ?? 0;
    rCum += resolved.get(d) ?? 0;
    return cumulative
      ? { date: d, created: cCum, resolved: rCum }
      : { date: d, created: created.get(d) ?? 0, resolved: resolved.get(d) ?? 0 };
  });
  return { days, cumulative, truncated, columns: ['created', 'resolved'], series };
}

export async function getWorkload(actor: import('../lib/auth.js').Actor, projectKey?: string) {
  const doneIds = (await prisma.status.findMany({ where: { category: 'done' }, select: { id: true } })).map(
    (s) => s.id
  );
  const rows = await prisma.issue.groupBy({
    by: ['assigneeId'],
    where: {
      AND: [
        await visibleIssueWhere(actor),
        { statusId: { notIn: doneIds } },
        ...(projectKey ? [{ project: { key: projectKey.toUpperCase() } }] : []),
      ],
    },
    _count: true,
    _sum: { storyPoints: true, remainingEstimateSec: true },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.assigneeId).filter(Boolean) as string[] } },
    select: { id: true, displayName: true },
  });
  const name = new Map(users.map((u) => [u.id, u.displayName]));
  return {
    projectKey: projectKey?.toUpperCase() ?? null,
    users: rows
      .map((r) => ({
        user: r.assigneeId ? (name.get(r.assigneeId) ?? r.assigneeId) : 'Unassigned',
        openIssues: r._count,
        points: r._sum.storyPoints ?? 0,
        remainingEstimateSec: r._sum.remainingEstimateSec ?? 0,
      }))
      .sort((a, b) => b.openIssues - a.openIssues),
  };
}

export async function getAverageAge(actor: import('../lib/auth.js').Actor, jql = 'resolution = Unresolved', weeks = 8) {
  const { issues, total, truncated } = await searchAll(actor, jql, ['created']);
  const now = Date.now();
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const i of issues) {
    const created = new Date((i.fields as { created: string }).created);
    const wk = `W${Math.max(0, Math.floor((now - created.getTime()) / (7 * DAY)))}`;
    const b = buckets.get(wk) ?? { sum: 0, n: 0 };
    b.sum += (now - created.getTime()) / DAY;
    b.n++;
    buckets.set(wk, b);
  }
  return {
    unresolved: total,
    truncated,
    buckets: [...buckets.entries()]
      .map(([bucket, b]) => ({ bucket, issues: b.n, avgAgeDays: Math.round((b.sum / b.n) * 10) / 10 }))
      .sort((a, b) => Number(a.bucket.slice(1)) - Number(b.bucket.slice(1)))
      .slice(0, weeks),
  };
}

export async function getResolutionTime(
  actor: import('../lib/auth.js').Actor,
  jql = 'resolution != Unresolved',
  groupBy = 'priority'
) {
  const { issues, total, truncated } = await searchAll(actor, jql, ['created', 'resolutiondate', groupBy]);
  const get = STAT[groupBy] ?? STAT.priority;
  const buckets = new Map<string, { sum: number; n: number }>();
  let resolved = 0;
  for (const i of issues) {
    const f = i.fields as { created?: string; resolutiondate?: string };
    if (!f.created || !f.resolutiondate) continue;
    resolved++;
    const k = get(i.fields as Record<string, unknown>);
    const b = buckets.get(k) ?? { sum: 0, n: 0 };
    b.sum += (new Date(f.resolutiondate).getTime() - new Date(f.created).getTime()) / DAY;
    b.n++;
    buckets.set(k, b);
  }
  return {
    resolved,
    total,
    truncated,
    groupBy,
    groups: [...buckets.entries()]
      .map(([name, b]) => ({ name, issues: b.n, avgDays: Math.round((b.sum / b.n) * 10) / 10 }))
      .sort((a, b) => b.issues - a.issues),
  };
}

export async function getTimeTracking(
  actor: import('../lib/auth.js').Actor,
  scope: { versionId?: string; sprintId?: string; projectKey?: string }
) {
  const doneIds = (await prisma.status.findMany({ where: { category: 'done' }, select: { id: true } })).map(
    (s) => s.id
  );
  const where = scope.versionId
    ? { versionRefs: { some: { versionId: scope.versionId, kind: 'fix' } } }
    : scope.sprintId
      ? { sprintId: scope.sprintId }
      : scope.projectKey
        ? { project: { key: scope.projectKey.toUpperCase() } }
        : {};
  const issues = await prisma.issue.findMany({
    where: {
      AND: [
        where,
        await visibleIssueWhere(actor),
        {
          OR: [
            { originalEstimateSec: { not: null } },
            { remainingEstimateSec: { not: null } },
            { worklogs: { some: {} } },
          ],
        },
      ],
    },
    select: {
      issueNumber: true,
      summary: true,
      originalEstimateSec: true,
      remainingEstimateSec: true,
      statusId: true,
      project: { select: { key: true } },
      worklogs: { select: { timeSpentSec: true } },
    },
    take: 1000,
  });
  const done = new Set(doneIds);
  let o = 0,
    s = 0,
    r = 0;
  const rows = issues.map((i) => {
    const spent = i.worklogs.reduce((a, w) => a + w.timeSpentSec, 0);
    o += i.originalEstimateSec ?? 0;
    s += spent;
    r += i.remainingEstimateSec ?? 0;
    return {
      key: toIssueKey(i.project.key, i.issueNumber),
      summary: i.summary,
      done: done.has(i.statusId),
      originalEstimateSec: i.originalEstimateSec ?? 0,
      timeSpentSec: spent,
      remainingEstimateSec: i.remainingEstimateSec ?? 0,
    };
  });
  return { totals: { originalEstimateSec: o, timeSpentSec: s, remainingEstimateSec: r }, issues: rows };
}

export async function getTimesheet(
  actor: import('../lib/auth.js').Actor,
  opts: { userId?: string | null; projectKey?: string; from?: string; to?: string }
) {
  // 064 US3 — timesheets expose worklog metadata; only admins may read others'.
  if (opts.userId && opts.userId !== actor.user.id && !actor.user.isAdmin) {
    throw new JiraApiError(403, jiraError(['You may only read your own timesheet.']));
  }
  const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 14 * DAY);
  const to = opts.to ? new Date(opts.to) : new Date();
  const rows = await prisma.worklog.findMany({
    where: {
      started: { gte: from, lte: to },
      ...(opts.userId ? { authorId: opts.userId } : opts.userId === null ? { authorId: actor.user.id } : {}),
      issue: {
        AND: [
          await visibleIssueWhere(actor),
          ...(opts.projectKey ? [{ project: { key: opts.projectKey.toUpperCase() } }] : []),
        ],
      },
    },
    select: {
      authorId: true,
      timeSpentSec: true,
      started: true,
      author: { select: { displayName: true } },
      issue: { select: { issueNumber: true, project: { select: { key: true } } } },
    },
    orderBy: { started: 'asc' },
    take: 5000,
  });
  const days = new Map<string, number>();
  const byUser = new Map<string, { name: string; total: number; days: Map<string, number> }>();
  for (const w of rows) {
    const d = jiraDate(w.started);
    days.set(d, (days.get(d) ?? 0) + w.timeSpentSec);
    const u = byUser.get(w.authorId) ?? { name: w.author.displayName, total: 0, days: new Map<string, number>() };
    u.total += w.timeSpentSec;
    u.days.set(d, (u.days.get(d) ?? 0) + w.timeSpentSec);
    byUser.set(w.authorId, u);
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    workdaySec: 8 * 3600,
    users: [...byUser.entries()].map(([userId, u]) => ({
      userId,
      user: u.name,
      totalSec: u.total,
      days: Object.fromEntries(u.days),
    })),
    totalsByDay: Object.fromEntries([...days.entries()].sort()),
  };
}

export async function getVersionReport(actor: Actor, versionId: string) {
  const version = await prisma.version.findUnique({
    where: { id: versionId },
    include: { project: { select: { key: true, id: true } } },
  });
  if (!version || !(await canSeeProjectId(actor, version.project.id))) {
    throw new JiraApiError(404, jiraError(['Version does not exist.']));
  }
  const doneIds = (await prisma.status.findMany({ where: { category: 'done' }, select: { id: true } })).map(
    (s) => s.id
  );
  const issues = await prisma.issue.findMany({
    where: { AND: [{ versionRefs: { some: { versionId, kind: 'fix' } } }, await visibleIssueWhere(actor)] },
    select: { statusId: true, storyPoints: true, remainingEstimateSec: true },
  });
  const done = issues.filter((i) => doneIds.includes(i.statusId));
  const totalPts = issues.reduce((a, i) => a + (i.storyPoints ?? 0), 0);
  const donePts = done.reduce((a, i) => a + (i.storyPoints ?? 0), 0);
  const remainingSec = issues.reduce((a, i) => a + (i.remainingEstimateSec ?? 0), 0);
  const board = await prisma.board.findFirst({ where: { projectId: version.project.id } });
  let velocity: number | null = null;
  if (board) {
    const closed = await prisma.sprint.findMany({
      where: { boardId: board.id, state: 'closed' },
      orderBy: { completeDate: 'desc' },
      take: 3,
    });
    const sums: number[] = [];
    for (const s of closed) {
      const all = await memberHistories(s.id);
      const vis = await visibleIds(
        actor,
        all.map((h) => h.issueId)
      );
      const histories = all.filter((h) => vis.has(h.issueId));
      const closedAt = (s.completeDate ?? s.endDate)?.getTime() ?? Date.now();
      const names = await doneStatusNames();
      sums.push(
        histories
          .filter((h) => memberAt(h, closedAt) && doneAt(h, closedAt, names))
          .reduce((a, h) => a + pointsAt(h, closedAt), 0)
      );
    }
    if (sums.length) velocity = Math.round((sums.reduce((a, b) => a + b, 0) / sums.length) * 100) / 100;
  }
  const remainingPts = totalPts - donePts;
  const predicted =
    velocity && velocity > 0 ? jiraDate(new Date(Date.now() + Math.ceil(remainingPts / velocity) * 14 * DAY)) : null;
  return {
    version: { id: version.id, name: version.name, released: version.released, releaseDate: version.releaseDate },
    issues: issues.length,
    doneIssues: done.length,
    percentDone: issues.length ? Math.round((done.length / issues.length) * 100) : 0,
    totalPoints: totalPts,
    donePoints: donePts,
    remainingPoints: remainingPts,
    remainingEstimateSec: remainingSec,
    forecast: {
      velocityPerSprint: velocity,
      predictedDate: predicted,
      confidence: velocity ? 'low (heuristic: avg of last 3 closed sprints × 14d)' : 'none',
    },
  };
}

export async function getProjectSummary(projectKey: string, actor: import('../lib/auth.js').Actor) {
  const key = projectKey.toUpperCase();
  const doneIds = (await prisma.status.findMany({ where: { category: 'done' }, select: { id: true } })).map(
    (s) => s.id
  );
  const vis = await visibleIssueWhere(actor);
  const [byStatus, byType, byPriority, open] = await Promise.all([
    prisma.issue.groupBy({ by: ['statusId'], where: { AND: [{ project: { key } }, vis] }, _count: true }),
    prisma.issue.groupBy({ by: ['issueTypeId'], where: { AND: [{ project: { key } }, vis] }, _count: true }),
    prisma.issue.groupBy({ by: ['priorityId'], where: { AND: [{ project: { key } }, vis] }, _count: true }),
    prisma.issue.count({ where: { AND: [{ project: { key }, statusId: { notIn: doneIds } }, vis] } }),
  ]);
  const [statuses, types, prios] = await Promise.all([
    prisma.status.findMany({ select: { id: true, name: true, category: true } }),
    prisma.issueType.findMany({ select: { id: true, name: true } }),
    prisma.priority.findMany({ select: { id: true, name: true } }),
  ]);
  const sMap = new Map(statuses.map((s) => [s.id, s]));
  const tMap = new Map(types.map((t) => [t.id, t.name]));
  const pMap = new Map(prios.map((p) => [p.id, p.name]));
  const trend = await getCreatedVsResolved(actor, `project = ${key}`, 30);
  const events = await prisma.domainEvent.findMany({ where: { project: { key } }, orderBy: { id: 'desc' }, take: 10 });
  return {
    project: key,
    openIssues: open,
    byStatus: byStatus.map((r) => ({
      name: sMap.get(r.statusId)?.name ?? '?',
      category: sMap.get(r.statusId)?.category,
      count: r._count,
    })),
    byType: byType.map((r) => ({ name: tMap.get(r.issueTypeId) ?? '?', count: r._count })),
    byPriority: byPriority.map((r) => ({ name: pMap.get(r.priorityId) ?? 'None', count: r._count })),
    createdVsResolved30d: trend.series,
    recentActivity: events.map((e) => ({ type: e.type, occurredAt: e.occurredAt })),
  };
}

export async function getOrgMetrics(actor: Actor) {
  const vis = await visibleIssueWhere(actor);
  const [issues, users, projects] = await Promise.all([
    prisma.issue.count({ where: vis }),
    prisma.user.count(),
    prisma.project.count(),
  ]);
  const since = new Date(Date.now() - 30 * DAY);
  const created = await prisma.issue.findMany({
    where: { AND: [{ createdAt: { gte: since } }, vis] },
    select: { createdAt: true },
  });
  const growth = new Map<string, number>();
  for (const i of created) {
    const d = jiraDate(i.createdAt);
    growth.set(d, (growth.get(d) ?? 0) + 1);
  }
  const activity = await prisma.domainEvent.groupBy({
    by: ['type'],
    _count: true,
    orderBy: { _count: { type: 'desc' } },
    take: 10,
  });
  return {
    totals: { issues, users, projects },
    issueGrowth30d: Object.fromEntries([...growth.entries()].sort()),
    activityByType: activity.map((a) => ({ type: a.type, count: a._count })),
  };
}

// 065 US5 — "Your work" merge moved out of routes/me.ts: six slices +
// worked-merge is domain logic, not request handling.
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { visibleIssueWhere } from './visibilityService.js';
import { getTimeTrackingConfig } from './settingsService.js';
import { toIssueResponse, toIssueKey } from './issueService.js';

const issueSelect = {
  project: true,
  issueType: true,
  status: true,
  priority: true,
  sprint: true,
  assignee: true,
  reporter: true,
} as const;

export async function getMyWork(actor: Actor) {
  const userId = actor.user.id;
  // 064 US3 — every slice filters through the shared visibility predicate.
  const vis = await visibleIssueWhere(actor);
  const [assigned, watched, reported, recents, commented, createdByMe] = await Promise.all([
    prisma.issue.findMany({
      where: { assigneeId: userId, status: { category: { not: 'done' } }, AND: [vis] },
      orderBy: [{ priority: { sequence: 'asc' } }, { issueNumber: 'asc' }],
      take: 50,
      include: issueSelect,
    }),
    prisma.watcher.findMany({
      where: { userId, issue: { AND: [{ status: { category: { not: 'done' } } }, vis] } },
      take: 50,
      include: { issue: { include: issueSelect } },
      orderBy: { issue: { updatedAt: 'desc' } },
    }),
    prisma.issue.findMany({
      where: { reporterId: userId, status: { category: { not: 'done' } }, assigneeId: { not: userId }, AND: [vis] },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: issueSelect,
    }),
    prisma.recentView.findMany({
      where: { userId, issue: vis },
      orderBy: { viewedAt: 'desc' },
      take: 10,
      include: { issue: { include: issueSelect } },
    }),
    prisma.comment.findMany({
      where: { authorId: userId, issue: vis },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { issue: { include: issueSelect } },
    }),
    prisma.issue.findMany({
      where: { reporterId: userId, AND: [vis] },
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: issueSelect,
    }),
  ]);
  // UB-011 — Jira "Worked on": issues the user created or commented on,
  // sorted by their latest own activity.
  const workedMap = new Map<string, { at: number; issue: unknown }>();
  for (const c of commented) {
    workedMap.set(c.issueId, { at: new Date(c.createdAt).getTime(), issue: c.issue });
  }
  for (const i of createdByMe) {
    const existing = workedMap.get(i.id);
    workedMap.set(i.id, {
      at: Math.max(existing?.at ?? 0, new Date(i.createdAt).getTime()),
      issue: i,
    });
  }
  const worked = [...workedMap.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, 25)
    .map((w) => w.issue);
  return {
    worked: worked.map((i) => toIssueResponse(i as never)),
    assigned: assigned.map((i) => toIssueResponse(i as never)),
    watching: watched.map((w) => toIssueResponse(w.issue as never)),
    reported: reported.map((i) => toIssueResponse(i as never)),
    recent: recents.map((v) => ({
      viewedAt: v.viewedAt.toISOString(),
      key: toIssueKey(v.issue.project.key, v.issue.issueNumber),
      issue: toIssueResponse(v.issue as never),
    })),
  };
}

// --- "Time logged" card — the caller's own timesheet for a month/period ------

/** Count Mon–Fri days between two dates, inclusive (same-day safe). */
function weekdaysBetween(a: Date, b: Date): number {
  if (b < a) return 0;
  let n = 0;
  const d = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()));
  const end = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  while (d.getTime() <= end) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n += 1;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

export async function getMyTimesheet(actor: Actor, opts: { from?: string; to?: string }) {
  const now = new Date();
  // Default: the current calendar month. Dates arrive as YYYY-MM-DD; compare
  // in UTC so timezone never shifts a worklog across the boundary.
  const from = opts.from ? new Date(`${opts.from}T00:00:00Z`) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = opts.to
    ? new Date(`${opts.to}T23:59:59.999Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new JiraApiError(400, jiraError(['from/to must be YYYY-MM-DD with from <= to.']));
  }
  const rows = await prisma.worklog.findMany({
    where: {
      authorId: actor.user.id,
      started: { gte: from, lte: to },
      issue: { AND: [await visibleIssueWhere(actor)] },
    },
    select: {
      timeSpentSec: true,
      started: true,
      issue: {
        select: {
          issueNumber: true,
          summary: true,
          status: { select: { category: true } },
          project: { select: { key: true } },
        },
      },
    },
    orderBy: { started: 'asc' },
    take: 5000,
  });
  const days = new Map<string, number>();
  const byIssue = new Map<string, { key: string; summary: string; statusCategoryKey: string | null; totalSec: number }>();
  let totalSec = 0;
  for (const w of rows) {
    const day = w.started.toISOString().slice(0, 10);
    days.set(day, (days.get(day) ?? 0) + w.timeSpentSec);
    totalSec += w.timeSpentSec;
    const key = toIssueKey(w.issue.project.key, w.issue.issueNumber);
    const slot = byIssue.get(key) ?? {
      key,
      summary: w.issue.summary,
      statusCategoryKey: w.issue.status?.category ?? null,
      totalSec: 0,
    };
    slot.totalSec += w.timeSpentSec;
    byIssue.set(key, slot);
  }
  const cfg = await getTimeTrackingConfig();
  const workdaySec = cfg.hoursPerDay * 3600;
  // Expected time = Mon–Fri count scaled by daysPerWeek/5 (a 5-day config
  // expects weekdays only; a 7-day config expects every day). `toDate` caps at
  // today so mid-month reads as progress-so-far, not a deadline already missed.
  const scale = cfg.daysPerWeek / 5;
  const expectedSec = Math.round(weekdaysBetween(from, to) * scale * workdaySec);
  const expectedToDateSec = Math.round(weekdaysBetween(from, to < now ? to : now) * scale * workdaySec);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    workdaySec,
    totalSec,
    expectedSec,
    expectedToDateSec,
    days: Object.fromEntries([...days.entries()].sort()),
    issues: [...byIssue.values()].sort((a, b) => b.totalSec - a.totalSec),
  };
}

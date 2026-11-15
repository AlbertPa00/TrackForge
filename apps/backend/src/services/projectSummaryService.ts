// 058 US7 — project summary aggregation for the /projects/:key landing page.
// One service call fans out to the cheap aggregates the five widgets need;
// nothing here is charting (D14) — counts and rows only.
import { prisma } from '../prisma.js';
import { jiraDate } from '../lib/http.js';

export async function getProjectSummary(projectId: string, projectKey: string) {
  const [
    statusRollup,
    openByPriority,
    recentChanges,
    recentComments,
    upcomingVersions,
    workload,
    activeSessions,
    openQuestions,
    total,
  ] = await Promise.all([
    // Status donut — count per workflow status (category drives colours).
    prisma.issue.groupBy({
      by: ['statusId'],
      where: { projectId },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ['priorityId'],
      where: { projectId, resolutionId: null },
      _count: { _all: true },
    }),
    prisma.changeHistory.findMany({
      where: { issue: { projectId } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      include: {
        author: { select: { id: true, displayName: true, type: true } },
        issue: { select: { issueNumber: true, summary: true } },
        items: { select: { field: true, fromString: true, toString: true }, take: 3 },
      },
    }),
    prisma.comment.findMany({
      where: { issue: { projectId } },
      orderBy: { createdAt: 'desc' },
      take: 15,
      include: {
        author: { select: { id: true, displayName: true, type: true } },
        issue: { select: { issueNumber: true, summary: true } },
      },
    }),
    prisma.version.findMany({
      where: { projectId, released: false, archived: false },
      orderBy: [{ releaseDate: 'asc' }, { sequence: 'asc' }],
      take: 5,
      include: { _count: { select: { issues: true } } },
    }),
    prisma.issue.groupBy({
      by: ['assigneeId'],
      where: { projectId, resolutionId: null, assigneeId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { assigneeId: 'desc' } },
      take: 10,
    }),
    prisma.agentSession.findMany({
      where: { issue: { projectId }, status: { in: ['running', 'blocked', 'needs-answer'] } },
      select: { status: true, agent: { select: { displayName: true } } },
    }),
    prisma.agentQuestion.count({ where: { issue: { projectId }, status: 'open' } }),
    prisma.issue.count({ where: { projectId } }),
  ]);

  // Resolve group-by ids → names in one shot each.
  const [statuses, priorities, assignees] = await Promise.all([
    prisma.status.findMany({
      where: { id: { in: statusRollup.map((s) => s.statusId) } },
      select: { id: true, name: true, category: true },
    }),
    prisma.priority.findMany({
      where: { id: { in: openByPriority.map((p) => p.priorityId) } },
      select: { id: true, name: true, sequence: true },
    }),
    prisma.user.findMany({
      where: { id: { in: workload.map((w) => w.assigneeId!) } },
      select: { id: true, displayName: true, type: true },
    }),
  ]);
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const priorityById = new Map(priorities.map((p) => [p.id, p]));
  const userById = new Map(assignees.map((u) => [u.id, u]));

  const activity = [
    ...recentComments.map((c) => ({
      type: 'comment' as const,
      at: c.createdAt.toISOString(),
      issueKey: `${projectKey}-${c.issue.issueNumber}`,
      issueSummary: c.issue.summary,
      actor: c.author.displayName,
      actorAccountId: c.author.id,
      agent: c.author.type === 'agent',
      channel: c.channel,
      text: c.body.length > 140 ? `${c.body.slice(0, 140)}…` : c.body,
    })),
    ...recentChanges.map((h) => ({
      type: 'change' as const,
      at: h.createdAt.toISOString(),
      issueKey: `${projectKey}-${h.issue.issueNumber}`,
      issueSummary: h.issue.summary,
      actor: h.author.displayName,
      actorAccountId: h.author.id,
      agent: h.author.type === 'agent',
      channel: h.channel,
      text: h.items.map((i) => `${i.field}${i.fromString ? ` ${i.fromString}` : ''} → ${i.toString ?? '—'}`).join(', '),
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);

  return {
    totals: {
      issues: total,
      open: statusRollup
        .filter((s) => statusById.get(s.statusId)?.category !== 'done')
        .reduce((n, s) => n + s._count._all, 0),
    },
    statusRollup: statusRollup
      .map((s) => ({
        status: statusById.get(s.statusId)?.name ?? 'Unknown',
        category: statusById.get(s.statusId)?.category ?? 'new',
        count: s._count._all,
      }))
      .sort((a, b) => b.count - a.count),
    openByPriority: openByPriority
      .map((p) => ({
        priority: priorityById.get(p.priorityId)?.name ?? 'Unknown',
        sequence: priorityById.get(p.priorityId)?.sequence ?? 0,
        count: p._count._all,
      }))
      .sort((a, b) => a.sequence - b.sequence),
    activity,
    upcomingVersions: upcomingVersions.map((v) => ({
      id: v.id,
      name: v.name,
      releaseDate: v.releaseDate ? jiraDate(v.releaseDate) : null,
      issueCount: v._count.issues,
    })),
    workload: workload.map((w) => ({
      user: userById.get(w.assigneeId!)?.displayName ?? 'Unknown',
      accountId: w.assigneeId!,
      agent: userById.get(w.assigneeId!)?.type === 'agent',
      open: w._count._all,
    })),
    agents: {
      running: activeSessions.filter((s) => s.status === 'running').length,
      blocked: activeSessions.filter((s) => s.status === 'blocked').length,
      needsAnswer: activeSessions.filter((s) => s.status === 'needs-answer').length,
      openQuestions,
      agents: [...new Set(activeSessions.map((s) => s.agent.displayName))],
    },
  };
}

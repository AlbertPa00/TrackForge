// 071 US4 — context-pack: one deterministic call that replaces the 6-7
// bootstrapping tool calls a cold-start agent used to need. Sections pack in
// priority order under a token budget (4 chars ≈ 1 token); peer-authored
// content is wrapped in <untrusted_data> markers so a downstream LLM keeps it
// out of the instruction channel (prompt-injection containment).

import { prisma } from '../prisma.js';
import { Prisma } from '../lib/pc.js';
import { getIssueByKey } from './issueService.js';
import { enforceIssueScope } from '../middleware/auth.js';
import type { Actor } from '../lib/auth.js';

const CHARS_PER_TOKEN = 4;

interface Section {
  priority: number;
  name: string;
  body: string;
}

function untrusted(actor: string, channel: string, body: string): string {
  return `<untrusted_data actor="${actor.replace(/"/g, '')}" channel="${channel.replace(/"/g, '')}">\n${body}\n</untrusted_data>`;
}

export async function getContextPack(actor: Actor, issueKey: string, maxTokens = 4000) {
  const key = issueKey.toUpperCase();
  await enforceIssueScope(key, actor);
  const issue = await getIssueByKey(key);
  const budget = Math.max(200, Math.min(50_000, maxTokens)) * CHARS_PER_TOKEN;

  const [sessions, handoffs, topicLinks, traces, comments] = await Promise.all([
    prisma.agentSession.findMany({
      where: { issueId: issue.id, status: { in: ['running', 'needs-answer', 'blocked'] } },
      include: { agent: { select: { displayName: true } } },
      orderBy: { startedAt: 'desc' },
    }),
    prisma.agentSession.findMany({
      where: { issueId: issue.id, handoff: { not: Prisma.DbNull } },
      select: { handoff: true, agent: { select: { displayName: true } }, finishedAt: true },
      orderBy: { finishedAt: 'desc' },
      take: 5,
    }),
    prisma.townHallTopicIssue.findMany({
      where: { issueId: issue.id, topic: { status: 'decided' } },
      include: { topic: { select: { id: true, title: true, decisionSummary: true, resolvedAt: true } } },
      take: 10,
    }),
    prisma.stigmergicTrace.findMany({
      where: {
        projectId: issue.projectId,
        expiresAt: { gt: new Date() },
        session: { status: { in: ['running', 'needs-answer', 'blocked'] } },
      },
      include: {
        issue: { select: { issueNumber: true, project: { select: { key: true } } } },
        session: { select: { agent: { select: { displayName: true } }, id: true } },
      },
      take: 100,
    }),
    prisma.comment.findMany({
      where: { issueId: issue.id },
      include: { author: { select: { displayName: true, type: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const keyOf = `${issue.project.key}-${issue.issueNumber}`;
  const sections: Section[] = [];

  // P0 — issue core + lease/transition state + project guidance (authoritative).
  const allowed = await import('./workflowService.js').then((m) => m.listAvailableTransitions(issue, actor));
  const activeLeases = sessions.map((s) => ({
    role: s.role,
    agent: s.agent.displayName,
    fenceToken: s.fenceToken,
    leaseExpiresAt: s.leaseExpiresAt?.toISOString() ?? null,
    worktreeRef: s.worktreeRef,
  }));
  sections.push({
    priority: 0,
    name: 'issue',
    body: JSON.stringify({
      key: keyOf,
      id: issue.id,
      version: issue.version,
      lastFenceToken: issue.lastFenceToken,
      summary: issue.summary,
      description: issue.description,
      status: issue.status.name,
      issueType: issue.issueType.name,
      priority: issue.priority.name,
      assignee: issue.assignee?.displayName ?? null,
      delegate: issue.delegate?.displayName ?? null,
      labels: issue.labels,
      resolution: issue.resolution?.name ?? null,
      activeLeases,
      availableTransitions: allowed.map((t) => ({ id: t.id, name: t.name, to: t.to.name })),
    }),
  });
  const guidance = [issue.project.agentGuidance].filter(Boolean).join('\n');
  if (guidance) sections.push({ priority: 0, name: 'systemGuidance', body: guidance });

  // P1 — prior handoffs + doNotRepeat warnings (untrusted peer content), and
  // 072 FR-012 path-scoped repo advisories: verified lessons survive closed
  // issues. Match against the paths this issue's sessions declared; with no
  // declared targets yet, surface the newest active advisories so cold-start
  // agents still inherit the repo's pitfalls.
  {
    const { matchingAdvisories } = await import('./advisoryService.js');
    const declaredPaths = traces.map((t) => t.target);
    let advs = declaredPaths.length ? await matchingAdvisories(issue.projectId, declaredPaths) : [];
    if (!advs.length) advs = await matchingAdvisories(issue.projectId, []);
    if (advs.length) {
      const body = advs
        .slice(0, 10)
        .map((a) => untrusted(a.createdBy, 'advisory', `[${a.severity}] ${a.pathGlob}: ${a.summary}`))
        .join('\n\n');
      sections.push({ priority: 1, name: 'repoAdvisories', body });
    }
  }
  if (handoffs.length) {
    const body = handoffs
      .map((h) => {
        const ho = h.handoff as { summary?: string; remainingSteps?: string[]; doNotRepeat?: string[]; outcome?: string };
        return untrusted(
          h.agent.displayName,
          'handoff',
          `outcome: ${ho.outcome ?? '?'}\nsummary: ${ho.summary ?? ''}\nremaining: ${(ho.remainingSteps ?? []).join('; ')}\ndoNotRepeat: ${(ho.doNotRepeat ?? []).join('; ')}`
        );
      })
      .join('\n\n');
    sections.push({ priority: 1, name: 'handoffs', body });
  }

  // 073 FR-003/FR-004 — latest deliverable review feedback (especially
  // changes_requested notes) + attached receipt digest summary so a woken
  // agent sees exactly what the reviewer asked for without extra round trips.
  {
    const [latestReview, issueReceipts] = await Promise.all([
      prisma.deliverableReview.findFirst({
        where: { issueId: issue.id },
        orderBy: { createdAt: 'desc' },
        include: { reviewer: { select: { displayName: true, type: true } } },
      }),
      prisma.workReceipt.findMany({
        where: { issueId: issue.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, kind: true, sha256: true, verification: true, changedFiles: true, summary: true },
      }),
    ]);
    if (latestReview) {
      const state = latestReview.supersededAt ? `${latestReview.verdict} (stale)` : latestReview.verdict;
      sections.push({
        priority: 1,
        name: 'deliverableReview',
        body: untrusted(
          latestReview.reviewer.displayName,
          'deliverable_review',
          `verdict: ${state} (${latestReview.reviewer.type})\npinnedHeadSha: ${latestReview.pinnedHeadSha ?? 'none'}\nnotes: ${latestReview.body ?? '(none)'}`
        ),
      });
    }
    if (issueReceipts.length) {
      sections.push({
        priority: 2,
        name: 'workReceipts',
        body: issueReceipts
          .map(
            (r) =>
              `${r.kind} ${r.sha256.slice(0, 12)} [${r.verification}] files=${(r.changedFiles ?? []).join(',') || 'none'} — ${r.summary.slice(0, 120)}`
          )
          .join('\n'),
      });
    }
  }

  // P2 — linked Town Hall decisions + cross-issue trace collisions.
  if (topicLinks.length) {
    const body = topicLinks
      .map((l) => `decision '${l.topic.title}' (${l.topic.id}, relation=${l.relation}):\n${l.topic.decisionSummary ?? ''}`)
      .join('\n\n');
    sections.push({ priority: 2, name: 'townHallDecisions', body: untrusted('town-hall', 'town_hall', body) });
  }
  if (traces.length) {
    const body = traces
      .map(
        (t) =>
          `${t.kind} ${t.target} — ${t.session.agent.displayName} on ${t.issue.project.key}-${t.issue.issueNumber} (expires ${t.expiresAt.toISOString()})`
      )
      .join('\n');
    sections.push({ priority: 2, name: 'activeTraces', body });
  }

  // P3 — parents/children + blocked-by DAG.
  const relBits: string[] = [];
  if (issue.parent) relBits.push(`parent: ${issue.parent.project.key}-${issue.parent.issueNumber} (${issue.parent.status.name})`);
  if (issue.children?.length) {
    relBits.push(`children: ${issue.children.map((c) => `${c.project.key}-${c.issueNumber}`).join(', ')}`);
  }
  const blockers = (issue.inLinks ?? []).filter((l) => l.type.outward.toLowerCase() === 'blocks');
  if (blockers.length) {
    relBits.push(
      `blockedBy: ${blockers.map((l) => `${l.outwardIssue.project.key}-${l.outwardIssue.issueNumber} (${l.outwardIssue.status?.name ?? '?'})`).join(', ')}`
    );
  }
  const blocking = (issue.outLinks ?? []).filter((l) => l.type.outward.toLowerCase() === 'blocks');
  if (blocking.length) {
    relBits.push(
      `blocks: ${blocking.map((l) => `${l.inwardIssue.project.key}-${l.inwardIssue.issueNumber} (${l.inwardIssue.status?.name ?? '?'})`).join(', ')}`
    );
  }
  if (relBits.length) sections.push({ priority: 3, name: 'relationships', body: relBits.join('\n') });

  // P4 — recent comments (untrusted; authors may be humans or other agents).
  if (comments.length) {
    const body = comments
      .reverse()
      .map((c) => untrusted(c.author.displayName, c.channel, c.body.slice(0, 1500)))
      .join('\n\n');
    sections.push({ priority: 4, name: 'comments', body });
  }

  // Priority packing: emit sections in order until the budget runs out;
  // the lowest-priority section is elided first, never truncated mid-JSON.
  sections.sort((a, b) => a.priority - b.priority);
  const packed: { name: string; body: string; elided?: boolean }[] = [];
  let used = 0;
  let elided = 0;
  for (const s of sections) {
    if (used + s.body.length > budget) {
      elided += 1;
      continue;
    }
    used += s.body.length;
    packed.push({ name: s.name, body: s.body });
  }
  return {
    issueKey: keyOf,
    version: issue.version,
    lastFenceToken: issue.lastFenceToken,
    maxTokens,
    sections: packed,
    elidedSections: elided,
  };
}

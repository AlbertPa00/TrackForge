// 047 US2/US3 — agent sessions + question interrupts. Sessions are the
// inspectable work-in-progress of a delegated task; questions are the
// "question" interrupt mode (notify/question/review — review = proposals).
// Every activity/question is attributable (FR-002) and lands on the 011 bus.
import { prisma } from '../prisma.js';
import { Prisma } from '../lib/pc.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { emitEvent } from './eventService.js';
import { recordChange } from './changelogService.js';
import { hasPermission } from './permissionService.js';
import type { Actor } from '../lib/auth.js';

export interface SessionView {
  id: string;
  issueKey: string;
  agent: string;
  delegator: string | null;
  trigger: string;
  status: string;
  role: string;
  fenceToken: number | null;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  worktreeRef: string | null;
  // 072 — git grounding + trace-vs-diff reconciliation verdict.
  baseSha: string | null;
  headSha: string | null;
  branchName: string | null;
  driftStatus: string;
  driftReport: unknown;
  dossierCommentId: string | null;
  activities: unknown[];
  guidance: string | null; // 047 US4-3 — project agentGuidance for the working agent
  startedAt: string;
  finishedAt: string | null;
  lastActivityAt: string;
}

const keyOf = (i: { project: { key: string }; issueNumber: number }) => `${i.project.key}-${i.issueNumber}`;

/** Issue snapshot for event payloads — lets the notification scheme resolve
 *  reporter/assignee like a normal issue event (US2-2/US3-1). */
const issueSnapshot = (i: { assigneeId: string | null; reporterId: string | null; summary: string }) => ({
  fields: {
    assignee: i.assigneeId ? { accountId: i.assigneeId } : null,
    reporter: i.reporterId ? { accountId: i.reporterId } : null,
    summary: i.summary,
  },
});

/** Wire shape of one activity item — unchanged from the Json-column era. */
interface ActivityRow {
  type: string;
  text: string;
  byName: string;
  createdAt: Date;
}

export function toSessionView(s: {
  id: string;
  status: string;
  trigger: string;
  role?: string;
  fenceToken?: number | null;
  leaseExpiresAt?: Date | null;
  heartbeatAt?: Date | null;
  worktreeRef?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  branchName?: string | null;
  driftStatus?: string;
  driftReport?: unknown;
  dossierCommentId?: string | null;
  activities: ActivityRow[];
  startedAt: Date;
  finishedAt: Date | null;
  lastActivityAt: Date;
  agent: { displayName: string };
  delegator: { displayName: string } | null;
  issue: { project: { key: string; agentGuidance?: string | null }; issueNumber: number };
}): SessionView {
  return {
    id: s.id,
    issueKey: keyOf(s.issue),
    agent: s.agent.displayName,
    delegator: s.delegator?.displayName ?? null,
    trigger: s.trigger,
    status: s.status,
    role: s.role ?? 'driver',
    fenceToken: s.fenceToken ?? null,
    leaseExpiresAt: s.leaseExpiresAt?.toISOString() ?? null,
    heartbeatAt: s.heartbeatAt?.toISOString() ?? null,
    worktreeRef: s.worktreeRef ?? null,
    // 072 — git grounding + trace-vs-diff verdict on the session itself.
    baseSha: s.baseSha ?? null,
    headSha: s.headSha ?? null,
    branchName: s.branchName ?? null,
    driftStatus: s.driftStatus ?? 'untracked',
    driftReport: s.driftReport ?? null,
    dossierCommentId: s.dossierCommentId ?? null,
    activities: s.activities.map((a) => ({ at: a.createdAt.toISOString(), type: a.type, text: a.text, by: a.byName })),
    guidance: s.issue.project.agentGuidance ?? null,
    startedAt: s.startedAt.toISOString(),
    finishedAt: s.finishedAt?.toISOString() ?? null,
    lastActivityAt: s.lastActivityAt.toISOString(),
  };
}

const sessionInclude = {
  issue: { include: { project: true } },
  agent: true,
  delegator: true,
  activities: { orderBy: { id: 'asc' } },
} as const;

/** Hot-path include for writes/sweeps — everything the status check + event
 *  payload need, minus the (potentially long) activity history. */
const sessionMetaInclude = {
  issue: {
    select: {
      id: true,
      projectId: true,
      issueNumber: true,
      assigneeId: true,
      reporterId: true,
      summary: true,
      project: { select: { key: true } },
    },
  },
} as const;

export async function listIssueSessions(issueKey: string): Promise<SessionView[]> {
  const { parseIssueKey } = await import('./issueService.js');
  const { projectKey, issueNumber } = await parseIssueKey(issueKey);
  const sessions = await prisma.agentSession.findMany({
    where: { issue: { project: { key: projectKey }, issueNumber } },
    include: sessionInclude,
    orderBy: { startedAt: 'desc' },
  });
  return sessions.map(toSessionView);
}

export async function getSession(id: string) {
  const s = await prisma.agentSession.findUnique({ where: { id }, include: sessionInclude });
  if (!s) throw new JiraApiError(404, jiraError(['Agent session not found.']));
  return s;
}

/** Who may act on a session: the agent itself, the delegator, or an admin. */
export function assertSessionActor(actor: Actor, s: { agentUserId: string; delegatorId: string | null }) {
  if (actor.user.isAdmin) return;
  if (actor.user.id === s.agentUserId || actor.user.id === s.delegatorId) return;
  throw new JiraApiError(403, jiraError(['Only the agent, the delegator, or an admin may touch a session.']));
}

/** US2-1 — the agent reports a step. `status` transitions close the session.
 *  070: one transaction appends an AgentActivity row, bumps the session, and
 *  emits the event — no read-modify-write of a growing JSON blob, no window
 *  between "session updated" and "event written" for a crash to split. */
export async function emitActivity(
  actor: Actor,
  sessionId: string,
  input: { type: 'thought' | 'action' | 'error'; text: string; status?: 'done' | 'failed' | 'blocked' | 'running' }
) {
  const s = await prisma.agentSession.findUnique({ where: { id: sessionId }, include: sessionMetaInclude });
  if (!s) throw new JiraApiError(404, jiraError(['Agent session not found.']));
  if (s.status !== 'running' && s.status !== 'blocked' && s.status !== 'needs-answer') {
    throw new JiraApiError(409, jiraError([], { session: `Session is ${s.status}.` }));
  }
  assertSessionActor(actor, s);
  const closing = input.status === 'done' || input.status === 'failed';
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    await tx.agentActivity.create({
      data: {
        sessionId: s.id,
        type: input.type,
        text: input.text.slice(0, 4000),
        byName: actor.user.displayName,
        createdAt: now,
      },
    });
    const u = await tx.agentSession.update({
      where: { id: s.id },
      data: {
        lastActivityAt: now,
        ...(input.status ? { status: input.status } : {}),
        ...(closing ? { finishedAt: now } : {}),
      },
      include: sessionInclude,
    });
    await emitEvent(tx, actor, {
      type: 'agent_session.activity',
      projectId: s.issue.projectId,
      issueId: s.issueId,
      payload: {
        sessionId: s.id,
        issueKey: keyOf(s.issue),
        activityType: input.type,
        status: u.status,
        delegatorId: s.delegatorId,
        issue: issueSnapshot(s.issue),
      },
    });
    return u;
  });
  return toSessionView(updated);
}

// ---------- US3 — question interrupts ----------

export async function askQuestion(
  actor: Actor,
  input: { issueKey: string; sessionId: string; question: string; options?: string[]; expiresInSec?: number }
) {
  const s = await getSession(input.sessionId);
  assertSessionActor(actor, s);
  if (s.status !== 'running' && s.status !== 'blocked') {
    throw new JiraApiError(409, jiraError([], { session: `Session is ${s.status} — cannot ask.` }));
  }
  const expiresAt = new Date(Date.now() + (input.expiresInSec ?? 86_400) * 1000);
  const q = await prisma.$transaction(async (tx) => {
    const created = await tx.agentQuestion.create({
      data: {
        sessionId: s.id,
        issueId: s.issueId,
        question: input.question,
        options: input.options ?? undefined,
        expiresAt,
      },
    });
    await tx.agentSession.update({ where: { id: s.id }, data: { status: 'needs-answer', lastActivityAt: new Date() } });
    await emitEvent(tx, actor, {
      type: 'agent_question.created',
      projectId: s.issue.projectId,
      issueId: s.issueId,
      payload: {
        questionId: created.id,
        sessionId: s.id,
        issueKey: input.issueKey,
        question: input.question,
        delegatorId: s.delegatorId,
        issue: issueSnapshot(s.issue),
      },
    });
    return created;
  });
  return q;
}

/** US3-2 — anyone with comment rights may answer; recorded as the author. */
export async function answerQuestion(actor: Actor, questionId: string, answer: string) {
  const q = await prisma.agentQuestion.findUnique({
    where: { id: questionId },
    include: { session: { include: { issue: { include: { project: true } } } } },
  });
  if (!q) throw new JiraApiError(404, jiraError(['Agent question not found.']));
  if (q.status !== 'open') throw new JiraApiError(409, jiraError([], { question: `Question is ${q.status}.` }));
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.agentQuestion.update({
      where: { id: q.id },
      data: { status: 'answered', answer, answeredById: actor.user.id, answeredAt: new Date() },
    });
    // 071 — only a blocking question (session waiting in needs-answer)
    // resumes the session; peer consults never blocked it in the first place.
    if (q.session.status === 'needs-answer') {
      await tx.agentSession.update({
        where: { id: q.sessionId },
        data: { status: 'running', lastActivityAt: new Date() },
      });
    }
    await emitEvent(tx, actor, {
      type: 'agent_question.answered',
      projectId: q.session.issue.projectId,
      issueId: q.issueId,
      payload: {
        questionId: q.id,
        sessionId: q.sessionId,
        issueKey: keyOf(q.session.issue),
        answer,
        answeredBy: actor.user.displayName,
        delegatorId: q.session.delegatorId,
        issue: issueSnapshot(q.session.issue),
        inbox:
          q.session.agentUserId !== actor.user.id
            ? [
                {
                  userId: q.session.agentUserId,
                  reason: 'question_answered',
                  actionHint: `${actor.user.displayName} answered your question on ${keyOf(q.session.issue)}.`,
                },
              ]
            : [],
      },
    });
    return u;
  });
  return updated;
}

/** Questions on an issue — the agent-questions inbox (US3, A2). */
export async function listIssueQuestions(issueKey: string, status?: string) {
  const { parseIssueKey } = await import('./issueService.js');
  const { projectKey, issueNumber } = await parseIssueKey(issueKey);
  return prisma.agentQuestion.findMany({
    where: {
      issue: { project: { key: projectKey }, issueNumber },
      ...(status ? { status } : {}),
    },
    include: { answeredBy: { select: { displayName: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getQuestion(id: string) {
  const q = await prisma.agentQuestion.findUnique({
    where: { id },
    include: { session: { include: { issue: { include: { project: true } } } }, answeredBy: true },
  });
  if (!q) throw new JiraApiError(404, jiraError(['Agent question not found.']));
  return q;
}

// ---------- 063 US4 — atomic "claim next ready work" ----------

/**
 * Atomically delegates the top-ranked *ready* issue to an agent and opens a
 * `trigger='claim'` session in one transaction — the multi-agent pickup
 * primitive (Beads' ready-work + lease semantics on the Jira data model).
 *
 * Ready = unresolved, unarchived, not already delegated, and carrying no
 * unresolved "blocks" blocker (the ready() JQL predicate's own definition).
 * The row is locked FOR UPDATE SKIP LOCKED so concurrent claims can never
 * hand the same issue to two agents; the delegate write + changelog + session
 * + event commit or fail together (FR-002).
 */
export async function claimReadyWork(
  actor: Actor,
  input: { projectKey: string; jql?: string; agent?: { accountId?: string; name?: string } }
) {
  const project = await prisma.project.findUnique({
    where: { key: input.projectKey.toUpperCase() },
  });
  const allowList = actor.token?.projectKeys;
  if (!project || (allowList?.length && !allowList.includes(project.key))) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  if (!(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: project.id }))) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }

  // Claim target: the caller when it is itself an assignable agent, else the
  // explicit `agent` ref (an admin/orchestrator claiming on another's behalf).
  const { resolveDelegateRef, toIssueKey } = await import('./issueService.js');
  const agent = await resolveDelegateRef(
    input.agent ?? (actor.user.isAssignableAgent ? { accountId: actor.user.id } : null)
  );
  if (!agent) {
    throw new JiraApiError(
      400,
      jiraError([], {
        agent: 'Claim requires an assignable agent — the caller is not one; pass agent:{accountId|name}.',
      })
    );
  }

  // 071 — fleet capacity: an agent may not hoard more open driver leases than
  // its profile allows (default 1). Overflow stays in ready() for the next claim.
  const { activeDriverLeases, maxConcurrentLeases, touchPresence } = await import('./agentProfileService.js');
  const [open, cap] = await Promise.all([activeDriverLeases(agent.id), maxConcurrentLeases(agent.id)]);
  if (open >= cap) {
    throw new JiraApiError(409, jiraError([], { agent: `Lease capacity reached (${open}/${cap} open driver sessions).` }));
  }

  // Candidate set = ready predicate ∩ project ∩ optional caller JQL. The JQL
  // arm runs through the same compiler (token scope + permission filtering
  // apply) so a claim can narrow — never widen — the visible set.
  // 070: "no unresolved blocks-link" is a relational NOT EXISTS now — the old
  // blockedIssueIds() pre-scan loaded every unresolved link in the DB into a
  // notIn list before candidates were even fetched.
  const readyWhere = {
    inLinks: {
      none: {
        type: { outward: { equals: 'blocks', mode: 'insensitive' as const } },
        outwardIssue: { resolutionId: null },
      },
    },
  };
  let where: Record<string, unknown> = {
    projectId: project.id,
    resolutionId: null,
    delegateId: null,
    archived: false,
    ...readyWhere,
  };
  if (input.jql) {
    const { parseJql, JqlParseError } = await import('../jql/parser.js');
    const { compileJql } = await import('../jql/compiler.js');
    try {
      const { where: jqlWhere } = await compileJql(parseJql(input.jql), actor);
      where = { AND: [where, jqlWhere] };
    } catch (e) {
      if (e instanceof JqlParseError) {
        throw new JiraApiError(400, jiraError([], { jql: (e as Error).message }));
      }
      throw e;
    }
  }
  const candidates = await prisma.issue.findMany({
    where: where as never,
    select: { id: true },
    orderBy: [{ rank: 'asc' }, { issueNumber: 'asc' }],
    take: 50,
  });
  // 072 FR-011 — DAG-aware + handoff-aware ranking: issues compiled from a
  // decided town-hall topic and issues whose last handoff names this agent
  // outrank plain backlog order. The fleet builds what it decided to build.
  const candidateIdList = candidates.map((c) => c.id);
  const [compiledLinks, handoffSessions] = await Promise.all([
    prisma.townHallTopicIssue.findMany({
      where: { issueId: { in: candidateIdList }, relation: 'compiled', topic: { status: 'decided' } },
      select: { issueId: true },
    }),
    prisma.agentSession.findMany({
      where: { issueId: { in: candidateIdList }, status: 'released', handoff: { not: Prisma.DbNull } },
      select: { issueId: true, handoff: true },
      orderBy: { finishedAt: 'desc' },
    }),
  ]);
  const boost = new Map<string, number>();
  for (const l of compiledLinks) boost.set(l.issueId, (boost.get(l.issueId) ?? 0) + 100);
  for (const s of handoffSessions) {
    const na = (s.handoff as { nextAssignee?: string } | null)?.nextAssignee;
    if (na && (na === agent.displayName || na === agent.id)) boost.set(s.issueId, (boost.get(s.issueId) ?? 0) + 50);
  }
  const candidateIds = [...candidateIdList].sort(
    (a, b) => (boost.get(b) ?? 0) - (boost.get(a) ?? 0) || candidateIdList.indexOf(a) - candidateIdList.indexOf(b)
  );

  const claimed = await prisma.$transaction(async (tx) => {
    // Re-check the mutable predicates under a row lock — delegation,
    // resolution, AND blockedness are TOCTOU hazards (a blocker could resolve
    // or appear between candidate fetch and lock). NOT EXISTS rides the
    // IssueLink_inwardId index.
    const rows = candidateIds.length
      ? await tx.$queryRaw<{ id: string; issueNumber: number }[]>`
          SELECT "Issue".id, "Issue"."issueNumber" FROM "Issue"
          WHERE "Issue".id = ANY(${candidateIds}::text[])
            AND "Issue"."delegateId" IS NULL
            AND "Issue"."resolutionId" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "IssueLink" l
              JOIN "IssueLinkType" lt ON lt.id = l."typeId"
              JOIN "Issue" lo ON lo.id = l."outwardId"
              WHERE l."inwardId" = "Issue".id
                AND lower(lt."outward") = 'blocks'
                AND lo."resolutionId" IS NULL
            )
          ORDER BY array_position(${candidateIds}::text[], "Issue".id)
          LIMIT 1
          FOR UPDATE SKIP LOCKED`
      : [];
    const row = rows[0];
    if (!row) return null;
    // 071 — delegate + fence mint atomically: every driver session carries the
    // issue's current fencing token so a re-leased zombie can't write back.
    const bumped = await tx.issue.update({
      where: { id: row.id },
      data: { delegateId: agent.id, lastFenceToken: { increment: 1 } },
      select: { lastFenceToken: true },
    });
    const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_DEFAULT_SEC * 1000);
    const session = await tx.agentSession.create({
      data: {
        issueId: row.id,
        agentUserId: agent.id,
        // A self-claim has no human delegator; a claim on behalf records who pulled.
        delegatorId: actor.user.id === agent.id ? null : actor.user.id,
        trigger: 'claim',
        role: 'driver',
        fenceToken: bumped.lastFenceToken,
        leaseExpiresAt,
        heartbeatAt: new Date(),
      },
    });
    await recordChange(tx, row.id, actor, [
      { field: 'delegate', from: null, fromString: null, to: agent.id, toString: agent.displayName },
    ]);
    await emitEvent(tx, actor, {
      type: 'agent_session.created',
      projectId: project.id,
      issueId: row.id,
      payload: {
        issueKey: toIssueKey(project.key, row.issueNumber),
        delegateId: agent.id,
        trigger: 'claim',
      },
    });
    return {
      issueId: row.id,
      issueKey: toIssueKey(project.key, row.issueNumber),
      sessionId: session.id,
      fenceToken: bumped.lastFenceToken,
      leaseExpiresAt,
    };
  });

  if (!claimed) {
    throw new JiraApiError(409, jiraError(['No ready issues to claim.']));
  }
  const issue = await prisma.issue.findUnique({ where: { id: claimed.issueId } });
  await touchPresence(agent.id, new Date());
  return {
    issue: {
      id: issue!.id,
      key: claimed.issueKey,
      fields: {
        summary: issue!.summary,
        status: (await prisma.status.findUnique({ where: { id: issue!.statusId }, select: { name: true } }))?.name,
        delegate: { accountId: agent.id, displayName: agent.displayName },
      },
    },
    sessionId: claimed.sessionId,
    lease: { fenceToken: claimed.fenceToken, expiresAt: claimed.leaseExpiresAt.toISOString() },
  };
}

/** 047 edge — agent deactivated/deleted mid-session: open sessions resolve
 *  failed, their open questions close, delegate clears everywhere, and each
 *  delegator is notified via the agent_session.failed event. */
export async function deactivateAgent(agentUserId: string) {
  const open = await prisma.agentSession.findMany({
    where: { agentUserId, status: { in: ['running', 'blocked', 'needs-answer'] } },
    include: sessionMetaInclude,
  });
  for (const s of open) {
    await prisma.$transaction(async (tx) => {
      await tx.agentSession.update({
        where: { id: s.id },
        data: { status: 'failed', finishedAt: new Date() },
      });
      await tx.agentQuestion.updateMany({
        where: { sessionId: s.id, status: 'open' },
        data: { status: 'expired' },
      });
      await emitEvent(tx, null, {
        type: 'agent_session.failed',
        projectId: s.issue.projectId,
        issueId: s.issueId,
        payload: {
          sessionId: s.id,
          issueKey: keyOf(s.issue),
          reason: 'agent-deactivated',
          delegatorId: s.delegatorId,
          issue: issueSnapshot(s.issue),
        },
      });
    });
  }
  await prisma.issue.updateMany({ where: { delegateId: agentUserId }, data: { delegateId: null } });
  return open.length;
}

/** US2-2 + US3-3 — stall/expiry sweep (durable job): stuck sessions block,
 *  lapsed questions fail the session — no silent hangs. */
export async function sweepStaleSessions(staleMs = 30 * 60 * 1000) {
  const cutoff = new Date(Date.now() - staleMs);
  let actions = 0;
  const expired = await prisma.agentQuestion.findMany({
    where: { status: 'open', expiresAt: { lt: new Date() } },
    include: { session: { include: { issue: { include: { project: true } } } } },
  });
  for (const q of expired) {
    await prisma.$transaction(async (tx) => {
      await tx.agentQuestion.update({ where: { id: q.id }, data: { status: 'expired' } });
      await tx.agentSession.update({
        where: { id: q.sessionId },
        data: { status: 'failed', finishedAt: new Date() },
      });
      await emitEvent(tx, null, {
        type: 'agent_session.failed',
        projectId: q.session.issue.projectId,
        issueId: q.issueId,
        payload: {
          sessionId: q.sessionId,
          issueKey: keyOf(q.session.issue),
          reason: 'question-expired',
          delegatorId: q.session.delegatorId,
          issue: issueSnapshot(q.session.issue),
        },
      });
    });
    actions += 1;
  }
  const stale = await prisma.agentSession.findMany({
    where: { status: 'running', lastActivityAt: { lt: cutoff } },
    include: { issue: { include: { project: true } } },
  });
  for (const s of stale) {
    await prisma.$transaction(async (tx) => {
      await tx.agentSession.update({ where: { id: s.id }, data: { status: 'blocked' } });
      await emitEvent(tx, null, {
        type: 'agent_session.blocked',
        projectId: s.issue.projectId,
        issueId: s.issueId,
        payload: {
          sessionId: s.id,
          issueKey: keyOf(s.issue),
          reason: 'stalled',
          delegatorId: s.delegatorId,
          issue: issueSnapshot(s.issue),
        },
      });
    });
    actions += 1;
  }
  return actions;
}

// 058 US5 — one-shot map of live agent work for every card on a board/backlog
// (badges), so pages don't fan out one /sessions request per issue.
export async function projectAgentActivity(actor: Actor, projectKey: string) {
  const project = await prisma.project.findUnique({ where: { key: projectKey.toUpperCase() } });
  if (!project || !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: project.id }))) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  const [sessions, questions] = await Promise.all([
    prisma.agentSession.findMany({
      where: {
        issue: { projectId: project.id },
        status: { in: ['running', 'blocked', 'needs-answer'] },
      },
      select: {
        status: true,
        agent: { select: { displayName: true } },
        issue: { select: { issueNumber: true } },
      },
    }),
    prisma.agentQuestion.findMany({
      where: { issue: { projectId: project.id }, status: 'open' },
      select: { issue: { select: { issueNumber: true } } },
    }),
  ]);
  const issues: Record<string, { running: number; blocked: number; needsAnswer: number; agents: string[] }> = {};
  const bump = (key: string) => (issues[key] ??= { running: 0, blocked: 0, needsAnswer: 0, agents: [] });
  for (const s of sessions) {
    const slot = bump(`${project.key}-${s.issue.issueNumber}`);
    if (s.status === 'needs-answer') slot.needsAnswer += 1;
    else if (s.status === 'blocked') slot.blocked += 1;
    else slot.running += 1;
    if (!slot.agents.includes(s.agent.displayName)) slot.agents.push(s.agent.displayName);
  }
  for (const q of questions) bump(`${project.key}-${q.issue.issueNumber}`).needsAnswer += 1;
  return { issues };
}

// ---------- 071 — fenced leases, handoffs, peer questions ----------

export const LEASE_TTL_DEFAULT_SEC = 900; // 15 min — heartbeats renew
export const OPEN_SESSION_STATUSES = ['running', 'blocked', 'needs-answer'] as const;

/** Read scope is wider than write scope: the agent, its delegator and admins
 *  as before, plus any peer holding an OPEN lease on the same issue (the
 *  reviewer watching the driver work). */
export async function assertSessionReader(actor: Actor, s: { agentUserId: string; delegatorId: string | null; issueId: string }) {
  if (actor.user.isAdmin) return;
  if (actor.user.id === s.agentUserId || actor.user.id === s.delegatorId) return;
  const peer = await prisma.agentSession.findFirst({
    where: { issueId: s.issueId, agentUserId: actor.user.id, status: { in: [...OPEN_SESSION_STATUSES] } },
    select: { id: true },
  });
  if (!peer) {
    throw new JiraApiError(403, jiraError(['Only the agent, the delegator, a same-issue lease peer, or an admin may read a session.']));
  }
}

/** Actor-scoped session view — the read endpoint's entry point. */
export async function getSessionView(actor: Actor, id: string) {
  const s = await getSession(id);
  await assertSessionReader(actor, s);
  return toSessionView(s);
}

/** The fencing check behind every agent-side issue write. Pass the token the
 *  lease granted; a re-lease (expiry/break/reclaim) bumped the issue's token,
 *  so a zombie session's write lands on a stale number → 409 FENCE_TOKEN_EXPIRED.
 *  Agents writing under a foreign driver's open lease are rejected even without
 *  an explicit token — the "not your turn" rule (reviewers still comment; they
 *  just can't field-update or transition). */
export async function assertFence(actor: Actor, issueId: string, fenceToken?: number | null) {
  if (fenceToken == null && actor.user.type !== 'agent') return;
  const [issue, holder] = await Promise.all([
    prisma.issue.findUnique({ where: { id: issueId }, select: { lastFenceToken: true } }),
    prisma.agentSession.findFirst({
      where: { issueId, role: 'driver', status: { in: [...OPEN_SESSION_STATUSES] } },
      select: { id: true, agentUserId: true, fenceToken: true },
    }),
  ]);
  if (!issue) throw new JiraApiError(404, jiraError(['Issue not found.']));
  if (fenceToken != null) {
    if (!holder || holder.fenceToken !== fenceToken || issue.lastFenceToken !== fenceToken) {
      throw new JiraApiError(
        409,
        jiraError(['Lease fencing token is stale — the lease expired, was broken, or was re-issued. Re-acquire before writing.'], {
          code: 'FENCE_TOKEN_EXPIRED',
        })
      );
    }
    if (holder.agentUserId !== actor.user.id && !actor.user.isAdmin) {
      throw new JiraApiError(409, jiraError(['Lease is held by another agent.'], { code: 'FENCE_TOKEN_EXPIRED' }));
    }
    return;
  }
  // No token supplied: an agent may not mutate an issue another agent drives.
  if (holder && holder.agentUserId !== actor.user.id && !actor.user.isAdmin) {
    throw new JiraApiError(
      409,
      jiraError(['Issue is driven by another agent — take a reviewer/observer role or wait for the lease to lapse.'], {
        code: 'FENCE_TOKEN_EXPIRED',
      })
    );
  }
}

/** 071 US3 — take (or renew) the driver lease on a specific issue. Serializes
 *  on the issue row: lastFenceToken++ + open-driver check in one tx means two
 *  concurrent claims can never both win — the loser sees the winner's session. */
export async function claimLease(
  actor: Actor,
  input: {
    issueKey: string;
    agent?: { accountId?: string; name?: string };
    ttlSec?: number;
    worktreeRef?: string;
    // 072 — git grounding + FIFO waitlist opt-in.
    baseSha?: string;
    branchName?: string;
    enqueueOnConflict?: boolean;
  }
) {
  const { parseIssueKey, toIssueKey, resolveDelegateRef } = await import('./issueService.js');
  const { projectKey, issueNumber } = await parseIssueKey(input.issueKey.toUpperCase());
  const issue = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    include: { project: true },
  });
  const allowList = actor.token?.projectKeys;
  if (!issue || (allowList?.length && !allowList.includes(issue.project.key))) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }
  if (!(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: issue.projectId }))) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }
  const agent = await resolveDelegateRef(
    input.agent ?? (actor.user.isAssignableAgent ? { accountId: actor.user.id } : null)
  );
  if (!agent) {
    throw new JiraApiError(400, jiraError([], { agent: 'Lease requires an assignable agent caller or agent:{accountId|name}.' }));
  }
  const { activeDriverLeases, maxConcurrentLeases, touchPresence } = await import('./agentProfileService.js');
  const [open, cap] = await Promise.all([activeDriverLeases(agent.id), maxConcurrentLeases(agent.id)]);
  if (open >= cap) {
    throw new JiraApiError(409, jiraError([], { agent: `Lease capacity reached (${open}/${cap} open driver sessions).` }));
  }
  const ttl = Math.min(3600, Math.max(60, input.ttlSec ?? LEASE_TTL_DEFAULT_SEC));
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + ttl * 1000);

  // 072 FR-009 — enqueue intent is captured inside the tx but the row must be
  // written AFTER the 409 rolls it back; the catch below re-enqueues against
  // the real client and patches the true queue position into the error.
  let waitlist: { projectId: string; targetKind: 'issue'; targetKey: string; userId: string } | null = null;
  const out = await prisma
    .$transaction(async (tx) => {
    // Row-lock the issue first (serializes concurrent lease attempts), then
    // expire + re-check under the lock.
    const locked = await tx.issue.update({
      where: { id: issue.id },
      data: { lastFenceToken: { increment: 1 } },
      select: { lastFenceToken: true, delegateId: true },
    });
    const existing = await tx.agentSession.findFirst({
      where: { issueId: issue.id, role: 'driver', status: { in: [...OPEN_SESSION_STATUSES] } },
      include: { agent: { select: { displayName: true } } },
    });
    if (existing) {
      const dead = existing.leaseExpiresAt !== null && existing.leaseExpiresAt < now;
      if (!dead) {
        if (input.enqueueOnConflict) {
          waitlist = { projectId: issue.projectId, targetKind: 'issue', targetKey: issue.id, userId: agent.id };
        }
        throw new JiraApiError(
          409,
          jiraError([], {
            issue: `Driver lease already held by ${existing.agent.displayName} until ${existing.leaseExpiresAt?.toISOString() ?? 'n/a'} — use role=reviewer/observer or break it as a human.`,
            heldBy: existing.agent.displayName,
            leaseExpiresAt: existing.leaseExpiresAt?.toISOString() ?? 'n/a',
            ...(waitlist
              ? { waitlistPosition: 'queued' }
              : { hint: 'Pass enqueueOnConflict:true to get a wake-up when the lease frees.' }),
          })
        );
      }
      // Zombie: lease lapsed without the sweeps noticing — expire it in place.
      await tx.agentSession.update({
        where: { id: existing.id },
        data: { status: 'expired', finishedAt: now },
      });
    }
    const session = await tx.agentSession.create({
      data: {
        issueId: issue.id,
        agentUserId: agent.id,
        delegatorId: actor.user.id === agent.id ? null : actor.user.id,
        trigger: 'lease',
        role: 'driver',
        fenceToken: locked.lastFenceToken,
        ttlSec: ttl,
        heartbeatAt: now,
        leaseExpiresAt,
        worktreeRef: input.worktreeRef ?? null,
        baseSha: input.baseSha ?? null,
        branchName: input.branchName ?? input.worktreeRef ?? null,
      },
    });
    // 072 — a fresh claim cancels the winner's own queue slot.
    const { clearWaiter } = await import('./contentionService.js');
    await clearWaiter(tx, { targetKind: 'issue', targetKey: issue.id, userId: agent.id });
    // 073 FR-004 — opening a new driver lease supersedes prior deliverable approvals.
    await tx.deliverableReview.updateMany({
      where: { issueId: issue.id, verdict: 'approved', supersededAt: null },
      data: { supersededAt: now },
    });
    const { recordLedger } = await import('./issueLedgerService.js');
    await recordLedger(tx, {
      issueId: issue.id,
      actorId: actor.user.id,
      kind: 'lease_claimed',
      summary: `${agent.displayName} took the driver lease (fence ${locked.lastFenceToken}, ttl ${ttl}s${input.branchName ? `, branch ${input.branchName}` : ''}).`,
      sessionId: session.id,
      payload: { fenceToken: locked.lastFenceToken, ttlSec: ttl, branchName: input.branchName ?? null, baseSha: input.baseSha ?? null },
    });
    await tx.issue.update({ where: { id: issue.id }, data: { delegateId: agent.id } });
    await recordChange(tx, issue.id, actor, [
      { field: 'delegate', from: locked.delegateId, fromString: null, to: agent.id, toString: agent.displayName },
    ]);
    await emitEvent(tx, actor, {
      type: 'agent_session.leased',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: { issueKey: toIssueKey(projectKey, issueNumber), sessionId: session.id, fenceToken: session.fenceToken },
    });
    return { session, fenceToken: locked.lastFenceToken };
    })
    .catch(async (e) => {
      // The 409 rolled back every write — including any waitlist row created
      // inside the tx. Persist the queue slot now and report the real position.
      if (waitlist) {
        const { enqueueWaiter } = await import('./contentionService.js');
        const w = await enqueueWaiter(prisma, waitlist);
        if (e instanceof JiraApiError) e.response.errors.waitlistPosition = String(w.position);
      }
      throw e;
    });
  await touchPresence(agent.id, now);
  // 072 FR-014 — normalized lease envelope; top-level aliases stay one sprint
  // for back-compat with the 071 clients that already parse them.
  return {
    sessionId: out.session.id,
    issueKey: toIssueKey(projectKey, issueNumber),
    lease: { fenceToken: out.fenceToken, expiresAt: leaseExpiresAt.toISOString(), role: 'driver' },
    fenceToken: out.fenceToken,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
  };
}

/** 071 US3 — heartbeat: renews the lease, stamps presence, and returns the
 *  fleet state the agent needs to know (pause flag, unread inbox) so the poll
 *  is also the kill-switch signal. Never throws 423 itself — heartbeats stay
 *  open while paused so a resumed fleet isn't dead on arrival. */
export async function heartbeatSession(actor: Actor, sessionId: string) {
  const s = await prisma.agentSession.findUnique({ where: { id: sessionId }, include: { issue: { include: { project: true } } } });
  if (!s) throw new JiraApiError(404, jiraError(['Agent session not found.']));
  if (!OPEN_SESSION_STATUSES.includes(s.status as (typeof OPEN_SESSION_STATUSES)[number])) {
    throw new JiraApiError(409, jiraError([], { session: `Session is ${s.status}.` }));
  }
  if (actor.user.id !== s.agentUserId && !actor.user.isAdmin) {
    throw new JiraApiError(403, jiraError(['Only the leasing agent (or an admin) may heartbeat a session.']));
  }
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + s.ttlSec * 1000);
  await prisma.$transaction(async (tx) => {
    await tx.agentSession.update({
      where: { id: s.id },
      data: { heartbeatAt: now, lastActivityAt: now, leaseExpiresAt },
    });
    await tx.agentActivity.create({
      data: { sessionId: s.id, type: 'thought', text: 'heartbeat', byName: 'system', createdAt: now },
    });
  });
  const { touchPresence } = await import('./agentProfileService.js');
  const { unreadInboxCount } = await import('./agentInboxService.js');
  const { pauseStatus } = await import('./fleetPause.js');
  await touchPresence(s.agentUserId, now);
  const [paused, unreadInbox] = await Promise.all([pauseStatus(s.issue.projectId), unreadInboxCount(s.agentUserId)]);
  return {
    sessionId: s.id,
    fenceToken: s.fenceToken,
    leaseExpiresAt: leaseExpiresAt.toISOString(),
    paused: paused.paused,
    unreadInbox,
  };
}

/** 071 US3 + 073 FR-002 — release: the driver gives the lease back early,
 *  reconciles git/receipt drift, and publishes a consolidated Work Product
 *  Dossier comment into Jira's native comment stream. */
export async function releaseSession(
  actor: Actor,
  sessionId: string,
  input: {
    outcome: 'completed' | 'ready_for_review' | 'handed_off' | 'failed';
    summary: string;
    nextAssignee?: string;
    suggestedNextIssueKey?: string;
    remainingSteps?: string[];
    doNotRepeat?: string[];
    // 072 — git grounding: what the branch tip is when the driver lets go.
    headSha?: string;
    receiptIds?: string[];
    // 073 — escape hatch for internal sweeps/tests if comment suppression is explicitly requested.
    suppressComment?: boolean;
  }
) {
  const s = await prisma.agentSession.findUnique({
    where: { id: sessionId },
    include: { issue: { include: { project: true } }, agent: { select: { displayName: true, ownerId: true } } },
  });
  if (!s) throw new JiraApiError(404, jiraError(['Agent session not found.']));
  assertSessionActor(actor, s);
  if (!OPEN_SESSION_STATUSES.includes(s.status as (typeof OPEN_SESSION_STATUSES)[number])) {
    throw new JiraApiError(409, jiraError([], { session: `Session is ${s.status}.` }));
  }
  const status =
    input.outcome === 'completed' || input.outcome === 'ready_for_review'
      ? 'done'
      : input.outcome === 'failed'
        ? 'failed'
        : 'released';
  const now = new Date();
  const handoff = {
    outcome: input.outcome,
    summary: input.summary.slice(0, 4000),
    nextAssignee: input.nextAssignee ?? null,
    suggestedNextIssueKey: input.suggestedNextIssueKey ?? null,
    remainingSteps: (input.remainingSteps ?? []).slice(0, 20),
    doNotRepeat: (input.doNotRepeat ?? []).slice(0, 20),
  };
  // Pre-bind any explicitly listed receipts owned by this session's agent so
  // computeDrift and the dossier comment both see the full evidence set.
  let linkedReceipts: string[] = [];
  if (input.receiptIds?.length) {
    const upd = await prisma.workReceipt.updateMany({
      where: { id: { in: input.receiptIds }, authorId: s.agentUserId },
      data: { sessionId: s.id, issueId: s.issueId, projectId: s.issue.projectId },
    });
    linkedReceipts = upd.count ? input.receiptIds : [];
  }
  const drift = await computeDrift(s.id, input.outcome, input.headSha);
  const [sessionReceipts, originatingLink] = await Promise.all([
    prisma.workReceipt.findMany({
      where: { sessionId: s.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        sha256: true,
        verification: true,
        summary: true,
        changedFiles: true,
        metricsJson: true,
        attachmentId: true,
        payload: { select: { byteLength: true } },
      },
    }),
    prisma.townHallTopicIssue.findFirst({
      where: { issueId: s.issueId },
      orderBy: { topic: { createdAt: 'desc' } },
      include: { topic: { select: { id: true, title: true } } },
    }),
  ]);

  let dossierCommentId: string | null = null;
  await prisma.$transaction(async (tx) => {
    if (!input.suppressComment) {
      const { buildDossierComment, insertStructuredCommentInTx } = await import('./deliverableService.js');
      const dossier = buildDossierComment({
        agentName: s.agent.displayName,
        role: s.role,
        sessionId: s.id,
        outcome: input.outcome,
        summary: handoff.summary,
        branchName: s.branchName,
        baseSha: s.baseSha,
        headSha: input.headSha ?? s.headSha,
        driftStatus: drift.driftStatus,
        remainingSteps: handoff.remainingSteps,
        doNotRepeat: handoff.doNotRepeat,
        receipts: sessionReceipts.map((r) => ({
          id: r.id,
          kind: r.kind,
          sha256: r.sha256,
          verification: r.verification === 'unverified' ? 'digest_only' : r.verification,
          summary: r.summary,
          changedFiles: r.changedFiles,
          metricsJson: r.metricsJson,
          hasInlineContent: Boolean(r.payload),
          attachmentId: r.attachmentId,
        })),
        originatingTopic: originatingLink
          ? { id: originatingLink.topic.id, title: originatingLink.topic.title, relation: originatingLink.relation }
          : null,
      });
      dossierCommentId = await insertStructuredCommentInTx(
        tx,
        actor,
        s.issue,
        dossier.body,
        dossier.metadata,
        s.agentUserId
      );
    }

    await tx.agentSession.update({
      where: { id: s.id },
      data: {
        status,
        finishedAt: now,
        lastActivityAt: now,
        handoff,
        headSha: input.headSha ?? s.headSha,
        driftStatus: drift.driftStatus,
        driftReport: drift.driftReport as never,
        dossierCommentId,
      },
    });
    // Re-pool: only clear the delegate when this session's agent held it —
    // a reviewer closing their session must not un-drive the driver's issue.
    if (s.role === 'driver' && s.agentUserId === s.issue.delegateId) {
      await tx.issue.update({ where: { id: s.issueId }, data: { delegateId: null } });
      await recordChange(tx, s.issueId, actor, [
        { field: 'delegate', from: s.agentUserId, fromString: s.agent.displayName, to: null, toString: null },
      ]);
    }
    // 072 — handed-off work in an unmerged worktree keeps its traces as
    // `pendingMerge` so parallel agents still sense in-flight edits; all
    // other outcomes drop the traces as before.
    if (
      s.role === 'driver' &&
      (input.outcome === 'handed_off' || input.outcome === 'ready_for_review') &&
      (s.worktreeRef || s.branchName)
    ) {
      await tx.stigmergicTrace.updateMany({
        where: { sessionId: s.id },
        data: { pendingMerge: true, expiresAt: new Date(now.getTime() + 6 * 3600_000) },
      });
    } else {
      await tx.stigmergicTrace.deleteMany({ where: { sessionId: s.id } });
    }
    // 072 — free path locks + wake the FIFO queues (issue waiters, path
    // waiters, the named nextAssignee, and the delegator) in one event.
    const { takeWaiterWakeups } = await import('./contentionService.js');
    const { releaseSessionLocks } = await import('./resourceLockService.js');
    const { recordLedger } = await import('./issueLedgerService.js');
    const inbox: { userId: string; reason: string; actionHint: string }[] = [];
    if (s.role === 'driver') {
      inbox.push(
        ...(await takeWaiterWakeups(tx, {
          targetKind: 'issue',
          targetKey: s.issueId,
          reason: 'lease_available',
          actionHint: `Driver lease on ${keyOf(s.issue)} freed (${input.outcome}) — claim it now.`,
        })),
        ...(await releaseSessionLocks(tx, s.id))
      );
      if (handoff.nextAssignee) {
        const { resolveDelegateRef } = await import('./issueService.js');
        const next = await resolveDelegateRef({ name: handoff.nextAssignee }).catch(() => null);
        if (next && next.id !== s.agentUserId) {
          inbox.push({
            userId: next.id,
            reason: input.outcome === 'ready_for_review' ? 'review_requested' : 'handoff_ready',
            actionHint: `${s.agent.displayName} ${input.outcome === 'ready_for_review' ? 'requested review on' : 'handed off'} ${keyOf(s.issue)}: ${handoff.summary.slice(0, 140)}`,
          });
        }
      }
    }
    if (s.delegatorId) {
      inbox.push({
        userId: s.delegatorId,
        reason: 'directive',
        actionHint: `${s.agentUserId === actor.user.id ? 'Driver' : 'Delegator'} released ${keyOf(s.issue)}: ${input.outcome} — ${handoff.summary.slice(0, 120)}`,
      });
    }
    const kind =
      input.outcome === 'ready_for_review'
        ? 'lease_ready_for_review'
        : input.outcome === 'completed'
          ? 'lease_completed'
          : input.outcome === 'failed'
            ? 'lease_failed'
            : 'lease_handed_off';
    await recordLedger(tx, {
      issueId: s.issueId,
      actorId: actor.user.id,
      kind,
      summary: handoff.summary.slice(0, 300),
      sessionId: s.id,
      payload: {
        ...handoff,
        driftStatus: drift.driftStatus,
        headSha: input.headSha ?? s.headSha,
        receiptIds: linkedReceipts.length ? linkedReceipts : sessionReceipts.map((r) => r.id),
        dossierCommentId,
      },
    });
    if (drift.driftStatus === 'phantom_handoff' || drift.driftStatus === 'undeclared_edits') {
      await tx.deliverableReview.updateMany({
        where: { issueId: s.issueId, verdict: 'approved', supersededAt: null },
        data: { supersededAt: now },
      });
      await recordLedger(tx, {
        issueId: s.issueId,
        actorId: null,
        kind: 'drift_flagged',
        summary:
          drift.driftStatus === 'phantom_handoff'
            ? `Release claimed '${input.outcome}' with no corroborating commits or verified diff receipts — phantom handoff.`
            : `Release touched ${((drift.driftReport as { undeclared?: string[] }).undeclared ?? []).length} file(s) outside declared traces.`,
        sessionId: s.id,
        payload: drift.driftReport as never,
      });
    }
    await emitEvent(tx, actor, {
      type: 'agent_session.released',
      projectId: s.issue.projectId,
      issueId: s.issueId,
      payload: {
        sessionId: s.id,
        issueKey: keyOf(s.issue),
        outcome: input.outcome,
        summary: handoff.summary.slice(0, 300),
        delegatorId: s.delegatorId,
        agentOwnerId: s.agent.ownerId,
        projectLeadId: s.issue.project.leadId,
        driftStatus: drift.driftStatus,
        dossierCommentId,
        issue: issueSnapshot(s.issue),
        inbox,
      },
    });
  });
  return {
    sessionId: s.id,
    status,
    driftStatus: drift.driftStatus,
    driftReport: drift.driftReport,
    dossierCommentId,
  };
}

/** 072 FR-007 + 073 — reconcile declared traces vs observed output. Observed files
 *  come from this session's receipts (`changedFiles` + `metricsJson.filesChanged`)
 *  and, when a headSha is given, any ingested DevelopmentItem commit matching it. */
async function computeDrift(
  sessionId: string,
  outcome: string,
  headSha?: string
): Promise<{ driftStatus: string; driftReport: { declared: string[]; observed: string[]; undeclared: string[] } }> {
  const declared = (
    await prisma.stigmergicTrace.findMany({
      where: { sessionId, kind: { in: ['file_edit', 'symbol_edit'] } },
      select: { target: true },
    })
  ).map((t) => t.target);
  const observed = new Set<string>();
  let commitOrVerifiedDiffSeen = false;
  const receipts = await prisma.workReceipt.findMany({
    where: { sessionId },
    select: { kind: true, changedFiles: true, verification: true, metricsJson: true, gitCommitSha: true },
  });
  for (const r of receipts) {
    for (const f of r.changedFiles ?? []) if (typeof f === 'string') observed.add(f);
    const fc = (r.metricsJson as { filesChanged?: unknown } | null)?.filesChanged;
    if (Array.isArray(fc)) for (const f of fc) if (typeof f === 'string') observed.add(f);
    if (r.gitCommitSha) commitOrVerifiedDiffSeen = true;
    if (r.kind === 'diff' && r.verification !== 'digest_only' && r.verification !== 'unverified') {
      commitOrVerifiedDiffSeen = true;
    }
  }
  if (headSha) {
    const items = await prisma.developmentItem.findMany({
      where: { type: 'commit', externalId: { contains: headSha.slice(0, 40) } },
      select: { payload: true },
    });
    for (const it of items) {
      commitOrVerifiedDiffSeen = true;
      const f = (it.payload as { files?: unknown; diff?: { files?: unknown } } | null)?.files ??
        (it.payload as { diff?: { files?: unknown } } | null)?.diff?.files;
      if (Array.isArray(f)) for (const x of f) if (typeof x === 'string') observed.add(x);
    }
  }
  const observedList = [...observed];
  const undeclared = observedList.filter(
    (f) => !declared.some((d) => f === d || f.startsWith(d.endsWith('/') ? d : `${d}/`))
  );
  let driftStatus = 'untracked';
  if (observedList.length) driftStatus = undeclared.length ? 'undeclared_edits' : 'clean';
  else if (
    (outcome === 'completed' || outcome === 'ready_for_review' || outcome === 'handed_off') &&
    !commitOrVerifiedDiffSeen
  ) {
    driftStatus = 'phantom_handoff';
  }
  return { driftStatus, driftReport: { declared, observed: observedList, undeclared } };
}

/** 071 US5 — human break: kill a stale/misbehaving driver's lease. The fence
 *  bump alone would do it; the status makes it legible. */
export async function breakLease(actor: Actor, issueKey: string) {
  const { parseIssueKey, toIssueKey } = await import('./issueService.js');
  const { projectKey, issueNumber } = await parseIssueKey(issueKey.toUpperCase());
  const issue = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    include: { project: true },
  });
  if (!issue) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  const canBreak =
    actor.user.isAdmin ||
    actor.user.id === issue.reporterId ||
    issue.project.leadId === actor.user.id ||
    (await hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId: issue.projectId }));
  if (!canBreak) {
    throw new JiraApiError(403, jiraError(['Only an admin, the reporter, or the project lead may break a lease.']));
  }
  const driver = await prisma.agentSession.findFirst({
    where: { issueId: issue.id, role: 'driver', status: { in: [...OPEN_SESSION_STATUSES] } },
    include: { agent: { select: { displayName: true } } },
  });
  if (!driver) throw new JiraApiError(404, jiraError(['No open driver lease on this issue.']));
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.issue.update({ where: { id: issue.id }, data: { lastFenceToken: { increment: 1 }, delegateId: null } });
    await tx.agentSession.update({
      where: { id: driver.id },
      data: { status: 'broken', finishedAt: now, handoff: { reason: `broken by ${actor.user.displayName}` } },
    });
    await tx.stigmergicTrace.deleteMany({ where: { sessionId: driver.id } });
    await recordChange(tx, issue.id, actor, [
      { field: 'delegate', from: driver.agentUserId, fromString: driver.agent.displayName, to: null, toString: null },
    ]);
    // 072 — free locks, wake waiters, ledger the kill.
    const { takeWaiterWakeups } = await import('./contentionService.js');
    const { releaseSessionLocks } = await import('./resourceLockService.js');
    const { recordLedger } = await import('./issueLedgerService.js');
    const inbox = [
      {
        userId: driver.agentUserId,
        reason: 'directive',
        actionHint: `Your lease on ${toIssueKey(projectKey, issueNumber)} was broken by ${actor.user.displayName} — stop work; writes will now 409.`,
      },
      ...(await takeWaiterWakeups(tx, {
        targetKind: 'issue',
        targetKey: issue.id,
        reason: 'lease_available',
        actionHint: `Driver lease on ${toIssueKey(projectKey, issueNumber)} was force-released — claim it now.`,
      })),
      ...(await releaseSessionLocks(tx, driver.id)),
    ];
    await recordLedger(tx, {
      issueId: issue.id,
      actorId: actor.user.id,
      kind: 'lease_broken',
      summary: `Driver lease of ${driver.agent.displayName} broken by ${actor.user.displayName}.`,
      sessionId: driver.id,
      payload: { brokenBy: actor.user.displayName },
    });
    await emitEvent(tx, actor, {
      type: 'agent_session.broken',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        sessionId: driver.id,
        issueKey: toIssueKey(projectKey, issueNumber),
        brokenBy: actor.user.displayName,
        inbox,
      },
    });
  });
  return { broken: true, sessionId: driver.id };
}

/** Fleet-wide session board for the mission-control UI / agent_roster tool. */
export async function listFleetSessions(
  actor: Actor,
  opts: { projectKey?: string; issueKey?: string; status?: string; role?: string; agentAccountId?: string; activeOnly?: boolean }
) {
  const scopeKeys = actor.token?.projectKeys;
  if (opts.projectKey && scopeKeys?.length && !scopeKeys.includes(opts.projectKey.toUpperCase())) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  // 072 FR-010 — history is the default: a bare ?issue=/?agent= call must show
  // who drove the issue (incl. released/done sessions); activeOnly=true keeps
  // the mission-control live view.
  const statusFilter = opts.status ? { status: opts.status } : opts.activeOnly ? { status: { in: [...OPEN_SESSION_STATUSES] } } : {};
  const rows = await prisma.agentSession.findMany({
    where: {
      ...statusFilter,
      ...(opts.role ? { role: opts.role } : {}),
      ...(opts.agentAccountId ? { agentUserId: opts.agentAccountId } : {}),
      issue: {
        ...(opts.projectKey ? { project: { key: opts.projectKey.toUpperCase() } } : {}),
        ...(opts.issueKey
          ? (() => {
              const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(opts.issueKey!.toUpperCase());
              return m ? { project: { key: m[1] }, issueNumber: Number(m[2]) } : {};
            })()
          : {}),
        ...(scopeKeys?.length ? { project: { key: { in: scopeKeys } } } : {}),
      },
    },
    include: {
      agent: { select: { id: true, displayName: true } },
      issue: { select: { issueNumber: true, summary: true, project: { select: { key: true } }, status: { select: { name: true } } } },
      delegator: { select: { displayName: true } },
      _count: { select: { traces: true } },
    },
    orderBy: { startedAt: 'desc' },
    take: 200,
  });
  return {
    sessions: rows.map((s) => ({
      sessionId: s.id,
      issueKey: keyOf(s.issue),
      issueSummary: s.issue.summary,
      issueStatus: s.issue.status.name,
      agent: { accountId: s.agent.id, displayName: s.agent.displayName },
      delegator: s.delegator?.displayName ?? null,
      role: s.role,
      status: s.status,
      trigger: s.trigger,
      fenceToken: s.fenceToken,
      leaseExpiresAt: s.leaseExpiresAt?.toISOString() ?? null,
      heartbeatAt: s.heartbeatAt?.toISOString() ?? null,
      worktreeRef: s.worktreeRef,
      branchName: s.branchName,
      driftStatus: s.driftStatus,
      traceCount: s._count.traces,
      startedAt: s.startedAt.toISOString(),
      lastActivityAt: s.lastActivityAt.toISOString(),
    })),
  };
}

/** 071 US2 — peer consultation: an agent questions a specific agent (or the
 *  best `[@role:x]` holder) WITHOUT blocking its own session — it keeps
 *  working while the consult lands in the peer's durable inbox. */
export async function askPeerQuestion(
  actor: Actor,
  input: { sessionId: string; issueKey: string; question: string; targetUserId?: string; targetRole?: string; expiresInSec?: number }
) {
  const s = await getSession(input.sessionId);
  assertSessionActor(actor, s);
  if (!OPEN_SESSION_STATUSES.includes(s.status as (typeof OPEN_SESSION_STATUSES)[number])) {
    throw new JiraApiError(409, jiraError([], { session: `Session is ${s.status} — cannot ask.` }));
  }
  let target: { id: string; displayName: string } | null = null;
  if (input.targetUserId) {
    const u = await prisma.user.findUnique({ where: { id: input.targetUserId } });
    if (!u || !u.active) throw new JiraApiError(404, jiraError(['Target user not found.']));
    target = { id: u.id, displayName: u.displayName };
  } else if (input.targetRole) {
    const { summonCandidates } = await import('./agentProfileService.js');
    const c = await summonCandidates(s.issue.projectId, input.targetRole, 1);
    if (!c.length) throw new JiraApiError(404, jiraError([], { targetRole: `No fleet agent holds role '${input.targetRole}'.` }));
    target = { id: c[0]!.userId, displayName: c[0]!.displayName };
  }
  const expiresAt = new Date(Date.now() + (input.expiresInSec ?? 86_400) * 1000);
  const q = await prisma.$transaction(async (tx) => {
    const created = await tx.agentQuestion.create({
      data: {
        sessionId: s.id,
        issueId: s.issueId,
        question: input.question.slice(0, 4000),
        targetUserId: target?.id ?? null,
        targetRole: input.targetRole ?? null,
        expiresAt,
      },
    });
    await tx.agentSession.update({ where: { id: s.id }, data: { lastActivityAt: new Date() } });
    await emitEvent(tx, actor, {
      type: 'agent_question.peer_asked',
      projectId: s.issue.projectId,
      issueId: s.issueId,
      payload: {
        questionId: created.id,
        sessionId: s.id,
        issueKey: input.issueKey,
        question: input.question.slice(0, 300),
        issue: issueSnapshot(s.issue),
        inbox: target
          ? [
              {
                userId: target.id,
                reason: 'peer_question',
                actionHint: `${actor.user.displayName} asks: ${input.question.slice(0, 140)}`,
              },
            ]
          : [],
      },
    });
    return created;
  });
  return { questionId: q.id, target: target?.displayName ?? 'delegator' };
}

/** 071 US3 — lease reaper: sessions whose lease lapsed close `expired`,
 *  delegateId clears (issue re-pools into ready()), and the delegator gets an
 *  inbox wake-up. Runs alongside sweepStaleSessions. */
export async function sweepExpiredLeases() {
  const now = new Date();
  const expired = await prisma.agentSession.findMany({
    where: {
      status: { in: [...OPEN_SESSION_STATUSES] },
      role: 'driver',
      leaseExpiresAt: { lt: now },
    },
    include: sessionMetaInclude,
    take: 200,
  });
  let actions = 0;
  for (const s of expired) {
    await prisma.$transaction(async (tx) => {
      // Re-check under lock — a heartbeat may have landed between select and tx.
      const fresh = await tx.agentSession.findUnique({ where: { id: s.id }, select: { status: true, leaseExpiresAt: true } });
      if (!fresh || !OPEN_SESSION_STATUSES.includes(fresh.status as (typeof OPEN_SESSION_STATUSES)[number])) return;
      if (!fresh.leaseExpiresAt || fresh.leaseExpiresAt >= now) return;
      await tx.agentSession.update({
        where: { id: s.id },
        data: { status: 'expired', finishedAt: now, handoff: { reason: 'lease-expired' } },
      });
      await tx.issue.update({
        where: { id: s.issueId },
        data: { lastFenceToken: { increment: 1 }, delegateId: null },
      });
      // 072 — an expired driver with a worktree may hold unmerged work; keep
      // its traces visible (pendingMerge) instead of deleting them blind.
      if (s.worktreeRef || s.branchName) {
        await tx.stigmergicTrace.updateMany({
          where: { sessionId: s.id },
          data: { pendingMerge: true, expiresAt: new Date(now.getTime() + 6 * 3600_000) },
        });
      } else {
        await tx.stigmergicTrace.deleteMany({ where: { sessionId: s.id } });
      }
      // 072 — free locks, wake waiters, ledger the expiry.
      const { takeWaiterWakeups } = await import('./contentionService.js');
      const { releaseSessionLocks } = await import('./resourceLockService.js');
      const { recordLedger } = await import('./issueLedgerService.js');
      const inbox = [
        ...(s.delegatorId
          ? [{ userId: s.delegatorId, reason: 'directive', actionHint: `Lease on ${keyOf(s.issue)} expired — issue returned to the ready pool.` }]
          : []),
        ...(await takeWaiterWakeups(tx, {
          targetKind: 'issue',
          targetKey: s.issueId,
          reason: 'lease_available',
          actionHint: `Driver lease on ${keyOf(s.issue)} expired — claim it now.`,
        })),
        ...(await releaseSessionLocks(tx, s.id)),
      ];
      await recordLedger(tx, {
        issueId: s.issueId,
        actorId: null,
        kind: 'lease_expired',
        summary: `Driver lease of ${s.agentUserId} expired without heartbeat — issue re-pooled.`,
        sessionId: s.id,
      });
      await emitEvent(tx, null, {
        type: 'agent_session.expired',
        projectId: s.issue.projectId,
        issueId: s.issueId,
        payload: {
          sessionId: s.id,
          issueKey: keyOf(s.issue),
          reason: 'lease-expired',
          delegatorId: s.delegatorId,
          issue: issueSnapshot(s.issue),
          inbox,
        },
      });
    });
    actions += 1;
  }
  return actions;
}

// 047 US2/US3 — agent sessions + question interrupts. Sessions are the
// inspectable work-in-progress of a delegated task; questions are the
// "question" interrupt mode (notify/question/review — review = proposals).
// Every activity/question is attributable (FR-002) and lands on the 011 bus.
import { prisma } from '../prisma.js';
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
    // Answering unblocks the session — the agent resumes on the event.
    await tx.agentSession.update({
      where: { id: q.sessionId },
      data: { status: 'running', lastActivityAt: new Date() },
    });
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
  const candidateIds = candidates.map((c) => c.id);

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
          ORDER BY "Issue".rank ASC, "Issue"."issueNumber" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`
      : [];
    const row = rows[0];
    if (!row) return null;
    await tx.issue.update({ where: { id: row.id }, data: { delegateId: agent.id } });
    const session = await tx.agentSession.create({
      data: {
        issueId: row.id,
        agentUserId: agent.id,
        // A self-claim has no human delegator; a claim on behalf records who pulled.
        delegatorId: actor.user.id === agent.id ? null : actor.user.id,
        trigger: 'claim',
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
    return { issueId: row.id, issueKey: toIssueKey(project.key, row.issueNumber), sessionId: session.id };
  });

  if (!claimed) {
    throw new JiraApiError(409, jiraError(['No ready issues to claim.']));
  }
  const issue = await prisma.issue.findUnique({ where: { id: claimed.issueId } });
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

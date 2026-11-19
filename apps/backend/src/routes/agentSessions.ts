import { ps } from '../lib/validation.js';
// 047 — agent session + question routes. Internal product API; agents drive
// the same surface via PAT (write scope) — delegation grants no powers (FR-001).
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import type { Actor } from '../lib/auth.js';
import { ah, parseBody } from '../lib/http.js';
import { enforceIssueScope } from '../middleware/auth.js';
import {
  listIssueSessions,
  getSession,
  getSessionView,
  emitActivity,
  assertSessionActor,
  askQuestion,
  askPeerQuestion,
  answerQuestion,
  getQuestion,
  listIssueQuestions,
  claimReadyWork,
  claimLease,
  heartbeatSession,
  releaseSession,
  breakLease,
  projectAgentActivity,
  listFleetSessions,
} from '../services/agentSessionService.js';
import { depositTraces } from '../services/traceService.js';
import { acquireLocks, releaseLocks } from '../services/resourceLockService.js';
import { prisma } from '../prisma.js';
import { qs } from '../lib/validation.js';

export const agentRouter: RouterType = Router();

const actorOf = (req: { actor?: Actor }): Actor => req.actor as Actor;

// GET /api/internal/issues/{key}/sessions — inspectable history (US2-3, A2)
agentRouter.get(
  '/issues/:key/sessions',
  ah(async (req, res) => {
    await enforceIssueScope(ps(req.params.key), req.actor!);
    res.json({ sessions: await listIssueSessions(ps(req.params.key)) });
  })
);

// GET /api/internal/projects/{key}/agent-activity — 058 US5: one-shot map of
// live agent work for every card on a board/backlog (badges), so pages don't
// fan out one /sessions request per issue.
agentRouter.get(
  '/projects/:key/agent-activity',
  ah(async (req, res) => {
    res.json(await projectAgentActivity(actorOf(req), ps(req.params.key)));
  })
);

// GET /api/internal/agent-sessions — 071 fleet session board: live leases +
// peers across the visible fleet. Filters: project, issue, status, role, agent.
agentRouter.get(
  '/agent-sessions',
  ah(async (req, res) => {
    res.json(
      await listFleetSessions(actorOf(req), {
        projectKey: qs(req.query.project) ? String(qs(req.query.project)).toUpperCase() : undefined,
        issueKey: qs(req.query.issue) ? String(qs(req.query.issue)).toUpperCase() : undefined,
        status: qs(req.query.status) ? String(qs(req.query.status)) : undefined,
        role: qs(req.query.role) ? String(qs(req.query.role)) : undefined,
        agentAccountId: qs(req.query.agent) ? String(qs(req.query.agent)) : undefined,
        // 072 FR-010 — terminal sessions are visible by default; activeOnly=1
        // restores the live-only mission-control view.
        activeOnly: ['1', 'true', 'yes'].includes(String(qs(req.query.activeOnly) ?? '').toLowerCase()),
      })
    );
  })
);

agentRouter.get(
  '/agent-sessions/:id',
  ah(async (req, res) => {
    // 064 US3 — IDOR: session detail is restricted to agent/delegator/admin;
    // 071 widens reads to same-issue lease peers (reviewers watching drivers).
    res.json(await getSessionView(actorOf(req), ps(req.params.id)));
  })
);

// US2-1 — the agent reports thought/action/error; `status` closes the run.
agentRouter.post(
  '/agent-sessions/:id/activities',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        type: z.enum(['thought', 'action', 'error']),
        text: z.string().min(1).max(4000),
        status: z.enum(['running', 'blocked', 'done', 'failed']).optional(),
      }),
      req
    );
    res.status(201).json(await emitActivity(actorOf(req), ps(req.params.id), body));
  })
);

// US3-1 — ask the human; session pauses needs-answer, delegator notified.
agentRouter.post(
  '/agent-questions',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        issueKey: z.string(),
        sessionId: z.string(),
        question: z.string().min(1).max(4000),
        options: z.array(z.string().max(500)).max(10).optional(),
        expiresInSec: z.number().int().min(60).max(604_800).optional(),
      }),
      req
    );
    res.status(201).json(await askQuestion(actorOf(req), body));
  })
);

// GET /api/internal/issues/{key}/agent-questions — question inbox for the
// issue page; ?status=open|answered|expired (default: all).
agentRouter.get(
  '/issues/:key/agent-questions',
  ah(async (req, res) => {
    await enforceIssueScope(ps(req.params.key), req.actor!);
    const status = qs(req.query.status) ? String(qs(req.query.status)) : undefined;
    const questions = await listIssueQuestions(ps(req.params.key), status);
    res.json({
      questions: questions.map((q) => ({
        id: q.id,
        sessionId: q.sessionId,
        question: q.question,
        options: q.options,
        status: q.status,
        answer: q.answer,
        answeredBy: q.answeredBy?.displayName ?? null,
        answeredAt: q.answeredAt?.toISOString() ?? null,
        expiresAt: q.expiresAt?.toISOString() ?? null,
        createdAt: q.createdAt.toISOString(),
      })),
    });
  })
);

// GET /api/internal/agent-questions/mine — questions targeted at me (the
// peer-consult inbox; complements the notification bell). Registered BEFORE
// /agent-questions/:id so 'mine' isn't captured as an id.
agentRouter.get(
  '/agent-questions/mine',
  ah(async (req, res) => {
    const rows = await prisma.agentQuestion.findMany({
      where: { targetUserId: actorOf(req).user.id, status: 'open' },
      include: {
        session: { select: { id: true, agent: { select: { id: true, displayName: true } } } },
        issue: { select: { issueNumber: true, summary: true, project: { select: { key: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    res.json({
      questions: rows.map((q) => ({
        id: q.id,
        sessionId: q.sessionId,
        issueKey: `${q.issue.project.key}-${q.issue.issueNumber}`,
        issueSummary: q.issue.summary,
        // 072 FR-014 — status + structured asker; askedBy stays as a
        // display-name alias for 071 clients.
        status: q.status,
        asker: { accountId: q.session.agent.id, displayName: q.session.agent.displayName },
        askedBy: q.session.agent.displayName,
        question: q.question,
        targetRole: q.targetRole,
        expiresAt: q.expiresAt?.toISOString() ?? null,
        createdAt: q.createdAt.toISOString(),
      })),
    });
  })
);

agentRouter.get(
  '/agent-questions/:id',
  ah(async (req, res) => {
    const q = await getQuestion(ps(req.params.id));
    res.json({
      id: q.id,
      sessionId: q.sessionId,
      question: q.question,
      options: q.options,
      status: q.status,
      answer: q.answer,
      answeredBy: q.answeredBy?.displayName ?? null,
      answeredAt: q.answeredAt?.toISOString() ?? null,
      expiresAt: q.expiresAt?.toISOString() ?? null,
    });
  })
);

// US3-2 — anyone with comment rights may answer; recorded as the author.
agentRouter.post(
  '/agent-questions/:id/answer',
  ah(async (req, res) => {
    const { answer } = parseBody(z.object({ answer: z.string().min(1).max(4000) }), req);
    const q = await answerQuestion(actorOf(req), ps(req.params.id), answer);
    res.json({ id: q.id, status: q.status, answer: q.answer });
  })
);

// 063 US4 — atomic ready-work claim: pick the top-ranked unblocked, unclaimed
// issue, delegate it, and open a `trigger='claim'` session in one transaction.
agentRouter.post(
  '/agent/claim',
  ah(async (req, res) => {
    const parsed = parseBody(
      z.object({
        projectKey: z.string().min(1).max(50),
        jql: z.string().max(4000).optional(),
        agent: z.object({ accountId: z.string().optional(), name: z.string().optional() }).optional(),
      }),
      req
    );
    res.status(201).json(await claimReadyWork(actorOf(req), parsed));
  })
);

// ---------- 071 — fenced leases ----------

// POST /api/internal/issues/{key}/lease — take the driver lease on a specific
// issue (or 409 when another agent's lease is live). Returns the fence token
// every subsequent write must carry.
agentRouter.post(
  '/issues/:key/lease',
  ah(async (req, res) => {
    const parsed = parseBody(
      z.object({
        agent: z.object({ accountId: z.string().optional(), name: z.string().optional() }).optional(),
        ttlSec: z.number().int().min(60).max(3600).optional(),
        worktreeRef: z.string().max(200).optional(),
        baseSha: z.string().max(80).optional(),
        branchName: z.string().max(200).optional(),
        enqueueOnConflict: z.boolean().optional(),
      }),
      req
    );
    res.status(201).json(await claimLease(actorOf(req), { issueKey: ps(req.params.key), ...parsed }));
  })
);

// POST /api/internal/issues/{key}/lease/break — human kill-switch for a stale
// or misbehaving driver. Admin/reporter/project-lead/ADMINISTER_PROJECTS.
agentRouter.post(
  '/issues/:key/lease/break',
  ah(async (req, res) => {
    res.json(await breakLease(actorOf(req), ps(req.params.key)));
  })
);

// POST /api/internal/agent-sessions/{id}/heartbeat — renew the lease; returns
// fenceToken, new expiry, fleet pause flag and unread inbox count (the poll
// doubles as the kill-switch signal).
agentRouter.post(
  '/agent-sessions/:id/heartbeat',
  ah(async (req, res) => {
    res.json(await heartbeatSession(actorOf(req), ps(req.params.id)));
  })
);

// POST /api/internal/agent-sessions/{id}/release — end the lease early with a
// structured handoff the next claimant reads from the context pack.
agentRouter.post(
  '/agent-sessions/:id/release',
  ah(async (req, res) => {
    const parsed = parseBody(
      z.object({
        outcome: z.enum(['completed', 'ready_for_review', 'handed_off', 'failed']),
        summary: z.string().min(1).max(4000),
        nextAssignee: z.string().max(200).optional(),
        suggestedNextIssueKey: z.string().max(50).optional(),
        remainingSteps: z.array(z.string().max(500)).max(20).optional(),
        doNotRepeat: z.array(z.string().max(500)).max(20).optional(),
        headSha: z.string().max(80).optional(),
        receiptIds: z.array(z.string().max(80)).max(50).optional(),
        suppressComment: z.boolean().optional(),
      }),
      req
    );
    res.json(await releaseSession(actorOf(req), ps(req.params.id), parsed));
  })
);

// POST /api/internal/agent-sessions/{id}/traces — declare file/symbol intents;
// returns cross-issue collisions with other live drivers.
agentRouter.post(
  '/agent-sessions/:id/traces',
  ah(async (req, res) => {
    const parsed = parseBody(
      z.object({
        traces: z
          .array(
            z.object({
              kind: z.enum(['file_read', 'file_edit', 'symbol_edit', 'resource_lock']),
              target: z.string().min(1).max(500),
              summary: z.string().max(500).optional(),
            })
          )
          .max(100),
      }),
      req
    );
    const s = await getSession(ps(req.params.id));
    assertSessionActor(actorOf(req), s);
    if (s.status !== 'running' && s.status !== 'blocked' && s.status !== 'needs-answer') {
      res.status(409).json({ errorMessages: [], errors: { session: `Session is ${s.status}.` } });
      return;
    }
    res.json(await depositTraces(actorOf(req), s, parsed.traces));
  })
);

// POST /api/internal/agent-questions/peer — non-blocking consult: target a
// specific agent (targetUserId) or summon by role tag (targetRole); the asker
// keeps working while the question lands in the peer's durable inbox.
agentRouter.post(
  '/agent-questions/peer',
  ah(async (req, res) => {
    const parsed = parseBody(
      z
        .object({
          sessionId: z.string(),
          issueKey: z.string(),
          question: z.string().min(1).max(4000),
          targetUserId: z.string().optional(),
          targetRole: z.string().max(100).optional(),
          expiresInSec: z.number().int().min(60).max(604_800).optional(),
        })
        .refine((b) => b.targetUserId || b.targetRole, { message: 'targetUserId or targetRole is required.' }),
      req
    );
    res.status(201).json(await askPeerQuestion(actorOf(req), parsed));
  })
);

// GET /api/internal/agent-sessions — fleet session board (scoped to the
// token's project allow-list). Filters: project, issue, status, role, agent.
// POST /api/internal/agent-sessions/{id}/locks — fenced path/glob resource
// locks bound to this session's driver lease (072 FR-008).
agentRouter.post(
  '/agent-sessions/:id/locks',
  ah(async (req, res) => {
    const parsed = parseBody(
      z.object({
        paths: z
          .array(
            z.object({
              path: z.string().min(1).max(500),
              mode: z.enum(['exclusive', 'shared']).optional(),
            })
          )
          .min(1)
          .max(50),
        enqueueOnConflict: z.boolean().optional(),
      }),
      req
    );
    const s = await getSession(ps(req.params.id));
    res.status(201).json(await acquireLocks(actorOf(req), s, parsed));
  })
);

// DELETE /api/internal/agent-sessions/{id}/locks?paths=a,b — release some or
// all of this session's path locks; wakes the FIFO path queues.
agentRouter.delete(
  '/agent-sessions/:id/locks',
  ah(async (req, res) => {
    const s = await getSession(ps(req.params.id));
    const paths = qs(req.query.paths)
      ? String(qs(req.query.paths)).split(',').map((p) => p.trim()).filter(Boolean)
      : undefined;
    res.json(await releaseLocks(actorOf(req), s, paths));
  })
);

// GET /api/internal/agent-questions/mine is registered above (before /:id).

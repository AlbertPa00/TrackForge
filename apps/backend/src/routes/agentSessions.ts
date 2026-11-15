// 047 — agent session + question routes. Internal product API; agents drive
// the same surface via PAT (write scope) — delegation grants no powers (FR-001).
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import type { Actor } from '../lib/auth.js';
import { ah, parseBody } from '../lib/http.js';
import { enforceIssueScope } from '../middleware/auth.js';
import {
  listIssueSessions,
  getSession,
  toSessionView,
  emitActivity,
  assertSessionActor,
  askQuestion,
  answerQuestion,
  getQuestion,
  listIssueQuestions,
  claimReadyWork,
  projectAgentActivity,
} from '../services/agentSessionService.js';

export const agentRouter: RouterType = Router();

const actorOf = (req: { actor?: Actor }): Actor => req.actor as Actor;

// GET /api/internal/issues/{key}/sessions — inspectable history (US2-3, A2)
agentRouter.get(
  '/issues/:key/sessions',
  ah(async (req, res) => {
    await enforceIssueScope(req.params.key, req.actor!);
    res.json({ sessions: await listIssueSessions(req.params.key) });
  })
);

// GET /api/internal/projects/{key}/agent-activity — 058 US5: one-shot map of
// live agent work for every card on a board/backlog (badges), so pages don't
// fan out one /sessions request per issue.
agentRouter.get(
  '/projects/:key/agent-activity',
  ah(async (req, res) => {
    res.json(await projectAgentActivity(actorOf(req), req.params.key));
  })
);

agentRouter.get(
  '/agent-sessions/:id',
  ah(async (req, res) => {
    // 064 US3 — IDOR: session detail is restricted to agent/delegator/admin.
    const s = await getSession(req.params.id);
    assertSessionActor(actorOf(req), s);
    res.json(toSessionView(s));
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
    res.status(201).json(await emitActivity(actorOf(req), req.params.id, body));
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
    await enforceIssueScope(req.params.key, req.actor!);
    const status = req.query.status ? String(req.query.status) : undefined;
    const questions = await listIssueQuestions(req.params.key, status);
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

agentRouter.get(
  '/agent-questions/:id',
  ah(async (req, res) => {
    const q = await getQuestion(req.params.id);
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
    const q = await answerQuestion(actorOf(req), req.params.id, answer);
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

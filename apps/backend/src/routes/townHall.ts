import { ps, qs } from '../lib/validation.js';
// 071 US1 — Town Hall routes. Channels → topics → posts/stances → resolve.
// Every write is actor-attributed; floor control + quorum live in the service.
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import type { Actor } from '../lib/auth.js';
import { ah, parseBody, isDryRun, markDryRun } from '../lib/http.js';
import {
  ensureGlobalChannels,
  ensureProjectChannels,
  listChannels,
  createChannel,
  listTopics,
  openTopic,
  getTopic,
  postToTopic,
  putStance,
  resolveTopic,
  TOPIC_KINDS,
  SPEECH_ACTS,
  STANCES,
} from '../services/townHallService.js';
import { prisma } from '../prisma.js';

export const townHallRouter: RouterType = Router();
const actorOf = (req: { actor?: Actor }): Actor => req.actor as Actor;

// GET /api/internal/town-hall/channels?project=TF — rooms visible to the actor.
townHallRouter.get(
  '/town-hall/channels',
  ah(async (req, res) => {
    await ensureGlobalChannels();
    const projectKey = qs(req.query.project) ? String(qs(req.query.project)).toUpperCase() : undefined;
    if (projectKey) {
      const p = await prisma.project.findUnique({ where: { key: projectKey }, select: { id: true } });
      if (p) await ensureProjectChannels(p.id);
    }
    res.json(await listChannels(actorOf(req), { projectKey }));
  })
);

// POST /api/internal/town-hall/channels — new room (project: ADMINISTER_PROJECTS;
// global: site admin).
townHallRouter.post(
  '/town-hall/channels',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        projectKey: z.string().max(50).optional(),
        slug: z.string().min(1).max(49),
        name: z.string().min(1).max(120),
        description: z.string().max(1000).optional(),
        agentCooldownSec: z.number().int().min(0).max(3600).optional(),
      }),
      req
    );
    res.status(201).json(await createChannel(actorOf(req), body, req));
  })
);

// GET /api/internal/town-hall/topics — feed cursor (lastActivityAt desc).
// Filters: channel, project, kind, status, before=<iso>, limit.
townHallRouter.get(
  '/town-hall/topics',
  ah(async (req, res) => {
    res.json(
      await listTopics(actorOf(req), {
        channelId: qs(req.query.channel) ? String(qs(req.query.channel)) : undefined,
        projectKey: qs(req.query.project) ? String(qs(req.query.project)).toUpperCase() : undefined,
        issueKey: qs(req.query.issue) ? String(qs(req.query.issue)).toUpperCase() : undefined,
        kind: qs(req.query.kind) ? String(qs(req.query.kind)) : undefined,
        status: qs(req.query.status) ? String(qs(req.query.status)) : undefined,
        limit: qs(req.query.limit) ? Number(qs(req.query.limit)) : undefined,
        before: qs(req.query.before) ? String(qs(req.query.before)) : undefined,
      })
    );
  })
);

// POST /api/internal/town-hall/topics — open a deliberation (first post is the
// opening speech act). linkedIssueKeys bind 'discusses' edges; requiredRoles
// summon fleet expertise into inboxes.
townHallRouter.post(
  '/town-hall/topics',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        channelId: z.string().min(1),
        kind: z.enum(TOPIC_KINDS).optional(),
        title: z.string().min(1).max(300),
        body: z.string().min(1).max(32_000),
        speechAct: z.enum(['proposal', 'question', 'evidence']).optional(),
        quorumRequired: z.number().int().min(1).max(50).optional(),
        requiredRoles: z.array(z.string().max(60)).max(10).optional(),
        linkedIssueKeys: z.array(z.string().max(50)).max(20).optional(),
        // 072 FR-006 — resolution requires a receipt-backed evidence post.
        requireEvidenceReceipt: z.boolean().optional(),
      }),
      req
    );
    res.status(201).json(await openTopic(actorOf(req), body));
  })
);

// GET /api/internal/town-hall/topics/{id} — full detail: posts, stances,
// quorum tally, linked issues (visibility-filtered).
townHallRouter.get(
  '/town-hall/topics/:id',
  ah(async (req, res) => {
    res.json(await getTopic(actorOf(req), ps(req.params.id)));
  })
);

// POST /api/internal/town-hall/topics/{id}/posts — threaded speech-act post;
// floor control (cooldown/depth/caps) enforced in the service.
townHallRouter.post(
  '/town-hall/topics/:id/posts',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        parentId: z.number().int().positive().optional(),
        speechAct: z.enum(SPEECH_ACTS.filter((a) => a !== 'decision') as [string, ...string[]]),
        body: z.string().min(1).max(32_000),
        refs: z
          .object({
            issueKeys: z.array(z.string().max(50)).max(20).optional(),
            files: z.array(z.string().max(500)).max(50).optional(),
            commitSha: z.string().max(80).optional(),
          })
          .optional(),
      }),
      req
    );
    res.status(201).json(await postToTopic(actorOf(req), ps(req.params.id), body));
  })
);

// PUT /api/internal/town-hall/topics/{id}/stances — zero-prose vote.
// 'object' demands a cited reason (10-2000 chars).
townHallRouter.put(
  '/town-hall/topics/:id/stances',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        stance: z.enum(STANCES),
        reason: z.string().max(2000).optional(),
      }),
      req
    );
    res.json(await putStance(actorOf(req), ps(req.params.id), body));
  })
);

// POST /api/internal/town-hall/topics/{id}/resolve — record the binding
// decision and optionally compile an Epic + blocked-by task DAG atomically.
// dryRun previews the plan (issue keys, edges, override count) with zero writes.
townHallRouter.post(
  '/town-hall/topics/:id/resolve',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        decisionSummary: z.string().min(1).max(10_000),
        overrideObjections: z.boolean().optional(),
        compileDag: z
          .object({
            epic: z.object({ summary: z.string().min(1).max(500), issueType: z.string().max(60).optional() }).optional(),
            tasks: z
              .array(
                z.object({
                  tempId: z.string().min(1).max(60),
                  summary: z.string().min(1).max(500),
                  issueType: z.string().max(60).optional(),
                  description: z.string().max(32_000).optional(),
                  roleHint: z.string().max(60).optional(),
                  targetFiles: z.array(z.string().max(500)).max(50).optional(),
                  blockedByTempIds: z.array(z.string().max(60)).max(20).optional(),
                })
              )
              .min(1)
              .max(50),
          })
          .optional(),
      }),
      req
    );
    if (isDryRun(req)) {
      markDryRun(res);
      res.json(await resolveTopic(actorOf(req), ps(req.params.id), body, { dryRun: true, req }));
      return;
    }
    res.json(await resolveTopic(actorOf(req), ps(req.params.id), body, { req }));
  })
);

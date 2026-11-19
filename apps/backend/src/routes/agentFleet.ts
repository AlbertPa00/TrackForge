import { ps, qs } from '../lib/validation.js';
// 071 US2/US4/US5 — fleet routes: roster, profiles, the durable inbox,
// context packs, the stigmergic heatmap and pause controls.
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import type { Actor } from '../lib/auth.js';
import { ah, parseBody } from '../lib/http.js';
import { projectAllowed } from '../middleware/auth.js';
import { jiraError } from '../lib/errors.js';
import { listRoster, upsertProfile, AGENT_ROLES } from '../services/agentProfileService.js';
import { listInbox, ackInbox, INBOX_REASONS } from '../services/agentInboxService.js';
import { projectTraces } from '../services/traceService.js';
import { getContextPack } from '../services/contextPackService.js';
import { setProjectPause, setGlobalPause, pauseStatus } from '../services/fleetPause.js';
import { listProjectLocks } from '../services/resourceLockService.js';
import { listAdvisories, createAdvisory, deleteAdvisory, ADVISORY_SEVERITIES } from '../services/advisoryService.js';
import { submitReceipt, getReceipt, listIssueReceipts, RECEIPT_KINDS } from '../services/receiptService.js';
import { listLedger } from '../services/issueLedgerService.js';
import {
  DELIVERABLE_VERDICTS,
  getIssueProvenance,
  listDeliverableReviews,
  submitDeliverableReview,
} from '../services/deliverableService.js';
import { outboxHealth } from '../services/dispatchService.js';
import { runnerStatus } from '../lib/jobs.js';
import { prisma } from '../prisma.js';

export const fleetRouter: RouterType = Router();
const actorOf = (req: { actor?: Actor }): Actor => req.actor as Actor;

// GET /api/internal/agents/roster?project=TF&role=coder&skill=prisma&status=online
// — who the fleet is, presence, capacity. Humans and agents alike read it.
fleetRouter.get(
  '/agents/roster',
  ah(async (req, res) => {
    res.json(
      await listRoster(actorOf(req), {
        projectKey: qs(req.query.project) ? String(qs(req.query.project)).toUpperCase() : undefined,
        role: qs(req.query.role) ? String(qs(req.query.role)).toLowerCase() : undefined,
        skill: qs(req.query.skill) ? String(qs(req.query.skill)).toLowerCase() : undefined,
        status: qs(req.query.status) as 'online' | 'busy' | 'offline' | undefined,
        limit: qs(req.query.limit) ? Number(qs(req.query.limit)) : undefined,
      })
    );
  })
);

// PUT /api/internal/agents/{userId}/profile — self or admin. Skills normalize
// to lowercase tags shared with [@role:x] summons.
fleetRouter.put(
  '/agents/:userId/profile',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        role: z.enum(AGENT_ROLES).optional(),
        skills: z.array(z.string().max(60)).max(30).optional(),
        model: z.string().max(120).nullable().optional(),
        bio: z.string().max(2000).nullable().optional(),
        maxConcurrentLeases: z.number().int().min(1).max(20).optional(),
      }),
      req
    );
    res.json(await upsertProfile(actorOf(req), ps(req.params.userId), body));
  })
);

// GET /api/internal/agent-inbox?after=<id>&unread=1&reasons=mention,peer_question
// — the durable mailbox. Cursor = last seen AgentInboxItem id.
fleetRouter.get(
  '/agent-inbox',
  ah(async (req, res) => {
    const reasons = String(qs(req.query.reasons) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => (INBOX_REASONS as readonly string[]).includes(s));
    res.json(
      await listInbox(actorOf(req), {
        after: qs(req.query.after) ? Number(qs(req.query.after)) : undefined,
        unreadOnly: ['1', 'true', 'yes'].includes(String(qs(req.query.unread) ?? '').toLowerCase()),
        reasons: reasons.length ? reasons : undefined,
        limit: qs(req.query.limit) ? Number(qs(req.query.limit)) : undefined,
      })
    );
  })
);

// POST /api/internal/agent-inbox/ack — {ids:[...]} | {upToId:n} | {all:true}.
fleetRouter.post(
  '/agent-inbox/ack',
  ah(async (req, res) => {
    const body = parseBody(
      z
        .object({
          ids: z.array(z.union([z.string().max(30), z.number().int().nonnegative()])).max(200).optional(),
          upToId: z.number().int().nonnegative().optional(),
          all: z.boolean().optional(),
        })
        .refine((b) => b.ids?.length || b.upToId !== undefined || b.all === true, {
          message: 'Provide ids, upToId, or all:true.',
        }),
      req
    );
    res.json(await ackInbox(actorOf(req), body));
  })
);

// GET /api/internal/issues/{key}/context-pack?maxTokens=4000 — the one-call
// bootstrap: issue core + leases + transitions + handoffs + decisions +
// traces + comments, priority-packed under the token budget.
fleetRouter.get(
  '/issues/:key/context-pack',
  ah(async (req, res) => {
    res.json(
      await getContextPack(
        actorOf(req),
        ps(req.params.key),
        qs(req.query.maxTokens) ? Number(qs(req.query.maxTokens)) : undefined
      )
    );
  })
);

// GET /api/internal/projects/{key}/traces — the stigmergic heatmap: live
// file/symbol intents across all open sessions in the project.
fleetRouter.get(
  '/projects/:key/traces',
  ah(async (req, res) => {
    res.json(await projectTraces(actorOf(req), ps(req.params.key)));
  })
);

// ---------- fleet pause (US5) ----------

// GET /api/internal/fleet/pause?project=TF — current brake state.
fleetRouter.get(
  '/fleet/pause',
  ah(async (req, res) => {
    const projectKey = qs(req.query.project) ? String(qs(req.query.project)).toUpperCase() : undefined;
    let projectId: string | undefined;
    if (projectKey) {
      const p = await prisma.project.findUnique({ where: { key: projectKey }, select: { id: true } });
      if (!p || !projectAllowed(actorOf(req), projectKey)) {
        res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
        return;
      }
      projectId = p.id;
    }
    res.json(await pauseStatus(projectId));
  })
);

// PUT /api/internal/projects/{key}/pause — project brake (lead/admin/
// ADMINISTER_PROJECTS). Audited.
fleetRouter.put(
  '/projects/:key/pause',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({ paused: z.boolean(), reason: z.string().max(500).optional() }),
      req
    );
    const project = await prisma.project.findUnique({
      where: { key: ps(req.params.key).toUpperCase() },
      select: { id: true },
    });
    if (!project || !projectAllowed(actorOf(req), ps(req.params.key).toUpperCase())) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    res.json(await setProjectPause(actorOf(req), project.id, body.paused, body.reason, req));
  })
);

// PUT /api/internal/fleet/pause — global brake (site admin only). Audited.
fleetRouter.put(
  '/fleet/pause',
  ah(async (req, res) => {
    if (!actorOf(req).user.isAdmin) {
      res.status(403).json(jiraError(['Only a site admin may pause the fleet globally.']));
      return;
    }
    const body = parseBody(
      z.object({ paused: z.boolean(), reason: z.string().max(500).optional() }),
      req
    );
    res.json(await setGlobalPause(actorOf(req), body.paused, body.reason, req));
  })
);

// ---------- 072 — fleet health, locks, advisories, receipts, ledger ----------

// GET /api/internal/fleet/health — outbox + runner health. Unauthenticated
// callers still reach requireAuth first, so this reports the degraded-mode
// signal to any authenticated principal; agents SHOULD poll it before
// launching heavy swarms.
fleetRouter.get(
  '/fleet/health',
  ah(async (_req, res) => {
    const [outbox, runner] = await Promise.all([outboxHealth(), Promise.resolve(runnerStatus())]);
    const degraded = runner.degraded || outbox.deadLettered > 0 || outbox.oldestUndispatchedAgeMs > 10_000;
    res.json({ status: degraded ? 'degraded' : 'ok', runner, outbox });
  })
);

// GET /api/internal/fleet/metrics?project=TF — SC-001..007 operational gauges.
fleetRouter.get(
  '/fleet/metrics',
  ah(async (req, res) => {
    const [outbox, runner, openSessions, waiters, locks, paused] = await Promise.all([
      outboxHealth(),
      Promise.resolve(runnerStatus()),
      prisma.agentSession.count({ where: { status: { in: ['running', 'needs-answer', 'blocked'] } } }),
      prisma.contentionWaiter.count({ where: { expiresAt: { gt: new Date() } } }),
      prisma.resourceLock.count({ where: { expiresAt: { gt: new Date() } } }),
      pauseStatus(undefined),
    ]);
    res.json({
      runner,
      outbox,
      fleet: { openSessions, waitlistDepth: waiters, activeLocks: locks, paused: paused.paused },
    });
  })
);

// GET /api/internal/projects/{key}/locks — live path-lock table + waiters.
fleetRouter.get(
  '/projects/:key/locks',
  ah(async (req, res) => {
    res.json(await listProjectLocks(actorOf(req), ps(req.params.key)));
  })
);

// GET/POST/DELETE /api/internal/projects/{key}/advisories — path-scoped repo
// memory crystals (FR-012): verified doNotRepeat lessons survive closed issues.
fleetRouter.get(
  '/projects/:key/advisories',
  ah(async (req, res) => {
    res.json(
      await listAdvisories(actorOf(req), ps(req.params.key), qs(req.query.path) ? String(qs(req.query.path)) : undefined)
    );
  })
);
fleetRouter.post(
  '/projects/:key/advisories',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        pathGlob: z.string().min(1).max(500),
        summary: z.string().min(1).max(2000),
        severity: z.enum(ADVISORY_SEVERITIES).optional(),
        sourceIssueKey: z.string().max(30).optional(),
        expiresInSec: z.number().int().min(60).max(30 * 86_400).optional(),
      }),
      req
    );
    res.status(201).json(await createAdvisory(actorOf(req), ps(req.params.key), body));
  })
);
fleetRouter.delete(
  '/projects/:key/advisories/:id',
  ah(async (req, res) => {
    res.json(await deleteAdvisory(actorOf(req), ps(req.params.key), ps(req.params.id)));
  })
);

// POST /api/internal/work-receipts — content-addressed proof of work (FR-005 + 073 FR-001).
// Digest-only stays at `digest_only`; inline `content` or `attachmentId` is
// hashed server-side to reach `hash_verified`; SCM corroboration upgrades higher.
fleetRouter.post(
  '/work-receipts',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        issueKey: z.string().max(30).optional(),
        sessionId: z.string().max(80).optional(),
        topicPostId: z.number().int().positive().optional(),
        kind: z.enum(RECEIPT_KINDS),
        sha256: z.string().regex(/^[a-f0-9]{64}$/i, 'sha256 must be a 64-char hex digest').optional(),
        content: z.string().max(70_000).optional(),
        contentType: z.string().max(120).optional(),
        attachmentId: z.string().uuid().optional(),
        changedFiles: z.array(z.string().min(1).max(500)).max(200).optional(),
        gitCommitSha: z.string().max(80).optional(),
        gitBranch: z.string().max(200).optional(),
        summary: z.string().min(1).max(1000),
        metrics: z.record(z.unknown()).optional(),
        artifactUri: z.string().max(1000).optional(),
      }),
      req
    );
    res.status(201).json(await submitReceipt(actorOf(req), body));
  })
);

// GET /api/internal/work-receipts/{id} — inspect receipt + inline diff/log payload (073 FR-001).
fleetRouter.get(
  '/work-receipts/:id',
  ah(async (req, res) => {
    res.json(await getReceipt(actorOf(req), ps(req.params.id)));
  })
);

// GET /api/internal/issues/{key}/receipts — proofs attached to this issue.
fleetRouter.get(
  '/issues/:key/receipts',
  ah(async (req, res) => {
    res.json(await listIssueReceipts(actorOf(req), ps(req.params.key)));
  })
);

// GET /api/internal/issues/{key}/ledger — the canonical issue ledger:
// immutable human+agent timeline cards (claims, handoffs, receipts,
// decisions, peer Q&A) — what the issue view renders for auditability.
fleetRouter.get(
  '/issues/:key/ledger',
  ah(async (req, res) => {
    res.json(await listLedger(actorOf(req), ps(req.params.key)));
  })
);

// GET /api/internal/issues/{key}/provenance — bidirectional lineage (073 FR-003):
// Town Hall RFC/decision links, receipts, changed files, latest session & review state.
fleetRouter.get(
  '/issues/:key/provenance',
  ah(async (req, res) => {
    res.json(await getIssueProvenance(actorOf(req), ps(req.params.key)));
  })
);

// GET/POST /api/internal/issues/{key}/deliverable-reviews — SHA/receipt-pinned
// post-execution acceptance sign-off (073 FR-004).
fleetRouter.get(
  '/issues/:key/deliverable-reviews',
  ah(async (req, res) => {
    res.json(await listDeliverableReviews(actorOf(req), ps(req.params.key)));
  })
);
fleetRouter.post(
  '/issues/:key/deliverable-review',
  ah(async (req, res) => {
    const body = parseBody(
      z.object({
        verdict: z.enum(DELIVERABLE_VERDICTS),
        body: z.string().max(10_000).optional(),
        receiptIds: z.array(z.string().uuid()).max(100).optional(),
        headSha: z.string().max(80).optional(),
      }),
      req
    );
    res.status(201).json(await submitDeliverableReview(actorOf(req), ps(req.params.key), body));
  })
);

// POST /api/internal/fleet/agents/{userId}/circuit/reset — clear a tripped
// per-agent circuit breaker (owner, project admin, or site admin).
fleetRouter.post(
  '/fleet/agents/:userId/circuit/reset',
  ah(async (req, res) => {
    const actor = actorOf(req);
    const target = await prisma.user.findUnique({
      where: { id: ps(req.params.userId) },
      select: { id: true, type: true, ownerId: true },
    });
    if (!target || target.type !== 'agent') {
      res.status(404).json(jiraError(['Agent not found.']));
      return;
    }
    if (!actor.user.isAdmin && actor.user.id !== target.ownerId) {
      res.status(403).json(jiraError(['Only the agent owner or a site admin may reset its circuit breaker.']));
      return;
    }
    const { resetAgentCircuit } = await import('../middleware/auth.js');
    resetAgentCircuit(target.id);
    res.json({ reset: true });
  })
);

import { ps } from '../lib/validation.js';
// /api/internal/events — cursor-based event feed + SSE stream.
// Visibility: token project allow-lists filter events to allowed projects.

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../prisma.js';
import { jiraError } from '../lib/errors.js';
import { toEventResponse } from '../services/eventService.js';
import { sseSubscribe, eventIssueVisible } from '../services/sseHub.js';
import { visibleProjectScope, canSeeProject } from '../services/visibilityService.js';
import type { Actor } from '../lib/auth.js';
import { ah } from '../lib/http.js';
import { qs } from '../lib/validation.js';

export const eventsRouter: RouterType = Router();

/** Project keys a token is allowed to see; null = unrestricted. */
function visibleProjects(actor: Actor): string[] | null {
  const allow = actor.token?.projectKeys;
  return allow && allow.length ? allow : null;
}

// GET /api/internal/events?after=<id>&types=a,b&projects=TF,DEMO&limit=100
// Cursor = last seen event id. 410 when `after` predates the pruned window.
eventsRouter.get(
  '/events',
  ah(async (req: Request, res: Response) => {
    const actor = req.actor!;
    const after = Math.max(0, Number(qs(req.query.after)) || 0);
    const limit = Math.min(500, Math.max(1, Number(qs(req.query.limit) ?? 100)) || 100);
    const types = String(qs(req.query.types) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const projects = String(qs(req.query.projects) ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (after > 0) {
      const cursor = await prisma.domainEvent.findUnique({ where: { id: BigInt(after) }, select: { id: true } });
      if (!cursor) {
        // Distinguish "never existed" (400) from "pruned" (410): the oldest live
        // event's id bounds the resumable window.
        const oldest = await prisma.domainEvent.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
        if (oldest && BigInt(after) < oldest.id) {
          res.status(410).json(jiraError(['Event cursor has expired — re-sync from the earliest live event.']));
          return;
        }
      }
    }

    const allowed = visibleProjects(actor);
    // project filter = requested ∩ allowed (empty intersection → nothing visible)
    const projectKeys = allowed ? (projects.length ? projects.filter((k) => allowed.includes(k)) : allowed) : projects;
    // 064 US3 — the feed also honors BROWSE_PROJECTS (not just the token
    // allow-list): non-browsable project ids are excluded at the query layer.
    const scope = await visibleProjectScope(actor);
    const where = {
      id: { gt: BigInt(after) },
      ...(types.length ? { type: { in: types } } : {}),
      ...(projectKeys.length || allowed ? { project: { key: { in: projectKeys } } } : {}),
      ...(scope.denied.size ? { projectId: { notIn: [...scope.denied] } } : {}),
      ...(scope.allowed ? { projectId: { in: [...scope.allowed] } } : {}),
    };
    const rows = await prisma.domainEvent.findMany({ where, orderBy: { id: 'asc' }, take: limit });
    // Issue-security levels hide per-row (same check the SSE path applies).
    const events = [] as ReturnType<typeof toEventResponse>[];
    for (const ev of rows) {
      if (ev.issueId && !(await eventIssueVisible(ev, actor))) continue;
      events.push(toEventResponse(ev));
    }
    res.json({
      events,
      nextCursor: rows.length ? Number(rows[rows.length - 1]!.id) : after,
      hasMore: rows.length === limit,
    });
  })
);

// GET /api/internal/events/stream — SSE. `Last-Event-ID` (or ?after=) resumes.
eventsRouter.get(
  '/events/stream',
  ah(async (req: Request, res: Response) => {
    const actor = req.actor!;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const allowed = visibleProjects(actor);
    // 065 audit C1 — same BROWSE_PROJECTS scope the polling endpoint applies.
    const scope = await visibleProjectScope(actor);
    const lastEventId = req.headers['last-event-id'] ?? qs(req.query.after);
    const resumeFrom = Number(lastEventId ?? 0) || 0;

    // Backfill missed events on resume before going live. A fresh connect
    // carries no Last-Event-ID at all — replaying history then floods the
    // client with one refetch per event (500x) and trips the rate limit.
    // Polling clients can still request full replay explicitly via ?after=0.
    const missed =
      lastEventId === undefined
        ? []
        : await prisma.domainEvent.findMany({
            where: { id: { gt: BigInt(resumeFrom) } },
            orderBy: { id: 'asc' },
            take: 500,
          });
    const allowedSet = allowed ? new Set(allowed.map((k) => k.toUpperCase())) : null;
    for (const ev of missed) {
      const pk = (ev.payload as { projectKey?: string }).projectKey ?? '';
      if (allowedSet && pk && !allowedSet.has(pk.toUpperCase())) continue;
      // C1 — backfill applies the same project scope as the live broadcast.
      if (ev.projectId && !canSeeProject(scope, ev.projectId)) continue;
      // 035 W1 — backfill honors issue security like the live path
      if (ev.issueId && !(await eventIssueVisible(ev, actor))) continue;
      res.write(`id: ${ev.id}\nevent: tf-event\ndata: ${JSON.stringify(toEventResponse(ev))}\n\n`);
    }

    // 071 — positive subscription filters: ?types=a,b limits event types,
    // ?channels=id1,id2 limits to Town Hall channel activity, and
    // ?inbox=1 restricts the socket to events whose payload targets THIS
    // actor — the fleet's wake-up channel (union semantics between clauses).
    const types = String(qs(req.query.types) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const channelIds = String(qs(req.query.channels) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const inboxOnly = ['1', 'true', 'yes'].includes(String(qs(req.query.inbox) ?? '').toLowerCase());
    sseSubscribe(res, allowed, actor, scope, { types, channelIds, inboxOnly });

    const heartbeat = setInterval(() => {
      try {
        res.write(`: hb ${Date.now()}\n\n`);
      } catch {
        /* closed */
      }
    }, 25_000);
    req.on('close', () => clearInterval(heartbeat));
  })
);

// GET /api/internal/events/{id} — single event (self link in feed items)
eventsRouter.get(
  '/events/:id',
  ah(async (req: Request, res: Response) => {
    const ev = await prisma.domainEvent.findUnique({ where: { id: BigInt(ps(req.params.id)) } }).catch(() => null);
    if (!ev) {
      res.status(404).json(jiraError(['Event not found.']));
      return;
    }
    const actor = req.actor!;
    const allowed = visibleProjects(actor);
    const pk = (ev.payload as { projectKey?: string }).projectKey;
    if (allowed && pk && !allowed.map((k) => k.toUpperCase()).includes(pk.toUpperCase())) {
      res.status(404).json(jiraError(['Event not found.']));
      return;
    }
    // 064 US3 — same existence-hiding as the list: BROWSE + issue security.
    const scope = await visibleProjectScope(actor);
    if (
      (ev.projectId && !canSeeProject(scope, ev.projectId)) ||
      (ev.issueId && !(await eventIssueVisible(ev, actor)))
    ) {
      res.status(404).json(jiraError(['Event not found.']));
      return;
    }
    res.json(toEventResponse(ev));
  })
);

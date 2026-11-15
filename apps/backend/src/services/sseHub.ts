// ---------- SSE hub (065 US5 — moved out of lib/jobs.ts: a hub that filters
// events through domain services is a service, not a lib primitive) ----------
import type { Response } from 'express';
import type { Actor } from '../lib/auth.js';
import type { DomainEvent } from '@prisma/client';
import { prisma } from '../prisma.js';
import { toEventResponse } from './eventService.js';
import { canSeeIssue } from './issueSecurityService.js';
import { logger } from '../lib/logger.js';

const log = logger.child({ mod: 'sse' });

interface SseClient {
  res: Response;
  visibleProjects: Set<string> | null; // token projectKeys allow-list; null = unrestricted
  projectScope?: { denied: Set<string>; allowed: Set<string> | null }; // 065 audit C1 — BROWSE_PROJECTS
  actor?: Actor; // 035 — per-client issue-security filtering
}

const sseClients = new Map<number, SseClient>();
let sseSeq = 0;

export function sseSubscribe(
  res: Response,
  visibleProjects: string[] | null,
  actor?: Actor,
  projectScope?: { denied: Set<string>; allowed: Set<string> | null }
): number {
  const id = ++sseSeq;
  sseClients.set(id, {
    res,
    visibleProjects: visibleProjects ? new Set(visibleProjects.map((k) => k.toUpperCase())) : null,
    projectScope,
    actor,
  });
  res.on('close', () => sseClients.delete(id));
  return id;
}

const eventIssueSelect = {
  id: true,
  effSecurityLevelId: true,
  reporterId: true,
  assigneeId: true,
  projectId: true,
} as const;

type EventIssue = {
  id: string;
  effSecurityLevelId: string | null;
  reporterId: string | null;
  assigneeId: string | null;
  projectId: string;
};

/** 035 W1 — issue-security check for a single event's issue, shared across clients. */
export async function eventIssueVisible(ev: DomainEvent, actor: Actor): Promise<boolean> {
  if (!ev.issueId) return true;
  const issue = await prisma.issue.findUnique({
    where: { id: ev.issueId },
    select: eventIssueSelect,
  });
  if (!issue) return false; // deleted — payload snapshot may still exist; hide it
  return canSeeIssue(actor, issue);
}

/** Local delivery — used by both the outbox dispatch path and the Redis
 *  fan-out subscriber (remote replicas' events arrive pre-filtered by the
 *  same code path, never re-published). */
async function deliverDomainEvent(ev: DomainEvent): Promise<void> {
  if (!sseClients.size) return;
  const data = JSON.stringify(toEventResponse(ev));
  const projectKey = ((ev.payload as Record<string, unknown>).projectKey as string) ?? '';
  // 070 — one issue row per event, not per client. With 1,000 connected
  // agents the old per-client fetch was N× the DB work per event; and
  // canSeeIssue early-returns for unsecured issues without touching the DB,
  // so only genuinely levelled issues keep a per-client check.
  const issue: EventIssue | null = ev.issueId
    ? await prisma.issue.findUnique({ where: { id: ev.issueId }, select: eventIssueSelect })
    : null;
  if (ev.issueId && !issue) return; // deleted mid-flight — hide the snapshot from everyone
  for (const c of sseClients.values()) {
    if (c.visibleProjects && projectKey && !c.visibleProjects.has(projectKey.toUpperCase())) continue;
    // 065 audit C1 — the stream honors BROWSE_PROJECTS, not just the token
    // allow-list: without this any signed-in user receives issue keys,
    // changelog items and comment/link objects for projects they can't browse.
    if (c.projectScope && ev.projectId) {
      if (c.projectScope.denied.has(ev.projectId)) continue;
      if (c.projectScope.allowed && !c.projectScope.allowed.has(ev.projectId)) continue;
    }
    try {
      if (c.actor && issue?.effSecurityLevelId && !(await canSeeIssue(c.actor, issue))) continue;
      c.res.write(`id: ${ev.id}\nevent: tf-event\ndata: ${data}\n\n`);
    } catch {
      /* client gone — close handler cleans up */
    }
  }
}

function deliverUserLocal(userId: string, data: Record<string, unknown>): void {
  const line = `event: tf-progress\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients.values()) {
    if (c.actor?.user.id !== userId) continue;
    try {
      c.res.write(line);
    } catch {
      /* client gone */
    }
  }
}

// ---------- 070 — cross-replica fan-out over Redis pub/sub ----------
// Clients live in-process, so a second replica used to see only its own
// sockets (docs/ha.md). With REDIS_URL set, each replica publishes domain
// events + per-user frames to `tf:sse`; every replica delivers locally.
const SSE_CHANNEL = 'tf:sse';
type RedisPublisher = { publish(channel: string, message: string): Promise<unknown> };
let ssePub: RedisPublisher | null = null;
let sseFanoutInit = false;

function dehydrateEvent(ev: DomainEvent): Record<string, unknown> {
  return {
    ...ev,
    id: ev.id.toString(),
    occurredAt: ev.occurredAt.toISOString(),
    dispatchedAt: ev.dispatchedAt?.toISOString() ?? null,
  };
}

function rehydrateEvent(raw: Record<string, unknown>): DomainEvent {
  return {
    ...raw,
    id: BigInt(String(raw.id)),
    occurredAt: new Date(String(raw.occurredAt)),
    dispatchedAt: raw.dispatchedAt ? new Date(String(raw.dispatchedAt)) : null,
  } as DomainEvent;
}

/** Call once at boot — no-ops without REDIS_URL (single-replica default). */
export async function initSseFanout(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url || sseFanoutInit) return;
  sseFanoutInit = true;
  try {
    const { Redis } = await import('ioredis');
    const pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const sub = new Redis(url, { lazyConnect: true });
    sub.on('message', (ch: string, msg: string) => {
      if (ch !== SSE_CHANNEL) return;
      try {
        const p = JSON.parse(msg) as
          | { kind: 'domain'; ev: Record<string, unknown> }
          | { kind: 'user'; userId: string; data: Record<string, unknown> };
        if (p.kind === 'domain') {
          void deliverDomainEvent(rehydrateEvent(p.ev)).catch(() => undefined);
        } else {
          deliverUserLocal(p.userId, p.data);
        }
      } catch {
        /* malformed frame — drop */
      }
    });
    await Promise.all([pub.connect(), sub.connect()]);
    await sub.subscribe(SSE_CHANNEL);
    ssePub = pub;
    log.info('SSE fan-out bridge up (Redis pub/sub)');
  } catch (e) {
    ssePub = null;
    log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      'SSE Redis fan-out unavailable — events deliver only to local sockets'
    );
  }
}

export async function sseBroadcast(ev: DomainEvent) {
  await deliverDomainEvent(ev);
  ssePub?.publish(SSE_CHANNEL, JSON.stringify({ kind: 'domain', ev: dehydrateEvent(ev) })).catch(() => undefined);
}

export function sseClientCount() {
  return sseClients.size;
}

/** 047 US5-3 — ephemeral per-user SSE frame (tf-progress). Not a DomainEvent:
 *  transient progress ticks don't belong in the persisted event store and are
 *  not backfilled — the buffered HTTP response is the fallback. */
export function sseEmitToUser(userId: string, data: Record<string, unknown>) {
  deliverUserLocal(userId, data);
  ssePub?.publish(SSE_CHANNEL, JSON.stringify({ kind: 'user', userId, data })).catch(() => undefined);
}

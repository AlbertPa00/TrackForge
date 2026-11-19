// ---------- SSE hub (065 US5 — moved out of lib/jobs.ts: a hub that filters
// events through domain services is a service, not a lib primitive) ----------
import type { Response } from 'express';
import type { Actor } from '../lib/auth.js';
import type { DomainEvent } from '../lib/pc.js';
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
  /** 071 — positive-subscription filter: when set, an event must match at
   *  least one clause to reach the client. `inboxOnly` matches events whose
   *  payload.inbox targets the actor — the fleet's wake-up channel that kills
   *  the O(events×clients) firehose for 200+ agents. */
  filter?: { types?: Set<string>; channelIds?: Set<string>; inboxOnly?: boolean };
  /** 072 — pure inboxOnly sockets live in `inboxSubscribers` and are skipped
   *  by the main scan; they receive only direct inbox-targeted delivery. */
  indexedInbox?: boolean;
}

const sseClients = new Map<number, SseClient>();
// 072 FR-004 — pure `inboxOnly` subscribers indexed by userId: fleet wake-up
// events route directly to their sockets instead of scanning every idle
// agent connection on every domain event.
const inboxSubscribers = new Map<string, Set<number>>();
let sseSeq = 0;

export function sseSubscribe(
  res: Response,
  visibleProjects: string[] | null,
  actor?: Actor,
  projectScope?: { denied: Set<string>; allowed: Set<string> | null },
  filter?: { types?: string[]; channelIds?: string[]; inboxOnly?: boolean }
): number {
  const id = ++sseSeq;
  const f =
    filter && (filter.types?.length || filter.channelIds?.length || filter.inboxOnly)
      ? {
          types: filter.types?.length ? new Set(filter.types) : undefined,
          channelIds: filter.channelIds?.length ? new Set(filter.channelIds) : undefined,
          inboxOnly: filter.inboxOnly,
        }
      : undefined;
  const pureInboxOnly = Boolean(f?.inboxOnly && !f.types?.size && !f.channelIds?.size && actor?.user.id);
  sseClients.set(id, {
    res,
    visibleProjects: visibleProjects ? new Set(visibleProjects.map((k) => k.toUpperCase())) : null,
    projectScope,
    actor,
    filter: f,
    indexedInbox: pureInboxOnly,
  });
  if (pureInboxOnly && actor) {
    const set = inboxSubscribers.get(actor.user.id) ?? new Set<number>();
    set.add(id);
    inboxSubscribers.set(actor.user.id, set);
  }
  res.on('close', () => {
    sseClients.delete(id);
    if (actor) {
      const set = inboxSubscribers.get(actor.user.id);
      if (set) {
        set.delete(id);
        if (!set.size) inboxSubscribers.delete(actor.user.id);
      }
    }
  });
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
  // 072 — direct-route pure inboxOnly subscribers: only sockets owned by a
  // payload.inbox target receive the frame; the other N idle agents cost 0.
  const inboxTargetIds = new Set(
    ((ev.payload as { inbox?: { userId?: string }[] }).inbox ?? []).map((r) => r.userId).filter((x): x is string => Boolean(x))
  );
  for (const c of sseClients.values()) {
    if (c.indexedInbox) continue; // handled by the direct-route pass below
    if (c.visibleProjects && projectKey && !c.visibleProjects.has(projectKey.toUpperCase())) continue;
    if (c.visibleProjects && projectKey && !c.visibleProjects.has(projectKey.toUpperCase())) continue;
    // 065 audit C1 — the stream honors BROWSE_PROJECTS, not just the token
    // allow-list: without this any signed-in user receives issue keys,
    // changelog items and comment/link objects for projects they can't browse.
    if (c.projectScope && ev.projectId) {
      if (c.projectScope.denied.has(ev.projectId)) continue;
      if (c.projectScope.allowed && !c.projectScope.allowed.has(ev.projectId)) continue;
    }
    // 071 — positive subscription: a filtered socket receives a frame only
    // when at least one clause matches (union semantics — an inbox+channel
    // sub sees both its wake-ups and its watched rooms).
    if (c.filter) {
      const p = ev.payload as { inbox?: { userId?: string }[]; channelId?: string };
      const inboxHit = Boolean(c.filter.inboxOnly && p.inbox?.some((r) => r.userId === c.actor?.user.id));
      const typeHit = Boolean(c.filter.types?.has(ev.type));
      const channelHit = Boolean(c.filter.channelIds && p.channelId && c.filter.channelIds.has(p.channelId));
      if (!inboxHit && !typeHit && !channelHit) continue;
    }
    try {
      if (c.actor && issue?.effSecurityLevelId && !(await canSeeIssue(c.actor, issue))) continue;
      c.res.write(`id: ${ev.id}\nevent: tf-event\ndata: ${data}\n\n`);
    } catch {
      /* client gone — close handler cleans up */
    }
  }
  // Direct-route pass: deliver to indexed inbox sockets of targeted users.
  for (const uid of inboxTargetIds) {
    for (const cid of inboxSubscribers.get(uid) ?? []) {
      const c = sseClients.get(cid);
      if (!c) continue;
      try {
        if (c.actor && issue?.effSecurityLevelId && !(await canSeeIssue(c.actor, issue))) continue;
        c.res.write(`id: ${ev.id}\nevent: tf-event\ndata: ${data}\n\n`);
      } catch {
        /* client gone */
      }
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

// 071 US2 — the durable agent inbox. Humans get Notification rows; agents get
// AgentInboxItem rows (they are not dropped on the floor anymore). Producers
// stamp `payload.inbox: [{userId, reason, actionHint?}]` on the DomainEvent
// they emit inside their own transaction; dispatch generates the rows from
// that envelope so inbox creation is transactional with the cause and carries
// no per-recipient N+1 (FR-011: one createMany per event batch).

import type { DomainEvent } from '../lib/pc.js';
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';

export const INBOX_REASONS = [
  'mention',
  'role_summon',
  'peer_question',
  'question_answered',
  'review_requested',
  'trace_collision',
  'dag_unblocked',
  'directive',
  // 072 — waitlist wake-ups + handoff targeting + lock contention.
  'lease_available',
  'lock_available',
  'handoff_ready',
  'circuit_tripped',
  // 073 — human/peer deliverable review feedback loop.
  'changes_requested',
] as const;

export interface InboxRef {
  userId: string;
  reason: string;
  actionHint?: string;
  topicId?: string;
}

/** Dispatch-side generator — reads `payload.inbox` and writes the rows.
 *  Called from dispatchService once per event; errors there are logged, never
 *  rethrown (inbox generation must not block the outbox).
 *  Bonus source: `~accountId:` mentions inside comment bodies — a human pinging
 *  an agent in a comment is exactly what the durable inbox exists for. */
export async function generateAgentInbox(ev: DomainEvent): Promise<void> {
  const p = ev.payload as { inbox?: InboxRef[]; issueKey?: string; comment?: { body?: string } };
  const refs = (p.inbox ?? []).filter((r) => r && typeof r.userId === 'string' && typeof r.reason === 'string');
  if (ev.type === 'comment_created' && p.comment?.body) {
    const mentioned = [...p.comment.body.matchAll(/\[~accountId:([^\]]+)\]/g)].map((m) => m[1]!);
    for (const userId of mentioned) {
      refs.push({ userId, reason: 'mention', actionHint: `Mentioned in a comment on ${p.issueKey ?? 'an issue'}.` });
    }
  }
  if (!refs.length) return;
  // Dedupe against the event actor — never inbox yourself.
  const unique = [...new Map(refs.filter((r) => r.userId !== ev.actorId).map((r) => [`${r.userId}:${r.reason}`, r])).values()];
  if (!unique.length) return;
  const users = await prisma.user.findMany({
    where: { id: { in: unique.map((r) => r.userId) }, active: true },
    select: { id: true },
  });
  const alive = new Set(users.map((u) => u.id));
  await prisma.agentInboxItem.createMany({
    data: unique
      .filter((r) => alive.has(r.userId))
      .map((r) => ({
        userId: r.userId,
        eventId: ev.id,
        projectId: ev.projectId,
        issueId: ev.issueId,
        topicId: r.topicId ?? null,
        reason: r.reason,
        payload: {
          issueKey: p.issueKey ?? null,
          fromActor: (ev.payload as { actor?: unknown }).actor ?? null,
          snippet: (((ev.payload as { comment?: { body?: string } }).comment?.body ??
            (ev.payload as { snippet?: string }).snippet ??
            '') as string).slice(0, 300),
          actionHint: r.actionHint ?? null,
        },
      })),
    skipDuplicates: true,
  });
}

/** Pull-model cursor feed — the agent's own durable mailbox. `after` is the
 *  last-seen item id (BigInt, same shape as the event cursor). */
export async function listInbox(
  actor: Actor,
  opts: { after?: number; unreadOnly?: boolean; reasons?: string[]; limit?: number }
) {
  const take = Math.min(200, Math.max(1, opts.limit ?? 50));
  const where = {
    userId: actor.user.id,
    ...(opts.after ? { id: { gt: BigInt(opts.after) } } : {}),
    ...(opts.unreadOnly ? { ackedAt: null } : {}),
    ...(opts.reasons?.length ? { reason: { in: opts.reasons } } : {}),
  };
  const [unreadCount, rows] = await Promise.all([
    prisma.agentInboxItem.count({ where: { userId: actor.user.id, ackedAt: null } }),
    prisma.agentInboxItem.findMany({
      where,
      orderBy: { id: 'asc' },
      take,
      include: {
        topic: { select: { id: true, title: true, status: true } },
      },
    }),
  ]);
  const issueIds = rows.map((r) => r.issueId).filter((x): x is string => Boolean(x));
  const issues = issueIds.length
    ? await prisma.issue.findMany({
        where: { id: { in: issueIds } },
        select: { id: true, issueNumber: true, summary: true, project: { select: { key: true } } },
      })
    : [];
  const issueBy = new Map(issues.map((i) => [i.id, `${i.project.key}-${i.issueNumber}`]));
  const summaryBy = new Map(issues.map((i) => [i.id, i.summary]));
  return {
    unreadCount,
    items: rows.map((r) => ({
      id: Number(r.id),
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      ackedAt: r.ackedAt?.toISOString() ?? null,
      issueKey: r.issueId ? (issueBy.get(r.issueId) ?? null) : null,
      issueSummary: r.issueId ? (summaryBy.get(r.issueId) ?? null) : null,
      topic: r.topic ? { id: r.topic.id, title: r.topic.title, status: r.topic.status } : null,
      eventId: r.eventId !== null ? Number(r.eventId) : null,
      payload: r.payload,
    })),
    nextCursor: rows.length ? Number(rows[rows.length - 1]!.id) : (opts.after ?? 0),
    hasMore: rows.length === take,
  };
}

export async function unreadInboxCount(userId: string): Promise<number> {
  return prisma.agentInboxItem.count({ where: { userId, ackedAt: null } });
}

/** Ack — `ids` for surgical acks, `upToId` for a cursor ack, `all` to flush. */
export async function ackInbox(actor: Actor, opts: { ids?: (string | number)[]; upToId?: number; all?: boolean }) {
  const where = {
    userId: actor.user.id,
    ackedAt: null,
    ...(opts.all ? {} : opts.upToId !== undefined ? { id: { lte: BigInt(opts.upToId) } } : { id: { in: (opts.ids ?? []).map((x) => BigInt(x)) } }),
  };
  const { count } = await prisma.agentInboxItem.updateMany({ where, data: { ackedAt: new Date() } });
  return { acked: count };
}

/** Retention — acked items die after 7d, unacked after 30d (fleets are noisy;
 *  the mailbox must stay a bounded working set, not an archive). */
export async function pruneInbox(): Promise<number> {
  const now = Date.now();
  const { count } = await prisma.agentInboxItem.deleteMany({
    where: {
      OR: [
        { ackedAt: { lt: new Date(now - 7 * 86_400_000) } },
        { ackedAt: null, createdAt: { lt: new Date(now - 30 * 86_400_000) } },
      ],
    },
  });
  return count;
}

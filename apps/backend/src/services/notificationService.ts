// In-app notifications — generated from dispatched events:
//   assigned       → assignee changed TO you by someone else
//   mentioned      → a comment mentions you ([~accountId:id])
//   watching       → you watch the issue and someone else changed/commented it
//   agent_question → a session asks you (delegator) or you assign the issue
//   agent_stalled  → a session you delegated stalls/blocks
//   agent_failed   → a session you delegated fails (e.g. question expired)
// Skipped: your own events, events on agent users (agents use webhooks/feed).

import type { DomainEvent } from '@prisma/client';
import { prisma } from '../prisma.js';
import { toUserResponse } from './userService.js';

const WATCHED_TYPES = new Set([
  'jira:issue_updated',
  'comment_created',
  'comment_updated',
  'issuelink_created',
  'issuelink_deleted',
  'worklog_created',
]);

function mentionIds(body: string): string[] {
  return [...body.matchAll(/\[~accountId:([^\]]+)\]/g)].map((m) => m[1]!);
}

export async function generateNotifications(ev: DomainEvent): Promise<void> {
  const p = ev.payload as {
    issueKey?: string;
    issueId?: string;
    delegatorId?: string;
    issue?: { fields?: { assignee?: { accountId?: string } } };
    comment?: { body?: string; id?: string };
    changelog?: { items?: { field?: string; to?: string | null }[] };
    actor?: { accountId?: string } | null;
  };
  const actorId = ev.actorId;
  const issueId = ev.issueId ?? null;
  const creates: { userId: string; reason: string }[] = [];

  // assigned — changelog item field=assignee with to=<accountId>
  if (ev.type === 'jira:issue_created' || ev.type === 'jira:issue_updated') {
    const assigneeTo = p.issue?.fields?.assignee?.accountId ?? null;
    const assigneeItem = p.changelog?.items?.find((i) => i.field === 'assignee');
    const target = ev.type === 'jira:issue_created' ? assigneeTo : (assigneeItem?.to ?? null);
    if (target && target !== actorId) creates.push({ userId: target, reason: 'assigned' });
  }

  // mentioned — comment bodies mention [~accountId:x]
  if ((ev.type === 'comment_created' || ev.type === 'comment_updated') && p.comment?.body) {
    for (const uid of mentionIds(p.comment.body)) {
      if (uid !== actorId) creates.push({ userId: uid, reason: 'mentioned' });
    }
  }

  // 047 — agent interrupts reach humans via the bell (agents use events).
  const delegator = (p as { delegatorId?: string }).delegatorId;
  if (ev.type === 'agent_question.created') {
    for (const uid of [delegator, p.issue?.fields?.assignee?.accountId]) {
      if (uid && uid !== actorId && !creates.some((c) => c.userId === uid)) {
        creates.push({ userId: uid, reason: 'agent_question' });
      }
    }
  }
  if (ev.type === 'agent_session.blocked' || ev.type === 'agent_session.failed') {
    if (delegator && delegator !== actorId)
      creates.push({
        userId: delegator,
        reason: ev.type === 'agent_session.blocked' ? 'agent_stalled' : 'agent_failed',
      });
  }

  // watching — anyone watching the issue except the actor (and not already notified)
  if (WATCHED_TYPES.has(ev.type) && issueId) {
    const watchers = await prisma.watcher.findMany({ where: { issueId }, select: { userId: true } });
    for (const w of watchers) {
      if (w.userId !== actorId && !creates.some((c) => c.userId === w.userId)) {
        creates.push({ userId: w.userId, reason: 'watching' });
      }
    }
  }

  if (!creates.length) return;
  // agents don't have inboxes — events reach them via webhooks/feed
  const humans = await prisma.user.findMany({
    where: { id: { in: creates.map((c) => c.userId) }, type: 'human', active: true },
    select: { id: true },
  });
  const humanIds = new Set(humans.map((u) => u.id));
  await prisma.notification.createMany({
    data: creates
      .filter((c) => humanIds.has(c.userId))
      .map((c) => ({ userId: c.userId, eventId: ev.id, issueId, reason: c.reason })),
    skipDuplicates: true,
  });
}

// ---------- API ----------

export async function listNotifications(
  userId: string,
  opts: { unreadOnly?: boolean; startAt?: number; maxResults?: number }
) {
  const where = { userId, ...(opts.unreadOnly ? { readAt: null } : {}) };
  const [total, unreadCount, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: opts.startAt ?? 0,
      take: Math.min(100, opts.maxResults ?? 50),
      include: {
        event: { select: { id: true, type: true, occurredAt: true, payload: true, channel: true } },
        issue: { include: { project: { select: { key: true } } } },
      },
    }),
  ]);
  return {
    total,
    unreadCount,
    startAt: opts.startAt ?? 0,
    maxResults: rows.length,
    notifications: rows.map((n) => {
      const p = (n.event?.payload ?? {}) as Record<string, unknown>;
      return {
        id: n.id,
        reason: n.reason,
        read: Boolean(n.readAt),
        created: n.createdAt.toISOString(),
        issueKey: (p.issueKey as string) ?? null,
        proposalId: (p.proposalId as string) ?? null,
        summary: (p.issue as { fields?: { summary?: string } })?.fields?.summary ?? null,
        event: {
          id: Number(n.event.id),
          type: n.event.type,
          occurredAt: n.event.occurredAt.toISOString(),
          channel: n.event.channel,
          actor: p.actor ?? null,
        },
        comment: (p.comment as { body?: string })?.body?.slice(0, 300) ?? null,
      };
    }),
  };
}

export async function markRead(userId: string, ids?: string[], all = false) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null, ...(all ? {} : { id: { in: ids ?? [] } }) },
    data: { readAt: new Date() },
  });
  return count;
}

export async function unreadCount(userId: string) {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

// ---------- watchers ----------

/** 066 — Jira "Autowatch" pref: creators/commenters/assignees auto-follow
 *  unless the user opted out in profile → notifications. Reads the same
 *  'notify.prefs' UserPreference row the mail prefs API serves (default on). */
export async function autowatchAllowed(userId: string, kind: 'create' | 'comment' | 'assign') {
  const row = await prisma.userPreference.findUnique({
    where: { userId_key: { userId, key: 'notify.prefs' } },
    select: { value: true },
  });
  const aw = (row?.value as { autowatch?: Record<string, boolean> } | undefined)?.autowatch;
  return aw?.[kind] !== false;
}

export async function addWatcher(issueId: string, userId: string) {
  // 057 US5 — join row + denormalized counter in one transaction.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.watcher.createMany({ data: [{ issueId, userId }], skipDuplicates: true });
    if (count) await tx.issue.update({ where: { id: issueId }, data: { watcherCount: { increment: count } } });
  });
}

export async function removeWatcher(issueId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.watcher.deleteMany({ where: { issueId, userId } });
    if (count) await tx.issue.update({ where: { id: issueId }, data: { watcherCount: { decrement: count } } });
  });
}

export async function watchState(issueId: string, viewerId?: string) {
  const watchers = await prisma.watcher.findMany({
    where: { issueId },
    include: { user: true },
    orderBy: { user: { displayName: 'asc' } },
  });
  return {
    watchCount: watchers.length,
    isWatching: viewerId ? watchers.some((w) => w.userId === viewerId) : false,
    watchers: watchers.map((w) => toUserResponse(w.user)),
  };
}

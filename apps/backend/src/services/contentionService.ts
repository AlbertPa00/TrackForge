// 072 FR-009 — FIFO contention waitlists + wake signals. A 409 is no longer a
// dead end: contenders opt into a bounded queue slot and the top live waiter
// gets a `lease_available` / `lock_available` / `handoff_ready` inbox item the
// moment the holder releases, breaks, or sweeps — zero polling.

import type { Prisma } from '../lib/pc.js';

export const WAITER_TTL_MS = 30 * 60 * 1000;
const WAKE_FANOUT = 3; // wake the head of the queue plus a little slack for dead waiters

type Tx = Pick<Prisma.TransactionClient, 'contentionWaiter' | 'user'>;

export interface WakeRef {
  userId: string;
  reason: string;
  actionHint: string;
}

/** Join (or refresh) the FIFO queue for a contended target. */
export async function enqueueWaiter(
  tx: Tx,
  args: { projectId: string; targetKind: 'issue' | 'path'; targetKey: string; userId: string }
): Promise<{ position: number }> {
  const expiresAt = new Date(Date.now() + WAITER_TTL_MS);
  const row = await tx.contentionWaiter.upsert({
    where: {
      targetKind_targetKey_userId: { targetKind: args.targetKind, targetKey: args.targetKey, userId: args.userId },
    },
    create: { ...args, expiresAt },
    update: { expiresAt },
  });
  // Position = this waiter's rank among LIVE waiters (createdAt asc), not a
  // raw row count — a re-enqueueing head waiter keeps reporting position 1,
  // and expired rows never inflate the reported depth.
  const position = await tx.contentionWaiter.count({
    where: {
      targetKind: args.targetKind,
      targetKey: args.targetKey,
      expiresAt: { gt: new Date() },
      createdAt: { lte: row.createdAt },
    },
  });
  return { position };
}

/** Pop the queue head(s) for a freed target and return inbox refs — callers
 *  merge them into the event payload inside the same transaction. */
export async function takeWaiterWakeups(
  tx: Tx,
  args: { targetKind: 'issue' | 'path'; targetKey: string; reason: 'lease_available' | 'lock_available' | 'handoff_ready'; actionHint: string }
): Promise<WakeRef[]> {
  const now = new Date();
  const head = await tx.contentionWaiter.findMany({
    where: { targetKind: args.targetKind, targetKey: args.targetKey, expiresAt: { gt: now } },
    orderBy: { createdAt: 'asc' },
    take: WAKE_FANOUT,
    select: { id: true, userId: true },
  });
  // Sweep the dead tail opportunistically.
  await tx.contentionWaiter.deleteMany({ where: { targetKind: args.targetKind, targetKey: args.targetKey, expiresAt: { lte: now } } });
  if (!head.length) return [];
  const alive = new Set(
    (
      await tx.user.findMany({
        where: { id: { in: head.map((w) => w.userId) }, active: true, type: 'agent' },
        select: { id: true },
      })
    ).map((u) => u.id)
  );
  const live = head.filter((w) => alive.has(w.userId));
  if (live.length) {
    await tx.contentionWaiter.deleteMany({ where: { id: { in: live.map((w) => w.id) } } });
  }
  return live.map((w) => ({ userId: w.userId, reason: args.reason, actionHint: args.actionHint }));
}

/** Drop an agent's own queue slot (e.g. after it wins the lease another way). */
export async function clearWaiter(tx: Tx, args: { targetKind: 'issue' | 'path'; targetKey: string; userId: string }) {
  await tx.contentionWaiter.deleteMany({ where: { ...args } });
}

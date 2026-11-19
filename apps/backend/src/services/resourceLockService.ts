// 072 FR-008 — enforceable resource locks. Advisory `resource_lock` traces
// warned after the collision; locks prevent it: exclusive or shared-read,
// TTL-fenced to the holding session's lease, FIFO waitlist on conflict.

import type { Actor } from '../lib/auth.js';
import type { Prisma } from '../lib/pc.js';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hasPermission } from './permissionService.js';
import { projectAllowed } from '../middleware/auth.js';
import { emitEvent } from './eventService.js';
import { enqueueWaiter, takeWaiterWakeups, type WakeRef } from './contentionService.js';
import type { AgentSession } from '../lib/pc.js';

const MAX_LOCKS_PER_SESSION = 20;
const SINGLETON_ALLOWLIST = new Set(['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'prisma/schema.prisma']);

/** Normalize to a POSIX repo path; reject traversal and wildcards shallower
 *  than one directory segment unless the file is a known singleton. */
export function normalizeLockPath(raw: string): string {
  const p = raw.trim().replace(/\\+/g, '/').replace(/^\.?\//, '').replace(/\/+/g, '/');
  if (!p || p.includes('..') || p.startsWith('/')) {
    throw new JiraApiError(400, jiraError([], { path: 'Path must be a repo-relative POSIX path without traversal.' }));
  }
  if (p.includes('*')) {
    const starSegs = p.split('/').filter((s) => s.includes('*'));
    const depth = p.indexOf('*') > -1 ? p.slice(0, p.indexOf('*')).split('/').filter(Boolean).length : 0;
    const globOk = starSegs.length === 1 && p.endsWith('**') && depth >= 1;
    if (!globOk && !SINGLETON_ALLOWLIST.has(p)) {
      throw new JiraApiError(
        400,
        jiraError([], { path: `Wildcard locks must be a single trailing '/**' at depth >= 1 (got '${p}'). Lock the specific file instead.` })
      );
    }
  }
  return p;
}

/** Does a concrete path fall under a lock pattern? (`dir/**` prefix or exact.) */
export function pathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith('/**')) return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2));
  return path === pattern;
}

/** Two patterns contend when either covers a path the other could hold. */
function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const ap = a.endsWith('/**') ? a.slice(0, -2) : null;
  const bp = b.endsWith('/**') ? b.slice(0, -2) : null;
  if (ap && (b.startsWith(ap) || (bp && bp.startsWith(ap)))) return true;
  if (bp && (a.startsWith(bp) || (ap && ap.startsWith(bp)))) return true;
  return Boolean(ap && bp && ap === bp);
}

type LockRow = {
  id: string; sessionId: string; agentUserId: string; pathPattern: string; mode: string;
  fenceToken: number; expiresAt: Date;
  session: { status: string; issue: { issueNumber: number; project: { key: string } } };
  agent: { displayName: string };
};

const lockInclude = {
  session: { select: { status: true, issue: { select: { issueNumber: true, project: { select: { key: true } } } } } },
  agent: { select: { displayName: true } },
} as const;

function toLockView(l: LockRow) {
  return {
    id: l.id,
    pathPattern: l.pathPattern,
    mode: l.mode,
    fenceToken: l.fenceToken,
    expiresAt: l.expiresAt.toISOString(),
    sessionId: l.sessionId,
    agent: l.agent.displayName,
    issueKey: `${l.session.issue.project.key}-${l.session.issue.issueNumber}`,
  };
}

export async function acquireLocks(
  actor: Actor,
  session: AgentSession & { issue: { id: string; projectId: string; issueNumber: number; project: { key: string } } },
  input: { paths: { path: string; mode?: 'exclusive' | 'shared' }[]; enqueueOnConflict?: boolean }
) {
  if (actor.user.id !== session.agentUserId && !actor.user.isAdmin) {
    throw new JiraApiError(403, jiraError(['Only the session agent (or an admin) may acquire locks.']));
  }
  if (!['running', 'blocked', 'needs-answer'].includes(session.status) || session.role !== 'driver') {
    throw new JiraApiError(409, jiraError([], { session: `Locks require an open driver session (got '${session.status}'/'${session.role}').` }));
  }
  const patterns = input.paths.map((p) => ({ path: normalizeLockPath(p.path), mode: p.mode ?? 'exclusive' }));
  const now = new Date();
  const expiresAt = session.leaseExpiresAt ?? new Date(now.getTime() + session.ttlSec * 1000);

  const out = await prisma.$transaction(async (tx) => {
    const existing = await tx.resourceLock.findMany({
      where: { projectId: session.issue.projectId, expiresAt: { gt: now } },
      include: lockInclude,
    });
    const mine = await tx.resourceLock.count({ where: { sessionId: session.id, expiresAt: { gt: now } } });
    const conflicts: { path: string; heldBy: LockRow }[] = [];
    for (const want of patterns) {
      for (const held of existing as unknown as LockRow[]) {
        if (held.sessionId === session.id) continue;
        if (!patternsOverlap(held.pathPattern, want.path)) continue;
        if (held.mode === 'shared' && want.mode === 'shared') continue;
        conflicts.push({ path: want.path, heldBy: held });
        break;
      }
    }
    if (conflicts.length) {
      const c = conflicts[0]!;
      // 072 — the 409 aborts this tx, so the waitlist row must be persisted
      // after rollback (see claimLease). Signal via the error for the caller.
      const err = new JiraApiError(
        409,
        jiraError([], {
          lock: `Path '${c.path}' is ${c.heldBy.mode}-locked by ${c.heldBy.agent.displayName} on ${c.heldBy.session.issue.project.key}-${c.heldBy.session.issue.issueNumber} until ${c.heldBy.expiresAt.toISOString()}.`,
          ...(input.enqueueOnConflict
            ? { waitlistPosition: 'queued' }
            : { hint: 'Pass enqueueOnConflict:true to join the FIFO waitlist.' }),
        })
      ) as JiraApiError & { _waitlist?: { projectId: string; targetKind: 'path'; targetKey: string; userId: string } };
      if (input.enqueueOnConflict) {
        err._waitlist = { projectId: session.issue.projectId, targetKind: 'path', targetKey: c.path, userId: session.agentUserId };
      }
      throw err;
    }
    if (mine + patterns.length > MAX_LOCKS_PER_SESSION) {
      throw new JiraApiError(400, jiraError([], { locks: `Lock budget exceeded (max ${MAX_LOCKS_PER_SESSION} per session).` }));
    }
    const created = [] as LockRow[];
    for (const want of patterns) {
      const lockId = `${session.id}:${createHash('sha256').update(want.path).digest('hex').slice(0, 16)}`;
      const l = (await tx.resourceLock.upsert({
        where: { id: lockId },
        create: {
          id: lockId,
          projectId: session.issue.projectId,
          sessionId: session.id,
          agentUserId: session.agentUserId,
          pathPattern: want.path,
          mode: want.mode,
          fenceToken: session.fenceToken ?? 0,
          expiresAt,
        },
        update: { mode: want.mode, expiresAt },
        include: lockInclude,
      })) as unknown as LockRow;
      created.push(l);
    }
    return created;
  }).catch(async (e) => {
    const w = (e as JiraApiError & { _waitlist?: { projectId: string; targetKind: 'path'; targetKey: string; userId: string } })._waitlist;
    if (w) {
      const enq = await enqueueWaiter(prisma, w);
      if (e instanceof JiraApiError) e.response.errors.waitlistPosition = String(enq.position);
    }
    throw e;
  });
  return { locks: out.map(toLockView) };
}

export async function releaseLocks(actor: Actor, session: AgentSession, paths?: string[]) {
  if (actor.user.id !== session.agentUserId && !actor.user.isAdmin) {
    throw new JiraApiError(403, jiraError(['Only the session agent (or an admin) may release locks.']));
  }
  const normalized = paths?.map(normalizeLockPath);
  const released = await prisma.$transaction(async (tx) => {
    const rows = await tx.resourceLock.findMany({
      where: { sessionId: session.id, ...(normalized ? { pathPattern: { in: normalized } } : {}) },
    });
    if (!rows.length) return [] as { path: string; wakeups: { userId: string; reason: string; actionHint: string }[] }[];
    await tx.resourceLock.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const out = [] as { path: string; wakeups: { userId: string; reason: string; actionHint: string }[] }[];
    for (const r of rows) {
      const wakeups = await takeWaiterWakeups(tx, {
        targetKind: 'path',
        targetKey: r.pathPattern,
        reason: 'lock_available',
        actionHint: `Lock on '${r.pathPattern}' released — claim it now.`,
      });
      out.push({ path: r.pathPattern, wakeups });
    }
    return out;
  });
  const inbox = released.flatMap((r) => r.wakeups);
  if (inbox.length) {
    await emitEvent(prisma as never, actor, {
      type: 'resource_lock.released',
      projectId: (session as { issue?: { projectId?: string } }).issue?.projectId ?? null,
      issueId: session.issueId,
      payload: { inbox, paths: released.map((r) => r.path) },
    });
  }
  return { released: released.map((r) => r.path), woken: inbox.length };
}

/** Called when a session leaves open state — frees all its locks and wakes
 *  path waiters. Runs inside the caller's transaction where possible. */
export async function releaseSessionLocks(
  tx: Pick<Prisma.TransactionClient, 'resourceLock' | 'contentionWaiter' | 'user'>,
  sessionId: string
): Promise<WakeRef[]> {
  const rows = await tx.resourceLock.findMany({ where: { sessionId }, select: { id: true, pathPattern: true } });
  if (!rows.length) return [];
  await tx.resourceLock.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
  const wakeups: { userId: string; reason: string; actionHint: string }[] = [];
  for (const r of rows) {
    wakeups.push(
      ...(await takeWaiterWakeups(tx, {
        targetKind: 'path',
        targetKey: r.pathPattern,
        reason: 'lock_available',
        actionHint: `Lock on '${r.pathPattern}' freed — claim it now.`,
      }))
    );
  }
  return wakeups;
}

export async function listProjectLocks(actor: Actor, projectKey: string) {
  const key = projectKey.toUpperCase();
  const project = await prisma.project.findUnique({ where: { key }, select: { id: true } });
  if (!project || !projectAllowed(actor, key)) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  if (!actor.user.isAdmin && !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: project.id }))) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  const now = new Date();
  const [locks, waiters] = await Promise.all([
    prisma.resourceLock.findMany({ where: { projectId: project.id, expiresAt: { gt: now } }, include: lockInclude }),
    prisma.contentionWaiter.findMany({
      where: { projectId: project.id, targetKind: 'path', expiresAt: { gt: now } },
      include: { user: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const queueDepth = new Map<string, number>();
  for (const w of waiters) queueDepth.set(w.targetKey, (queueDepth.get(w.targetKey) ?? 0) + 1);
  return {
    locks: (locks as unknown as LockRow[]).map((l) => ({ ...toLockView(l), queueDepth: queueDepth.get(l.pathPattern) ?? 0 })),
    waiters: waiters.map((w) => ({ path: w.targetKey, agent: w.user.displayName, since: w.createdAt.toISOString() })),
  };
}

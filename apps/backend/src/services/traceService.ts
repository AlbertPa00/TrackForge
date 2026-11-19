// 071 US4 — stigmergic traces: agents declare which files/symbols they intend
// to touch so parallel worktrees sense overlap BEFORE merge time. Traces are
// ephemeral — bound to the session's lease expiry and cascade-deleted on
// session close. `file_edit`/`symbol_edit`/`resource_lock` intents collide;
// `file_read` never does (reads are ambient).

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { emitEvent } from './eventService.js';
import { hasPermission } from './permissionService.js';
import { projectAllowed } from '../middleware/auth.js';
import type { Actor } from '../lib/auth.js';

export const TRACE_KINDS = ['file_read', 'file_edit', 'symbol_edit', 'resource_lock'] as const;
const WRITE_KINDS = new Set(['file_edit', 'symbol_edit', 'resource_lock']);
const MAX_TARGETS = 100;

/** POSIX-normalize: `a\b\c` → `a/b/c`, strip leading `./`, collapse `..` runs
 *  that would escape the repo root (they clamp at root, never reject — a
 *  malformed path must not be able to smuggle a non-colliding variant). */
export function normalizeTarget(raw: string): string {
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/');
  const parts: string[] = [];
  for (const seg of cleaned.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/').slice(0, 500);
}

/** Replace the session's declared intents and return cross-issue collisions.
 *  Caller (agentSessionService) already validated session ownership + lease. */
export async function depositTraces(
  actor: Actor,
  session: { id: string; issueId: string; agentUserId: string; leaseExpiresAt: Date | null },
  traces: { kind: string; target: string; summary?: string }[]
) {
  if (traces.length > MAX_TARGETS) {
    throw new JiraApiError(400, jiraError([], { traces: `Max ${MAX_TARGETS} targets per session.` }));
  }
  const issue = await prisma.issue.findUnique({
    where: { id: session.issueId },
    select: { projectId: true },
  });
  if (!issue) throw new JiraApiError(404, jiraError(['Issue not found.']));
  const rows = traces.map((t) => ({
    kind: t.kind,
    target: normalizeTarget(t.target),
    summary: t.summary?.slice(0, 500) ?? null,
  }));
  for (const r of rows) {
    if (!TRACE_KINDS.includes(r.kind as (typeof TRACE_KINDS)[number])) {
      throw new JiraApiError(400, jiraError([], { kind: `Invalid kind '${r.kind}'. Allowed: ${TRACE_KINDS.join(', ')}.` }));
    }
    if (!r.target) throw new JiraApiError(400, jiraError([], { target: 'Normalized target is empty.' }));
  }
  const expiresAt = session.leaseExpiresAt ?? new Date(Date.now() + 15 * 60_000);

  // Replace-in-transaction, then collide against other open sessions' writes.
  await prisma.$transaction(async (tx) => {
    await tx.stigmergicTrace.deleteMany({ where: { sessionId: session.id } });
    await tx.stigmergicTrace.createMany({
      data: rows.map((r) => ({
        projectId: issue.projectId,
        issueId: session.issueId,
        sessionId: session.id,
        actorId: session.agentUserId,
        kind: r.kind,
        target: r.target,
        summary: r.summary,
        expiresAt,
      })),
      skipDuplicates: true,
    });
  });

  const myWriteTargets = rows.filter((r) => WRITE_KINDS.has(r.kind)).map((r) => r.target);
  let collisions: {
    issueKey: string;
    agent: string;
    sessionId: string;
    kind: string;
    target: string;
    worktreeRef: string | null;
    leaseExpiresAt: string | null;
  }[] = [];
  if (myWriteTargets.length) {
    const others = await prisma.stigmergicTrace.findMany({
      where: {
        projectId: issue.projectId,
        sessionId: { not: session.id },
        target: { in: myWriteTargets },
        kind: { in: [...WRITE_KINDS] },
        expiresAt: { gt: new Date() },
        OR: [
          { session: { status: { in: ['running', 'needs-answer', 'blocked'] } } },
          // 072 — unmerged worktree traces outlive released sessions and still
          // count as collisions: the edits exist, the session just let go.
          { pendingMerge: true },
        ],
      },
      include: {
        session: { select: { id: true, worktreeRef: true, leaseExpiresAt: true, agent: { select: { displayName: true, id: true } } } },
        issue: { select: { issueNumber: true, project: { select: { key: true } } } },
      },
      take: 50,
    });
    collisions = others.map((o) => ({
      issueKey: `${o.issue.project.key}-${o.issue.issueNumber}`,
      agent: o.session.agent.displayName,
      sessionId: o.session.id,
      kind: o.kind,
      target: o.target,
      pendingMerge: o.pendingMerge,
      worktreeRef: o.session.worktreeRef,
      leaseExpiresAt: o.session.leaseExpiresAt?.toISOString() ?? null,
    }));
    if (collisions.length) {
      const holders = [...new Map(others.map((o) => [o.session.agent.id, o])).values()];
      await emitEvent(prisma, actor, {
        type: 'agent_trace.collision',
        projectId: issue.projectId,
        issueId: session.issueId,
        payload: {
          sessionId: session.id,
          collisions: collisions.map((c) => ({ issueKey: c.issueKey, target: c.target, kind: c.kind })),
          inbox: holders.map((h) => ({
            userId: h.session.agent.id,
            reason: 'trace_collision',
            actionHint: `${actor.user.displayName} declared ${collisions
              .filter((c) => c.sessionId === h.sessionId)
              .map((c) => c.kind)
              .join('/')} on ${[...new Set(collisions.filter((c) => c.sessionId === h.sessionId).map((c) => c.target))].join(', ')}.`,
          })),
        },
      });
    }
  }
  return { deposited: rows.length, collisions };
}

/** Project heatmap — live file/symbol intents across all open sessions. */
export async function projectTraces(actor: Actor, projectKey: string) {
  const project = await prisma.project.findUnique({ where: { key: projectKey.toUpperCase() } });
  if (
    !project ||
    !projectAllowed(actor, project.key) ||
    !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: project.id }))
  ) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  const rows = await prisma.stigmergicTrace.findMany({
    where: {
      projectId: project.id,
      expiresAt: { gt: new Date() },
      OR: [{ session: { status: { in: ['running', 'needs-answer', 'blocked'] } } }, { pendingMerge: true }],
    },
    include: {
      session: { select: { id: true, role: true, worktreeRef: true, agent: { select: { id: true, displayName: true } } } },
      issue: { select: { issueNumber: true, project: { select: { key: true } } } },
    },
    orderBy: { target: 'asc' },
    take: 2000,
  });
  const byTarget = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byTarget.get(r.target) ?? [];
    list.push(r);
    byTarget.set(r.target, list);
  }
  return {
    projectKey: project.key,
    traces: [...byTarget].map(([target, list]) => ({
      target,
      contested: list.filter((l) => WRITE_KINDS.has(l.kind)).length > 1,
      holders: list.map((l) => ({
        kind: l.kind,
        issueKey: `${l.issue.project.key}-${l.issue.issueNumber}`,
        agent: l.session.agent.displayName,
        sessionId: l.session.id,
        role: l.session.role,
        pendingMerge: l.pendingMerge,
        worktreeRef: l.session.worktreeRef,
        summary: l.summary,
        expiresAt: l.expiresAt.toISOString(),
      })),
    })),
  };
}

/** Sweep hook — deletes expired rows (also invoked by lease expiry). */
export async function pruneExpiredTraces(): Promise<number> {
  const { count } = await prisma.stigmergicTrace.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

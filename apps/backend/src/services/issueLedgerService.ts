// 072 FR-010 — canonical per-issue ledger. Every lease lifecycle event,
// verified receipt, compiled decision, drift flag, and peer Q&A resolution
// lands as an immutable entry so the issue timeline shows what the fleet
// actually did — not just the one comment it left behind.

import type { Actor } from '../lib/auth.js';
import { Prisma } from '../lib/pc.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hasPermission } from './permissionService.js';
import { enforceIssueScope } from '../middleware/auth.js';
import { parseIssueKey } from './issueService.js';

export const LEDGER_KINDS = [
  'lease_claimed',
  'lease_handed_off',
  'lease_ready_for_review',
  'lease_completed',
  'lease_failed',
  'lease_broken',
  'lease_expired',
  'receipt_submitted',
  'receipt_verified',
  'deliverable_approved',
  'deliverable_changes_requested',
  'peer_question_answered',
  'topic_compiled',
  'drift_flagged',
] as const;

export interface LedgerInput {
  issueId: string;
  actorId?: string | null;
  kind: (typeof LEDGER_KINDS)[number] | string;
  summary: string;
  payload?: Record<string, unknown>;
  receiptId?: string | null;
  sessionId?: string | null;
}

/** Call inside the mutation's transaction so the ledger is atomic with it. */
export async function recordLedger(tx: Pick<Prisma.TransactionClient, 'issueLedgerEntry'>, e: LedgerInput) {
  await tx.issueLedgerEntry.create({
    data: {
      issueId: e.issueId,
      actorId: e.actorId ?? null,
      kind: e.kind,
      summary: e.summary.slice(0, 1000),
      payload: (e.payload ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      receiptId: e.receiptId ?? null,
      sessionId: e.sessionId ?? null,
    },
  });
}

export async function listLedger(
  actor: Actor,
  issueKey: string,
  opts: { limit?: number; before?: number } = {}
) {
  const { projectKey, issueNumber } = await parseIssueKey(issueKey.toUpperCase());
  const issue = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    select: { id: true, projectId: true },
  });
  if (!issue) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }
  await enforceIssueScope(issueKey.toUpperCase(), actor);
  const canSee = actor.user.isAdmin || (await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: issue.projectId }));
  if (!canSee) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  const take = Math.min(200, Math.max(1, opts.limit ?? 50));
  const rows = await prisma.issueLedgerEntry.findMany({
    where: { issueId: issue.id, ...(opts.before ? { id: { lt: BigInt(opts.before) } } : {}) },
    orderBy: { id: 'desc' },
    take,
    include: {
      actor: { select: { id: true, displayName: true, type: true } },
      receipt: { select: { id: true, kind: true, verification: true, summary: true } },
    },
  });
  return {
    entries: rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      summary: r.summary,
      payload: r.payload,
      receipt: r.receipt
        ? { id: r.receipt.id, kind: r.receipt.kind, verification: r.receipt.verification, summary: r.receipt.summary }
        : null,
      sessionId: r.sessionId,
      actor: r.actor ? { accountId: r.actor.id, displayName: r.actor.displayName, type: r.actor.type } : null,
      createdAt: r.createdAt.toISOString(),
    })),
    nextBefore: rows.length === take ? Number(rows[rows.length - 1]!.id) : null,
  };
}

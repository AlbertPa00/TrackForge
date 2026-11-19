// 073 FR-002/FR-003/FR-004 — Human Verifiability, Provenance & Deliverable Sign-Off.
// Bridges the fleet plane into Jira's native human surfaces:
//   1. Consolidated Work Product Dossier comments on session release
//   2. Bidirectional RFC ↔ Issue ↔ Session ↔ Receipt/File provenance
//   3. SHA/receipt-pinned DeliverableReview with staleness invalidation and
//      durable inbox wake-ups on changes_requested.

import type { Actor } from '../lib/auth.js';
import { Prisma } from '../lib/pc.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { enforceIssueScope } from '../middleware/auth.js';
import { hasPermission, requirePermission } from './permissionService.js';
import { parseIssueKey, toIssueKey, issueInclude, toIssueResponse } from './issueService.js';
import { toCommentResponse } from './commentService.js';
import { emitEvent } from './eventService.js';
import { recordLedger } from './issueLedgerService.js';
import { issueReceiptGate, toReceiptView } from './receiptService.js';

export const DELIVERABLE_VERDICTS = ['approved', 'changes_requested'] as const;

export interface DossierReceiptSummary {
  id: string;
  kind: string;
  sha256: string;
  verification: string;
  summary: string;
  changedFiles: string[];
  metricsJson: unknown;
  hasInlineContent: boolean;
  attachmentId: string | null;
}

const OUTCOME_LABELS: Record<string, string> = {
  ready_for_review: 'Ready for Review',
  completed: 'Completed',
  handed_off: 'Handed Off',
  failed: 'Failed',
};

function formatMetricsShort(metricsJson: unknown): string {
  if (!metricsJson || typeof metricsJson !== 'object') return '—';
  const m = metricsJson as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof m.passed === 'number') parts.push(`${m.passed} passed`);
  if (typeof m.failed === 'number') parts.push(`${m.failed} failed`);
  if (typeof m.durationMs === 'number') parts.push(`${m.durationMs}ms`);
  return parts.length ? parts.join(', ') : '—';
}

export function buildDossierComment(opts: {
  agentName: string;
  role: string;
  sessionId: string;
  outcome: string;
  summary: string;
  branchName: string | null;
  baseSha: string | null;
  headSha: string | null;
  driftStatus: string;
  remainingSteps: string[];
  doNotRepeat: string[];
  receipts: DossierReceiptSummary[];
  originatingTopic: { id: string; title: string; relation: string } | null;
}): { body: string; metadata: Record<string, unknown> } {
  const outcomeLabel = OUTCOME_LABELS[opts.outcome] ?? opts.outcome;
  const shaSpan =
    opts.baseSha && opts.headSha
      ? `\`${opts.baseSha.slice(0, 8)}..${opts.headSha.slice(0, 8)}\``
      : opts.headSha
        ? `\`${opts.headSha.slice(0, 12)}\``
        : null;
  const ctxParts = [
    `Agent: **${opts.agentName}** (\`${opts.role}\`)`,
    ...(opts.branchName ? [`Branch: \`${opts.branchName}\``] : []),
    ...(shaSpan ? [`Commit: ${shaSpan}`] : []),
    `Drift: \`${opts.driftStatus}\``,
  ];

  const allFiles = [
    ...new Set(opts.receipts.flatMap((r) => r.changedFiles ?? [])),
  ];

  const lines: string[] = [
    `### Work Product Dossier — ${outcomeLabel}`,
    ctxParts.join(' · '),
    '',
    opts.summary.trim(),
  ];

  if (opts.receipts.length) {
    lines.push(
      '',
      '| Kind | Digest | Verification | Metrics | Summary |',
      '|---|---|---|---|---|'
    );
    for (const r of opts.receipts) {
      const cleanSummary = r.summary.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 160);
      lines.push(
        `| \`${r.kind}\` | \`${r.sha256.slice(0, 12)}\` | **${r.verification.replace(/_/g, ' ')}** | ${formatMetricsShort(r.metricsJson)} | ${cleanSummary} |`
      );
    }
  }

  if (allFiles.length) {
    lines.push(
      '',
      `**Changed files (${allFiles.length}):** ${allFiles.slice(0, 20).map((f) => `\`${f}\``).join(', ')}${allFiles.length > 20 ? ` (+${allFiles.length - 20} more)` : ''}`
    );
  }

  if (opts.remainingSteps.length) {
    lines.push('', '**Remaining steps:**', ...opts.remainingSteps.map((s) => `- ${s}`));
  }
  if (opts.doNotRepeat.length) {
    lines.push('', '**Do not repeat:**', ...opts.doNotRepeat.map((s) => `- ${s}`));
  }
  if (opts.originatingTopic) {
    lines.push(
      '',
      `_Provenance: ${opts.originatingTopic.relation} from Town Hall topic **${opts.originatingTopic.title}** (\`${opts.originatingTopic.id.slice(0, 8)}\`) · Session \`${opts.sessionId.slice(0, 8)}\`_`
    );
  } else {
    lines.push('', `_Session \`${opts.sessionId.slice(0, 8)}\`_`);
  }

  const metadata = {
    kind: 'agent_dossier',
    sessionId: opts.sessionId,
    outcome: opts.outcome,
    branchName: opts.branchName,
    baseSha: opts.baseSha,
    headSha: opts.headSha,
    driftStatus: opts.driftStatus,
    receiptIds: opts.receipts.map((r) => r.id),
    changedFiles: allFiles,
    topicId: opts.originatingTopic?.id ?? null,
    topicTitle: opts.originatingTopic?.title ?? null,
  };

  return { body: lines.join('\n'), metadata };
}

/** Transactionally creates a Comment with structured metadataJson and emits comment_created. */
export async function insertStructuredCommentInTx(
  tx: Prisma.TransactionClient,
  actor: Actor,
  issue: { id: string; projectId: string; issueNumber: number; project: { key: string } },
  body: string,
  metadata: Record<string, unknown>,
  authorIdOverride?: string
): Promise<string> {
  const issueKey = toIssueKey(issue.project.key, issue.issueNumber);
  const c = await tx.comment.create({
    data: {
      issueId: issue.id,
      authorId: authorIdOverride ?? actor.user.id,
      body,
      channel: actor.channel,
      metadataJson: metadata as Prisma.InputJsonValue,
    },
    include: { author: true, issue: { include: { project: true } } },
  });
  const snapshot = await tx.issue.findUnique({ where: { id: issue.id }, include: issueInclude });
  await emitEvent(tx, actor, {
    type: 'comment_created',
    projectId: issue.projectId,
    issueId: issue.id,
    payload: {
      issueKey,
      projectKey: issue.project.key,
      issue: snapshot ? toIssueResponse(snapshot) : null,
      comment: toCommentResponse(c),
    },
  });
  return c.id;
}

function toReviewView(r: {
  id: string;
  verdict: string;
  body: string | null;
  pinnedHeadSha: string | null;
  pinnedReceiptIds: string[];
  sessionId: string | null;
  commentId: string | null;
  supersededAt: Date | null;
  createdAt: Date;
  reviewer: { id: string; displayName: string; type: string };
}) {
  return {
    id: r.id,
    verdict: r.verdict,
    body: r.body,
    pinnedHeadSha: r.pinnedHeadSha,
    pinnedReceiptIds: r.pinnedReceiptIds,
    sessionId: r.sessionId,
    commentId: r.commentId,
    supersededAt: r.supersededAt?.toISOString() ?? null,
    stale: r.supersededAt !== null,
    reviewer: {
      accountId: r.reviewer.id,
      displayName: r.reviewer.displayName,
      type: r.reviewer.type,
    },
    createdAt: r.createdAt.toISOString(),
  };
}

/** 073 FR-003 — Single-call bidirectional provenance for an issue:
 *  Town Hall RFC/decisions ↔ sessions ↔ receipts & files ↔ deliverable review state. */
export async function getIssueProvenance(actor: Actor, issueKey: string) {
  const key = issueKey.toUpperCase();
  const { projectKey, issueNumber } = await parseIssueKey(key);
  const issue = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    select: { id: true, projectId: true, issueNumber: true, project: { select: { key: true } } },
  });
  if (!issue) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  await enforceIssueScope(key, actor);
  if (!actor.user.isAdmin && !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: issue.projectId }))) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }

  const [topicLinks, receiptRows, lastDriver, reviewRows] = await Promise.all([
    prisma.townHallTopicIssue.findMany({
      where: { issueId: issue.id },
      include: {
        topic: {
          include: {
            channel: { select: { slug: true, name: true } },
            author: { select: { id: true, displayName: true, type: true } },
            resolvedBy: { select: { id: true, displayName: true, type: true } },
            posts: {
              where: { speechAct: 'evidence' },
              select: {
                id: true,
                receipts: {
                  select: { id: true, kind: true, sha256: true, verification: true, summary: true },
                },
              },
            },
          },
        },
      },
      orderBy: { topic: { createdAt: 'desc' } },
    }),
    prisma.workReceipt.findMany({
      where: { issueId: issue.id },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: { id: true, displayName: true } },
        issue: { select: { issueNumber: true, project: { select: { key: true } } } },
        attachment: { select: { id: true, filename: true, mime: true, sniffedMime: true, size: true } },
        payload: { select: { byteLength: true } },
      },
    }),
    prisma.agentSession.findFirst({
      where: { issueId: issue.id, role: 'driver' },
      orderBy: { startedAt: 'desc' },
      include: { agent: { select: { id: true, displayName: true } } },
    }),
    prisma.deliverableReview.findMany({
      where: { issueId: issue.id },
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: { reviewer: { select: { id: true, displayName: true, type: true } } },
    }),
  ]);

  const receipts = receiptRows.map(toReceiptView);
  const changedFilesSet = new Set<string>();
  for (const r of receipts) {
    for (const f of r.changedFiles) changedFilesSet.add(f);
  }
  const observed = (lastDriver?.driftReport as { observed?: unknown } | null)?.observed;
  if (Array.isArray(observed)) {
    for (const f of observed) if (typeof f === 'string') changedFilesSet.add(f);
  }

  const latestReview = reviewRows[0] ?? null;
  const handoffOutcome = (lastDriver?.handoff as { outcome?: string } | null)?.outcome ?? null;
  let reviewStatus: 'none' | 'awaiting_review' | 'approved' | 'changes_requested' | 'stale' = 'none';
  if (latestReview) {
    if (latestReview.verdict === 'approved') {
      reviewStatus = latestReview.supersededAt ? 'stale' : 'approved';
    } else if (
      lastDriver?.finishedAt &&
      lastDriver.finishedAt > latestReview.createdAt &&
      (handoffOutcome === 'ready_for_review' || handoffOutcome === 'completed')
    ) {
      reviewStatus = 'awaiting_review';
    } else {
      reviewStatus = 'changes_requested';
    }
  } else if (
    handoffOutcome === 'ready_for_review' ||
    (lastDriver && (handoffOutcome === 'completed' || receipts.length > 0))
  ) {
    reviewStatus = 'awaiting_review';
  }

  return {
    issueKey: key,
    topics: topicLinks.map((tl) => ({
      topicId: tl.topic.id,
      relation: tl.relation,
      title: tl.topic.title,
      kind: tl.topic.kind,
      status: tl.topic.status,
      channelSlug: tl.topic.channel.slug,
      channelName: tl.topic.channel.name,
      decisionSummary: tl.topic.decisionSummary,
      author: { accountId: tl.topic.author.id, displayName: tl.topic.author.displayName, type: tl.topic.author.type },
      resolvedBy: tl.topic.resolvedBy
        ? { accountId: tl.topic.resolvedBy.id, displayName: tl.topic.resolvedBy.displayName, type: tl.topic.resolvedBy.type }
        : null,
      resolvedAt: tl.topic.resolvedAt?.toISOString() ?? null,
      evidenceReceipts: tl.topic.posts.flatMap((p) =>
        p.receipts.map((r) => ({
          id: r.id,
          postId: Number(p.id),
          kind: r.kind,
          sha256: r.sha256,
          verification: r.verification === 'unverified' ? 'digest_only' : r.verification,
          summary: r.summary,
        }))
      ),
    })),
    receipts,
    changedFiles: [...changedFilesSet],
    latestDriverSession: lastDriver
      ? {
          id: lastDriver.id,
          status: lastDriver.status,
          outcome: handoffOutcome,
          agent: { accountId: lastDriver.agent.id, displayName: lastDriver.agent.displayName },
          branchName: lastDriver.branchName,
          baseSha: lastDriver.baseSha,
          headSha: lastDriver.headSha,
          driftStatus: lastDriver.driftStatus,
          driftReport: lastDriver.driftReport,
          dossierCommentId: lastDriver.dossierCommentId,
          finishedAt: lastDriver.finishedAt?.toISOString() ?? null,
        }
      : null,
    deliverableReview: {
      status: reviewStatus,
      activeApproval:
        latestReview && latestReview.verdict === 'approved' && !latestReview.supersededAt
          ? toReviewView(latestReview)
          : null,
      latestReview: latestReview ? toReviewView(latestReview) : null,
      reviews: reviewRows.map(toReviewView),
    },
  };
}

export async function listDeliverableReviews(actor: Actor, issueKey: string) {
  const key = issueKey.toUpperCase();
  const { projectKey, issueNumber } = await parseIssueKey(key);
  const issue = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    select: { id: true, projectId: true },
  });
  if (!issue) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  await enforceIssueScope(key, actor);
  if (!actor.user.isAdmin && !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: issue.projectId }))) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }
  const rows = await prisma.deliverableReview.findMany({
    where: { issueId: issue.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { reviewer: { select: { id: true, displayName: true, type: true } } },
  });
  return { reviews: rows.map(toReviewView) };
}

/** 073 FR-004 — Submit SHA/receipt-pinned deliverable review (`approved` | `changes_requested`). */
export async function submitDeliverableReview(
  actor: Actor,
  issueKey: string,
  input: {
    verdict: 'approved' | 'changes_requested';
    body?: string;
    receiptIds?: string[];
    headSha?: string;
  }
) {
  const key = issueKey.toUpperCase();
  await enforceIssueScope(key, actor);
  const { projectKey, issueNumber } = await parseIssueKey(key);
  const issue = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    include: { project: true },
  });
  if (!issue) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  await requirePermission(actor, 'EDIT_ISSUES', { projectId: issue.projectId, issue });

  const trimmedBody = input.body?.trim() ?? '';
  if (input.verdict === 'changes_requested' && trimmedBody.length < 10) {
    throw new JiraApiError(
      400,
      jiraError([], { body: 'Requesting changes requires review notes of at least 10 characters so the agent knows what to fix.' })
    );
  }

  const lastDriver = await prisma.agentSession.findFirst({
    where: { issueId: issue.id, role: 'driver' },
    orderBy: { startedAt: 'desc' },
    select: { id: true, agentUserId: true, headSha: true },
  });

  if (lastDriver && lastDriver.agentUserId === actor.user.id) {
    throw new JiraApiError(
      403,
      jiraError(['Separation of duties: the implementing driver agent cannot review or approve its own deliverable.'])
    );
  }

  const issueReceipts = await prisma.workReceipt.findMany({
    where: { issueId: issue.id },
    select: { id: true, verification: true, sha256: true, kind: true },
  });
  const issueReceiptMap = new Map(issueReceipts.map((r) => [r.id, r]));

  let pinnedReceiptIds: string[];
  if (input.receiptIds?.length) {
    const foreign = input.receiptIds.filter((id) => !issueReceiptMap.has(id));
    if (foreign.length) {
      throw new JiraApiError(400, jiraError([], { receiptIds: `Receipt(s) not attached to ${key}: ${foreign.join(', ')}` }));
    }
    pinnedReceiptIds = [...new Set(input.receiptIds)];
  } else {
    pinnedReceiptIds = issueReceipts.map((r) => r.id);
  }

  const pinnedHeadSha = input.headSha?.trim() || lastDriver?.headSha || null;
  const now = new Date();

  const review = await prisma.$transaction(async (tx) => {
    await tx.deliverableReview.updateMany({
      where: { issueId: issue.id, supersededAt: null },
      data: { supersededAt: now },
    });

    if (input.verdict === 'approved' && actor.user.type === 'human' && pinnedReceiptIds.length) {
      await tx.workReceipt.updateMany({
        where: {
          id: { in: pinnedReceiptIds },
          verification: { in: ['hash_verified', 'scm_corroborated'] },
        },
        data: { verification: 'human_attested', verifiedAt: now },
      });
    }

    const mdHeader =
      input.verdict === 'approved'
        ? `### Deliverable Review — Approved`
        : `### Deliverable Review — Changes Requested`;
    const pinLine = [
      `Reviewer: **${actor.user.displayName}** (\`${actor.user.type}\`)`,
      ...(pinnedHeadSha ? [`Pinned SHA: \`${pinnedHeadSha.slice(0, 12)}\``] : []),
      ...(pinnedReceiptIds.length ? [`Pinned receipts: ${pinnedReceiptIds.length}`] : []),
    ].join(' · ');
    const commentBody = [mdHeader, pinLine, ...(trimmedBody ? ['', trimmedBody] : [])].join('\n');

    const commentId = await insertStructuredCommentInTx(
      tx,
      actor,
      issue,
      commentBody,
      {
        kind: 'deliverable_review',
        verdict: input.verdict,
        reviewerType: actor.user.type,
        pinnedHeadSha,
        pinnedReceiptIds,
        sessionId: lastDriver?.id ?? null,
      }
    );

    const created = await tx.deliverableReview.create({
      data: {
        projectId: issue.projectId,
        issueId: issue.id,
        sessionId: lastDriver?.id ?? null,
        reviewerId: actor.user.id,
        verdict: input.verdict,
        body: trimmedBody || null,
        pinnedHeadSha,
        pinnedReceiptIds,
        commentId,
      },
      include: { reviewer: { select: { id: true, displayName: true, type: true } } },
    });

    await recordLedger(tx, {
      issueId: issue.id,
      actorId: actor.user.id,
      kind: input.verdict === 'approved' ? 'deliverable_approved' : 'deliverable_changes_requested',
      summary:
        input.verdict === 'approved'
          ? `${actor.user.displayName} approved deliverable${pinnedHeadSha ? ` (${pinnedHeadSha.slice(0, 8)})` : ''}.`
          : `${actor.user.displayName} requested changes: ${trimmedBody.slice(0, 200)}`,
      sessionId: lastDriver?.id ?? null,
      payload: {
        reviewId: created.id,
        verdict: input.verdict,
        pinnedHeadSha,
        pinnedReceiptIds,
      },
    });

    const inbox: { userId: string; reason: string; actionHint: string }[] = [];
    if (lastDriver && lastDriver.agentUserId !== actor.user.id) {
      inbox.push({
        userId: lastDriver.agentUserId,
        reason: input.verdict === 'changes_requested' ? 'changes_requested' : 'directive',
        actionHint:
          input.verdict === 'changes_requested'
            ? `Changes requested on ${key} by ${actor.user.displayName}: ${trimmedBody.slice(0, 220)}`
            : `Deliverable approved on ${key} by ${actor.user.displayName}.`,
      });
    }

    await emitEvent(tx, actor, {
      type: 'deliverable_review.submitted',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issueKey: key,
        reviewId: created.id,
        verdict: input.verdict,
        pinnedHeadSha,
        pinnedReceiptIds,
        inbox,
      },
    });

    return created;
  });

  return toReviewView(review);
}

/** 073 FR-004 — Workflow TransitionRule validator `deliverableApproved`. */
export async function checkDeliverableApprovedGate(
  issueId: string,
  cfg: { requireHuman?: boolean; minReceiptTier?: string } = {}
): Promise<{ ok: true } | { ok: false; missing: string }> {
  const requireHuman = cfg.requireHuman !== false;
  const minTier = cfg.minReceiptTier ?? 'hash_verified';

  const receiptCheck = await issueReceiptGate(
    issueId,
    ['diff', 'test_run', 'benchmark', 'build', 'command'],
    minTier
  );
  if (!receiptCheck.ok) return receiptCheck;

  const latest = await prisma.deliverableReview.findFirst({
    where: { issueId },
    orderBy: { createdAt: 'desc' },
    include: { reviewer: { select: { type: true, displayName: true } } },
  });

  if (!latest) {
    return {
      ok: false,
      missing: `Requires deliverable sign-off before completing (POST /api/internal/issues/{key}/deliverable-review with verdict='approved').`,
    };
  }
  if (latest.verdict === 'changes_requested') {
    return {
      ok: false,
      missing: `Deliverable has unaddressed changes_requested feedback from ${latest.reviewer.displayName}.`,
    };
  }
  if (latest.supersededAt !== null) {
    return {
      ok: false,
      missing: `Prior deliverable approval by ${latest.reviewer.displayName} is stale because new leases, diff receipts, or drift occurred afterward — re-approve the current deliverable.`,
    };
  }
  if (requireHuman && latest.reviewer.type !== 'human') {
    return {
      ok: false,
      missing: `Workflow requires deliverable sign-off by a human reviewer (last approval was by agent '${latest.reviewer.displayName}').`,
    };
  }
  return { ok: true };
}

// 072 FR-005/006 + 073 FR-001 — WorkReceipts: content-addressed proof artifacts.
// Digest-only submissions (no bytes uploaded) stay at `digest_only`.
// `hash_verified` requires TrackForge to hash inline `content` (<= 64 KiB) or
// an uploaded `Attachment` (`attachmentId`) and verify SHA-256(bytes) === sha256.
// `scm_corroborated` upgrades when `gitCommitSha` matches an ingested
// DevelopmentItem (038/051), and `human_attested` when pinned by DeliverableReview.

import { createHash } from 'node:crypto';
import type { Actor } from '../lib/auth.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { resourceSelf } from '../lib/http.js';
import { getAttachmentStore } from '../ports/attachmentStore.js';
import { hasPermission } from './permissionService.js';
import { enforceIssueScope, projectAllowed } from '../middleware/auth.js';
import { emitEvent } from './eventService.js';
import { recordLedger } from './issueLedgerService.js';
import { parseIssueKey, toIssueKey } from './issueService.js';

export const RECEIPT_KINDS = ['diff', 'test_run', 'benchmark', 'build', 'command'] as const;
export const VERIFICATION_TIERS = [
  'digest_only',
  'hash_verified',
  'scm_corroborated',
  'human_attested',
  'signed_ci',
] as const;
export const MAX_INLINE_RECEIPT_BYTES = 65_536;

function tierRank(t: string): number {
  if (t === 'unverified') return 0;
  const idx = VERIFICATION_TIERS.indexOf(t as (typeof VERIFICATION_TIERS)[number]);
  return idx >= 0 ? idx : 1;
}

export interface ReceiptInput {
  issueKey?: string;
  sessionId?: string;
  topicPostId?: number;
  kind: (typeof RECEIPT_KINDS)[number];
  sha256?: string;
  content?: string;
  contentType?: string;
  attachmentId?: string;
  changedFiles?: string[];
  gitCommitSha?: string;
  gitBranch?: string;
  summary: string;
  metrics?: Record<string, unknown>;
  artifactUri?: string;
}

function normalizeChangedFiles(explicit?: string[], metrics?: Record<string, unknown>): string[] {
  const fromMetrics = Array.isArray(metrics?.filesChanged)
    ? (metrics.filesChanged as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  const merged = [...(explicit ?? []), ...fromMetrics];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of merged) {
    const clean = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!clean || clean.length > 500 || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 200) break;
  }
  return out;
}

function defaultContentType(kind: string): string {
  if (kind === 'diff') return 'text/x-diff';
  return 'text/plain';
}

const receiptListInclude = {
  author: { select: { id: true, displayName: true } },
  issue: { select: { issueNumber: true, project: { select: { key: true } } } },
  attachment: { select: { id: true, filename: true, mime: true, sniffedMime: true, size: true } },
  payload: { select: { byteLength: true } },
} as const;

type ReceiptListRow = {
  id: string;
  kind: string;
  sha256: string;
  gitCommitSha: string | null;
  gitBranch: string | null;
  summary: string;
  metricsJson: unknown;
  artifactUri: string | null;
  changedFiles: string[];
  attachmentId: string | null;
  contentType: string | null;
  verification: string;
  verifiedAt: Date | null;
  topicPostId: bigint | null;
  sessionId: string | null;
  createdAt: Date;
  author: { id: string; displayName: string } | null;
  issue: { issueNumber: number; project: { key: string } } | null;
  attachment: { id: string; filename: string; mime: string; sniffedMime: string | null; size: number } | null;
  payload: { byteLength: number } | null;
};

export function toReceiptView(r: ReceiptListRow) {
  return {
    id: r.id,
    kind: r.kind,
    sha256: r.sha256,
    gitCommitSha: r.gitCommitSha,
    gitBranch: r.gitBranch,
    issueKey: r.issue ? toIssueKey(r.issue.project.key, r.issue.issueNumber) : null,
    sessionId: r.sessionId,
    topicPostId: r.topicPostId !== null ? Number(r.topicPostId) : null,
    summary: r.summary,
    metrics: r.metricsJson ?? null,
    artifactUri: r.artifactUri,
    changedFiles: r.changedFiles ?? [],
    contentType: r.contentType,
    hasInlineContent: Boolean(r.payload),
    contentByteLength: r.payload?.byteLength ?? null,
    attachmentId: r.attachmentId,
    attachment: r.attachment
      ? {
          id: r.attachment.id,
          filename: r.attachment.filename,
          mimeType: r.attachment.sniffedMime ?? r.attachment.mime,
          size: r.attachment.size,
          contentUrl: resourceSelf(`/rest/api/2/attachment/content/${r.attachment.id}`),
        }
      : null,
    verification: r.verification === 'unverified' ? 'digest_only' : r.verification,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    author: r.author ? { accountId: r.author.id, displayName: r.author.displayName } : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** If the commit sha matches an ingested DevelopmentItem (038/051 webhooks
 *  already normalize commits/builds), upgrade verification — the SCM saw it. */
async function corroborate(receiptId: string, sha: string, kind: string): Promise<'scm_corroborated' | null> {
  const wantedType = kind === 'build' || kind === 'test_run' ? ['build', 'commit'] : ['commit'];
  const hit = await prisma.developmentItem.findFirst({
    where: { type: { in: wantedType }, externalId: { contains: sha } },
    select: { id: true, state: true },
  });
  if (!hit) return null;
  if (wantedType.includes('build') && hit.state && !['success', 'succeeded', 'passed', 'committed', ''].includes(hit.state)) {
    return null;
  }
  await prisma.workReceipt.update({
    where: { id: receiptId },
    data: { verification: 'scm_corroborated', verifiedAt: new Date() },
  });
  return 'scm_corroborated';
}

export async function submitReceipt(actor: Actor, input: ReceiptInput) {
  if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.sha256)) {
    throw new JiraApiError(400, jiraError([], { sha256: 'sha256 must be a 64-char hex digest of the artifact content.' }));
  }

  let issue: { id: string; projectId: string; issueNumber: number; project: { key: string } } | null = null;
  if (input.issueKey) {
    const { projectKey, issueNumber } = await parseIssueKey(input.issueKey.toUpperCase());
    issue = await prisma.issue.findFirst({
      where: { issueNumber, project: { key: projectKey } },
      select: { id: true, projectId: true, issueNumber: true, project: { select: { key: true } } },
    });
    if (!issue) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
    await enforceIssueScope(input.issueKey.toUpperCase(), actor);
  }
  let projectId = issue?.projectId;
  if (input.sessionId) {
    const s = await prisma.agentSession.findUnique({
      where: { id: input.sessionId },
      select: { agentUserId: true, status: true, issue: { select: { id: true, projectId: true, issueNumber: true, project: { select: { key: true } } } } },
    });
    if (!s) throw new JiraApiError(404, jiraError(['Agent session not found.']));
    if (s.agentUserId !== actor.user.id && !actor.user.isAdmin) {
      throw new JiraApiError(403, jiraError(['Only the session agent (or an admin) may attach receipts to a session.']));
    }
    issue = issue ?? s.issue;
    projectId = s.issue.projectId;
  }
  if (input.topicPostId) {
    const post = await prisma.townHallPost.findUnique({
      where: { id: BigInt(input.topicPostId) },
      select: { id: true, authorId: true, topic: { select: { projectId: true, channel: { select: { projectId: true } } } } },
    });
    if (!post) throw new JiraApiError(404, jiraError(['Town hall post not found.']));
    projectId = projectId ?? post.topic.projectId ?? post.topic.channel.projectId ?? undefined;
  }
  if (!projectId) throw new JiraApiError(400, jiraError([], { receipt: 'Provide issueKey, sessionId, or topicPostId.' }));
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { key: true } });
  if (!project || !projectAllowed(actor, project.key)) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }

  // 073 FR-001 — Honest SHA-256 verification over inline content or Attachment bytes.
  let resolvedSha: string;
  let baseVerification: 'digest_only' | 'hash_verified';
  let inlinePayload: { contentText: string; byteLength: number } | null = null;
  let resolvedContentType = input.contentType?.trim() || null;
  let verifiedAttachmentId: string | null = null;

  if (input.content !== undefined) {
    const buf = Buffer.from(input.content, 'utf8');
    if (buf.byteLength > MAX_INLINE_RECEIPT_BYTES) {
      throw new JiraApiError(
        400,
        jiraError([], {
          content: `Inline receipt content is ${buf.byteLength} bytes (max ${MAX_INLINE_RECEIPT_BYTES}). Upload via issue attachments and pass attachmentId.`,
        })
      );
    }
    const computed = createHash('sha256').update(buf).digest('hex');
    if (input.sha256 && input.sha256.toLowerCase() !== computed) {
      throw new JiraApiError(
        422,
        jiraError([], {
          sha256: `Computed digest ${computed} does not match declared ${input.sha256.toLowerCase()}.`,
        })
      );
    }
    resolvedSha = computed;
    baseVerification = 'hash_verified';
    inlinePayload = { contentText: input.content, byteLength: buf.byteLength };
    resolvedContentType = resolvedContentType ?? defaultContentType(input.kind);
  } else if (input.attachmentId) {
    const att = await prisma.attachment.findUnique({
      where: { id: input.attachmentId },
      select: { id: true, issueId: true, storagePath: true, mime: true, sniffedMime: true, issue: { select: { projectId: true } } },
    });
    if (!att || att.issue.projectId !== projectId || (issue && att.issueId !== issue.id)) {
      throw new JiraApiError(404, jiraError(['Attachment does not exist on this issue/project.']));
    }
    const buf = await getAttachmentStore().get(att.storagePath);
    const computed = createHash('sha256').update(buf).digest('hex');
    if (input.sha256 && input.sha256.toLowerCase() !== computed) {
      throw new JiraApiError(
        422,
        jiraError([], {
          sha256: `Computed attachment digest ${computed} does not match declared ${input.sha256.toLowerCase()}.`,
        })
      );
    }
    resolvedSha = computed;
    baseVerification = 'hash_verified';
    verifiedAttachmentId = att.id;
    resolvedContentType = resolvedContentType ?? att.sniffedMime ?? att.mime;
  } else {
    if (!input.sha256) {
      throw new JiraApiError(
        400,
        jiraError([], { sha256: 'Provide inline content, attachmentId, or a 64-char sha256 digest.' })
      );
    }
    resolvedSha = input.sha256.toLowerCase();
    baseVerification = 'digest_only';
  }

  const changedFiles = normalizeChangedFiles(input.changedFiles, input.metrics);
  const now = new Date();

  const receipt = await prisma.$transaction(async (tx) => {
    const r = await tx.workReceipt.create({
      data: {
        projectId,
        issueId: issue?.id ?? null,
        sessionId: input.sessionId ?? null,
        topicPostId: input.topicPostId ? BigInt(input.topicPostId) : null,
        authorId: actor.user.id,
        kind: input.kind,
        sha256: resolvedSha,
        gitCommitSha: input.gitCommitSha ?? null,
        gitBranch: input.gitBranch ?? null,
        summary: input.summary.slice(0, 2000),
        metricsJson: (input.metrics as never) ?? undefined,
        artifactUri: input.artifactUri ?? null,
        changedFiles,
        attachmentId: verifiedAttachmentId,
        contentType: resolvedContentType,
        verification: baseVerification,
        verifiedAt: baseVerification === 'hash_verified' ? now : null,
      },
    });
    if (inlinePayload) {
      await tx.workReceiptPayload.create({
        data: {
          receiptId: r.id,
          contentText: inlinePayload.contentText,
          byteLength: inlinePayload.byteLength,
        },
      });
    }
    // 073 FR-004 — Any new diff receipt on an issue supersedes prior approvals
    // whose pinned receipt set did not cover this artifact.
    if (issue && input.kind === 'diff') {
      await tx.deliverableReview.updateMany({
        where: { issueId: issue.id, verdict: 'approved', supersededAt: null },
        data: { supersededAt: now },
      });
    }
    if (issue) {
      await recordLedger(tx, {
        issueId: issue.id,
        actorId: actor.user.id,
        kind: baseVerification === 'hash_verified' ? 'receipt_verified' : 'receipt_submitted',
        summary: `${input.kind} receipt ${r.sha256.slice(0, 12)}… submitted (${baseVerification})`,
        payload: { kind: input.kind, sha256: r.sha256, gitCommitSha: r.gitCommitSha, changedFiles, verification: baseVerification },
        receiptId: r.id,
        sessionId: input.sessionId ?? null,
      });
    }
    await emitEvent(tx as never, actor, {
      type: 'work_receipt.submitted',
      projectId,
      issueId: issue?.id ?? null,
      payload: {
        issueKey: issue ? toIssueKey(issue.project.key, issue.issueNumber) : undefined,
        receiptId: r.id,
        kind: input.kind,
        verification: baseVerification,
      },
    });
    return r;
  });
  if (input.gitCommitSha) await corroborate(receipt.id, input.gitCommitSha, input.kind);
  const fresh = await prisma.workReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: receiptListInclude });
  return toReceiptView(fresh);
}

/** 073 FR-001 — Inspect a single WorkReceipt including inline diff/log text. */
export async function getReceipt(actor: Actor, receiptId: string) {
  const row = await prisma.workReceipt.findUnique({
    where: { id: receiptId },
    include: {
      ...receiptListInclude,
      project: { select: { id: true, key: true } },
      payload: { select: { contentText: true, byteLength: true } },
    },
  });
  if (!row) throw new JiraApiError(404, jiraError(['Work receipt not found.']));
  if (!projectAllowed(actor, row.project.key)) {
    throw new JiraApiError(404, jiraError(['Work receipt not found.']));
  }
  const issueKey = row.issue ? toIssueKey(row.issue.project.key, row.issue.issueNumber) : null;
  if (issueKey) await enforceIssueScope(issueKey, actor);
  if (!actor.user.isAdmin && !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: row.project.id }))) {
    throw new JiraApiError(404, jiraError(['Work receipt not found.']));
  }
  return {
    ...toReceiptView(row),
    content: row.payload?.contentText ?? null,
  };
}

export async function listIssueReceipts(actor: Actor, issueKey: string) {
  const { projectKey, issueNumber } = await parseIssueKey(issueKey.toUpperCase());
  const issue = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    select: { id: true, projectId: true },
  });
  if (!issue) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  await enforceIssueScope(issueKey.toUpperCase(), actor);
  if (!actor.user.isAdmin && !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: issue.projectId }))) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }
  const rows = await prisma.workReceipt.findMany({
    where: { issueId: issue.id },
    orderBy: { createdAt: 'asc' },
    include: receiptListInclude,
  });
  return { receipts: rows.map(toReceiptView) };
}

/** FR-006 gate helper — does the issue hold a receipt of one of `kinds` at
 *  >= `minTier` verification? Returns the missing requirement on failure. */
export async function issueReceiptGate(
  issueId: string,
  kinds: string[],
  minTier: string
): Promise<{ ok: true } | { ok: false; missing: string }> {
  const tiers = VERIFICATION_TIERS.slice(tierRank(minTier));
  const hit = await prisma.workReceipt.findFirst({
    where: { issueId, kind: { in: kinds }, verification: { in: [...tiers] } },
    select: { id: true },
  });
  return hit
    ? { ok: true }
    : {
        ok: false,
        missing: `Requires a ${kinds.join('|')} receipt at '${minTier}' verification or higher (include inline 'content' or 'attachmentId' so TrackForge can hash-verify the artifact).`,
      };
}

/** FR-006 town-hall gate — ≥1 evidence post on the topic must carry a
 *  verified (hash_verified+) receipt for requiredRoles endorsements to count. */
export async function topicHasReceiptBackedEvidence(topicId: string): Promise<boolean> {
  const hit = await prisma.workReceipt.findFirst({
    where: {
      verification: { in: [...VERIFICATION_TIERS.slice(1)] },
      topicPost: { topicId, speechAct: 'evidence' },
    },
    select: { id: true },
  });
  return Boolean(hit);
}

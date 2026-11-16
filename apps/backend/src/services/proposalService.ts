// Proposal lifecycle (US2): create on gated writes (validated via the same
// dry-run path the copilot uses), review in the Approvals inbox, approve →
// re-validated replay as the original principal (approvedBy recorded in the
// changelog), reject/expire → proposal_resolved event + principal notification.

import type { Request } from 'express';
import type { Actor } from '../lib/auth.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { internalRequest } from '../lib/internalRequest.js';
import { pathWithFreshConfirmToken } from '../lib/confirmToken.js';
import { parseIssueKeyParts } from '../lib/issueKey.js';
import { emitEvent } from './eventService.js';
import { hasPermission } from './permissionService.js';
import type { Prisma } from '../lib/pc.js';

const EXPIRY_DAYS = 7;

/** Paths where `?dryRun=true` is honoured — safe to pre-validate via replay.
 *  Includes the 052 dryRun surfaces (comment/bulk/link/watch/rank + worklog,
 *  archive/restore) so their proposals store a validated diff, not a raw body. */
const PREVIEWABLE: RegExp[] = [
  /^POST \/rest\/api\/2\/issue\/?$/,
  /^POST \/rest\/api\/2\/issue\/bulk\/?$/,
  /^PUT \/rest\/api\/2\/issue\/[^/?]+$/,
  /^PUT \/rest\/api\/2\/issue\/[^/?]+\/(assignee|archive|restore)$/,
  /^POST \/rest\/api\/2\/issue\/[^/?]+\/(transitions|comment|watchers|worklog)$/,
  /^DELETE \/rest\/api\/2\/issue\/[^/?]+$/,
  /^POST \/rest\/api\/2\/issueLink\/?$/,
  /^PUT \/rest\/agile\/1\.0\/issue\/rank\/?$/,
];

/** 053 US4 — internal routes that honour dryRun in the BODY. Preview replays
 *  inject {dryRun:true} into the stored body — a ?dryRun query flag would be
 *  ignored by these schemas and EXECUTE the write for real. */
const PREVIEWABLE_BODY_DRYRUN: RegExp[] = [
  /^POST \/api\/internal\/bulk\/(edit|transition|move|delete|comment|watch|link)$/,
  /^POST \/api\/internal\/issues\/[^/?]+\/(move|clone)$/,
];

const ISSUE_KEY = /\/issues?\/([A-Z][A-Z0-9]*-\d+)/;

function ch(actor: Actor): 'api' | 'mcp' | 'copilot' | 'automation' {
  // smartcommit never reaches proposal replay (no token writes) — map to 'api' if seen.
  return actor.channel === 'ui' || actor.channel === 'smartcommit' ? 'api' : actor.channel;
}

/** Derive issue/project linkage from the request path + body where possible. */
async function deriveLinkage(method: string, path: string, body: unknown) {
  const m = ISSUE_KEY.exec(path);
  let issueId: string | null = null;
  let projectId: string | null = null;
  if (m) {
    const [pk, num] = [m[1]!.split('-')[0]!, Number(m[1]!.split('-')[1])];
    const found = await prisma.issue.findFirst({
      where: { issueNumber: num, project: { key: pk } },
      select: { id: true, projectId: true },
    });
    issueId = found?.id ?? null;
    projectId = found?.projectId ?? null;
  }
  // issueLink bodies carry the keys — anchor the proposal on the outward
  // (source) issue so it surfaces on that issue's review panel.
  if (!issueId && body && typeof body === 'object') {
    const linkKey = (body as { outwardIssue?: { key?: string } }).outwardIssue?.key;
    const parts = linkKey ? parseIssueKeyParts(linkKey) : null;
    if (parts) {
      const found = await prisma.issue.findFirst({
        where: { issueNumber: parts.issueNumber, project: { key: parts.projectKey } },
        select: { id: true, projectId: true },
      });
      issueId = found?.id ?? null;
      projectId = found?.projectId ?? null;
    }
  }
  if (!projectId && body && typeof body === 'object') {
    const key = (body as { fields?: { project?: { key?: string } } }).fields?.project?.key;
    if (key) {
      const p = await prisma.project.findUnique({ where: { key: key.toUpperCase() }, select: { id: true } });
      projectId = p?.id ?? null;
    }
  }
  return { issueId, projectId, issueKey: m?.[1] ?? null };
}

export async function createProposal(actor: Actor, req: Request) {
  const method = req.method;
  const path = req.originalUrl;
  const basePath = path.split('?')[0]!;
  const body = req.body ?? {};

  const previewable = PREVIEWABLE.some((re) => re.test(`${method} ${basePath}`));
  const bodyDryRun = PREVIEWABLE_BODY_DRYRUN.some((re) => re.test(`${method} ${basePath}`));
  const { issueId, projectId, issueKey } = await deriveLinkage(method, path, body);

  // Issues referenced by path must exist and be inside the token's scope —
  // the real route would 404 the same way.
  if (ISSUE_KEY.test(path) && !issueId) {
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }

  let diff: Prisma.InputJsonValue | undefined;
  if (previewable || bodyDryRun) {
    // 065 audit B3 — preview runs as the caller's token, not a bare session.
    const { status, body: preview } = bodyDryRun
      ? await internalRequest<Record<string, unknown>>(
          { userId: actor.user.id, tokenId: actor.token?.id, channel: ch(actor) },
          method,
          path,
          { ...(typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}), dryRun: true }
        )
      : await internalRequest<Record<string, unknown>>(
          { userId: actor.user.id, tokenId: actor.token?.id, channel: ch(actor) },
          method,
          `${path}${path.includes('?') ? '&' : '?'}dryRun=true`,
          body
        );
    if (status >= 400) {
      const err = preview as { errorMessages?: string[]; errors?: Record<string, string> };
      throw new JiraApiError(status, {
        errorMessages: err.errorMessages ?? ['Validation failed.'],
        errors: err.errors ?? {},
      });
    }
    diff = preview as Prisma.InputJsonValue;
  }

  const proposal = await prisma.proposal.create({
    data: {
      principalId: actor.user.id,
      tokenId: actor.token?.id ?? null,
      projectId,
      issueId,
      method,
      path,
      body: body as Prisma.InputJsonValue,
      channel: ch(actor),
      diff,
      rationale: (req.headers['x-trackforge-rationale'] as string | undefined)?.slice(0, 2000) ?? null,
      expiresAt: new Date(Date.now() + EXPIRY_DAYS * 86_400_000),
    },
  });

  // Notify the project lead (and the issue reporter) that review is needed.
  const notifyIds = new Set<string>();
  if (projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { leadId: true } });
    if (p?.leadId) notifyIds.add(p.leadId);
  }
  if (issueId) {
    const i = await prisma.issue.findUnique({ where: { id: issueId }, select: { reporterId: true, assigneeId: true } });
    if (i?.reporterId) notifyIds.add(i.reporterId);
    if (i?.assigneeId) notifyIds.add(i.assigneeId);
  }
  notifyIds.delete(actor.user.id);
  const ev = await emitEvent(
    prisma,
    { user: { id: actor.user.id, displayName: actor.user.displayName, type: actor.user.type }, channel: ch(actor) },
    {
      type: 'proposal_created',
      projectId,
      issueId,
      payload: {
        proposalId: proposal.id,
        method,
        path: basePath,
        issueKey: issueKey ?? undefined,
        principal: actor.user.displayName,
      },
    }
  );
  for (const uid of notifyIds) {
    await prisma.notification
      .create({
        data: { userId: uid, eventId: ev.id, issueId, reason: 'proposal_pending' },
      })
      .catch(() => undefined);
  }
  return proposal;
}

// ---------- review ----------

export function canReview(actor: Actor): boolean {
  return !actor.token; // humans only — tokens never approve proposals
}

/**
 * 065 audit B2 — review is a privileged act: the replay executes as the
 * proposing principal (possibly an admin's gated token), so the reviewer must
 * hold ADMINISTER_PROJECTS on the proposal's project. Site admins always
 * review; proposals with no project are admin-only.
 */
async function canReviewProposal(actor: Actor, p: { projectId: string | null }): Promise<boolean> {
  if (actor.token) return false;
  if (actor.user.isAdmin) return true;
  if (!p.projectId) return false;
  return hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId: p.projectId });
}

/** Projects where the actor may review proposals (empty for tokens/admins' fast paths). */
async function reviewableProjectIds(actor: Actor): Promise<string[]> {
  const projects = await prisma.project.findMany({ select: { id: true } });
  const ids: string[] = [];
  for (const p of projects) {
    if (await hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId: p.id })) ids.push(p.id);
  }
  return ids;
}

export async function listProposals(actor: Actor, opts: { status?: string; projectKey?: string; issueKey?: string }) {
  // 065 audit B2 — non-admin humans see their own proposals plus those in
  // projects they administer; they may not browse the whole pending queue.
  const visible: Prisma.ProposalWhereInput[] | undefined = actor.token
    ? [{ principalId: actor.user.id }]
    : actor.user.isAdmin
      ? undefined
      : [{ principalId: actor.user.id }, { projectId: { in: await reviewableProjectIds(actor) } }];
  const issueParts = opts.issueKey ? parseIssueKeyParts(opts.issueKey) : null;
  const where: Prisma.ProposalWhereInput = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.projectKey ? { project: { key: opts.projectKey.toUpperCase() } } : {}),
    ...(issueParts
      ? { issue: { issueNumber: issueParts.issueNumber, project: { key: issueParts.projectKey } } }
      : {}),
    ...(visible ? { OR: visible } : {}),
  };
  return prisma.proposal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      principal: { select: { id: true, displayName: true, type: true } },
      resolvedBy: { select: { id: true, displayName: true } },
      project: { select: { key: true, name: true } },
      issue: {
        select: {
          id: true,
          issueNumber: true,
          summary: true,
          project: { select: { key: true } },
          status: { select: { category: true } },
        },
      },
      token: { select: { id: true, revokedAt: true, name: true } },
    },
  });
}

export async function getProposal(actor: Actor, id: string) {
  const p = await prisma.proposal.findUnique({
    where: { id },
    include: {
      principal: { select: { id: true, displayName: true, type: true } },
      resolvedBy: { select: { id: true, displayName: true } },
      project: { select: { key: true, name: true } },
      issue: {
        select: {
          id: true,
          issueNumber: true,
          summary: true,
          project: { select: { key: true } },
          status: { select: { category: true } },
        },
      },
      token: { select: { id: true, revokedAt: true, name: true } },
    },
  });
  // 065 audit B2 — existence-hiding: only the principal or a reviewer on the
  // proposal's project may read a proposal (body + diff can leak issue data).
  if (!p || (p.principalId !== actor.user.id && !(await canReviewProposal(actor, p)))) {
    throw new JiraApiError(404, jiraError(['Proposal not found.']));
  }
  return p;
}

function issueKeyOf(p: { issue?: { issueNumber: number; project: { key: string } } | null }): string | null {
  return p.issue ? `${p.issue.project.key}-${p.issue.issueNumber}` : null;
}

/** Replay the stored (or approver-edited) request as the principal; returns status+body. */
async function replay(
  proposal: {
    id: string;
    principalId: string;
    method: string;
    path: string;
    body: unknown;
    channel: string;
    tokenId?: string | null;
    editedBody?: unknown;
    appliedWithEdits?: boolean;
  },
  approvedById: string
) {
  const { method } = proposal;
  let { path } = proposal;

  // Deletes require a fresh confirmToken (stored ones may be stale/expired).
  if (method === 'DELETE' && /^\/rest\/api\/2\/issue\/[^/?]+/.test(path)) {
    path = await pathWithFreshConfirmToken(
      {
        userId: proposal.principalId,
        tokenId: proposal.tokenId ?? undefined,
        channel: proposal.channel as 'api' | 'mcp',
        bypassApproval: true,
        approvedById,
      },
      path
    );
  }

  // 065 audit B3 — replay as the recorded token so an approved write keeps the
  // principal's project scope (approval widens nothing).
  return internalRequest<Record<string, unknown>>(
    {
      userId: proposal.principalId,
      tokenId: proposal.tokenId ?? undefined,
      channel: proposal.channel as 'api' | 'mcp',
      bypassApproval: true,
      approvedById,
    },
    method,
    path,
    proposal.appliedWithEdits && proposal.editedBody != null ? proposal.editedBody : proposal.body
  );
}

async function resolveProposal(
  id: string,
  actor: Actor,
  outcome: 'approved' | 'rejected' | 'expired' | 'failed',
  opts: { reason?: string; result?: unknown; createdAt?: Date }
) {
  // 047 US5-4 — verification-cost metric: wall time from park to decision.
  const tta = opts.createdAt ? Math.max(0, Math.round((Date.now() - opts.createdAt.getTime()) / 1000)) : null;
  const p = await prisma.proposal.update({
    where: { id },
    data: {
      status: outcome,
      resolvedById: outcome === 'expired' ? null : actor.user.id,
      resolvedAt: new Date(),
      timeToApproveSec: tta,
      reason: opts.reason ?? null,
      result: (opts.result ?? undefined) as Prisma.InputJsonValue | undefined,
    },
    include: { issue: { select: { issueNumber: true, project: { select: { key: true } } } } },
  });
  const issueKey = issueKeyOf(p);
  const ev = await emitEvent(
    prisma,
    { user: { id: actor.user.id, displayName: actor.user.displayName, type: actor.user.type }, channel: 'api' },
    {
      type: 'proposal_resolved',
      projectId: p.projectId,
      issueId: p.issueId,
      payload: {
        proposalId: p.id,
        status: outcome,
        reason: opts.reason ?? null,
        method: p.method,
        path: p.path.split('?')[0],
        issueKey: issueKey ?? undefined,
      },
    }
  );
  // The proposing agent learns the outcome.
  await prisma.notification
    .create({
      data: { userId: p.principalId, eventId: ev.id, issueId: p.issueId, reason: 'proposal_resolved' },
    })
    .catch(() => undefined);
  return p;
}

// 047 US4 / SC-004 — approve-with-edits: the approver supplies a replacement
// request body; it's replayed through the real route (so it is re-validated
// and authorized identically to the original), attributed to the principal
// with appliedWithEdits + resolvedBy recorded.
export async function approveProposal(id: string, actor: Actor, edits?: Record<string, unknown>) {
  const p = await getProposal(actor, id);
  // 065 audit B2 — reviewer must administer the proposal's project (tokens and
  // ordinary users can't), and self-approval is never allowed: the point of
  // the gate is a second pair of eyes.
  if (!(await canReviewProposal(actor, p))) {
    throw new JiraApiError(403, jiraError(['You do not have permission to review proposals for this project.']));
  }
  if (p.principalId === actor.user.id) {
    throw new JiraApiError(403, jiraError(['You cannot approve your own proposal.']));
  }
  if (p.status !== 'pending') throw new JiraApiError(400, jiraError([`Proposal is already ${p.status}.`]));
  if (p.expiresAt < new Date()) {
    await resolveProposal(id, actor, 'expired', { createdAt: p.createdAt });
    throw new JiraApiError(400, jiraError(['Proposal has expired — ask the agent to re-propose.']));
  }

  if (edits !== undefined) {
    await prisma.proposal.update({
      where: { id },
      data: { editedBody: edits as Prisma.InputJsonValue, appliedWithEdits: true },
    });
  }
  const effective = edits !== undefined ? { ...p, editedBody: edits, appliedWithEdits: true } : p;

  const { status, body } = await replay(effective, actor.user.id);
  if (status < 400) {
    await resolveProposal(id, actor, 'approved', { result: body, createdAt: p.createdAt });
    // 047 US5-4 — accept/edited outcome on the reviewer's verification cost.
    const { recordOutcome } = await import('../lib/ai.js');
    await recordOutcome(actor.user.id, 'review', edits !== undefined ? 'edited' : 'accepted').catch(() => undefined);
    return { status: 'approved' as const, result: body };
  }
  const err = body as { errorMessages?: string[]; errors?: Record<string, string> };
  const msg =
    err.errorMessages?.join('; ') || Object.values(err.errors ?? {}).join('; ') || `Request failed (${status})`;
  await resolveProposal(id, actor, 'failed', {
    reason: `Stale or invalid at approval: ${msg} — ask the agent to re-propose.`,
    result: body,
    createdAt: p.createdAt,
  });
  throw new JiraApiError(
    status,
    jiraError([`Proposal is stale — the target changed since it was created (${msg}). Ask the agent to re-propose.`])
  );
}

export async function rejectProposal(id: string, actor: Actor, reason?: string) {
  const p = await getProposal(actor, id);
  if (actor.token) throw new JiraApiError(403, jiraError(['Tokens cannot reject proposals.']));
  // A human principal may reject (cancel) their own proposal; anyone else
  // must be a reviewer on the proposal's project.
  if (p.principalId !== actor.user.id && !(await canReviewProposal(actor, p))) {
    throw new JiraApiError(403, jiraError(['You do not have permission to review proposals for this project.']));
  }
  if (p.status !== 'pending') throw new JiraApiError(400, jiraError([`Proposal is already ${p.status}.`]));
  await resolveProposal(id, actor, 'rejected', { reason, createdAt: p.createdAt });
  const { recordOutcome } = await import('../lib/ai.js');
  await recordOutcome(actor.user.id, 'review', 'discarded').catch(() => undefined);
  return { status: 'rejected' as const };
}

export async function bulkResolve(ids: string[], action: 'approve' | 'reject', actor: Actor, reason?: string) {
  const results: { id: string; status: string; error?: string }[] = [];
  for (const id of ids) {
    try {
      if (action === 'approve') {
        await approveProposal(id, actor);
        results.push({ id, status: 'approved' });
      } else {
        await rejectProposal(id, actor, reason);
        results.push({ id, status: 'rejected' });
      }
    } catch (e) {
      results.push({
        id,
        status: 'error',
        error: e instanceof JiraApiError ? e.response.errorMessages.join('; ') : String(e),
      });
    }
  }
  return results;
}

/** Hourly job — pending proposals past expiresAt become 'expired' + event. */
export async function expireProposals(): Promise<number> {
  const stale = await prisma.proposal.findMany({
    where: { status: 'pending', expiresAt: { lt: new Date() } },
    take: 200,
  });
  for (const p of stale) {
    await prisma.proposal.update({
      where: { id: p.id },
      data: { status: 'expired', resolvedAt: new Date() },
    });
    const ev = await emitEvent(prisma, null, {
      type: 'proposal_resolved',
      projectId: p.projectId,
      issueId: p.issueId,
      payload: { proposalId: p.id, status: 'expired', method: p.method, path: p.path.split('?')[0] },
    });
    await prisma.notification
      .create({
        data: { userId: p.principalId, eventId: ev.id, issueId: p.issueId, reason: 'proposal_resolved' },
      })
      .catch(() => undefined);
  }
  return stale.length;
}

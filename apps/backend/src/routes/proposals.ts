import { ps } from '../lib/validation.js';
import { qs } from '../lib/validation.js';
// /api/internal/proposals — Approvals inbox (US2). Humans (sessions) review;
// agents (tokens) can list/get only their own proposals.

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod/v3';
import {
  listProposals,
  getProposal,
  approveProposal,
  rejectProposal,
  bulkResolve,
} from '../services/proposalService.js';
import { jiraError } from '../lib/errors.js';
import { toStatusCategory } from '../services/metaService.js';
import type { Prisma } from '../lib/pc.js';
import { ah } from '../lib/http.js';

export const proposalsRouter: RouterType = Router();

type LoadedProposal = Prisma.ProposalGetPayload<{
  include: {
    principal: { select: { id: true; displayName: true; type: true } };
    resolvedBy: { select: { id: true; displayName: true } };
    project: { select: { key: true; name: true } };
    issue: {
      select: {
        id: true;
        issueNumber: true;
        summary: true;
        project: { select: { key: true } };
        status: { select: { category: true } };
      };
    };
    token: { select: { id: true; revokedAt: true; name: true } };
  };
}>;

function toResponse(p: LoadedProposal) {
  return {
    id: p.id,
    status: p.status,
    method: p.method,
    path: p.path.split('?')[0],
    rationale: p.rationale,
    diff: p.diff,
    body: p.body,
    editedBody: p.editedBody,
    appliedWithEdits: p.appliedWithEdits,
    timeToApproveSec: p.timeToApproveSec,
    result: p.result,
    reason: p.reason,
    channel: p.channel,
    principal: {
      accountId: p.principal.id,
      displayName: p.principal.displayName,
      agent: p.principal.type === 'agent',
    },
    token: p.token ? { name: p.token.name, revoked: !!p.token.revokedAt } : null,
    project: p.project ? { key: p.project.key, name: p.project.name } : null,
    issue: p.issue
      ? {
          key: `${p.issue.project.key}-${p.issue.issueNumber}`,
          summary: p.issue.summary,
          statusCategory: toStatusCategory(p.issue.status.category).key,
        }
      : null,
    resolvedBy: p.resolvedBy ? { accountId: p.resolvedBy.id, displayName: p.resolvedBy.displayName } : null,
    resolvedAt: p.resolvedAt?.toISOString() ?? null,
    expiresAt: p.expiresAt.toISOString(),
    createdAt: p.createdAt.toISOString(),
  };
}

proposalsRouter.get(
  '/',
  ah(async (req: Request, res: Response) => {
    const status = qs(req.query.status) ? String(qs(req.query.status)) : undefined;
    const projectKey = qs(req.query.project) ? String(qs(req.query.project)) : undefined;
    const issueKey = qs(req.query.issue) ? String(qs(req.query.issue)) : undefined;
    const rows = await listProposals(req.actor!, { status, projectKey, issueKey });
    res.json({ proposals: rows.map(toResponse), total: rows.length });
  })
);

proposalsRouter.get(
  '/:id',
  ah(async (req: Request, res: Response) => {
    res.json(toResponse(await getProposal(req.actor!, ps(req.params.id))));
  })
);

// 047 US4 — optional `body` replaces the proposed request body (approve-with-
// edits). Re-validated by the real route on replay; appliedWithEdits recorded.
const approveSchema = z.object({ body: z.record(z.unknown()).optional() });

proposalsRouter.post(
  '/:id/approve',
  ah(async (req: Request, res: Response) => {
    const parsed = approveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(jiraError([], { body: 'Invalid edits.' }));
      return;
    }
    res.json(await approveProposal(ps(req.params.id), req.actor!, parsed.data.body));
  })
);

const rejectSchema = z.object({ reason: z.string().max(1000).optional() });

proposalsRouter.post(
  '/:id/reject',
  ah(async (req: Request, res: Response) => {
    const parsed = rejectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(jiraError([], { reason: 'Invalid reason.' }));
      return;
    }
    res.json(await rejectProposal(ps(req.params.id), req.actor!, parsed.data.reason));
  })
);

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(1000).optional(),
});

proposalsRouter.post(
  '/bulk',
  ah(async (req: Request, res: Response) => {
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], { ids: 'Provide 1–50 proposal ids and an action.' }));
      return;
    }
    res.json({ results: await bulkResolve(parsed.data.ids, parsed.data.action, req.actor!, parsed.data.reason) });
  })
);

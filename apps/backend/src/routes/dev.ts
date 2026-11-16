import { ps } from '../lib/validation.js';
// Sprint 038: signed dev-webhook receivers, repo admin, issue panel data.
import { Router, type Router as RouterType } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import { requireAuth, requireAdmin, enforceIssueScope } from '../middleware/auth.js';
import { requireIssuePermission } from '../services/permissionService.js';
import { getIssueByKey } from '../services/issueService.js';
import { ingest, panelData, ingestGitlabSigned, ingestDevinfoBulk, reprocessDelivery } from '../services/devService.js';
import type { DevinfoRepository } from '../services/devService.js';
import {
  extras,
  testConnection,
  pollSync,
  createBranch,
  createMergeRequest,
  branchNameFor,
} from '../services/gitlabService.js';
import { getDurableRunner } from '../lib/jobs.js';
import { audit } from '../services/auditService.js';
import { encryptSecret } from '../lib/ai.js';
import type { Request } from 'express';
import { ah } from '../lib/http.js';

// ---------- public signed receivers (raw body for HMAC) ----------
export const devReceiverRouter: RouterType = Router();

// 065 audit D5/D7 — constrain provider so admin paths under /api/internal/dev
// (gitlab/connections, repositories/:id) are not shadowed by this catch-all,
// and read Bitbucket's actual signature header (X-Hub-Signature).
devReceiverRouter.post(
  '/:repoId/:provider',
  express.text({ type: '*/*', limit: '1mb' }),
  ah(async (req, res, next) => {
    const provider = ps(req.params.provider);
    // path-to-regexp v8 dropped inline param regexes — the allowlist gate
    // keeps the same fall-through semantics for admin paths.
    if (provider !== 'github' && provider !== 'gitlab' && provider !== 'bitbucket') return next();
    const sig =
      req.headers['x-hub-signature-256'] ??
      req.headers['x-gitlab-token'] ??
      req.headers['x-hub-signature'] ??
      req.headers['x-hook-signature'];
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    // 051: GitLab ≥16 can sign with a token; delivery UUID dedupes floods.
    const eventUuid = String(req.headers['x-gitlab-event-uuid'] ?? '');
    const result =
      provider === 'gitlab'
        ? await ingestGitlabSigned(ps(req.params.repoId), String(sig ?? ''), raw, eventUuid)
        : await ingest(ps(req.params.repoId), provider, raw, String(sig ?? ''));
    res.status(202).json(result); // queued semantics — items already persisted
  })
);

// ---------- admin repo CRUD ----------
export const devAdminRouter: RouterType = Router();
devAdminRouter.use(requireAuth, requireAdmin);

const repoSchema = z.object({
  name: z.string().min(1).max(120),
  provider: z.enum(['github', 'gitlab', 'bitbucket']),
  baseUrl: z.string().url(),
  webhookSecret: z.string().min(8),
  projectKeyMap: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
});

devAdminRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(
      await prisma.devRepository.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          provider: true,
          baseUrl: true,
          enabled: true,
          projectKeyMap: true,
          createdAt: true,
        },
      })
    );
  })
);

devAdminRouter.post(
  '/',
  ah(async (req, res) => {
    const parsed = repoSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const r = await prisma.devRepository.create({
      data: {
        ...parsed.data,
        webhookSecret: encryptSecret(parsed.data.webhookSecret),
        projectKeyMap: parsed.data.projectKeyMap ?? {},
      },
    });
    res.status(201).json({ ...r, webhookUrl: `/api/internal/dev/${r.id}/${r.provider}` });
  })
);

devAdminRouter.put(
  '/:id',
  ah(async (req, res) => {
    const parsed = repoSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const { webhookSecret, ...rest } = parsed.data;
    const r = await prisma.devRepository.update({
      where: { id: ps(req.params.id) },
      data: {
        ...rest,
        ...(webhookSecret ? { webhookSecret: encryptSecret(webhookSecret) } : {}),
      },
    });
    res.json(r);
  })
);

devAdminRouter.delete(
  '/:id',
  ah(async (req, res) => {
    await prisma.devRepository.delete({ where: { id: ps(req.params.id) } });
    res.status(204).end();
  })
);

devAdminRouter.get(
  '/:id/deliveries',
  ah(async (req, res) => {
    res.json(
      await prisma.devDelivery.findMany({
        where: { repoId: ps(req.params.id) },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, deliveryId: true, status: true, error: true, createdAt: true },
      })
    );
  })
);

// 038 leftover: re-run a stored delivery payload (re-link after late issue creation).
devAdminRouter.post(
  '/:id/deliveries/:deliveryId/reprocess',
  ah(async (req, res) => {
    const d = await prisma.devDelivery.findUnique({ where: { id: ps(req.params.deliveryId) } });
    if (!d || d.repoId !== ps(req.params.id)) throw new JiraApiError(404, jiraError(['Delivery not found.']));
    const out = await reprocessDelivery(d.id);
    await audit(req, 'dev.delivery.reprocess', 'DevRepository', d.repoId, { deliveryId: d.deliveryId, ...out });
    res.json(out);
  })
);

devAdminRouter.get(
  '/:id/unlinked',
  ah(async (req, res) => {
    res.json(
      await prisma.developmentItem.findMany({
        where: { repoId: ps(req.params.id), issues: { none: {} } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, type: true, title: true, state: true, createdAt: true },
      })
    );
  })
);

// ---------- issue panel ----------
export const devIssueRouter: RouterType = Router();
// Jira VIEW_DEV_TOOLS: the development panel requires BROWSE + the dedicated
// permission (grants live on the project's permission scheme).
async function requireDevTools(key: string, req: Request) {
  await enforceIssueScope(key.toUpperCase(), req.actor!);
  const issue = await getIssueByKey(key.toUpperCase());
  await requireIssuePermission(req.actor!, 'VIEW_DEV_TOOLS', issue);
  return issue;
}

devIssueRouter.get(
  '/:key/development',
  requireAuth,
  ah(async (req, res) => {
    await requireDevTools(ps(req.params.key), req);
    res.json(await panelData(ps(req.params.key)));
  })
);

// ---------- 051: outbound actions (panel + MCP share this path, A1) ----------
const pickGitlabRepo = async (connectionId?: string) => {
  // 065 audit D5 — a caller-chosen connectionId must still be an *enabled*
  // GitLab repo; findUnique let a disabled (or non-GitLab) row be used.
  const repo = connectionId
    ? await prisma.devRepository.findFirst({ where: { id: connectionId, provider: 'gitlab', enabled: true } })
    : await prisma.devRepository.findFirst({ where: { provider: 'gitlab', enabled: true } });
  if (!repo) throw new JiraApiError(404, jiraError(['No enabled GitLab connection.']));
  return repo;
};

devIssueRouter.post(
  '/:key/gitlab/branch',
  requireAuth,
  ah(async (req, res) => {
    const parsed = z
      .object({
        name: z.string().max(200).optional(),
        ref: z.string().min(1).max(200),
        connectionId: z.string().optional(),
        dryRun: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const issue = await requireDevTools(ps(req.params.key), req);
    const repo = await pickGitlabRepo(parsed.data.connectionId);
    const name = parsed.data.name ?? branchNameFor(ps(req.params.key), issue.summary ?? 'branch');
    if (parsed.data.dryRun) return res.json({ dryRun: true, name, ref: parsed.data.ref, connectionId: repo.id });
    const out = await createBranch(repo.id, { name, ref: parsed.data.ref, issueKey: ps(req.params.key) });
    await audit(req, 'gitlab.branch.create', 'DevRepository', repo.id, {
      issueKey: ps(req.params.key),
      name,
      ref: parsed.data.ref,
    });
    res.status(201).json({ ...out, connectionId: repo.id });
  })
);

devIssueRouter.post(
  '/:key/gitlab/merge-request',
  requireAuth,
  ah(async (req, res) => {
    const parsed = z
      .object({
        sourceBranch: z.string().min(1).max(200),
        targetBranch: z.string().min(1).max(200),
        title: z.string().max(300).optional(),
        connectionId: z.string().optional(),
        dryRun: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const issue = await requireDevTools(ps(req.params.key), req);
    const repo = await pickGitlabRepo(parsed.data.connectionId);
    const title = parsed.data.title ?? `${ps(req.params.key)} ${issue.summary ?? ''}`.trim();
    if (parsed.data.dryRun) return res.json({ dryRun: true, title, ...parsed.data, connectionId: repo.id });
    const out = await createMergeRequest(repo.id, { ...parsed.data, title, issueKey: ps(req.params.key) });
    await audit(req, 'gitlab.mr.create', 'DevRepository', repo.id, { issueKey: ps(req.params.key), title, ...parsed.data });
    res.status(201).json({ ...out, title, connectionId: repo.id });
  })
);

// ---------- 051: GitLab connections (admin) ----------
export const devGitlabRouter: RouterType = Router();
devGitlabRouter.use(requireAuth, requireAdmin);

const gitlabConnSchema = z.object({
  name: z.string().min(1).max(120),
  baseUrl: z.string().url(),
  apiTokenRef: z.string().regex(/^env:[A-Z0-9_]+$/i, 'apiTokenRef must be env:VAR'),
  groupPath: z.string().max(300).optional(),
  projectIds: z.array(z.number().int()).optional(),
  mode: z.enum(['webhook', 'poll', 'both']).optional(),
  verifySsl: z.boolean().optional(),
  webhookSecret: z.string().min(8).optional(),
  signingToken: z.string().min(8).optional(),
  enabled: z.boolean().optional(),
});

const gitlabView = (r: {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  gitlab: unknown;
  projectKeyMap: unknown;
  createdAt: Date;
}) => {
  const x = extras(r);
  return {
    id: r.id,
    name: r.name,
    baseUrl: r.baseUrl,
    enabled: r.enabled,
    mode: x.mode ?? 'webhook',
    groupPath: x.groupPath,
    projectIds: x.projectIds,
    apiTokenRef: x.apiTokenRef,
    verifySsl: x.verifySsl !== false,
    hasWebhookSecret: true,
    hasSigningToken: Boolean(x.signingToken),
    syncCursor: x.syncCursor,
    backfill: x.backfill,
    lastTestAt: x.lastTestAt,
    lastError: x.lastError,
    webhookUrl: `/api/internal/dev/${r.id}/gitlab`,
    createdAt: r.createdAt,
  };
};

devGitlabRouter.get(
  '/',
  ah(async (_req, res) => {
    const rows = await prisma.devRepository.findMany({ where: { provider: 'gitlab' }, orderBy: { createdAt: 'desc' } });
    res.json({ connections: rows.map(gitlabView) });
  })
);

devGitlabRouter.post(
  '/',
  ah(async (req, res) => {
    const parsed = gitlabConnSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const { apiTokenRef, groupPath, projectIds, mode, verifySsl, signingToken, webhookSecret, ...rest } = parsed.data;
    // 065 F3 — generated/supplied secrets encrypt at rest; the generated one is
    // returned once from the local plaintext (the stored value is ciphertext).
    const plainSecret = webhookSecret ?? crypto.randomBytes(24).toString('hex');
    const r = await prisma.devRepository.create({
      data: {
        ...rest,
        provider: 'gitlab',
        webhookSecret: encryptSecret(plainSecret),
        gitlab: {
          apiTokenRef,
          groupPath,
          projectIds,
          mode: mode ?? 'webhook',
          verifySsl: verifySsl ?? true,
          signingToken,
        },
      },
    });
    await audit(req, 'gitlab.connection.create', 'DevRepository', r.id, { name: r.name, baseUrl: r.baseUrl });
    res.status(201).json({ ...gitlabView(r), webhookSecret: webhookSecret ? undefined : plainSecret });
  })
);

devGitlabRouter.put(
  '/:id',
  ah(async (req, res) => {
    const parsed = gitlabConnSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const existing = await prisma.devRepository.findUnique({ where: { id: ps(req.params.id) } });
    if (!existing || existing.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['Connection not found.']));
    const { apiTokenRef, groupPath, projectIds, mode, verifySsl, signingToken, webhookSecret, ...rest } = parsed.data;
    const cur = extras(existing);
    const r = await prisma.devRepository.update({
      where: { id: ps(req.params.id) },
      data: {
        ...rest,
        ...(webhookSecret ? { webhookSecret: encryptSecret(webhookSecret) } : {}),
        gitlab: {
          ...cur,
          ...(apiTokenRef ? { apiTokenRef } : {}),
          ...(groupPath !== undefined ? { groupPath } : {}),
          ...(projectIds !== undefined ? { projectIds } : {}),
          ...(mode ? { mode } : {}),
          ...(verifySsl !== undefined ? { verifySsl } : {}),
          ...(signingToken !== undefined ? { signingToken } : {}),
        },
      },
    });
    await audit(req, 'gitlab.connection.update', 'DevRepository', r.id, { fields: Object.keys(parsed.data) });
    res.json(gitlabView(r));
  })
);

devGitlabRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const r = await prisma.devRepository.findUnique({ where: { id: ps(req.params.id) } });
    if (!r || r.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['Connection not found.']));
    await prisma.devRepository.delete({ where: { id: ps(req.params.id) } });
    await audit(req, 'gitlab.connection.delete', 'DevRepository', ps(req.params.id), { name: r.name });
    res.status(204).end();
  })
);

devGitlabRouter.post(
  '/:id/test',
  ah(async (req, res) => {
    const r = await prisma.devRepository.findUnique({ where: { id: ps(req.params.id) } });
    if (!r || r.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['Connection not found.']));
    try {
      const out = await testConnection(r);
      const cur = extras(r);
      await prisma.devRepository.update({
        where: { id: r.id },
        data: { gitlab: { ...cur, lastTestAt: new Date().toISOString(), lastError: undefined } },
      });
      res.json(out);
    } catch (e) {
      const cur = extras(r);
      await prisma.devRepository.update({
        where: { id: r.id },
        data: { gitlab: { ...cur, lastError: (e as Error).message } },
      });
      throw e;
    }
  })
);

devGitlabRouter.post(
  '/:id/backfill',
  ah(async (req, res) => {
    const r = await prisma.devRepository.findUnique({ where: { id: ps(req.params.id) } });
    if (!r || r.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['Connection not found.']));
    const job = await getDurableRunner().enqueue(
      'gitlab.backfill',
      { repoId: r.id },
      { key: `gitlab-backfill-${r.id}` }
    );
    res.status(202).json({ queued: Boolean(job), jobId: job?.id });
  })
);

devGitlabRouter.post(
  '/:id/sync',
  ah(async (req, res) => {
    const r = await prisma.devRepository.findUnique({ where: { id: ps(req.params.id) } });
    if (!r || r.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['Connection not found.']));
    res.json(await pollSync(r.id));
  })
);

devGitlabRouter.get(
  '/:id/status',
  ah(async (req, res) => {
    const r = await prisma.devRepository.findUnique({ where: { id: ps(req.params.id) } });
    if (!r || r.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['Connection not found.']));
    res.json(gitlabView(r));
  })
);

// ---------- 051: devinfo-compatible receiver (US3) ----------
// GitLab-for-Jira's own payload shape — Bearer PAT + write scope via /rest.
export const devinfoRouter: RouterType = Router();
// 064 US4 — devinfo writes (and the smart-commit text they carry) are
// site-admin only; arbitrary authenticated users must not inject dev items.
devinfoRouter.use(requireAdmin);

devinfoRouter.post(
  '/bulk',
  ah(async (req, res) => {
    res.status(202).json(await ingestDevinfoBulk(req.body as { repositories?: DevinfoRepository[] }));
  })
);

devinfoRouter.delete(
  '/repository/:id/:entityType/:entityId',
  ah(async (req, res) => {
    const repo = await prisma.devRepository.findFirst({
      where: { provider: 'gitlab', name: `devinfo-${ps(req.params.id)}` },
    });
    if (!repo) throw new JiraApiError(404, jiraError(['Repository not found.']));
    const typeMap: Record<string, string> = {
      branch: 'branch',
      commit: 'commit',
      pullrequest: 'pull_request',
      pullrequests: 'pull_request',
      build: 'build',
      pipeline: 'build',
      deployment: 'deployment',
      featureflag: 'feature_flag',
    };
    const type = typeMap[ps(req.params.entityType).toLowerCase()] ?? ps(req.params.entityType);
    const del = await prisma.developmentItem.deleteMany({
      where: { repoId: repo.id, type, externalId: ps(req.params.entityId) },
    });
    res.status(202).json({ deleted: del.count });
  })
);

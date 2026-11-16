import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import {
  statusSchema,
  prioritySchema,
  resolutionSchema,
  issueTypeSchema,
  issueLinkTypeSchema,
} from '../lib/validation.js';
import { requireAdmin } from '../middleware/auth.js';
import { audit } from '../services/auditService.js';
import { invalidateJqlCtxCache } from '../jql/ctxCache.js';
import type { z } from 'zod/v3';
import type { Prisma } from '@prisma/client';
import { ah } from '../lib/http.js';

/**
 * Sprint 021 — admin metadata CRUD. Mounted at /api/internal/metadata.
 * Jira exposes these vocabularies read-only on /rest/api/2/*; administration
 * is app-scoped in Jira Cloud, so CRUD lives on the internal surface.
 */
export const metadataRouter: RouterType = Router();

interface EntityCfg {
  model: 'status' | 'priority' | 'resolution' | 'issueType' | 'issueLinkType';
  schema: z.ZodTypeAny;
  shape: (row: any) => Record<string, unknown>;
  /** Returns a human error when the row is referenced, else null. */
  inUse?: (id: string) => Promise<string | null>;
}

const entities: Record<string, EntityCfg> = {
  statuses: {
    model: 'status',
    schema: statusSchema,
    shape: (s) => ({ id: s.id, name: s.name, category: s.category, sequence: s.sequence }),
    inUse: async (id) => {
      const [issues, wf, trans, cols] = await Promise.all([
        prisma.issue.count({ where: { statusId: id } }),
        prisma.workflowStatus.count({ where: { statusId: id } }),
        prisma.workflowTransition.count({ where: { OR: [{ fromStatusId: id }, { toStatusId: id }] } }),
        prisma.boardColumnStatus.count({ where: { statusId: id } }),
      ]);
      const refs = [
        issues && `${issues} issue(s)`,
        wf && `${wf} workflow(s)`,
        trans && `${trans} transition(s)`,
        cols && `${cols} board column(s)`,
      ].filter(Boolean);
      return refs.length ? `Status is in use by ${refs.join(', ')}.` : null;
    },
  },
  priorities: {
    model: 'priority',
    schema: prioritySchema,
    shape: (p) => ({ id: p.id, name: p.name, color: p.color ?? undefined, sequence: p.sequence }),
    inUse: async (id) => {
      const n = await prisma.issue.count({ where: { priorityId: id } });
      return n ? `Priority is in use by ${n} issue(s).` : null;
    },
  },
  resolutions: {
    model: 'resolution',
    schema: resolutionSchema,
    shape: (r) => ({ id: r.id, name: r.name, description: r.description ?? undefined, sequence: r.sequence }),
    inUse: async (id) => {
      const n = await prisma.issue.count({ where: { resolutionId: id } });
      return n ? `Resolution is in use by ${n} issue(s).` : null;
    },
  },
  issuetypes: {
    model: 'issueType',
    schema: issueTypeSchema,
    shape: (t) => ({
      id: t.id,
      name: t.name,
      description: t.description ?? undefined,
      subtask: t.isSubtask,
      hierarchyLevel: t.hierarchyLevel,
    }),
    inUse: async (id) => {
      const n = await prisma.issue.count({ where: { issueTypeId: id } });
      return n ? `Issue type is in use by ${n} issue(s).` : null;
    },
  },
  issuelinktypes: {
    model: 'issueLinkType',
    schema: issueLinkTypeSchema,
    shape: (t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward }),
    // Jira allows link-type delete (links drop) — caller gets a count warning.
  },
};

const delegate = (model: EntityCfg['model']) =>
  (prisma as any)[model] as {
    findMany: (a?: any) => Promise<any[]>;
    findUnique: (a: any) => Promise<any>;
    create: (a: any) => Promise<any>;
    update: (a: any) => Promise<any>;
    delete: (a: any) => Promise<any>;
  };

metadataRouter.get(
  '/:entity',
  requireAdmin,
  ah(async (req, res) => {
    const cfg = entities[ps(req.params.entity)];
    if (!cfg) throw new JiraApiError(404, jiraError(['Unknown metadata entity.']));
    const rows = await delegate(cfg.model).findMany({ orderBy: { name: 'asc' } });
    res.json(rows.map(cfg.shape));
  })
);

metadataRouter.post(
  '/:entity',
  requireAdmin,
  ah(async (req, res) => {
    const cfg = entities[ps(req.params.entity)];
    if (!cfg) throw new JiraApiError(404, jiraError(['Unknown metadata entity.']));
    const parsed = cfg.schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const data = parsed.data as Record<string, unknown>;
    const row = await delegate(cfg.model)
      .create({ data: data as Prisma.InputJsonValue as any })
      .catch((e: any) => {
        if (e?.code === 'P2002') {
          throw new JiraApiError(400, jiraError([], { name: 'An item with that name already exists.' }));
        }
        throw e;
      });
    invalidateJqlCtxCache();
    await audit(req, `metadata.${ps(req.params.entity)}.created`, 'metadata', row.id, { name: (data as any).name });
    res.status(201).json(cfg.shape(row));
  })
);

metadataRouter.put(
  '/:entity/:id',
  requireAdmin,
  ah(async (req, res) => {
    const cfg = entities[ps(req.params.entity)];
    if (!cfg) throw new JiraApiError(404, jiraError(['Unknown metadata entity.']));
    const parsed = (cfg.schema as z.AnyZodObject).partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const row = await delegate(cfg.model)
      .update({ where: { id: ps(req.params.id) }, data: parsed.data })
      .catch((e: any) => {
        if (e?.code === 'P2002') {
          throw new JiraApiError(400, jiraError([], { name: 'An item with that name already exists.' }));
        }
        if (e?.code === 'P2025') throw new JiraApiError(404, jiraError(['Not found.']));
        throw e;
      });
    invalidateJqlCtxCache();
    await audit(req, `metadata.${ps(req.params.entity)}.updated`, 'metadata', ps(req.params.id), parsed.data as any);
    res.json(cfg.shape(row));
  })
);

metadataRouter.delete(
  '/:entity/:id',
  requireAdmin,
  ah(async (req, res) => {
    const cfg = entities[ps(req.params.entity)];
    if (!cfg) throw new JiraApiError(404, jiraError(['Unknown metadata entity.']));
    const existing = await delegate(cfg.model).findUnique({ where: { id: ps(req.params.id) } });
    if (!existing) throw new JiraApiError(404, jiraError(['Not found.']));
    if (cfg.inUse) {
      const msg = await cfg.inUse(ps(req.params.id));
      if (msg) {
        res.status(400).json(jiraError([], { entity: msg }));
        return;
      }
    }
    if (cfg.model === 'issueLinkType') {
      const links = await prisma.issueLink.count({ where: { typeId: ps(req.params.id) } });
      // Jira drops the links with the type — surface the count in the audit log.
      await prisma.$transaction([
        prisma.issueLink.deleteMany({ where: { typeId: ps(req.params.id) } }),
        prisma.issueLinkType.delete({ where: { id: ps(req.params.id) } }),
      ]);
      await audit(req, `metadata.${ps(req.params.entity)}.deleted`, 'metadata', ps(req.params.id), { droppedLinks: links });
      invalidateJqlCtxCache();
      res.status(204).end();
      return;
    }
    await delegate(cfg.model).delete({ where: { id: ps(req.params.id) } });
    invalidateJqlCtxCache();
    await audit(req, `metadata.${ps(req.params.entity)}.deleted`, 'metadata', ps(req.params.id), { name: existing.name });
    res.status(204).end();
  })
);

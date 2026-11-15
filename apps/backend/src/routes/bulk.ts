// Sprint 023: bulk operations + export — TF-internal routes under
// /api/internal/bulk and /api/internal/export. Mounted before migrationRouter
// (its blanket requireAdmin would otherwise 403 these paths).
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { jiraError } from '../lib/errors.js';
import { ah, parseBody, parseQuery } from '../lib/http.js';
import { createBulkJob, getBulkJob, retryBulkJob } from '../services/bulkService.js';
import { exportIssues, exportIssuePrint } from '../services/exportService.js';

export const bulkRouter: RouterType = Router();
export const exportRouter: RouterType = Router();

const bulkBody = z.object({
  issueKeys: z.array(z.string()).max(500).optional(),
  jql: z.string().max(2000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().optional(),
});

for (const op of ['edit', 'transition', 'move', 'delete', 'comment', 'watch', 'link'] as const) {
  bulkRouter.post(
    `/${op}`,
    ah(async (req, res) => {
      const parsed = bulkBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json(jiraError([], { body: 'Invalid bulk request.' }));
        return;
      }
      const { issueKeys, jql, payload, dryRun } = parsed.data;
      const result = await createBulkJob(op, { issueKeys, jql }, payload ?? {}, dryRun ?? false, req.actor!);
      res.status(dryRun ? 200 : 202).json(result);
    })
  );
}

bulkRouter.get(
  '/job/:jobId',
  ah(async (req, res) => {
    res.json(await getBulkJob(req.params.jobId, req.actor!));
  })
);

bulkRouter.post(
  '/job/:jobId/retry',
  ah(async (req, res) => {
    const { dryRun } = parseBody(z.object({ dryRun: z.boolean().optional() }), req);
    res.status(dryRun ? 200 : 202).json(await retryBulkJob(req.params.jobId, dryRun ?? false, req.actor!));
  })
);

// ---------- export (US4) ----------

exportRouter.get(
  '/issues',
  ah(async (req, res) => {
    const q = parseQuery(
      z.object({
        jql: z.string().max(2000).optional(),
        format: z.enum(['csv', 'print']).default('csv'),
        columns: z.string().max(1000).optional(),
      }),
      req
    );
    const out = await exportIssues(req.actor!, {
      jql: q.jql,
      format: q.format,
      columns: q.columns
        ? q.columns
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined,
    });
    if (q.format === 'print') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
    } else {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="issues.csv"');
    }
    res.send(out);
  })
);

exportRouter.get(
  '/issue/:key',
  ah(async (req, res) => {
    parseQuery(z.object({ format: z.enum(['print']).default('print') }), req);
    const html = await exportIssuePrint(req.actor!, req.params.key.toUpperCase());
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  })
);

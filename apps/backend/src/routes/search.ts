import { Router, type Router as RouterType } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod/v3';
import { aggregateIssues, executeSearch, jqlToHttpError } from '../services/searchService.js';
import { jiraError } from '../lib/errors.js';
import { searchRequestSchema, formatZodErrors } from '../lib/validation.js';
import { parseSelection } from '../services/issueService.js';
import { ah, pageParams } from '../lib/http.js';

const router: RouterType = Router();

async function runSearch(
  req: Request,
  res: Response,
  next: NextFunction,
  params: { jql: string; startAt: number; maxResults: number; fields?: string[]; expand?: string[] }
) {
  try {
    if (!params.jql.trim()) {
      res.status(400).json(jiraError(['A JQL query is required.']));
      return;
    }
    res.json(await executeSearch(req.actor!, params));
  } catch (err) {
    const jqlErr = jqlToHttpError(err);
    if (jqlErr) {
      res.status(jqlErr.status).json(jqlErr.response);
      return;
    }
    next(err);
  }
}

router.get('/', async (req, res, next) => {
  await runSearch(req, res, next, {
    jql: String(req.query.jql ?? ''),
    ...pageParams(req, { cap: 100 }),
    fields: parseSelection(req.query.fields),
    expand: parseSelection(req.query.expand),
  });
});

router.post('/', async (req, res, next) => {
  const parsed = searchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
    return;
  }
  await runSearch(req, res, next, {
    jql: parsed.data.jql,
    startAt: Math.max(0, parsed.data.startAt ?? 0),
    maxResults: Math.min(100, Math.max(1, parsed.data.maxResults ?? 50)),
    fields: parsed.data.fields,
    expand: parsed.data.expand,
  });
});

export default router;

// ---------- 068 — /api/internal/search: aggregate surface ----------

export const searchInternalRouter: RouterType = Router();

const aggregateSchema = z.object({
  jql: z.string().min(1).max(2000),
  groupBy: z.enum(['status', 'assignee', 'priority', 'issuetype', 'project', 'reporter', 'sprint']).optional(),
});

/** Count + group-by buckets for the copilot's aggregate_issues tool — same
 *  visibility-scoped predicate as executeSearch. */
searchInternalRouter.post(
  '/aggregate',
  ah(async (req: Request, res: Response) => {
    const parsed = aggregateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    try {
      res.json(await aggregateIssues(req.actor!, parsed.data.jql, parsed.data.groupBy));
    } catch (e) {
      throw jqlToHttpError(e) ?? e;
    }
  })
);

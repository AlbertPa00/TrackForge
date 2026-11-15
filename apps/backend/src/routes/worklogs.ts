import { Router, type Router as RouterType } from 'express';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors, worklogListSchema } from '../lib/validation.js';
import { worklogsUpdated, worklogsDeleted, worklogsByIds, sinceParam } from '../services/worklogService.js';
import { visibleIssueWhere } from '../services/visibilityService.js';
import type { Actor } from '../lib/auth.js';
import { prisma } from '../prisma.js';
import { ah } from '../lib/http.js';

/** Sprint 024 — Jira /worklog/* incremental-sync endpoints.
 *  Mounted at /rest/api/2/worklog. */
export const worklogRouter: RouterType = Router();

/** Issue ids the actor may see — BROWSE + token allow-list + issue security
 *  (064 US3; previously only BROWSE). */
async function scopedIssueIds(actor: Actor) {
  const visible = await prisma.issue.findMany({
    where: await visibleIssueWhere(actor),
    select: { id: true },
  });
  return visible.map((i) => i.id);
}

worklogRouter.get(
  '/updated',
  ah(async (req, res) => {
    res.json(await worklogsUpdated(sinceParam(req), await scopedIssueIds(req.actor!)));
  })
);

worklogRouter.get(
  '/deleted',
  ah(async (req, res) => {
    res.json(await worklogsDeleted(sinceParam(req), await scopedIssueIds(req.actor!)));
  })
);

worklogRouter.post(
  '/list',
  ah(async (req, res) => {
    const parsed = worklogListSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await worklogsByIds(parsed.data.ids, req.actor!));
  })
);

import { ps } from '../lib/validation.js';
// Sprint 022: TF-extension issue operations — clone + move (Jira has no REST
// equivalents; both live under /api/internal/issues and are dryRun-able).
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { enforceIssueScope, projectAllowed } from '../middleware/auth.js';
import { getIssueByKey, toIssueResponse } from '../services/issueService.js';
import { cloneIssue, moveIssue } from '../services/issueOpsService.js';
import { ah } from '../lib/http.js';

export const issueOpsRouter: RouterType = Router();

const cloneSchema = z.object({
  summary: z.string().min(1).max(255).optional(),
  options: z
    .object({
      includeLinks: z.boolean().optional(),
      includeSubtasks: z.boolean().optional(),
      includeAttachments: z.boolean().optional(),
      includeWatchers: z.boolean().optional(),
      includeVotes: z.boolean().optional(),
      includeSprint: z.boolean().optional(),
    })
    .optional(),
  dryRun: z.boolean().optional(),
});

issueOpsRouter.post(
  '/:key/clone',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = cloneSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(jiraError([], { body: 'Invalid clone request.' }));
      return;
    }
    const source = await getIssueByKey(key);
    const result = await cloneIssue(source, req.actor!, {
      ...parsed.data.options,
      summary: parsed.data.summary,
      dryRun: parsed.data.dryRun,
    });
    if ('id' in result && result.id) {
      const clone = await getIssueByKey(result.key!);
      res.status(201).json({ ...result, issue: toIssueResponse(clone, { actorId: req.actor!.user.id }) });
      return;
    }
    res.json(result);
  })
);

const moveSchema = z.object({
  target: z.object({
    projectKey: z.string().min(1),
    issueTypeName: z.string().optional(),
    statusName: z.string().optional(),
  }),
  dryRun: z.boolean().optional(),
});

issueOpsRouter.post(
  '/:key/move',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = moveSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(jiraError([], { body: 'Invalid move request — body must be { target: { projectKey } }.' }));
      return;
    }
    if (!projectAllowed(req.actor!, parsed.data.target.projectKey)) {
      throw new JiraApiError(
        404,
        jiraError([], { project: 'Project does not exist or you do not have permission to see it.' })
      );
    }
    const source = await getIssueByKey(key);
    const result = await moveIssue(source, { ...parsed.data.target, dryRun: parsed.data.dryRun }, req.actor!);
    res.json(result);
  })
);

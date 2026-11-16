import { ps } from '../lib/validation.js';
// 058 US7 — project landing-page extras (internal product API).
import { Router, type Router as RouterType } from 'express';
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { hasPermission } from '../services/permissionService.js';
import { projectAllowed } from '../middleware/auth.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { getProjectSummary } from '../services/projectSummaryService.js';
import { ah } from '../lib/http.js';

export const projectExtrasRouter: RouterType = Router();

// GET /api/internal/projects/{key}/summary — five-widget aggregate:
// status rollup, recent activity, open-by-priority, upcoming versions,
// workload + live agent activity.
projectExtrasRouter.get(
  '/projects/:key/summary',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    if (!projectAllowed(req.actor as Actor, key)) {
      throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
    }
    const project = await prisma.project.findUnique({ where: { key } });
    if (!project || !(await hasPermission(req.actor as Actor, 'BROWSE_PROJECTS', { projectId: project.id }))) {
      throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
    }
    res.json(await getProjectSummary(project.id, project.key));
  })
);

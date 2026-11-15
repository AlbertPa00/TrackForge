import { Router, type Router as RouterType } from 'express';
import {
  createProject,
  listProjects,
  getProjectByKey,
  getProjectStatuses,
  updateProject,
  deleteProject,
  archiveProject,
  restoreProject,
  toProjectResponse,
  projectIssueTypes,
} from '../services/projectService.js';
import { createProjectSchema, updateProjectSchema, formatZodErrors } from '../lib/validation.js';
import { jiraError } from '../lib/errors.js';
import { requireAdmin, projectAllowed } from '../middleware/auth.js';
import { hasPermission, nonBrowsableProjectIds } from '../services/permissionService.js';
import { audit } from '../services/auditService.js';
import { ah, markDryRun, isDryRun } from '../lib/http.js';

const router: RouterType = Router();

// Jira: only Jira administrators may create projects (company-managed).
router.post(
  '/',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const project = await createProject(parsed.data);
    await audit(req, 'project.created', 'project', parsed.data.key, { name: parsed.data.name });
    res.status(201).json(toProjectResponse(project));
  })
);

router.get(
  '/',
  ah(async (req, res) => {
    const projects = await listProjects({
      includeArchived: String(req.query.includeArchived ?? '') === 'true',
      categoryId: req.query.categoryId ? String(req.query.categoryId) : undefined,
    });
    const denied = new Set(await nonBrowsableProjectIds(req.actor!));
    const allowed = projects.filter((p) => projectAllowed(req.actor!, p.key) && !denied.has(p.id));
    res.json(allowed.map(toProjectResponse));
  })
);

router.get(
  '/:key',
  ah(async (req, res) => {
    const key = req.params.key.toUpperCase();
    if (!projectAllowed(req.actor!, key)) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    const project = await getProjectByKey(key);
    if (!(await hasPermission(req.actor!, 'BROWSE_PROJECTS', { projectId: project.id }))) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    // 062 US4 — Jira returns issueTypes on project detail; pickers scope to it.
    res.json({ ...toProjectResponse(project), issueTypes: await projectIssueTypes(project) });
  })
);

// Jira GET /project/{key}/statuses — statuses per issue type from the project's workflow.
router.get(
  '/:key/statuses',
  ah(async (req, res) => {
    const key = req.params.key.toUpperCase();
    if (!projectAllowed(req.actor!, key)) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    const project = await getProjectByKey(key);
    if (!(await hasPermission(req.actor!, 'BROWSE_PROJECTS', { projectId: project.id }))) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    res.json(await getProjectStatuses(key));
  })
);

router.put(
  '/:key',
  ah(async (req, res) => {
    const key = req.params.key.toUpperCase();
    if (!projectAllowed(req.actor!, key)) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    const parsed = updateProjectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    {
      const p = await getProjectByKey(key);
      if (!(await hasPermission(req.actor!, 'ADMINISTER_PROJECTS', { projectId: p.id }))) {
        res.status(403).json(jiraError([], { permission: "Missing required permission 'ADMINISTER_PROJECTS'." }));
        return;
      }
    }
    const project = await updateProject(key, {
      name: parsed.data.name,
      description: parsed.data.description,
      avatarColor: parsed.data.avatarColor,
      leadAccountId: parsed.data.lead ? (parsed.data.lead.accountId ?? parsed.data.lead.name ?? null) : undefined,
      aiEnabled: parsed.data.aiEnabled,
      agentGuidance: parsed.data.agentGuidance,
      categoryId: parsed.data.categoryId,
    });
    await audit(req, 'project.update', 'project', key, { name: parsed.data.name });
    res.json(toProjectResponse(project));
  })
);

// 021 — Jira archive/restore (read-only; hidden from pickers/lists).
router.post(
  '/:key/archive',
  requireAdmin,
  ah(async (req, res) => {
    const project = await archiveProject(req.params.key.toUpperCase());
    await audit(req, 'project.archived', 'project', project.key);
    res.json(toProjectResponse(project));
  })
);

router.post(
  '/:key/restore',
  requireAdmin,
  ah(async (req, res) => {
    const project = await restoreProject(req.params.key.toUpperCase());
    await audit(req, 'project.restored', 'project', project.key);
    res.json(toProjectResponse(project));
  })
);

// 065 audit G8 — two-step like issue delete: ?dryRun=true previews the
// blast radius and mints an expiring single-use confirmToken; the real
// delete must present it.
router.delete(
  '/:key',
  requireAdmin,
  ah(async (req, res) => {
    const key = req.params.key.toUpperCase();
    const { prisma } = await import('../prisma.js');
    const project = await getProjectByKey(key);
    const issueCount = await prisma.issue.count({ where: { projectId: project.id } });
    if (isDryRun(req)) {
      const { issueConfirmToken } = await import('../lib/confirmToken.js');
      markDryRun(res);
      res.json({
        key,
        deletesIssues: issueCount,
        warning: `Project ${key} and its ${issueCount} issue(s), sprints, and boards are permanently deleted.`,
        confirmToken: await issueConfirmToken('project-delete', project.id),
      });
      return;
    }
    const { consumeConfirmToken } = await import('../lib/confirmToken.js');
    const raw = String(req.query.confirmToken ?? req.headers['x-confirm-token'] ?? '') || undefined;
    if (!(await consumeConfirmToken('project-delete', project.id, raw))) {
      res.status(400).json(
        jiraError([], {
          confirmToken: 'Project deletion requires a confirmToken from a ?dryRun=true preview of this same delete.',
        })
      );
      return;
    }
    const result = await deleteProject(key);
    await audit(req, 'project.delete', 'project', key, result);
    res.status(204).send();
  })
);

export default router;

import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  assignWorkflowToProject,
  listWorkflowSchemes,
  getWorkflowScheme,
  createWorkflowScheme,
  updateWorkflowScheme,
  deleteWorkflowScheme,
  deleteWorkflow,
} from '../services/workflowService.js';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import { requireAdmin } from '../middleware/auth.js';
import { requirePermission } from '../services/permissionService.js';
import { audit } from '../services/auditService.js';
import { prisma } from '../prisma.js';
import { ah } from '../lib/http.js';

const router: RouterType = Router();

const ruleSchema = z.object({
  kind: z.enum(['condition', 'validator', 'postFunction']),
  type: z.string().min(1),
  config: z.record(z.unknown()).optional(),
});

const workflowSchema = z.object({
  name: z.string().min(1).max(255),
  statuses: z
    .array(
      z.object({
        statusId: z.string().min(1),
        isInitial: z.boolean().optional(),
        position: z.number().int().optional(),
      })
    )
    .min(1),
  transitions: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        fromStatusId: z.string().nullable().optional(),
        toStatusId: z.string().min(1),
        screenFields: z.array(z.string()).max(8).optional(),
        rules: z.array(ruleSchema).optional(),
      })
    )
    .default([]),
});

// GET /workflows — full workflow definitions for the editor.
router.get(
  '/workflows',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listWorkflows());
  })
);

router.get(
  '/workflows/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await getWorkflow(ps(req.params.id)));
  })
);

router.post(
  '/workflows',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = workflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const wf = await createWorkflow(parsed.data);
    await audit(req, 'workflow.create', 'workflow', wf.id, { name: wf.name });
    res.status(201).json(wf);
  })
);

router.put(
  '/workflows/:id',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = workflowSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const wf = await updateWorkflow(ps(req.params.id), parsed.data);
    await audit(req, 'workflow.update', 'workflow', wf.id, { name: wf.name });
    res.json(wf);
  })
);

// DELETE /workflows/:id — refused while bound to projects or schemes (060 US1).
router.delete(
  '/workflows/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteWorkflow(ps(req.params.id));
    await audit(req, 'workflow.delete', 'workflow', ps(req.params.id));
    res.status(204).end();
  })
);

const assignSchema = z.object({
  workflowId: z.string().min(1),
  mapping: z.record(z.string()).default({}),
});

// POST /projects/:key/workflow — Jira gates workflow changes behind
// ADMINISTER_PROJECTS; status mapping required when existing issues sit in
// statuses absent from the new workflow.
router.post(
  '/projects/:key/workflow',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    const project = await prisma.project.findUnique({ where: { key } });
    if (!project) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    const actor = req.actor!;
    await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: project.id });
    const parsed = assignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const result = await assignWorkflowToProject(key, parsed.data.workflowId, parsed.data.mapping, actor);
    await audit(req, 'workflow.assign', 'project', key, {
      workflowId: parsed.data.workflowId,
      remappedIssues: result.remappedIssues,
    });
    res.json(result);
  })
);

// ---------- 031: workflow schemes (issue type -> workflow mapping) ----------
const schemeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultWorkflowId: z.string().min(1),
  mappings: z.record(z.string()).optional(),
});

router.get(
  '/workflowschemes',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listWorkflowSchemes());
  })
);

router.get(
  '/workflowschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await getWorkflowScheme(ps(req.params.id)));
  })
);

router.post(
  '/workflowschemes',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = schemeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.status(201).json(await createWorkflowScheme(parsed.data));
  })
);

router.put(
  '/workflowschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = schemeSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await updateWorkflowScheme(ps(req.params.id), parsed.data));
  })
);

router.delete(
  '/workflowschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteWorkflowScheme(ps(req.params.id));
    res.status(204).end();
  })
);

// POST /projects/:key/workflowscheme — bind a scheme to a project (admin)
router.post(
  '/projects/:key/workflowscheme',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = z.object({ schemeId: z.string().nullable() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const project = await prisma.project.update({
      where: { key: ps(req.params.key).toUpperCase() },
      data: { workflowSchemeId: parsed.data.schemeId },
    });
    res.json({ id: project.id, workflowSchemeId: project.workflowSchemeId });
  })
);

export default router;

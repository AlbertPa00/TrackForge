import { ps } from '../lib/validation.js';
// Admin CRUD for custom fields — TrackForge-native API (admin only).
//
//   GET    /api/internal/customfields                list (includeInactive?)
//   POST   /api/internal/customfields                create {name,type,description?}
//   GET    /api/internal/customfields/:id            one field + contexts/options
//   PUT    /api/internal/customfields/:id            rename/description
//   DELETE /api/internal/customfields/:id            soft-delete (?dryRun → preview)
//   POST   /api/internal/customfields/:id/contexts   add context {isGlobal?,projectKeys?,options?}
//   PUT    /api/internal/customfields/:id/contexts/:ctxId   update options
//   DELETE /api/internal/customfields/:id/contexts/:ctxId   remove context

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import { requireAdmin } from '../middleware/auth.js';
import { qs, formatZodErrors } from '../lib/validation.js';
import { jiraError } from '../lib/errors.js';
import { audit } from '../services/auditService.js';
import * as cf from '../services/customFieldService.js';
import { cfSchema, CF_TYPES } from '../lib/cfTypes.js';
import { ah, isDryRun, markDryRun, resourceSelf } from '../lib/http.js';
import { projectByKeyOr404 } from '../services/projectService.js';

export const customFieldsRouter: RouterType = Router();

const optionInput = z.union([
  z
    .string()
    .min(1)
    .max(255)
    .transform((value) => ({ value })),
  z.object({
    value: z.string().min(1).max(255),
    children: z.array(z.string().min(1).max(255)).optional(),
  }),
]);

const createSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(CF_TYPES as [string, ...string[]]),
  description: z.string().max(1000).optional(),
  context: z
    .object({
      projectKeys: z.array(z.string()).optional(),
      options: z.array(optionInput).optional(),
    })
    .optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});

const contextSchema = z.object({
  isGlobal: z.boolean().optional(),
  projectKeys: z.array(z.string()).optional(),
  options: z.array(optionInput).optional(),
});

const contextUpdateSchema = z.object({
  options: z
    .array(
      z.object({
        id: z.string().optional(),
        value: z.string().min(1).max(255),
        disabled: z.boolean().optional(),
        children: z.array(z.string().min(1).max(255)).optional(),
      })
    )
    .optional(),
});

function toAdminResponse(field: cf.FieldWithContexts) {
  return {
    id: field.id,
    name: field.name,
    description: field.description,
    type: field.type,
    searcherType: field.searcherType,
    custom: field.type,
    schema: cfSchema(field),
    active: field.active,
    systemManaged: field.systemManaged,
    alias: field.alias,
    self: resourceSelf(`/api/internal/customfields/${field.id}`),
    contexts: field.contexts.map((c) => ({
      id: c.id,
      isGlobal: c.isGlobal,
      projects: c.projects.map((p) => ({ projectId: p.projectId })),
      options: c.options
        .filter((o) => !o.parentId)
        .map((o) => ({
          id: o.id,
          value: o.value,
          disabled: o.disabled,
          position: o.position,
          children: c.options
            .filter((ch) => ch.parentId === o.id)
            .map((ch) => ({ id: ch.id, value: ch.value, disabled: ch.disabled })),
        })),
    })),
  };
}

customFieldsRouter.get(
  '/',
  ah(async (req, res) => {
    const includeInactive = String(qs(req.query.includeInactive) ?? '') === 'true';
    const fields = await cf.listFields(includeInactive);
    res.json({ fields: fields.map(toAdminResponse), types: CF_TYPES });
  })
);

customFieldsRouter.post(
  '/',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const field = await cf.createField(parsed.data);
    let full = field;
    if (parsed.data.context) {
      full = await cf.upsertContext(field.id, parsed.data.context);
    }
    await audit(req, 'customfield.create', 'customfield', field.id, { name: field.name });
    res.status(201).json(toAdminResponse(full));
  })
);

customFieldsRouter.get(
  '/:id',
  ah(async (req, res) => {
    res.json(toAdminResponse(await cf.getField(ps(req.params.id))));
  })
);

customFieldsRouter.put(
  '/:id',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const field = await cf.updateField(ps(req.params.id), parsed.data);
    await audit(req, 'customfield.update', 'customfield', field.id, parsed.data);
    res.json(toAdminResponse(field));
  })
);

// Soft-delete with mandatory dryRun preview (AI-native: deletes are previewable).
customFieldsRouter.delete(
  '/:id',
  requireAdmin,
  ah(async (req, res) => {
    if (isDryRun(req)) {
      const preview = await cf.deleteField(ps(req.params.id), true);
      markDryRun(res);
      res.json(preview);
      return;
    }
    const result = await cf.deleteField(ps(req.params.id), false);
    await audit(req, 'customfield.delete', 'customfield', ps(req.params.id), result);
    res.status(204).send();
  })
);

customFieldsRouter.post(
  '/:id/contexts',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = contextSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (!parsed.data.isGlobal && !parsed.data.projectKeys?.length) {
      // No projects listed + not global = global context (Jira default).
      parsed.data.isGlobal = true;
    }
    const field = await cf.upsertContext(ps(req.params.id), parsed.data);
    await audit(req, 'customfield.context.create', 'customfield', ps(req.params.id), {
      projectKeys: parsed.data.projectKeys,
    });
    res.status(201).json(toAdminResponse(field));
  })
);

customFieldsRouter.put(
  '/:id/contexts/:ctxId',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = contextUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const field = await cf.updateContext(ps(req.params.id), ps(req.params.ctxId), parsed.data);
    await audit(req, 'customfield.context.update', 'customfield', ps(req.params.id), {
      contextId: ps(req.params.ctxId),
    });
    res.json(toAdminResponse(field));
  })
);

customFieldsRouter.delete(
  '/:id/contexts/:ctxId',
  requireAdmin,
  ah(async (req, res) => {
    const field = await cf.deleteContext(ps(req.params.id), ps(req.params.ctxId));
    await audit(req, 'customfield.context.delete', 'customfield', ps(req.params.id), {
      contextId: ps(req.params.ctxId),
    });
    res.json(toAdminResponse(field));
  })
);

/** Jira-style option listing for one field+project context (drives pickers). */
customFieldsRouter.get(
  '/:id/options',
  ah(async (req, res) => {
    const field = await cf.getField(ps(req.params.id));
    const projectKey = String(qs(req.query.project) ?? '').toUpperCase();
    let options;
    if (projectKey) {
      const project = await projectByKeyOr404(projectKey);
      options = cf.optionsForProject(field, project.id);
    } else {
      options = cf.allOptions(field);
    }
    res.json({ options });
  })
);

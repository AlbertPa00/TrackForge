import { ps } from '../lib/validation.js';
// Sprint 031 — screens / screen schemes / issue-type screen schemes (US1).
// Jira read shapes under /rest/api/2/screens; full CRUD under /api/internal
// (admin-gated) + project ITSS assignment.

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  listScreens,
  createScreen,
  updateScreen,
  deleteScreen,
  setScreenTabs,
  listScreenSchemes,
  createScreenScheme,
  updateScreenScheme,
  deleteScreenScheme,
  listIssueTypeScreenSchemes,
  createIssueTypeScreenScheme,
  updateIssueTypeScreenScheme,
  deleteIssueTypeScreenScheme,
  assignIssueTypeScreenScheme,
} from '../services/screenService.js';
import {
  listFieldConfigurations,
  createFieldConfiguration,
  updateFieldConfiguration,
  deleteFieldConfiguration,
  listFieldConfigurationSchemes,
  createFieldConfigurationScheme,
  updateFieldConfigurationScheme,
  deleteFieldConfigurationScheme,
  assignFieldConfigurationScheme,
} from '../services/fieldConfigService.js';
import { prisma } from '../prisma.js';
import { ah } from '../lib/http.js';
import { qs } from '../lib/validation.js';

export const screensJiraRouter: RouterType = Router(); // /rest/api/2/screens
export const screensAdminRouter: RouterType = Router(); // /api/internal/screens|screenschemes|issuetypescreenschemes
export const projectScreensRouter: RouterType = Router(); // /api/internal/projects

const body = <T>(schema: z.ZodType<T>, req: import('express').Request): T => {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    throw new JiraApiError(400, jiraError([r.error.issues[0]?.message ?? 'Invalid request body.']));
  }
  return r.data;
};

const tabSchema = z.object({ name: z.string().min(1), fields: z.array(z.string()).optional() });
const screenSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tabs: z.array(tabSchema).optional(),
});
const schemeItemSchema = z.object({
  operation: z.enum(['default', 'create', 'edit', 'view']),
  screenId: z.string().min(1),
});
const screenSchemeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  items: z.array(schemeItemSchema).optional(),
});
const itssSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultSchemeId: z.string().nullable().optional(),
  mappings: z.array(z.object({ issueTypeId: z.string(), screenSchemeId: z.string() })).optional(),
});

type Tab = { id: string; name: string; position: number; fields: { fieldId: string }[] };
const screenJson = (s: { id: string; name: string; description: string | null; tabs: Tab[] }) => ({
  id: s.id,
  name: s.name,
  description: s.description ?? undefined,
  tabs: s.tabs.map((t) => ({ id: t.id, name: t.name, fields: t.fields.map((f) => f.fieldId) })),
});

/* --------------------------- Jira read shape --------------------------- */

screensJiraRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json((await listScreens()).map(screenJson));
  })
);
screensJiraRouter.get(
  '/:id',
  ah(async (req, res) => {
    const s = (await listScreens()).find((x) => x.id === ps(req.params.id));
    if (!s) throw new JiraApiError(404, jiraError(['Screen does not exist.']));
    res.json(screenJson(s));
  })
);
screensJiraRouter.get(
  '/:id/tabs',
  ah(async (req, res) => {
    const s = (await listScreens()).find((x) => x.id === ps(req.params.id));
    if (!s) throw new JiraApiError(404, jiraError(['Screen does not exist.']));
    res.json(screenJson(s).tabs);
  })
);

/* ------------------------------- admin ------------------------------- */

screensAdminRouter.get(
  '/screens',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listScreens());
  })
);
screensAdminRouter.post(
  '/screens',
  requireAdmin,
  ah(async (req, res) => {
    res.status(201).json(await createScreen(body(screenSchema, req)));
  })
);
screensAdminRouter.put(
  '/screens/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await updateScreen(ps(req.params.id), body(screenSchema.partial(), req)));
  })
);
screensAdminRouter.delete(
  '/screens/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteScreen(ps(req.params.id));
    res.status(204).end();
  })
);
screensAdminRouter.put(
  '/screens/:id/tabs',
  requireAdmin,
  ah(async (req, res) => {
    const { tabs } = body(z.object({ tabs: z.array(tabSchema) }), req);
    res.json(await setScreenTabs(ps(req.params.id), tabs));
  })
);

screensAdminRouter.get(
  '/screenschemes',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listScreenSchemes());
  })
);
screensAdminRouter.post(
  '/screenschemes',
  requireAdmin,
  ah(async (req, res) => {
    res.status(201).json(await createScreenScheme(body(screenSchemeSchema, req)));
  })
);
screensAdminRouter.put(
  '/screenschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await updateScreenScheme(ps(req.params.id), body(screenSchemeSchema.partial(), req)));
  })
);
screensAdminRouter.delete(
  '/screenschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteScreenScheme(ps(req.params.id));
    res.status(204).end();
  })
);

screensAdminRouter.get(
  '/issuetypescreenschemes',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listIssueTypeScreenSchemes());
  })
);
screensAdminRouter.post(
  '/issuetypescreenschemes',
  requireAdmin,
  ah(async (req, res) => {
    res.status(201).json(await createIssueTypeScreenScheme(body(itssSchema, req)));
  })
);
screensAdminRouter.put(
  '/issuetypescreenschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await updateIssueTypeScreenScheme(ps(req.params.id), body(itssSchema.partial(), req)));
  })
);
screensAdminRouter.delete(
  '/issuetypescreenschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteIssueTypeScreenScheme(ps(req.params.id));
    res.status(204).end();
  })
);

/* ------------------------- project assignment ------------------------ */

projectScreensRouter.post(
  '/:key/issuetypescreenscheme',
  requireAdmin,
  ah(async (req, res) => {
    const { schemeId } = body(z.object({ schemeId: z.string().nullable() }), req);
    res.json(await assignIssueTypeScreenScheme(ps(req.params.key), schemeId));
  })
);

// used by tests/clients: resolved screen for a project+type+op
projectScreensRouter.get(
  '/:key/issuetypescreenscheme/resolved',
  requireAdmin,
  ah(async (req, res) => {
    const p = await prisma.project.findUnique({ where: { key: ps(req.params.key).toUpperCase() } });
    if (!p) throw new JiraApiError(404, jiraError(['Project does not exist.']));
    const { screenFieldSet } = await import('../services/screenService.js');
    const fields = await screenFieldSet(
      p.id,
      (qs(req.query.issueTypeId) as string | undefined) ?? null,
      (qs(req.query.op) as 'create' | 'edit' | 'view' | undefined) ?? 'view'
    );
    res.json({ fields: fields ? [...fields] : null });
  })
);

/* --------------------- field configurations (US2) --------------------- */

const fcItemSchema = z.object({
  fieldId: z.string().min(1),
  required: z.boolean().optional(),
  hidden: z.boolean().optional(),
  description: z.string().optional(),
  defaultValue: z.unknown().optional(),
  rules: z
    .array(
      z.object({
        when: z
          .object({
            field: z.string(),
            is: z.unknown().optional(),
            in: z.array(z.unknown()).optional(),
            isNot: z.unknown().optional(),
            empty: z.boolean().optional(),
          })
          .optional(),
        required: z.boolean().optional(),
        hidden: z.boolean().optional(),
        defaultValue: z.unknown().optional(),
      })
    )
    .optional(),
});
const fcSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  items: z.array(fcItemSchema).optional(),
});
const fcsSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  defaultConfigId: z.string().nullable().optional(),
  mappings: z.array(z.object({ issueTypeId: z.string(), configId: z.string() })).optional(),
});

export const fieldConfigJiraRouter: RouterType = Router(); // /rest/api/2/fieldconfigurations

fieldConfigJiraRouter.get(
  '/',
  ah(async (_req, res) => {
    res.json(await listFieldConfigurations());
  })
);
fieldConfigJiraRouter.get(
  '/:id',
  ah(async (req, res) => {
    const c = (await listFieldConfigurations()).find((x) => x.id === ps(req.params.id));
    if (!c) throw new JiraApiError(404, jiraError(['Field configuration does not exist.']));
    res.json(c);
  })
);

screensAdminRouter.get(
  '/fieldconfigurations',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listFieldConfigurations());
  })
);
screensAdminRouter.post(
  '/fieldconfigurations',
  requireAdmin,
  ah(async (req, res) => {
    res.status(201).json(await createFieldConfiguration(body(fcSchema, req)));
  })
);
screensAdminRouter.put(
  '/fieldconfigurations/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await updateFieldConfiguration(ps(req.params.id), body(fcSchema.partial(), req)));
  })
);
screensAdminRouter.delete(
  '/fieldconfigurations/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteFieldConfiguration(ps(req.params.id));
    res.status(204).end();
  })
);

screensAdminRouter.get(
  '/fieldconfigurationschemes',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listFieldConfigurationSchemes());
  })
);
screensAdminRouter.post(
  '/fieldconfigurationschemes',
  requireAdmin,
  ah(async (req, res) => {
    res.status(201).json(await createFieldConfigurationScheme(body(fcsSchema, req)));
  })
);
screensAdminRouter.put(
  '/fieldconfigurationschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await updateFieldConfigurationScheme(ps(req.params.id), body(fcsSchema.partial(), req)));
  })
);
screensAdminRouter.delete(
  '/fieldconfigurationschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteFieldConfigurationScheme(ps(req.params.id));
    res.status(204).end();
  })
);

projectScreensRouter.post(
  '/:key/fieldconfigurationscheme',
  requireAdmin,
  ah(async (req, res) => {
    const { schemeId } = body(z.object({ schemeId: z.string().nullable() }), req);
    res.json(await assignFieldConfigurationScheme(ps(req.params.key), schemeId));
  })
);

// ---------- 031: issue type schemes ----------
const itsSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  issueTypeIds: z.array(z.string()).optional(),
});
const { listSchemes, createScheme, updateScheme, deleteScheme } = await import('../services/issueTypeSchemeService.js');

screensAdminRouter.get(
  '/issuetypeschemes',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listSchemes());
  })
);
screensAdminRouter.post(
  '/issuetypeschemes',
  requireAdmin,
  ah(async (req, res) => {
    res.status(201).json(await createScheme(body(itsSchema, req)));
  })
);
screensAdminRouter.put(
  '/issuetypeschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await updateScheme(ps(req.params.id), body(itsSchema.partial(), req)));
  })
);
screensAdminRouter.delete(
  '/issuetypeschemes/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteScheme(ps(req.params.id));
    res.status(204).end();
  })
);

projectScreensRouter.post(
  '/:key/issuetypescheme',
  requireAdmin,
  ah(async (req, res) => {
    const { schemeId } = body(z.object({ schemeId: z.string().nullable() }), req);
    const project = await prisma.project.update({
      where: { key: ps(req.params.key) },
      data: { issueTypeSchemeId: schemeId },
    });
    res.json({ id: project.id, issueTypeSchemeId: project.issueTypeSchemeId });
  })
);

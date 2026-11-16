import { ps } from '../lib/validation.js';
// Sprint 031 — issue security scheme endpoints (US4).
// Jira read shape: GET /rest/api/2/issuesecurityschemes returns schemes with
// levels+members. Full CRUD lives under /api/internal (admin-gated), plus
// project assignment and per-level management.

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  listSchemes,
  createScheme,
  updateScheme,
  deleteScheme,
  addLevel,
  updateLevel,
  deleteLevel,
  assignScheme,
} from '../services/issueSecurityService.js';
import { ah, resourceSelf } from '../lib/http.js';

export const issueSecurityJiraRouter: RouterType = Router(); // /rest/api/2/issuesecurityschemes
export const issueSecurityAdminRouter: RouterType = Router(); // /api/internal/issuesecurityschemes
export const projectSecurityRouter: RouterType = Router(); // /api/internal/projects

const memberSchema = z.object({
  kind: z.enum(['user', 'group', 'projectrole', 'reporter', 'assignee', 'projectlead']),
  ref: z.string().optional(),
});
const levelSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  members: z.array(memberSchema).optional(),
});
const schemeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  levels: z.array(levelSchema).optional(),
});
const body = <T>(schema: z.ZodType<T>, req: import('express').Request): T => {
  const r = schema.safeParse(req.body);
  if (!r.success) {
    throw new JiraApiError(400, jiraError([r.error.issues[0]?.message ?? 'Invalid request body.']));
  }
  return r.data;
};

type Level = {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  members: { kind: string; ref: string | null }[];
};
const levelJson = (l: Level) => ({
  id: l.id,
  name: l.name,
  description: l.description ?? undefined,
  isDefault: l.isDefault,
  members: l.members.map((m) => ({ type: m.kind, parameter: m.ref ?? undefined })),
});
const schemeJson = (s: { id: string; name: string; description: string | null; levels: Level[] }) => ({
  id: s.id,
  name: s.name,
  description: s.description ?? undefined,
  self: resourceSelf(`/rest/api/2/issuesecurityschemes/${s.id}`),
  defaultSecurityLevelId: s.levels.find((l) => l.isDefault)?.id ?? null,
  levels: s.levels.map(levelJson),
});

/* ------------------------- Jira read surface ------------------------- */

issueSecurityJiraRouter.get(
  '/',
  ah(async (_req, res) => {
    const schemes = await listSchemes();
    res.json({ issueSecuritySchemes: schemes.map(schemeJson) });
  })
);

issueSecurityJiraRouter.get(
  '/:id',
  ah(async (req, res) => {
    const schemes = await listSchemes();
    const s = schemes.find((x) => x.id === ps(req.params.id));
    if (!s) throw new JiraApiError(404, jiraError(['Issue security scheme does not exist.']));
    res.json(schemeJson(s));
  })
);

/* ----------------------------- admin CRUD ---------------------------- */

issueSecurityAdminRouter.get(
  '/',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(await listSchemes());
  })
);

issueSecurityAdminRouter.post(
  '/',
  requireAdmin,
  ah(async (req, res) => {
    const input = body(schemeSchema, req);
    res.status(201).json(await createScheme(input));
  })
);

issueSecurityAdminRouter.put(
  '/:id',
  requireAdmin,
  ah(async (req, res) => {
    const input = body(z.object({ name: z.string().min(1).optional(), description: z.string().optional() }), req);
    res.json(await updateScheme(ps(req.params.id), input));
  })
);

issueSecurityAdminRouter.delete(
  '/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteScheme(ps(req.params.id));
    res.status(204).end();
  })
);

issueSecurityAdminRouter.post(
  '/:schemeId/levels',
  requireAdmin,
  ah(async (req, res) => {
    const input = body(levelSchema, req);
    res.status(201).json(await addLevel(ps(req.params.schemeId), input));
  })
);

issueSecurityAdminRouter.put(
  '/levels/:levelId',
  requireAdmin,
  ah(async (req, res) => {
    const input = body(levelSchema.partial(), req);
    res.json(await updateLevel(ps(req.params.levelId), input));
  })
);

issueSecurityAdminRouter.delete(
  '/levels/:levelId',
  requireAdmin,
  ah(async (req, res) => {
    await deleteLevel(ps(req.params.levelId));
    res.status(204).end();
  })
);

/* ------------------------- project assignment ------------------------ */

projectSecurityRouter.post(
  '/:key/issuesecurityscheme',
  requireAdmin,
  ah(async (req, res) => {
    const input = body(z.object({ schemeId: z.string().nullable() }), req);
    res.json(await assignScheme(ps(req.params.key), input.schemeId));
  })
);

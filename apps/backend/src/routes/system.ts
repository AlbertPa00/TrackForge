import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import { jiraError } from '../lib/errors.js';
import { qs,
  formatZodErrors,
  timeTrackingConfigSchema,
  moduleTogglesSchema,
  projectCategorySchema,
} from '../lib/validation.js';
import {
  getTimeTrackingConfig,
  setTimeTrackingConfig,
  getSetting,
  putSetting,
  getModuleToggles,
  setModuleToggles,
} from '../services/settingsService.js';
import { z } from 'zod';
import { requireAdmin, projectAllowed } from '../middleware/auth.js';
import { hasPermission } from '../services/permissionService.js';
import { listArchivedIssues } from '../services/issueService.js';
import { audit } from '../services/auditService.js';
import { toProjectResponse } from '../services/projectService.js';
import { publicBaseUrl } from '../config.js';
import { prisma } from '../prisma.js';
import { ah } from '../lib/http.js';

/** Sprint 024/021 — instance-level system surface.
 *  Mounted at /api/internal. */
export const systemRouter: RouterType = Router();

const started = Date.now();

/** GET /system/info — discoverable instance facts (A3). Grows in 021. */
systemRouter.get('/system/info', async (req, res) => {
  const [tt, modules, counts] = await Promise.all([
    getTimeTrackingConfig(),
    getModuleToggles(),
    Promise.all([prisma.user.count(), prisma.project.count(), prisma.issue.count()]),
  ]);
  res.json({
    baseUrl: publicBaseUrl(),
    version: '1.0.0',
    serverTitle: 'TrackForge',
    deploymentType: 'Server',
    uptimeSec: Math.floor((Date.now() - started) / 1000),
    counts: { users: counts[0], projects: counts[1], issues: counts[2] },
    modules,
    timeTracking: tt,
  });
});

/** GET /system/timetracking — §13.3 workday assumptions (any authenticated user). */
systemRouter.get('/system/timetracking', async (_req, res) => {
  res.json(await getTimeTrackingConfig());
});

/** PUT /system/timetracking — admin config (§13.3 global only). */
systemRouter.put(
  '/system/timetracking',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = timeTrackingConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const cfg = await setTimeTrackingConfig(parsed.data);
    await audit(req, 'system.timetracking.update', 'system', undefined, parsed.data);
    res.json(cfg);
  })
);

// 065 audit A7 — SSO-only policy switch: setSsoOnly existed but had no route.
// GET returns the flag; PUT toggles it (password login stays allowed for
// site-admins as break-glass — enforced in routes/auth.ts).
systemRouter.get('/system/auth-policy', requireAdmin, async (_req, res) => {
  const { isSsoOnly } = await import('../services/identityService.js');
  res.json({ ssoOnly: await isSsoOnly() });
});

systemRouter.put(
  '/system/auth-policy',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = z.object({ ssoOnly: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const { setSsoOnly } = await import('../services/identityService.js');
    await setSsoOnly(parsed.data.ssoOnly);
    await audit(req, 'system.auth_policy.update', 'system', undefined, parsed.data);
    res.json({ ssoOnly: parsed.data.ssoOnly });
  })
);

/** GET /system/settings — raw setting read for admins (021 module toggles grow here). */
systemRouter.get('/system/settings/:key', requireAdmin, async (req, res) => {
  const value = await getSetting(ps(req.params.key));
  if (value === null) {
    res.status(404).json(jiraError(['Setting not found.']));
    return;
  }
  res.json({ key: ps(req.params.key), value });
});

// ---- 060 stretch — announcement banner (Jira "Announcement banner") ----

const BANNER_KEY = 'announcement.banner';
const bannerSchema = z.object({ message: z.string().max(2000) });

/** Any authenticated user reads the banner (TopNav renders it). */
systemRouter.get('/system/banner', async (_req, res) => {
  const cfg = await getSetting<{ message: string }>(BANNER_KEY);
  res.json({ message: cfg?.message ?? '' });
});

systemRouter.put(
  '/system/banner',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = bannerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    await putSetting(BANNER_KEY, { message: parsed.data.message });
    await audit(req, 'system.banner.update', 'system', undefined, { length: parsed.data.message.length });
    res.json({ message: parsed.data.message });
  })
);

// ---- 021 — module toggles ----

systemRouter.get('/system/modules', async (_req, res) => {
  res.json(await getModuleToggles());
});

systemRouter.put(
  '/system/modules',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = moduleTogglesSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const toggles = await setModuleToggles(parsed.data);
    await audit(req, 'system.modules.update', 'system', undefined, parsed.data);
    res.json(toggles);
  })
);

// ---- 021 — project categories (/api/internal/projectcategories) ----

/** 060 US4 — admin "Ver proyectos": every project (incl. archived) with
    issue counts and last-issue-activity, for the /admin/projects console. */
systemRouter.get(
  '/admin/projects',
  requireAdmin,
  ah(async (_req, res) => {
    const [projects, stats] = await Promise.all([
      prisma.project.findMany({
        include: { lead: { select: { id: true, displayName: true, email: true } }, category: true, workflow: true },
        orderBy: { key: 'asc' },
      }),
      prisma.issue.groupBy({ by: ['projectId'], _count: { id: true }, _max: { updatedAt: true } }),
    ]);
    const byId = new Map(stats.map((s) => [s.projectId, s]));
    res.json(
      projects.map((p) => ({
        ...toProjectResponse(p),
        issues: byId.get(p.id)?._count.id ?? 0,
        lastIssueUpdate: byId.get(p.id)?._max.updatedAt ?? null,
      }))
    );
  })
);

/** 060 US7 — Jira DC "Incidencias archivadas": archived-issue browse for a
    project, visible to RESTORE_ISSUES holders (project admins) and site
    admins. Deliberately bypasses securityGateWhere — it IS the archive view. */
systemRouter.get(
  '/projects/:key/issues/archived',
  ah(async (req, res) => {
    const project = await prisma.project.findUnique({ where: { key: ps(req.params.key).toUpperCase() } });
    if (!project || !projectAllowed(req.actor!, project.key)) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    const allowed =
      req.actor!.user.isAdmin || (await hasPermission(req.actor!, 'RESTORE_ISSUES', { projectId: project.id }));
    if (!allowed) {
      res.status(403).json(jiraError(['You do not have permission to restore issues in this project.']));
      return;
    }
    res.json(await listArchivedIssues(project.id, String(qs(req.query.query) ?? '') || undefined));
  })
);

const catShape = (c: { id: string; name: string; description: string | null }) => ({
  id: c.id,
  name: c.name,
  description: c.description ?? undefined,
});

systemRouter.get('/projectcategories', async (_req, res) => {
  res.json((await prisma.projectCategory.findMany({ orderBy: { name: 'asc' } })).map(catShape));
});

systemRouter.post(
  '/projectcategories',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = projectCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (await prisma.projectCategory.findUnique({ where: { name: parsed.data.name } })) {
      res.status(400).json(jiraError([], { name: 'A project category with that name already exists.' }));
      return;
    }
    const c = await prisma.projectCategory.create({ data: parsed.data });
    await audit(req, 'projectcategory.created', 'projectcategory', c.id, { name: c.name });
    res.status(201).json(catShape(c));
  })
);

systemRouter.put(
  '/projectcategories/:id',
  requireAdmin,
  ah(async (req, res) => {
    const parsed = projectCategorySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (parsed.data.name) {
      const dup = await prisma.projectCategory.findUnique({ where: { name: parsed.data.name } });
      if (dup && dup.id !== ps(req.params.id)) {
        res.status(400).json(jiraError([], { name: 'A project category with that name already exists.' }));
        return;
      }
    }
    const c = await prisma.projectCategory.update({ where: { id: ps(req.params.id) }, data: parsed.data });
    await audit(req, 'projectcategory.updated', 'projectcategory', c.id, parsed.data);
    res.json(catShape(c));
  })
);

systemRouter.delete(
  '/projectcategories/:id',
  requireAdmin,
  ah(async (req, res) => {
    const count = await prisma.project.count({ where: { categoryId: ps(req.params.id) } });
    if (count > 0) {
      res.status(400).json(jiraError([], { category: `Category is used by ${count} project(s).` }));
      return;
    }
    await prisma.projectCategory.delete({ where: { id: ps(req.params.id) } });
    await audit(req, 'projectcategory.deleted', 'projectcategory', ps(req.params.id));
    res.status(204).end();
  })
);

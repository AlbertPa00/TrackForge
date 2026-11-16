import { ps } from '../lib/validation.js';
// Sprint 026 — Jira-shaped dashboard API + TrackForge data endpoints.
// Mount order matters: /search and /gadgets must precede /:id.
import { Router, type Router as RouterType } from 'express';
import { ah, pageParams } from '../lib/http.js';
import {
  listDashboards,
  createDashboard,
  getDashboard,
  updateDashboard,
  deleteDashboard,
  copyDashboard,
  addGadget,
  updateGadget,
  deleteGadget,
  gadgetRegistry,
  gadgetData,
  dashboardData,
} from '../services/dashboardService.js';
import { qs } from '../lib/validation.js';

export const dashboardRouter: RouterType = Router();

dashboardRouter.get(
  '/',
  ah(async (req, res) => {
    const dashboards = await listDashboards(req.actor!);
    res.json({ startAt: 0, maxResults: 1000, total: dashboards.length, dashboards });
  })
);

dashboardRouter.post(
  '/',
  ah(async (req, res) => {
    res.status(201).json(await createDashboard(req.actor!, req.body ?? {}));
  })
);

// GET /rest/api/2/dashboard/search?dashboardName=&owner=&startAt=&maxResults=
dashboardRouter.get(
  '/search',
  ah(async (req, res) => {
    const all = await listDashboards(req.actor!);
    const nameQ = String(qs(req.query.dashboardName) ?? '').toLowerCase();
    const ownerQ = String(qs(req.query.owner) ?? '').toLowerCase();
    const filtered = all.filter(
      (d) =>
        (!nameQ || d.name.toLowerCase().includes(nameQ)) && (!ownerQ || d.owner.name.toLowerCase().includes(ownerQ))
    );
    const { startAt, maxResults } = pageParams(req, { cap: 100, default: 50 });
    const values = filtered.slice(startAt, startAt + maxResults);
    res.json({
      startAt,
      maxResults,
      total: filtered.length,
      isLast: startAt + maxResults >= filtered.length,
      values,
    });
  })
);

// GET /rest/api/2/dashboard/gadgets — the available gadget-type registry.
dashboardRouter.get('/gadgets', (_req, res) => {
  res.json({ gadgets: gadgetRegistry() });
});

dashboardRouter.get(
  '/:id',
  ah(async (req, res) => {
    res.json(await getDashboard(req.actor!, ps(req.params.id)));
  })
);

dashboardRouter.put(
  '/:id',
  ah(async (req, res) => {
    res.json(await updateDashboard(req.actor!, ps(req.params.id), req.body ?? {}));
  })
);

dashboardRouter.delete(
  '/:id',
  ah(async (req, res) => {
    await deleteDashboard(req.actor!, ps(req.params.id));
    res.status(204).end();
  })
);

dashboardRouter.post(
  '/:id/copy',
  ah(async (req, res) => {
    res.status(201).json(await copyDashboard(req.actor!, ps(req.params.id), req.body?.name));
  })
);

dashboardRouter.post(
  '/:id/gadget',
  ah(async (req, res) => {
    res.status(201).json(await addGadget(req.actor!, ps(req.params.id), req.body ?? {}));
  })
);

dashboardRouter.put(
  '/:id/gadget/:gid',
  ah(async (req, res) => {
    res.json(await updateGadget(req.actor!, ps(req.params.id), ps(req.params.gid), req.body ?? {}));
  })
);

dashboardRouter.delete(
  '/:id/gadget/:gid',
  ah(async (req, res) => {
    await deleteGadget(req.actor!, ps(req.params.id), ps(req.params.gid));
    res.status(204).end();
  })
);

export const dashboardDataRouter: RouterType = Router();

// TrackForge extensions — aggregate + per-gadget data, resolved as the viewer.
dashboardDataRouter.get(
  '/dashboards/:id/data',
  ah(async (req, res) => {
    res.json(await dashboardData(req.actor!, ps(req.params.id)));
  })
);

dashboardDataRouter.get(
  '/dashboards/:id/gadgets/:gid/data',
  ah(async (req, res) => {
    res.json(await gadgetData(req.actor!, ps(req.params.id), ps(req.params.gid)));
  })
);

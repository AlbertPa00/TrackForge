import { ps } from '../lib/validation.js';
// 050 — Docs portal API. Mounted BEFORE the /api/internal requireAuth gate:
// the router resolves an optional actor itself and audience-filters per page
// (public → anyone; authed → login or DOCS_PUBLIC=on; admin → admin only).
import { Router, type Router as RouterType } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { getPage, listPages, searchDocs, searchIndex, audienceAllowed } from '../services/docsService.js';
import { openApiDocument } from '../lib/openapi.js';
import { jiraError } from '../lib/errors.js';

export const docsRouter: RouterType = Router();
docsRouter.use(optionalAuth);

docsRouter.get('/manifest', (req, res) => {
  res.json(listPages(req.actor ?? null));
});

docsRouter.get('/index', (req, res) => {
  res.json({ index: searchIndex(req.actor ?? null) });
});

// The rendered spec is 'authed' audience — DOCS_PUBLIC=on opens it too
// (US4: the explorer renders the SERVED spec, FR-004, not a copy).
docsRouter.get('/openapi.json', (req, res) => {
  if (!audienceAllowed('authed', req.actor ?? null)) {
    res.status(404).json(jiraError(['Not found.']));
    return;
  }
  res.json(openApiDocument());
});

docsRouter.get('/search', (req, res) => {
  res.json({ results: searchDocs(String(req.query.q ?? ''), req.actor ?? null) });
});

docsRouter.get('/page/:slug', (req, res, next) => {
  try {
    res.json(getPage(ps(req.params.slug), req.actor ?? null));
  } catch (e) {
    next(e);
  }
});

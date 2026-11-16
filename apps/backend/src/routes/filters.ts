import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType, type Request, type NextFunction } from 'express';
import {
  createFilter,
  updateFilter,
  deleteFilter,
  getFilter,
  listMyFilters,
  listFavouriteFilters,
  listVisibleFilters,
  setFavourite,
  getDefaultShareScope,
  setDefaultShareScope,
  listSharePermissions,
  addSharePermission,
  getSharePermission,
  deleteSharePermission,
} from '../services/filterService.js';
import { executeSearch } from '../services/searchService.js';
import { jiraError } from '../lib/errors.js';
import { qs, formatZodErrors, filterSchema, createFilterSchema } from '../lib/validation.js';
import { JqlParseError } from '../jql/parser.js';
import { JiraApiError } from '../lib/errors.js';
import type { Response } from 'express';
import { ah, pageParams } from '../lib/http.js';

const router: RouterType = Router();

const filterInputSchema = filterSchema;
const createSchema = createFilterSchema;

function handleJqlParse(res: Response, err: unknown) {
  if (err instanceof JqlParseError) {
    res.status(400).json(jiraError([err.message]));
    return true;
  }
  return false;
}

// POST /filter — create
router.post('/', async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const visibility =
      parsed.data.visibility ?? (parsed.data.sharePermissions?.some((p) => p.type === 'global') ? 'all' : 'private');
    const filter = await createFilter(req.actor!, { ...parsed.data, visibility });
    res.status(201).json(filter);
  } catch (err) {
    if (!handleJqlParse(res, err)) next(err);
  }
});

// GET /filter/my
router.get(
  '/my',
  ah(async (req, res) => {
    res.json(await listMyFilters(req.actor!));
  })
);

// GET /filter/favourite (+ Jira 'favorite' spelling)
const listFavourites = async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listFavouriteFilters(req.actor!));
  } catch (err) {
    next(err);
  }
};
router.get('/favourite', listFavourites);
router.get('/favorite', listFavourites);

// GET /filter/search?filterName= — list visible filters (Jira-like)
router.get(
  '/search',
  ah(async (req, res) => {
    const name = String(qs(req.query.filterName) ?? '');
    res.json(await listVisibleFilters(req.actor!, name));
  })
);

// GET/PUT /filter/defaultShareScope — Jira per-user default for new filters
router.get(
  '/defaultShareScope',
  ah(async (req, res) => {
    res.json(await getDefaultShareScope(req.actor!));
  })
);
router.put(
  '/defaultShareScope',
  ah(async (req, res) => {
    res.json(await setDefaultShareScope(req.actor!, req.body?.scope));
  })
);

// GET /filter/{id}
router.get(
  '/:id',
  ah(async (req, res) => {
    res.json(await getFilter(req.actor!, ps(req.params.id)));
  })
);

// GET /filter/{id}/run — convenience: execute a saved filter
router.get('/:id/run', async (req, res, next) => {
  try {
    const filter = await getFilter(req.actor!, ps(req.params.id));
    const { startAt, maxResults } = pageParams(req, { cap: 100, default: 50 });
    res.json(
      await executeSearch(req.actor!, {
        jql: filter.jql,
        startAt,
        maxResults,
        fields: undefined,
        expand: undefined,
      })
    );
  } catch (err) {
    if (err instanceof JiraApiError) {
      res.status(err.status).json(err.response);
      return;
    }
    next(err);
  }
});

// PUT /filter/{id}
router.put('/:id', async (req, res, next) => {
  try {
    const parsed = filterInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const visibility =
      parsed.data.visibility ??
      (parsed.data.sharePermissions
        ? parsed.data.sharePermissions.some((p) => p.type === 'global')
          ? 'all'
          : 'private'
        : undefined);
    res.json(await updateFilter(req.actor!, ps(req.params.id), { ...parsed.data, visibility }));
  } catch (err) {
    if (!handleJqlParse(res, err)) next(err);
  }
});

// DELETE /filter/{id}
router.delete(
  '/:id',
  ah(async (req, res) => {
    await deleteFilter(req.actor!, ps(req.params.id));
    res.status(204).send();
  })
);

// Jira /filter/{id}/permission — share-permission management (owner/admin)
router.get(
  '/:id/permission',
  ah(async (req, res) => {
    res.json(await listSharePermissions(req.actor!, ps(req.params.id)));
  })
);

router.post(
  '/:id/permission',
  ah(async (req, res) => {
    res.status(201).json(await addSharePermission(req.actor!, ps(req.params.id), req.body ?? {}));
  })
);

router.get(
  '/:id/permission/:permId',
  ah(async (req, res) => {
    res.json(await getSharePermission(req.actor!, ps(req.params.id), ps(req.params.permId)));
  })
);

router.delete(
  '/:id/permission/:permId',
  ah(async (req, res) => {
    await deleteSharePermission(req.actor!, ps(req.params.id), ps(req.params.permId));
    res.status(204).send();
  })
);

// PUT/DELETE /filter/{id}/favourite — TrackForge convenience (documented divergence)
router.put(
  '/:id/favourite',
  ah(async (req, res) => {
    res.json(await setFavourite(req.actor!, ps(req.params.id), true));
  })
);

router.delete(
  '/:id/favourite',
  ah(async (req, res) => {
    res.json(await setFavourite(req.actor!, ps(req.params.id), false));
  })
);

export default router;

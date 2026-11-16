import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import { listStatuses, listPriorities, listIssueTypes, listFields } from '../services/metaService.js';
import { getMyself } from '../services/userService.js';
import { openApiDocument } from '../lib/openapi.js';
import {
  listLinkTypes,
  createLink,
  previewLink,
  deleteLink,
  listResolutions,
  listLabels,
} from '../services/linkService.js';
import { issueLinkSchema, formatZodErrors } from '../lib/validation.js';
import { jiraError } from '../lib/errors.js';
import { ah, markDryRun, isDryRun, pageParams } from '../lib/http.js';

const router: RouterType = Router();

router.get(
  '/status',
  ah(async (_req, res) => {
    res.json(await listStatuses());
  })
);

router.get(
  '/priority',
  ah(async (_req, res) => {
    res.json(await listPriorities());
  })
);

router.get(
  '/issuetype',
  ah(async (_req, res) => {
    res.json(await listIssueTypes());
  })
);

router.get('/myself', (req, res) => {
  res.json(getMyself(req.actor!.user));
});

router.get(
  '/field',
  ah(async (_req, res) => {
    res.json(await listFields());
  })
);

// Jira GET /workflow — paged list of workflows (names only).
router.get(
  '/workflow',
  ah(async (_req, res) => {
    const { prisma } = await import('../prisma.js');
    const workflows = await prisma.workflow.findMany({ orderBy: { name: 'asc' } });
    res.json({
      startAt: 0,
      maxResults: 50,
      total: workflows.length,
      isLast: true,
      values: workflows.map((w) => ({ name: w.name, default: w.name === 'Simple' })),
    });
  })
);

router.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument());
});

// --- Sprint 008 metadata: resolutions, labels, issue links ---

router.get(
  '/resolution',
  ah(async (_req, res) => {
    res.json(await listResolutions());
  })
);

router.get(
  '/label',
  ah(async (req, res) => {
    const { startAt, maxResults } = pageParams(req, { cap: 1000, default: 100 });
    res.json(await listLabels(startAt, maxResults));
  })
);

router.get(
  '/issueLinkType',
  ah(async (_req, res) => {
    res.json(await listLinkTypes());
  })
);

router.post(
  '/issueLink',
  ah(async (req, res) => {
    const parsed = issueLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const { type, outwardIssue, inwardIssue } = parsed.data;
    const typeRef = type.name ?? type.id;
    if (!typeRef) {
      res.status(400).json(jiraError([], { type: 'Provide type.name or type.id.' }));
      return;
    }
    if (isDryRun(req)) {
      // 052 — dryRun preview: full validation, zero writes.
      markDryRun(res);
      res
        .status(200)
        .json(await previewLink(typeRef, outwardIssue.key.toUpperCase(), inwardIssue.key.toUpperCase(), req.actor!));
      return;
    }
    const link = await createLink(typeRef, outwardIssue.key.toUpperCase(), inwardIssue.key.toUpperCase(), req.actor!);
    // Jira returns bare 201 — the id is additive so timeline clients can undo.
    res.status(201).json({ id: link.id });
  })
);

router.delete(
  '/issueLink/:id',
  ah(async (req, res) => {
    await deleteLink(ps(req.params.id), req.actor!);
    res.status(204).send();
  })
);

export default router;

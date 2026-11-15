import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import {
  createBoard,
  createQuickFilter,
  deleteBoard,
  deleteQuickFilter,
  getBoard,
  getBoardConfiguration,
  getCardConfig,
  getQuickFilter,
  listBoardIssues,
  listBoards,
  listQuickFilters,
  setBoardType,
  setCardConfig,
  setDefaultBoard,
  updateBoard,
  updateBoardConfiguration,
  updateQuickFilter,
} from '../services/boardService.js';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import { enforceBoardScope, projectAllowed } from '../middleware/auth.js';
import { hasPermission } from '../services/permissionService.js';
import { prisma } from '../prisma.js';
import { ah, pageParams } from '../lib/http.js';

const router: RouterType = Router();

router.get(
  '/',
  ah(async (req, res) => {
    const keyOrId = String(req.query.projectKeyOrId ?? '').trim();
    let boards = await listBoards(keyOrId || undefined);
    // Token allow-list + BROWSE_PROJECTS filter — scoped tokens see only their
    // projects' boards (Sprint 020 leak gate).
    const visible = [];
    for (const b of boards) {
      if (!projectAllowed(req.actor!, b.location.projectKey)) continue;
      const project = await prisma.project.findUnique({ where: { key: b.location.projectKey }, select: { id: true } });
      if (project && !(await hasPermission(req.actor!, 'BROWSE_PROJECTS', { projectId: project.id }))) continue;
      visible.push(b);
    }
    boards = visible;
    res.json({ maxResults: 50, startAt: 0, total: boards.length, isLast: true, values: boards });
  })
);

const createBoardSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['scrum', 'kanban']).optional(),
  filterId: z.string().optional(),
  location: z.object({ type: z.string().optional(), projectKeyOrId: z.string().min(1) }).optional(),
});

// Jira POST /rest/agile/1.0/board (033 multi-board).
router.post(
  '/',
  ah(async (req, res) => {
    const parsed = createBoardSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.status(201).json(await createBoard(req.actor!, parsed.data));
  })
);

// Jira DELETE /rest/agile/1.0/board/{id}. Deleting the default requires
// ?promoteTo=<boardId> unless it's the project's last board.
router.delete(
  '/:boardId',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    await deleteBoard(req.actor!, req.params.boardId, req.query.promoteTo ? String(req.query.promoteTo) : undefined);
    res.status(204).end();
  })
);

// Jira GET /board/{id}/quickfilter and /quickfilter/{qfId} (033 — read-only).
router.get(
  '/:boardId/quickfilter',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    res.json(await listQuickFilters(req.params.boardId));
  })
);

router.get(
  '/:boardId/quickfilter/:qfId',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    res.json(await getQuickFilter(req.params.boardId, req.params.qfId));
  })
);

// TF-native GET card config (colors/indicators/daysInColumn/hideDone/swimlaneBy).
router.get(
  '/:boardId/cardconfig',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    res.json(await getCardConfig(req.params.boardId));
  })
);

router.get(
  '/:boardId',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    res.json(await getBoard(req.params.boardId));
  })
);

router.get(
  '/:boardId/configuration',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    res.json(await getBoardConfiguration(req.params.boardId));
  })
);

const columnSchema = z.object({
  columns: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(64),
          statusIds: z.array(z.string()).min(1),
          min: z.number().int().min(0).nullable().optional(),
          max: z.number().int().min(1).nullable().optional(),
        })
        .refine((c) => c.min == null || c.max == null || c.min <= c.max, {
          // 062 US2 — inverted WIP limits used to save silently.
          message: 'Max must be greater than or equal to Min.',
          path: ['max'],
        })
    )
    .min(1),
});

const typeSchema = z.object({ type: z.enum(['scrum', 'kanban']) });

router.put(
  '/:boardId/configuration',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const parsed = columnSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await updateBoardConfiguration(req.params.boardId, parsed.data.columns, req.actor));
  })
);

// TrackForge-native: flip board.type (scrum↔kanban) with open-sprint guard.
router.put(
  '/:boardId/type',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const parsed = typeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await setBoardType(req.params.boardId, parsed.data.type, req.actor));
  })
);

// GET /rest/agile/1.0/board/{id}/reports — Jira's report list (027).
// Jira returns the reports available for this board; ours links into the
// /api/internal/reports data endpoints.
router.get(
  '/:boardId/reports',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const id = encodeURIComponent(req.params.boardId);
    res.json([
      { key: 'burndown', name: 'Burndown Chart', url: `/api/internal/reports/board/${id}/burndown` },
      { key: 'velocity', name: 'Velocity Chart', url: `/api/internal/reports/board/${id}/velocity` },
      { key: 'cfd', name: 'Cumulative Flow Diagram', url: `/api/internal/reports/cfd/${id}` },
      { key: 'control', name: 'Control Chart', url: `/api/internal/reports/control/${id}` },
      {
        key: 'sprint-report',
        name: 'Sprint Report',
        url: `/api/internal/reports/board/${id}/sprint/{sprintId}/report`,
      },
    ]);
  })
);

router.get(
  '/:boardId/issue',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const { startAt, maxResults } = pageParams(req, { cap: 200, default: 200 });
    const quickFilterIds = req.query.quickFilterIds
      ? String(req.query.quickFilterIds)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    res.json(await listBoardIssues(req.params.boardId, { startAt, maxResults }, req.actor, { quickFilterIds }));
  })
);

// ---------- 033: TF-native write surface (/api/internal/boards) ----------

export const boardInternalRouter: RouterType = Router();

const renameSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  filterId: z.string().nullable().optional(),
  filter: z.string().nullable().optional(),
});
const qfSchema = z.object({
  name: z.string().min(1).max(128),
  jql: z.string().min(1).max(4000),
  position: z.number().int().optional(),
});
const qfPatchSchema = qfSchema.partial();

boardInternalRouter.put(
  '/:boardId',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await updateBoard(req.actor!, req.params.boardId, parsed.data));
  })
);

boardInternalRouter.post(
  '/:boardId/default',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    res.json(await setDefaultBoard(req.actor!, req.params.boardId));
  })
);

boardInternalRouter.put(
  '/:boardId/cardconfig',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      res.status(400).json(jiraError([], { cardConfig: 'object expected' }));
      return;
    }
    res.json(await setCardConfig(req.actor!, req.params.boardId, req.body));
  })
);

boardInternalRouter.post(
  '/:boardId/quickfilters',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const parsed = qfSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.status(201).json(await createQuickFilter(req.actor!, req.params.boardId, parsed.data));
  })
);

boardInternalRouter.put(
  '/:boardId/quickfilters/:qfId',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const parsed = qfPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await updateQuickFilter(req.actor!, req.params.boardId, req.params.qfId, parsed.data));
  })
);

boardInternalRouter.delete(
  '/:boardId/quickfilters/:qfId',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    await deleteQuickFilter(req.actor!, req.params.boardId, req.params.qfId);
    res.status(204).end();
  })
);

export default router;

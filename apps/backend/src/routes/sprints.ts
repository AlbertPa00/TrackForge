import { Router, type Router as RouterType } from 'express';
import {
  createSprint,
  listSprints,
  getSprint,
  updateSprint,
  deleteSprint,
  listSprintIssues,
  moveIssuesToSprint,
  moveIssuesToBacklog,
} from '../services/sprintService.js';
import { createSprintSchema, updateSprintSchema, issueKeysSchema, formatZodErrors } from '../lib/validation.js';
import { jiraError } from '../lib/errors.js';
import { rankIssues, previewRankIssues, listBacklog } from '../services/boardService.js';
import { getIssueByKey, toIssueResponse, parseSelection, expandIssueResponse } from '../services/issueService.js';
import { getEpic, listEpicIssues, moveIssuesToEpic, removeIssuesFromEpic } from '../services/epicService.js';
import { z } from 'zod';
import { enforceBoardScope, enforceIssueScope, enforceSprintScope, projectAllowed } from '../middleware/auth.js';
import { ah, markDryRun, isDryRun, pageParams } from '../lib/http.js';

export const sprintRouter: RouterType = Router();
export const backlogRouter: RouterType = Router();

const rankSchema = z.object({
  issues: z.array(z.string()).min(1),
  rankBeforeIssue: z.string().optional(),
  rankAfterIssue: z.string().optional(),
});

/** 404 if any issue key falls outside the token's project allow-list. */
function keysAllowed(
  keys: string[],
  actor: Parameters<typeof projectAllowed>[0],
  res: import('express').Response
): boolean {
  const bad = keys.find((k) => !projectAllowed(actor, k.split('-')[0] ?? ''));
  if (bad !== undefined) {
    res.status(404).json(jiraError([`Issue ${bad} does not exist or you do not have permission to see it.`]));
    return false;
  }
  return true;
}

// GET /issue/{key} — agile issue view (same shape as /rest/api/2/issue).
sprintRouter.get(
  '/issue/:key',
  ah(async (req, res) => {
    await enforceIssueScope(req.params.key, req.actor!);
    const issue = await getIssueByKey(req.params.key);
    res.json(
      await expandIssueResponse(
        toIssueResponse(issue) as Record<string, unknown>,
        issue,
        parseSelection(req.query.expand)
      )
    );
  })
);

sprintRouter.put(
  '/issue/rank',
  ah(async (req, res) => {
    const parsed = rankSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (
      !keysAllowed(
        [...parsed.data.issues, parsed.data.rankBeforeIssue, parsed.data.rankAfterIssue].filter((k): k is string =>
          Boolean(k)
        ),
        req.actor!,
        res
      )
    )
      return;
    if (isDryRun(req)) {
      // 052 — rank preview: same guards, zero writes.
      markDryRun(res);
      res.json(await previewRankIssues(parsed.data, req.actor!));
      return;
    }
    res.json(await rankIssues(parsed.data, req.actor!));
  })
);

sprintRouter.post(
  '/sprint',
  ah(async (req, res) => {
    const parsed = createSprintSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    await enforceBoardScope(parsed.data.originBoardId, req.actor!);
    res.status(201).json(await createSprint(parsed.data, req.actor!));
  })
);

sprintRouter.get(
  '/sprint/:id',
  ah(async (req, res) => {
    await enforceSprintScope(req.params.id, req.actor!);
    res.json(await getSprint(req.params.id));
  })
);

const updateSprintHandler = async (
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction
) => {
  try {
    await enforceSprintScope(req.params.id, req.actor!);
    const parsed = updateSprintSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await updateSprint(req.params.id, parsed.data, req.actor!));
  } catch (err) {
    next(err);
  }
};

sprintRouter.put('/sprint/:id', updateSprintHandler);
sprintRouter.post('/sprint/:id', updateSprintHandler);

sprintRouter.delete(
  '/sprint/:id',
  ah(async (req, res) => {
    await enforceSprintScope(req.params.id, req.actor!);
    await deleteSprint(req.params.id, req.actor!);
    res.status(204).send();
  })
);

sprintRouter.get(
  '/sprint/:id/issue',
  ah(async (req, res) => {
    await enforceSprintScope(req.params.id, req.actor!);
    const { startAt, maxResults } = pageParams(req, { cap: 200, default: 200 });
    const quickFilterIds = req.query.quickFilterIds
      ? String(req.query.quickFilterIds)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    res.json(await listSprintIssues(req.params.id, { startAt, maxResults }, req.actor, { quickFilterIds }));
  })
);

sprintRouter.post(
  '/sprint/:id/issue',
  ah(async (req, res) => {
    await enforceSprintScope(req.params.id, req.actor!);
    const parsed = issueKeysSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (!keysAllowed(parsed.data.issues, req.actor!, res)) return;
    await moveIssuesToSprint(req.params.id, parsed.data.issues, req.actor!);
    res.status(204).send();
  })
);

sprintRouter.get(
  '/board/:boardId/sprint',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const stateParam = String(req.query.state ?? '');
    const states = stateParam
      ? stateParam
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const sprints = await listSprints(req.params.boardId, states);
    res.json({ maxResults: 50, startAt: 0, total: sprints.length, isLast: true, values: sprints });
  })
);

sprintRouter.get(
  '/board/:boardId/backlog',
  ah(async (req, res) => {
    await enforceBoardScope(req.params.boardId, req.actor!);
    const { startAt, maxResults } = pageParams(req, { cap: 200, default: 50 });
    const quickFilterIds = req.query.quickFilterIds
      ? String(req.query.quickFilterIds)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    res.json(await listBacklog(req.params.boardId, { startAt, maxResults }, req.actor, { quickFilterIds }));
  })
);

backlogRouter.post(
  '/issue',
  ah(async (req, res) => {
    const parsed = issueKeysSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (!keysAllowed(parsed.data.issues, req.actor!, res)) return;
    await moveIssuesToBacklog(parsed.data.issues, req.actor!);
    res.status(204).send();
  })
);

// ---------- epics (/rest/agile/1.0/epic/{key}) ----------
// /epic/none/issue must precede /epic/:key/issue or 'none' binds to :key.

sprintRouter.post(
  '/epic/none/issue',
  ah(async (req, res) => {
    const parsed = issueKeysSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (!keysAllowed(parsed.data.issues, req.actor!, res)) return;
    await removeIssuesFromEpic(parsed.data.issues, req.actor!);
    res.status(204).send();
  })
);

sprintRouter.get(
  '/epic/:key',
  ah(async (req, res) => {
    await enforceIssueScope(req.params.key, req.actor!);
    res.json(await getEpic(req.params.key));
  })
);

sprintRouter.get(
  '/epic/:key/issue',
  ah(async (req, res) => {
    await enforceIssueScope(req.params.key, req.actor!);
    const { startAt, maxResults } = pageParams(req, { cap: 200, default: 50 });
    res.json(await listEpicIssues(req.params.key, { startAt, maxResults }, req.actor!));
  })
);

sprintRouter.post(
  '/epic/:key/issue',
  ah(async (req, res) => {
    const parsed = issueKeysSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (!keysAllowed(parsed.data.issues, req.actor!, res)) return;
    if (req.params.key.toLowerCase() !== 'none') await enforceIssueScope(req.params.key, req.actor!);
    if (req.params.key.toLowerCase() === 'none') {
      await removeIssuesFromEpic(parsed.data.issues, req.actor!);
    } else {
      await moveIssuesToEpic(req.params.key, parsed.data.issues, req.actor!);
    }
    res.status(204).send();
  })
);

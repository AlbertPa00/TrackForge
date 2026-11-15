import { Router } from 'express';
import { getRoadmap } from '../services/roadmapService.js';
import { ah } from '../lib/http.js';

/** 041 — planning-view feed: /api/internal/roadmap/{boardId}?level=issues */
export const roadmapRouter: Router = Router();

const q = (req: { query: Record<string, unknown> }, k: string) =>
  typeof req.query[k] === 'string' ? (req.query[k] as string) : undefined;

roadmapRouter.get(
  '/:boardId',
  ah(async (req, res) => {
    res.json(
      await getRoadmap(req.params.boardId, req.actor!, {
        level: q(req, 'level'),
        status: q(req, 'status'),
        assignee: q(req, 'assignee'),
        label: q(req, 'label'),
        component: q(req, 'component'),
      })
    );
  })
);

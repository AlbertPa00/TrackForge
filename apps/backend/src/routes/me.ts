// /api/internal/me/* — user-context surface: notifications, recent views,
// "Your work". Powers the bell + home page; all scoped to the caller.

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import { listNotifications, markRead } from '../services/notificationService.js';
import { getIssueByKey, toIssueResponse } from '../services/issueService.js';
import { getMyWork, getMyTimesheet } from '../services/meService.js';
import { canSeeIssueFull, visibleIssueWhere } from '../services/visibilityService.js';
import { ah, pageParams } from '../lib/http.js';
import {
  getProfile,
  updateProfile,
  changePassword,
  listSessions,
  revokeSession,
  totpEnroll,
  totpVerify,
  totpDisable,
  regenerateBackupCodes,
} from '../services/identityService.js';

export const meRouter: RouterType = Router();

const issueSelect = {
  project: true,
  issueType: true,
  status: true,
  priority: true,
  sprint: true,
  assignee: true,
  reporter: true,
} as const;

// GET /api/internal/me/notifications?unreadOnly=true&startAt=&maxResults=
meRouter.get(
  '/notifications',
  ah(async (req, res) => {
    const result = await listNotifications(req.actor!.user.id, {
      unreadOnly: String(req.query.unreadOnly ?? '') === 'true',
      ...pageParams(req, { cap: 100 }),
    });
    res.json(result);
  })
);

// POST /api/internal/me/notifications/read — { ids?: string[] } or { all: true }
meRouter.post(
  '/notifications/read',
  ah(async (req, res) => {
    const parsed = z
      .object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const count = await markRead(req.actor!.user.id, parsed.data.ids, parsed.data.all === true);
    res.json({ marked: count });
  })
);

// POST /api/internal/me/recent-views — body { issueKey }
meRouter.post(
  '/recent-views',
  ah(async (req, res) => {
    const key = String(req.body?.issueKey ?? '').toUpperCase();
    if (!key) {
      res.status(400).json(jiraError(['issueKey is required.']));
      return;
    }
    const issue = await getIssueByKey(key);
    // 064 US3 — recording a view requires actually being able to see the issue.
    if (!(await canSeeIssueFull(req.actor!, issue))) {
      res.status(404).json(jiraError(['Issue does not exist or you do not have permission to see it.']));
      return;
    }
    await prisma.recentView.upsert({
      where: { userId_issueId: { userId: req.actor!.user.id, issueId: issue.id } },
      create: { userId: req.actor!.user.id, issueId: issue.id },
      update: { viewedAt: new Date() },
    });
    res.status(204).send();
  })
);

// GET /api/internal/me/recent-views — last 10 viewed issues
meRouter.get(
  '/recent-views',
  ah(async (req, res) => {
    const views = await prisma.recentView.findMany({
      where: { userId: req.actor!.user.id, issue: await visibleIssueWhere(req.actor!) },
      orderBy: { viewedAt: 'desc' },
      take: 10,
      include: { issue: { include: issueSelect } },
    });
    res.json({
      issues: views.map((v) => ({ viewedAt: v.viewedAt.toISOString(), ...toIssueResponse(v.issue as never) })),
    });
  })
);

// GET /api/internal/me/work — "Your work": assigned, watched, reported, recents
meRouter.get(
  '/work',
  ah(async (req, res) => {
    res.json(await getMyWork(req.actor!));
  })
);

// GET /api/internal/me/timesheet?from=YYYY-MM-DD&to=YYYY-MM-DD — the caller's
// own timesheet: total + per-day + per-issue seconds for the "Time logged"
// card. Defaults to the current calendar month.
meRouter.get(
  '/timesheet',
  ah(async (req, res) => {
    const parsed = z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(await getMyTimesheet(req.actor!, parsed.data));
  })
);

// ---------- Sprint 036: profile, password, sessions, TOTP ----------

// GET /me — profile card: identity + open issues + recent comments.
meRouter.get(
  '/',
  ah(async (req, res) => {
    res.json(await getProfile(req.actor!.user.id));
  })
);

// PUT /me — display name / locale / timezone / date format.
meRouter.put(
  '/',
  ah(async (req, res) => {
    res.json(await updateProfile(req.actor!.user.id, req.body ?? {}));
  })
);

// PUT /me/password — change own password (revokes other sessions).
meRouter.put(
  '/password',
  ah(async (req, res) => {
    const { current, new: next } = req.body ?? {};
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.actor!.user.id } });
    await changePassword(user, String(current ?? ''), String(next ?? ''), req.sessionId);
    res.status(204).end();
  })
);

// GET /me/sessions — active sessions, `current` flagged.
meRouter.get(
  '/sessions',
  ah(async (req, res) => {
    res.json(await listSessions(req.actor!.user.id, req.sessionId));
  })
);

// DELETE /me/sessions/:id
meRouter.delete(
  '/sessions/:id',
  ah(async (req, res) => {
    await revokeSession(req.actor!.user.id, req.params.id);
    res.status(204).end();
  })
);

// POST /me/totp — begin enrollment: returns secret + otpauth URL (not enabled yet).
meRouter.post(
  '/totp',
  ah(async (req, res) => {
    res.json(await totpEnroll(req.actor!.user.id));
  })
);

// POST /me/totp/verify — confirm a code → enables 2FA, returns backup codes once.
meRouter.post(
  '/totp/verify',
  ah(async (req, res) => {
    res.json(await totpVerify(req.actor!.user.id, String(req.body?.code ?? '')));
  })
);

// DELETE /me/totp — disable (requires current code).
meRouter.delete(
  '/totp',
  ah(async (req, res) => {
    await totpDisable(req.actor!.user.id, String(req.body?.code ?? ''));
    res.status(204).end();
  })
);

// POST /me/totp/backup-codes — regenerate (requires current code).
meRouter.post(
  '/totp/backup-codes',
  ah(async (req, res) => {
    res.json(await regenerateBackupCodes(req.actor!.user.id, String(req.body?.code ?? '')));
  })
);

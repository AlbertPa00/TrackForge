// Sprint 029 — email & notification scheme endpoints.
// Admin: scheme CRUD + project assignment + mail config/test + outbox.
// User: prefs + filter subscriptions. Public: unsubscribe-by-token.

import { Router, urlencoded, type Router as RouterType } from 'express';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  listSchemes,
  createScheme,
  updateScheme,
  deleteScheme,
  assignScheme,
  getMailConfig,
  setMailConfig,
  getMailAdapter,
  getNotifyPrefs,
  setNotifyPrefs,
  listSubscriptions,
  subscribeFilter,
  unsubscribe,
} from '../services/mailService.js';
import { ah, pageParams } from '../lib/http.js';

export const notificationSchemeRouter: RouterType = Router(); // /api/internal/notificationschemes
export const mailAdminRouter: RouterType = Router(); // /api/internal/admin
export const projectSchemeRouter: RouterType = Router(); // /api/internal/projects
export const meNotifyRouter: RouterType = Router(); // /api/internal/me
export const filterSubRouter: RouterType = Router(); // /api/internal/filters
export const unsubRouter: RouterType = Router(); // /unsubscribe (public)

/* ------------------------------ schemes ------------------------------ */

notificationSchemeRouter.get(
  '/',
  requireAdmin,
  ah(async (_req, res) => {
    res.json({ schemes: await listSchemes() });
  })
);

notificationSchemeRouter.post(
  '/',
  requireAdmin,
  ah(async (req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new JiraApiError(400, jiraError(['name is required.']));
    res.status(201).json(await createScheme(b));
  })
);

notificationSchemeRouter.get(
  '/:id',
  requireAdmin,
  ah(async (req, res) => {
    const s = await prisma.notificationScheme.findUnique({ where: { id: req.params.id }, include: { entries: true } });
    if (!s) throw new JiraApiError(404, jiraError(['Notification scheme does not exist.']));
    res.json(s);
  })
);

notificationSchemeRouter.put(
  '/:id',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await updateScheme(req.params.id, req.body ?? {}));
  })
);

notificationSchemeRouter.delete(
  '/:id',
  requireAdmin,
  ah(async (req, res) => {
    await deleteScheme(req.params.id);
    res.status(204).end();
  })
);

/* ------------------- project scheme assignment ------------------- */

projectSchemeRouter.post(
  '/:key/notificationscheme',
  requireAdmin,
  ah(async (req, res) => {
    res.json(await assignScheme(req.params.key, (req.body?.schemeId as string) ?? null));
  })
);

/* ------------------------------ mail admin ------------------------------ */

// 065 audit F2 — the SMTP password never leaves this surface, masked on read
// AND on write responses.
const mailConfigView = (cfg: Awaited<ReturnType<typeof getMailConfig>>) => ({
  ...cfg,
  pass: cfg.pass ? '•••' : undefined,
  envOverrides: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_TLS', 'BASE_URL'].filter(
    (k) => process.env[k]
  ),
});

mailAdminRouter.get(
  '/mail',
  requireAdmin,
  ah(async (_req, res) => {
    res.json(mailConfigView(await getMailConfig()));
  })
);

mailAdminRouter.put(
  '/mail',
  requireAdmin,
  ah(async (req, res) => {
    await setMailConfig(req.body ?? {});
    res.json(mailConfigView(await getMailConfig()));
  })
);

mailAdminRouter.post(
  '/mail/test',
  requireAdmin,
  ah(async (req, res) => {
    const to = String(req.body?.to ?? req.actor?.user.email ?? '');
    try {
      await getMailAdapter().send({
        to,
        subject: '[TrackForge] SMTP test',
        html: '<p>TrackForge SMTP configuration test — if you see this, mail works.</p>',
        text: 'TrackForge SMTP configuration test.',
      });
      res.json({ ok: true, to });
    } catch (e) {
      // failures surface the SMTP error verbatim (US1 AC1)
      throw new JiraApiError(502, jiraError([`SMTP send failed: ${String(e)}`]));
    }
  })
);

mailAdminRouter.get(
  '/outbox',
  requireAdmin,
  ah(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const [total, rows] = await Promise.all([
      prisma.emailOutbox.count({ where: status ? { status } : {} }),
      prisma.emailOutbox.findMany({
        where: status ? { status } : {},
        orderBy: { createdAt: 'desc' },
        take: pageParams(req, { cap: 200 }).maxResults,
      }),
    ]);
    res.json({ total, outbox: rows.map((r) => ({ ...r, eventId: r.eventId === null ? null : Number(r.eventId) })) });
  })
);

/* ------------------------------ user prefs ------------------------------ */

meNotifyRouter.get(
  '/preferences',
  ah(async (req, res) => {
    res.json(await getNotifyPrefs(req.actor!.user.id));
  })
);

meNotifyRouter.put(
  '/preferences',
  ah(async (req, res) => {
    const prefs = req.body ?? {};
    await setNotifyPrefs(req.actor!.user.id, prefs);
    res.json(await getNotifyPrefs(req.actor!.user.id));
  })
);

/* -------------------------- filter subscriptions -------------------------- */

filterSubRouter.get(
  '/unsubscribe',
  ah(async (req, res) => {
    // authenticated variant — token identifies the subscription
    const token = String(req.query.token ?? '');
    await unsubscribe(token);
    res.json({ ok: true });
  })
);

filterSubRouter.get(
  '/:id/subscriptions',
  ah(async (req, res) => {
    res.json({ subscriptions: await listSubscriptions(req.actor!.user.id) });
  })
);

filterSubRouter.post(
  '/:id/subscriptions',
  ah(async (req, res) => {
    const b = req.body ?? {};
    if (b.frequency !== 'daily' && b.frequency !== 'weekly') {
      throw new JiraApiError(400, jiraError(['frequency must be daily|weekly.']));
    }
    res.status(201).json(await subscribeFilter(req.params.id, req.actor!, b));
  })
);

filterSubRouter.delete(
  '/:id/subscriptions/:subId',
  ah(async (req, res) => {
    const sub = await prisma.filterSubscription.findUnique({ where: { id: req.params.subId } });
    if (!sub || sub.userId !== req.actor!.user.id) {
      throw new JiraApiError(404, jiraError(['Subscription does not exist.']));
    }
    await unsubscribe(sub.id);
    res.status(204).end();
  })
);

/* -------------------- public unsubscribe (token = credential) -------------------- */

// 064 US6 — a GET that mutates state gets prefetched by mail scanners,
// unsubscribing users who never clicked. GET renders a confirm page; the
// actual unsubscribe is POST-only.
const unsubPage = (token: string) => `<!doctype html><title>Unsubscribe</title>
<form method="post" action="/unsubscribe"><input type="hidden" name="token" value="${token.replace(/"/g, '&quot;')}">
<p>Unsubscribe from these notifications?</p><button type="submit">Unsubscribe</button></form>`;

unsubRouter.get(
  '/',
  ah(async (req, res) => {
    const token = String(req.query.token ?? '');
    if (!token) return res.status(404).type('html').send('<p>Subscription not found.</p>');
    res.type('html').send(unsubPage(token));
  })
);

unsubRouter.post(
  '/',
  urlencoded({ extended: false, limit: '4kb' }),
  ah(async (req, res) => {
    try {
      await unsubscribe(String(req.body?.token ?? req.query.token ?? ''));
      res.type('html').send('<p>You have been unsubscribed.</p>');
    } catch {
      res.status(404).type('html').send('<p>Subscription not found or already removed.</p>');
    }
  })
);

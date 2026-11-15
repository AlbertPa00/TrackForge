// Sprint 036: identity admin + public auth flows.
//   adminIdpRouter → /api/internal/admin/idps          (site-admin only)
//   identityAuthRouter → /api/internal/auth            (public OIDC/reset)
import { Router, type Router as RouterType } from 'express';
import { z } from 'zod';
import { jiraError, JiraApiError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

import { audit } from '../services/auditService.js';
import { getMailAdapter, getMailConfig } from '../services/mailService.js';
import {
  listIdps,
  upsertIdp,
  beginOidc,
  finishOidc,
  oidcStates,
  requestReset,
  confirmReset,
  confirmInvite,
  createSession,
} from '../services/identityService.js';
import { prisma } from '../prisma.js';
import { signSession, SESSION_COOKIE } from '../lib/auth.js';

import { publicBaseUrl } from '../config.js';
import { ah, resourceSelf } from '../lib/http.js';

export const adminIdpRouter: RouterType = Router();
adminIdpRouter.use(requireAuth, requireAdmin);

const idpSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/),
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  scopes: z.string().optional(),
  claimMap: z.record(z.string()).optional(),
  autoProvision: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

adminIdpRouter.get(
  '/',
  ah(async (_req, res) => res.json(await listIdps()))
);

adminIdpRouter.post(
  '/',
  ah(async (req, res) => {
    const parsed = idpSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const idp = await upsertIdp(parsed.data);
    await audit(req, 'identity.idp.create', 'idp', idp.id, { name: idp.name });
    res.status(201).json(idp);
  })
);

adminIdpRouter.put(
  '/:id',
  ah(async (req, res) => {
    const parsed = idpSchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const idp = await upsertIdp(parsed.data, req.params.id);
    await audit(req, 'identity.idp.update', 'idp', idp.id, { name: idp.name });
    res.json(idp);
  })
);

adminIdpRouter.delete(
  '/:id',
  ah(async (req, res) => {
    await prisma.identityProvider.delete({ where: { id: req.params.id } }).catch(() => {
      throw new JiraApiError(404, jiraError(['Identity provider not found.']));
    });
    await audit(req, 'identity.idp.delete', 'idp', req.params.id);
    res.status(204).end();
  })
);

// ---------- public auth additions ----------

export const identityAuthRouter: RouterType = Router();

const resetRequestSchema = z.object({ email: z.string().email() });
const resetConfirmSchema = z.object({ token: z.string().min(10), newPassword: z.string().min(8) });

async function sendResetMail(email: string, token: string) {
  const cfg = await getMailConfig();
  const link = `${cfg.baseUrl}/login?resetToken=${encodeURIComponent(token)}`;
  await getMailAdapter().send({
    to: email,
    subject: 'Reset your TrackForge password',
    text: `A password reset was requested for this account. If it was you, open this link to choose a new password:\n\n${link}\n\nThe link expires in 1 hour. If you didn't request a reset, ignore this email.`,
    html: `<p>A password reset was requested for this account. If it was you, open this link to choose a new password:</p><p><a href="${link}">${link}</a></p><p>The link expires in 1 hour. If you didn't request a reset, ignore this email.</p>`,
  });
}

// POST /auth/reset-request — always 204 (never reveals account existence). The
// token travels only in the reset email. Dev/test hook: outside production the
// raw token is also exposed via response header so the flow stays testable
// without a mailbox (mirrors x-invite-token).
identityAuthRouter.post(
  '/reset-request',
  ah(async (req, res) => {
    const parsed = resetRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const token = await requestReset(parsed.data.email);
    await audit(req, 'identity.reset.request', 'user', undefined, { email: parsed.data.email.slice(0, 100) });
    if (token) {
      await sendResetMail(parsed.data.email, token).catch(() => {
        /* SMTP unconfigured — admin-driven reset remains the fallback */
      });
    }
    if (process.env.NODE_ENV !== 'production') res.setHeader('x-reset-token', token ?? '');
    res.status(204).end();
  })
);

identityAuthRouter.post(
  '/reset-confirm',
  ah(async (req, res) => {
    const parsed = resetConfirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    await confirmReset(parsed.data.token, parsed.data.newPassword);
    await audit(req, 'identity.reset.confirm', 'user', undefined);
    res.status(204).end();
  })
);

// 060 US5 — invite accept: sets the password and activates the account.
identityAuthRouter.post(
  '/invite-accept',
  ah(async (req, res) => {
    const parsed = resetConfirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new JiraApiError(400, jiraError([], formatZodErrors(parsed.error)));
    const user = await confirmInvite(parsed.data.token, parsed.data.newPassword);
    await audit(req, 'identity.invite.accept', 'user', user.id, { email: user.email });
    res.status(204).end();
  })
);

// GET /auth/idps — public list of enabled IdPs (login page buttons).
identityAuthRouter.get(
  '/idps',
  ah(async (_req, res) => {
    res.json((await listIdps()).filter((i) => i.enabled).map(({ id, name }) => ({ id, name })));
  })
);

// GET /auth/oidc/:idp — begin the authorization-code flow.
// ?next=<app-relative path> rides the IdP round-trip in the state record and
// the callback lands there — lets the login page return users to
// /oauth/authorize after SSO. Only same-origin paths pass the guard.
identityAuthRouter.get(
  '/oidc/:idp',
  ah(async (req, res) => {
    const redirectUri = resourceSelf(`/api/internal/auth/oidc/${req.params.idp}/callback`);
    const q = req.query.next;
    const next =
      typeof q === 'string' && q.startsWith('/') && !q.startsWith('//') ? q : undefined;
    const { redirectTo } = await beginOidc(req.params.idp, redirectUri, next);
    if (req.query.json === 'true') res.json({ redirectTo });
    else res.redirect(redirectTo);
  })
);

// GET /auth/oidc/:idp/callback — complete the flow, mint a session, redirect home.
identityAuthRouter.get(
  '/oidc/:idp/callback',
  ah(async (req, res) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) throw new JiraApiError(400, jiraError(['Missing code/state.']));
    const redirectUri = resourceSelf(`/api/internal/auth/oidc/${req.params.idp}/callback`);
    const next = oidcStates.get(state)?.next; // finishOidc consumes the record
    const user = await finishOidc(req.params.idp, code, state, redirectUri);
    req.actor = { user, channel: 'ui' };
    await audit(req, 'login.oidc', 'user', user.id, { idp: req.params.idp });
    const s = await createSession(user.id, { headers: req.headers as Record<string, unknown>, ip: req.ip });
    res
      .cookie(SESSION_COOKIE, signSession(user.id, s.id), {
        httpOnly: true,
        sameSite: 'lax',
        secure: publicBaseUrl().startsWith('https://'),
        maxAge: 12 * 3600 * 1000,
        path: '/',
      })
      .redirect(next ?? '/');
  })
);

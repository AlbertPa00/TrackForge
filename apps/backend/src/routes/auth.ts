import { Router, type Router as RouterType } from 'express';
import { login, ensureBootstrap, toUserResponse } from '../services/userService.js';
import { signSession, SESSION_COOKIE } from '../lib/auth.js';
import { createSession, consumeSecondFactor, isSsoOnly, userNeedsTotpEnroll } from '../services/identityService.js';
import { prisma } from '../prisma.js';
import jwt from 'jsonwebtoken';
import { audit } from '../services/auditService.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { publicBaseUrl, sessionSecret } from '../config.js';
import { ah } from '../lib/http.js';

const router: RouterType = Router();

router.post('/login', async (req, res, next) => {
  try {
    await ensureBootstrap();
    const { email, password, remember } = req.body ?? {};
    if (!email || !password) {
      throw new JiraApiError(400, jiraError([], { credentials: 'Email and password are required.' }));
    }
    const user = await login(String(email), String(password));
    // 036 US3-3: SSO-only policy — password login disabled except site-admins
    // (break-glass). Checked AFTER password verification (065 audit A5): the
    // old pre-check returned 403 for non-admins before any credential check,
    // which enumerated which accounts are admins.
    if ((await isSsoOnly()) && !user.isAdmin) {
      throw new JiraApiError(403, jiraError(['Password login is disabled — use your identity provider.']));
    }
    req.actor = { user, channel: 'ui' };
    // 036 US2: TOTP second factor — short-lived pending token, not a session.
    if (user.totpEnabled) {
      const pending = jwt.sign({ sub: user.id, kind: '2fa', remember: Boolean(remember) }, sessionSecret(), {
        expiresIn: '5m',
      });
      res.json({ totpRequired: true, pending });
      return;
    }
    await audit(req, 'login.success', 'user', user.id);
    // UB-010: "Keep me logged in" extends session, JWT and cookie to 30 days —
    // all three must agree or the cookie outlives the credential.
    const sessTtlMs = (remember ? 30 * 24 : 12) * 3600 * 1000;
    const sess = await createSession(
      user.id,
      { headers: req.headers as Record<string, unknown>, ip: req.ip },
      sessTtlMs
    );
    res
      .cookie(SESSION_COOKIE, signSession(user.id, sess.id, remember ? '30d' : '12h'), {
        httpOnly: true,
        sameSite: 'lax',
        secure: publicBaseUrl().startsWith('https://'),
        maxAge: sessTtlMs,
        path: '/',
      })
      .json({ ...toUserResponse(user), totpEnrollRequired: !user.totpEnabled && (await userNeedsTotpEnroll(user.id)) });
  } catch (err) {
    await audit(req, 'login.failure', 'user', undefined, {
      email: String(req.body?.email ?? '').slice(0, 100),
    });
    next(err);
  }
});

// 036 US2: complete a TOTP-challenged login. The second factor is 6 digits and
// this endpoint sits outside the global limiter — cap attempts per pending
// login so the factor can't be brute-forced inside its 5-minute window.
const totpAttempts = new Map<string, { count: number; reset: number }>();
const TOTP_MAX_ATTEMPTS = 5;

router.post(
  '/login/totp',
  ah(async (req, res) => {
    const { pending, code } = req.body ?? {};
    const payload = jwt.verify(String(pending ?? ''), sessionSecret()) as {
      sub?: string;
      kind?: string;
      remember?: boolean;
    };
    if (!payload.sub || payload.kind !== '2fa') {
      throw new JiraApiError(400, jiraError(['Invalid pending login.']));
    }
    const attemptsKey = `totp:${payload.sub}`;
    const now = Date.now();
    const att = totpAttempts.get(attemptsKey);
    if (att && att.reset > now && att.count >= TOTP_MAX_ATTEMPTS) {
      res.setHeader('Retry-After', String(Math.ceil((att.reset - now) / 1000)));
      throw new JiraApiError(429, jiraError(['Too many authentication attempts — log in again.']));
    }
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active || !(await consumeSecondFactor(user, String(code ?? '')))) {
      const cur = totpAttempts.get(attemptsKey);
      if (cur && cur.reset > now) cur.count += 1;
      else totpAttempts.set(attemptsKey, { count: 1, reset: now + 5 * 60_000 });
      throw new JiraApiError(401, jiraError(['Invalid authentication code.']));
    }
    totpAttempts.delete(attemptsKey);
    req.actor = { user, channel: 'ui' };
    await audit(req, 'login.success', 'user', user.id, { secondFactor: true });
    const sessTtlMs = (payload.remember ? 30 * 24 : 12) * 3600 * 1000;
    const sess = await createSession(
      user.id,
      { headers: req.headers as Record<string, unknown>, ip: req.ip },
      sessTtlMs
    );
    res
      .cookie(SESSION_COOKIE, signSession(user.id, sess.id, payload.remember ? '30d' : '12h'), {
        httpOnly: true,
        sameSite: 'lax',
        secure: publicBaseUrl().startsWith('https://'),
        maxAge: sessTtlMs,
        path: '/',
      })
      .json(toUserResponse(user));
  })
);

router.post('/logout', requireAuth, async (req, res) => {
  if (req.sessionId) {
    const { revokeSession } = await import('../services/identityService.js');
    await revokeSession(req.actor!.user.id, req.sessionId).catch(() => {});
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' }).status(204).end();
});

// TrackForge extension: full principal info for agents (scopes, allow-list, channel).
router.get('/whoami', requireAuth, (req, res) => {
  const actor = req.actor!;
  res.json({
    user: toUserResponse(actor.user),
    authType: actor.token ? 'token' : 'session',
    channel: actor.channel,
    token: actor.token
      ? {
          id: actor.token.id,
          name: actor.token.name,
          prefix: actor.token.prefix,
          scopes: actor.token.scopes,
          projectKeys: actor.token.projectKeys,
          expiresAt: actor.token.expiresAt?.toISOString() ?? null,
        }
      : null,
    scopes: actor.token ? actor.token.scopes : ['read', 'write', ...(actor.user.isAdmin ? ['admin'] : [])],
    allowedProjects: actor.token?.projectKeys ?? null,
  });
});

export default router;

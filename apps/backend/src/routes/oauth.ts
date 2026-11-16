import { ps } from '../lib/validation.js';
// Sprint 049 — OAuth 2.1 authorization server endpoints (Track B).
// Public AS surface (mounted outside requireAuth): /.well-known/*, /oauth/*.
// Authed surface: /api/internal/admin/oauth/clients (requireAdmin), /api/internal/me/grants.
// RFC 9700 profile: no implicit/ROPC; S256 PKCE mandatory; exact redirect match.
import { Router, type Router as RouterType, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { requireAuth, requireAdmin, rateLimit, resolveRequestActor } from '../middleware/auth.js';
import { frontendBaseUrl } from '../config.js';
import { hashToken } from '../lib/auth.js';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import {
  issuer,
  jwksDocument,
  validateAuthorizeRequest,
  issueAuthorizationCode,
  exchangeToken,
  revokeToken,
  revokeGrant,
  introspect,
  validScopes,
  createDeviceCode,
  decideDeviceCode,
  type AuthorizeParams,
} from '../services/oauthService.js';
import { ah } from '../lib/http.js';

export const oauthRouter: RouterType = Router(); // public — mounted at /
export const oauthAdminRouter: RouterType = Router(); // /api/internal/admin/oauth
export const oauthMeRouter: RouterType = Router(); // /api/internal/me

function oauthErr(res: Response, status: number, error: string, description?: string): void {
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

const DCR_ENABLED = process.env.OAUTH_DCR_ENABLED !== 'false';

// Scoped sub-mounts — this router sits at '/', so router-level .use would
// apply to EVERY request. rateLimit + urlencoded must only cover /oauth/*.
oauthRouter.use('/oauth', rateLimit, express.urlencoded({ extended: false, limit: '16kb' }));
oauthRouter.use('/.well-known', rateLimit);

// ---------- discovery (RFC 8414 / 9728) ----------

oauthRouter.get(
  '/.well-known/oauth-authorization-server',
  ah(async (_req, res) => {
    const iss = issuer();
    res.json({
      issuer: iss,
      authorization_endpoint: `${iss}/oauth/authorize`,
      token_endpoint: `${iss}/oauth/token`,
      revocation_endpoint: `${iss}/oauth/revoke`,
      introspection_endpoint: `${iss}/oauth/introspect`,
      registration_endpoint: DCR_ENABLED ? `${iss}/oauth/register` : undefined,
      device_authorization_endpoint: `${iss}/oauth/device`,
      jwks_uri: `${iss}/oauth/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      // Advertise only scopes public clients can actually be granted —
      // 'admin' exists but stays an admin-registration privilege.
      scopes_supported: ['read', 'write'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
  })
);

oauthRouter.get(
  '/.well-known/oauth-protected-resource',
  ah(async (_req, res) => {
    const iss = issuer();
    res.json({
      resource: iss,
      authorization_servers: [iss],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read', 'write'],
    });
  })
);

// RFC 9728 §5.1 — path-aware resource metadata: clients configured with
// {iss}/mcp look the doc up at /.well-known/oauth-protected-resource/mcp.
oauthRouter.get(
  '/.well-known/oauth-protected-resource/mcp',
  ah(async (_req, res) => {
    const iss = issuer();
    res.json({
      resource: `${iss}/mcp`,
      authorization_servers: [iss],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read', 'write'],
    });
  })
);

oauthRouter.get(
  '/oauth/jwks',
  ah(async (_req, res) => {
    res.json(await jwksDocument());
  })
);

// ---------- authorize + consent ----------

const CONSENT_PAGE = (clientName: string, scopes: string[], fields: Record<string, string>): string => {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, '&quot;')}">`)
    .join('\n');
  return `<!doctype html><html><head><title>Authorize — TrackForge</title><style>
body{font-family:system-ui;margin:40px auto;max-width:420px}h1{font-size:18px}
.card{border:1px solid #ddd;border-radius:8px;padding:20px}button{padding:8px 16px;margin-right:8px;cursor:pointer}
.approve{background:#0052cc;color:#fff;border:0;border-radius:4px}.deny{background:#fff;border:1px solid #ccc;border-radius:4px}
ul{color:#555}</style></head><body><div class="card">
<h1>${clientName.replace(/</g, '&lt;')} requests access</h1>
<p>This application will be able to act on your behalf with these scopes:</p>
<ul>${scopes.map((s) => `<li>${s}</li>`).join('')}</ul>
<form method="post" action="/oauth/authorize">${hidden}
<button class="approve" name="decision" value="approve" type="submit">Allow</button>
<button class="deny" name="decision" value="deny" type="submit">Deny</button>
</form></div></body></html>`;
};

function authorizeErrorRedirect(
  res: Response,
  redirectUri: string,
  state: string | undefined,
  error: string,
  description?: string
): void {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  u.searchParams.set('iss', issuer()); // RFC 9207 mix-up defense
  if (state) u.searchParams.set('state', state);
  res.redirect(u.toString());
}

// A browser mid-OAuth-dance gets JSON 401 from requireAuth — a dead end for
// MCP clients' authorization popups. Bounce unauthenticated browsers through
// the SPA login and return to the authorize URL (rebuilt from the body for
// POST consent submissions whose session lapsed between render and submit).
const requireUiOrRedirect = ah(async (req: Request, res: Response, next: NextFunction) => {
  const actor = await resolveRequestActor(req);
  if (actor) {
    requireAuth(req, res, next);
    return;
  }
  // For POSTs rebuild the authorize URL from the body — minus `decision`,
  // which is the consent form's own control, not an authorize param.
  const nextUrl =
    req.method === 'POST'
      ? `/oauth/authorize?${new URLSearchParams(
          Object.fromEntries(
            Object.entries(req.body as Record<string, string>).filter(([k]) => k !== 'decision')
          )
        ).toString()}`
      : req.originalUrl;
  res.redirect(`${frontendBaseUrl()}/login?next=${encodeURIComponent(nextUrl)}`);
});

oauthRouter.get(
  '/oauth/authorize',
  requireUiOrRedirect,
  ah(async (req, res) => {
    const q = req.query as AuthorizeParams;
    const check = validateAuthorizeRequest(q);
    if ('error' in check) {
      // Redirect the error when client+uri still resolve; else bare 400.
      const c = await prisma.oAuthClient.findUnique({ where: { clientId: q.client_id ?? '' } });
      if (c && q.redirect_uri && c.redirectUris.includes(q.redirect_uri)) {
        authorizeErrorRedirect(res, q.redirect_uri, q.state, check.error);
        return;
      }
      oauthErr(res, 400, check.error);
      return;
    }
    const client = await check.client.catch(async (e) => {
      const c = await prisma.oAuthClient.findUnique({ where: { clientId: q.client_id ?? '' } });
      if (c && q.redirect_uri && c.redirectUris.includes(q.redirect_uri)) {
        authorizeErrorRedirect(
          res,
          q.redirect_uri,
          q.state,
          (e as { oauthError?: string }).oauthError ?? 'invalid_request',
          (e as { message?: string }).message
        );
        return null;
      }
      return null;
    });
    if (!client) {
      if (!res.headersSent) oauthErr(res, 400, 'invalid_request');
      return;
    }
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res
      .type('html')
      .send(
        CONSENT_PAGE(
          client.name,
          check.scopes,
          Object.fromEntries(Object.entries(req.query as Record<string, string>).map(([k, v]) => [k, String(v)]))
        )
      );
  })
);

oauthRouter.post(
  '/oauth/authorize',
  requireUiOrRedirect,
  ah(async (req, res) => {
    // Consent is human-only (AI-native checklist): a bearer PAT cannot mint grants.
    if (req.actor!.channel !== 'ui') {
      oauthErr(res, 401, 'invalid_request', 'Consent requires an interactive session');
      return;
    }
    const q = req.body as AuthorizeParams & { decision?: string };
    const check = validateAuthorizeRequest(q);
    if ('error' in check) {
      oauthErr(res, 400, check.error);
      return;
    }
    const client = await check.client.catch(() => null);
    if (!client) {
      oauthErr(res, 400, 'unauthorized_client');
      return;
    }
    if (req.body.decision !== 'approve') {
      authorizeErrorRedirect(res, q.redirect_uri!, q.state, 'access_denied');
      return;
    }
    const code = await issueAuthorizationCode(client, req.actor!.user.id, q, check.scopes, client.allowedProjectKeys);
    const u = new URL(q.redirect_uri!);
    u.searchParams.set('code', code);
    u.searchParams.set('iss', issuer());
    if (q.state) u.searchParams.set('state', q.state);
    res.redirect(u.toString());
  })
);

// ---------- device grant (RFC 8628) ----------

oauthRouter.post(
  '/oauth/device',
  ah(async (req, res) => {
    const b = req.body as { client_id?: string; scope?: string };
    try {
      res.json(await createDeviceCode(b.client_id ?? '', b.scope));
    } catch (e) {
      const oe = e as { oauthError?: string; message?: string };
      oauthErr(res, 400, oe.oauthError ?? 'server_error', oe.message);
    }
  })
);

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const DEVICE_PAGE = (
  userCode: string,
  msg = '',
  client?: { name: string; scopes: string[] } | null
): string => `<!doctype html><html><head><title>Device sign-in — TrackForge</title><style>
body{font-family:system-ui;margin:40px auto;max-width:400px}input{font-size:20px;letter-spacing:2px;padding:8px;width:100%;box-sizing:border-box;text-transform:uppercase}
button{padding:8px 16px;margin-top:12px;cursor:pointer}.ok{background:#0052cc;color:#fff;border:0;border-radius:4px}.no{background:#fff;border:1px solid #ccc;border-radius:4px}.err{color:#b00}.card{border:1px solid #ddd;border-radius:8px;padding:16px;margin:12px 0}</style></head>
<body><h1>Connect a device</h1>${msg ? `<p class="err">${escHtml(msg)}</p>` : ''}
${client ? `<div class="card"><b>${escHtml(client.name)}</b> is requesting access with scopes: <b>${escHtml(client.scopes.join(' ') || 'read')}</b>. Only approve if you initiated this sign-in.</div>` : ''}
<form method="post" action="/oauth/device/approve">
<input name="user_code" value="${escHtml(userCode)}" placeholder="XXXX-XXXX" maxlength="9" required>
<button class="ok" name="decision" value="approve" type="submit">Allow</button>
<button class="no" name="decision" value="deny" type="submit">Deny</button></form></body></html>`;

// Anti-clickjacking: OAuth HTML pages must never render inside a frame.
function denyFraming(res: Response): void {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
}

oauthRouter.get(
  '/oauth/device',
  requireAuth,
  ah(async (req, res) => {
    denyFraming(res);
    const userCode = String((req.query as { user_code?: string }).user_code ?? '');
    // Show which client + scopes the code belongs to — an approval page that
    // hides this enables scope-escalation phishing.
    const row = userCode
      ? await prisma.oAuthDeviceCode
          .findUnique({
            where: { userCode: userCode.toUpperCase().replace(/\s/g, '') },
            include: { client: { select: { name: true } } },
          })
          .catch(() => null)
      : null;
    res.type('html').send(DEVICE_PAGE(userCode, '', row ? { name: row.client.name, scopes: row.scopes } : null));
  })
);

oauthRouter.post(
  '/oauth/device/approve',
  requireAuth,
  ah(async (req, res) => {
    denyFraming(res);
    if (req.actor!.channel !== 'ui') {
      oauthErr(res, 401, 'invalid_request', 'Device approval requires an interactive session');
      return;
    }
    const b = req.body as { user_code?: string; decision?: string };
    const ok = await decideDeviceCode(b.user_code ?? '', req.actor!.user.id, b.decision === 'approve');
    res
      .type('html')
      .send(
        ok
          ? '<!doctype html><html><body style="font-family:system-ui;margin:40px auto;max-width:400px"><h1>Done — you can close this window.</h1></body></html>'
          : DEVICE_PAGE(b.user_code ?? '', 'Code is invalid, expired, or already decided.')
      );
  })
);

// ---------- token / revoke / introspect / register ----------

oauthRouter.post(
  '/oauth/token',
  ah(async (req, res) => {
    // Accept HTTP Basic client auth per RFC 6749 §2.3.1.
    const body = { ...(req.body as Record<string, string>) };
    const auth = req.headers.authorization;
    if (!body.client_id && auth?.startsWith('Basic ')) {
      const [id, ...rest] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      body.client_id = decodeURIComponent(id);
      body.client_secret = decodeURIComponent(rest.join(':'));
    }
    try {
      res.json(await exchangeToken(body, req));
    } catch (e) {
      const oe = e as { oauthError?: string; status?: number; message?: string };
      oauthErr(res, oe.status ?? 400, oe.oauthError ?? 'server_error', oe.message);
    }
  })
);

oauthRouter.post(
  '/oauth/revoke',
  ah(async (req, res) => {
    await revokeToken(String((req.body as { token?: string }).token ?? ''), req);
    res.status(200).json({}); // RFC 7009 — always 200
  })
);

oauthRouter.post(
  '/oauth/introspect',
  requireAuth,
  ah(async (req, res) => {
    if (!req.actor!.user.isAdmin && !req.actor!.token?.scopes.includes('admin')) {
      oauthErr(res, 403, 'insufficient_scope');
      return;
    }
    res.json(await introspect(String((req.body as { token?: string }).token ?? '')));
  })
);

// DCR gets its own tighter per-IP bucket — registration abuse is the classic
// vector and must not consume the general /oauth envelope (SC-005).
const dcrBuckets = new Map<string, { count: number; reset: number }>();
oauthRouter.post(
  '/oauth/register',
  ah(async (req, res) => {
    const limit = Number(process.env.OAUTH_DCR_RATE_LIMIT ?? 60);
    const now = Date.now();
    const key = req.ip ?? 'anon';
    let b = dcrBuckets.get(key);
    if (!b || b.reset < now) {
      b = { count: 0, reset: now + 60_000 };
      dcrBuckets.set(key, b);
    }
    b.count++;
    if (b.count > limit) {
      oauthErr(res, 429, 'rate_limited', 'Too many registrations');
      return;
    }
    if (!DCR_ENABLED) {
      oauthErr(res, 403, 'invalid_client_metadata', 'Dynamic registration disabled');
      return;
    }
    const schema = z.object({
      client_name: z.string().min(1).max(200),
      redirect_uris: z.array(z.string().url()).max(20).default([]),
      grant_types: z.array(z.string()).default(['authorization_code']),
      // Clients that omit scope expect the full public surface — 'admin' is
      // still rejected below.
      scope: z.string().default('read write'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      oauthErr(res, 400, 'invalid_client_metadata');
      return;
    }
    const d = parsed.data;
    const scopes = d.scope.split(' ').filter(Boolean);
    if (!validScopes(scopes)) {
      oauthErr(res, 400, 'invalid_client_metadata', 'Unknown scope');
      return;
    }
    // Public DCR clients must never hold the admin scope — dynamic registration
    // is unauthenticated; admin scope stays an admin-registration privilege.
    if (scopes.includes('admin')) {
      oauthErr(res, 400, 'invalid_client_metadata', "Scope 'admin' is not available via dynamic registration");
      return;
    }
    const grants = d.grant_types.filter((g) =>
      ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'].includes(g)
    );
    if (!grants.length) {
      oauthErr(res, 400, 'invalid_client_metadata', 'No supported grant types');
      return;
    }
    // Public clients only via DCR — confidential clients are admin-registered.
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `tf-${crypto.randomUUID()}`,
        name: d.client_name,
        redirectUris: d.redirect_uris,
        grantTypes: [...new Set([...grants, 'refresh_token'])],
        allowedScopes: scopes,
        allowedProjectKeys: [],
        registrationType: 'dynamic',
      },
    });
    res.status(201).json({
      client_id: client.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      scope: client.allowedScopes.join(' '),
      token_endpoint_auth_method: 'none',
      registration_type: 'dynamic',
    });
  })
);

// ---------- admin client CRUD ----------

const clientSchema = z.object({
  name: z.string().min(1).max(200),
  redirectUris: z.array(z.string()).max(20).default([]),
  grantTypes: z
    .array(
      z.enum([
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
      ])
    )
    .min(1),
  allowedScopes: z.array(z.enum(['read', 'write', 'admin'])).min(1),
  allowedProjectKeys: z.array(z.string()).default([]),
  confidential: z.boolean().default(false),
  serviceUserId: z.string().nullable().optional(),
  metadataDocumentUrl: z.string().url().nullable().optional(),
  enabled: z.boolean().default(true),
});

function clientView(c: {
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  allowedScopes: string[];
  allowedProjectKeys: string[];
  serviceUserId: string | null;
  metadataDocumentUrl: string | null;
  registrationType: string;
  enabled: boolean;
  createdAt: Date;
}) {
  return {
    // FR-007 — secret hashes never leave the API
    id: c.id,
    clientId: c.clientId,
    name: c.name,
    redirectUris: c.redirectUris,
    grantTypes: c.grantTypes,
    allowedScopes: c.allowedScopes,
    allowedProjectKeys: c.allowedProjectKeys,
    serviceUserId: c.serviceUserId,
    metadataDocumentUrl: c.metadataDocumentUrl,
    confidential: false as boolean,
    registrationType: c.registrationType,
    enabled: c.enabled,
    createdAt: c.createdAt,
  };
}

oauthAdminRouter.post(
  '/clients',
  requireAuth,
  requireAdmin,
  ah(async (req, res) => {
    const parsed = clientSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const d = parsed.data;
    const secret = d.confidential ? crypto.randomBytes(32).toString('base64url') : null;
    const client = await prisma.oAuthClient.create({
      data: {
        clientId: `tf-${crypto.randomUUID()}`,
        name: d.name,
        redirectUris: d.redirectUris,
        grantTypes: [
          ...new Set(
            d.grantTypes.concat(d.grantTypes.includes('authorization_code') ? ['refresh_token' as const] : [])
          ),
        ],
        allowedScopes: d.allowedScopes,
        allowedProjectKeys: d.allowedProjectKeys,
        clientSecretHash: secret ? hashToken(secret) : null,
        serviceUserId: d.serviceUserId ?? null,
        metadataDocumentUrl: d.metadataDocumentUrl ?? null,
        enabled: d.enabled,
      },
    });
    res
      .status(201)
      .json({ ...clientView(client), confidential: !!client.clientSecretHash, clientSecret: secret ?? undefined });
  })
);

oauthAdminRouter.get(
  '/clients',
  requireAuth,
  requireAdmin,
  ah(async (_req, res) => {
    const clients = await prisma.oAuthClient.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ clients: clients.map((c) => ({ ...clientView(c), confidential: !!c.clientSecretHash })) });
  })
);

oauthAdminRouter.put(
  '/clients/:id',
  requireAuth,
  requireAdmin,
  ah(async (req, res) => {
    const parsed = clientSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const d = parsed.data;
    const client = await prisma.oAuthClient.update({
      where: { id: ps(req.params.id) },
      data: {
        ...(d.name !== undefined && { name: d.name }),
        ...(d.redirectUris !== undefined && { redirectUris: d.redirectUris }),
        ...(d.grantTypes !== undefined && { grantTypes: d.grantTypes }),
        ...(d.allowedScopes !== undefined && { allowedScopes: d.allowedScopes }),
        ...(d.allowedProjectKeys !== undefined && { allowedProjectKeys: d.allowedProjectKeys }),
        ...(d.serviceUserId !== undefined && { serviceUserId: d.serviceUserId }),
        ...(d.metadataDocumentUrl !== undefined && { metadataDocumentUrl: d.metadataDocumentUrl }),
        ...(d.enabled !== undefined && { enabled: d.enabled }),
      },
    });
    res.json({ ...clientView(client), confidential: !!client.clientSecretHash });
  })
);

oauthAdminRouter.delete(
  '/clients/:id',
  requireAuth,
  requireAdmin,
  ah(async (req, res) => {
    await prisma.oAuthClient.delete({ where: { id: ps(req.params.id) } });
    res.status(204).end();
  })
);

// ---------- user grant management (US4) ----------

oauthMeRouter.get(
  '/grants',
  requireAuth,
  ah(async (req, res) => {
    const grants = await prisma.oAuthGrant.findMany({
      where: { userId: req.actor!.user.id, revokedAt: null },
      include: { client: { select: { name: true, clientId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      grants: grants.map((g) => ({
        id: g.id,
        clientId: g.client.clientId,
        clientName: g.client.name,
        scopes: g.scopes,
        projectKeys: g.projectKeys,
        createdAt: g.createdAt,
      })),
    });
  })
);

oauthMeRouter.delete(
  '/grants/:id',
  requireAuth,
  ah(async (req, res) => {
    if (!(await revokeGrant(ps(req.params.id), req.actor!.user.id))) {
      res.status(404).json(jiraError(['Grant not found']));
      return;
    }
    res.status(204).end();
  })
);

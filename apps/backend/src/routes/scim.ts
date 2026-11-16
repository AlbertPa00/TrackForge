import { ps } from '../lib/validation.js';
// Sprint 049 Track A1 — SCIM 2.0 endpoints + directory connection admin.
// /scim/v2/* sits OUTSIDE requireAuth — the per-connection bearer IS the auth
// (resolveScimToken). /api/internal/admin/directory/* is requireAdmin.
import { Router, type Router as RouterType, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { prisma } from '../prisma.js';
import { requireAuth, requireAdmin, rateLimit } from '../middleware/auth.js';
import { generateToken } from '../lib/auth.js';
import { jiraError } from '../lib/errors.js';
import { formatZodErrors } from '../lib/validation.js';
import {
  resolveScimToken,
  upsertScimUser,
  patchScimUser,
  listScimUsers,
  getScimUser,
  deactivateScimUser,
  upsertScimGroup,
  listScimGroups,
  getScimGroup,
  scimErrorBody,
  ScimError,
} from '../services/scimService.js';
import type { DirectoryConnection } from '@prisma/client';
import { ah } from '../lib/http.js';

export const scimRouter: RouterType = Router();
export const directoryAdminRouter: RouterType = Router();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      scimConnection?: DirectoryConnection;
    }
  }
}

async function scimAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization ?? '';
  const conn = header.startsWith('Bearer ') ? await resolveScimToken(header.slice(7).trim()) : null;
  if (!conn) {
    res.status(401).json(scimErrorBody(401, 'Missing or invalid SCIM bearer token'));
    return;
  }
  req.scimConnection = conn;
  next();
}

scimRouter.use(rateLimit); // global backstop
scimRouter.use(scimAuth);
// FR-006/US1-5 — per-connection bucket: a flooding IdP is capped without
// degrading other connections (IdPs ignore 429s; the bucket protects us).
const SCIM_WINDOW_MS = 60_000;
const scimBuckets = new Map<string, { count: number; reset: number }>();
scimRouter.use((req, res, next) => {
  const limit = Number(process.env.SCIM_RATE_LIMIT ?? 600);
  const key = req.scimConnection!.id;
  const now = Date.now();
  let b = scimBuckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + SCIM_WINDOW_MS };
    scimBuckets.set(key, b);
  }
  b.count++;
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - b.count)));
  if (b.count > limit) {
    res.setHeader('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
    res.status(429).json(scimErrorBody(429, 'Rate limit exceeded'));
    return;
  }
  next();
});

scimRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof ScimError) {
    res.status(err.status).json(scimErrorBody(err.status, err.message));
    return;
  }
  next(err);
});

function handle(handler: (req: Request) => Promise<{ scim?: object; status?: number } | object>) {
  return ah(async (req, res) => {
    try {
      const out = await handler(req);
      const body = (out as { scim?: object }).scim ?? out;
      res.status((out as { status?: number }).status ?? 200).json(body);
    } catch (e) {
      if (e instanceof ScimError) {
        res.status(e.status).json(scimErrorBody(e.status, e.message));
        return;
      }
      throw e;
    }
  });
}

// ---------- discovery (unauthenticated-safe: still behind scimAuth per RFC) ----------

scimRouter.get('/ServiceProviderConfig', (_req, res) => {
  res.json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'SCIM bearer (per connection)',
        specUri: 'https://www.rfc-editor.org/rfc/rfc7643',
      },
    ],
  });
});

scimRouter.get('/ResourceTypes', (_req, res) => {
  res.json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 2,
    Resources: [
      { id: 'User', name: 'User', endpoint: '/Users', schema: 'urn:ietf:params:scim:schemas:core:2.0:User' },
      { id: 'Group', name: 'Group', endpoint: '/Groups', schema: 'urn:ietf:params:scim:schemas:core:2.0:Group' },
    ],
  });
});

scimRouter.get('/Schemas', (_req, res) => {
  res.json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 2,
    Resources: [
      { id: 'urn:ietf:params:scim:schemas:core:2.0:User', name: 'User' },
      { id: 'urn:ietf:params:scim:schemas:core:2.0:Group', name: 'Group' },
    ],
  });
});

// ---------- Users ----------

scimRouter.get(
  '/Users',
  handle((req) => listScimUsers(req.scimConnection!, req.query as never))
);
scimRouter.get(
  '/Users/:id',
  handle((req) => getScimUser(ps(req.params.id)))
);
scimRouter.post(
  '/Users',
  handle((req) => upsertScimUser(req.scimConnection!, req.body))
);
scimRouter.put(
  '/Users/:id',
  handle(async (req) => {
    const existing = await prisma.user.findUnique({ where: { id: ps(req.params.id) } });
    if (!existing) throw new ScimError(404, 'User not found');
    const body = { ...(req.body as Record<string, unknown>) };
    const ident = await prisma.externalIdentity.findFirst({ where: { userId: ps(req.params.id), provider: 'scim' } });
    if (ident && !body.externalId) body.externalId = ident.externalId;
    return upsertScimUser(req.scimConnection!, body);
  })
);
scimRouter.patch(
  '/Users/:id',
  handle((req) => patchScimUser(req.scimConnection!, ps(req.params.id), req.body))
);
scimRouter.delete(
  '/Users/:id',
  handle(async (req) => {
    await deactivateScimUser(req.scimConnection!, ps(req.params.id));
    return { status: 204 };
  })
);

// ---------- Groups ----------

scimRouter.get(
  '/Groups',
  handle((req) => listScimGroups(req.query as never))
);
scimRouter.get(
  '/Groups/:id',
  handle((req) => getScimGroup(ps(req.params.id)))
);
scimRouter.post(
  '/Groups',
  handle((req) => upsertScimGroup(req.scimConnection!, req.body))
);
scimRouter.put(
  '/Groups/:id',
  handle((req) => upsertScimGroup(req.scimConnection!, req.body, ps(req.params.id)))
);

// ---------- admin: directory connections ----------

const connectionSchema = z.object({
  type: z.enum(['scim', 'ldap']),
  name: z.string().min(1).max(200),
  config: z.record(z.unknown()).default({}),
  secretRef: z.string().max(500).nullable().optional(),
  enabled: z.boolean().default(false),
});

function connView(c: DirectoryConnection) {
  const { id, type, name, config, enabled, lastSyncAt, syncStatus, createdAt } = c;
  return { id, type, name, config, enabled, lastSyncAt, syncStatus, createdAt }; // secretRef never emitted (FR-007)
}

directoryAdminRouter.use(requireAuth, requireAdmin);

directoryAdminRouter.post(
  '/directory',
  ah(async (req, res) => {
    const parsed = connectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const d = parsed.data;
    if (d.type === 'ldap' && (d.config as { tls?: string }).tls === 'none') {
      res
        .status(400)
        .json(jiraError([], { 'config.tls': 'tls:none is rejected — use ldaps or starttls (no plaintext opt-out)' }));
      return;
    }
    const conn = await prisma.directoryConnection.create({
      data: {
        type: d.type,
        name: d.name,
        config: d.config as object,
        secretRef: d.secretRef ?? null,
        enabled: d.enabled,
      },
    });
    let scimToken: string | undefined;
    if (d.type === 'scim') {
      const { plain, prefix, hash } = generateToken();
      await prisma.scimToken.create({ data: { connectionId: conn.id, name: 'default', prefix, hash } });
      scimToken = plain; // returned once
    }
    res.status(201).json({ ...connView(conn), scimToken });
  })
);

directoryAdminRouter.get(
  '/directory',
  ah(async (_req, res) => {
    const conns = await prisma.directoryConnection.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ connections: conns.map(connView) });
  })
);

directoryAdminRouter.put(
  '/directory/:id',
  ah(async (req, res) => {
    const parsed = connectionSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const d = parsed.data;
    if (d.config && (d.config as { tls?: string }).tls === 'none') {
      res.status(400).json(jiraError([], { 'config.tls': 'tls:none is rejected — use ldaps or starttls' }));
      return;
    }
    const conn = await prisma.directoryConnection.update({
      where: { id: ps(req.params.id) },
      data: {
        ...(d.name !== undefined && { name: d.name }),
        ...(d.config !== undefined && { config: d.config as object }),
        ...(d.secretRef !== undefined && { secretRef: d.secretRef }),
        ...(d.enabled !== undefined && { enabled: d.enabled }),
      },
    });
    res.json(connView(conn));
  })
);

directoryAdminRouter.delete(
  '/directory/:id',
  ah(async (req, res) => {
    await prisma.directoryConnection.delete({ where: { id: ps(req.params.id) } });
    res.status(204).end();
  })
);

/** Mint an additional SCIM bearer for a connection (rotation). */
directoryAdminRouter.post(
  '/directory/:id/scim-tokens',
  ah(async (req, res) => {
    const conn = await prisma.directoryConnection.findUnique({ where: { id: ps(req.params.id) } });
    if (!conn || conn.type !== 'scim') {
      res.status(404).json(jiraError(['SCIM connection not found']));
      return;
    }
    const { plain, prefix, hash } = generateToken();
    const tok = await prisma.scimToken.create({
      data: {
        connectionId: conn.id,
        name: String((req.body as { name?: string }).name ?? `token-${crypto.randomInt(9999)}`),
        prefix,
        hash,
      },
    });
    res.status(201).json({ id: tok.id, prefix: tok.prefix, scimToken: plain });
  })
);

directoryAdminRouter.delete(
  '/directory/:id/scim-tokens/:tokenId',
  ah(async (req, res) => {
    await prisma.scimToken.update({ where: { id: ps(req.params.tokenId) }, data: { revokedAt: new Date() } });
    res.status(204).end();
  })
);

// ---------- LDAP test + on-demand sync (US2) ----------

directoryAdminRouter.post(
  '/directory/:id/test',
  ah(async (req, res) => {
    const conn = await prisma.directoryConnection.findUnique({ where: { id: ps(req.params.id) } });
    if (!conn || conn.type !== 'ldap') {
      res.status(404).json(jiraError(['LDAP connection not found']));
      return;
    }
    const { testDirectoryConnection } = await import('../services/directoryService.js');
    try {
      res.json(await testDirectoryConnection(conn, (req.body as { sampleLogin?: string }).sampleLogin));
    } catch (e) {
      res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })
);

directoryAdminRouter.post(
  '/directory/:id/sync',
  ah(async (req, res) => {
    const conn = await prisma.directoryConnection.findUnique({ where: { id: ps(req.params.id) } });
    if (!conn || conn.type !== 'ldap' || !conn.enabled) {
      res.status(404).json(jiraError(['Enabled LDAP connection not found']));
      return;
    }
    const { syncDirectoryConnection } = await import('../services/directoryService.js');
    try {
      res.json({ ok: true, stats: await syncDirectoryConnection(conn) });
    } catch (e) {
      res.status(200).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })
);

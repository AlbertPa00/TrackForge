// Sprint 049 — OAuth 2.1 authorization server (Track B).
// RFC 9700 profile: S256 PKCE mandatory, single-use <=60s codes, rotating
// refresh tokens with reuse detection, exact redirect-URI match, iss param.
// Access tokens are RS256 JWTs verifiable against /oauth/jwks (native crypto
// JWK export — no new deps). FR-001: they resolve to the same Actor as PATs.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { OAuthClient, OAuthGrant } from '@prisma/client';
import { prisma } from '../prisma.js';
import { hashToken } from '../lib/auth.js';
import { publicBaseUrl } from '../config.js';

const KEYS_SETTING = 'oauth2_jwks';
const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_SEC = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const VALID_SCOPES = ['read', 'write', 'admin'] as const;

interface SigningKeys {
  kid: string;
  privatePem: string;
  publicPem: string;
}

let cachedKeys: SigningKeys | null = null;

async function signingKeys(): Promise<SigningKeys> {
  if (cachedKeys) return cachedKeys;
  const row = await prisma.systemSetting.findUnique({ where: { key: KEYS_SETTING } });
  if (row) {
    cachedKeys = row.value as unknown as SigningKeys;
    return cachedKeys;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  cachedKeys = { kid: crypto.randomUUID(), privatePem: privateKey, publicPem: publicKey };
  await prisma.systemSetting.create({
    data: { key: KEYS_SETTING, value: cachedKeys as unknown as object },
  });
  return cachedKeys;
}

export async function jwksDocument(): Promise<object> {
  const { publicPem, kid } = await signingKeys();
  const jwk = crypto.createPublicKey(publicPem).export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
}

export function issuer(): string {
  return publicBaseUrl();
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function s256Challenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function oauthError(error: string, description: string): Error & { oauthError?: string; status?: number } {
  const e = new Error(description) as Error & { oauthError?: string; status?: number };
  e.oauthError = error;
  e.status = 400;
  return e;
}

async function audit(
  actorId: string | null,
  action: string,
  entityId: string | null,
  details?: object,
  req?: { ip?: string; headers?: { 'user-agent'?: string } }
): Promise<void> {
  await prisma.auditEvent
    .create({
      data: {
        actorId,
        action,
        entityType: 'oauth',
        entityId,
        details: details as object | undefined,
        ip: req?.ip,
        userAgent: req?.headers?.['user-agent'],
      },
    })
    .catch(() => undefined);
}

export function validScopes(scopes: string[]): boolean {
  return scopes.length > 0 && scopes.every((s) => (VALID_SCOPES as readonly string[]).includes(s));
}

export function redirectUriAllowed(client: OAuthClient, uri: string): boolean {
  return client.redirectUris.includes(uri); // exact match — OAuth 2.1, RFC 9700
}

// ---------- Client ID Metadata Documents (MCP authorization) ----------

/** https URL (localhost http allowed for native/dev clients, RFC 8252 spirit). */
function isMetadataDocumentId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const METADATA_SCHEMA = z.object({
  client_id: z.string(),
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string().url()).min(1),
  grant_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
});

/** Fetch + validate a Client ID Metadata Document, then persist it as a client row. */
async function registerFromMetadataDocument(clientId: string): Promise<OAuthClient | null> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    // 064 US5 — metadata-doc fetch goes through the egress guard; the only
    // private addresses allowed are the loopback ids RFC 8252 dev clients use.
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(clientId).hostname);
    const { egressFetch } = await import('../lib/egress.js');
    const res = await egressFetch(
      clientId,
      { signal: controller.signal, headers: { accept: 'application/json' } },
      { allowPrivate: local }
    );
    clearTimeout(t);
    if (!res.ok) return null;
    const parsed = METADATA_SCHEMA.safeParse(await res.json());
    if (!parsed.success) return null;
    const d = parsed.data;
    if (d.client_id !== clientId) return null; // document must self-identify
    // Doc-omitted scope = "all the AS offers a public client" (RFC 7591) —
    // never admin, which stays an admin-registration privilege like DCR.
    const scopes = (d.scope ?? 'read write')
      .split(' ')
      .filter((s) => (VALID_SCOPES as readonly string[]).includes(s) && s !== 'admin');
    if (!scopes.length) return null;
    const grants = (d.grant_types ?? ['authorization_code']).filter((g) =>
      ['authorization_code', 'refresh_token'].includes(g)
    );
    return await prisma.oAuthClient.upsert({
      where: { clientId },
      update: {
        name: d.client_name ?? clientId,
        redirectUris: d.redirect_uris,
        grantTypes: [...new Set([...grants, 'refresh_token'])],
        allowedScopes: scopes,
      },
      create: {
        clientId,
        name: d.client_name ?? clientId,
        redirectUris: d.redirect_uris,
        grantTypes: [...new Set([...grants, 'refresh_token'])],
        allowedScopes: scopes,
        allowedProjectKeys: [],
        metadataDocumentUrl: clientId,
        registrationType: 'metadata-document',
      },
    });
  } catch {
    return null;
  }
}

// ---------- authorize ----------

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

export function validateAuthorizeRequest(
  q: AuthorizeParams
): { client: Promise<OAuthClient>; scopes: string[] } | { error: string } {
  if (q.response_type !== 'code') return { error: 'unsupported_response_type' };
  if (!q.client_id || !q.redirect_uri || !q.code_challenge) return { error: 'invalid_request' };
  if (q.code_challenge_method !== 'S256') return { error: 'invalid_request' }; // OAuth 2.1: S256 only
  const scopes = (q.scope ?? 'read').split(' ').filter(Boolean);
  if (!validScopes(scopes)) return { error: 'invalid_scope' };
  // RFC 8707 — the deployment is ONE logical resource (aud stays the issuer);
  // the same-origin MCP endpoints are paths of it, not separate audiences.
  const resource = (q.resource ?? '').replace(/\/+$/, '');
  const mcpResources = [`${issuer()}/mcp`, `${issuer()}/mcp/readonly`];
  if (resource && resource !== issuer() && !mcpResources.includes(resource))
    return { error: 'invalid_target' };
  return {
    client: (async () => {
      let c = await prisma.oAuthClient.findUnique({ where: { clientId: q.client_id! } });
      // MCP registration priority #2 — Client ID Metadata Document: the
      // client_id IS a URL hosting its metadata. Re-resolve on each authorize
      // (docs may change — e.g. a rotating loopback port); keep the cached row
      // when the document is unreachable.
      if (isMetadataDocumentId(q.client_id!)) {
        c = (await registerFromMetadataDocument(q.client_id!)) ?? c;
      }
      if (!c || !c.enabled) throw oauthError('unauthorized_client', 'Unknown or disabled client');
      if (!c.grantTypes.includes('authorization_code'))
        throw oauthError('unauthorized_client', 'Client may not use authorization_code');
      if (!redirectUriAllowed(c, q.redirect_uri!)) throw oauthError('invalid_request', 'redirect_uri not registered');
      if (!scopes.every((s) => c.allowedScopes.includes(s)))
        throw oauthError('invalid_scope', 'Scope exceeds client registration');
      return c;
    })(),
    scopes,
  };
}

export async function issueAuthorizationCode(
  client: OAuthClient,
  userId: string,
  q: AuthorizeParams,
  scopes: string[],
  projectKeys: string[]
): Promise<string> {
  const code = randomToken();
  await prisma.oAuthAuthorizationCode.create({
    data: {
      hash: hashToken(code),
      clientDbId: client.id,
      userId,
      redirectUri: q.redirect_uri!,
      scopes,
      projectKeys,
      codeChallenge: q.code_challenge!,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  await audit(userId, 'oauth.code.issued', client.id, { clientId: client.clientId, scopes });
  return code;
}

// ---------- token ----------

async function issueAccessToken(grant: OAuthGrant & { client: OAuthClient }, userId: string | null): Promise<string> {
  const keys = await signingKeys();
  return jwt.sign(
    {
      iss: issuer(),
      aud: issuer(),
      sub: userId ?? grant.client.serviceUserId ?? '',
      cid: grant.client.clientId,
      gid: grant.id,
      scp: grant.scopes.join(' '),
      pk: grant.projectKeys,
      gty: userId ? 'user' : 'client',
    },
    keys.privatePem,
    { algorithm: 'RS256', keyid: keys.kid, expiresIn: ACCESS_TTL_SEC }
  );
}

async function issueRefresh(grantId: string): Promise<string> {
  const plain = randomToken();
  await prisma.oAuthRefreshToken.create({
    data: { hash: hashToken(plain), grantId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  return plain;
}

function tokenResponse(access: string, refresh: string | null, scopes: string[]) {
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SEC,
    scope: scopes.join(' '),
    ...(refresh ? { refresh_token: refresh } : {}),
  };
}

async function authenticateClient(clientId: string | undefined, secret: string | undefined): Promise<OAuthClient> {
  if (!clientId) throw oauthError('invalid_client', 'client_id required');
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client || !client.enabled) throw oauthError('invalid_client', 'Unknown or disabled client');
  if (client.clientSecretHash) {
    if (!secret || hashToken(secret) !== client.clientSecretHash)
      throw oauthError('invalid_client', 'Bad client credentials');
  }
  return client;
}

export async function exchangeToken(
  body: Record<string, string | undefined>,
  req?: { ip?: string; headers?: { 'user-agent'?: string } }
): Promise<object> {
  const grantType = body.grant_type;
  const client = await authenticateClient(body.client_id, body.client_secret);

  if (grantType === 'authorization_code') {
    if (!client.grantTypes.includes('authorization_code')) throw oauthError('unauthorized_client', 'grant not allowed');
    const row = await prisma.oAuthAuthorizationCode.findUnique({ where: { hash: hashToken(body.code ?? '') } });
    if (!row || row.clientDbId !== client.id) throw oauthError('invalid_grant', 'Unknown code');
    if (row.usedAt || row.expiresAt < new Date()) throw oauthError('invalid_grant', 'Code expired or used');
    if (row.redirectUri !== body.redirect_uri) throw oauthError('invalid_grant', 'redirect_uri mismatch');
    if (!body.code_verifier || s256Challenge(body.code_verifier) !== row.codeChallenge) {
      throw oauthError('invalid_grant', 'PKCE verification failed');
    }
    const grant = await prisma.$transaction(async (tx) => {
      const claimed = await tx.oAuthAuthorizationCode.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (!claimed.count) throw oauthError('invalid_grant', 'Code already used');
      return tx.oAuthGrant.create({
        data: { clientDbId: client.id, userId: row.userId, scopes: row.scopes, projectKeys: row.projectKeys },
        include: { client: true },
      });
    });
    const [access, refresh] = await Promise.all([issueAccessToken(grant, row.userId), issueRefresh(grant.id)]);
    await audit(row.userId, 'oauth.grant.issued', grant.id, { clientId: client.clientId }, req);
    return tokenResponse(access, refresh, grant.scopes);
  }

  if (grantType === 'refresh_token') {
    const rt = await prisma.oAuthRefreshToken.findUnique({
      where: { hash: hashToken(body.refresh_token ?? '') },
      include: { grant: { include: { client: true } } },
    });
    if (!rt) throw oauthError('invalid_grant', 'Unknown refresh token');
    if (rt.grant.revokedAt || rt.expiresAt < new Date()) throw oauthError('invalid_grant', 'Grant revoked or expired');
    if (rt.revokedAt || rt.rotatedToId) {
      // RFC 9700: replayed rotated token → kill the whole grant chain.
      await prisma.$transaction([
        prisma.oAuthRefreshToken.update({ where: { id: rt.id }, data: { reuseDetected: true } }),
        prisma.oAuthGrant.update({ where: { id: rt.grantId }, data: { revokedAt: new Date() } }),
      ]);
      await audit(rt.grant.userId, 'oauth.refresh.reuse_detected', rt.grantId, { clientId: client.clientId }, req);
      throw oauthError('invalid_grant', 'Refresh token reuse detected — grant revoked');
    }
    if (rt.grant.clientDbId !== client.id) throw oauthError('invalid_grant', 'Client mismatch');
    const newPlain = randomToken();
    const [next] = await prisma.$transaction([
      prisma.oAuthRefreshToken.create({
        data: { hash: hashToken(newPlain), grantId: rt.grantId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
      }),
      prisma.oAuthRefreshToken.update({ where: { id: rt.id }, data: { revokedAt: new Date() } }),
    ]);
    await prisma.oAuthRefreshToken.update({ where: { id: rt.id }, data: { rotatedToId: next.id } });
    const access = await issueAccessToken(rt.grant, rt.grant.userId);
    return tokenResponse(access, newPlain, rt.grant.scopes);
  }

  if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
    return pollDeviceGrant(client, body.device_code);
  }

  if (grantType === 'client_credentials') {
    if (!client.grantTypes.includes('client_credentials')) throw oauthError('unauthorized_client', 'grant not allowed');
    if (!client.clientSecretHash) throw oauthError('invalid_client', 'Public clients cannot use client_credentials');
    if (!client.serviceUserId) throw oauthError('invalid_client', 'No service user bound');
    const scopes = body.scope ? body.scope.split(' ').filter(Boolean) : client.allowedScopes;
    if (!scopes.length || !scopes.every((s) => client.allowedScopes.includes(s)))
      throw oauthError('invalid_scope', 'Scope exceeds registration');
    const grant = await prisma.oAuthGrant.create({
      data: { clientDbId: client.id, userId: client.serviceUserId, scopes, projectKeys: client.allowedProjectKeys },
      include: { client: true },
    });
    const access = await issueAccessToken(grant, null);
    await audit(
      client.serviceUserId,
      'oauth.grant.issued',
      grant.id,
      { clientId: client.clientId, gty: 'client_credentials' },
      req
    );
    return tokenResponse(access, null, grant.scopes);
  }

  throw oauthError('unsupported_grant_type', 'grant_type not supported');
}

// ---------- device grant (RFC 8628) ----------

const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_POLL_SEC = 5;
const USER_CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXZ'; // unambiguous — no vowels/digits

function newUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_CHARS[crypto.randomInt(USER_CODE_CHARS.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function createDeviceCode(clientId: string, scopeParam: string | undefined) {
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } });
  if (!client || !client.enabled || !client.grantTypes.includes('urn:ietf:params:oauth:grant-type:device_code')) {
    throw oauthError('unauthorized_client', 'Client may not use the device grant');
  }
  const scopes = (scopeParam ?? 'read').split(' ').filter(Boolean);
  if (!validScopes(scopes) || !scopes.every((s) => client.allowedScopes.includes(s))) {
    throw oauthError('invalid_scope', 'Scope exceeds client registration');
  }
  const deviceCode = randomToken();
  const userCode = newUserCode();
  await prisma.oAuthDeviceCode.create({
    data: {
      hash: hashToken(deviceCode),
      userCode,
      clientDbId: client.id,
      scopes,
      projectKeys: client.allowedProjectKeys,
      intervalSec: DEVICE_POLL_SEC,
      expiresAt: new Date(Date.now() + DEVICE_TTL_MS),
    },
  });
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${issuer()}/oauth/device`,
    verification_uri_complete: `${issuer()}/oauth/device?user_code=${userCode}`,
    expires_in: DEVICE_TTL_MS / 1000,
    interval: DEVICE_POLL_SEC,
  };
}

/** Called by the user-facing device page — binds the code to the approving user. */
export async function decideDeviceCode(userCode: string, userId: string, approve: boolean): Promise<boolean> {
  const row = await prisma.oAuthDeviceCode.findUnique({
    where: { userCode: userCode.toUpperCase().replace(/\s/g, '') },
  });
  if (!row || row.expiresAt < new Date() || row.userId || row.deniedAt) return false;
  await prisma.oAuthDeviceCode.update({
    where: { id: row.id },
    data: approve ? { userId } : { deniedAt: new Date() },
  });
  if (approve) await audit(userId, 'oauth.device.approved', row.id, {});
  return true;
}

async function pollDeviceGrant(client: OAuthClient, deviceCode: string | undefined): Promise<object> {
  const row = await prisma.oAuthDeviceCode.findUnique({ where: { hash: hashToken(deviceCode ?? '') } });
  if (!row || row.clientDbId !== client.id) throw oauthError('invalid_grant', 'Unknown device_code');
  if (row.expiresAt < new Date()) throw oauthError('expired_token', 'device_code expired');
  if (row.deniedAt) throw oauthError('access_denied', 'User denied the request');
  if (!row.userId) {
    // Poll pacing: faster than interval → slow_down.
    if (row.lastPollAt && Date.now() - row.lastPollAt.getTime() < row.intervalSec * 1000) {
      throw oauthError('slow_down', 'Polling too fast');
    }
    await prisma.oAuthDeviceCode.update({ where: { id: row.id }, data: { lastPollAt: new Date() } });
    throw oauthError('authorization_pending', 'Awaiting user approval');
  }
  const grant = await prisma.$transaction(async (tx) => {
    const g = await tx.oAuthGrant.create({
      data: { clientDbId: client.id, userId: row.userId, scopes: row.scopes, projectKeys: row.projectKeys },
      include: { client: true },
    });
    await tx.oAuthDeviceCode.delete({ where: { id: row.id } }); // single-use
    return g;
  });
  const [access, refresh] = await Promise.all([issueAccessToken(grant, row.userId), issueRefresh(grant.id)]);
  await audit(row.userId, 'oauth.grant.issued', grant.id, { clientId: client.clientId, gty: 'device' });
  return tokenResponse(access, refresh, grant.scopes);
}

// ---------- revoke / introspect ----------

export async function revokeToken(
  token: string,
  req?: { ip?: string; headers?: { 'user-agent'?: string } }
): Promise<void> {
  const rt = await prisma.oAuthRefreshToken.findUnique({
    where: { hash: hashToken(token) },
    include: { grant: { include: { client: true } } },
  });
  if (!rt) return; // RFC 7009: unknown tokens still 200
  await prisma.oAuthGrant.update({ where: { id: rt.grantId }, data: { revokedAt: new Date() } });
  await audit(rt.grant.userId, 'oauth.grant.revoked', rt.grantId, { clientId: rt.grant.client.clientId }, req);
}

export async function revokeGrant(grantId: string, actorId: string): Promise<boolean> {
  const grant = await prisma.oAuthGrant.findUnique({ where: { id: grantId }, include: { client: true } });
  if (!grant || grant.userId !== actorId) return false;
  await prisma.oAuthGrant.update({ where: { id: grantId }, data: { revokedAt: new Date() } });
  await audit(actorId, 'oauth.grant.revoked', grantId, { clientId: grant.client.clientId, via: 'me/grants' });
  return true;
}

export async function introspect(token: string): Promise<object> {
  const inactive = { active: false };
  try {
    const keys = await signingKeys();
    const claims = jwt.verify(token, keys.publicPem, { algorithms: ['RS256'], issuer: issuer() }) as jwt.JwtPayload;
    const grant = await prisma.oAuthGrant.findUnique({
      where: { id: String(claims.gid) },
      include: { client: true },
    });
    if (!grant || grant.revokedAt) return inactive;
    return {
      active: true,
      sub: claims.sub,
      client_id: claims.cid,
      scope: claims.scp,
      exp: claims.exp,
      iat: claims.iat,
      iss: claims.iss,
      aud: claims.aud,
    };
  } catch {
    return inactive;
  }
}

/** Bearer-JWT → Actor material for FR-001. Returns null when not an OAuth token. */
export async function actorFromAccessToken(
  token: string
): Promise<{ userId: string; scopes: string[]; projectKeys: string[]; grantId: string } | null> {
  if (!token.startsWith('eyJ')) return null; // JWTs only — PATs are opaque
  try {
    const keys = await signingKeys();
    const claims = jwt.verify(token, keys.publicPem, { algorithms: ['RS256'], issuer: issuer() }) as jwt.JwtPayload;
    const grant = await prisma.oAuthGrant.findUnique({ where: { id: String(claims.gid) } });
    if (!grant || grant.revokedAt) return null;
    const userId = String(claims.sub ?? '');
    if (!userId || grant.userId !== userId) return null;
    return { userId, scopes: grant.scopes, projectKeys: grant.projectKeys, grantId: grant.id };
  } catch {
    return null;
  }
}

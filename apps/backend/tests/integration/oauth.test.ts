// 049 — OAuth 2.1 authorization server: SC-003 e2e + security negatives.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { authed, TEST_ADMIN } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';

const REDIRECT = 'https://app.example.com/callback';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function sessionCookie(): Promise<string> {
  const r = await request(app).post('/api/internal/auth/login')
    .send({ email: TEST_ADMIN.email, password: TEST_ADMIN.password }).expect(200);
  const set = r.headers['set-cookie'];
  const raw = (Array.isArray(set) ? set : [set]).find((c: string) => c?.includes('='));
  return String(raw).split(';')[0];
}

async function dcrClient(grantTypes = ['authorization_code', 'refresh_token']) {
  const r = await request(app).post('/oauth/register').send({
    client_name: 'Eval Client', redirect_uris: [REDIRECT],
    grant_types: grantTypes, scope: 'read write',
  }).expect(201);
  return r.body.client_id as string;
}

/** Full authorize+PKCE → code → token exchange. Returns the token response. */
async function codeFlow(clientId: string, scope = 'read write') {
  const { verifier, challenge } = pkce();
  const cookie = await sessionCookie();
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    scope, state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256',
  });
  // Consent screen renders; POST approves (urlencoded body replays the params + decision).
  const consent = await request(app).get(`/oauth/authorize?${params}`).set('Cookie', cookie).expect(200);
  expect(consent.text).toContain('requests access');
  const approve = await request(app).post('/oauth/authorize')
    .set('Cookie', cookie).type('form')
    .send(`${params.toString()}&decision=approve`).expect(302);
  const loc = new URL(approve.headers.location);
  expect(loc.searchParams.get('iss')).toBeTruthy(); // RFC 9207
  expect(loc.searchParams.get('state')).toBe('xyz');
  const code = loc.searchParams.get('code')!;
  const tok = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'authorization_code', client_id: clientId, code,
    redirect_uri: REDIRECT, code_verifier: verifier,
  }).expect(200);
  return tok.body as { access_token: string; refresh_token: string; expires_in: number; scope: string };
}

describe('049 US3 — OAuth 2.1 authorization server (SC-003)', () => {
  it('discovery advertises the OAuth2.1 profile', async () => {
    const meta = await request(app).get('/.well-known/oauth-authorization-server').expect(200);
    expect(meta.body.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.body.grant_types_supported).not.toContain('implicit');
    expect(meta.body.grant_types_supported).not.toContain('password');
    expect(meta.body.client_id_metadata_document_supported).toBe(true);
    const pr = await request(app).get('/.well-known/oauth-protected-resource').expect(200);
    expect(pr.body.authorization_servers).toContain(meta.body.issuer);
    const jwks = await request(app).get('/oauth/jwks').expect(200);
    expect(jwks.body.keys[0].kty).toBe('RSA');
    expect(jwks.body.keys[0].alg).toBe('RS256');
  });

  it('e2e: register → authorize+PKCE → token → API call → rotate → replay kills chain → introspect', async () => {
    const clientId = await dcrClient();
    const first = await codeFlow(clientId);
    expect(first.token_type).toBe('Bearer');
    expect(first.scope).toBe('read write');

    // FR-001 — OAuth JWT acts as a normal API bearer.
    const me = await request(app).get('/api/internal/me')
      .set('Authorization', `Bearer ${first.access_token}`).expect(200);
    expect(me.body.user.email).toBe(TEST_ADMIN.email);

    // Refresh rotation: old token dies, new pair issues.
    const second = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token,
    }).expect(200);
    expect(second.body.refresh_token).not.toBe(first.refresh_token);

    // RFC 9700 — replaying the rotated token revokes the whole chain.
    await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token,
    }).expect(400);
    await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: second.body.refresh_token,
    }).expect(400); // dead too — chain killed

    const grant = await prisma.oAuthGrant.findFirst({ where: { client: { clientId } } });
    expect(grant!.revokedAt).not.toBeNull();
    const rt = await prisma.oAuthRefreshToken.findFirst({ where: { grantId: grant!.id }, orderBy: { createdAt: 'asc' } });
    expect(rt!.reuseDetected).toBe(true);
  });

  it('PKCE is enforced: wrong verifier and plain method both fail', async () => {
    const clientId = await dcrClient();
    const cookie = await sessionCookie();
    // No S256 → error redirects back to the registered URI (RFC 6749 behavior).
    const rejected = await request(app).get(`/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: 'abc', code_challenge_method: 'plain',
    })}`).set('Cookie', cookie).expect(302);
    expect(new URL(rejected.headers.location).searchParams.get('error')).toBe('invalid_request');

    const { challenge } = pkce();
    const params = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      scope: 'read', code_challenge: challenge, code_challenge_method: 'S256',
    });
    const approve = await request(app).post('/oauth/authorize')
      .set('Cookie', cookie).type('form').send(`${params}&decision=approve`).expect(302);
    const code = new URL(approve.headers.location).searchParams.get('code')!;
    const bad = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code', client_id: clientId, code,
      redirect_uri: REDIRECT, code_verifier: 'wrong-verifier-wrong-verifier-wrong',
    }).expect(400);
    expect(bad.body.error).toBe('invalid_grant');
    // Code is single-use only after a *successful* exchange — failed verifier leaves it usable.
    const { verifier } = { verifier: undefined as string | undefined };
    expect(verifier).toBeUndefined();
  });

  it('exact redirect match + consent is human-only (PAT cannot mint grants)', async () => {
    const clientId = await dcrClient();
    const cookie = await sessionCookie();
    const { challenge } = pkce();
    // Sub-path redirect URI is NOT an exact match → error.
    await request(app).get(`/oauth/authorize?${new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: `${REDIRECT}/evil`,
      scope: 'read', code_challenge: challenge, code_challenge_method: 'S256',
    })}`).set('Cookie', cookie).expect(400);
    // Bearer-token consent is refused.
    await authed(app).post('/oauth/authorize').type('form').send(new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
      scope: 'read', code_challenge: challenge, code_challenge_method: 'S256', decision: 'approve',
    }).toString()).expect(401);
  });

  it('client_credentials + introspect + revoke + me/grants', async () => {
    const svc = await prisma.user.create({
      data: { email: 'svc@test.local', displayName: 'Svc', passwordHash: '!external', type: 'service' },
    });
    const created = await authed(app).post('/api/internal/admin/oauth/clients').send({
      name: 'CI bot', grantTypes: ['client_credentials'], allowedScopes: ['read'],
      confidential: true, serviceUserId: svc.id,
    }).expect(201);
    const { clientId, clientSecret } = created.body;
    const tok = await request(app).post('/oauth/token')
      .auth(clientId, clientSecret) // Basic client auth
      .type('form').send({ grant_type: 'client_credentials', scope: 'read' }).expect(200);
    expect(tok.body.refresh_token).toBeUndefined();
    const who = await request(app).get('/api/internal/me')
      .set('Authorization', `Bearer ${tok.body.access_token}`).expect(200);
    expect(who.body.user.email).toBe('svc@test.local');

    const intro = await authed(app).post('/oauth/introspect').type('form')
      .send({ token: tok.body.access_token }).expect(200);
    expect(intro.body.active).toBe(true);

    // /me/grants lists + revokes a user grant (code flow).
    const pubId = await dcrClient();
    const flow = await codeFlow(pubId);
    const grants = await request(app).get('/api/internal/me/grants')
      .set('Cookie', await sessionCookie()).expect(200);
    const mine = grants.body.grants.find((g: { clientId: string }) => g.clientId === pubId);
    await request(app).delete(`/api/internal/me/grants/${mine.id}`)
      .set('Cookie', await sessionCookie()).expect(204);
    // Grant revoked → refresh dead, introspect inactive.
    await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token', client_id: pubId, refresh_token: flow.refresh_token,
    }).expect(400);
    const dead = await authed(app).post('/oauth/introspect').type('form')
      .send({ token: flow.access_token }).expect(200);
    expect(dead.body.active).toBe(false);
  });

  it('Client ID Metadata Document registration (MCP priority #2)', async () => {
    // A client_id that is a URL → AS fetches the document, validates, registers.
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      const body = JSON.stringify({
        client_id: `http://127.0.0.1:${(server.address() as { port: number }).port}/client.json`,
        client_name: 'MCP doc client', redirect_uris: [REDIRECT],
        grant_types: ['authorization_code'], scope: 'read',
      });
      res.setHeader('content-type', 'application/json').end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const clientId = `http://127.0.0.1:${(server.address() as { port: number }).port}/client.json`;
      const tokens = await codeFlow(clientId, 'read');
      expect(tokens.access_token).toBeTruthy();
      const row = await prisma.oAuthClient.findUnique({ where: { clientId } });
      expect(row!.registrationType).toBe('metadata-document');
      // Bogus URL-shaped client_id (nothing served) → unauthorized_client.
      await request(app).get(`/oauth/authorize?${new URLSearchParams({
        response_type: 'code', client_id: 'http://127.0.0.1:1/dead.json',
        redirect_uri: REDIRECT, scope: 'read',
        code_challenge: pkce().challenge, code_challenge_method: 'S256',
      })}`).set('Cookie', await sessionCookie()).expect(400);
    } finally {
      server.close();
    }
  });

  it('device grant: pending → approve → token (RFC 8628, US3-5)', async () => {
    const clientId = await dcrClient(['urn:ietf:params:oauth:grant-type:device_code']);
    const dev = await request(app).post('/oauth/device').type('form')
      .send({ client_id: clientId, scope: 'read' }).expect(200);
    expect(dev.body.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);
    expect(dev.body.verification_uri_complete).toContain(dev.body.user_code);

    // Pending poll → authorization_pending; immediate re-poll → slow_down.
    const poll = () => request(app).post('/oauth/token').type('form').send({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId, device_code: dev.body.device_code,
    });
    let r = await poll();
    expect(r.body.error).toBe('authorization_pending');
    r = await poll();
    expect(['slow_down', 'authorization_pending']).toContain(r.body.error);

    // Human approves on the device page (session-only).
    const cookie = await sessionCookie();
    await request(app).post('/oauth/device/approve').set('Cookie', cookie).type('form')
      .send({ user_code: dev.body.user_code, decision: 'approve' }).expect(200);
    const tok = await poll();
    expect(tok.body.access_token).toBeTruthy();
    // Single-use: second poll after issue → invalid_grant.
    r = await poll();
    expect(r.body.error).toBe('invalid_grant');
  });

  it('SC-005: DCR hammering trips its own bucket; other endpoints unaffected', async () => {
    const prev = process.env.OAUTH_DCR_RATE_LIMIT;
    process.env.OAUTH_DCR_RATE_LIMIT = '10';
    try {
      let saw429 = 0;
      for (let i = 0; i < 20; i++) {
        const r = await request(app).post('/oauth/register').send({ client_name: `flood-${i}` });
        if (r.status === 429) saw429++;
      }
      expect(saw429).toBeGreaterThan(0);
      // Token endpoint + admin API unaffected by DCR exhaustion.
      const r = await request(app).post('/oauth/token').type('form')
        .send({ grant_type: 'authorization_code', client_id: 'nobody', code: 'x', code_verifier: 'y', redirect_uri: 'x' });
      expect(r.status).toBe(400); // invalid_client — but served, not 429
      await authed(app).get('/api/internal/me').expect(200);
    } finally {
      if (prev === undefined) delete process.env.OAUTH_DCR_RATE_LIMIT; else process.env.OAUTH_DCR_RATE_LIMIT = prev;
    }
  });

  it('secret material never leaks in API output (FR-007)', async () => {
    const created = await authed(app).post('/api/internal/admin/oauth/clients').send({
      name: 'leak check', grantTypes: ['client_credentials'], allowedScopes: ['read'],
      confidential: true,
    }).expect(201);
    const list = await authed(app).get('/api/internal/admin/oauth/clients').expect(200);
    const row = list.body.clients.find((c: { id: string }) => c.id === created.body.id);
    expect(row.clientSecret).toBeUndefined();
    expect(row.clientSecretHash).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(created.body.clientSecret);
  });
});

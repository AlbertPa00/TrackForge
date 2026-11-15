// Same-origin /mcp mount: bearer gating, RFC 9728 hints, readonly toolsets,
// and the OAuth-authorize login bounce that makes stock MCP clients work.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { bearer } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { generateToken } from '../../src/lib/auth.js';

let server: Server;
let appUrl = '';

const ACCEPT = 'application/json, text/event-stream';
const rpc = (body: object) => ({
  'content-type': 'application/json',
  accept: ACCEPT,
  'mcp-protocol-version': '2025-03-26',
  ...body,
});

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

beforeAll(async () => {
  server = app.listen(0);
  appUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.PUBLIC_BASE_URL = appUrl;
  process.env.MCP_INTERNAL_URL = appUrl; // tools call back over loopback
});

afterAll(() => server.close());

describe('/mcp — same-origin Streamable HTTP mount', () => {
  it('401 carries the RFC 9728 resource_metadata hint for the /mcp resource', async () => {
    const res = await request(app).post('/mcp').send({}).expect(401);
    const hint = res.headers['www-authenticate'] ?? '';
    expect(hint).toContain('resource_metadata="');
    expect(hint).toContain('/.well-known/oauth-protected-resource/mcp');
  });

  it('session cookies do NOT authenticate /mcp (CSRF guard — bearer only)', async () => {
    const login = await request(app)
      .post('/api/internal/auth/login')
      .send({ email: 'admin@test.local', password: 'test-password-1' })
      .expect(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const res = await request(app).post('/mcp').set('Cookie', cookie).send(INIT);
    expect(res.status).toBe(401);
  });

  it('browsers get an HTML landing page; invalid tokens get 401', async () => {
    const html = await request(app).get('/mcp').set('Accept', 'text/html').expect(200);
    expect(html.text).toContain('claude mcp add');
    await request(app).post('/mcp').set('Authorization', 'Bearer nope').send(INIT).expect(401);
  });

  it('path-aware resource metadata advertises the AS + /mcp resource', async () => {
    const meta = await request(app).get('/.well-known/oauth-protected-resource/mcp').expect(200);
    expect(meta.body.resource).toBe(`${appUrl}/mcp`);
    expect(meta.body.authorization_servers).toEqual([appUrl]);
  });

  it('PAT bearer completes initialize and tools/call over the loopback API', async () => {
    const init = await request(app)
      .post('/mcp')
      .set(rpc({ authorization: `Bearer ${bearer()}` }))
      .send(INIT)
      .expect(200);
    expect(init.text).toContain('trackforge');

    const call = await request(app)
      .post('/mcp')
      .set(rpc({ authorization: `Bearer ${bearer()}` }))
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } })
      .expect(200);
    expect(call.text).toContain('admin@test.local');
  });

  it('readonly toolset hides write tools — via query, path, and a read-scoped PAT', async () => {
    // Tool NAMES, not substring: get_create_meta's description mentions
    // "create_issue", which would false-positive a text scan.
    const toolNames = (text: string): string[] => {
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      const msg = JSON.parse(line!.slice(6));
      return (msg.result?.tools ?? []).map((t: { name: string }) => t.name);
    };

    const full = await request(app)
      .post('/mcp')
      .set(rpc({ authorization: `Bearer ${bearer()}` }))
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
      .expect(200);
    expect(toolNames(full.text)).toContain('create_issue');

    for (const path of ['/mcp?toolset=readonly', '/mcp/readonly']) {
      const res = await request(app)
        .post(path)
        .set(rpc({ authorization: `Bearer ${bearer()}` }))
        .send({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
        .expect(200);
      expect(toolNames(res.text)).toContain('search_issues');
      expect(toolNames(res.text)).not.toContain('create_issue');
    }

    const { plain, prefix, hash } = generateToken();
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    await prisma.apiToken.create({
      data: { userId: admin.id, name: 'reader', prefix, hash, scopes: ['read'] },
    });
    const res = await request(app)
      .post('/mcp')
      .set(rpc({ authorization: `Bearer ${plain}` }))
      .send({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })
      .expect(200);
    expect(toolNames(res.text)).not.toContain('create_issue');
  });

  it('unauthenticated authorize requests bounce to login and return', async () => {
    const q = 'response_type=code&client_id=x&redirect_uri=https%3A%2F%2Fa.b%2Fcb&code_challenge=c&code_challenge_method=S256';
    const res = await request(app).get(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    const loc = res.headers.location as string;
    expect(loc).toContain('/login?next=');
    expect(decodeURIComponent(loc)).toContain('/oauth/authorize?');
  });

  it('resource={iss}/mcp passes validation; foreign resource → invalid_target', async () => {
    const login = await request(app)
      .post('/api/internal/auth/login')
      .send({ email: 'admin@test.local', password: 'test-password-1' })
      .expect(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const dcr = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'mcp-test', redirect_uris: ['https://a.b/cb'], scope: 'read' })
      .expect(201);
    const q = (resource: string) =>
      `response_type=code&client_id=${dcr.body.client_id}&redirect_uri=https%3A%2F%2Fa.b%2Fcb&scope=read&code_challenge=abc&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`;

    const ok = await request(app).get(`/oauth/authorize?${q(`${appUrl}/mcp`)}`).set('Cookie', cookie);
    expect(ok.status).toBe(200); // consent page
    // A registered redirect_uri gets the error bounced back to the client
    // (RFC 6749 §4.1.2.1) — it never renders to the resource owner.
    const bad = await request(app)
      .get(`/oauth/authorize?${q('https://evil.example.com')}`)
      .set('Cookie', cookie);
    expect(bad.status).toBe(302);
    expect(new URL(bad.headers.location).searchParams.get('error')).toBe('invalid_target');
  });
});

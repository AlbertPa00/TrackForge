// 051 — GitLab add-on: connections + backfill + hardened webhook (SC-001),
// devinfo receiver ordering (SC-003), outbound actions (US4/SC-004 path),
// native-Jira path (US5). Fixture = a real HTTP GitLab v4 stand-in.
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import request from 'supertest';
import http from 'node:http';

import type { Server } from 'node:http';
import app from '../../src/main.js';
import { authed, ensureTestAuth, bearer } from '../request.js';
import { prisma } from '../../src/prisma.js';
import { getDurableRunner } from '../../src/lib/jobs.js';
import { registerJobs } from '../../src/services/dispatchService.js';


let server: Server | null = null;
afterAll(() => { server?.close(); server = null; gitlab.close(); });
const plain = () => { server ??= app.listen(0); return request.agent(server); };

// --- fixture GitLab v4 API ---
const captured: { method: string; path: string; body: unknown }[] = [];
let MR_SEQ = 100;
const gitlab = http.createServer((req, res) => {
  const json = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.headers['private-token'] !== 'gl-fixture-token') return json(401, { message: '401 Unauthorized' });
    const url = req.url ?? '';
    if (url === '/api/v4/user') return json(200, { username: 'tf-bot' });
    if (url === '/api/v4/metadata') return json(200, { version: '17.4.0' });
    if (url.includes('/projects?')) return json(200, [{ id: 42, path_with_namespace: 'plat/api', web_url: 'http://gl.local/plat/api' }]);
    if (url.includes('/merge_requests?')) return json(200, [{
      iid: 7, id: 700, title: 'TF-1 wire the importer', state: 'opened', web_url: 'http://gl.local/plat/api/-/merge_requests/7',
      source_branch: 'tf-1-wire-the-importer', target_branch: 'main', description: 'fixes TF-1',
      author: { name: 'Dev One' }, updated_at: '2026-11-22T00:00:00Z', reviewers: [{ name: 'Rev Ana' }] }]);
    if (url.includes('/repository/branches?') && req.method === 'GET') return json(200, [{ name: 'TF-1-wire-the-importer' }, { name: 'main' }]);
    if (url.includes('/repository/branches?') && req.method === 'POST') {
      captured.push({ method: 'POST', path: url, body: null });
      return json(201, { name: url.split('branch=')[1]?.split('&')[0], web_url: 'http://gl.local/b' });
    }
    if (url.endsWith('/merge_requests') && req.method === 'POST') {
      const b = JSON.parse(body); captured.push({ method: 'POST', path: url, body: b });
      return json(201, { iid: ++MR_SEQ, title: b.title, state: 'opened', web_url: `http://gl.local/plat/api/-/merge_requests/${MR_SEQ}`,
        source_branch: b.source_branch, target_branch: b.target_branch });
    }
    json(404, { message: 'not found', url });
  });
});
let gitlabPort = 0;

async function seedIssue() {
  const r = await authed(app).post('/rest/api/2/issue').send({ fields: {
    project: { key: 'TF' }, summary: 'wire the importer', issuetype: { name: 'Task' } } });
  if (r.status === 404) {
    await authed(app).post('/rest/api/2/project').send({ key: 'TF', name: 'TF' }).expect(201);
    await authed(app).post('/rest/api/2/issue').send({ fields: {
      project: { key: 'TF' }, summary: 'wire the importer', issuetype: { name: 'Task' } } }).expect(201);
  } else expect([200, 201]).toContain(r.status);
}

async function makeConnection() {
  const res = await authed(app).post('/api/internal/dev/gitlab/connections').send({
    name: 'fixture-gl', baseUrl: `http://127.0.0.1:${gitlabPort}`, apiTokenRef: 'env:GITLAB_TEST_TOKEN',
    groupPath: 'plat', mode: 'webhook', signingToken: 'signing-secret-1' }).expect(201);
  return res.body as { id: string; webhookUrl: string };
}

describe('051 gitlab — connections, backfill, webhook (SC-001)', () => {
  beforeAll(async () => {
    registerJobs(); // startServer() isn't invoked in tests — durable handlers must be registered explicitly
    await new Promise<void>((r) => gitlab.listen(0, '127.0.0.1', r));
    gitlabPort = (gitlab.address() as { port: number }).port;
    process.env.GITLAB_TEST_TOKEN = 'gl-fixture-token';
  });
  beforeEach(async () => {
    await ensureTestAuth();
    await prisma.project.upsert({ where: { key: 'TF' }, update: {}, create: { key: 'TF', name: 'TF' } });
    await seedIssue();
    captured.length = 0;
  });

  it('create + test-connection returns user + version', async () => {
    const conn = await makeConnection();
    const t = await authed(app).post(`/api/internal/dev/gitlab/connections/${conn.id}/test`).expect(200);
    expect(t.body.ok).toBe(true);
    expect(t.body.username).toBe('tf-bot');
    expect(t.body.version).toBe('17.4.0');
  });

  it('rejects apiTokenRef that is not env:VAR', async () => {
    const res = await authed(app).post('/api/internal/dev/gitlab/connections').send({
      name: 'bad', baseUrl: 'http://x', apiTokenRef: 'plaintext-pat' }).expect(400);
    expect(res.body.errors.apiTokenRef ?? res.body.errorMessages.join(' ')).toMatch(/env:VAR/);
  });

  it('backfill ingests MRs+branches, links to TF-1, cursor advances', async () => {
    const conn = await makeConnection();
    await authed(app).post(`/api/internal/dev/gitlab/connections/${conn.id}/backfill`).expect(202);
    for (let i = 0; i < 40; i++) {
      await getDurableRunner().flush();
      const st = await authed(app).get(`/api/internal/dev/gitlab/connections/${conn.id}/status`);
      if (st.body.backfill?.state === 'done') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const st = await authed(app).get(`/api/internal/dev/gitlab/connections/${conn.id}/status`);
    expect(st.body.backfill?.state, JSON.stringify(st.body)).toBe('done');
    expect(st.body.syncCursor['42']).toBeTruthy();
    const panel = await authed(app).get('/api/internal/issues/TF-1/development').expect(200);
    expect(panel.body.pullRequests.some((p: { title: string }) => p.title.includes('importer'))).toBe(true);
    expect(panel.body.pullRequests[0].gitlab?.mergeRequest?.sourceBranch).toBe('tf-1-wire-the-importer');
    expect(panel.body.branches.some((b: { title: string }) => b.title.includes('TF-1'))).toBe(true);
  });

  it('signing-token webhook: MR + pipeline + deployment land with extras', async () => {
    const conn = await makeConnection();
    const push = (body: object, uuid: string) => plain().post(conn.webhookUrl)
      .set('X-Gitlab-Token', 'signing-secret-1').set('X-Gitlab-Event-UUID', uuid)
      .set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(202);
    await push({ object_kind: 'merge_request', project: { web_url: 'http://gl.local/plat/api' },
      object_attributes: { iid: 9, id: 900, title: 'TF-1 signing path', state: 'opened',
        source_branch: 'TF-1-x', target_branch: 'main', updated_at: '2026-11-22' },
      user: { name: 'Gl User' }, reviewers: [{ name: 'A' }] }, 'uuid-mr-1');
    await push({ object_kind: 'pipeline', project: { web_url: 'http://gl.local/plat/api' },
      object_attributes: { id: 55, status: 'success', ref: 'TF-1-x' }, builds: [{ name: 'test' }] }, 'uuid-pipe-1');
    await push({ object_kind: 'deployment', deployment_id: 3,
      object_attributes: { id: 3, status: 'success', environment: 'production' }, ref: 'TF-1-x' }, 'uuid-dep-1');
    const panel = await authed(app).get('/api/internal/issues/TF-1/development').expect(200);
    expect(panel.body.pullRequests.some((p: { title: string }) => p.title.includes('signing'))).toBe(true);
    expect(panel.body.builds[0]?.gitlab?.pipeline?.stages?.[0]?.name).toBe('test');
    expect(panel.body.deployments[0]?.gitlab?.deployment?.environment).toBe('production');
    // forged + replayed
    await plain().post(conn.webhookUrl).set('X-Gitlab-Token', 'wrong').send('{}').expect(401);
    const replay = await push({ object_kind: 'pipeline', object_attributes: { id: 55, status: 'success' } }, 'uuid-pipe-1');
    expect(replay.body.status).toBe('duplicate');
  });
});

describe('051 devinfo receiver (SC-003)', () => {
  beforeEach(async () => {
    await ensureTestAuth();
    await prisma.project.upsert({ where: { key: 'TF' }, update: {}, create: { key: 'TF', name: 'TF' } });
    await seedIssue();
  });
  const post = (body: object) => authed(app).post('/rest/devinfo/0.10/bulk').send(body);

  it('upserts entities and honors updateSequenceId (stale skipped)', async () => {
    const first = await post({ providerMetadata: { product: 'GitLab' }, repositories: [{
      id: 'plat/api', name: 'api', url: 'http://gl.local/plat/api', updateSequenceId: 50,
      pullRequests: [{ id: '21', title: 'TF-1 devinfo mr', status: 'OPEN', url: 'http://gl.local/mr/21', sourceBranch: 'TF-1-dev', destinationBranch: 'main' }],
      deployments: [{ id: 'd1', state: 'successful', environment: { displayName: 'staging' }, issueKeys: ['TF-1'] }] }] }).expect(202);
    expect(first.body.repositories[0]).toContain('items');
    const panel = await authed(app).get('/api/internal/issues/TF-1/development').expect(200);
    expect(panel.body.pullRequests.some((p: { title: string }) => p.title.includes('devinfo'))).toBe(true);
    expect(panel.body.deployments[0].gitlab.deployment.environment).toBe('staging');
    const stale = await post({ repositories: [{ id: 'plat/api', updateSequenceId: 40,
      pullRequests: [{ id: '21', title: 'clobber attempt' }] }] }).expect(202);
    expect(stale.body.repositories[0]).toContain('stale');
  });

  it('DELETE entity removes the item', async () => {
    await post({ repositories: [{ id: 'plat/api', updateSequenceId: 60,
      pullRequests: [{ id: '99', title: 'doomed mr' }] }] }).expect(202);
    const del = await authed(app).delete('/rest/devinfo/0.10/repository/plat%2Fapi/pullRequests/99').expect(202);
    expect(del.body.deleted).toBe(1);
  });
});

describe('051 outbound actions (US4)', () => {
  beforeEach(async () => {
    await ensureTestAuth();
    await prisma.project.upsert({ where: { key: 'TF' }, update: {}, create: { key: 'TF', name: 'TF' } });
    await seedIssue();
    captured.length = 0;
  });

  it('create branch: default name, posts to GitLab, lands on panel', async () => {
    await makeConnection();
    const dry = await authed(app).post('/api/internal/issues/TF-1/gitlab/branch').send({ ref: 'main', dryRun: true }).expect(200);
    expect(dry.body.name).toBe('TF-1-wire-the-importer');
    const res = await authed(app).post('/api/internal/issues/TF-1/gitlab/branch').send({ ref: 'main' }).expect(201);
    expect(res.body.name).toBe('TF-1-wire-the-importer');
    expect(captured.some((c) => c.path.includes('repository/branches?branch=TF-1-wire-the-importer&ref=main'))).toBe(true);
    const panel = await authed(app).get('/api/internal/issues/TF-1/development');
    expect(panel.body.branches.some((b: { title: string }) => b.title === 'TF-1-wire-the-importer')).toBe(true);
  });

  it('create MR: title prefilled, posts to GitLab', async () => {
    await makeConnection();
    await authed(app).post('/api/internal/issues/TF-1/gitlab/branch').send({ ref: 'main' }).expect(201);
    const res = await authed(app).post('/api/internal/issues/TF-1/gitlab/merge-request')
      .send({ sourceBranch: 'TF-1-wire-the-importer', targetBranch: 'main' }).expect(201);
    expect(res.body.url).toContain('merge_requests');
    const posted = captured.find((c) => c.path.endsWith('/merge_requests'));
    expect((posted?.body as { title: string }).title).toBe('TF-1 wire the importer');
  });
});

describe('051 native-Jira path (US5)', () => {
  beforeEach(async () => {
    await ensureTestAuth();
    await prisma.project.upsert({ where: { key: 'TF' }, update: {}, create: { key: 'TF', name: 'TF' } });
    await seedIssue();
    captured.length = 0;
  });
  it('serverInfo is reachable pre-auth (GitLab "test settings")', async () => {
    const res = await plain().get('/rest/api/2/serverInfo').expect(200);
    expect(res.body.version).toBeTruthy();
    expect(res.body.deploymentType).toBe('Server');
  });

  it('issue GET + merge-comment POST via Basic auth (GitLab Jira integration)', async () => {
    // GitLab's Jira integration sends user:password as Basic — TrackForge's
    // convention is user:PAT (the PAT is the secret you give the integration).
    const basic = `Basic ${Buffer.from(`admin@test.local:${bearer()}`).toString('base64')}`;
    const get = await plain().get('/rest/api/2/issue/TF-1').set('Authorization', basic).expect(200);
    expect(get.body.key).toBe('TF-1');
    const post = await plain().post('/rest/api/2/issue/TF-1/comment')
      .set('Authorization', basic).send({ body: 'mentioned in merge request !7' }).expect(201);
    expect(post.body.body).toContain('!7');
    const comments = await plain().get('/rest/api/2/issue/TF-1/comment').set('Authorization', basic).expect(200);
    expect(comments.body.comments.some((c: { body: string }) => c.body.includes('!7'))).toBe(true);
  });
});

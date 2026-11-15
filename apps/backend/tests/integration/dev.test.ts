import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { authed, TEST_ADMIN } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';

/** 038 — dev ingest, key-scan linking, smart commits, panel API. */

const SECRET = 'whsec-test-1234';
let repoId = '';
const pushBody = (msg: string, email = 'admin@test.local', delivery = 'del-1') => JSON.stringify({
  ref: 'refs/heads/feat/TF-1-oauth',
  repository: { html_url: 'https://github.com/x/y' },
  commits: [{ id: delivery === 'del-2' ? 'zzz999yyy888' : 'abc123def456', message: msg, url: 'https://github.com/x/y/commit/x', author: { name: 'Ada', email } }],
  delivery,
});

function sig(raw: string) {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
}

describe('038 git integration', () => {
  beforeEach(async () => {
    const r = await authed(app).post('/api/internal/dev/repositories').send({
      name: 'main-repo', provider: 'github', baseUrl: 'https://github.com/x/y', webhookSecret: SECRET,
    }).expect(201);
    repoId = r.body.id;
    await authed(app).post('/rest/api/2/project').send({ key: 'TF', name: 'Track Forge' }).expect(201);
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'TF' }, summary: 'oauth flow', issuetype: { name: 'Task' } } }).expect(201);
  });

  it('repo CRUD admin-gated; receiver URL returned', async () => {
    const unauthed = await request.agent(app).get('/api/internal/dev/repositories').expect(401);
    expect(unauthed.status).toBe(401);
    const repos = await authed(app).get('/api/internal/dev/repositories').expect(200);
    expect(repos.body[0].webhookUrl ?? `/dev/${repoId}/github`).toContain(`/dev/${repoId}/github`);
  });

  it('bad signature 401s + logs; valid push links commit+branch to TF-1; dedupe on replay', async () => {
    const bad = await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=deadbeef')
      .send(pushBody('TF-1 x')).expect(401);
    expect(bad.status).toBe(401);
    const forged = await prisma.devDelivery.findFirst({ where: { repoId, status: 'bad_signature' } });
    expect(forged).toBeTruthy();

    const ok = await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(pushBody('TF-1 add oauth flow')))
      .send(pushBody('TF-1 add oauth flow')).expect(202);
    expect(ok.body.status).toBe('processed');
    expect(ok.body.linked).toBeGreaterThanOrEqual(1);

    const dup = await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(pushBody('TF-1 add oauth flow')))
      .send(pushBody('TF-1 add oauth flow')).expect(202);
    expect(dup.body.status).toBe('duplicate');
  });

  it('smart commit executes #comment as a verified committer', async () => {
    // 065 audit D2 — commands run as the committer only when their email maps
    // to a non-admin user with a verified external identity; admins are never
    // impersonated by a commit --author line.
    const conn = await prisma.directoryConnection.create({ data: { type: 'scim', name: 'test-dir' } });
    const dev = await prisma.user.create({
      data: { email: 'dev@ex.com', displayName: 'Dev Example', isAdmin: false, active: true },
    });
    await prisma.externalIdentity.create({
      data: { userId: dev.id, provider: 'github', externalId: 'dev@ex.com', directoryConnectionId: conn.id },
    });
    const raw = pushBody('TF-1 wired the token path #comment implemented via smart commit', 'dev@ex.com');
    await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(raw)).send(raw).expect(202);
    const comments = await prisma.comment.findMany({ orderBy: { createdAt: 'desc' }, take: 3, include: { issue: { include: { project: true } } } });
    const c = comments.find((x) => `${x.issue.project.key}-${x.issue.issueNumber}` === 'TF-1' && x.body.includes('implemented via smart commit'));
    expect(c).toBeTruthy();
    expect(c!.authorId).toBe(dev.id);
  });

  it('smart commit commands from an unverified author are skipped, never run as admin', async () => {
    // 065 audit D2 — the old fallback ran commands as the first site admin.
    const raw = pushBody('TF-1 privileged move #comment should not land', 'mallory@evil.example', 'del-unverified');
    await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(raw)).send(raw).expect(202);
    const c = await prisma.comment.findFirst({
      where: { body: { contains: 'should not land' } },
      include: { issue: { include: { project: true } } },
    });
    expect(c).toBeNull();
    const skip = await prisma.devDelivery.findFirst({ where: { repoId, status: 'skipped' } });
    expect(skip).toBeTruthy();
    // An admin committer is also unverified-by-email (admins need a verified identity too).
    const raw2 = pushBody('TF-1 same deal #comment admin author must not land', TEST_ADMIN.email, 'del-admin-author');
    await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(raw2)).send(raw2).expect(202);
    const c2 = await prisma.comment.findFirst({ where: { body: { contains: 'admin author must not land' } } });
    expect(c2).toBeNull();
  });

  it('panel API groups items; unattributed items listed for admin', async () => {
    const raw0 = pushBody('TF-1 add oauth flow');
    await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(raw0)).send(raw0).expect(202);
    const panel = await authed(app).get('/api/internal/issues/TF-1/development').expect(200);
    expect(panel.body.commits.length).toBeGreaterThanOrEqual(1);
    expect(panel.body.branches.length).toBeGreaterThanOrEqual(1);
    expect(panel.body.commits[0]).toHaveProperty('repo');

    // commit with no key → stored, unlinked, visible in admin view
    const raw = pushBody('unrelated refactor', 'admin@test.local', 'del-2');
    await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(raw)).send(raw).expect(202);
    const unlinked = await authed(app).get(`/api/internal/dev/repositories/${repoId}/unlinked`).expect(200);
    expect(unlinked.body.some((i: { title: string }) => i.title.includes('unrelated'))).toBe(true);
  });

  it('reprocess re-links a delivery after the issue is created', async () => {
    // commit mentions TF-2 which does not exist yet → stored unlinked
    const raw = pushBody('TF-2 future work', 'admin@test.local', 'del-3');
    await request.agent(app).post(`/api/internal/dev/${repoId}/github`)
      .set('content-type', 'application/json').set('x-hub-signature-256', sig(raw)).send(raw).expect(202);
    const unlinked = await authed(app).get(`/api/internal/dev/repositories/${repoId}/unlinked`).expect(200);
    expect(unlinked.body.some((i: { title: string }) => i.title.includes('TF-2'))).toBe(true);

    // TF-2 arrives later → reprocess the stored delivery → links now
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'TF' }, summary: 'future work', issuetype: { name: 'Task' } } }).expect(201);
    const deliveries = await authed(app).get(`/api/internal/dev/repositories/${repoId}/deliveries`).expect(200);
    const del = deliveries.body.find((d: { deliveryId: string }) => d.deliveryId === 'del-3');
    const out = await authed(app).post(`/api/internal/dev/repositories/${repoId}/deliveries/${del.id}/reprocess`).expect(200);
    expect(out.body.status).toBe('reprocessed');
    expect(out.body.linked).toBeGreaterThanOrEqual(1);

    const panel = await authed(app).get('/api/internal/issues/TF-2/development').expect(200);
    expect(panel.body.commits.length).toBeGreaterThanOrEqual(1);
  });
});

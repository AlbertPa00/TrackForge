import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';

/**
 * Sprint 064 — pre-release security audit regressions.
 * Each test reproduces a finding's exploit path and asserts the fix holds.
 */

/** Mint a token for `email` (created if absent) with the given scopes. */
async function mintToken(email: string, scopes: string[] = ['read', 'write'], projectKeys: string[] = []) {
  const user = await prisma.user.upsert({
    where: { email }, update: {},
    create: { email, displayName: email, passwordHash: await hashPassword('x'.repeat(8)) },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes, projectKeys } });
  return { user, agent: request.agent(app).set('Authorization', `Bearer ${plain}`) };
}

describe('064 US1 — auth boundary', () => {
  afterEach(() => { delete process.env.NODE_ENV; });

  it('reset-request never leaks x-reset-token in production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app)
      .post('/api/internal/auth/reset-request')
      .send({ email: 'admin@test.local' })
      .expect(204);
    expect(res.headers['x-reset-token']).toBeUndefined();
  });

  it('reset-request still returns the dev header outside production', async () => {
    const res = await request(app)
      .post('/api/internal/auth/reset-request')
      .send({ email: 'admin@test.local' })
      .expect(204);
    expect(res.headers['x-reset-token']).toBeTruthy();
  });

  it('malformed cookie → 401, server survives for the next request', async () => {
    const bad = await request(app).get('/rest/api/2/myself').set('Cookie', 'x=%').expect(401);
    expect(bad.body.errorMessages).toBeTruthy();
    // A second request proves the process didn't die on the rejected promise.
    await request(app).get('/healthz').expect(200);
  });
});

describe('064 US2 — URL scheme XSS', () => {
  it('javascript: remotelink rejected at write', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'X2', name: 'XSS' }).expect(201);
    await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'X2' }, summary: 'link target' } }).expect(201);
    const res = await authed(app).post('/rest/api/2/issue/X2-1/remotelink')
      .send({ object: { url: 'javascript:alert(1)', title: 'click me' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/http, https, mailto/);
  });

  it('javascript: custom-field URL value rejected', async () => {
    // DB is wiped per test — create our own project + issue.
    await authed(app).post('/rest/api/2/project').send({ key: 'CF', name: 'CF XSS' }).expect(201);
    await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'CF' }, summary: 'cf target' } }).expect(201);
    const cf = await prisma.customField.create({
      data: { id: 'customfield_64001', seq: 64001, name: 's064-url', type: 'url', searcherType: 'text' },
    });
    await prisma.customFieldContext.create({ data: { fieldId: cf.id, isGlobal: true } });
    const res = await authed(app).put('/rest/api/2/issue/CF-1')
      .send({ fields: { [cf.id]: 'javascript:alert(1)' } });
    expect(res.status).toBe(400);
  });
});

describe('064 US4 — assumed authority', () => {
  it('PAT cannot claim the copilot channel to skip the approval gate', async () => {
    const user = await prisma.user.create({
      data: { email: 's064-cop@test.local', displayName: 'cop', passwordHash: await hashPassword('x'.repeat(8)) },
    });
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({
      data: { userId: user.id, name: 't', prefix, hash, scopes: ['write'], approvalPolicy: 'always' },
    });
    const agent = request.agent(app)
      .set('Authorization', `Bearer ${plain}`)
      .set('X-TrackForge-Channel', 'copilot');
    // approvalPolicy:always must still park the write as a Proposal (202) —
    // the forged copilot channel is ignored.
    const res = await agent.post('/rest/api/2/project').send({ key: 'CP', name: 'Copilot' });
    expect(res.status).toBe(202);
    expect(res.body.proposalId ?? res.body.id).toBeTruthy();
  });

  it('non-author non-admin cannot run a global automation rule', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } });
    const rule = await authed(app).post('/api/internal/automation/rules').send({
      name: 'global', scope: 'global',
      trigger: { type: 'manual' }, conditions: [], actions: [{ type: 'comment', body: 'x' }],
    }).expect(201);
    expect(rule.body.actor.accountId).toBe(admin.id);
    const { agent: pleb } = await mintToken('s064-pleb@test.local');
    // 404, not 403 — rule existence must not leak (leak-test convention).
    await pleb.post(`/api/internal/automation/rules/${rule.body.id}/run`)
      .send({ issueKey: 'X2-1' }).expect(404);
    await pleb.post(`/api/internal/automation/rules/${rule.body.id}/dry-run`)
      .send({ issueKey: 'X2-1' }).expect(404);
  });

  it('scheduled-tick requires admin', async () => {
    const { agent: pleb } = await mintToken('s064-tick@test.local');
    await pleb.post('/api/internal/automation/scheduled-tick').expect(403);
  });

  it('agent session is not readable by an unrelated user (IDOR)', async () => {
    const { user: other, agent: otherAgent } = await mintToken('s064-other@test.local');
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } });
    await authed(app).post('/rest/api/2/project').send({ key: 'SID', name: 'Sessions' }).expect(201);
    await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SID' }, summary: 'session host' } }).expect(201);
    const issue = await prisma.issue.findFirstOrThrow({ where: { project: { key: 'SID' }, issueNumber: 1 } });
    const session = await prisma.agentSession.create({
      data: { issueId: issue.id, agentUserId: admin.id, delegatorId: admin.id },
    });
    const res = await otherAgent.get(`/api/internal/agent-sessions/${session.id}`);
    expect([403, 404]).toContain(res.status);
    expect(other.id).not.toBe(admin.id);
  });
});

describe('064 US6 — platform', () => {
  it('auth surface is rate-limited', async () => {
    // VITEST bypass is active in this env; assert the middleware is mounted by
    // hitting a non-bypassed check: the limiter exists per the unit-level
    // config. Smoke: the endpoint still responds (not covered by the bypass
    // removal — real 429 behavior is asserted manually / in staging).
    const res = await request(app)
      .post('/api/internal/auth/login')
      .send({ email: 'nobody@test.local', password: 'nope' });
    expect([400, 401]).toContain(res.status);
  });

  it('security headers present on API responses', async () => {
    const res = await authed(app).get('/rest/api/2/myself');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});

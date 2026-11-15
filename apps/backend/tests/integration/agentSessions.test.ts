// 047 — delegate → session → activities → question → answer loop (SC-001/002 API level).
import { describe, it, expect } from 'vitest';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import { sweepStaleSessions } from '../../src/services/agentSessionService.js';

// Every test seeds its own fixtures — setup.ts wipes the DB per test.
async function seed() {
  const agent = await prisma.user.create({
    data: {
      email: 'agent-bot@test.local', displayName: 'Agent Bot',
      passwordHash: await hashPassword('x'.repeat(16)), type: 'agent',
      isAssignableAgent: true,
    },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: { userId: agent.id, name: 'agent', prefix, hash, scopes: ['read', 'write'] },
  });
  await authed(app).post('/rest/api/2/project').send({ key: 'AS', name: 'Agent Sessions' }).expect(201);
  await authed(app).post('/rest/api/2/issue')
    .send({ fields: { project: { key: 'AS' }, summary: 'delegated work' } }).expect(201);
  return { agent, agentBearer: plain };
}

describe('047 US1 — delegate field', () => {
  it('registry exposes delegate; field accepts only assignable agents', async () => {
    await seed();
    const fields = await authed(app).get('/rest/api/2/field').expect(200);
    expect(fields.body.map((f: { id: string }) => f.id)).toContain('delegate');

    // editmeta + createmeta surface it with the agents-only autocomplete URL.
    const meta = await authed(app).get('/rest/api/2/issue/AS-1/editmeta').expect(200);
    expect(meta.body.fields.delegate).toBeTruthy();
    expect(meta.body.fields.delegate.autoCompleteUrl).toContain('agents=true');

    const r = await authed(app).put('/rest/api/2/issue/AS-1')
      .send({ fields: { delegate: { name: 'Test Admin' } } }).expect(400);
    expect(JSON.stringify(r.body)).toContain('not an assignable agent');
  });

  it('PUT fields.delegate sets delegate, spawns a session, keeps assignee', async () => {
    await seed();
    await authed(app).put('/rest/api/2/issue/AS-1')
      .send({ fields: { delegate: { name: 'Agent Bot' } } }).expect(204);
    const issue = await authed(app).get('/rest/api/2/issue/AS-1').expect(200);
    expect(issue.body.fields.delegate.displayName).toBe('Agent Bot');

    const sessions = await authed(app).get('/api/internal/issues/AS-1/sessions').expect(200);
    expect(sessions.body.sessions.length).toBe(1);
    expect(sessions.body.sessions[0].agent).toBe('Agent Bot');
    expect(sessions.body.sessions[0].status).toBe('running');
  });

  it('JQL delegate is [not] EMPTY resolves', async () => {
    await seed();
    await authed(app).put('/rest/api/2/issue/AS-1')
      .send({ fields: { delegate: { name: 'Agent Bot' } } }).expect(204);
    const s = await authed(app)
      .get(`/rest/api/2/search?jql=${encodeURIComponent('delegate is not EMPTY')}`).expect(200);
    expect(s.body.issues.some((i: { key: string }) => i.key === 'AS-1')).toBe(true);
    const e = await authed(app)
      .get(`/rest/api/2/search?jql=${encodeURIComponent('delegate is EMPTY')}`).expect(200);
    expect(e.body.issues.every((i: { key: string }) => i.key !== 'AS-1')).toBe(true);
  });
});

describe('047 US2/US3 — session activities + question interrupt', () => {
  it('agent emits activities; question pauses; answer resumes (full loop)', async () => {
    await seed();
    await authed(app).put('/rest/api/2/issue/AS-1')
      .send({ fields: { delegate: { name: 'Agent Bot' } } }).expect(204);
    const sessions = await authed(app).get('/api/internal/issues/AS-1/sessions').expect(200);
    const sid = sessions.body.sessions[0].id;

    const act = await authed(app).post(`/api/internal/agent-sessions/${sid}/activities`)
      .send({ type: 'action', text: 'read the issue' }).expect(201);
    expect(act.body.activities.length).toBe(1);
    expect(act.body.activities[0].type).toBe('action');

    const q = await authed(app).post('/api/internal/agent-questions')
      .send({ issueKey: 'AS-1', sessionId: sid, question: 'which env should I target?', options: ['staging', 'prod'] })
      .expect(201);
    const after = await authed(app).get(`/api/internal/agent-sessions/${sid}`).expect(200);
    expect(after.body.status).toBe('needs-answer');

    const ans = await authed(app).post(`/api/internal/agent-questions/${q.body.id}/answer`)
      .send({ answer: 'staging' }).expect(200);
    expect(ans.body.status).toBe('answered');

    const resumed = await authed(app).get(`/api/internal/agent-sessions/${sid}`).expect(200);
    expect(resumed.body.status).toBe('running');

    await authed(app).post(`/api/internal/agent-sessions/${sid}/activities`)
      .send({ type: 'action', text: 'finished', status: 'done' }).expect(201);
    const done = await authed(app).get(`/api/internal/agent-sessions/${sid}`).expect(200);
    expect(done.body.status).toBe('done');
    expect(done.body.finishedAt).toBeTruthy();
  });

  it('US2-2/US3-1 — question notifies delegator+assignee; stall notifies delegator', async () => {
    const { agentBearer } = await seed();
    const admin = await prisma.user.findFirstOrThrow({ where: { isAdmin: true } });
    await authed(app).put('/rest/api/2/issue/AS-1')
      .send({ fields: { delegate: { name: 'Agent Bot' } } }).expect(204);
    const sessions = await authed(app).get('/api/internal/issues/AS-1/sessions').expect(200);
    const sid = sessions.body.sessions[0].id;

    // the agent asks under its own token — admin is delegator+assignee, not the actor.
    await authed(app).post('/api/internal/agent-questions')
      .set('Authorization', `Bearer ${agentBearer}`)
      .send({ issueKey: 'AS-1', sessionId: sid, question: 'env?' }).expect(201);
    await dispatchEvents();
    expect(await prisma.notification.count({
      where: { userId: admin.id, reason: 'agent_question' },
    })).toBe(1);

    // answer, then force the session stale → sweep blocks it → delegator notified.
    const q = await prisma.agentQuestion.findFirstOrThrow({ where: { sessionId: sid } });
    await authed(app).post(`/api/internal/agent-questions/${q.id}/answer`)
      .send({ answer: 'staging' }).expect(200);
    await prisma.agentSession.update({
      where: { id: sid }, data: { status: 'running', lastActivityAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    expect(await sweepStaleSessions()).toBeGreaterThanOrEqual(1);
    await dispatchEvents();
    expect(await prisma.notification.count({
      where: { userId: admin.id, reason: 'agent_stalled' },
    })).toBe(1);
  });

  it('edge — deactivating the agent fails open sessions, clears delegate, notifies', async () => {
    const { agent, agentBearer } = await seed();
    const admin = await prisma.user.findFirstOrThrow({ where: { isAdmin: true } });
    await authed(app).put('/rest/api/2/issue/AS-1')
      .send({ fields: { delegate: { name: 'Agent Bot' } } }).expect(204);
    const sessions = await authed(app).get('/api/internal/issues/AS-1/sessions').expect(200);
    const sid = sessions.body.sessions[0].id;
    await authed(app).post('/api/internal/agent-questions')
      .set('Authorization', `Bearer ${agentBearer}`)
      .send({ issueKey: 'AS-1', sessionId: sid, question: 'env?' }).expect(201);

    await authed(app).put(`/api/internal/users/${agent.id}`)
      .send({ active: false }).expect(200);
    await dispatchEvents();

    const s = await prisma.agentSession.findUniqueOrThrow({ where: { id: sid } });
    expect(s.status).toBe('failed');
    expect(s.finishedAt).toBeTruthy();
    expect(await prisma.agentQuestion.count({ where: { sessionId: sid, status: 'open' } })).toBe(0);
    const issue = await authed(app).get('/rest/api/2/issue/AS-1').expect(200);
    expect(issue.body.fields.delegate).toBeNull();
    expect(await prisma.notification.count({
      where: { userId: admin.id, reason: 'agent_failed' },
    })).toBe(1);
  });
});

describe('047 US4-3 — agent guidance', () => {
  it('project agentGuidance round-trips and reaches the session view', async () => {
    await seed();
    await authed(app).put('/rest/api/2/project/AS')
      .send({ agentGuidance: 'Always run migrations before merging.' }).expect(200);
    const project = await authed(app).get('/rest/api/2/project/AS').expect(200);
    expect(project.body.agentGuidance).toBe('Always run migrations before merging.');

    await authed(app).put('/rest/api/2/issue/AS-1')
      .send({ fields: { delegate: { name: 'Agent Bot' } } }).expect(204);
    const sessions = await authed(app).get('/api/internal/issues/AS-1/sessions').expect(200);
    expect(sessions.body.sessions[0].guidance).toBe('Always run migrations before merging.');
  });

  it('admin settings accept globalGuidance', async () => {
    const res = await authed(app).put('/api/internal/ai/settings')
      .send({ globalGuidance: 'Never mention competitor products.' }).expect(200);
    const get = await authed(app).get('/api/internal/ai/settings').expect(200);
    expect(get.body.globalGuidance).toBe('Never mention competitor products.');
    void res;
  });
});

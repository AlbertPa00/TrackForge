// 063 — launch wedge: JQL ready()/blocked(), atomic agent claim, composite
// PUT (fields+transition+comment+worklog), scope-at-call-time, llms.txt.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';

async function seed() {
  const agent = await prisma.user.create({
    data: {
      email: 'claim-bot@test.local', displayName: 'Claim Bot',
      passwordHash: await hashPassword('x'.repeat(16)), type: 'agent',
      isAssignableAgent: true,
    },
  });
  const { plain, prefix, hash } = generateToken();
  const token = await prisma.apiToken.create({
    data: { userId: agent.id, name: 'agent', prefix, hash, scopes: ['read', 'write'] },
  });
  await authed(app).post('/rest/api/2/project').send({ key: 'LW', name: 'Launch Wedge' }).expect(201);
  for (const summary of ['ready one', 'ready two', 'blocked child']) {
    await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'LW' }, summary } }).expect(201);
  }
  // LW-1 blocks LW-3 → LW-3 is blocked; LW-1/LW-2 are ready.
  await authed(app).post('/rest/api/2/issueLink')
    .send({ type: { name: 'Blocks' }, outwardIssue: { key: 'LW-1' }, inwardIssue: { key: 'LW-3' } })
    .expect(201);
  return { agent, agentBearer: plain, agentToken: token };
}

describe('063 US4 — JQL ready() / blocked()', () => {
  it('ready() excludes issues with unresolved blockers; blocked() is the inverse', async () => {
    await seed();
    const ready = await authed(app)
      .get(`/rest/api/2/search?jql=${encodeURIComponent('project = LW AND key in ready()')}&fields=summary`)
      .expect(200);
    const readyKeys = ready.body.issues.map((i: { key: string }) => i.key).sort();
    expect(readyKeys).toEqual(['LW-1', 'LW-2']);

    const blocked = await authed(app)
      .get(`/rest/api/2/search?jql=${encodeURIComponent('project = LW AND key in blocked()')}&fields=summary`)
      .expect(200);
    expect(blocked.body.issues.map((i: { key: string }) => i.key)).toEqual(['LW-3']);
  });

  it('resolving the blocker frees the blocked issue', async () => {
    await seed();
    // Resolve LW-1 via a composite PUT (fields.resolution) — Jira unresolved = resolution EMPTY.
    await authed(app).put('/rest/api/2/issue/LW-1')
      .send({ fields: { resolution: { name: 'Done' } } }).expect(204);
    // ready() = unresolved work: LW-1 drops out (resolved), LW-3 is freed.
    const ready = await authed(app)
      .get(`/rest/api/2/search?jql=${encodeURIComponent('project = LW AND key in ready()')}`)
      .expect(200);
    expect(ready.body.issues.map((i: { key: string }) => i.key).sort())
      .toEqual(['LW-2', 'LW-3']);
    const blocked = await authed(app)
      .get(`/rest/api/2/search?jql=${encodeURIComponent('project = LW AND key in blocked()')}`)
      .expect(200);
    expect(blocked.body.issues).toEqual([]);
  });
});

describe('063 US4 — POST /api/internal/agent/claim', () => {
  it('agent self-claim: delegates top-ranked ready issue + opens session atomically', async () => {
    const { agentBearer } = await seed();
    const r = await authed(app).post('/api/internal/agent/claim')
      .set('Authorization', `Bearer ${agentBearer}`)
      .send({ projectKey: 'LW' })
      .expect(201);
    expect(r.body.issue.key).toBe('LW-1');
    expect(r.body.sessionId).toBeTruthy();
    expect(r.body.issue.fields.delegate.displayName).toBe('Claim Bot');

    const sessions = await authed(app).get('/api/internal/issues/LW-1/sessions').expect(200);
    expect(sessions.body.sessions[0].trigger).toBe('claim');
    expect(sessions.body.sessions[0].status).toBe('running');
  });

  it('sequential claims hand out distinct issues; pool exhausted → 409', async () => {
    const { agentBearer } = await seed();
    const agent = authed(app).set('Authorization', `Bearer ${agentBearer}`);
    const first = await agent.post('/api/internal/agent/claim').send({ projectKey: 'LW' }).expect(201);
    const second = await agent.post('/api/internal/agent/claim').send({ projectKey: 'LW' }).expect(201);
    expect(first.body.issue.key).not.toBe(second.body.issue.key);
    // LW-3 is blocked by unresolved LW-1 → pool is exhausted after two claims.
    await agent.post('/api/internal/agent/claim').send({ projectKey: 'LW' }).expect(409);
  });

  it('jql narrows the claim pool', async () => {
    const { agentBearer } = await seed();
    const r = await authed(app).post('/api/internal/agent/claim')
      .set('Authorization', `Bearer ${agentBearer}`)
      .send({ projectKey: 'LW', jql: 'summary ~ "two"' })
      .expect(201);
    expect(r.body.issue.key).toBe('LW-2');
  });

  it('non-assignable caller without agent param → 400', async () => {
    await seed();
    const r = await authed(app).post('/api/internal/agent/claim')
      .send({ projectKey: 'LW' }).expect(400);
    expect(JSON.stringify(r.body)).toContain('assignable agent');
  });

  it('admin may claim on behalf of an agent', async () => {
    await seed();
    const r = await authed(app).post('/api/internal/agent/claim')
      .send({ projectKey: 'LW', agent: { name: 'Claim Bot' } }).expect(201);
    expect(r.body.issue.fields.delegate.displayName).toBe('Claim Bot');
    const s = await prisma.agentSession.findUniqueOrThrow({ where: { id: r.body.sessionId } });
    expect(s.delegatorId).not.toBeNull();
  });
});

describe('063 US3/US6 — scope enforcement at call time', () => {
  it('read-scope token cannot POST claim (403)', async () => {
    const { agent } = await seed();
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({
      data: { userId: agent.id, name: 'ro', prefix, hash, scopes: ['read'] },
    });
    await authed(app).post('/api/internal/agent/claim')
      .set('Authorization', `Bearer ${plain}`)
      .send({ projectKey: 'LW' })
      .expect(403);
  });

  it('token project allow-list excludes the project → 404, no leak', async () => {
    const { agent } = await seed();
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({
      data: { userId: agent.id, name: 'scoped', prefix, hash, scopes: ['read', 'write'], projectKeys: ['OTHER'] },
    });
    await authed(app).post('/api/internal/agent/claim')
      .set('Authorization', `Bearer ${plain}`)
      .send({ projectKey: 'LW' })
      .expect(404);
  });

  it('approvalPolicy always parks the claim as a proposal (202)', async () => {
    const { agentBearer, agentToken } = await seed();
    await prisma.apiToken.update({ where: { id: agentToken.id }, data: { approvalPolicy: 'always' } });
    const r = await authed(app).post('/api/internal/agent/claim')
      .set('Authorization', `Bearer ${agentBearer}`)
      .send({ projectKey: 'LW' })
      .expect(202);
    expect(r.body.proposalId).toBeTruthy();
    // Nothing was delegated.
    const issue = await authed(app).get('/rest/api/2/issue/LW-1').expect(200);
    expect(issue.body.fields.delegate).toBeNull();
  });
});

describe('063 US5 — composite PUT /rest/api/2/issue/{key}', () => {
  it('fields + comment + worklog apply in one call', async () => {
    await seed();
    const r = await authed(app).put('/rest/api/2/issue/LW-2')
      .send({
        fields: { summary: 'renamed by composite' },
        comment: { body: 'composite comment' },
        worklog: { timeSpent: '1h', comment: 'composite work' },
      })
      .expect(200);
    expect(r.body.steps.fields).toBe('updated');
    expect(r.body.steps.comment.id).toBeTruthy();
    expect(r.body.steps.worklog.timeSpentSeconds).toBe(3600);

    const issue = await authed(app)
      .get('/rest/api/2/issue/LW-2?fields=summary&expand=changelog').expect(200);
    expect(issue.body.fields.summary).toBe('renamed by composite');
    const comments = await authed(app).get('/rest/api/2/issue/LW-2/comment').expect(200);
    expect(comments.body.comments.some((c: { body: string }) => c.body === 'composite comment')).toBe(true);
    const wls = await authed(app).get('/rest/api/2/issue/LW-2/worklog').expect(200);
    expect(wls.body.worklogs.length).toBe(1);
  });

  it('composite transition moves status in the same call', async () => {
    await seed();
    const list = await authed(app).get('/rest/api/2/issue/LW-2/transitions').expect(200);
    const start = list.body.transitions.find((t: { name: string }) => t.name === 'Start Progress');
    const r = await authed(app).put('/rest/api/2/issue/LW-2')
      .send({ transition: { id: start.id }, comment: { body: 'starting work' } })
      .expect(200);
    expect(r.body.steps.transition.id).toBe(start.id);
    const issue = await authed(app).get('/rest/api/2/issue/LW-2').expect(200);
    expect(issue.body.fields.status.name).toBe('In Progress');
  });

  it('dryRun previews every declared step and persists nothing', async () => {
    await seed();
    const r = await authed(app).put('/rest/api/2/issue/LW-2?dryRun=true')
      .send({
        fields: { summary: 'preview only' },
        comment: { body: 'nope' },
        worklog: { timeSpent: '30m' },
      })
      .expect(200);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.steps.fields).toBeTruthy();
    expect(r.body.steps.comment.body).toBe('nope');
    expect(r.body.steps.worklog.timeSpentSeconds).toBe(1800);

    const issue = await authed(app).get('/rest/api/2/issue/LW-2').expect(200);
    expect(issue.body.fields.summary).toBe('ready two');
    expect((await prisma.comment.count({ where: { body: 'nope' } }))).toBe(0);
    expect((await prisma.worklog.count({ where: { timeSpentSec: 1800 } }))).toBe(0);
  });

  it('invalid transition in composite → whole request fails, fields not applied', async () => {
    await seed();
    const r = await authed(app).put('/rest/api/2/issue/LW-2')
      .send({ fields: { summary: 'should not persist' }, transition: { id: 'bogus' } })
      .expect(404);
    expect(JSON.stringify(r.body)).toContain('Transition id is invalid');
    const issue = await authed(app).get('/rest/api/2/issue/LW-2').expect(200);
    expect(issue.body.fields.summary).toBe('ready two');
  });
});

describe('063 US3 — GET /llms.txt', () => {
  it('serves the agent onboarding index unauthenticated', async () => {
    const r = await request(app).get('/llms.txt').expect(200);
    expect(r.text).toContain('# TrackForge');
    expect(r.text).toContain('MCP');
    expect(r.text).toContain('/rest/api/2');
  });
});

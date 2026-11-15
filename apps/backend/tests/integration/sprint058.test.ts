// Sprint 058 — better-than-Jira UX wave: backend surface for the project
// summary landing page (US7) and the board-scoped agent-activity map (US5).
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { authed, ensureTestAuth } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';

async function mkProject(key: string) {
  await authed(app).post('/rest/api/2/project').send({ key, name: `Project ${key}` }).expect(201);
}

async function mkIssue(fields: Record<string, unknown>) {
  const res = await authed(app).post('/rest/api/2/issue').send({ fields }).expect(201);
  return res.body.key as string;
}

async function memberAuth(email: string) {
  const user = await prisma.user.create({
    data: { email, displayName: email.split('@')[0], passwordHash: await hashPassword('pw') },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: { userId: user.id, name: 't', prefix, hash, scopes: ['read', 'write'] },
  });
  const usersGroup = await prisma.group.findUniqueOrThrow({ where: { name: 'jira-software-users' } });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: usersGroup.id, userId: user.id } },
    create: { groupId: usersGroup.id, userId: user.id },
    update: {},
  });
  return { user, agent: request.agent(app).set('Authorization', `Bearer ${plain}`) };
}

/** Project whose scheme only grants what we list — everything else denied. */
async function restrictedProject(key: string, grants: [string, string, string?][]) {
  const p = await prisma.project.create({
    data: {
      key, name: key,
      permissionSchemeId: (await prisma.permissionScheme.findFirstOrThrow({ where: { name: 'Default Permission Scheme' } })).id,
    },
  });
  const scheme = await prisma.permissionScheme.create({ data: { name: `${key}-scheme` } });
  for (const [perm, type, param] of grants)
    await prisma.permissionGrant.create({ data: { schemeId: scheme.id, permission: perm, holderType: type, holderParam: param } });
  await prisma.project.update({ where: { id: p.id }, data: { permissionSchemeId: scheme.id } });
  return p;
}

async function mkAgentUser(email: string, name: string) {
  return prisma.user.create({
    data: {
      email, displayName: name,
      passwordHash: await hashPassword('x'.repeat(16)), type: 'agent',
      isAssignableAgent: true,
    },
  });
}

beforeAll(async () => {
  await ensureTestAuth();
  await (await import('../../src/seed.js')).seedPermissionDefaults();
});

describe('058 US7 — GET /api/internal/projects/{key}/summary', () => {
  it('returns all five widget sections for a populated project', async () => {
    await mkProject('SM');
    const k1 = await mkIssue({ project: { key: 'SM' }, summary: 'one', priority: { name: 'High' } });
    const k2 = await mkIssue({ project: { key: 'SM' }, summary: 'two' });
    await authed(app).post(`/rest/api/2/issue/${k1}/comment`).send({ body: 'hello summary' }).expect(201);
    await authed(app).put(`/rest/api/2/issue/${k2}/assignee`).send({ name: 'Test Admin' }).expect(204);

    const res = await authed(app).get('/api/internal/projects/SM/summary').expect(200);
    expect(res.body.totals.issues).toBeGreaterThanOrEqual(2);
    expect(res.body.totals.open).toBeGreaterThanOrEqual(2);
    // Widget 1 — status rollup
    expect(res.body.statusRollup.length).toBeGreaterThan(0);
    expect(res.body.statusRollup[0]).toMatchObject({ status: expect.any(String), count: expect.any(Number) });
    // Widget 2 — open by priority
    const high = res.body.openByPriority.find((p: { priority: string }) => p.priority === 'High');
    expect(high?.count).toBeGreaterThanOrEqual(1);
    // Widget 3 — recent activity mixes comments + field changes
    const kinds = new Set(res.body.activity.map((a: { type: string }) => a.type));
    expect(kinds.has('comment')).toBe(true);
    expect(kinds.has('change')).toBe(true);
    expect(res.body.activity[0].issueKey).toMatch(/^SM-\d+$/);
    // Widget 4 — workload includes the assignee
    expect(res.body.workload.some((w: { user: string }) => w.user === 'Test Admin')).toBe(true);
    // Widget 5 — agent activity object exists even when quiet
    expect(res.body.agents).toMatchObject({ running: 0, blocked: 0, needsAnswer: 0 });
    expect(Array.isArray(res.body.upcomingVersions)).toBe(true);
  });

  it('normalizes lowercase project keys', async () => {
    await mkProject('LC');
    await authed(app).get('/api/internal/projects/lc/summary').expect(200);
  });

  it('empty project returns zeroed widgets, not an error', async () => {
    await mkProject('EMPTY');
    const res = await authed(app).get('/api/internal/projects/EMPTY/summary').expect(200);
    expect(res.body.totals).toEqual({ issues: 0, open: 0 });
    expect(res.body.statusRollup).toEqual([]);
    expect(res.body.activity).toEqual([]);
    expect(res.body.workload).toEqual([]);
  });

  it('404s a project that does not exist', async () => {
    await authed(app).get('/api/internal/projects/NOPE/summary').expect(404);
  });

  it('denies members without BROWSE_PROJECTS (404, not 403 — no existence leak)', async () => {
    await restrictedProject('SMDENY', [['BROWSE_PROJECTS', 'group', 'jira-administrators']]);
    const { agent } = await memberAuth('sm-denied@test.local');
    await agent.get('/api/internal/projects/SMDENY/summary').expect(404);
    await agent.get('/api/internal/projects/smdeny/summary').expect(404); // lowercase can't slip past
    await authed(app).get('/api/internal/projects/SMDENY/summary').expect(200); // admin fine
  });

  it('scopes agent activity to the requested project', async () => {
    await mkProject('SMAG');
    await mkProject('SMOTHER');
    await mkAgentUser('smag-bot@test.local', 'Summary Bot');
    const key = await mkIssue({ project: { key: 'SMAG' }, summary: 'delegated', delegate: { name: 'Summary Bot' } });
    await mkIssue({ project: { key: 'SMOTHER' }, summary: 'other', delegate: { name: 'Summary Bot' } });
    // Park the session in needs-answer via an open question.
    const sessions = await prisma.agentSession.findMany({
      where: { issue: { issueNumber: Number(key.split('-')[1]), project: { key: 'SMAG' } } },
    });
    expect(sessions).toHaveLength(1);
    await prisma.agentQuestion.create({
      data: { issueId: sessions[0].issueId, sessionId: sessions[0].id, question: 'which env?', status: 'open' },
    });
    await prisma.agentSession.update({ where: { id: sessions[0].id }, data: { status: 'needs-answer' } });

    const res = await authed(app).get('/api/internal/projects/SMAG/summary').expect(200);
    expect(res.body.agents.needsAnswer).toBe(1);
    expect(res.body.agents.openQuestions).toBe(1);
    expect(res.body.agents.agents).toContain('Summary Bot');
    // The other project's session must not leak in.
    const other = await authed(app).get('/api/internal/projects/SMOTHER/summary').expect(200);
    expect(other.body.agents.running).toBe(1);
    expect(other.body.agents.needsAnswer).toBe(0);
  });
});

describe('058 US5 — GET /api/internal/projects/{key}/agent-activity', () => {
  it('returns a per-issue badge map with open questions folded in', async () => {
    await mkProject('ACT');
    const key = await mkIssue({ project: { key: 'ACT' }, summary: 'work' });
    await mkAgentUser('act-bot@test.local', 'Act Bot');
    // Delegate directly so a session exists.
    await authed(app).put(`/rest/api/2/issue/${key}`).send({ fields: { delegate: { name: 'Act Bot' } } }).expect(204);
    const [session] = await prisma.agentSession.findMany({
      where: { issue: { issueNumber: Number(key.split('-')[1]), project: { key: 'ACT' } } },
    });
    expect(session).toBeDefined();
    await prisma.agentQuestion.create({
      data: { issueId: session.issueId, sessionId: session.id, question: 'go?', status: 'open' },
    });

    const res = await authed(app).get('/api/internal/projects/ACT/agent-activity').expect(200);
    const slot = res.body.issues[key];
    expect(slot).toBeDefined();
    expect(slot.running + slot.blocked + slot.needsAnswer).toBeGreaterThanOrEqual(2); // session + question
    expect(slot.needsAnswer).toBeGreaterThanOrEqual(1);
    expect(slot.agents).toContain('Act Bot');
  });

  it('denies members without BROWSE_PROJECTS', async () => {
    await restrictedProject('ACTDENY', [['BROWSE_PROJECTS', 'group', 'jira-administrators']]);
    const { agent } = await memberAuth('act-denied@test.local');
    await agent.get('/api/internal/projects/ACTDENY/agent-activity').expect(404);
    await agent.get('/api/internal/projects/actdeny/agent-activity').expect(404);
  });
});

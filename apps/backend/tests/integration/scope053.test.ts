import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import { setInternalBaseUrl } from '../../src/lib/internalRequest.js';

/** Sprint 053 — audit P0 wave: scope enforcement, workflow conditions,
 *  assign-authority parity, proposal-gate coverage, move-with-subtasks. */

let loopback: Server;

async function memberAuth(email: string, opts: { approvalPolicy?: string; scopes?: string[] } = {}) {
  const user = await prisma.user.create({
    data: { email, displayName: email.split('@')[0], passwordHash: await hashPassword('pw') },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: {
      userId: user.id, name: 't', prefix, hash,
      scopes: opts.scopes ?? ['read', 'write'],
      ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
    },
  });
  const usersGroup = await prisma.group.findUniqueOrThrow({ where: { name: 'jira-software-users' } });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: usersGroup.id, userId: user.id } },
    create: { groupId: usersGroup.id, userId: user.id },
    update: {},
  });
  return { user, agent: request.agent(app).set('Authorization', `Bearer ${plain}`) };
}

async function createProject(key: string, leadId?: string) {
  return prisma.project.create({
    data: {
      key, name: key, leadId,
      permissionSchemeId: (await prisma.permissionScheme.findFirstOrThrow({ where: { name: 'Default Permission Scheme' } })).id,
    },
  });
}

async function grant(schemeId: string, permission: string, holderType: string, holderParam?: string) {
  return prisma.permissionGrant.create({ data: { schemeId, permission, holderType, holderParam } });
}

/** Project whose scheme only grants what we list — everything else denied. */
async function restrictedProject(key: string, grants: [string, string, string?][], leadId?: string) {
  const p = await createProject(key, leadId);
  const scheme = await prisma.permissionScheme.create({ data: { name: `${key}-scheme` } });
  for (const [perm, type, param] of grants) await grant(scheme.id, perm, type, param);
  await prisma.project.update({ where: { id: p.id }, data: { permissionSchemeId: scheme.id } });
  return p;
}

/** Creates an issue via the API; returns its real key (first issue is KEY-2 —
 *  new projects start issueCounter at 1). */
async function makeIssue(projectKey: string, fields: Record<string, unknown> = {}) {
  const res = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: projectKey }, summary: `${projectKey} issue`, ...fields } });
  if (res.status !== 201) throw new Error(`makeIssue ${projectKey} → ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.key as string;
}

beforeAll(async () => {
  // internalRequest (proposal preview replay) needs a real listener.
  loopback = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => loopback.once('listening', r));
  setInternalBaseUrl(`http://127.0.0.1:${(loopback.address() as AddressInfo).port}`);
  await ensureTestAuth();
  await (await import('../../src/seed.js')).seedPermissionDefaults();
});

afterAll(async () => {
  setInternalBaseUrl(null);
  await new Promise<void>((r) => loopback.close(() => r()));
});

// ---------- US1 — enforceIssueScope: lowercase + alias bypasses ----------

describe('053 US1 — issue scope enforcement', () => {
  it('lowercase issue keys do not bypass BROWSE_PROJECTS', async () => {
    await restrictedProject('LSC', [['BROWSE_PROJECTS', 'group', 'jira-administrators']]);
    const key = await makeIssue('LSC');
    const { agent } = await memberAuth('lsc-viewer@test.local');
    // Uppercase already 404s; the bug made the lowercase variant 200.
    await agent.get(`/rest/api/2/issue/${key}`).expect(404);
    await agent.get(`/rest/api/2/issue/${key.toLowerCase()}`).expect(404);
    // Admin still sees it.
    await authed(app).get(`/rest/api/2/issue/${key.toLowerCase()}`).expect(200);
  });

  it('moved-issue alias cannot be read through the old public key', async () => {
    await restrictedProject('PUB', [['BROWSE_PROJECTS', 'applicationRole']]);
    await restrictedProject('SEC', [['BROWSE_PROJECTS', 'group', 'jira-administrators']]);
    const oldKey = await makeIssue('PUB');
    // Admin moves the issue into restricted SEC → old key becomes an alias.
    const moved = await authed(app)
      .post(`/api/internal/issues/${oldKey}/move`)
      .send({ target: { projectKey: 'SEC' } })
      .expect(200);
    const { agent } = await memberAuth('alias-sneak@test.local');
    await agent.get(`/rest/api/2/issue/${oldKey}`).expect(404);
    // The alias still resolves for permitted users (admin).
    const admin = await authed(app).get(`/rest/api/2/issue/${oldKey}`).expect(200);
    expect(admin.body.key).toBe(moved.body.key);
  });
});

// ---------- US2 — onlyProjectLead checks the actor ----------

describe('053 US2 — onlyProjectLead condition', () => {
  it('does not open to everyone when the lead reported the issue', async () => {
    const { user: lead, agent: leadAgent } = await memberAuth('opl-lead@test.local');
    await restrictedProject('OPL', [
      ['BROWSE_PROJECTS', 'applicationRole'], ['TRANSITION_ISSUES', 'applicationRole'],
      ['CREATE_ISSUES', 'applicationRole'], ['RESOLVE_ISSUES', 'applicationRole'],
      ['CLOSE_ISSUES', 'applicationRole'],
    ], lead.id);
    // The lead reports the issue — previously this made the condition pass for all.
    await leadAgent.post('/rest/api/2/issue').send({ fields: { project: { key: 'OPL' }, summary: 'lead reported' } }).expect(201);
    const issueKey = (await prisma.issue.findFirstOrThrow({ where: { project: { key: 'OPL' } }, select: { issueNumber: true } }).then((r) => `OPL-${r.issueNumber}`));
    const transitions = (await leadAgent.get(`/rest/api/2/issue/${issueKey}/transitions`).expect(200)).body.transitions;
    const t = transitions[0];
    await prisma.transitionRule.create({ data: { transitionId: t.id, kind: 'condition', type: 'onlyProjectLead' } });

    const { agent: other } = await memberAuth('opl-other@test.local');
    const otherList = (await other.get(`/rest/api/2/issue/${issueKey}/transitions`).expect(200)).body.transitions;
    expect(otherList.map((x: { id: string }) => x.id)).not.toContain(t.id);
    await other.post(`/rest/api/2/issue/${issueKey}/transitions`).send({ transition: { id: t.id } }).expect(400);

    // The lead still sees and can run it.
    const leadList = (await leadAgent.get(`/rest/api/2/issue/${issueKey}/transitions`).expect(200)).body.transitions;
    expect(leadList.map((x: { id: string }) => x.id)).toContain(t.id);
  });
});

// ---------- US3 — assign authority on create / transition / empty refs ----------

describe('053 US3 — assign-authority parity', () => {
  it('create with assignee requires ASSIGN_ISSUES', async () => {
    await restrictedProject('ASC', [['BROWSE_PROJECTS', 'applicationRole'], ['CREATE_ISSUES', 'applicationRole']]);
    const { agent } = await memberAuth('asc-creator@test.local');
    const target = await prisma.user.findUniqueOrThrow({ where: { email: 'asc-creator@test.local' } });
    const res = await agent
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'ASC' }, summary: 'x', assignee: { accountId: target.id } } });
    expect(res.status).toBe(403);
  });

  it('create with empty assignee ref is 400, not "first user in the table"', async () => {
    await restrictedProject('AEM', [['BROWSE_PROJECTS', 'applicationRole'], ['CREATE_ISSUES', 'applicationRole'], ['ASSIGN_ISSUES', 'applicationRole'], ['ASSIGNABLE_USER', 'applicationRole']]);
    const { agent } = await memberAuth('aem@test.local');
    const res = await agent
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'AEM' }, summary: 'x', assignee: {} } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('accountId or name');
  });

  it('transition-screen assignee requires ASSIGN_ISSUES', async () => {
    const { createWorkflow } = await import('../../src/services/workflowService.js');
    const todo = await prisma.status.findFirstOrThrow({ where: { category: 'todo' } });
    const prog = await prisma.status.findFirstOrThrow({ where: { category: 'inprogress' } });
    const wf = await createWorkflow({
      name: 'TSA-screen',
      statuses: [
        { statusId: todo.id, isInitial: true },
        { statusId: prog.id },
      ],
      transitions: [
        { name: 'Go', fromStatusId: todo.id, toStatusId: prog.id, screenFields: ['assignee'] },
        { name: 'Back', fromStatusId: prog.id, toStatusId: todo.id },
      ],
    });
    const p = await restrictedProject('TSA', [['BROWSE_PROJECTS', 'applicationRole'], ['CREATE_ISSUES', 'applicationRole'], ['TRANSITION_ISSUES', 'applicationRole']]);
    await prisma.project.update({ where: { id: p.id }, data: { workflowId: wf.id } });
    const issueKey = await makeIssue('TSA');
    const { agent } = await memberAuth('tsa@test.local');
    const list = (await agent.get(`/rest/api/2/issue/${issueKey}/transitions`).expect(200)).body.transitions;
    const go = list.find((x: { name: string }) => x.name === 'Go');
    const res = await agent
      .post(`/rest/api/2/issue/${issueKey}/transitions`)
      .send({ transition: { id: go.id }, fields: { assignee: { accountId: (await prisma.user.findUniqueOrThrow({ where: { email: 'tsa@test.local' } })).id } } });
    expect(res.status).toBe(403);
    // Grant ASSIGN_ISSUES → same call works (target self-assign is assignable).
    const scheme = await prisma.permissionScheme.findUniqueOrThrow({ where: { name: 'TSA-scheme' } });
    await grant(scheme.id, 'ASSIGN_ISSUES', 'applicationRole');
    await grant(scheme.id, 'ASSIGNABLE_USER', 'applicationRole');
    await agent
      .post(`/rest/api/2/issue/${issueKey}/transitions`)
      .send({ transition: { id: go.id }, fields: { assignee: { accountId: (await prisma.user.findUniqueOrThrow({ where: { email: 'tsa@test.local' } })).id } } })
      .expect(204);
  });
});

// ---------- US4 — proposal gate: dryRun bypass + internal destructive ----------

describe('053 US4 — proposal gate coverage', () => {
  it('?dryRun=true never parks as a proposal', async () => {
    await createProject('DRY');
    const key = await makeIssue('DRY');
    const { agent } = await memberAuth('dry-gated@test.local', { approvalPolicy: 'always' });
    // The two-step delete preview must return the confirmToken, not a 202.
    const res = await agent.delete(`/rest/api/2/issue/${key}?dryRun=true`);
    expect(res.status).toBe(200);
    expect(res.body.confirmToken).toBeTruthy();
    expect(res.body.proposalId).toBeUndefined();
  });

  it('destructiveOnly parks internal bulk delete but not ordinary bulk ops', async () => {
    await createProject('BLK');
    const key = await makeIssue('BLK');
    const { agent } = await memberAuth('blk-gated@test.local', { approvalPolicy: 'destructiveOnly' });
    const del = await agent.post('/api/internal/bulk/delete').send({ issueKeys: [key] });
    expect(del.status).toBe(202);
    expect(del.body.proposalId).toBeTruthy();
    // Ordinary bulk ops still execute (job id, not proposal id).
    const edit = await agent.post('/api/internal/bulk/comment').send({ issueKeys: [key], payload: { body: 'hi' } });
    expect(edit.status).toBe(202);
    expect(edit.body.jobId).toBeTruthy();
    expect(edit.body.proposalId).toBeUndefined();
    // Issue untouched — the delete was parked.
    await authed(app).get(`/rest/api/2/issue/${key}`).expect(200);
  });

  it('always parks /rest/-class internal writes but keeps the agent loop free', async () => {
    await createProject('ALW');
    const key = await makeIssue('ALW');
    const { agent } = await memberAuth('alw-gated@test.local', { approvalPolicy: 'always' });
    // Clone is a /rest/-class internal write → parked.
    const clone = await agent.post(`/api/internal/issues/${key}/clone`).send({});
    expect(clone.status).toBe(202);
    expect(clone.body.proposalId).toBeTruthy();
    // The agent's own loop (notifications read) is not parked.
    const loop = await agent.post('/api/internal/me/notifications/read').send({ ids: [] });
    expect(loop.body?.proposalId).toBeUndefined();
    // And a real delete preview still works.
    const dry = await agent.delete(`/rest/api/2/issue/${key}?dryRun=true`);
    expect(dry.status).toBe(200);
    expect(dry.body.proposalId).toBeUndefined();
  });
});

// ---------- US5 — move with subtasks renumbers + aliases ----------

describe('053 US5 — move with subtasks', () => {
  it('renumbers colliding subtasks, writes aliases, keeps counter monotonic', async () => {
    await createProject('MVF');
    await createProject('MVT');
    // Parent + two subtasks in MVF; colliding numbers in MVT (3 issues exist).
    const parent = await makeIssue('MVF');
    const sub1 = await makeIssue('MVF', { issuetype: { name: 'Subtask' }, parent: { key: parent } });
    const sub2 = await makeIssue('MVF', { issuetype: { name: 'Subtask' }, parent: { key: parent } });
    await makeIssue('MVT');
    await makeIssue('MVT');
    await makeIssue('MVT');

    const res = await authed(app)
      .post(`/api/internal/issues/${parent}/move`)
      .send({ target: { projectKey: 'MVT' } });
    expect(res.status).toBe(200);
    const newParent = res.body.key;
    expect(newParent).toMatch(/^MVT-\d+$/);

    // Subtasks renumbered — old keys resolve via alias to the new keys, and
    // they keep pointing at the moved parent.
    const s1 = await authed(app).get(`/rest/api/2/issue/${sub1}`).expect(200);
    const s2 = await authed(app).get(`/rest/api/2/issue/${sub2}`).expect(200);
    expect(s1.body.key).toMatch(/^MVT-\d+$/);
    expect(s2.body.key).toMatch(/^MVT-\d+$/);
    expect(s1.body.fields.parent.key).toBe(newParent);
    expect(s2.body.fields.parent.key).toBe(newParent);
    expect(s1.body.key).not.toBe(sub1);
    expect(s2.body.key).not.toBe(sub2);
    // Counter monotonic — the next create in MVT can't collide.
    const next = await makeIssue('MVT');
    const nums = [newParent, s1.body.key, s2.body.key, next].map((k) => Number(k.split('-')[1]));
    expect(new Set(nums).size).toBe(4);
  });
});

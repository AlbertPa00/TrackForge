// Sprint 057 — copilot/automation/data-integrity SCs.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import { TOOLKIT } from '../../src/services/copilotService.js';
import { MemoryStore, setAttachmentStore, getAttachmentStore } from '../../src/ports/attachmentStore.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function mkProject(key: string) {
  await authed(app).post('/rest/api/2/project').send({ key, name: `Project ${key}` }).expect(201);
}

async function mkIssue(fields: Record<string, unknown>) {
  const res = await authed(app).post('/rest/api/2/issue').send({ fields }).expect(201);
  return res.body.key as string;
}

async function mkAgent(email: string, name: string) {
  const agent = await prisma.user.create({
    data: {
      email, displayName: name,
      passwordHash: await hashPassword('x'.repeat(16)), type: 'agent',
      isAssignableAgent: true,
    },
  });
  return agent;
}

async function mkHuman(email: string, name: string, timeZone?: string) {
  const u = await prisma.user.create({
    data: {
      email, displayName: name,
      passwordHash: await hashPassword('x'.repeat(16)),
      ...(timeZone ? { timeZone } : {}),
    },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: u.id, name: 't', prefix, hash, scopes: ['read', 'write'] } });
  return { user: u, token: plain };
}

describe('057 US1 — delegate on create spawns a session (SC-001)', () => {
  it('POST /issue with fields.delegate creates an AgentSession', async () => {
    await mkProject('DG');
    const agent = await mkAgent('dg-agent@test.local', 'Delegate Bot');
    const res = await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'DG' }, summary: 'delegated', delegate: { name: 'Delegate Bot' } } })
      .expect(201);
    const sessions = await authed(app).get(`/api/internal/issues/${res.body.key}/sessions`).expect(200);
    expect(sessions.body.sessions).toHaveLength(1);
    expect(sessions.body.sessions[0].agent).toBe('Delegate Bot');
    expect(sessions.body.sessions[0].status).toBe('running');
    const issue = await authed(app).get(`/rest/api/2/issue/${res.body.key}`).expect(200);
    expect(issue.body.fields.delegate.accountId).toBe(agent.id);
  });
});

describe('057 US2 — AI write resolvers (SC-002)', () => {
  it('copilot assign_issue resolves no-assignee to {accountId: null}', async () => {
    const r = await TOOLKIT.assign_issue!.resolve({ issueKey: 'XX-1' }, { userId: 'u' });
    expect(r.method).toBe('PUT');
    expect(r.body).toEqual({ accountId: null });
    const named = await TOOLKIT.assign_issue!.resolve({ issueKey: 'XX-1', name: 'Test Admin' }, { userId: 'u' });
    expect(named.body).toEqual({ name: 'Test Admin' });
  });

  it('PUT /issue/{k}/assignee {accountId:null} unassigns (what copilot now emits)', async () => {
    await mkProject('UN');
    const key = await mkIssue({ project: { key: 'UN' }, summary: 'x', assignee: { name: 'Test Admin' } });
    await authed(app).put(`/rest/api/2/issue/${key}/assignee`).send({ accountId: null }).expect(204);
    const issue = await authed(app).get(`/rest/api/2/issue/${key}`).expect(200);
    expect(issue.body.fields.assignee).toBeNull();
  });

  it('automation assign resolves reporter and raw accountId', async () => {
    await mkProject('AU');
    const { user } = await mkHuman('au-user@test.local', 'Assign Target');
    for (const to of ['reporter', user.id]) {
      await authed(app).post('/api/internal/automation/rules').send({
        name: `Assign ${to}`, scope: 'project', projectKey: 'AU',
        trigger: { type: 'issue_created' }, conditions: [],
        actions: [{ type: 'assign', to }],
      }).expect(201);
      const key = await mkIssue({ project: { key: 'AU' }, summary: `t-${to}` });
      await dispatchEvents();
      const issue = await authed(app).get(`/rest/api/2/issue/${key}`).expect(200);
      const want = to === 'reporter'
        ? 'Test Admin'
        : 'Assign Target';
      expect(issue.body.fields.assignee?.displayName).toBe(want);
    }
  });
});

describe('057 US3 — clone consistency (SC-003)', () => {
  beforeAll(() => setAttachmentStore(new MemoryStore()));

  it('watcherCount includes the caller auto-watch; subtask ranks are distinct', async () => {
    await mkProject('CL');
    const { user } = await mkHuman('cl-watcher@test.local', 'Other Watcher');
    const parent = await mkIssue({ project: { key: 'CL' }, summary: 'parent' });
    await mkIssue({
      project: { key: 'CL' }, summary: 'child',
      issuetype: { name: 'Subtask' }, parent: { key: parent },
    });
    await authed(app).post(`/rest/api/2/issue/${parent}/watchers`).send({ accountId: user.id }).expect(204);

    const clone = await authed(app).post(`/api/internal/issues/${parent}/clone`)
      .send({}).expect(201);
    const cloneRow = await prisma.issue.findFirstOrThrow({
      where: { project: { key: 'CL' }, issueNumber: Number(clone.body.key.split('-')[1]) },
      include: { children: true },
    });
    // watcher = Other Watcher + caller (admin) auto-watch — counted in the row
    expect(cloneRow.watcherCount).toBe(2);

    expect(cloneRow.children).toHaveLength(1);
    const subRank = cloneRow.children[0]!.rank;
    // cloned subtask has its own rank — not the parent's rank repeated
    expect(subRank).not.toBe(cloneRow.rank);
    const children = await authed(app).get(`/rest/api/2/issue/${clone.body.key}/children`).expect(200);
    expect(children.body.issues).toHaveLength(1);
  });

  it('attachments copy bytes to new storage keys on the clone', async () => {
    await mkProject('CA');
    const src = await mkIssue({ project: { key: 'CA' }, summary: 'with attachment' });
    await authed(app).post(`/rest/api/2/issue/${src}/attachments`).attach('file', PNG, 'p.png').expect(200);
    const clone = await authed(app).post(`/api/internal/issues/${src}/clone`).send({}).expect(201);
    const got = await authed(app).get(`/rest/api/2/issue/${clone.body.key}`).expect(200);
    expect(got.body.fields.attachment).toHaveLength(1);
    const att = got.body.fields.attachment[0];
    const srcGot = await authed(app).get(`/rest/api/2/issue/${src}`).expect(200);
    expect(att.id).not.toBe(srcGot.body.fields.attachment[0].id);
    // bytes exist at the new key — no row-without-bytes orphan
    const store = getAttachmentStore();
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: att.id } });
    const bytes = await store.get(row.storagePath);
    expect(bytes.equals(PNG)).toBe(true);
  });
});

describe('057 US4 — CF date equality is tz-correct (SC-004)', () => {
  it('date field = "YYYY-MM-DD" matches under Europe/Berlin and America/New_York', async () => {
    await mkProject('TZ');
    const f = await authed(app).post('/api/internal/customfields')
      .send({ name: 'Go Live', type: 'date', context: { projectKeys: ['TZ'] } })
      .expect(201);
    await mkIssue({ project: { key: 'TZ' }, summary: 'dated', [f.body.id]: '2026-11-08' });

    for (const tz of ['Europe/Berlin', 'America/New_York']) {
      const { token } = await mkHuman(`tz-${tz.replace(/\W/g, '')}@test.local`, `TZ ${tz}`, tz);
      const res = await request.agent(app)
        .get(`/rest/api/2/search?jql=${encodeURIComponent('"Go Live" = "2026-11-08"')}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body.total).toBe(1);
    }
  });
});

describe('057 US5 — batch idempotency + gadgets (SC-005 + FR-003)', () => {
  it('bulk create with batchId replays per-item instead of double-creating', async () => {
    await mkProject('BK');
    const body = {
      batchId: 'batch-1',
      issueUpdates: [{ fields: { project: { key: 'BK' }, summary: 'first' } }],
    };
    const r1 = await authed(app).post('/rest/api/2/issue/bulk').send(body).expect(201);
    expect(r1.body.issues).toHaveLength(1);
    const r2 = await authed(app).post('/rest/api/2/issue/bulk').send(body).expect(201);
    expect(r2.body.issues).toHaveLength(1);
    expect(r2.body.issues[0].key).toBe(r1.body.issues[0].key);
    expect(r2.body.issues[0].replayed).toBe(true);
    expect(r2.body.batchId).toBe('batch-1');
    const all = await authed(app).get(`/rest/api/2/search?jql=${encodeURIComponent('project = BK')}`).expect(200);
    expect(all.body.total).toBe(1);
  });

  it('untouched gadget config gets declared defaults; 2-D cells use JSON tuple keys', async () => {
    await mkProject('GD');
    await mkIssue({ project: { key: 'GD' }, summary: 'cell', assignee: { name: 'Test Admin' } });
    const d = (await authed(app).post('/rest/api/2/dashboard')
      .send({ name: 'Default Wall' }).expect(201)).body;

    // pie-chart has required statType=status default — untouched must not 400
    const pie = await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'pie-chart', config: { jql: 'project = GD' } }).expect(201);
    expect(pie.body.config.statType).toBe('status');

    const twoD = await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'two-dimensional', config: { jql: 'project = GD' } }).expect(201);
    expect(twoD.body.config.xstatType).toBe('status');
    expect(twoD.body.config.ystatType).toBe('assignee');

    const data = await authed(app).get(`/api/internal/dashboards/${d.id}/data`).expect(200);
    const matrix = data.body.gadgets.find((g: { gadget: { type: string } }) => g.gadget.type === 'two-dimensional');
    const keys = Object.keys(matrix.data.cells);
    expect(keys.length).toBeGreaterThan(0);
    // JSON tuple keys are unambiguous — x+y concatenations cannot merge cells
    for (const k of keys) expect(() => JSON.parse(k)).not.toThrow();
    expect(keys.every((k) => Array.isArray(JSON.parse(k)) && JSON.parse(k).length === 2)).toBe(true);
  });
});

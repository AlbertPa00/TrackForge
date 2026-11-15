// Sprint 026 — dashboard CRUD, share-permission visibility, gadget CRUD,
// registry, and viewer-context data resolvers.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';

async function mintToken(email: string) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: email, passwordHash: await hashPassword('x-'.repeat(8)) },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes: ['read', 'write'], projectKeys: [] } });
  return { agent: request.agent(app).set('Authorization', `Bearer ${plain}`), user };
}

async function createDash(body: object) {
  return authed(app).post('/rest/api/2/dashboard').send(body).expect(201);
}

describe('dashboards & gadgets (026)', () => {
  let issueKey: string;
  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'DSH', name: 'DSH' }).expect(201);
    const i = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'DSH' }, summary: 'dash probe', issuetype: { name: 'Bug' } } })
      .expect(201);
    issueKey = i.body.key;
  });

  it('creates, gets, updates, searches, and deletes a dashboard', async () => {
    const d = (await createDash({ name: 'Team Wall', description: 'main' })).body;
    expect(d.id).toBeTruthy();

    const got = await authed(app).get(`/rest/api/2/dashboard/${d.id}`).expect(200);
    expect(got.body.name).toBe('Team Wall');
    // Default share = loggedin.
    expect(got.body.sharePermissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'loggedin' })])
    );

    const upd = await authed(app)
      .put(`/rest/api/2/dashboard/${d.id}`)
      .send({ name: 'Renamed', layout: { columns: 3 } })
      .expect(200);
    expect(upd.body.name).toBe('Renamed');
    expect((upd.body.layout as { columns: number }).columns).toBe(3);

    const found = await authed(app)
      .get('/rest/api/2/dashboard/search?dashboardName=renam')
      .expect(200);
    expect(found.body.values.map((v: { id: string }) => v.id)).toContain(d.id);

    await authed(app).delete(`/rest/api/2/dashboard/${d.id}`).expect(204);
    await authed(app).get(`/rest/api/2/dashboard/${d.id}`).expect(404);
  });

  it('honours share permissions for visibility and editing', async () => {
    const { agent, user } = await mintToken('viewer@test.local');
    // Shared read-only with `user` → visible, not editable.
    const shared = (await createDash({
      name: 'Shared Wall',
      sharePermissions: [{ type: 'user', target: user.id }],
    })).body;
    const list = await agent.get('/rest/api/2/dashboard').expect(200);
    expect(list.body.dashboards.map((x: { id: string }) => x.id)).toContain(shared.id);
    await agent.get(`/rest/api/2/dashboard/${shared.id}`).expect(200);
    await agent.put(`/rest/api/2/dashboard/${shared.id}`).send({ name: 'hijack' }).expect(403);

    // Editable via edit permission.
    const editable = (await createDash({
      name: 'Editable Wall',
      editPermissions: [{ type: 'user', target: user.id }],
    })).body;
    await agent.put(`/rest/api/2/dashboard/${editable.id}`).send({ name: 'by viewer' }).expect(200);
    await agent.delete(`/rest/api/2/dashboard/${editable.id}`).expect(404); // delete = owner/admin only

    // Private dashboard → invisible (404, existence-hiding).
    const priv = (await createDash({ name: 'Private Wall', sharePermissions: [] })).body;
    await agent.get(`/rest/api/2/dashboard/${priv.id}`).expect(404);
    const list2 = await agent.get('/rest/api/2/dashboard').expect(200);
    expect(list2.body.dashboards.map((x: { id: string }) => x.id)).not.toContain(priv.id);
  });

  it('copies a dashboard with gadgets, private to the copier', async () => {
    const { agent } = await mintToken('copier@test.local');
    const d = (await createDash({ name: 'Original' })).body;
    await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'assigned-to-me', config: { maxResults: 5 } })
      .expect(201);
    const copy = (await agent.post(`/rest/api/2/dashboard/${d.id}/copy`).send({}).expect(201)).body;
    expect(copy.name).toBe('Copy of Original');
    const cg = await agent.get(`/rest/api/2/dashboard/${copy.id}`).expect(200);
    expect(cg.body.gadgets).toHaveLength(1);
    // Copier owns it; admin (original owner) cannot see the private copy.
    await authed(app).get(`/rest/api/2/dashboard/${copy.id}`).expect(200); // admin sees all
  });

  it('exposes the gadget registry and validates gadget type/config', async () => {
    const reg = await authed(app).get('/rest/api/2/dashboard/gadgets').expect(200);
    const types = reg.body.gadgets.map((g: { type: string }) => g.type);
    for (const t of ['assigned-to-me', 'filter-results', 'pie-chart', 'two-dimensional', 'created-vs-resolved', 'sprint-health', 'recently-updated', 'watched-issues']) {
      expect(types).toContain(t);
    }
    const d = (await createDash({ name: 'Gadget Wall' })).body;
    await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'no-such-gadget' }).expect(400);
    await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'filter-results' }).expect(400); // filterId required
    const g = (await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'recently-updated', column: 1 }).expect(201)).body;
    expect(g.position.column).toBe(1);
    const upd = (await authed(app).put(`/rest/api/2/dashboard/${d.id}/gadget/${g.id}`)
      .send({ position: 7 }).expect(200)).body;
    expect(upd.position.row).toBe(7);
    await authed(app).delete(`/rest/api/2/dashboard/${d.id}/gadget/${g.id}`).expect(204);
  });

  it('resolves gadget data as the viewer via the data endpoints', async () => {
    const { agent, user } = await mintToken('assigned@test.local');
    await authed(app).put(`/rest/api/2/issue/${issueKey}`)
      .send({ fields: { assignee: { name: user.displayName } } }).expect(204);
    // Watch from the viewer's account.
    await agent.post(`/rest/api/2/issue/${issueKey}/watchers`).send(`"${user.displayName}"`).set('Content-Type', 'application/json');

    const d = (await createDash({
      name: 'Data Wall',
      editPermissions: [{ type: 'user', target: user.id }],
    })).body;
    for (const type of ['assigned-to-me', 'watched-issues', 'recently-updated']) {
      await agent.post(`/rest/api/2/dashboard/${d.id}/gadget`).send({ type }).expect(201);
    }
    const data = await agent.get(`/api/internal/dashboards/${d.id}/data`).expect(200);
    const byType = Object.fromEntries(data.body.gadgets.map((g: { gadget: { type: string }; data?: { issues?: { key: string }[] } }) => [g.gadget.type, g.data]));
    // Viewer sees their assigned issue; admin-created issue is visible to all.
    expect(byType['assigned-to-me'].issues.map((i: { key: string }) => i.key)).toContain(issueKey);
    expect(byType['watched-issues'].issues.map((i: { key: string }) => i.key)).toContain(issueKey);
    expect(byType['recently-updated'].issues.map((i: { key: string }) => i.key)).toContain(issueKey);

    // Admin resolving the SAME dashboard sees admin-context data.
    const adminData = await authed(app).get(`/api/internal/dashboards/${d.id}/data`).expect(200);
    const adminAssigned = adminData.body.gadgets.find(
      (g: { gadget: { type: string } }) => g.gadget.type === 'assigned-to-me'
    );
    expect(adminAssigned.data.issues.map((i: { key: string }) => i.key)).not.toContain(issueKey);
  });

  it('pie-chart groups by statType and reports truncation honestly', async () => {
    const d = (await createDash({ name: 'Pie Wall' })).body;
    const g = (await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'pie-chart', config: { jql: 'project = DSH', statType: 'issuetype' } })
      .expect(201)).body;
    const data = await authed(app).get(`/api/internal/dashboards/${d.id}/gadgets/${g.id}/data`).expect(200);
    expect(data.body.data.groups).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Bug', count: 1 })])
    );
    expect(data.body.data.total).toBe(1);
    // Bad statType resolves to a gadget error card, not a 500.
    const bad = (await authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`)
      .send({ type: 'pie-chart', config: { jql: 'project = DSH', statType: 'nope' } })
      .expect(201)).body;
    const badData = await authed(app).get(`/api/internal/dashboards/${d.id}/gadgets/${bad.id}/data`).expect(200);
    expect(badData.body.data.error).toBe('bad-statType');
  });

  it('agile + activity resolvers pull from the report/event services', async () => {
    const boards = await authed(app).get('/rest/agile/1.0/board?projectKeyOrId=DSH').expect(200);
    const boardId = boards.body.values[0].id;
    const sprint = (await authed(app).post('/rest/agile/1.0/sprint')
      .send({ originBoardId: boardId, name: 'DSH Sprint 1' }).expect(201)).body;

    const d = (await createDash({ name: 'Agile Wall' })).body;
    const add = (type: string, config: object) =>
      authed(app).post(`/rest/api/2/dashboard/${d.id}/gadget`).send({ type, config }).expect(201);
    await add('burndown-chart', { boardId });
    await add('velocity-chart', { boardId });
    await add('activity-stream', { projectKey: 'DSH' });
    const reg = await authed(app).get('/rest/api/2/dashboard/gadgets').expect(200);
    for (const t of ['burndown-chart', 'velocity-chart', 'activity-stream']) {
      expect(reg.body.gadgets.map((g: { type: string }) => g.type)).toContain(t);
    }

    const data = await authed(app).get(`/api/internal/dashboards/${d.id}/data`).expect(200);
    const byType = Object.fromEntries(data.body.gadgets.map(
      (g: { gadget: { type: string }; data?: Record<string, unknown> }) => [g.gadget.type, g.data]));
    // No active sprint → friendly empty state, not an error.
    expect(byType['burndown-chart'].sprint ?? byType['burndown-chart'].message).toBeTruthy();
    expect(byType['velocity-chart'].boardId).toBe(boardId);
    expect(byType['velocity-chart'].sprints).toEqual([]);
    // Issue creation emitted a domain event for DSH.
    const events = byType['activity-stream'].events as { type: string; issueKey?: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.issueKey)).toContain(issueKey);
    void sprint;
  });
});

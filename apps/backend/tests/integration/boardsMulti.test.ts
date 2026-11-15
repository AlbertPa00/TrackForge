import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';

/** 033 — multi-board per project, board JQL filter, quick filters, picker. */
describe('Multi-board (033)', () => {
  async function setup() {
    await request(app).post('/rest/api/2/project').send({ key: 'MB', name: 'Multi Board' }).expect(201);
    for (const [i, labels] of [
      [1, ['backend']],
      [2, ['frontend']],
      [3, ['backend', 'frontend']],
    ] as const) {
      await request(app)
        .post('/rest/api/2/issue')
        .send({ fields: { project: { key: 'MB' }, summary: `Issue ${i}`, labels: [...labels] } })
        .expect(201);
    }
  }

  it('auto-creates one default board; a second board coexists', async () => {
    await setup();
    const list = await request(app).get('/rest/agile/1.0/board?projectKeyOrId=MB').expect(200);
    expect(list.body.total).toBe(1);
    const def = list.body.values[0];
    expect(def.isDefault).toBe(true);

    const created = await request(app)
      .post('/rest/agile/1.0/board')
      .send({ name: 'Backend only', type: 'kanban', location: { projectKeyOrId: 'MB' } })
      .expect(201);
    expect(created.body.isDefault).toBe(false);

    const list2 = await request(app).get('/rest/agile/1.0/board?projectKeyOrId=MB').expect(200);
    expect(list2.body.total).toBe(2);
  });

  it('legacy project-key lookup resolves to the DEFAULT board (FR-002)', async () => {
    await setup();
    const def = await request(app).get('/rest/agile/1.0/board/MB').expect(200);
    const second = await request(app)
      .post('/rest/agile/1.0/board')
      .send({ name: 'Second', location: { projectKeyOrId: 'MB' } })
      .expect(201);
    // Project-key alias still lands on the original default, not the newest.
    const viaKey = await request(app).get('/rest/agile/1.0/board/MB').expect(200);
    expect(viaKey.body.id).toBe(def.body.id);
    expect(viaKey.body.id).not.toBe(second.body.id);
    // Direct id lookup hits the second board.
    const viaId = await request(app).get(`/rest/agile/1.0/board/${second.body.id}`).expect(200);
    expect(viaId.body.id).toBe(second.body.id);
  });

  it('board filter JQL scopes membership per board (FR-001)', async () => {
    await setup();
    const backend = await request(app)
      .post('/rest/agile/1.0/board')
      .send({ name: 'Backend', location: { projectKeyOrId: 'MB' }, filterId: undefined })
      .expect(201);
    await request(app)
      .put(`/api/internal/boards/${backend.body.id}`)
      .send({ filter: 'labels = backend' })
      .expect(200);

    const scoped = await request(app).get(`/rest/agile/1.0/board/${backend.body.id}/issue`).expect(200);
    expect(scoped.body.issues.map((i: { key: string }) => i.key).sort()).toEqual(['MB-1', 'MB-3']);

    // Default board still sees everything.
    const all = await request(app).get('/rest/agile/1.0/board/MB/issue').expect(200);
    expect(all.body.total).toBe(3);
  });

  it('quick filters AND onto board filter, never replace (FR-003)', async () => {
    await setup();
    const backend = await request(app)
      .post('/rest/agile/1.0/board')
      .send({ name: 'Backend', location: { projectKeyOrId: 'MB' } })
      .expect(201);
    await request(app)
      .put(`/api/internal/boards/${backend.body.id}`)
      .send({ filter: 'labels = backend' })
      .expect(200);
    const qf = await request(app)
      .post(`/api/internal/boards/${backend.body.id}/quickfilters`)
      .send({ name: 'FE too', jql: 'labels = frontend' })
      .expect(201);

    const res = await request(app)
      .get(`/rest/agile/1.0/board/${backend.body.id}/issue?quickFilterIds=${qf.body.id}`)
      .expect(200);
    expect(res.body.issues.map((i: { key: string }) => i.key)).toEqual(['MB-3']);

    // Jira read surface
    const listed = await request(app).get(`/rest/agile/1.0/board/${backend.body.id}/quickfilter`).expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].jql).toBe('labels = frontend');
    await request(app).get(`/rest/agile/1.0/board/${backend.body.id}/quickfilter/${qf.body.id}`).expect(200);
  });

  it('invalid quick-filter JQL is rejected at save', async () => {
    await setup();
    await request(app)
      .post('/api/internal/boards/MB/quickfilters')
      .send({ name: 'Broken', jql: '((( AND nonsense' })
      .expect(400);
  });

  it('default-board delete guard: promoteTo required, last board refused', async () => {
    await setup();
    const second = await request(app)
      .post('/rest/agile/1.0/board')
      .send({ name: 'Second', location: { projectKeyOrId: 'MB' } })
      .expect(201);

    // Deleting the default without promoteTo → 400.
    const def = (await request(app).get('/rest/agile/1.0/board/MB').expect(200)).body;
    await request(app).delete(`/rest/agile/1.0/board/${def.id}`).expect(400);

    // promoteTo transfers default and deletes.
    await request(app).delete(`/rest/agile/1.0/board/${def.id}?promoteTo=${second.body.id}`).expect(204);
    const after = await request(app).get('/rest/agile/1.0/board/MB').expect(200);
    expect(after.body.id).toBe(second.body.id);
    expect(after.body.isDefault).toBe(true);

    // Only board remains — delete refused.
    await request(app).delete(`/rest/agile/1.0/board/${second.body.id}`).expect(400);
  });

  it('set-default + rename via internal routes', async () => {
    await setup();
    const second = await request(app)
      .post('/rest/agile/1.0/board')
      .send({ name: 'Second', location: { projectKeyOrId: 'MB' } })
      .expect(201);
    await request(app).post(`/api/internal/boards/${second.body.id}/default`).expect(200);
    const viaKey = await request(app).get('/rest/agile/1.0/board/MB').expect(200);
    expect(viaKey.body.id).toBe(second.body.id);
    const renamed = await request(app)
      .put(`/api/internal/boards/${second.body.id}`)
      .send({ name: 'Renamed board' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed board');
  });

  it('card config round-trips', async () => {
    await setup();
    const cfg = { daysInColumn: true, hideDone: true, swimlaneBy: 'assignee', colors: { 'MB-1': 'red' } };
    await request(app).put('/api/internal/boards/MB/cardconfig').send(cfg).expect(200);
    const res = await request(app).get('/rest/agile/1.0/board/MB/cardconfig').expect(200);
    expect(res.body).toMatchObject(cfg);
  });

  it('issue picker: key and summary search', async () => {
    await setup();
    const byKey = await request(app).get('/rest/api/2/issue/picker?query=MB-2').expect(200);
    expect(byKey.body.sections[0].issues.map((i: { key: string }) => i.key)).toContain('MB-2');
    // statusCategory lets clients strike done-category keys (Jira behaviour).
    const hit = byKey.body.sections[0].issues.find((i: { key: string }) => i.key === 'MB-2');
    expect(hit.statusCategory).toBe('new');
    const bySummary = await request(app).get('/rest/api/2/issue/picker?query=Issue%203').expect(200);
    expect(bySummary.body.sections[0].issues.map((i: { key: string }) => i.key)).toContain('MB-3');
  });
});

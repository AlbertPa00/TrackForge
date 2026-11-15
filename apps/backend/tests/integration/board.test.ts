import { describe, it, expect } from 'vitest';
import { authed as request, transitionTo } from '../request.js';
import app from '../../src/main.js';

describe('Agile Board API', () => {
  async function setupProject() {
    await request(app)
      .post('/rest/api/2/project')
      .send({ key: 'BRD', name: 'Board Project' })
      .expect(201);
    const base = { project: { key: 'BRD' } };
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { ...base, summary: 'Card one' } })
      .expect(201);
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { ...base, summary: 'Card two' } })
      .expect(201);
    await transitionTo(app, 'BRD-2', 'In Progress');
  }

  it('returns a kanban board for a project key', async () => {
    await setupProject();

    const res = await request(app)
      .get('/rest/agile/1.0/board?projectKeyOrId=BRD')
      .expect(200);

    expect(res.body.total).toBe(1);
    const board = res.body.values[0];
    expect(board.id).toBeDefined();
    expect(board.type).toBe('kanban');
    expect(board.location.projectKey).toBe('BRD');
  });

  it('returns a column per status with statusCategory', async () => {
    await setupProject();

    const res = await request(app)
      .get('/rest/agile/1.0/board/BRD/configuration')
      .expect(200);

    const columns = res.body.columnConfig.columns;
    expect(columns.length).toBe(3);
    expect(columns.map((c: { name: string }) => c.name)).toEqual([
      'To Do',
      'In Progress',
      'Done',
    ]);
    expect(columns[0].statuses[0].statusCategory.key).toBe('new');
    expect(columns[2].statuses[0].statusCategory.key).toBe('done');
  });

  it('returns all board issues ordered by key', async () => {
    await setupProject();

    const res = await request(app).get('/rest/agile/1.0/board/BRD/issue').expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.issues.map((i: { key: string }) => i.key)).toEqual(['BRD-1', 'BRD-2']);
    expect(res.body.issues[1].fields.status.name).toBe('In Progress');
  });

  it('paginates board issues', async () => {
    await setupProject();

    const res = await request(app)
      .get('/rest/agile/1.0/board/BRD/issue?startAt=1&maxResults=1')
      .expect(200);

    expect(res.body.total).toBe(2);
    expect(res.body.issues.length).toBe(1);
    expect(res.body.issues[0].key).toBe('BRD-2');
  });

  // 062 US2 — inverted WIP limits and blank column names used to save silently.
  it('rejects inverted WIP limits and blank column names', async () => {
    await setupProject();
    const cfg = await request(app).get('/rest/agile/1.0/board/BRD/configuration').expect(200);
    const cols = cfg.body.columnConfig.columns.map((c: { name: string; statuses: { id: string }[] }) => ({
      name: c.name,
      statusIds: c.statuses.map((s) => s.id),
    }));

    const inverted = [...cols];
    inverted[1] = { ...inverted[1], min: 10, max: 5 };
    const res = await request(app)
      .put('/rest/agile/1.0/board/BRD/configuration')
      .send({ columns: inverted })
      .expect(400);
    const key = Object.keys(res.body.errors).find((k) => k.includes('max'));
    expect(key).toBeTruthy();
    expect(res.body.errors[key!]).toMatch(/greater than or equal to Min/);

    const blank = [{ ...cols[0], name: '   ' }, ...cols.slice(1)];
    await request(app)
      .put('/rest/agile/1.0/board/BRD/configuration')
      .send({ columns: blank })
      .expect(400);
  });

  it('returns 404 for an unknown board', async () => {
    await request(app).get('/rest/agile/1.0/board/NOPE/configuration').expect(404);
    await request(app).get('/rest/agile/1.0/board/NOPE/issue').expect(404);
  });

  it('lists all boards when no filter is given', async () => {
    await setupProject();
    const res = await request(app).get('/rest/agile/1.0/board').expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.values.map((b: { location: { projectKey: string } }) => b.location.projectKey)).toContain('BRD');
  });
});

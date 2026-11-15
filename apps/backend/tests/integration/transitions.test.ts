import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';

describe('Issue Transitions API', () => {
  async function setupIssue() {
    await request(app).post('/rest/api/2/project').send({ key: 'PROJ', name: 'Sample' }).expect(201);
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'PROJ' }, summary: 'Transition me' } })
      .expect(201);
  }

  it('lists workflow transitions available from the current status', async () => {
    await setupIssue();

    const res = await request(app).get('/rest/api/2/issue/PROJ-1/transitions').expect(200);
    const names = res.body.transitions.map((t: { name: string }) => t.name);
    expect(names).toEqual(['Start Progress']); // To Do → In Progress; Reopen targets To Do (self) so is hidden

    const t = res.body.transitions.find((t: { name: string }) => t.name === 'Start Progress');
    expect(t.to.name).toBe('In Progress');
    expect(t.to.statusCategory.key).toBe('indeterminate');
  });

  it('executes a transition', async () => {
    await setupIssue();

    const list = await request(app).get('/rest/api/2/issue/PROJ-1/transitions').expect(200);
    const start = list.body.transitions.find((t: { name: string }) => t.name === 'Start Progress');

    await request(app)
      .post('/rest/api/2/issue/PROJ-1/transitions')
      .send({ transition: { id: start.id } })
      .expect(204);

    const res = await request(app).get('/rest/api/2/issue/PROJ-1').expect(200);
    expect(res.body.fields.status.name).toBe('In Progress');
    expect(res.body.fields.status.statusCategory.key).toBe('indeterminate');
  });

  it('enforces validators and screens on transitions', async () => {
    await setupIssue();
    const list = async () =>
      (await request(app).get('/rest/api/2/issue/PROJ-1/transitions').expect(200)).body.transitions;
    const run = async (id: string, body: Record<string, unknown> = {}, status = 204) =>
      request(app)
        .post('/rest/api/2/issue/PROJ-1/transitions')
        .send({ transition: { id }, ...body })
        .expect(status);

    await run((await list()).find((t: { name: string }) => t.name === 'Start Progress').id);

    const done = (await list()).find((t: { name: string; hasScreen: boolean }) => t.name === 'Done');
    expect(done.hasScreen).toBe(true);

    // resolutionRequired validator rejects without the screen field
    const rejected = await run(done.id, {}, 400);
    expect(rejected.body.errors.resolution).toBeDefined();

    // supplying the screen field + a comment succeeds
    await run(done.id, {
      fields: { resolution: { name: 'Done' } },
      update: { comment: [{ add: { body: 'closing via transition' } }] },
    });
    const res = await request(app).get('/rest/api/2/issue/PROJ-1').expect(200);
    expect(res.body.fields.status.name).toBe('Done');
    expect(res.body.fields.resolution.name).toBe('Done');
    expect(res.body.fields.resolutiondate).toBeDefined();
  });

  it('reopens via the global transition and clears resolution', async () => {
    await setupIssue();
    const list = async () =>
      (await request(app).get('/rest/api/2/issue/PROJ-1/transitions').expect(200)).body.transitions;
    const run = async (name: string, body: Record<string, unknown> = {}) => {
      const t = (await list()).find((x: { name: string }) => x.name === name);
      return request(app)
        .post('/rest/api/2/issue/PROJ-1/transitions')
        .send({ transition: { id: t.id }, ...body })
        .expect(204);
    };
    await run('Start Progress');
    await run('Done', { fields: { resolution: { name: 'Done' } } });
    await run('Reopen');
    const res = await request(app).get('/rest/api/2/issue/PROJ-1').expect(200);
    expect(res.body.fields.status.name).toBe('To Do');
    expect(res.body.fields.resolution).toBeNull();
  });

  it('rejects a transition not reachable from the current status', async () => {
    await setupIssue();
    await request(app)
      .post('/rest/api/2/issue/PROJ-1/transitions')
      .send({ transition: { id: 'does-not-exist' } })
      .expect(404);
  });

  it('returns 404 for transitions on a missing issue', async () => {
    await request(app).get('/rest/api/2/issue/NOPE-9/transitions').expect(404);
  });
});

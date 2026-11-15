import { describe, it, expect } from 'vitest';
import { authed as request, transitionTo } from '../request.js';
import app from '../../src/main.js';

describe('Issue API', () => {
  async function createTestProject() {
    await request(app).post('/rest/api/2/project').send({ key: 'PROJ', name: 'Sample Project' }).expect(201);
  }

  it('creates an issue with default type and priority', async () => {
    await createTestProject();

    const res = await request(app)
      .post('/rest/api/2/issue')
      .send({
        fields: {
          project: { key: 'PROJ' },
          summary: 'First issue',
        },
      })
      .expect(201);

    expect(res.body.key).toBe('PROJ-1');
    expect(res.body.fields.summary).toBe('First issue');
    expect(res.body.fields.issuetype.name).toBe('Task');
    expect(res.body.fields.status.name).toBe('To Do');
    expect(res.body.fields.priority.name).toBe('Medium');
  });

  it('gets an issue by key', async () => {
    await createTestProject();
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'PROJ' }, summary: 'First issue' } })
      .expect(201);

    const res = await request(app).get('/rest/api/2/issue/PROJ-1').expect(200);
    expect(res.body.fields.summary).toBe('First issue');
  });

  it('lists issues by project', async () => {
    await createTestProject();
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'PROJ' }, summary: 'First issue' } })
      .expect(201);

    const res = await request(app).get('/rest/api/2/search?jql=project=PROJ').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].key).toBe('PROJ-1');
  });

  it('updates issue status', async () => {
    await createTestProject();
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'PROJ' }, summary: 'First issue' } })
      .expect(201);

    await transitionTo(app, 'PROJ-1', 'In Progress');

    const res = await request(app).get('/rest/api/2/issue/PROJ-1').expect(200);
    expect(res.body.fields.status.name).toBe('In Progress');
  });

  it('rejects direct status edits — status only moves via transitions', async () => {
    await createTestProject();
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'PROJ' }, summary: 'First issue' } })
      .expect(201);

    const res = await request(app)
      .put('/rest/api/2/issue/PROJ-1')
      .send({ fields: { status: { name: 'In Progress' } } })
      .expect(400);

    expect(res.body.errors.status).toBeDefined();
  });

  it('rejects issue for missing project', async () => {
    const res = await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'MISS' }, summary: 'First issue' } })
      .expect(400);

    expect(res.body.errors['fields.project']).toBeDefined();
  });
});

import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';

describe('Project API', () => {
  it('creates a project', async () => {
    const res = await request(app)
      .post('/rest/api/2/project')
      .send({ key: 'PROJ', name: 'Sample Project' })
      .expect(201);

    expect(res.body.key).toBe('PROJ');
    expect(res.body.name).toBe('Sample Project');
    expect(res.body.projectTypeKey).toBe('software');
  });

  it('lists projects', async () => {
    await request(app).post('/rest/api/2/project').send({ key: 'PROJ', name: 'Sample Project' }).expect(201);

    const res = await request(app).get('/rest/api/2/project').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].key).toBe('PROJ');
  });

  it('gets a project by key', async () => {
    await request(app).post('/rest/api/2/project').send({ key: 'PROJ', name: 'Sample Project' }).expect(201);

    const res = await request(app).get('/rest/api/2/project/PROJ').expect(200);
    expect(res.body.name).toBe('Sample Project');
  });

  it('rejects duplicate project keys', async () => {
    await request(app).post('/rest/api/2/project').send({ key: 'PROJ', name: 'Sample Project' }).expect(201);

    const res = await request(app)
      .post('/rest/api/2/project')
      .send({ key: 'PROJ', name: 'Another' })
      .expect(400);

    expect(res.body.errors.key).toBeDefined();
  });
});

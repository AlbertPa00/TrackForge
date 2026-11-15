import { describe, it, expect } from 'vitest';
import { authed as request, transitionTo } from '../request.js';
import app from '../../src/main.js';

async function setupIssues() {
  await request(app).post('/rest/api/2/project').send({ key: 'PROJ', name: 'Sample' }).expect(201);
  const base = { project: { key: 'PROJ' } };
  await request(app)
    .post('/rest/api/2/issue')
    .send({ fields: { ...base, summary: 'Bug one', issuetype: { name: 'Bug' }, priority: { name: 'High' } } })
    .expect(201);
  await request(app)
    .post('/rest/api/2/issue')
    .send({ fields: { ...base, summary: 'Task two', issuetype: { name: 'Task' } } })
    .expect(201);
  await request(app)
    .post('/rest/api/2/issue')
    .send({ fields: { ...base, summary: 'Story three', issuetype: { name: 'Story' } } })
    .expect(201);
  await transitionTo(app, 'PROJ-2', 'Done');
}

describe('Search API', () => {
  it('filters by status', async () => {
    await setupIssues();

    const res = await request(app)
      .get('/rest/api/2/search?jql=' + encodeURIComponent('project = PROJ AND status = "Done"'))
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].key).toBe('PROJ-2');
  });

  it('filters by issuetype with bare value', async () => {
    await setupIssues();

    const res = await request(app)
      .get('/rest/api/2/search?jql=' + encodeURIComponent('project = PROJ AND issuetype = Bug'))
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].fields.summary).toBe('Bug one');
  });

  it('filters by multiple clauses', async () => {
    await setupIssues();

    const res = await request(app)
      .get(
        '/rest/api/2/search?jql=' +
          encodeURIComponent('project = PROJ AND issuetype = "Bug" AND priority = "High"')
      )
      .expect(200);

    expect(res.body.total).toBe(1);
  });

  it('orders by key descending', async () => {
    await setupIssues();

    const res = await request(app)
      .get('/rest/api/2/search?jql=' + encodeURIComponent('project = PROJ ORDER BY key DESC'))
      .expect(200);

    expect(res.body.issues.map((i: { key: string }) => i.key)).toEqual(['PROJ-3', 'PROJ-2', 'PROJ-1']);
  });

  it('paginates with startAt and maxResults', async () => {
    await setupIssues();

    const page = await request(app)
      .get('/rest/api/2/search?jql=project=PROJ&startAt=1&maxResults=1')
      .expect(200);

    expect(page.body.total).toBe(3);
    expect(page.body.issues.length).toBe(1);
    expect(page.body.startAt).toBe(1);
    expect(page.body.issues[0].key).toBe('PROJ-2');
  });

  it('rejects unknown fields', async () => {
    const res = await request(app)
      .get('/rest/api/2/search?jql=' + encodeURIComponent('project = PROJ AND nosuchfield = web'))
      .expect(400);

    expect(res.body.errorMessages[0]).toMatch(/Field 'nosuchfield' does not exist/);
  });

  it('searches across projects without a project clause', async () => {
    await setupIssues();

    const res = await request(app)
      .get('/rest/api/2/search?jql=' + encodeURIComponent('status = "Done"'))
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].key).toBe('PROJ-2');
  });
});

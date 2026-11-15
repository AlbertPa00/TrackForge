import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { authed, sessioned } from '../request.js';
import app from '../../src/main.js';


const login = (body: object) =>
  request(app).post('/api/internal/auth/login').send(body);

describe('authentication', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/rest/api/2/project');
    expect(res.status).toBe(401);
    expect(res.body.errorMessages).toContain('You are not authenticated.');
  });

  it('rejects unauthenticated /api/internal with 401', async () => {
    const res = await request(app).get('/api/internal/tokens');
    expect(res.status).toBe(401);
  });

  it('logs in with valid credentials and returns myself', async () => {
    const res = await login({ email: 'admin@test.local', password: 'test-password-1' });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0];
    expect(cookie).toContain('tf_session=');
    expect(cookie).toContain('HttpOnly');

    const me = await request(app).get('/rest/api/2/myself').set('Cookie', cookie!);
    expect(me.status).toBe(200);
    expect(me.body.emailAddress).toBe('admin@test.local');
    expect(me.body.displayName).toBe('Test Admin');
  });

  it('rejects bad credentials with 401', async () => {
    const res = await login({ email: 'admin@test.local', password: 'wrong' });
    expect(res.status).toBe(401);
  });
});

describe('scoped tokens', () => {
  it('creates a token and authenticates with Bearer', async () => {
    // 065 audit B1 — token creation is session-only; token-authenticated
    // callers get 403 so a scoped token can't mint an unrestricted one.
    const denied = await authed(app)
      .post('/api/internal/tokens')
      .send({ name: 'ci', scopes: ['read'] });
    expect(denied.status).toBe(403);
    const res = await (await sessioned(app))
      .post('/api/internal/tokens')
      .send({ name: 'ci', scopes: ['read'] });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^tfp_/);
    const me = await request(app)
      .get('/rest/api/2/myself')
      .set('Authorization', `Bearer ${res.body.secret}`);
    expect(me.status).toBe(200);
  });

  it('enforces read scope on writes', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'TF', name: 'TF' });
    const t = await (await sessioned(app))
      .post('/api/internal/tokens')
      .send({ name: 'ro', scopes: ['read'], projectKeys: ['TF'] });

    const write = await request(app)
      .post('/rest/api/2/issue')
      .set('Authorization', `Bearer ${t.body.secret}`)
      .send({ fields: { project: { key: 'TF' }, summary: 'x' } });
    expect(write.status).toBe(403);
    expect(write.body.errors.scope).toContain('write');
  });

  it('project allow-list returns 404 for other projects', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'TF', name: 'TF' });
    await authed(app).post('/rest/api/2/project').send({ key: 'MOB', name: 'Mob' });
    const t = await (await sessioned(app))
      .post('/api/internal/tokens')
      .send({ name: 'scoped', scopes: ['read'], projectKeys: ['TF'] });

    const ok = await request(app)
      .get('/rest/api/2/search?jql=' + encodeURIComponent('project = TF'))
      .set('Authorization', `Bearer ${t.body.secret}`);
    expect(ok.status).toBe(200);

    const denied = await request(app)
      .get('/rest/api/2/search?jql=' + encodeURIComponent('project = MOB'))
      .set('Authorization', `Bearer ${t.body.secret}`);
    // Sprint 010: JQL engine returns a Jira-style 400 value error for
    // projects outside the token allow-list (doesn't confirm existence).
    expect(denied.status).toBe(400);
    expect(denied.body.errorMessages[0]).toContain("'MOB' does not exist for the field 'project'");
  });

  it('revoked token returns 401', async () => {
    const t = await (await sessioned(app))
      .post('/api/internal/tokens')
      .send({ name: 'rev', scopes: ['read'] });
    await authed(app).delete(`/api/internal/tokens/${t.body.id}`);
    const res = await request(app)
      .get('/rest/api/2/myself')
      .set('Authorization', `Bearer ${t.body.secret}`);
    expect(res.status).toBe(401);
  });
});

describe('assignee + changelog', () => {
  async function seedAssignedIssue() {
    await authed(app).post('/rest/api/2/project').send({ key: 'ASG', name: 'Assign' });
    const created = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'ASG' }, summary: 'Owned' } });
    const me = (await authed(app).get('/rest/api/2/myself')).body;
    await authed(app)
      .put(`/rest/api/2/issue/${created.body.key}/assignee`)
      .send({ accountId: me.accountId });
    return { key: created.body.key as string, me };
  }

  it('sets reporter from actor and assignee via PUT assignee', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'ASG', name: 'Assign' });
    const created = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'ASG' }, summary: 'Owned' } });
    expect(created.status).toBe(201);
    const me = (await authed(app).get('/rest/api/2/myself')).body;
    expect(created.body.fields.reporter.accountId).toBe(me.accountId);

    const put = await authed(app)
      .put(`/rest/api/2/issue/${created.body.key}/assignee`)
      .send({ accountId: me.accountId });
    expect(put.status).toBe(204);
    const issue = await authed(app).get(`/rest/api/2/issue/${created.body.key}`);
    expect(issue.body.fields.assignee.accountId).toBe(me.accountId);

    // unassign via null
    await authed(app)
      .put(`/rest/api/2/issue/${created.body.key}/assignee`)
      .send({ accountId: null })
      .expect(204);
    const unassigned = await authed(app).get(`/rest/api/2/issue/${created.body.key}`);
    expect(unassigned.body.fields.assignee).toBeNull();
  });

  it('writes changelog entries with channel and actor', async () => {
    const { key } = await seedAssignedIssue();
    const issue = await authed(app).get(`/rest/api/2/issue/${key}?expand=changelog`);
    const histories = issue.body.changelog.histories;
    expect(histories.length).toBeGreaterThanOrEqual(2); // create + assign
    const createEntry = histories.find((h: { items: { field: string }[] }) =>
      h.items.some((i) => i.field === 'summary')
    );
    expect(createEntry.author.displayName).toBe('Test Admin');
    expect(createEntry.channel).toBe('api');
    const assignEntry = histories.find((h: { items: { field: string }[] }) =>
      h.items.some((i) => i.field === 'assignee')
    );
    expect(assignEntry.items[0].toString).toBe('Test Admin');
  });

  it('filters by assignee = currentUser() and EMPTY', async () => {
    await seedAssignedIssue();
    const jql1 = encodeURIComponent('project = ASG AND assignee = currentUser()');
    const res1 = await authed(app).get(`/rest/api/2/search?jql=${jql1}`);
    expect(res1.body.total).toBe(1);
    const jql2 = encodeURIComponent('project = ASG AND assignee = EMPTY');
    const res2 = await authed(app).get(`/rest/api/2/search?jql=${jql2}`);
    expect(res2.body.total).toBe(0);
  });
});

describe('admin user management', () => {
  it('creates users and prevents last-admin demotion', async () => {
    const res = await authed(app)
      .post('/api/internal/users')
      .send({ email: 'bob@test.local', displayName: 'Bob', password: 'password-123' });
    expect(res.status).toBe(201);

    const me = (await authed(app).get('/rest/api/2/myself')).body;
    const demote = await authed(app)
      .put(`/api/internal/users/${me.accountId}`)
      .send({ isAdmin: false });
    expect(demote.status).toBe(400);
  });

  it('creates agent accounts that cannot log in', async () => {
    const me = (await authed(app).get('/rest/api/2/myself')).body;
    const res = await authed(app)
      .post('/api/internal/users')
      .send({
        email: 'bot@test.local',
        displayName: 'Bot',
        type: 'agent',
        ownerId: me.accountId,
      });
    expect(res.status).toBe(201);
    expect(res.body.agent).toBe(true);
    const loginRes = await login({ email: 'bot@test.local', password: 'x' });
    expect(loginRes.status).toBe(401);
  });
});

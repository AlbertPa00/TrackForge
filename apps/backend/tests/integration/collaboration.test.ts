import { describe, it, expect } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed } from '../request.js';
import { hashPassword } from '../../src/lib/auth.js';

async function seedProject(key = 'COL') {
  const project = await prisma.project.create({ data: { key, name: 'Collab' } });
  return project;
}

async function createIssue(key: string, fields: Record<string, unknown> = {}) {
  const res = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key }, summary: 'issue', ...fields } });
  return res;
}

describe('collaboration — fields, hierarchy, labels', () => {
  it('creates + reads labels, duedate, resolution, parent', async () => {
    await seedProject();
    const epic = await createIssue('COL', { issuetype: { name: 'Epic' }, summary: 'epic' });
    expect(epic.status).toBe(201);
    const child = await createIssue('COL', {
      summary: 'story',
      issuetype: { name: 'Story' },
      parent: { key: epic.body.key },
      labels: ['backend', 'auth'],
      duedate: '2026-12-01',
    });
    expect(child.status).toBe(201);
    expect(child.body.fields.parent.key).toBe(epic.body.key);
    // Jira parity: the parent ref carries status for done-strike rendering.
    expect(child.body.fields.parent.fields.status.statusCategory.key).toBe('new');
    expect(child.body.fields.labels).toEqual(['backend', 'auth']);
    expect(child.body.fields.duedate).toBe('2026-12-01');

    const get = await authed(app).get(`/rest/api/2/issue/${epic.body.key}`);
    expect(get.body.fields.subtasks).toEqual([]);
    // epic children are not subtasks — check the children endpoint
    const children = await authed(app).get(`/rest/api/2/issue/${epic.body.key}/children`);
    expect(children.body.issues.map((i: { key: string }) => i.key)).toContain(child.body.key);
  });

  it('validates hierarchy: subtask requires a non-subtask parent', async () => {
    await seedProject();
    const noParent = await createIssue('COL', { issuetype: { name: 'Subtask' } });
    expect(noParent.status).toBe(400);

    const sub1 = await createIssue('COL', { issuetype: { name: 'Subtask' } });
    const parent = await createIssue('COL', { summary: 'task' });
    const sub = await createIssue('COL', { issuetype: { name: 'Subtask' }, parent: { key: parent.body.key } });
    expect(sub.status).toBe(201);
    // subtask cannot parent a story (wrong level)
    const bad = await createIssue('COL', { issuetype: { name: 'Story' }, parent: { key: sub.body.key } });
    expect(bad.status).toBe(400);
    void sub1;
  });

  it('rejects labels with spaces; supports update add/remove ops', async () => {
    await seedProject();
    const bad = await createIssue('COL', { labels: ['has space'] });
    expect(bad.status).toBe(400);
    const issue = await createIssue('COL', { labels: ['a', 'b'] });
    const res = await authed(app)
      .put(`/rest/api/2/issue/${issue.body.key}`)
      .send({ update: { labels: [{ add: 'c' }, { remove: 'a' }] } });
    expect(res.status).toBe(204);
    const get = await authed(app).get(`/rest/api/2/issue/${issue.body.key}`);
    expect(get.body.fields.labels.sort()).toEqual(['b', 'c']);
  });

  it('sets resolution via update ops; /resolution lists seeded values', async () => {
    await seedProject();
    const res = await authed(app).get('/rest/api/2/resolution');
    expect(res.body.map((r: { name: string }) => r.name)).toContain('Done');
    const issue = await createIssue('COL');
    await authed(app)
      .put(`/rest/api/2/issue/${issue.body.key}`)
      .send({ fields: { resolution: { name: 'Done' } } });
    const get = await authed(app).get(`/rest/api/2/issue/${issue.body.key}`);
    expect(get.body.fields.resolution.name).toBe('Done');
    expect(get.body.fields.resolutiondate).toBeTruthy();
  });

  it('GET /label returns distinct labels', async () => {
    await seedProject();
    await createIssue('COL', { labels: ['x', 'y'] });
    await createIssue('COL', { labels: ['y', 'z'] });
    const res = await authed(app).get('/rest/api/2/label');
    expect(res.body.values).toEqual(['x', 'y', 'z']);
  });
});

describe('comments', () => {
  it('CRUD with Jira paging shape + permissions', async () => {
    await seedProject();
    const issue = await createIssue('COL');
    const key = issue.body.key;

    const c = await authed(app).post(`/rest/api/2/issue/${key}/comment`).send({ body: 'hello world' });
    expect(c.status).toBe(201);
    expect(c.body.author.displayName).toBe('Test Admin');

    const list = await authed(app).get(`/rest/api/2/issue/${key}/comment?startAt=0&maxResults=10`);
    expect(list.body.total).toBe(1);
    expect(list.body.comments[0].body).toBe('hello world');

    const edit = await authed(app)
      .put(`/rest/api/2/issue/${key}/comment/${c.body.id}`)
      .send({ body: 'edited' });
    expect(edit.status).toBe(200);
    expect(edit.body.body).toBe('edited');

    // non-author non-admin cannot edit/delete
    const other = await prisma.user.create({
      data: { email: 'other@t.local', displayName: 'Other', passwordHash: await hashPassword('password123') },
    });
    const { generateToken } = await import('../../src/lib/auth.js');
    const tok = generateToken();
    await prisma.apiToken.create({
      data: { userId: other.id, name: 't', prefix: tok.prefix, hash: tok.hash, scopes: ['read', 'write'] },
    });
    const st = (await import('supertest')).default;
    const res = await st(app)
      .put(`/rest/api/2/issue/${key}/comment/${c.body.id}`)
      .set('Authorization', `Bearer ${tok.plain}`)
      .send({ body: 'hack' });
    expect(res.status).toBe(403);
    const del = await st(app)
      .delete(`/rest/api/2/issue/${key}/comment/${c.body.id}`)
      .set('Authorization', `Bearer ${tok.plain}`);
    expect(del.status).toBe(403);

    // admin deletes own comment
    const delOk = await authed(app).delete(`/rest/api/2/issue/${key}/comment/${c.body.id}`);
    expect(delOk.status).toBe(204);
  });
});

describe('issue links', () => {
  it('creates, reads and deletes links with inward/outward semantics', async () => {
    await seedProject();
    const a = await createIssue('COL', { summary: 'a' });
    const b = await createIssue('COL', { summary: 'b' });
    const types = await authed(app).get('/rest/api/2/issueLinkType');
    expect(types.body.issueLinkTypes.map((t: { name: string }) => t.name)).toContain('Blocks');

    const link = await authed(app)
      .post('/rest/api/2/issueLink')
      .send({ type: { name: 'Blocks' }, outwardIssue: { key: a.body.key }, inwardIssue: { key: b.body.key } });
    expect(link.status).toBe(201);

    const getA = await authed(app).get(`/rest/api/2/issue/${a.body.key}`);
    expect(getA.body.fields.issuelinks[0].inwardIssue.key).toBe(b.body.key);
    // Jira parity: linked issues carry status so clients can strike done keys.
    expect(getA.body.fields.issuelinks[0].inwardIssue.fields.status.statusCategory.key).toBe('new');
    const linkId = getA.body.fields.issuelinks[0].id;

    // Transition b to Done (To Do → In Progress → Done; resolution required).
    const steps = async () =>
      (await authed(app).get(`/rest/api/2/issue/${b.body.key}/transitions`)).body.transitions as {
        id: string;
        name: string;
      }[];
    const start = (await steps()).find((t) => /start progress/i.test(t.name));
    await authed(app).post(`/rest/api/2/issue/${b.body.key}/transitions`).send({ transition: { id: start.id } }).expect(204);
    const done = (await steps()).find((t) => /^done$/i.test(t.name));
    await authed(app)
      .post(`/rest/api/2/issue/${b.body.key}/transitions`)
      .send({ transition: { id: done.id }, fields: { resolution: { name: 'Done' } } })
      .expect(204);
    const getA2 = await authed(app).get(`/rest/api/2/issue/${a.body.key}`);
    expect(getA2.body.fields.issuelinks[0].inwardIssue.fields.status.statusCategory.key).toBe('done');

    const del = await authed(app).delete(`/rest/api/2/issueLink/${linkId}`);
    expect(del.status).toBe(204);
  });
});

describe('delete issue — Jira semantics + confirmToken', () => {
  it('requires deleteSubtasks for parents; requires confirmToken; clears epic children', async () => {
    await seedProject();
    const parent = await createIssue('COL', { summary: 'parent' });
    await createIssue('COL', { issuetype: { name: 'Subtask' }, parent: { key: parent.body.key } });

    // without deleteSubtasks → 400
    const blocked = await authed(app).delete(`/rest/api/2/issue/${parent.body.key}`);
    expect(blocked.status).toBe(400);

    // dryRun → confirmToken
    const preview = await authed(app).delete(`/rest/api/2/issue/${parent.body.key}?deleteSubtasks=true&dryRun=true`);
    expect(preview.status).toBe(200);
    expect(preview.body.deletesSubtasks).toHaveLength(1);
    const token = preview.body.confirmToken;
    expect(token).toBeTruthy();

    // real delete without token → 400; with token → 204
    const noToken = await authed(app).delete(`/rest/api/2/issue/${parent.body.key}?deleteSubtasks=true`);
    expect(noToken.status).toBe(400);
    const ok = await authed(app).delete(
      `/rest/api/2/issue/${parent.body.key}?deleteSubtasks=true&confirmToken=${token}`
    );
    expect(ok.status).toBe(204);

    // epic child is reparented (parent cleared), not deleted
    const epic = await createIssue('COL', { issuetype: { name: 'Epic' }, summary: 'epic' });
    const child = await createIssue('COL', { summary: 'story', parent: { key: epic.body.key } });
    const prev = await authed(app).delete(`/rest/api/2/issue/${epic.body.key}?dryRun=true`);
    const gone = await authed(app).delete(
      `/rest/api/2/issue/${epic.body.key}?confirmToken=${prev.body.confirmToken}`
    );
    expect(gone.status).toBe(204);
    const orphan = await authed(app).get(`/rest/api/2/issue/${child.body.key}`);
    expect(orphan.body.fields.parent).toBeUndefined();
    const changelog = await authed(app).get(`/rest/api/2/issue/${child.body.key}/changelog`);
    expect(JSON.stringify(changelog.body)).toContain('parent');
  });
});

describe('project update + delete', () => {
  it('updates name/lead/avatarColor; admin delete removes issues', async () => {
    const project = await seedProject('DEL');
    await createIssue('DEL');
    const me = await authed(app).get('/rest/api/2/myself');

    const upd = await authed(app)
      .put('/rest/api/2/project/DEL')
      .send({ name: 'Deleted Soon', avatarColor: '#123456', lead: { accountId: me.body.accountId } });
    expect(upd.status).toBe(200);
    expect(upd.body.name).toBe('Deleted Soon');
    expect(upd.body.lead.accountId).toBe(me.body.accountId);

    // 065 G8 — project delete is two-step: dryRun previews + confirmToken,
    // bare DELETE 400s, token executes.
    const bare = await authed(app).delete('/rest/api/2/project/DEL');
    expect(bare.status).toBe(400);
    const preview = await authed(app).delete('/rest/api/2/project/DEL?dryRun=true');
    expect(preview.status).toBe(200);
    expect(preview.body.deletesIssues).toBeGreaterThanOrEqual(1);
    expect(preview.body.confirmToken).toBeTruthy();
    const del = await authed(app).delete(`/rest/api/2/project/DEL?confirmToken=${preview.body.confirmToken}`);
    expect(del.status).toBe(204);
    const check = await prisma.project.findUnique({ where: { id: project.id } });
    expect(check).toBeNull();
  });
});

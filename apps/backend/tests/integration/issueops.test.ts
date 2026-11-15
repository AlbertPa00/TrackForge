import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';

/** Sprint 022 — issue operations: votes, remote links, environment/reporter, clone, move. */

beforeAll(async () => {
  await ensureTestAuth();
});

async function makeProject(key: string) {
  const exists = await prisma.project.findUnique({ where: { key } });
  if (exists) return;
  await authed(app).post('/rest/api/2/project').send({ key, name: key }).expect(201);
}

async function makeIssue(key: string, summary = 'ops test issue') {
  await makeProject(key.split('-')[0]);
  const res = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: key.split('-')[0] }, summary } })
    .expect(201);
  return res.body.key as string;
}

async function mintUser(email: string) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: email, passwordHash: await hashPassword('x-'.repeat(8)) },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes: ['read', 'write'], projectKeys: [] } });
  return { user, agent: request.agent(app).set('Authorization', `Bearer ${plain}`) };
}

describe('votes', () => {
  it('POST/DELETE /issue/{k}/votes — idempotent, per-user, serialized in fields.votes', async () => {
    const key = await makeIssue('OPS-1');
    const other = await mintUser('voter2@test.local');

    for (const agent of [authed(app), other.agent]) {
      const r = await agent.post(`/rest/api/2/issue/${key}/votes`);
      expect(r.status).toBe(204);
    }
    // same user re-votes — counts once (US1.1)
    expect((await other.agent.post(`/rest/api/2/issue/${key}/votes`)).status).toBe(204);

    const list = await authed(app).get(`/rest/api/2/issue/${key}/votes`);
    expect(list.body.votes).toBe(2);
    expect(list.body.hasVoted).toBe(true);
    expect(list.body.voters).toHaveLength(2);

    const view = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(view.body.fields.votes.votes).toBe(2);
    const otherView = await other.agent.get(`/rest/api/2/issue/${key}`);
    expect(otherView.body.fields.votes.hasVoted).toBe(true);

    // DELETE removes only the caller's vote
    await other.agent.delete(`/rest/api/2/issue/${key}/votes`);
    const after = await authed(app).get(`/rest/api/2/issue/${key}/votes`);
    expect(after.body.votes).toBe(1);
    const otherAfter = await other.agent.get(`/rest/api/2/issue/${key}/votes`);
    expect(otherAfter.body.hasVoted).toBe(false);
  });
});

describe('remote links', () => {
  it('CRUD /issue/{k}/remotelink — Jira object shape, changelog entry', async () => {
    const key = await makeIssue('OPS-1');
    const created = await authed(app)
      .post(`/rest/api/2/issue/${key}/remotelink`)
      .send({ object: { url: 'https://example.com/doc/1', title: 'Spec doc', summary: 'Design' }, globalId: 'app-1' });
    expect(created.status).toBe(201);
    expect(created.body.object.url).toBe('https://example.com/doc/1');
    expect(created.body.object.title).toBe('Spec doc');
    const linkId = created.body.id;

    const list = await authed(app).get(`/rest/api/2/issue/${key}/remotelink`);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(linkId);

    expect((await authed(app).delete(`/rest/api/2/issue/${key}/remotelink/${linkId}`)).status).toBe(204);
    expect((await authed(app).get(`/rest/api/2/issue/${key}/remotelink`)).body).toHaveLength(0);

    const ch = await authed(app).get(`/rest/api/2/issue/${key}?expand=changelog`);
    const items = ch.body.changelog.histories.flatMap((h: { items: { field: string }[] }) => h.items);
    expect(items.some((i: { field: string }) => i.field === 'Link')).toBe(true);
  });

  it('rejects missing object.url/title', async () => {
    const key = await makeIssue('OPS-1');
    const r = await authed(app)
      .post(`/rest/api/2/issue/${key}/remotelink`)
      .send({ object: { title: 'no url' } });
    expect(r.status).toBe(400);
  });
});

describe('environment + reporter', () => {
  it('creates and updates fields.environment + fields.reporter with changelog', async () => {
    await makeProject('ENV');
    const other = await mintUser('env-reporter@test.local');
    const created = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'ENV' }, summary: 'env issue', environment: 'prod-us-1', reporter: { accountId: other.user.id } } })
      .expect(201);
    expect(created.body.fields.environment).toBe('prod-us-1');
    expect(created.body.fields.reporter.accountId).toBe(other.user.id);

    const key = created.body.key;
    const adminUser = await prisma.user.findFirst({ where: { email: 'admin@test.local' } });
    const upd = await authed(app)
      .put(`/rest/api/2/issue/${key}`)
      .send({ fields: { environment: 'staging', reporter: { accountId: adminUser!.id } } });
    expect(upd.status).toBe(204);

    const view = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(view.body.fields.environment).toBe('staging');
    expect(view.body.fields.reporter.accountId).toBe(adminUser!.id);

    const ch = await authed(app).get(`/rest/api/2/issue/${key}?expand=changelog`);
    const fields = ch.body.changelog.histories.flatMap((h: { items: { field: string }[] }) => h.items.map((i) => i.field));
    expect(fields).toContain('environment');
    expect(fields).toContain('reporter');
  });
});

describe('clone', () => {
  it('dryRun returns would-be payload; commit creates CLONE - prefix + Cloners link + watch', async () => {
    const key = await makeIssue('OPS-1');
    await authed(app).post(`/rest/api/2/issue/${key}/votes`);

    const dry = await authed(app)
      .post(`/api/internal/issues/${key}/clone`)
      .send({ dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.fields.summary).toBe('CLONE - ops test issue');

    const res = await authed(app)
      .post(`/api/internal/issues/${key}/clone`)
      .send({});
    expect(res.status).toBe(201);
    const clone = res.body.issue;
    expect(clone.fields.summary).toBe('CLONE - ops test issue');
    const link = clone.fields.issuelinks.find((l: { type: { name: string } }) => l.type.name === 'Cloners');
    expect(link).toBeTruthy();
    expect(clone.fields.watches.isWatching).toBe(true);
    expect(clone.fields.votes.votes).toBe(1);
  });
});

describe('move', () => {
  it('preview lists dropped fields; commit re-keys + aliases old key', async () => {
    const key = await makeIssue('MV1-1');
    await makeProject('MV2');

    const dry = await authed(app)
      .post(`/api/internal/issues/${key}/move`)
      .send({ target: { projectKey: 'MV2' }, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body.dryRun).toBe(true);
    expect(dry.body.oldKey).toBe('MV1-1');
    expect(dry.body.newKey).toMatch(/^MV2-/);

    const res = await authed(app)
      .post(`/api/internal/issues/${key}/move`)
      .send({ target: { projectKey: 'MV2' } });
    expect(res.status).toBe(200);
    const newKey = res.body.key;
    expect(newKey).toMatch(/^MV2-/);

    // old key resolves via alias (US3.3)
    const viaOld = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(viaOld.status).toBe(200);
    expect(viaOld.body.key).toBe(newKey);

    const ch = await authed(app).get(`/rest/api/2/issue/${newKey}?expand=changelog`);
    const fields = ch.body.changelog.histories.flatMap((h: { items: { field: string }[] }) => h.items.map((i) => i.field));
    expect(fields).toContain('Key');
    expect(fields).toContain('Project');
  });

  it('rejects a target project outside the token allow-list', async () => {
    const key = await makeIssue('PERM1-1');
    await makeProject('PERM2');
    const { plain, prefix, hash } = generateToken();
    const adminUser = await prisma.user.findFirst({ where: { email: 'admin@test.local' } });
    await prisma.apiToken.create({
      data: { userId: adminUser!.id, name: 'scoped', prefix, hash, scopes: ['read', 'write'], projectKeys: ['PERM1'] },
    });
    const r = await request.agent(app)
      .set('Authorization', `Bearer ${plain}`)
      .post(`/api/internal/issues/${key}/move`)
      .send({ target: { projectKey: 'PERM2' } });
    expect(r.status).toBe(404);
  });
});

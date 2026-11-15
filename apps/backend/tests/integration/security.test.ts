// Sprint 031 (US4) — issue security schemes/levels: shared visibility
// predicate across direct reads, JQL search, board lists, and subtask
// inheritance. 404 existence-hiding for non-members; unsecured = visible to all.
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
  await prisma.apiToken.create({
    data: { userId: user.id, name: email, prefix, hash, scopes: ['read', 'write'], projectKeys: [] },
  });
  return { agent: request.agent(app).set('Authorization', `Bearer ${plain}`), user };
}

async function newProject(key: string) {
  await authed(app).post('/rest/api/2/project').send({ key, name: key }).expect(201);
  return prisma.project.findUniqueOrThrow({ where: { key } });
}

async function newIssue(key: string, summary: string, extra: Record<string, unknown> = {}) {
  const r = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key }, summary, ...extra } })
    .expect(201);
  return r.body.key as string;
}

describe('issue security (031 US4)', () => {
  let member: Awaited<ReturnType<typeof mintToken>>;
  let outsider: Awaited<ReturnType<typeof mintToken>>;
  let schemeId: string;
  let levelId: string;
  let boardId: string;

  beforeEach(async () => {
    await ensureTestAuth();
    member = await mintToken('sec-member@test.local');
    outsider = await mintToken('sec-outsider@test.local');
    await newProject('SEC');
    const boards = await authed(app).get('/rest/agile/1.0/board?projectKeyOrId=SEC').expect(200);
    boardId = boards.body.values[0].id;

    // scheme "Private" with level "Dev only" granting member@ only.
    const s = await authed(app)
      .post('/api/internal/issuesecurityschemes')
      .send({
        name: 'Private',
        levels: [
          // reporter included so the creator retains visibility (Jira applies
          // issue security to everyone, admins included)
          { name: 'Dev only', isDefault: false, members: [{ kind: 'user', ref: member.user.id }, { kind: 'reporter' }] },
        ],
      })
      .expect(201);
    schemeId = s.body.id;
    levelId = s.body.levels[0].id;
    await authed(app)
      .post('/api/internal/projects/SEC/issuesecurityscheme')
      .send({ schemeId })
      .expect(200);
  });

  it('scheme CRUD + Jira read shape', async () => {
    const list = await authed(app).get('/rest/api/2/issuesecurityschemes').expect(200);
    const sch = list.body.issueSecuritySchemes.find((x: { id: string }) => x.id === schemeId);
    expect(sch.levels[0].members[0]).toEqual({ type: 'user', parameter: member.user.id });

    const lvl = await authed(app)
      .post(`/api/internal/issuesecurityschemes/${schemeId}/levels`)
      .send({ name: 'Admins only', members: [] })
      .expect(201);
    await authed(app)
      .put(`/api/internal/issuesecurityschemes/levels/${lvl.body.id}`)
      .send({ name: 'Admins only (renamed)' })
      .expect(200);
    await authed(app).delete(`/api/internal/issuesecurityschemes/levels/${lvl.body.id}`).expect(204);

    // non-admin cannot manage schemes
    await outsider.agent.get('/api/internal/issuesecurityschemes').expect(403);
  });

  it('065 C4 — a comment id cannot be read through a sibling issue URL', async () => {
    const open = await newIssue('SEC', 'open sibling');
    const locked = await newIssue('SEC', 'hidden sibling', { security: { id: levelId } });
    const c = await authed(app).post(`/rest/api/2/issue/${locked}/comment`).send({ body: 'secret' }).expect(201);
    // Same-project sibling URL: the comment lives on `locked`, not `open`.
    await authed(app).get(`/rest/api/2/issue/${open}/comment/${c.body.id}`).expect(404);
    // Outsider through the visible sibling — used to leak the restricted comment.
    await outsider.agent.get(`/rest/api/2/issue/${open}/comment/${c.body.id}`).expect(404);
    // Positive control: the comment still reads on its own issue.
    await authed(app).get(`/rest/api/2/issue/${locked}/comment/${c.body.id}`).expect(200);
  });

  it('fields.security set at create; member sees it, outsider gets 404', async () => {
    const key = await newIssue('SEC', 'locked down', { security: { name: 'Dev only' } });
    const open = await newIssue('SEC', 'open issue');

    const got = await authed(app).get(`/rest/api/2/issue/${key}`).expect(200);
    expect(got.body.fields.security).toEqual({ id: levelId, name: 'Dev only' });

    // level member sees it
    await member.agent.get(`/rest/api/2/issue/${key}`).expect(200);
    // non-member: existence-hidden 404
    const res = await outsider.agent.get(`/rest/api/2/issue/${key}`);
    expect(res.status).toBe(404);
    expect(res.body.errorMessages[0]).toContain('do not have permission');
    // unsecured issue remains visible to everyone
    await outsider.agent.get(`/rest/api/2/issue/${open}`).expect(200);
  });

  it('search totals are computed post-filter', async () => {
    const locked = await newIssue('SEC', 'hidden', { security: { id: levelId } });
    await newIssue('SEC', 'visible one');
    await newIssue('SEC', 'visible two');

    const jql = 'project = SEC ORDER BY created ASC';
    const all = await authed(app).get('/rest/api/2/search').query({ jql }).expect(200);
    expect(all.body.total).toBe(3);
    expect(all.body.issues.map((i: { key: string }) => i.key)).toContain(locked);

    const filtered = await outsider.agent.get('/rest/api/2/search').query({ jql }).expect(200);
    expect(filtered.body.total).toBe(2);
    expect(filtered.body.issues.map((i: { key: string }) => i.key)).not.toContain(locked);
  });

  it('board issue list excludes secured issues for non-members', async () => {
    const locked = await newIssue('SEC', 'board-hidden', { security: { name: 'Dev only' } });
    await newIssue('SEC', 'board-open');

    const all = await authed(app).get(`/rest/agile/1.0/board/${boardId}/issue`).expect(200);
    expect(all.body.issues.map((i: { key: string }) => i.key)).toContain(locked);

    const filtered = await outsider.agent.get(`/rest/agile/1.0/board/${boardId}/issue`).expect(200);
    const keys = filtered.body.issues.map((i: { key: string }) => i.key);
    expect(keys).not.toContain(locked);
    expect(keys.length).toBe(1);
  });

  it('subtask inherits parent security (parent secured → child hidden too)', async () => {
    const parent = await newIssue('SEC', 'secured parent', { security: { name: 'Dev only' } });
    const child = await newIssue('SEC', 'child', {
      issuetype: { name: 'Subtask' },
      parent: { key: parent },
    });
    // child has no own level — visibility is inherited from the parent
    await outsider.agent.get(`/rest/api/2/issue/${child}`).expect(404);
    await member.agent.get(`/rest/api/2/issue/${child}`).expect(200);
    const c = await authed(app).get(`/rest/api/2/issue/${child}`).expect(200);
    expect(c.body.fields.security).toEqual({ id: levelId, name: 'Dev only' });
  });

  it('default level applies on create; PUT clears it', async () => {
    const s2 = await authed(app)
      .post('/api/internal/issuesecurityschemes')
      .send({ name: 'Defaulted', levels: [{ name: 'Restricted', isDefault: true, members: [{ kind: 'reporter' }] }] })
      .expect(201);
    await authed(app)
      .post('/api/internal/projects/SEC/issuesecurityscheme')
      .send({ schemeId: s2.body.id })
      .expect(200);

    const key = await newIssue('SEC', 'defaulted');
    const got = await authed(app).get(`/rest/api/2/issue/${key}`).expect(200);
    expect(got.body.fields.security.name).toBe('Restricted');

    // clearing via PUT restores visibility for everyone
    await authed(app).put(`/rest/api/2/issue/${key}`).send({ fields: { security: null } }).expect(204);
    await outsider.agent.get(`/rest/api/2/issue/${key}`).expect(200);
    const cleared = await authed(app).get(`/rest/api/2/issue/${key}`).expect(200);
    expect(cleared.body.fields.security).toBeUndefined();
  });

  it('reporter member kind grants visibility', async () => {
    const s2 = await authed(app)
      .post('/api/internal/issuesecurityschemes')
      .send({ name: 'ReporterOnly', levels: [{ name: 'Reporter sees', members: [{ kind: 'reporter' }] }] })
      .expect(201);
    await authed(app)
      .post('/api/internal/projects/SEC/issuesecurityscheme')
      .send({ schemeId: s2.body.id })
      .expect(200);

    // outsider creates → outsider is reporter → sees it; member does not
    const r = await outsider.agent
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SEC' }, summary: 'mine', security: { name: 'Reporter sees' } } });
    expect(r.status).toBe(201);
    const key = r.body.key;
    await outsider.agent.get(`/rest/api/2/issue/${key}`).expect(200);
    await member.agent.get(`/rest/api/2/issue/${key}`).expect(404);
  });

  it('comment/worklog visibility restricted to group members', async () => {
    // member joins group 'devs'; outsider does not
    const g = await prisma.group.create({ data: { name: 'devs' } });
    await prisma.groupMember.create({ data: { groupId: g.id, userId: member.user.id } });

    const key = await newIssue('SEC', 'visibility probe');
    const c = await authed(app)
      .post(`/rest/api/2/issue/${key}/comment`)
      .send({ body: 'secret', visibility: { type: 'group', value: 'devs' } })
      .expect(201);
    expect(c.body.visibility).toEqual({ type: 'group', value: 'devs' });
    await authed(app).post(`/rest/api/2/issue/${key}/comment`).send({ body: 'open' }).expect(201);

    // outsider: restricted comment filtered from list + total, 404 on direct GET
    const list = await outsider.agent.get(`/rest/api/2/issue/${key}/comment`).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.comments[0].body).toBe('open');
    await outsider.agent.get(`/rest/api/2/issue/${key}/comment/${c.body.id}`).expect(404);

    // member sees both; author (admin) always sees own
    const m = await member.agent.get(`/rest/api/2/issue/${key}/comment`).expect(200);
    expect(m.body.total).toBe(2);
    const a = await authed(app).get(`/rest/api/2/issue/${key}/comment`).expect(200);
    expect(a.body.total).toBe(2);

    // worklogs — same contract
    const w = await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog`)
      .send({ timeSpent: '1h', visibility: { type: 'group', value: 'devs' } })
      .expect(201);
    await authed(app).post(`/rest/api/2/issue/${key}/worklog`).send({ timeSpent: '30m' }).expect(201);
    const wl = await outsider.agent.get(`/rest/api/2/issue/${key}/worklog`).expect(200);
    expect(wl.body.total).toBe(1);
    await outsider.agent.get(`/rest/api/2/issue/${key}/worklog/${w.body.id}`).expect(404);
    const wlm = await member.agent.get(`/rest/api/2/issue/${key}/worklog`).expect(200);
    expect(wlm.body.total).toBe(2);

    // clearing visibility restores access
    await authed(app)
      .put(`/rest/api/2/issue/${key}/comment/${c.body.id}`)
      .send({ body: 'secret', visibility: null })
      .expect(200);
    const cleared = await outsider.agent.get(`/rest/api/2/issue/${key}/comment`).expect(200);
    expect(cleared.body.total).toBe(2);

    // unknown group rejected
    await authed(app)
      .post(`/rest/api/2/issue/${key}/comment`)
      .send({ body: 'x', visibility: { type: 'group', value: 'nosuch' } })
      .expect(400);
  });

  it('update.security set op + project with no scheme rejects the field', async () => {
    await newProject('PLAIN');
    const plain = await newIssue('PLAIN', 'no scheme');
    const r = await authed(app)
      .put(`/rest/api/2/issue/${plain}`)
      .send({ fields: { security: { name: 'x' } } });
    expect(r.status).toBe(400);
    expect(r.body.errorMessages[0]).toContain('no issue security scheme');

    const key = await newIssue('SEC', 'set op');
    await authed(app)
      .put(`/rest/api/2/issue/${key}`)
      .send({ update: { security: [{ set: { name: 'Dev only' } }] } })
      .expect(204);
    await outsider.agent.get(`/rest/api/2/issue/${key}`).expect(404);
  });
});

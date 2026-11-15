// Sprint 032 slice 1 — function registry + US1 user/linkage/tree functions.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { authed, ensureTestAuth, transitionTo } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';
import { prisma } from '../../src/prisma.js';
import app from '../../src/main.js';

async function mintToken(email: string) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: email, passwordHash: await hashPassword('x-'.repeat(8)) },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes: ['read', 'write'], projectKeys: [] } });
  return { agent: request.agent(app).set('Authorization', `Bearer ${plain}`), user };
}

const jql = (q: string) => encodeURIComponent(q);
const search = (q: string) => authed(app).get(`/rest/api/2/search?jql=${jql(q)}&fields[]=key`);
const keys = (body: { issues: { key: string }[] }) => body.issues.map((i) => i.key).sort();

async function mkIssue(project: string, summary: string, extra: Record<string, unknown> = {}) {
  const r = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: project }, summary, ...extra } });
  if (r.status !== 201) throw new Error(`create ${summary}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.key as string;
}

describe('JQL functions (032 US1)', () => {
  let ada: Awaited<ReturnType<typeof mintToken>>;

  beforeEach(async () => {
    await ensureTestAuth();
    ada = await mintToken('fn-ada@test.local');
    await authed(app).post('/rest/api/2/project').send({ key: 'FN', name: 'Functions' }).expect(201);

    // FN-1 epic ← FN-2 story ← FN-3 subtask; FN-4 bug (linked, ada); FN-5 task
    await mkIssue('FN', 'Epic one', { issuetype: { name: 'Epic' } });
    await mkIssue('FN', 'Story two', { issuetype: { name: 'Story' }, parent: { key: 'FN-1' } });
    await mkIssue('FN', 'Sub three', { issuetype: { name: 'Subtask' }, parent: { key: 'FN-2' } });
    await mkIssue('FN', 'Bug four', { issuetype: { name: 'Bug' }, assignee: { name: 'fn-ada@test.local' } });
    await mkIssue('FN', 'Task five', { issuetype: { name: 'Task' } });
  });

  it('assignee in membersOf("group") expands group membership; unknown group errors', async () => {
    await authed(app).post('/rest/api/2/group').send({ name: 'fn-qa' }).expect(201);
    await authed(app).post('/rest/api/2/group/user?groupname=fn-qa').send({ accountId: ada.user.id }).expect(201);

    const res = await search('assignee in membersOf("fn-qa")').expect(200);
    expect(keys(res.body)).toEqual(['FN-4']);

    const bad = await search('assignee in membersOf("nope")').expect(400);
    expect(JSON.stringify(bad.body)).toContain("nope");
  });

  it('reporter in updatedBy() returns changelog authors; updatedBy(u) filters', async () => {
    // admin edited FN-1 (assign change writes a ChangeHistory row)
    await authed(app)
      .put('/rest/api/2/issue/FN-1')
      .send({ fields: { assignee: { name: 'fn-ada@test.local' } } })
      .expect(204);

    const res = await search('reporter in updatedBy()').expect(200);
    // admin is the reporter of all FN-* and authored a change
    expect(res.body.total).toBeGreaterThanOrEqual(5);

    const me = await authed(app).get('/rest/api/2/myself').expect(200);
    const named = await search(`reporter in updatedBy("${me.body.emailAddress}")`).expect(200);
    expect(named.body.total).toBeGreaterThanOrEqual(5);

    const nobody = await search('reporter in updatedBy("fn-ada@test.local")').expect(200);
    expect(nobody.body.total).toBe(0); // ada authored nothing yet
  });

  it('issue in linkedIssues(key[, type]) resolves both directions', async () => {
    await authed(app)
      .post('/rest/api/2/issueLink')
      .send({ type: { name: 'Blocks' }, outwardIssue: { key: 'FN-4' }, inwardIssue: { key: 'FN-2' } })
      .expect(201);

    const from = await search('issue in linkedIssues(FN-4)').expect(200);
    expect(keys(from.body)).toEqual(['FN-2']);
    const to = await search('issue in linkedIssues(FN-2)').expect(200);
    expect(keys(to.body)).toEqual(['FN-4']);

    const typed = await search('issue in linkedIssues(FN-2, "is blocked by")').expect(200);
    expect(keys(typed.body)).toEqual(['FN-4']);
  });

  it('linkedIssuesOf("Blocks") returns issues joined by the link type', async () => {
    await authed(app)
      .post('/rest/api/2/issueLink')
      .send({ type: { name: 'Blocks' }, outwardIssue: { key: 'FN-4' }, inwardIssue: { key: 'FN-2' } })
      .expect(201);
    await authed(app)
      .post('/rest/api/2/issueLink')
      .send({ type: { name: 'Relates' }, outwardIssue: { key: 'FN-4' }, inwardIssue: { key: 'FN-5' } })
      .expect(201);

    const res = await search('issue in linkedIssuesOf("Blocks")').expect(200);
    expect(keys(res.body)).toEqual(['FN-2', 'FN-4']);
  });

  it('tree pack: subtasksOf / parentsOf / epicsOf / issuesInEpics', async () => {
    const subs = await search('issue in subtasksOf("key = FN-2")').expect(200);
    expect(keys(subs.body)).toEqual(['FN-3']);

    const parents = await search('issue in parentsOf("key = FN-3")').expect(200);
    expect(keys(parents.body)).toEqual(['FN-2']);

    const epics = await search('issue in epicsOf("key = FN-2")').expect(200);
    expect(keys(epics.body)).toEqual(['FN-1']);

    const inEpics = await search('issue in issuesInEpics("key = FN-1")').expect(200);
    expect(keys(inEpics.body)).toEqual(['FN-2']);
  });

  it('hasComments() returns issues with comments', async () => {
    await authed(app).post('/rest/api/2/issue/FN-5/comment').send({ body: 'first' }).expect(201);
    const res = await search('issue in hasComments()').expect(200);
    expect(keys(res.body)).toEqual(['FN-5']);
  });

  it('watchers()/voters() user sets on user fields', async () => {
    await authed(app).post('/rest/api/2/issue/FN-4/votes').expect(204);
    const res = await search('reporter in voters()').expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(5); // admin voted, admin reported all

    await authed(app).post('/rest/api/2/issue/FN-4/watchers').expect(204);
    const w = await search('assignee in watchers()').expect(200);
    expect(keys(w.body)).toEqual(['FN-4']); // admin watches FN-4 and is FN-4's assignee
  });

  it('currentLogin()/lastLogin() resolve as date operands', async () => {
    // admin's login was recorded by ensureTestAuth → non-null instant
    const res = await search('updated <= now() AND updated >= lastLogin()').expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(0); // resolves without error

    const prev = await search('updated >= previousLogin()').expect(200);
    expect(prev.body.total).toBeGreaterThanOrEqual(0);
  });

  it('unknown function and wrong return-type errors are explicit', async () => {
    const bad = await search('assignee in nosuchfn()').expect(400);
    expect(JSON.stringify(bad.body)).toContain('nosuchfn');

    const wrong = await search('assignee in linkedIssues(FN-1)').expect(400);
    expect(JSON.stringify(wrong.body)).toContain('issue');
  });

  it('GET /api/internal/jql/functions exposes the registry (A3)', async () => {
    const res = await authed(app).get('/api/internal/jql/functions').expect(200);
    const names = res.body.functions.map((f: { name: string }) => f.name);
    for (const n of ['membersof', 'updatedby', 'linkedissues', 'subtasksof', 'hascomments', 'currentlogin']) {
      expect(names).toContain(n);
    }
    const mo = res.body.functions.find((f: { name: string }) => f.name === 'membersof');
    expect(mo).toMatchObject({ returns: 'user', args: { min: 1, max: 1 } });
  });
});

describe('JQL history operators (032 US2)', () => {
  beforeEach(async () => {
    await ensureTestAuth();
    await mintToken('fn-ada@test.local');
    await authed(app).post('/rest/api/2/project').send({ key: 'HI', name: 'History' }).expect(201);
    await mkIssue('HI', 'One');
    await mkIssue('HI', 'Two');
    await mkIssue('HI', 'Three');
  });

  it('status WAS matches transitions and the current value', async () => {
    await transitionTo(app, 'HI-1', 'In Progress');

    const was = await search('status WAS "In Progress"').expect(200);
    expect(keys(was.body)).toEqual(['HI-1']); // transitioned there (and still is)

    await transitionTo(app, 'HI-1', 'Done');
    const wasIp = await search('status WAS "In Progress"').expect(200);
    expect(keys(wasIp.body)).toEqual(['HI-1']); // previously had it

    const wasDone = await search('status WAS Done').expect(200);
    expect(keys(wasDone.body)).toEqual(['HI-1']); // current value included

    const wasNot = await search('status WAS NOT Done').expect(200);
    expect(keys(wasNot.body)).toEqual(['HI-2', 'HI-3']);
  });

  it('WAS IN list + WAS with date predicates', async () => {
    await transitionTo(app, 'HI-1', 'In Progress');
    const list = await search('status WAS IN ("Done", "In Progress")').expect(200);
    expect(keys(list.body)).toEqual(['HI-1']);

    const before = await search('status WAS "In Progress" BEFORE now()').expect(200);
    expect(keys(before.body)).toEqual(['HI-1']);

    const future = await search('status WAS "In Progress" BEFORE -1d').expect(200);
    expect(future.body.total).toBe(0); // happened today, not before yesterday
  });

  it('status CHANGED [FROM/TO/BY/DURING]', async () => {
    await transitionTo(app, 'HI-2', 'In Progress');

    const any = await search('status CHANGED').expect(200);
    expect(keys(any.body)).toEqual(['HI-1', 'HI-2', 'HI-3']); // creation writes a status ChangeItem (Jira parity)

    const to = await search('status CHANGED TO "In Progress"').expect(200);
    expect(keys(to.body)).toEqual(['HI-2']);

    const from = await search('status CHANGED FROM "To Do"').expect(200);
    expect(keys(from.body)).toEqual(['HI-2']);

    const during = await search('status CHANGED DURING (-1d, now())').expect(200);
    expect(keys(during.body)).toEqual(['HI-1', 'HI-2', 'HI-3']); // all were created in the window

    const byMe = await search('status CHANGED BY currentUser()').expect(200);
    expect(keys(byMe.body)).toEqual(['HI-1', 'HI-2', 'HI-3']); // admin authored every change incl. creates
  });

  it('assignee CHANGED FROM / TO resolves user operands', async () => {
    const me = await authed(app).get('/rest/api/2/myself').expect(200);
    // HI-1 starts assigned to admin so the FROM side is a real user
    await authed(app)
      .put('/rest/api/2/issue/HI-1')
      .send({ fields: { assignee: { name: me.body.emailAddress } } })
      .expect(204);
    await authed(app)
      .put('/rest/api/2/issue/HI-1')
      .send({ fields: { assignee: { name: 'fn-ada@test.local' } } })
      .expect(204);

    const res = await search(`assignee CHANGED FROM ${me.body.emailAddress} TO "fn-ada@test.local"`).expect(200);
    expect(keys(res.body)).toEqual(['HI-1']);

    const toOnly = await search('assignee CHANGED TO "fn-ada@test.local"').expect(200);
    expect(keys(toOnly.body)).toEqual(['HI-1']);
  });

  it('unsupported field/operator combos and bad predicates error explicitly', async () => {
    const noField = await search('summary WAS "x"').expect(400);
    expect(JSON.stringify(noField.body)).toMatch(/'WAS'.*not supported|not supported.*'WAS'/i);

    const labels = await search('labels CHANGED').expect(400);
    expect(JSON.stringify(labels.body)).toMatch(/not supported/i);

    const fromOnWas = await search('status WAS "Done" FROM "To Do"').expect(400);
    expect(JSON.stringify(fromOnWas.body)).toMatch(/FROM.*not supported/i);
  });
});

describe('JQL field coverage + saved filters (032 US3)', () => {
  let ada: Awaited<ReturnType<typeof mintToken>>;

  beforeEach(async () => {
    await ensureTestAuth();
    ada = await mintToken('cv-ada@test.local');
    await authed(app).post('/rest/api/2/project').send({ key: 'CV', name: 'Coverage' }).expect(201);
    await mkIssue('CV', 'One');
    await mkIssue('CV', 'Two');
    await mkIssue('CV', 'Three');
  });

  it('votes/watches compare against denormalized counts', async () => {
    await authed(app).post('/rest/api/2/issue/CV-1/votes').expect(204);
    await authed(app).post('/rest/api/2/issue/CV-2/watchers').expect(204);
    await authed(app).post('/rest/api/2/issue/CV-2/watchers').send({ accountId: ada.user.id }).expect(204);

    const v = await search('votes > 0').expect(200);
    expect(keys(v.body)).toEqual(['CV-1']);
    const v0 = await search('votes = 0').expect(200);
    expect(keys(v0.body)).toEqual(['CV-2', 'CV-3']);

    const w = await search('watches > 1').expect(200);
    expect(keys(w.body)).toEqual(['CV-2']);
    // every issue auto-watches its reporter → watches = 1 for the un-watched pair
    const w1 = await search('watches = 1').expect(200);
    expect(keys(w1.body)).toEqual(['CV-1', 'CV-3']);
  });

  it('Flagged resolves as an unquoted CF name; security IS NOT EMPTY; category = X', async () => {
    await mkIssue('CV', 'Blocked', { flagged: [{ value: 'Impediment' }] });
    const fl = await search('Flagged = Impediment').expect(200);
    expect(keys(fl.body)).toEqual(['CV-4']);

    // project category
    const cat = await authed(app).post('/api/internal/projectcategories').send({ name: 'Platform' }).expect(201);
    await authed(app).put('/rest/api/2/project/CV').send({ categoryId: cat.body.id }).expect(200);
    const pc = await search('projectCategory = Platform').expect(200);
    expect(pc.body.total).toBeGreaterThanOrEqual(3);
    const pcNone = await search('projectCategory IS EMPTY AND project = CV').expect(200);
    expect(pcNone.body.total).toBe(0);

    // security scheme + level; admin keeps visibility via reporter member
    const s = await authed(app)
      .post('/api/internal/issuesecurityschemes')
      .send({ name: 'Cov', levels: [{ name: 'Dev only', members: [{ kind: 'reporter' }] }] })
      .expect(201);
    await authed(app).post('/api/internal/projects/CV/issuesecurityscheme').send({ schemeId: s.body.id }).expect(200);
    await authed(app).put('/rest/api/2/issue/CV-1').send({ fields: { security: { name: 'Dev only' } } }).expect(204);

    const notEmpty = await search('security IS NOT EMPTY AND project = CV').expect(200);
    expect(keys(notEmpty.body)).toEqual(['CV-1']);
    const lvl = await search('security = "Dev only"').expect(200);
    expect(keys(lvl.body)).toEqual(['CV-1']);
    const empty = await search('security IS EMPTY AND project = CV').expect(200);
    expect(keys(empty.body)).toEqual(['CV-2', 'CV-3', 'CV-4']);
  });

  it('filter = "name" inlines the saved JQL; share scope gates visibility', async () => {
    await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'cv-open', jql: 'project = CV AND issuetype = Task' })
      .expect(201);
    await authed(app).put('/rest/api/2/issue/CV-1').send({ fields: { issuetype: { name: 'Bug' } } }).expect(204);

    const res = await search('filter = "cv-open" AND key >= CV-2').expect(200);
    expect(keys(res.body)).toEqual(['CV-2', 'CV-3']); // Tasks only, CV-1 is a Bug

    // private filter invisible to ada → same not-found error as a missing name
    const denied = await ada.agent.get(`/rest/api/2/search?jql=${jql('filter = "cv-open"')}`).expect(400);
    expect(JSON.stringify(denied.body)).toContain('cv-open');

    // share to ada's group → resolves for her too
    await authed(app).post('/rest/api/2/group').send({ name: 'cv-crew' }).expect(201);
    await authed(app).post('/rest/api/2/group/user?groupname=cv-crew').send({ accountId: ada.user.id }).expect(201);
    const mine = await authed(app).get('/rest/api/2/filter/my').expect(200);
    const fid = mine.body.find((f: { name: string }) => f.name === 'cv-open').id;
    await authed(app)
      .put(`/rest/api/2/filter/${fid}`)
      .send({ sharePermissions: [{ type: 'group', groupname: 'cv-crew' }] })
      .expect(200);
    const ok = await ada.agent.get(`/rest/api/2/search?jql=${jql('filter = "cv-open"')}`).expect(200);
    expect(keys(ok.body)).toEqual(['CV-2', 'CV-3']);
  });

  it('circular filter references are rejected at save and at eval', async () => {
    const a = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'cyc-a', jql: 'project = CV' })
      .expect(201);
    const b = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'cyc-b', jql: 'filter = "cyc-a"' })
      .expect(201);

    // save-time: pointing A at B would close the loop
    const bad = await authed(app)
      .put(`/rest/api/2/filter/${a.body.id}`)
      .send({ jql: 'filter = "cyc-b"' })
      .expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/circular/i);

    // eval-time: force a self-reference past the save guard via direct write
    await prisma.filter.update({ where: { id: a.body.id }, data: { jql: 'filter = "cyc-a"' } });
    const evalErr = await search('filter = "cyc-a"').expect(400);
    expect(JSON.stringify(evalErr.body)).toMatch(/circular/i);
    await prisma.filter.update({ where: { id: b.body.id }, data: { jql: 'project = CV' } });
  });
});

describe('Filter share permissions (032 US4)', () => {
  let ada: Awaited<ReturnType<typeof mintToken>>;

  beforeEach(async () => {
    await ensureTestAuth();
    ada = await mintToken('sp-ada@test.local');
    await authed(app).post('/rest/api/2/project').send({ key: 'SP', name: 'SharePerms' }).expect(201);
    await mkIssue('SP', 'shared one');
  });

  it('POST /filter/{id}/permission adds a group perm; DELETE revokes', async () => {
    const f = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'sp-grp', jql: 'project = SP' })
      .expect(201);
    expect(f.body.sharePermissions).toEqual([]);

    // ada denied while private
    await ada.agent.get(`/rest/api/2/filter/${f.body.id}`).expect(404);

    // owner adds a group permission row via the Jira endpoint
    await authed(app).post('/rest/api/2/group').send({ name: 'sp-crew' }).expect(201);
    await authed(app).post('/rest/api/2/group/user?groupname=sp-crew').send({ accountId: ada.user.id }).expect(201);
    const perm = await authed(app)
      .post(`/rest/api/2/filter/${f.body.id}/permission`)
      .send({ type: 'group', groupname: 'sp-crew' })
      .expect(201);
    expect(perm.body).toMatchObject({ type: 'group', groupname: 'sp-crew' });

    const list = await authed(app).get(`/rest/api/2/filter/${f.body.id}/permission`).expect(200);
    expect(list.body).toHaveLength(1);
    const one = await authed(app)
      .get(`/rest/api/2/filter/${f.body.id}/permission/${perm.body.id}`)
      .expect(200);
    expect(one.body.type).toBe('group');

    // ada can now see it + reference it in JQL
    await ada.agent.get(`/rest/api/2/filter/${f.body.id}`).expect(200);
    const viaJql = await ada.agent
      .get(`/rest/api/2/search?jql=${jql('filter = "sp-grp"')}`)
      .expect(200);
    expect(viaJql.body.total).toBe(1);

    // DELETE revokes
    await authed(app).delete(`/rest/api/2/filter/${f.body.id}/permission/${perm.body.id}`).expect(204);
    await ada.agent.get(`/rest/api/2/filter/${f.body.id}`).expect(404);
  });

  it('project + projectRole + authenticated perm types; invalid perm 400s', async () => {
    const f = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'sp-proj', jql: 'project = SP' })
      .expect(201);

    // project share (by key — resolves to project id)
    const p1 = await authed(app)
      .post(`/rest/api/2/filter/${f.body.id}/permission`)
      .send({ type: 'project', projectKey: 'SP' })
      .expect(201);
    expect(p1.body).toMatchObject({ type: 'project' });
    // ada browses SP → sees it
    await ada.agent.get(`/rest/api/2/filter/${f.body.id}`).expect(200);

    // projectRole share — admin role on SP; admin sees, ada does not
    const roles = await authed(app).get('/rest/api/2/role').expect(200);
    const adminRole = roles.body.find((r: { name: string }) => /admin/i.test(r.name));
    const p2 = await authed(app)
      .post(`/rest/api/2/filter/${f.body.id}/permission`)
      .send({ type: 'projectRole', projectKey: 'SP', roleName: adminRole.name })
      .expect(201);
    expect(p2.body).toMatchObject({ type: 'projectRole', roleId: adminRole.id });

    // invalid perm type 400s
    const bad = await authed(app)
      .post(`/rest/api/2/filter/${f.body.id}/permission`)
      .send({ type: 'bogus' })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('bogus');

    // authenticated → everyone sees
    const f2 = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'sp-auth', jql: 'project = SP', sharePermissions: [{ type: 'authenticated' }] })
      .expect(201);
    await ada.agent.get(`/rest/api/2/filter/${f2.body.id}`).expect(200);
    const got = await ada.agent
      .get(`/rest/api/2/search?jql=${jql('filter = "sp-auth"')}`)
      .expect(200);
    expect(got.body.total).toBe(1);
  });

  it('defaultShareScope GET/PUT; new filters follow the user default', async () => {
    const d0 = await authed(app).get('/rest/api/2/filter/defaultShareScope').expect(200);
    expect(d0.body.scope).toBe('PRIVATE');

    await authed(app).put('/rest/api/2/filter/defaultShareScope').send({ scope: 'GLOBAL' }).expect(200);
    const f = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'sp-def', jql: 'project = SP' })
      .expect(201);
    expect(f.body.sharePermissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'global' })])
    );
    expect(f.body.visibility).toBe('all');
    await ada.agent.get(`/rest/api/2/filter/${f.body.id}`).expect(200);

    await authed(app).put('/rest/api/2/filter/defaultShareScope').send({ scope: 'PRIVATE' }).expect(200);
    const bad = await authed(app)
      .put('/rest/api/2/filter/defaultShareScope')
      .send({ scope: 'bogus' })
      .expect(400);
    expect(bad.body.errorMessages?.[0] ?? '').toMatch(/GLOBAL|PRIVATE/);
  });

  it('PUT sharePermissions replaces the whole row set', async () => {
    const f = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'sp-rep', jql: 'project = SP', sharePermissions: [{ type: 'global' }] })
      .expect(201);
    await ada.agent.get(`/rest/api/2/filter/${f.body.id}`).expect(200);

    const u = await authed(app)
      .put(`/rest/api/2/filter/${f.body.id}`)
      .send({ sharePermissions: [] })
      .expect(200);
    expect(u.body.sharePermissions).toEqual([]);
    await ada.agent.get(`/rest/api/2/filter/${f.body.id}`).expect(404);
  });
});

describe('§10.3 remaining functions + environment/epicLink (032 US5)', () => {
  let ada: Awaited<ReturnType<typeof mintToken>>;

  beforeEach(async () => {
    await ensureTestAuth();
    ada = await mintToken('u5-ada@test.local');
    await authed(app).post('/rest/api/2/project').send({ key: 'U5', name: 'UsFive' }).expect(201);
    // U5-1 epic ← U5-2 story; U5-3 standalone task
    await mkIssue('U5', 'epic', { issuetype: { name: 'Epic' } });
    await mkIssue('U5', 'story', { parent: { key: 'U5-1' }, environment: 'prod-east-1' });
    await mkIssue('U5', 'task', { environment: 'staging west' });
  });

  it('key in commentedBy("user") — issues commented by the user', async () => {
    await ada.agent.post('/rest/api/2/issue/U5-3/comment').send({ body: 'ada was here' }).expect(201);
    const res = await search('key in commentedBy("u5-ada@test.local")').expect(200);
    expect(keys(res.body)).toEqual(['U5-3']);
    const bad = await search('key in commentedBy("ghost-user")').expect(400);
    expect(JSON.stringify(bad.body)).toContain('ghost-user');
  });

  it('component in componentsLeadBy("user") / project in projectsLeadBy("user")', async () => {
    const c = await authed(app)
      .post('/rest/api/2/component')
      .send({ project: 'U5', name: 'AdasPart', leadAccountId: ada.user.id })
      .expect(201);
    expect(c.body.id).toBeTruthy();
    await mkIssue('U5', 'comp issue', { components: [{ name: 'AdasPart' }] });

    const comp = await search('component in componentsLeadBy("u5-ada@test.local")').expect(200);
    expect(keys(comp.body)).toEqual(['U5-4']);

    // projectsLeadBy — set ada as U5's lead
    await authed(app).put('/rest/api/2/project/U5').send({ lead: { accountId: ada.user.id } }).expect(200);
    const proj = await search('project in projectsLeadBy("u5-ada@test.local")').expect(200);
    expect(keys(proj.body)).toEqual(['U5-1', 'U5-2', 'U5-3', 'U5-4']);
  });

  it('environment field: ~ / = / IS EMPTY', async () => {
    const tilde = await search('environment ~ "prod"').expect(200);
    expect(keys(tilde.body)).toEqual(['U5-2']);
    const eq = await search('environment = "staging west"').expect(200);
    expect(keys(eq.body)).toEqual(['U5-3']);
    const empty = await search('environment IS EMPTY AND project = U5').expect(200);
    expect(keys(empty.body)).toEqual(['U5-1']);
  });

  it('epicLink resolves epic parents; quoted "Epic Link" works; non-epic errors', async () => {
    const res = await search('epicLink = U5-1').expect(200);
    expect(keys(res.body)).toEqual(['U5-2']);

    // Jira quoted-name form resolves as the system field
    const quoted = await search('"Epic Link" = U5-1').expect(200);
    expect(keys(quoted.body)).toEqual(['U5-2']);

    const empty = await search('epicLink IS EMPTY AND project = U5').expect(200);
    expect(keys(empty.body)).toEqual(['U5-1', 'U5-3']);

    const notEpic = await search('epicLink = U5-2').expect(400);
    expect(JSON.stringify(notEpic.body)).toMatch(/not an epic/i);
  });
});

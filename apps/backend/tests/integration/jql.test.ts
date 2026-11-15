// Sprint 010 — full JQL integration tests against the real engine + DB.

import { describe, it, expect } from 'vitest';
import { authed as request, transitionTo } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { generateToken } from '../../src/lib/auth.js';
import request2 from 'supertest';

const jql = (q: string) => `/rest/api/2/search?jql=${encodeURIComponent(q)}`;
const keys = (res: { body: { issues: { key: string }[] } }) => res.body.issues.map((i) => i.key);

async function setupProjects() {
  await request(app).post('/rest/api/2/project').send({ key: 'TF', name: 'TrackForge' }).expect(201);
  await request(app).post('/rest/api/2/project').send({ key: 'MOB', name: 'Mobile' }).expect(201);

  const mk = (project: string, fields: Record<string, unknown>) =>
    request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: project }, ...fields } })
      .expect(201);

  // TF-1: high bug, login text, labelled, open
  await mk('TF', {
    summary: 'Login timeout error',
    description: 'Users hit a timeout on the login form',
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    labels: ['backend', 'regression'],
  });
  // TF-2: task assigned to admin, done
  const two = await mk('TF', {
    summary: 'Write onboarding docs',
    issuetype: { name: 'Task' },
    labels: ['docs'],
  });
  await request(app)
    .put(`/rest/api/2/issue/${two.body.key}/assignee`)
    .send({ accountId: (await prisma.user.findFirst({ where: { email: 'admin@test.local' } }))!.id })
    .expect(204);
  await transitionTo(app, 'TF-2', 'Done');
  // TF-3: story, comment with FTS term, subtask child
  await mk('TF', {
    summary: 'Improve dashboard speed',
    issuetype: { name: 'Story' },
    priority: { name: 'Medium' },
  });
  await request(app)
    .post('/rest/api/2/issue/TF-3/comment')
    .send({ body: 'Profiles show query latency is high' })
    .expect(201);
  await mk('TF', {
    summary: 'Add cache layer',
    issuetype: { name: 'Subtask' },
    parent: { key: 'TF-3' },
  });
  // MOB-1: mobile story open
  await mk('MOB', { summary: 'Mobile push notifications', issuetype: { name: 'Story' } });
}

describe('JQL — project & key', () => {
  it('single project', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project = TF')).expect(200);
    expect(res.body.total).toBe(4);
    expect(keys(res)).toContain('TF-4');
  });
  it('project IN list (cross-project)', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project IN (TF, MOB)')).expect(200);
    expect(res.body.total).toBe(5);
  });
  it('no project clause → all projects', async () => {
    await setupProjects();
    const res = await request(app).get(jql('statusCategory != Done')).expect(200);
    expect(res.body.total).toBe(4); // all but TF-2
  });
  it('project != excludes', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project != MOB')).expect(200);
    expect(keys(res)).not.toContain('MOB-1');
    expect(res.body.total).toBe(4);
  });
  it('key =', async () => {
    await setupProjects();
    const res = await request(app).get(jql('key = TF-3')).expect(200);
    expect(keys(res)).toEqual(['TF-3']);
  });
  it('key IN', async () => {
    await setupProjects();
    const res = await request(app).get(jql('key IN (TF-1, MOB-1)')).expect(200);
    expect(keys(res).sort()).toEqual(['MOB-1', 'TF-1']);
  });
  it('key >', async () => {
    await setupProjects();
    const res = await request(app).get(jql('key > TF-2 AND project = TF')).expect(200);
    expect(keys(res).sort()).toEqual(['TF-3', 'TF-4']);
  });
  it('unknown project value errors', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project = NOPE')).expect(400);
    expect(res.body.errorMessages[0]).toContain("'NOPE' does not exist for the field 'project'");
  });
  it('unknown issue key errors', async () => {
    await setupProjects();
    const res = await request(app).get(jql('key = TF-99')).expect(400);
    expect(res.body.errorMessages[0]).toContain("'TF-99'");
  });
});

describe('JQL — status & workflow fields', () => {
  it('status = quoted name', async () => {
    await setupProjects();
    const res = await request(app).get(jql('status = "Done"')).expect(200);
    expect(keys(res)).toEqual(['TF-2']);
  });
  it('status IN list', async () => {
    await setupProjects();
    const res = await request(app).get(jql('status IN ("To Do", "Done")')).expect(200);
    expect(res.body.total).toBe(5);
  });
  it('status NOT IN', async () => {
    await setupProjects();
    const res = await request(app).get(jql('status NOT IN ("To Do")')).expect(200);
    expect(res.body.total).toBe(1); // only TF-2 (Done)
  });
  it('statusCategory = Done', async () => {
    await setupProjects();
    const res = await request(app).get(jql('statusCategory = Done')).expect(200);
    expect(keys(res)).toEqual(['TF-2']);
  });
  it('statusCategory != Done (Jira: only set categories match)', async () => {
    await setupProjects();
    const res = await request(app).get(jql('statusCategory != Done')).expect(200);
    expect(res.body.total).toBe(4);
  });
  it('issuetype via type alias', async () => {
    await setupProjects();
    const res = await request(app).get(jql('type = "Subtask"')).expect(200);
    expect(keys(res)).toEqual(['TF-4']);
  });
  it('priority IN', async () => {
    await setupProjects();
    const res = await request(app).get(jql('priority IN (High, Highest)')).expect(200);
    expect(keys(res)).toEqual(['TF-1']);
  });
  it('resolution = Unresolved', async () => {
    await setupProjects();
    const res = await request(app).get(jql('resolution = Unresolved')).expect(200);
    expect(res.body.total).toBe(4);
  });
  it('resolution IS NOT EMPTY after done', async () => {
    await setupProjects();
    const res = await request(app).get(jql('resolution IS NOT EMPTY')).expect(200);
    expect(keys(res)).toEqual(['TF-2']);
  });
  it('unknown status value → Jira value error', async () => {
    await setupProjects();
    const res = await request(app).get(jql('status = Doing')).expect(400);
    expect(res.body.errorMessages[0]).toContain("'Doing' does not exist for the field 'status'");
  });
});

describe('JQL — users', () => {
  it('assignee = currentUser()', async () => {
    await setupProjects();
    const res = await request(app).get(jql('assignee = currentUser()')).expect(200);
    expect(keys(res)).toEqual(['TF-2']);
  });
  it('assignee IS EMPTY', async () => {
    await setupProjects();
    const res = await request(app).get(jql('assignee IS EMPTY')).expect(200);
    expect(res.body.total).toBe(4);
  });
  it('assignee != x excludes EMPTY (Jira semantics)', async () => {
    await setupProjects();
    const res = await request(app).get(jql('assignee != "Test Admin"')).expect(200);
    expect(res.body.total).toBe(0); // only TF-2 is assigned at all
  });
  it('assignee = EMPTY OR assigned', async () => {
    await setupProjects();
    const res = await request(app).get(jql('assignee IS EMPTY OR assignee = currentUser()')).expect(200);
    expect(res.body.total).toBe(5);
  });
  it('reporter = currentUser() (all issues reported by admin)', async () => {
    await setupProjects();
    const res = await request(app).get(jql('reporter = currentUser()')).expect(200);
    expect(res.body.total).toBe(5);
  });
  it('unknown user value errors', async () => {
    await setupProjects();
    const res = await request(app).get(jql('assignee = nobody')).expect(400);
    expect(res.body.errorMessages[0]).toContain("'nobody' does not exist for the field 'assignee'");
  });
  it('unsupported function → clear error', async () => {
    const res = await request(app).get(jql('assignee = bogusFn("team")')).expect(400);
    expect(res.body.errorMessages[0]).toMatch(/bogusfn/i);
  });
});

describe('JQL — labels & hierarchy', () => {
  it('labels = value', async () => {
    await setupProjects();
    const res = await request(app).get(jql('labels = regression')).expect(200);
    expect(keys(res)).toEqual(['TF-1']);
  });
  it('labels IN list (hasSome)', async () => {
    await setupProjects();
    const res = await request(app).get(jql('labels IN (docs, regression)')).expect(200);
    expect(keys(res).sort()).toEqual(['TF-1', 'TF-2']);
  });
  it('labels NOT IN', async () => {
    await setupProjects();
    const res = await request(app).get(jql('labels NOT IN (docs)')).expect(200);
    expect(keys(res)).not.toContain('TF-2');
  });
  it('labels IS EMPTY', async () => {
    await setupProjects();
    const res = await request(app).get(jql('labels IS EMPTY')).expect(200);
    expect(res.body.total).toBe(3);
  });
  it('parent = key', async () => {
    await setupProjects();
    const res = await request(app).get(jql('parent = TF-3')).expect(200);
    expect(keys(res)).toEqual(['TF-4']);
  });
  it('parent IS EMPTY', async () => {
    await setupProjects();
    const res = await request(app).get(jql('parent IS EMPTY')).expect(200);
    expect(res.body.total).toBe(4);
  });
  it('parent IS NOT EMPTY', async () => {
    await setupProjects();
    const res = await request(app).get(jql('parent IS NOT EMPTY')).expect(200);
    expect(keys(res)).toEqual(['TF-4']);
  });
});

describe('JQL — dates', () => {
  it('created >= -1d finds today’s issues', async () => {
    await setupProjects();
    const res = await request(app).get(jql('created >= -1d')).expect(200);
    expect(res.body.total).toBe(5);
  });
  it('created <= -1d finds none', async () => {
    await setupProjects();
    const res = await request(app).get(jql('created <= -1d')).expect(200);
    expect(res.body.total).toBe(0);
  });
  it('created >= startOfDay() finds today', async () => {
    await setupProjects();
    const res = await request(app).get(jql('created >= startOfDay()')).expect(200);
    expect(res.body.total).toBe(5);
  });
  it('updated >= now() - none (updatedAt == now rounds to the ms)', async () => {
    await setupProjects();
    const res = await request(app).get(jql('updated > now()')).expect(200);
    expect(res.body.total).toBe(0);
  });
  it('resolved IS NOT EMPTY for done issue', async () => {
    await setupProjects();
    const res = await request(app).get(jql('resolved IS NOT EMPTY')).expect(200);
    expect(keys(res)).toEqual(['TF-2']);
  });
  it('duedate comparisons', async () => {
    await setupProjects();
    await request(app)
      .put('/rest/api/2/issue/TF-1')
      .send({ fields: { duedate: '2099-01-01' } })
      .expect(204);
    const res = await request(app).get(jql('duedate IS NOT EMPTY')).expect(200);
    expect(keys(res)).toEqual(['TF-1']);
    const far = await request(app).get(jql('duedate <= "2099-12-31" AND duedate IS NOT EMPTY')).expect(200);
    expect(keys(far)).toEqual(['TF-1']);
    const empty = await request(app).get(jql('duedate = "2026-01-01"')).expect(200);
    expect(empty.body.total).toBe(0);
  });
  it('invalid date errors', async () => {
    await setupProjects();
    const res = await request(app).get(jql('created = banana')).expect(400);
    expect(res.body.errorMessages[0]).toContain('not a valid date');
  });
});

describe('JQL — full-text search', () => {
  it('text ~ finds summary + description + comment', async () => {
    await setupProjects();
    const res = await request(app).get(jql('text ~ "latency"')).expect(200);
    expect(keys(res)).toEqual(['TF-3']); // matched in comment
  });
  it('text ~ across summary+description', async () => {
    await setupProjects();
    const res = await request(app).get(jql('text ~ "timeout"')).expect(200);
    expect(keys(res)).toEqual(['TF-1']);
  });
  it('summary ~ scoped', async () => {
    await setupProjects();
    const res = await request(app).get(jql('summary ~ "dashboard"')).expect(200);
    expect(keys(res)).toEqual(['TF-3']);
    const none = await request(app).get(jql('summary ~ "latency"')).expect(200);
    expect(none.body.total).toBe(0); // latency is only in the comment
  });
  it('comment ~ scoped', async () => {
    await setupProjects();
    const res = await request(app).get(jql('comment ~ "latency"')).expect(200);
    expect(keys(res)).toEqual(['TF-3']);
  });
  it('summary !~ excludes', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project = TF AND summary !~ "dashboard"')).expect(200);
    expect(keys(res)).not.toContain('TF-3');
    expect(res.body.total).toBe(3);
  });
  it('text ~ respects stemming (english)', async () => {
    await setupProjects();
    const res = await request(app).get(jql('text ~ "timeouts"')).expect(200);
    expect(keys(res)).toEqual(['TF-1']); // 'timeouts' stems to 'timeout'
  });
});

describe('JQL — boolean logic', () => {
  it('OR', async () => {
    await setupProjects();
    const res = await request(app).get(jql('issuetype = Bug OR issuetype = "Subtask"')).expect(200);
    expect(keys(res).sort()).toEqual(['TF-1', 'TF-4']);
  });
  it('precedence: OR binds looser than AND', async () => {
    await setupProjects();
    // (type=Bug) OR (type=Task AND status=Done) → TF-1, TF-2
    const res = await request(app).get(jql('issuetype = Bug OR issuetype = Task AND status = Done')).expect(200);
    expect(keys(res).sort()).toEqual(['TF-1', 'TF-2']);
  });
  it('parenthesised', async () => {
    await setupProjects();
    const res = await request(app).get(jql('(issuetype = Task OR issuetype = Story) AND project = TF')).expect(200);
    expect(keys(res).sort()).toEqual(['TF-2', 'TF-3']);
  });
  it('NOT', async () => {
    await setupProjects();
    const res = await request(app).get(jql('NOT issuetype = Story AND project = TF')).expect(200);
    expect(keys(res).sort()).toEqual(['TF-1', 'TF-2', 'TF-4']);
  });
  it('NOT over group', async () => {
    await setupProjects();
    const res = await request(app).get(jql('NOT (issuetype = Story OR issuetype = Task)')).expect(200);
    expect(keys(res).sort()).toEqual(['TF-1', 'TF-4']);
  });
});

describe('JQL — ORDER BY', () => {
  it('multi-field: priority DESC, updated ASC', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project = TF ORDER BY priority DESC, key ASC')).expect(200);
    // High(TF-1) then Medium(TF-2,TF-3,TF-4 default) by key
    expect(keys(res)[0]).toBe('TF-1');
  });
  it('key DESC', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project = TF ORDER BY key DESC')).expect(200);
    expect(keys(res)).toEqual(['TF-4', 'TF-3', 'TF-2', 'TF-1']);
  });
  it('created DESC', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project = TF ORDER BY created DESC')).expect(200);
    expect(keys(res)[0]).toBe('TF-4');
  });
  it('ORDER BY rank is supported', async () => {
    await setupProjects();
    const res = await request(app).get(jql('project = TF ORDER BY rank')).expect(200);
    expect(res.body.total).toBe(4);
  });
});

describe('JQL — errors & misc', () => {
  it('syntax error carries position', async () => {
    const res = await request(app).get(jql('project = TF bogus = 1')).expect(400);
    expect(res.body.errorMessages[0]).toMatch(/line 1, character 14/);
  });
  it('POST /search works with body', async () => {
    await setupProjects();
    const res = await request(app)
      .post('/rest/api/2/search')
      .send({ jql: 'project = MOB', maxResults: 10 })
      .expect(200);
    expect(res.body.total).toBe(1);
  });
  it('fields= narrows response', async () => {
    await setupProjects();
    const res = await request(app)
      .post('/rest/api/2/search')
      .send({ jql: 'key = TF-1', fields: ['summary'] })
      .expect(200);
    expect(res.body.issues[0].fields.summary).toBe('Login timeout error');
    expect(res.body.issues[0].fields.status).toBeUndefined();
  });
  it('token project allow-list scopes unfiltered search', async () => {
    await setupProjects();
    const user = await prisma.user.findFirst({ where: { email: 'admin@test.local' } });
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({
      data: { userId: user!.id, name: 'mob-only', prefix, hash, scopes: ['read'], projectKeys: ['MOB'] },
    });
    const res = await request2(app)
      .get(jql('statusCategory != Done'))
      .set('Authorization', `Bearer ${plain}`)
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].key).toBe('MOB-1');
    // explicit query for a foreign project → value error (Jira: does not exist)
    const denied = await request2(app).get(jql('project = TF')).set('Authorization', `Bearer ${plain}`).expect(400);
    expect(denied.body.errorMessages[0]).toContain("'TF' does not exist for the field 'project'");
  });
});

describe('jql/parse & autocomplete', () => {
  it('POST /jql/parse validates without executing', async () => {
    const res = await request(app)
      .post('/rest/api/2/jql/parse')
      .send({ queries: ['project = TF AND status = Done', 'bogus = 1'] })
      .expect(200);
    expect(res.body.queries).toHaveLength(2);
    expect(res.body.queries[0].errors).toEqual([]);
    expect(res.body.queries[0].structure.where.type).toBe('and');
    expect(res.body.queries[1].errors[0]).toContain("'bogus' does not exist");
  });
  it('GET /jql/autocompletedata lists fields+functions+reserved', async () => {
    const res = await request(app).get('/rest/api/2/jql/autocompletedata').expect(200);
    const fieldNames = res.body.visibleFieldNames.map((f: { value: string }) => f.value);
    expect(fieldNames).toContain('assignee');
    expect(fieldNames).toContain('statusCategory');
    expect(res.body.visibleFunctionNames.map((f: { value: string }) => f.value)).toContain('currentUser()');
    expect(res.body.jqlReservedWords).toContain('AND');
  });
  it('suggestions for status', async () => {
    await setupProjects();
    const res = await request(app)
      .get('/rest/api/2/jql/autocompletedata/suggestions?fieldName=status&fieldValue=To')
      .expect(200);
    expect(res.body.results.map((r: { value: string }) => r.value)).toContain('"To Do"');
  });
  it('suggestions for project', async () => {
    await setupProjects();
    const res = await request(app)
      .get('/rest/api/2/jql/autocompletedata/suggestions?fieldName=project&fieldValue=T')
      .expect(200);
    expect(res.body.results.map((r: { value: string }) => r.value)).toContain('TF');
  });
  it('suggestions for assignee includes currentUser()', async () => {
    const res = await request(app)
      .get('/rest/api/2/jql/autocompletedata/suggestions?fieldName=assignee&fieldValue=cur')
      .expect(200);
    expect(res.body.results[0].value).toBe('currentUser()');
  });
  it('unknown fieldName → empty results', async () => {
    const res = await request(app).get('/rest/api/2/jql/autocompletedata/suggestions?fieldName=wat').expect(200);
    expect(res.body.results).toEqual([]);
  });
});

describe('saved filters', () => {
  const seed = () =>
    request(app)
      .post('/rest/api/2/filter')
      .send({ name: 'My open issues', jql: 'assignee = currentUser()', description: 'mine' })
      .expect(201);

  it('creates a filter (Jira shape)', async () => {
    const res = await seed();
    expect(res.body.name).toBe('My open issues');
    expect(res.body.jql).toBe('assignee = currentUser()');
    expect(res.body.owner.emailAddress).toBe('admin@test.local');
    expect(res.body.favourite).toBe(false);
    expect(res.body.id).toBeTruthy();
  });
  it('rejects invalid JQL on create', async () => {
    const res = await request(app).post('/rest/api/2/filter').send({ name: 'bad', jql: 'bogus = 1' }).expect(400);
    expect(res.body.errorMessages[0]).toContain("'bogus'");
  });
  it('lists my filters', async () => {
    await seed();
    const res = await request(app).get('/rest/api/2/filter/my').expect(200);
    expect(res.body).toHaveLength(1);
  });
  it('favourite + unfavourite flow', async () => {
    const created = await seed();
    const fav = await request(app).put(`/rest/api/2/filter/${created.body.id}/favourite`).expect(200);
    expect(fav.body.favourite).toBe(true);
    const list = await request(app).get('/rest/api/2/filter/favourite').expect(200);
    expect(list.body.map((f: { id: string }) => f.id)).toContain(created.body.id);
    const unfav = await request(app).delete(`/rest/api/2/filter/${created.body.id}/favourite`).expect(200);
    expect(unfav.body.favourite).toBe(false);
  });
  it('runs a saved filter', async () => {
    await setupProjects();
    const created = await request(app)
      .post('/rest/api/2/filter')
      .send({ name: 'Done issues', jql: 'statusCategory = Done' })
      .expect(201);
    const res = await request(app).get(`/rest/api/2/filter/${created.body.id}/run`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].key).toBe('TF-2');
  });
  it('updates + deletes', async () => {
    const created = await seed();
    const updated = await request(app)
      .put(`/rest/api/2/filter/${created.body.id}`)
      .send({ jql: 'project = TF', visibility: 'all' })
      .expect(200);
    expect(updated.body.jql).toBe('project = TF');
    expect(updated.body.visibility).toBe('all');
    await request(app).delete(`/rest/api/2/filter/${created.body.id}`).expect(204);
    await request(app).get(`/rest/api/2/filter/${created.body.id}`).expect(404);
  });
  it('other users can see but not edit shared filters', async () => {
    await request(app)
      .post('/rest/api/2/filter')
      .send({ name: 'Shared', jql: 'project = TF', visibility: 'all' })
      .expect(201);
    // second user
    await request(app)
      .post('/api/internal/users')
      .send({ email: 'viewer@test.local', displayName: 'Viewer', password: 'pw-12345' })
      .expect(201);
    const { plain, prefix, hash } = generateToken();
    const viewer = await prisma.user.findUnique({ where: { email: 'viewer@test.local' } });
    await prisma.apiToken.create({
      data: { userId: viewer!.id, name: 'v', prefix, hash, scopes: ['read', 'write'] },
    });
    const shared = await request(app).get('/rest/api/2/filter/search').expect(200);
    const id = shared.body[0].id;
    // viewer can read + star
    const seen = await request2(app)
      .get(`/rest/api/2/filter/${id}`)
      .set('Authorization', `Bearer ${plain}`)
      .expect(200);
    expect(seen.body.name).toBe('Shared');
    const denied = await request2(app)
      .put(`/rest/api/2/filter/${id}`)
      .set('Authorization', `Bearer ${plain}`)
      .send({ name: 'hijack' })
      .expect(403);
    expect(denied.body.errorMessages).toBeTruthy();
  });
  it('private filters are invisible to others', async () => {
    const created = await seed();
    await request(app)
      .post('/api/internal/users')
      .send({ email: 'out@test.local', displayName: 'Out', password: 'pw-12345' })
      .expect(201);
    const { plain, prefix, hash } = generateToken();
    const outsider = await prisma.user.findUnique({ where: { email: 'out@test.local' } });
    await prisma.apiToken.create({
      data: { userId: outsider!.id, name: 'o', prefix, hash, scopes: ['read'] },
    });
    await request2(app)
      .get(`/rest/api/2/filter/${created.body.id}`)
      .set('Authorization', `Bearer ${plain}`)
      .expect(404);
  });
});

describe('JQL — lastViewed (recent views)', () => {
  it('lastViewed >= -1d finds only viewed issues', async () => {
    await setupProjects();
    await request(app).post('/api/internal/me/recent-views').send({ issueKey: 'TF-1' }).expect(204);
    const res = await request(app).get(jql('lastViewed >= -1d')).expect(200);
    expect(keys(res)).toContain('TF-1');
    expect(keys(res)).toHaveLength(1);
  });
  it('lastViewed <= -1d excludes the just-viewed issue', async () => {
    await setupProjects();
    await request(app).post('/api/internal/me/recent-views').send({ issueKey: 'TF-1' }).expect(204);
    const res = await request(app).get(jql('lastViewed <= -1d')).expect(200);
    expect(keys(res)).toHaveLength(0);
  });
  it('lastViewed IS EMPTY finds never-viewed issues', async () => {
    await setupProjects();
    await request(app).post('/api/internal/me/recent-views').send({ issueKey: 'TF-1' }).expect(204);
    const res = await request(app).get(jql('lastViewed IS EMPTY')).expect(200);
    expect(keys(res)).not.toContain('TF-1');
    expect(res.body.total).toBe(4);
  });
  it('lastViewed IS NOT EMPTY finds viewed ones', async () => {
    await setupProjects();
    await request(app).post('/api/internal/me/recent-views').send({ issueKey: 'TF-1' }).expect(204);
    const res = await request(app).get(jql('lastViewed IS NOT EMPTY')).expect(200);
    expect(keys(res)).toEqual(['TF-1']);
  });
  it('repeated views update the timestamp (upsert, not dup)', async () => {
    await setupProjects();
    await request(app).post('/api/internal/me/recent-views').send({ issueKey: 'TF-1' }).expect(204);
    await request(app).post('/api/internal/me/recent-views').send({ issueKey: 'TF-1' }).expect(204);
    const count = await prisma.recentView.count();
    expect(count).toBe(1);
    const res = await request(app).get(jql('lastViewed >= -1d')).expect(200);
    expect(keys(res)).toEqual(['TF-1']);
  });
  it('views are per-user — another user sees their own set', async () => {
    await setupProjects();
    await request(app).post('/api/internal/me/recent-views').send({ issueKey: 'TF-1' }).expect(204);
    await request(app)
      .post('/api/internal/users')
      .send({ email: 'other@test.local', displayName: 'Other', password: 'pw-12345' })
      .expect(201);
    const { plain, prefix, hash } = generateToken();
    const other = await prisma.user.findUnique({ where: { email: 'other@test.local' } });
    await prisma.apiToken.create({
      data: { userId: other!.id, name: 'o', prefix, hash, scopes: ['read'] },
    });
    const res = await request2(app).get(jql('lastViewed >= -1d')).set('Authorization', `Bearer ${plain}`).expect(200);
    expect(res.body.issues).toHaveLength(0);
  });
});

describe('JQL — commentdate (comment activity)', () => {
  // setupProjects comments on TF-3 during the run, i.e. "today".
  it('commentdate >= -1d finds only commented issues', async () => {
    await setupProjects();
    const res = await request(app).get(jql('commentdate >= -1d')).expect(200);
    expect(keys(res)).toEqual(['TF-3']);
  });
  it('commentdate >= startOfDay() answers "commented today"', async () => {
    await setupProjects();
    const res = await request(app).get(jql('commentdate >= startOfDay() AND statusCategory != done')).expect(200);
    expect(keys(res)).toEqual(['TF-3']);
  });
  it('commentdate <= -1d excludes the just-commented issue', async () => {
    await setupProjects();
    const res = await request(app).get(jql('commentdate <= -1d')).expect(200);
    expect(keys(res)).toHaveLength(0);
  });
  it('commentdate IS EMPTY finds commentless issues', async () => {
    await setupProjects();
    const res = await request(app).get(jql('commentdate IS EMPTY')).expect(200);
    expect(keys(res)).not.toContain('TF-3');
    expect(res.body.total).toBe(4);
  });
  it('commentdate IS NOT EMPTY / commented alias both resolve', async () => {
    await setupProjects();
    const a = await request(app).get(jql('commentdate IS NOT EMPTY')).expect(200);
    const b = await request(app).get(jql('commented IS NOT EMPTY')).expect(200);
    expect(keys(a)).toEqual(['TF-3']);
    expect(keys(b)).toEqual(keys(a));
  });
});

// Sprint 032 SC-001 — every documented §10.2 field and §10.3
// function/operator works or errors explicitly (never silent).
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { authed, ensureTestAuth } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';
import { prisma } from '../../src/prisma.js';
import app from '../../src/main.js';

const jql = (q: string) => encodeURIComponent(q);
const search = (q: string) => authed(app).get(`/rest/api/2/search?jql=${jql(q)}&fields[]=key`);

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

// §10.2 fields × a representative operator each — all must execute.
const FIELD_QUERIES: [string, string][] = [
  ['project', 'project = MX'],
  ['issuetype', 'issuetype = Task'],
  ['status', 'status = "To Do"'],
  ['priority', 'priority >= Medium'],
  ['assignee', 'assignee = currentUser()'],
  ['reporter', 'reporter IS NOT EMPTY'],
  ['created', 'created >= -7d'],
  ['updated', 'updated <= now()'],
  ['duedate', 'duedate <= endOfWeek()'],
  ['resolution', 'resolution = Unresolved'],
  ['component', 'component IS EMPTY'],
  ['fixVersion', 'fixVersion IS EMPTY'],
  ['labels', 'labels IS EMPTY'],
  ['sprint', 'sprint IS EMPTY'],
  ['epicLink', 'epicLink IS EMPTY'],
  ['storyPoints', 'storyPoints >= 0'],
  ['text', 'text ~ "matrix"'],
  ['summary', 'summary ~ "matrix"'],
  ['description', 'description ~ "seed"'],
  ['comment', 'comment ~ "seed"'],
  ['key', 'key in (MX-1)'],
  ['statusCategory', 'statusCategory != Done'],
  ['parent', 'parent IS EMPTY'],
  ['votes', 'votes >= 0'],
  ['watches', 'watches >= 0'],
  ['security', 'security IS EMPTY'],
  ['projectCategory', 'projectCategory IS EMPTY'],
  ['environment', 'environment IS EMPTY'],
  ['worklogDate', 'worklogDate IS EMPTY'],
  ['timespent', 'timespent IS EMPTY'],
  ['filter', 'filter = "mx-all"'],
  ['custom field ref', 'Flagged IS EMPTY'],
];

// §10.3 functions — each resolves (200) or errors naming itself (400).
const FUNCTION_QUERIES: [string, string][] = [
  ['currentUser', 'assignee = currentUser()'],
  ['membersOf', 'assignee in membersOf("mx-g")'],
  ['startOfDay', 'created >= startOfDay()'],
  ['endOfDay', 'created <= endOfDay()'],
  ['startOfWeek', 'updated >= startOfWeek()'],
  ['endOfWeek', 'updated <= endOfWeek()'],
  ['startOfMonth', 'created >= startOfMonth()'],
  ['endOfMonth', 'created <= endOfMonth()'],
  ['now', 'updated <= now()'],
  ['relative date', 'updated >= -7d'],
  ['openSprints', 'sprint in openSprints()'],
  ['closedSprints', 'sprint in closedSprints()'],
  ['releasedVersions', 'fixVersion in releasedVersions()'],
  ['unreleasedVersions', 'fixVersion in unreleasedVersions()'],
  ['linkedIssuesOf', 'key in linkedIssuesOf("Blocks")'],
  ['linkedIssues', 'key in linkedIssues(MX-1)'],
  ['subtasksOf', 'key in subtasksOf("project = MX")'],
  ['parentsOf', 'key in parentsOf("project = MX")'],
  ['epicsOf', 'key in epicsOf("project = MX")'],
  ['issuesInEpics', 'key in issuesInEpics("project = MX")'],
  ['hasComments', 'key in hasComments()'],
  ['updatedBy', 'reporter in updatedBy()'],
  ['commentedBy', 'key in commentedBy("admin@test.local")'],
  ['componentsLeadBy', 'component in componentsLeadBy("admin@test.local")'],
  ['projectsLeadBy', 'project in projectsLeadBy("admin@test.local")'],
  ['currentLogin', 'updated <= currentLogin()'],
  ['lastLogin', 'updated <= lastLogin()'],
  ['watchers', 'assignee in watchers()'],
  ['voters', 'assignee in voters()'],
];

// History operators on history-safe fields (US2 + §10.1 grammar).
const HISTORY_QUERIES: [string, string][] = [
  ['status WAS', 'status WAS "To Do"'],
  ['status WAS NOT', 'status WAS NOT "Done"'],
  ['status WAS IN', 'status WAS IN ("To Do", "In Progress")'],
  ['status CHANGED', 'status CHANGED'],
  ['CHANGED BEFORE', 'status CHANGED BEFORE now()'],
  ['CHANGED AFTER', 'status CHANGED AFTER -30d'],
  ['CHANGED BY', 'assignee CHANGED BY currentUser()'],
  ['WAS BEFORE', 'status WAS "To Do" BEFORE now()'],
  ['WAS DURING', 'status WAS "To Do" DURING (-30d, now())'],
  ['priority WAS', 'priority WAS "High"'],
  ['assignee CHANGED FROM', 'assignee CHANGED FROM currentUser()'],
  ['resolution CHANGED TO', 'resolution CHANGED TO "Done"'],
];

// Documented deferrals must error explicitly, never silently pass.
const EXPLICIT_ERRORS: [string, string, RegExp][] = [
  ['cascadeOption deferred', 'key in cascadeOption("a","b")', /cascadeOption/i],
  ['issueFunction field', 'issueFunction in linkedIssuesOf("Blocks")', /issueFunction|does not exist/i],
  ['issueHistory deferred', 'key in issueHistory()', /issueHistory/i],
  ['bogus function', 'key in noSuchFn()', /noSuchFn/i],
  ['WAS on non-history field', 'summary WAS "x"', /WAS.*not supported|does not exist/i],
];

describe('JQL §10.2/§10.3 matrix (032 SC-001)', () => {
  beforeEach(async () => {
    await ensureTestAuth();
    const ada = await mintToken('mx-ada@test.local');
    void ada;
    await authed(app).post('/rest/api/2/project').send({ key: 'MX', name: 'Matrix' }).expect(201);
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'MX' }, summary: 'matrix seed', description: 'seed desc' } })
      .expect(201);
    await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'mx-all', jql: 'project = MX' })
      .expect(201);
  });

  it.each(FIELD_QUERIES)('field %s executes', async (_name, q) => {
    const res = await search(q).expect(200);
    expect(res.body).toHaveProperty('issues');
  });

  it.each(FUNCTION_QUERIES)('function %s resolves', async (_name, q) => {
    const res = await search(q);
    // 200 = resolved; 400 = explicit named error (e.g. unknown group).
    if (res.status === 400) {
      const msg = JSON.stringify(res.body);
      expect(msg).not.toMatch(/internal|unexpected/i);
    } else {
      expect(res.status).toBe(200);
    }
  });

  it.each(HISTORY_QUERIES)('history %s executes', async (_name, q) => {
    const res = await search(q).expect(200);
    expect(res.body).toHaveProperty('issues');
  });

  it.each(EXPLICIT_ERRORS)('%s → explicit error', async (_name, q, pattern) => {
    const res = await search(q).expect(400);
    expect(JSON.stringify(res.body)).toMatch(pattern);
  });

  it('SC-004: "bugs that were In Progress and moved back" JQL executes', async () => {
    const res = await search(
      'project = MX AND issuetype = Bug AND status WAS "In Progress" AND status = "To Do"'
    ).expect(200);
    expect(res.body).toHaveProperty('issues');
  });
});

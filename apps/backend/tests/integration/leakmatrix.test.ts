// Sprint 031 — security leak matrix: an ineligible user must get
// existence-hiding 404s on EVERY issue-scoped read, and the shared
// visibleIssues predicate must hold across every aggregate surface
// (search, board/backlog, epic children, exports, dashboards, reports).
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

async function newIssue(key: string, summary: string, extra: Record<string, unknown> = {}) {
  const r = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key }, summary, ...extra } })
    .expect(201);
  return r.body.key as string;
}

describe('031 leak matrix — secured issue on every read path', () => {
  let outsider: Awaited<ReturnType<typeof mintToken>>;
  let locked: string;
  let open: string;
  let boardId: string;

  beforeEach(async () => {
    await ensureTestAuth();
    outsider = await mintToken('lk-outsider@test.local');
    await authed(app).post('/rest/api/2/project').send({ key: 'LK', name: 'LK' }).expect(201);
    const boards = await authed(app).get('/rest/agile/1.0/board?projectKeyOrId=LK').expect(200);
    boardId = boards.body.values[0].id;
    // level "Dev only" grants only the reporter — admin-created issues stay
    // visible to their creator; outsider is excluded.
    const s = await authed(app)
      .post('/api/internal/issuesecurityschemes')
      .send({ name: 'LK Private', levels: [{ name: 'Dev only', members: [{ kind: 'reporter' }] }] })
      .expect(201);
    await authed(app).post('/api/internal/projects/LK/issuesecurityscheme').send({ schemeId: s.body.id }).expect(200);
    locked = await newIssue('LK', 'locked', { security: { name: 'Dev only' } });
    open = await newIssue('LK', 'open');
  });

  it('every issue-scoped GET returns 404 to a non-member', async () => {
    const paths = [
      `/rest/api/2/issue/${locked}`,
      `/rest/api/2/issue/${locked}/editmeta`,
      `/rest/api/2/issue/${locked}/children`,
      `/rest/api/2/issue/${locked}/changelog`,
      `/rest/api/2/issue/${locked}/transitions`,
      `/rest/api/2/issue/${locked}/comment`,
      `/rest/api/2/issue/${locked}/watchers`,
      `/rest/api/2/issue/${locked}/votes`,
      `/rest/api/2/issue/${locked}/remotelink`,
      `/rest/api/2/issue/${locked}/worklog`,
      `/rest/agile/1.0/issue/${locked}`,
      `/api/internal/export/issue/${locked}?format=print`,
    ];
    for (const p of paths) {
      const r = await outsider.agent.get(p);
      expect(r.status, `GET ${p} should 404`).toBe(404);
    }
    // sanity: the open issue reads fine
    await outsider.agent.get(`/rest/api/2/issue/${open}`).expect(200);
  });

  it('write ops on the invisible issue are also hidden', async () => {
    await outsider.agent.put(`/rest/api/2/issue/${locked}`).send({ fields: { summary: 'hax' } }).expect(404);
    await outsider.agent.delete(`/rest/api/2/issue/${locked}`).expect(404);
    await outsider.agent.post(`/rest/api/2/issue/${locked}/comment`).send({ body: 'x' }).expect(404);
  });

  it('aggregate surfaces filter the secured issue', async () => {
    // search
    const search = await outsider.agent.get('/rest/api/2/search').query({ jql: 'project = LK' }).expect(200);
    expect(search.body.total).toBe(1);
    expect(search.body.issues[0].key).toBe(open);
    // board list
    const board = await outsider.agent.get(`/rest/agile/1.0/board/${boardId}/issue`).expect(200);
    expect(board.body.issues.map((i: { key: string }) => i.key)).toEqual([open]);
    // backlog (scrum board required — flip the auto-created board)
    await authed(app).put(`/rest/agile/1.0/board/${boardId}/type`).send({ type: 'scrum' }).expect(200);
    const backlog = await outsider.agent.get(`/rest/agile/1.0/board/${boardId}/backlog`).expect(200);
    expect(backlog.body.issues.map((i: { key: string }) => i.key)).toEqual([open]);
    // export CSV — header + exactly one data row
    const csv = await outsider.agent.get('/api/internal/export/issues?jql=project%20%3D%20LK').expect(200);
    expect(csv.text).toContain(open);
    expect(csv.text).not.toContain(locked);
    // print export of the secured issue → 404 (regression: bypassed the scope)
    await outsider.agent.get(`/api/internal/export/issue/${locked}`).expect(404);
  });

  it('epic children list hides secured children; secured epic 404s', async () => {
    const epic = await newIssue('LK', 'visible epic', { issuetype: { name: 'Epic' } });
    const child = await newIssue('LK', 'secured child', { parent: { key: epic }, security: { name: 'Dev only' } });
    const openChild = await newIssue('LK', 'open child', { parent: { key: epic } });
    const list = await outsider.agent.get(`/rest/agile/1.0/epic/${epic}/issue`).expect(200);
    const keys = list.body.issues.map((i: { key: string }) => i.key);
    expect(keys).toContain(openChild);
    expect(keys).not.toContain(child);
    // a secured epic itself → 404 on the epic-children endpoint
    const secEpic = await newIssue('LK', 'secret epic', { issuetype: { name: 'Epic' }, security: { name: 'Dev only' } });
    await outsider.agent.get(`/rest/agile/1.0/epic/${secEpic}/issue`).expect(404);
  });

  it('reports and dashboard gadgets respect the predicate', async () => {
    // pie over the project — outsider sees only the open issue
    const pie = await outsider.agent.get('/api/internal/reports/pie').query({ jql: 'project = LK', statType: 'status' }).expect(200);
    const total = pie.body.groups.reduce((a: number, g: { count: number }) => a + g.count, 0);
    expect(total).toBe(1);
    // project summary open-issue count (locked + open exist; outsider sees 1)
    const sum = await outsider.agent.get('/api/internal/reports/project/LK').expect(200);
    expect(sum.body.openIssues).toBe(1);
    const adminSum = await authed(app).get('/api/internal/reports/project/LK').expect(200);
    expect(adminSum.body.openIssues).toBe(2);
    // dashboard filter-results gadget
    const filter = await authed(app)
      .post('/rest/api/2/filter')
      .send({ name: 'lk-all', jql: 'project = LK', visibility: 'all' })
      .expect(201);
    const dash = await authed(app)
      .post('/rest/api/2/dashboard')
      .send({ name: 'lkdash', sharePermissions: [{ type: 'loggedin' }] })
      .expect(201);
    await authed(app)
      .post(`/rest/api/2/dashboard/${dash.body.id}/gadget`)
      .send({ type: 'filter-results', config: { filterId: filter.body.id } })
      .expect(201);
    const data = await outsider.agent.get(`/api/internal/dashboards/${dash.body.id}/data`).expect(200);
    const gadget = Object.values(data.body.gadgets)[0] as { data: { issues: { key: string }[]; total: number } };
    expect(gadget.data.total).toBe(1);
    expect(gadget.data.issues.map((i: { key: string }) => i.key)).toEqual([open]);
  });

  it('035: issue picker filters secured issues', async () => {
    const res = await outsider.agent.get('/rest/api/2/issue/picker').query({ query: 'LK' }).expect(200);
    const keys = (res.body.issues ?? res.body.sections?.[0]?.issues ?? []).map((i: { key: string }) => i.key);
    expect(keys).toContain(open);
    expect(keys).not.toContain(locked);
  });

  it('035: SSE event visibility check denies secured issues to non-members', async () => {
    const { eventIssueVisible } = await import('../../src/lib/jobs.js');
    const issue = await prisma.issue.findFirstOrThrow({
      where: { project: { key: 'LK' }, summary: 'locked' },
      select: { id: true },
    });
    const ev = { issueId: issue.id } as import('@prisma/client').DomainEvent;
    const outsiderActor = { user: outsider.user, channel: 'ui' as const };
    expect(await eventIssueVisible(ev, outsiderActor)).toBe(false);
    const admin = await prisma.user.findFirstOrThrow({ where: { isAdmin: true } });
    expect(await eventIssueVisible(ev, { user: admin, channel: 'ui' })).toBe(true);
  });
});

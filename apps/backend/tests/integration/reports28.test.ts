// Sprint 028 — general, time & release reports on the 027 framework.
// Distribution (pie/two-dim/workload), trends (created-vs-resolved,
// average-age, resolution-time), time (time-tracking/timesheet),
// release (version), project summary, admin-only org metrics.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth, transitionTo } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';

async function mkIssue(fields: object) {
  const r = await authed(app).post('/rest/api/2/issue').send({ fields }).expect(201);
  return r.body.key as string;
}

async function nonAdminAgent() {
  const email = 'viewer@r28.test';
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: email, passwordHash: await hashPassword('x-'.repeat(8)) },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes: [], projectKeys: [] } });
  return request.agent(app).set('Authorization', `Bearer ${plain}`);
}

describe('reports II (028)', () => {
  let versionId: string;

  let doneKey: string;

  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'R28', name: 'R28' }).expect(201);
    const v = await authed(app).post('/rest/api/2/version')
      .send({ project: 'R28', name: 'v1', releaseDate: '2027-01-01' }).expect(201);
    versionId = v.body.id;
    await mkIssue({ project: { key: 'R28' }, summary: 'open probe' });
    doneKey = await mkIssue({
      project: { key: 'R28' }, summary: 'done probe', fixVersions: [{ id: versionId }],
      timetracking: { originalEstimate: '4h', remainingEstimate: '4h' },
    });
    await transitionTo(app, doneKey, 'Done');
    await authed(app).post(`/rest/api/2/issue/${doneKey}/worklog`).send({ timeSpent: '2h' }).expect(201);
  });

  it('pie + two-dimensional group by system fields within JQL scope', async () => {
    const pie = await authed(app).get('/api/internal/reports/pie?jql=project%20%3D%20R28&statType=status').expect(200);
    expect(pie.body.total).toBe(2);
    const sum = pie.body.groups.reduce((a: number, g: { count: number }) => a + g.count, 0);
    expect(sum).toBe(2);

    const td = await authed(app)
      .get('/api/internal/reports/two-dimensional?jql=project%20%3D%20R28&xstatType=status&ystatType=assignee').expect(200);
    expect(td.body.xLabels.length).toBeGreaterThan(0);
    expect(td.body.yLabels.length).toBeGreaterThan(0);
    const cellSum = Object.values(td.body.cells as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(cellSum).toBe(2);

    // bad stat field → 400, not 500
    await authed(app).get('/api/internal/reports/pie?jql=project%20%3D%20R28&statType=bogus').expect(400);
  });

  it('created-vs-resolved, average-age and resolution-time trends', async () => {
    const cvr = await authed(app).get('/api/internal/reports/created-vs-resolved?jql=project%20%3D%20R28&days=1').expect(200);
    expect(cvr.body.series.length).toBeGreaterThan(0);
    const today = cvr.body.series[cvr.body.series.length - 1];
    expect(today.created).toBe(2);
    expect(today.resolved).toBe(1);
    const cum = await authed(app).get('/api/internal/reports/created-vs-resolved?jql=project%20%3D%20R28&days=1&cumulative=true').expect(200);
    expect(cum.body.cumulative).toBe(true);

    const age = await authed(app).get('/api/internal/reports/average-age?jql=project%20%3D%20R28%20AND%20resolution%20%3D%20Unresolved').expect(200);
    expect(age.body.unresolved).toBe(1); // done issue excluded by the JQL
    const bucketSum = age.body.buckets.reduce((a: number, b: { issues: number }) => a + b.issues, 0);
    expect(bucketSum).toBe(1);

    const rt = await authed(app).get('/api/internal/reports/resolution-time?jql=project%20%3D%20R28').expect(200);
    expect(rt.body.resolved).toBe(1);
    expect(rt.body.groups[0].avgDays).toBeGreaterThanOrEqual(0);
  });

  it('workload lists per-assignee open counts', async () => {
    const w = await authed(app).get('/api/internal/reports/workload?projectKey=R28').expect(200);
    const open = w.body.users.reduce((a: number, u: { openIssues: number }) => a + u.openIssues, 0);
    expect(open).toBe(1); // done issue excluded
  });

  it('time-tracking and timesheet aggregate worklogs + estimates', async () => {
    const tt = await authed(app).get(`/api/internal/reports/time-tracking?versionId=${versionId}`).expect(200);
    expect(tt.body.issues.map((i: { key: string }) => i.key)).toEqual([doneKey]);
    expect(tt.body.totals.originalEstimateSec).toBe(4 * 3600);
    expect(tt.body.totals.timeSpentSec).toBe(2 * 3600);
    expect(tt.body.totals.remainingEstimateSec).toBe(2 * 3600); // 4h − 2h auto-adjust

    const ts = await authed(app).get('/api/internal/reports/timesheet?projectKey=R28').expect(200);
    expect(ts.body.workdaySec).toBe(8 * 3600);
    const total = ts.body.users.reduce((a: number, u: { totalSec: number }) => a + u.totalSec, 0);
    expect(total).toBe(2 * 3600);
    expect(Object.values(ts.body.totalsByDay as Record<string, number>)).toContain(2 * 3600);
  });

  it('version report and project summary', async () => {
    const vr = await authed(app).get(`/api/internal/reports/version/${versionId}`).expect(200);
    expect(vr.body.issues).toBe(1);
    expect(vr.body.doneIssues).toBe(1);
    expect(vr.body.percentDone).toBe(100);
    expect(vr.body).toHaveProperty('forecast');

    const ps = await authed(app).get('/api/internal/reports/project/R28').expect(200);
    expect(ps.body.openIssues).toBe(1);
    expect(ps.body.byStatus.length).toBeGreaterThan(0);
    const trToday = ps.body.createdVsResolved30d[ps.body.createdVsResolved30d.length - 1];
    expect(trToday.created).toBe(2);
    expect(trToday.resolved).toBe(1);
    expect(ps.body.recentActivity.length).toBeGreaterThan(0);
  });

  it('org metrics: admin sees aggregates, non-admin gets 403', async () => {
    const org = await authed(app).get('/api/internal/reports/org').expect(200);
    expect(org.body.totals.issues).toBeGreaterThanOrEqual(2);
    expect(org.body.totals.projects).toBeGreaterThanOrEqual(1);
    expect(org.body.issueGrowth30d).toBeTruthy();
    expect(Array.isArray(org.body.activityByType)).toBe(true);

    const viewer = await nonAdminAgent();
    await viewer.get('/api/internal/reports/org').expect(403);
  });

  it('exports CSV for the new report types', async () => {
    const pie = await authed(app).get('/api/internal/reports/pie?jql=project%20%3D%20R28&statType=status&format=csv').expect(200);
    expect(pie.headers['content-type']).toContain('text/csv');
    expect(pie.text.split('\n')[0]).toContain('status,count');

    const wl = await authed(app).get('/api/internal/reports/workload?projectKey=R28&format=csv').expect(200);
    expect(wl.text.split('\n')[0]).toContain('user,openIssues');
  });
});

// Sprint 027 — report registry, board report listing, CFD, control chart,
// epic report, CSV export. Flow reports derive from the changelog (FR).
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { authed, ensureTestAuth, transitionTo } from '../request.js';

async function mkIssue(fields: object) {
  const r = await authed(app).post('/rest/api/2/issue').send({ fields }).expect(201);
  return r.body.key as string;
}

describe('reports framework (027)', () => {
  let boardId: string;
  let issueKey: string;
  let epicKey: string;
  let childKey: string;

  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'RPT', name: 'RPT' }).expect(201);
    const boards = await authed(app).get('/rest/agile/1.0/board?projectKeyOrId=RPT').expect(200);
    boardId = boards.body.values[0].id;
    issueKey = await mkIssue({ project: { key: 'RPT' }, summary: 'flow probe' });
    epicKey = await mkIssue({ project: { key: 'RPT' }, summary: 'epic probe', issuetype: { name: 'Epic' } });
    childKey = await mkIssue({ project: { key: 'RPT' }, summary: 'epic child', parent: { key: epicKey } });
  });
  it('registry lists all report types with params and formats', async () => {
    const reg = await authed(app).get('/api/internal/reports').expect(200);
    const types = reg.body.reports.map((r: { type: string }) => r.type);
    for (const t of ['sprint', 'epic', 'burndown', 'velocity', 'cfd', 'control']) {
      expect(types).toContain(t);
    }
    expect(reg.body.reports.find((r: { type: string }) => r.type === 'cfd').formats).toContain('csv');
    const jira = await authed(app).get(`/rest/agile/1.0/board/${boardId}/reports`).expect(200);
    expect(jira.body.map((r: { key: string }) => r.key)).toEqual(
      expect.arrayContaining(['burndown', 'velocity', 'cfd', 'control'])
    );
  });

  it('cfd + control rebuild state from the changelog', async () => {
    await transitionTo(app, issueKey, 'In Progress');
    await transitionTo(app, issueKey, 'Done');

    const cfd = await authed(app).get(`/api/internal/reports/cfd/${boardId}?days=1`).expect(200);
    const cols: string[] = cfd.body.columns;
    expect(cols.length).toBeGreaterThan(0);
    const last = cfd.body.series[cfd.body.series.length - 1];
    // Done issues land in the last (done-category) column of the board.
    const doneCol = cols[cols.length - 1];
    expect(last.counts[doneCol]).toBeGreaterThanOrEqual(1);

    const cc = await authed(app).get(`/api/internal/reports/control/${boardId}?days=30`).expect(200);
    const mine = cc.body.issues.find((i: { key: string }) => i.key === issueKey);
    expect(mine).toBeTruthy();
    expect(mine.cycleDays).toBeGreaterThanOrEqual(0);
    expect(cc.body.mean).toBeGreaterThanOrEqual(0);
    expect(cc.body.rolling.length).toBe(cc.body.issues.length);
  });

  it('epic report counts children and reports a forecast object', async () => {
    const r = await authed(app).get(`/api/internal/reports/epic/${epicKey}`).expect(200);
    expect(r.body.total).toBe(1);
    expect(r.body.completed).toBe(0);
    expect(r.body.remainingIssues.map((i: { key: string }) => i.key)).toContain(childKey);
    expect(r.body.forecast).toHaveProperty('sprintsRemaining');

    await transitionTo(app, childKey, 'Done');
    const r2 = await authed(app).get(`/api/internal/reports/epic/${epicKey}`).expect(200);
    expect(r2.body.completed).toBe(1);
    expect(r2.body.percentComplete).toBe(100);
  });

  it('exports CSV for any report type', async () => {
    const res = await authed(app).get(`/api/internal/reports/control/${boardId}?format=csv`).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text.split('\n')[0]).toContain('key,summary,cycleDays');
    const v = await authed(app).get(`/api/internal/reports/board/${boardId}/velocity?format=csv`).expect(200);
    expect(v.text.split('\n')[0]).toContain('sprint,committedPoints');
  });
});

import { describe, it, expect, beforeAll } from 'vitest';

import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { registerBulkHandlers } from '../../src/services/bulkService.js';
import { getDurableRunner } from '../../src/lib/jobs.js';

/** Sprint 023 — bulk operations (plan/execute/retry) + export (csv/print). */

beforeAll(async () => {
  await ensureTestAuth();
  registerBulkHandlers();
});

const flush = () => (getDurableRunner() as { flush(): Promise<void> }).flush();

async function makeProject(key: string) {
  const exists = await prisma.project.findUnique({ where: { key } });
  if (exists) return;
  await authed(app).post('/rest/api/2/project').send({ key, name: key }).expect(201);
}

async function makeIssue(key: string, summary = 'bulk test') {
  await makeProject(key.split('-')[0]);
  const res = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: key.split('-')[0] }, summary } })
    .expect(201);
  return res.body.key as string;
}

async function makeIssues(prefix: string, n: number) {
  const keys: string[] = [];
  for (let i = 1; i <= n; i++) keys.push(await makeIssue(`${prefix}-${i}`, `bulk ${prefix} ${i}`));
  return keys;
}

describe('bulk ops', () => {
  it('edit dryRun returns per-issue plan; execute applies + records results', async () => {
    const keys = await makeIssues('BLK', 3);
    const dry = await authed(app)
      .post('/api/internal/bulk/edit')
      .send({ issueKeys: keys, payload: { fields: { labels: ['triaged'] } }, dryRun: true })
      .expect(200);
    expect(dry.body.total).toBe(3);
    expect(dry.body.plan.every((p: { ok: boolean }) => p.ok)).toBe(true);
    // dry run must not mutate
    const before = await authed(app).get(`/rest/api/2/issue/${keys[0]}`).expect(200);
    expect(before.body.fields.labels).not.toContain('triaged');

    const run = await authed(app)
      .post('/api/internal/bulk/edit')
      .send({ issueKeys: keys, payload: { fields: { labels: ['triaged'] } } })
      .expect(202);
    await flush();
    const job = await authed(app).get(`/api/internal/bulk/job/${run.body.jobId}`).expect(200);
    expect(job.body.status).toBe('done');
    expect(job.body.succeeded).toBe(3);
    const after = await authed(app).get(`/rest/api/2/issue/${keys[0]}`).expect(200);
    expect(after.body.fields.labels).toContain('triaged');
  });

  it('jql selection + comment op + summary event', async () => {
    const keys = await makeIssues('BJQ', 2);
    const run = await authed(app)
      .post('/api/internal/bulk/comment')
      .send({ jql: `project = BJQ`, payload: { body: 'bulk hello' } })
      .expect(202);
    expect(run.body.total).toBeGreaterThanOrEqual(2);
    await flush();
    const job = await authed(app).get(`/api/internal/bulk/job/${run.body.jobId}`).expect(200);
    expect(job.body.succeeded).toBe(run.body.total);
    const comments = await authed(app).get(`/rest/api/2/issue/${keys[0]}/comment`).expect(200);
    expect(JSON.stringify(comments.body)).toContain('bulk hello');
  });

  it('mixed-permission selection fails per item; retry replays failures only', async () => {
    const keys = await makeIssues('BPERM', 2);
    // Second key: delete the issue afterward to force a per-item failure.
    const doomed = keys[1];
    const preview = await authed(app)
      .delete(`/rest/api/2/issue/${doomed}?deleteSubtasks=true&dryRun=true`)
      .expect(200);
    await authed(app)
      .delete(`/rest/api/2/issue/${doomed}?deleteSubtasks=true&confirmToken=${preview.body.confirmToken}`)
      .expect(204);

    const run = await authed(app)
      .post('/api/internal/bulk/comment')
      .send({ issueKeys: keys, payload: { body: 'post-delete' } })
      .expect(202);
    await flush();
    const job = await authed(app).get(`/api/internal/bulk/job/${run.body.jobId}`).expect(200);
    expect(job.body.succeeded).toBe(1);
    expect(job.body.failed).toBe(1);
    const failed = (job.body.results as { key: string; ok: boolean }[]).filter((r) => !r.ok);
    expect(failed[0].key).toBe(doomed);

    // retry → new job with just the failed key; it fails again (still deleted)
    const retry = await authed(app)
      .post(`/api/internal/bulk/job/${run.body.jobId}/retry`)
      .send({})
      .expect(202);
    await flush();
    const rjob = await authed(app).get(`/api/internal/bulk/job/${retry.body.jobId}`).expect(200);
    expect(rjob.body.total).toBe(1);
    expect(rjob.body.failed).toBe(1);
  });

  it('watch + transition ops end-to-end', async () => {
    const keys = await makeIssues('BWT', 2);
    const run = await authed(app)
      .post('/api/internal/bulk/watch')
      .send({ issueKeys: keys })
      .expect(202);
    await flush();
    const job = await authed(app).get(`/api/internal/bulk/job/${run.body.jobId}`).expect(200);
    expect(job.body.succeeded).toBe(2);
    const issue = await authed(app).get(`/rest/api/2/issue/${keys[0]}`).expect(200);
    expect(issue.body.fields.watches.isWatching).toBe(true);

    // find a transition id then bulk-transition
    const transitions = await authed(app).get(`/rest/api/2/issue/${keys[0]}/transitions`).expect(200);
    const tid = transitions.body.transitions[0]?.id;
    const trun = await authed(app)
      .post('/api/internal/bulk/transition')
      .send({ issueKeys: keys, payload: { transitionId: tid }, dryRun: true })
      .expect(200);
    expect(trun.body.plan.every((p: { ok: boolean }) => p.ok)).toBe(true);

    // statusName resolves per issue (wizard path)
    const targetName = transitions.body.transitions[0]?.to?.name;
    const trun2 = await authed(app)
      .post('/api/internal/bulk/transition')
      .send({ issueKeys: keys, payload: { statusName: targetName }, dryRun: true })
      .expect(200);
    expect(trun2.body.plan.every((p: { ok: boolean }) => p.ok)).toBe(true);
    const missing = await authed(app)
      .post('/api/internal/bulk/transition')
      .send({ issueKeys: keys, payload: { statusName: 'NO-SUCH-STATUS' }, dryRun: true })
      .expect(200);
    expect(missing.body.plan.every((p: { ok: boolean }) => !p.ok)).toBe(true);
  });

  it('missing keys fail per item; over-cap rejects', async () => {
    const res = await authed(app)
      .post('/api/internal/bulk/edit')
      .send({ issueKeys: ['NOPE-1'], payload: { fields: {} }, dryRun: true })
      .expect(200);
    expect(res.body.plan[0]).toMatchObject({ key: 'NOPE-1', ok: false });
    const keys = Array.from({ length: 501 }, (_, i) => `X-${i}`);
    await authed(app)
      .post('/api/internal/bulk/edit')
      .send({ issueKeys: keys, payload: { fields: { labels: ['x'] } } })
      .expect(400);
  });
});

describe('export', () => {
  it('CSV export respects JQL + columns + BOM + quoting', async () => {
    await makeIssue('EXP-1', 'comma, "quoted" summary');
    const res = await authed(app)
      .get('/api/internal/export/issues?jql=project%20%3D%20EXP&format=csv&columns=key,summary,status')
      .expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const body: string = res.text;
    expect(body.charCodeAt(0)).toBe(0xfeff); // BOM
    expect(body).toContain('key,summary,status');
    expect(body).toContain('EXP-1');
    expect(body).toContain('"comma, ""quoted"" summary"');
  });

  it('print export renders table + single-issue print page', async () => {
    const key = await makeIssue('EXP-2', 'printable issue');
    const list = await authed(app)
      .get('/api/internal/export/issues?jql=project%20%3D%20EXP&format=print&columns=key,summary')
      .expect(200);
    expect(list.text).toContain('<table');
    expect(list.text).toContain(key);
    const single = await authed(app).get(`/api/internal/export/issue/${key}?format=print`).expect(200);
    expect(single.text).toContain(key);
    expect(single.text).toContain('printable issue');
    expect(single.text).toContain('Description');
  });

  // H3 gate: 500-issue bulk edit through the durable runner — per-item
  // results + counters must stay correct at the documented selection cap.
  it('load: bulk edit across 500 issues completes with per-item results', async () => {
    await makeProject('LOAD');
    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'LOAD' } });
    const [status, issueType, priority] = await Promise.all([
      prisma.status.findFirstOrThrow(),
      prisma.issueType.findFirstOrThrow(),
      prisma.priority.findFirstOrThrow(),
    ]);
    await prisma.issue.createMany({
      data: Array.from({ length: 500 }, (_, i) => ({
        projectId: project.id,
        issueNumber: i + 1,
        summary: `load ${i}`,
        statusId: status.id,
        issueTypeId: issueType.id,
        priorityId: priority.id,
      })),
    });

    const t0 = Date.now();
    const run = await authed(app)
      .post('/api/internal/bulk/edit')
      .send({ jql: 'project = LOAD', payload: { fields: { labels: ['bulk-load'] } } })
      .expect(202);
    await flush();
    // The flush admits the job; 500 sequential writes take a few seconds —
    // poll until terminal rather than racing the runner.
    let job = { body: { status: '', total: 0, done: 0, succeeded: 0, failed: 0, results: [] } };
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      job = await authed(app).get(`/api/internal/bulk/job/${run.body.jobId}`).expect(200);
      if (job.body.status === 'done' || job.body.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(job.body.status).toBe('done');
    expect(job.body.total).toBe(500);
    expect(job.body.done).toBe(500);
    expect(job.body.succeeded).toBe(500);
    expect(job.body.failed).toBe(0);
    expect(job.body.results).toHaveLength(500);
    // Soft perf signal — the durable path should stay well under a minute.
    expect(Date.now() - t0).toBeLessThan(60_000);
    const check = await authed(app).get('/rest/api/2/issue/LOAD-1').expect(200);
    expect(check.body.fields.labels).toContain('bulk-load');
  }, 120_000);
});

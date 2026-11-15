import { describe, it, expect } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed } from '../request.js';

async function seedProject(key = 'WL') {
  return prisma.project.create({ data: { key, name: 'Worklogs' } });
}

async function createIssue(key: string, fields: Record<string, unknown> = {}) {
  return authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key }, summary: 'wl issue', ...fields } });
}

describe('sprint 024 — timetracking on issues', () => {
  it('create/update via fields.timetracking; rejects read-only fields', async () => {
    await seedProject();
    const res = await createIssue('WL', { timetracking: { originalEstimate: '2d', remainingEstimate: '2d' } });
    expect(res.status).toBe(201);
    const tt = res.body.fields.timetracking;
    expect(tt.originalEstimate).toBe('2d');
    expect(tt.originalEstimateSeconds).toBe(57600);

    const upd = await authed(app)
      .put(`/rest/api/2/issue/${res.body.key}`)
      .send({ fields: { timetracking: { remainingEstimate: '1d' } } });
    expect(upd.status).toBe(204);
    const got = await authed(app).get(`/rest/api/2/issue/${res.body.key}`);
    expect(got.body.fields.timetracking.remainingEstimate).toBe('1d');
    expect(got.body.fields.timeestimate).toBe(28800);
    expect(got.body.fields.timeoriginalestimate).toBe(57600);

    // read-only Jira fields rejected
    const bad = await authed(app)
      .put(`/rest/api/2/issue/${res.body.key}`)
      .send({ fields: { timespent: '2h' } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors['fields.timespent']).toMatch(/cannot be set/i);
  });

  it('update ops form (update.timetracking edit)', async () => {
    await seedProject();
    const res = await createIssue('WL');
    const upd = await authed(app)
      .put(`/rest/api/2/issue/${res.body.key}`)
      .send({ update: { timetracking: [{ edit: { originalEstimate: '4h' } }] } });
    expect(upd.status).toBe(204);
    const got = await authed(app).get(`/rest/api/2/issue/${res.body.key}`);
    expect(got.body.fields.timetracking.originalEstimate).toBe('4h');
  });
});

describe('sprint 024 — worklog CRUD', () => {
  it('POST/GET/PUT/DELETE lifecycle with adjustEstimate modes', async () => {
    await seedProject();
    const issue = await createIssue('WL', { timetracking: { originalEstimate: '2d', remainingEstimate: '2d' } });
    const key = issue.body.key;

    // POST — auto (default): remaining 2d − 2h = 1d 6h
    const w = await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog`)
      .send({ timeSpent: '2h', comment: 'first shift', billable: true });
    expect(w.status).toBe(201);
    expect(w.body.timeSpentSeconds).toBe(7200);
    expect(w.body.timeSpent).toBe('2h');
    expect(w.body.billable).toBe(true);

    let got = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(got.body.fields.timetracking.timeSpent).toBe('2h');
    expect(got.body.fields.timetracking.remainingEstimate).toBe('1d 6h');
    expect(got.body.fields.workratio).toBe(13); // 7200/57600 = 12.5 → 13
    expect(got.body.fields.aggregatetimespent).toBe(7200);
    expect(got.body.fields.worklog.total).toBe(1);

    // GET list + single
    const list = await authed(app).get(`/rest/api/2/issue/${key}/worklog`);
    expect(list.body.total).toBe(1);
    expect(list.body.worklogs[0].id).toBe(w.body.id);
    const single = await authed(app).get(`/rest/api/2/issue/${key}/worklog/${w.body.id}`);
    expect(single.body.timeSpentSeconds).toBe(7200);

    // PUT — change to 4h with explicit auto adjust: delta +2h → remaining 1d4h
    const edited = await authed(app)
      .put(`/rest/api/2/issue/${key}/worklog/${w.body.id}?adjustEstimate=auto`)
      .send({ timeSpent: '4h' });
    expect(edited.status).toBe(200);
    got = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(got.body.fields.timetracking.timeSpent).toBe('4h');
    expect(got.body.fields.timetracking.remainingEstimate).toBe('1d 4h');

    // POST with leave — estimate untouched
    const w2 = await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog?adjustEstimate=leave`)
      .send({ timeSpent: '1h' });
    expect(w2.status).toBe(201);
    got = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(got.body.fields.timetracking.remainingEstimate).toBe('1d 4h');
    expect(got.body.fields.timetracking.timeSpent).toBe('5h');

    // POST with new — estimate replaced
    await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog?adjustEstimate=new&newEstimate=3h`)
      .send({ timeSpent: '30m' })
      .expect(201);
    got = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(got.body.fields.timetracking.remainingEstimate).toBe('3h');

    // POST with manual — reduce by 1h
    await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog?adjustEstimate=manual&reduceBy=1h`)
      .send({ timeSpent: '15m' })
      .expect(201);
    got = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(got.body.fields.timetracking.remainingEstimate).toBe('2h');

    // invalid adjustEstimate / missing reduceBy
    await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog?adjustEstimate=bogus`)
      .send({ timeSpent: '1h' })
      .expect(400);
    await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog?adjustEstimate=manual`)
      .send({ timeSpent: '1h' })
      .expect(400);

    // DELETE — auto hands the time back (2h → +4h = 6h remaining)
    const del = await authed(app).delete(`/rest/api/2/issue/${key}/worklog/${w.body.id}`);
    expect(del.status).toBe(204);
    got = await authed(app).get(`/rest/api/2/issue/${key}`);
    expect(got.body.fields.timetracking.remainingEstimate).toBe('6h');

    // changelog shows Worklog items
    const cl = await authed(app).get(`/rest/api/2/issue/${key}/changelog`);
    const fields = cl.body.histories.flatMap((h: { items: { field: string }[] }) => h.items.map((i) => i.field));
    expect(fields).toContain('Worklog');
    expect(fields).toContain('timespent');
  });

  it('dryRun previews without persisting', async () => {
    await seedProject();
    const issue = await createIssue('WL', { timetracking: { remainingEstimate: '1d' } });
    const key = issue.body.key;
    const prev = await authed(app)
      .post(`/rest/api/2/issue/${key}/worklog?dryRun=true`)
      .send({ timeSpent: '2h' });
    expect(prev.status).toBe(200);
    expect(prev.headers['x-trackforge-dryrun']).toBe('true');
    expect(prev.body.resultingEstimates.remainingEstimateSec).toBe(28800 - 7200);
    const list = await authed(app).get(`/rest/api/2/issue/${key}/worklog`);
    expect(list.body.total).toBe(0);
  });

  it('rejects invalid/zero durations and bad started dates', async () => {
    await seedProject();
    const issue = await createIssue('WL');
    const key = issue.body.key;
    await authed(app).post(`/rest/api/2/issue/${key}/worklog`).send({ timeSpent: 'nonsense' }).expect(400);
    await authed(app).post(`/rest/api/2/issue/${key}/worklog`).send({ timeSpent: '0h' }).expect(400);
    await authed(app).post(`/rest/api/2/issue/${key}/worklog`).send({ timeSpentSeconds: 60 }).expect(201); // raw seconds ok
  });

  it('incremental sync: updated / deleted / list', async () => {
    await seedProject();
    const issue = await createIssue('WL');
    const key = issue.body.key;
    const w = await authed(app).post(`/rest/api/2/issue/${key}/worklog`).send({ timeSpent: '1h' }).expect(201);

    const upd = await authed(app).get('/rest/api/2/worklog/updated?since=0');
    expect(upd.body.values.some((v: { worklogId: string }) => v.worklogId === w.body.id)).toBe(true);

    const byIds = await authed(app).post('/rest/api/2/worklog/list').send({ ids: [w.body.id] });
    expect(byIds.body[0].id).toBe(w.body.id);

    await authed(app).delete(`/rest/api/2/issue/${key}/worklog/${w.body.id}`).expect(204);
    const del = await authed(app).get('/rest/api/2/worklog/deleted?since=0');
    expect(del.body.values.some((v: { worklogId: string }) => v.worklogId === w.body.id)).toBe(true);
  });
});

describe('sprint 024 — JQL time fields', () => {
  it('queries timeSpent, estimates, workratio, worklogDate, billable', async () => {
    await seedProject();
    const a = await createIssue('WL', { timetracking: { originalEstimate: '2d', remainingEstimate: '2d' } });
    const b = await createIssue('WL');
    const keyA = a.body.key;
    const keyB = b.body.key;
    await authed(app).post(`/rest/api/2/issue/${keyA}/worklog`).send({ timeSpent: '4h', billable: true }).expect(201);
    await authed(app).post(`/rest/api/2/issue/${keyB}/worklog`).send({ timeSpent: '30m' }).expect(201);

    const search = async (jql: string) => {
      const res = await authed(app).get('/rest/api/2/search').query({ jql });
      expect(res.status).toBe(200);
      return res.body.issues.map((i: { key: string }) => i.key);
    };

    expect(await search('timeSpent >= "2h"')).toEqual([keyA]);
    expect(await search('timeSpent < "1h" AND timeSpent IS NOT EMPTY')).toEqual([keyB]);
    expect(await search('timeSpent IS EMPTY')).not.toContain(keyA);
    expect(await search('originalEstimate = "2d"')).toEqual([keyA]);
    expect(await search('remainingEstimate < "2d"')).toEqual([keyA]); // 2d-4h = 12h
    expect(await search('remainingEstimate IS EMPTY')).toEqual(expect.arrayContaining([keyB]));
    expect(await search('workratio >= 20')).toEqual([keyA]); // 4h/16h*100 = 25
    expect(await search('worklogDate >= -1d')).toEqual(expect.arrayContaining([keyA, keyB]));
    expect(await search('billable = true')).toEqual([keyA]);
    expect(await search('billable = false')).toEqual([keyB]);
    expect(await search('timeSpent IS NOT EMPTY ORDER BY remainingEstimate DESC')).toEqual([keyB, keyA]);
  });
});

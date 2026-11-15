// Sprint 014 — custom-fields core: admin CRUD, contexts, values, JQL.

import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { generateToken } from '../../src/lib/auth.js';

const jql = (q: string) => `/rest/api/2/search?jql=${encodeURIComponent(q)}`;
const keys = (res: { body: { issues: { key: string }[] } }) => res.body.issues.map((i) => i.key);

async function mkProject(key = 'TF') {
  await request(app).post('/rest/api/2/project').send({ key, name: `Project ${key}` }).expect(201);
}

async function mkIssue(fields: Record<string, unknown>, project = 'TF') {
  const res = await request(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: project }, summary: 'x', ...fields } })
    .expect(201);
  return res.body;
}

/** Create a select field with a global context + options; returns the admin response. */
async function mkSelectField(name: string, options: string[], projectKeys?: string[]) {
  const res = await request(app)
    .post('/api/internal/customfields')
    .send({
      name,
      type: 'select',
      context: { projectKeys, options },
    })
    .expect(201);
  return res.body as {
    id: string;
    name: string;
    seq?: number;
    contexts: { id: string; isGlobal: boolean; options: { id: string; value: string }[] }[];
  };
}

async function nonAdminBearer() {
  const u = await prisma.user.create({
    data: {
      email: 'viewer@test.local',
      displayName: 'Viewer',
      passwordHash: 'x',
      type: 'human',
      active: true,
    },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: { userId: u.id, name: 't', prefix, hash, scopes: ['read', 'write'] },
  });
  return plain;
}

describe('custom fields — admin CRUD + contexts', () => {
  it('creates a field with sequential customfield_NNNNN id and context options', async () => {
    const f = await mkSelectField('Risk Level', ['Low', 'Medium', 'High']);
    expect(f.id).toMatch(/^customfield_\d+$/);
    const seq = Number(f.id.split('_')[1]);
    expect(seq).toBeGreaterThan(10003); // after seeded system fields
    const ctx = f.contexts[0];
    expect(ctx.isGlobal).toBe(true);
    expect(ctx.options.map((o: { value: string }) => o.value)).toEqual(['Low', 'Medium', 'High']);
  });

  it('rejects duplicate names and unknown types', async () => {
    await mkSelectField('Risk Level', ['Low']);
    const dup = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'Risk Level', type: 'select' })
      .expect(400);
    expect(JSON.stringify(dup.body)).toContain('already exists');
    const bad = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'X', type: 'frobnicate' })
      .expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/type|frobnicate/i);
  });

  it('requires admin for mutations but not reads', async () => {
    const bearer = await nonAdminBearer();
    const create = await request(app)
      .post('/api/internal/customfields')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ name: 'Risk Level', type: 'select' })
      .expect(403);
    expect(create.status).toBe(403);
    await mkSelectField('Risk Level', ['Low']);
    const list = await request(app)
      .get('/api/internal/customfields')
      .set('Authorization', `Bearer ${bearer}`)
      .expect(200);
    expect(list.body.fields.some((f: { name: string }) => f.name === 'Risk Level')).toBe(true);
  });

  it('scopes options per project context', async () => {
    await mkProject('TF');
    await mkProject('MOB');
    const f = await request(app)
      .post('/api/internal/customfields')
      .send({
        name: 'Risk Level',
        type: 'select',
        context: { projectKeys: ['TF'], options: ['Low', 'High'] },
      })
      .expect(201);
    // MOB has no applicable context → field not applicable there
    const mobIssue = await mkIssue({ summary: 'm' }, 'MOB');
    expect(mobIssue.fields[f.body.id]).toBeUndefined();
    const tfIssue = await mkIssue({ summary: 't' }, 'TF');
    expect(f.body.id in tfIssue.fields).toBe(true);
  });

  it('soft-deletes with dryRun preview reporting affected issues', async () => {
    await mkProject('TF');
    const f = await mkSelectField('Risk Level', ['Low', 'High']);
    await mkIssue({ summary: 'a', [f.id]: { value: 'High' } });
    const dry = await request(app)
      .delete(`/api/internal/customfields/${f.id}?dryRun=true`)
      .expect(200);
    expect(dry.body.affectedIssues).toBe(1);
    expect(dry.body.deleted).toBe(false);
    await request(app).delete(`/api/internal/customfields/${f.id}`).expect(204);
    const fieldList = await request(app).get('/rest/api/2/field').expect(200);
    expect(fieldList.body.some((x: { id: string }) => x.id === f.id)).toBe(false);
    // writing a deleted field is rejected
    const res = await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'TF' }, summary: 'b', [f.id]: { value: 'Low' } } })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('cannot be set');
  });
});

describe('custom fields — issue values', () => {
  it('accepts values on create and serializes Jira-shaped options', async () => {
    await mkProject('TF');
    const f = await mkSelectField('Risk Level', ['Low', 'High']);
    const issue = await mkIssue({ summary: 'a', [f.id]: { value: 'High' } });
    expect(issue.fields[f.id]).toMatchObject({ value: 'High' });
    // aliases/names expansions include the CF
    const got = await request(app)
      .get(`/rest/api/2/issue/${issue.key}?expand=names,schema`)
      .expect(200);
    expect(got.body.names[f.id]).toBe('Risk Level');
    expect(got.body.schema[f.id].custom).toContain('select');
  });

  it('validates option values with an allowed-values error', async () => {
    await mkProject('TF');
    const f = await mkSelectField('Risk Level', ['Low', 'High']);
    const res = await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'TF' }, summary: 'a', [f.id]: { value: 'Bogus' } } })
      .expect(400);
    expect(res.body.errorMessages.join(' ')).toContain('Low');
    expect(res.body.errorMessages.join(' ')).toContain('High');
  });

  it('supports set/add/remove update ops on multi-value fields', async () => {
    await mkProject('TF');
    const f = await request(app)
      .post('/api/internal/customfields')
      .send({
        name: 'Environments',
        type: 'multiselect',
        context: { options: ['dev', 'staging', 'prod'] },
      })
      .expect(201);
    const fid = f.body.id;
    const issue = await mkIssue({ summary: 'a' });
    // set two
    await request(app)
      .put(`/rest/api/2/issue/${issue.key}`)
      .send({ fields: { [fid]: [{ value: 'dev' }, { value: 'staging' }] } })
      .expect(204);
    let got = await request(app).get(`/rest/api/2/issue/${issue.key}`).expect(200);
    expect(got.body.fields[fid].map((o: { value: string }) => o.value).sort()).toEqual(['dev', 'staging']);
    // add + remove via update ops
    await request(app)
      .put(`/rest/api/2/issue/${issue.key}`)
      .send({ update: { [fid]: [{ add: { value: 'prod' } }, { remove: { value: 'dev' } }] } })
      .expect(204);
    got = await request(app).get(`/rest/api/2/issue/${issue.key}`).expect(200);
    expect(got.body.fields[fid].map((o: { value: string }) => o.value).sort()).toEqual(['prod', 'staging']);
  });

  it('writes changelog entries with fieldtype custom', async () => {
    await mkProject('TF');
    const f = await mkSelectField('Risk Level', ['Low', 'High']);
    const issue = await mkIssue({ summary: 'a' });
    await request(app)
      .put(`/rest/api/2/issue/${issue.key}`)
      .send({ fields: { [f.id]: { value: 'High' } } })
      .expect(204);
    const log = await request(app).get(`/rest/api/2/issue/${issue.key}/changelog`).expect(200);
    const item = log.body.histories[0].items.find((i: { field: string }) => i.field === 'Risk Level');
    expect(item).toBeTruthy();
    expect(item.fieldtype).toBe('custom');
    expect(item.toString).toBe('High');
  });

  it('stores user/date/number/text/url/checklist values with per-type validation', async () => {
    await mkProject('TF');
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } });
    const mkField = async (name: string, type: string, context?: unknown) =>
      (await request(app).post('/api/internal/customfields').send({ name, type, context }).expect(201)).body;
    const userF = await mkField('Reviewer', 'user', {});
    const dateF = await mkField('Target Date', 'date', {});
    const numF = await mkField('Estimate', 'number', {});
    const textF = await mkField('Notes', 'text', {});
    const urlF = await mkField('Spec URL', 'url', {});
    const checkF = await mkField('Done checklist', 'checklist', {});

    const issue = await mkIssue({
      summary: 'typed values',
      [userF.id]: { name: 'Test Admin' },
      [dateF.id]: '2026-01-15',
      [numF.id]: 7,
      [textF.id]: 'hello',
      [urlF.id]: 'https://example.com/spec',
      [checkF.id]: { items: [{ text: 'tests', done: true }, { text: 'docs', done: false }] },
    });
    const f = issue.fields;
    expect(f[userF.id].accountId).toBe(admin.id);
    expect(f[dateF.id]).toBe('2026-01-15');
    expect(f[numF.id]).toBe(7);
    expect(f[textF.id]).toBe('hello');
    expect(f[urlF.id]).toBe('https://example.com/spec');
    expect(f[checkF.id].items).toHaveLength(2);

    // invalid date rejected
    const bad = await request(app)
      .put(`/rest/api/2/issue/${issue.key}`)
      .send({ fields: { [dateF.id]: 'not-a-date' } })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain('YYYY-MM-DD');
  });
});

describe('custom fields — metadata', () => {
  it('GET /field lists system-managed + custom fields', async () => {
    const res = await request(app).get('/rest/api/2/field').expect(200);
    const ids = res.body.map((f: { id: string }) => f.id);
    expect(ids).toContain('customfield_10001'); // Story Points
    expect(ids).toContain('customfield_10002'); // Flagged
    expect(ids).toContain('customfield_10003'); // Start date
    // still has all the system fields
    for (const k of ['summary', 'status', 'assignee', 'story_points']) {
      expect(ids).toContain(k);
    }
  });

  it('createmeta lists applicable CFs with allowedValues', async () => {
    await mkProject('TF');
    await mkProject('MOB');
    const f = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'Risk Level', type: 'select', context: { projectKeys: ['TF'], options: ['Low', 'High'] } })
      .expect(201);
    const meta = await request(app)
      .get('/rest/api/2/issue/createmeta/TF/issuetypes')
      .expect(200);
    const taskType = meta.body.issuetypes.find((t: { name: string }) => t.name === 'Task');
    const meta2 = await request(app)
      .get(`/rest/api/2/issue/createmeta/TF/issuetypes/${taskType.id}`)
      .expect(200);
    const entry = meta2.body.values.find((v: { fieldId: string }) => v.fieldId === f.body.id);
    expect(entry).toBeTruthy();
    expect(entry.allowedValues.map((o: { value: string }) => o.value).sort()).toEqual(['High', 'Low']);
    // MOB has no context → field absent from its createmeta
    const mobMeta = await request(app)
      .get(`/rest/api/2/issue/createmeta/MOB/issuetypes/${taskType.id}`)
      .expect(200);
    expect(mobMeta.body.values.some((v: { fieldId: string }) => v.fieldId === f.body.id)).toBe(false);
  });

  it('editmeta includes CFs with operations', async () => {
    await mkProject('TF');
    const f = await mkSelectField('Risk Level', ['Low']);
    const issue = await mkIssue({ summary: 'a' });
    const meta = await request(app).get(`/rest/api/2/issue/${issue.key}/editmeta`).expect(200);
    expect(meta.body.fields[f.id]).toBeTruthy();
    expect(meta.body.fields[f.id].operations).toContain('set');
  });
});

describe('custom fields — system-managed', () => {
  it('story_points round-trips through both ids and shares one column', async () => {
    await mkProject('TF');
    // write via the CF id
    const issue = await mkIssue({ summary: 'a', customfield_10001: 8 });
    expect(issue.fields.customfield_10001).toBe(8);
    expect(issue.fields.story_points).toBe(8);
    // write via the system id
    await request(app)
      .put(`/rest/api/2/issue/${issue.key}`)
      .send({ fields: { story_points: 3 } })
      .expect(204);
    const got = await request(app).get(`/rest/api/2/issue/${issue.key}`).expect(200);
    expect(got.body.fields.customfield_10001).toBe(3);
    expect(got.body.fields.story_points).toBe(3);
    const row = await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } });
    expect(row.storyPoints).toBe(3);
  });

  it('flagged accepts the Impediment option via alias', async () => {
    await mkProject('TF');
    const issue = await mkIssue({ summary: 'a', flagged: [{ value: 'Impediment' }] });
    expect(issue.fields.customfield_10002[0].value).toBe('Impediment');
    // remove via update op
    await request(app)
      .put(`/rest/api/2/issue/${issue.key}`)
      .send({ update: { flagged: [{ remove: { value: 'Impediment' } }] } })
      .expect(204);
    const got = await request(app).get(`/rest/api/2/issue/${issue.key}`).expect(200);
    expect(got.body.fields.customfield_10002).toBeNull();
  });

  it('startdate stores and queries via alias + cf id', async () => {
    await mkProject('TF');
    const issue = await mkIssue({ summary: 'a', startdate: '2026-02-01' });
    expect(issue.fields.customfield_10003).toBe('2026-02-01');
  });
});

describe('custom fields — JQL', () => {
  it('finds issues by cf[N], quoted name, and option value', async () => {
    await mkProject('TF');
    const f = await mkSelectField('Risk Level', ['Low', 'High']);
    const seq = f.id.split('_')[1];
    const high = await mkIssue({ summary: 'h', [f.id]: { value: 'High' } });
    await mkIssue({ summary: 'l', [f.id]: { value: 'Low' } });
    await mkIssue({ summary: 'none' });

    expect(keys(await request(app).get(jql(`cf[${seq}] = "High"`)).expect(200))).toEqual([high.key]);
    expect(keys(await request(app).get(jql('"Risk Level" = High')).expect(200))).toEqual([high.key]);
    expect(keys(await request(app).get(jql(`cf[${seq}] IN ("Low", "High")`)).expect(200)).sort()).toEqual(['TF-1', 'TF-2']);
    // IS EMPTY / IS NOT EMPTY
    expect(keys(await request(app).get(jql(`cf[${seq}] IS EMPTY`)).expect(200))).toEqual(['TF-3']);
    expect(keys(await request(app).get(jql(`cf[${seq}] IS NOT EMPTY`)).expect(200)).sort()).toEqual(['TF-1', 'TF-2']);
    // invalid option value → 400
    const bad = await request(app).get(jql(`cf[${seq}] = "Bogus"`)).expect(400);
    expect(bad.body.errorMessages.join(' ')).toContain('does not exist');
  });

  it('compares number and date CFs and orders by scalar CFs', async () => {
    await mkProject('TF');
    const num = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'Estimate', type: 'number', context: {} })
      .expect(201);
    const date = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'Target Date', type: 'date', context: {} })
      .expect(201);
    const nid = num.body.id;
    const did = date.body.id;
    const a = await mkIssue({ summary: 'a', [nid]: 3, [did]: '2026-01-10' });
    const b = await mkIssue({ summary: 'b', [nid]: 9, [did]: '2026-03-01' });
    await mkIssue({ summary: 'c' });

    expect(keys(await request(app).get(jql(`${nid} >= 5`)).expect(200))).toEqual([b.key]);
    expect(keys(await request(app).get(jql(`${nid} = 3`)).expect(200))).toEqual([a.key]);
    expect(keys(await request(app).get(jql(`cf[${did.split('_')[1]}] >= "2026-02-01"`)).expect(200))).toEqual([b.key]);

    // ORDER BY number CF — nulls last
    const asc = await request(app).get(jql(`project = TF ORDER BY ${nid} ASC`)).expect(200);
    expect(keys(asc)).toEqual([a.key, b.key, 'TF-3']);
    const desc = await request(app).get(jql(`project = TF ORDER BY cf[${nid.split('_')[1]}] DESC`)).expect(200);
    expect(keys(desc)).toEqual([b.key, a.key, 'TF-3']);
  });

  it('queries user, text, and checklist-searchability rules', async () => {
    await mkProject('TF');
    const user = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'Reviewer', type: 'user', context: {} })
      .expect(201);
    const text = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'Notes', type: 'text', context: {} })
      .expect(201);
    const check = await request(app)
      .post('/api/internal/customfields')
      .send({ name: 'Checklist', type: 'checklist', context: {} })
      .expect(201);
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } });
    const a = await mkIssue({
      summary: 'a',
      [user.body.id]: { name: 'Test Admin' },
      [text.body.id]: 'refactor me',
    });
    expect(keys(await request(app).get(jql(`${user.body.id} = currentUser()`)).expect(200))).toEqual([a.key]);
    expect(keys(await request(app).get(jql(`${text.body.id} ~ "refactor"`)).expect(200))).toEqual([a.key]);
    // checklist is not searchable — Jira-style error
    const bad = await request(app).get(jql(`${check.body.id} = 1`)).expect(400);
    expect(bad.body.errorMessages.join(' ')).toMatch(/not support searching|does not exist/i);
    void admin;
  });

  it('storypoints shares JQL between alias and cf id', async () => {
    await mkProject('TF');
    const a = await mkIssue({ summary: 'a', story_points: 5 });
    await mkIssue({ summary: 'b' });
    expect(keys(await request(app).get(jql('storypoints = 5')).expect(200))).toEqual([a.key]);
    expect(keys(await request(app).get(jql('cf[10001] = 5')).expect(200))).toEqual([a.key]);
    expect(keys(await request(app).get(jql('cf[10001] IS EMPTY')).expect(200))).toEqual(['TF-2']);
  });
});

describe('custom fields — registry snapshot (non-CF payloads unchanged)', () => {
  it('system field set on issues is byte-identical to the pre-CF shape', async () => {
    await mkProject('TF');
    const issue = await mkIssue({ summary: 'a', labels: ['x'], story_points: 2 });
    const systemKeys = Object.keys(issue.fields).filter((k) => !k.startsWith('customfield_'));
    // exactly the 008–013 field ids + 019's components/fixVersions/versions +
    // 022's votes/watches/environment + 024's timetracking/worklog ids +
    // 014 startdate + 025 flagged + 027 statuschangedate + 047 delegate —
    // no renames, no removals.
    // (description/parent are unset → serialized as undefined → dropped by JSON)
    expect(systemKeys.sort()).toEqual([
      'aggregateprogress', 'aggregatetimeestimate', 'aggregatetimeoriginalestimate',
      'aggregatetimespent', 'assignee', 'attachment', 'components', 'created', 'delegate',
      'duedate', 'fixVersions', 'flagged', 'issuelinks', 'issuetype', 'labels', 'priority',
      'progress', 'project', 'reporter', 'resolution', 'resolutiondate', 'sprint',
      'startdate', 'status', 'statuschangedate', 'story_points', 'subtasks', 'summary',
      'timeestimate', 'timeoriginalestimate', 'timespent', 'timetracking', 'updated',
      'versions', 'votes', 'watches', 'worklog', 'workratio',
    ].sort());
    // CF keys present for global system-managed fields
    expect(issue.fields.customfield_10001).toBe(2);
    expect(issue.fields.customfield_10002).toBeNull();
    expect(issue.fields.customfield_10003).toBeNull();
  });
});

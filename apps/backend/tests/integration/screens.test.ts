// Sprint 031 (US1) — screens, tabs, screen schemes, issue-type screen
// schemes: createmeta/editmeta filtering + Jira "cannot be set" write
// enforcement. Projects without a bound ITSS are fully unrestricted
// (pre-sprint behaviour, SC).
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';

const CORE = ['summary', 'description', 'issuetype', 'priority', 'assignee', 'labels'];

describe('screens & screen schemes (031 US1)', () => {
  let screenId: string;
  let schemeId: string;
  let itssId: string;
  let bugTypeId: string;

  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'SCR', name: 'SCR' }).expect(201);
    const bug = await prisma.issueType.findUniqueOrThrow({ where: { name: 'Bug' } });
    bugTypeId = bug.id;

    const s = await authed(app)
      .post('/api/internal/screens')
      .send({ name: 'Default Screen', tabs: [{ name: 'Main', fields: CORE }] })
      .expect(201);
    screenId = s.body.id;
    const ss = await authed(app)
      .post('/api/internal/screenschemes')
      .send({
        name: 'Default Scheme',
        items: [
          { operation: 'default', screenId },
          { operation: 'create', screenId },
        ],
      })
      .expect(201);
    schemeId = ss.body.id;
    const itss = await authed(app)
      .post('/api/internal/issuetypescreenschemes')
      .send({ name: 'SCR Scheme', defaultSchemeId: schemeId })
      .expect(201);
    itssId = itss.body.id;
    await authed(app)
      .post('/api/internal/projects/SCR/issuetypescreenscheme')
      .send({ schemeId: itssId })
      .expect(200);
  });

  it('screen + scheme CRUD and Jira read shape', async () => {
    const list = await authed(app).get('/rest/api/2/screens').expect(200);
    const scr = list.body.find((x: { id: string }) => x.id === screenId);
    expect(scr.tabs[0].fields).toEqual(CORE);

    // tabs editable
    await authed(app)
      .put(`/api/internal/screens/${screenId}/tabs`)
      .send({ tabs: [{ name: 'A', fields: ['summary'] }, { name: 'B', fields: ['description'] }] })
      .expect(200);
    const tabs = await authed(app).get(`/rest/api/2/screens/${screenId}/tabs`).expect(200);
    expect(tabs.body.map((t: { name: string }) => t.name)).toEqual(['A', 'B']);

    // in-use guards
    await authed(app).delete(`/api/internal/screens/${screenId}`).expect(400);
    await authed(app).delete(`/api/internal/screenschemes/${schemeId}`).expect(400);
    await authed(app).delete(`/api/internal/issuetypescreenschemes/${itssId}`).expect(400);
  });

  it('createmeta lists only on-screen fields once ITSS bound', async () => {
    const meta = await authed(app)
      .get(`/rest/api/2/issue/createmeta/SCR/issuetypes/${bugTypeId}`)
      .expect(200);
    const keys = meta.body.values.map((v: { fieldId: string }) => v.fieldId);
    expect(keys).toEqual(expect.arrayContaining(['summary', 'description', 'priority', 'assignee', 'labels']));
    expect(keys).not.toContain('environment');
    expect(keys).not.toContain('duedate');
    expect(keys).not.toContain('security');
  });

  it('writes to off-screen fields get the Jira cannot-be-set error', async () => {
    const r = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SCR' }, summary: 'x', environment: 'prod' } });
    expect(r.status).toBe(400);
    expect(r.body.errors.environment).toContain('cannot be set');

    // on-screen fields still work
    const ok = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SCR' }, summary: 'x', description: 'd', labels: ['a'] } });
    expect(ok.status).toBe(201);

    // edit path: off-screen field rejected on PUT
    const key = ok.body.key;
    const e = await authed(app)
      .put(`/rest/api/2/issue/${key}`)
      .send({ fields: { environment: 'prod' } });
    expect(e.status).toBe(400);
    expect(e.body.errors.environment).toContain('cannot be set');
    await authed(app).put(`/rest/api/2/issue/${key}`).send({ fields: { description: 'ok' } }).expect(204);

    // editmeta reflects the screen
    const meta = await authed(app).get(`/rest/api/2/issue/${key}/editmeta`).expect(200);
    expect(Object.keys(meta.body.fields)).not.toContain('environment');
  });

  it('per-type mapping: Bug and Task can resolve different screens', async () => {
    // second screen/scheme restricted to summary only
    const s2 = await authed(app)
      .post('/api/internal/screens')
      .send({ name: 'Minimal', tabs: [{ name: 'M', fields: ['summary'] }] })
      .expect(201);
    const ss2 = await authed(app)
      .post('/api/internal/screenschemes')
      .send({ name: 'Minimal Scheme', items: [{ operation: 'create', screenId: s2.body.id }] })
      .expect(201);
    await authed(app)
      .put(`/api/internal/issuetypescreenschemes/${itssId}`)
      .send({ mappings: [{ issueTypeId: bugTypeId, screenSchemeId: ss2.body.id }] })
      .expect(200);

    // Bug resolves to minimal screen → description rejected
    const r = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SCR' }, summary: 'bug', issuetype: { name: 'Bug' }, description: 'd' } });
    expect(r.status).toBe(400);

    // Task uses default scheme → description allowed
    const task = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SCR' }, summary: 'task', issuetype: { name: 'Task' }, description: 'd' } });
    expect(task.status).toBe(201);
  });

  it('unbound project stays fully unrestricted (pre-sprint behaviour)', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'FREE', name: 'FREE' }).expect(201);
    const r = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FREE' }, summary: 'x', environment: 'prod', labels: ['a'] } });
    expect(r.status).toBe(201);
  });
});

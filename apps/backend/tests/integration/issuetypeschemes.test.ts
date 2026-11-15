// Sprint 031 (US3) — issue type schemes: a bound scheme restricts which
// issue types a project offers (createmeta) and accepts (create write).
// Unbound projects offer every type (pre-031 default).
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';

describe('issue type schemes (031 US3)', () => {
  let schemeId: string;
  let bugId: string;
  let taskId: string;
  let subtaskId: string;

  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'IT', name: 'IT' }).expect(201);
    bugId = (await prisma.issueType.findUniqueOrThrow({ where: { name: 'Bug' } })).id;
    taskId = (await prisma.issueType.findUniqueOrThrow({ where: { name: 'Task' } })).id;
    subtaskId = (await prisma.issueType.findUniqueOrThrow({ where: { name: 'Subtask' } })).id;
    const r = await authed(app)
      .post('/api/internal/issuetypeschemes')
      .send({ name: 'Bugs only', issueTypeIds: [bugId, subtaskId] })
      .expect(201);
    schemeId = r.body.id;
  });

  it('scheme CRUD + in-use guard', async () => {
    const list = await authed(app).get('/api/internal/issuetypeschemes').expect(200);
    const s = list.body.find((x: { id: string }) => x.id === schemeId);
    expect(s.issueTypeIds).toEqual([bugId, subtaskId]);
    // bind → delete guard fires
    await authed(app)
      .post('/api/internal/projects/IT/issuetypescheme')
      .send({ schemeId })
      .expect(200);
    await authed(app).delete(`/api/internal/issuetypeschemes/${schemeId}`).expect(400);
    // update replaces the type set
    await authed(app)
      .put(`/api/internal/issuetypeschemes/${schemeId}`)
      .send({ issueTypeIds: [bugId] })
      .expect(200);
    const after = await authed(app).get('/api/internal/issuetypeschemes').expect(200);
    expect(after.body.find((x: { id: string }) => x.id === schemeId).issueTypeIds).toEqual([bugId]);
  });

  it('createmeta lists only scheme types; issuetype allowedValues filtered', async () => {
    await authed(app)
      .post('/api/internal/projects/IT/issuetypescheme')
      .send({ schemeId })
      .expect(200);
    const meta = await authed(app).get('/rest/api/2/issue/createmeta/IT/issuetypes').expect(200);
    const names = meta.body.issuetypes.map((t: { name: string }) => t.name);
    expect(names).toContain('Bug');
    expect(names).toContain('Subtask');
    expect(names).not.toContain('Task');
    // per-type createmeta → allowedValues on issuetype also filtered
    const fields = await authed(app)
      .get(`/rest/api/2/issue/createmeta/IT/issuetypes/${bugId}`)
      .expect(200);
    const it = fields.body.values.find((v: { fieldId: string }) => v.fieldId === 'issuetype');
    expect(it.allowedValues.map((t: { name: string }) => t.name)).not.toContain('Task');
    // out-of-scheme type id → 404 on its createmeta
    await authed(app).get(`/rest/api/2/issue/createmeta/IT/issuetypes/${taskId}`).expect(404);
  });

  it('create rejects types outside the scheme; allows scheme types', async () => {
    await authed(app)
      .post('/api/internal/projects/IT/issuetypescheme')
      .send({ schemeId })
      .expect(200);
    const bad = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'IT' }, summary: 'x', issuetype: { name: 'Task' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.issuetype).toContain('invalid');
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'IT' }, summary: 'x', issuetype: { name: 'Bug' } } })
      .expect(201);
  });

  it('unbound project offers and accepts all types', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'UU', name: 'UU' }).expect(201);
    const meta = await authed(app).get('/rest/api/2/issue/createmeta/UU/issuetypes').expect(200);
    const names = meta.body.issuetypes.map((t: { name: string }) => t.name);
    expect(names).toContain('Task');
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'UU' }, summary: 'x', issuetype: { name: 'Task' } } })
      .expect(201);
  });
});

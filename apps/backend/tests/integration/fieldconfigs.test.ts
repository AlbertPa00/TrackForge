// Sprint 031 (US2) — field configurations & schemes: required/hidden/
// description/defaultValue + conditional rules (required-if, hidden-if,
// default-by-context). Scheme-bound projects only; unbound = unrestricted.
// NOTE: createmeta lists registry fields only — enforcement also covers
// non-registry writable columns (environment/security) on the write path.
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';

describe('field configurations (031 US2)', () => {
  let configId: string;
  let schemeId: string;
  let bugTypeId: string;

  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'FC', name: 'FC' }).expect(201);
    bugTypeId = (await prisma.issueType.findUniqueOrThrow({ where: { name: 'Bug' } })).id;
    const c = await authed(app)
      .post('/api/internal/fieldconfigurations')
      .send({
        name: 'Strict',
        items: [
          { fieldId: 'duedate', required: true },
          { fieldId: 'components', hidden: true },
          { fieldId: 'security', hidden: true },
          { fieldId: 'labels', defaultValue: ['triage'] },
          { fieldId: 'priority', description: 'How urgent is it?' },
          {
            fieldId: 'environment',
            rules: [{ when: { field: 'priority', is: 'Highest' }, required: true }],
          },
        ],
      })
      .expect(201);
    configId = c.body.id;
    const s = await authed(app)
      .post('/api/internal/fieldconfigurationschemes')
      .send({ name: 'FC Scheme', defaultConfigId: configId })
      .expect(201);
    schemeId = s.body.id;
    await authed(app)
      .post('/api/internal/projects/FC/fieldconfigurationscheme')
      .send({ schemeId })
      .expect(200);
  });

  it('scheme CRUD + Jira read shape + in-use guard', async () => {
    const list = await authed(app).get('/rest/api/2/fieldconfigurations').expect(200);
    const cfg = list.body.find((x: { id: string }) => x.id === configId);
    expect(cfg.items.length).toBe(6);
    await authed(app).delete(`/api/internal/fieldconfigurations/${configId}`).expect(400);
    await authed(app).delete(`/api/internal/fieldconfigurationschemes/${schemeId}`).expect(400);
    // update items replaces the set
    await authed(app)
      .put(`/api/internal/fieldconfigurations/${configId}`)
      .send({ items: [{ fieldId: 'duedate', required: false }] })
      .expect(200);
    const one = await authed(app).get(`/rest/api/2/fieldconfigurations/${configId}`).expect(200);
    expect(one.body.items.length).toBe(1);
  });

  it('createmeta merges required/description/default and drops hidden', async () => {
    const meta = await authed(app)
      .get(`/rest/api/2/issue/createmeta/FC/issuetypes/${bugTypeId}`)
      .expect(200);
    const byId = Object.fromEntries(meta.body.values.map((v: { fieldId: string }) => [v.fieldId, v]));
    expect(byId.duedate.required).toBe(true);
    expect(byId.priority.description).toBe('How urgent is it?');
    expect(byId.labels.defaultValue).toEqual(['triage']);
    expect(byId.components).toBeUndefined();
  });

  it('required field missing on create → Jira required error', async () => {
    const r = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FC' }, summary: 'x' } });
    expect(r.status).toBe(400);
    expect(r.body.errors.duedate).toContain('required');
    const ok = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FC' }, summary: 'x', duedate: '2030-01-01' } });
    expect(ok.status).toBe(201);
  });

  it('hidden field write → cannot-be-set (incl. non-registry columns)', async () => {
    const r = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FC' }, summary: 'x', duedate: '2030-01-01', security: { name: 'x' } } });
    expect(r.status).toBe(400);
    expect(r.body.errors.security).toContain('cannot be set');
  });

  it('default value applied on create when field unprovided', async () => {
    const r = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FC' }, summary: 'x', duedate: '2030-01-01' } })
      .expect(201);
    const issue = await authed(app).get(`/rest/api/2/issue/${r.body.key}`).expect(200);
    expect(issue.body.fields.labels).toEqual(['triage']);
  });

  it('required-if rule fires on matching context', async () => {
    // priority=Highest + no environment → required error
    const r = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FC' }, summary: 'x', duedate: '2030-01-01', priority: { name: 'Highest' } } });
    expect(r.status).toBe(400);
    expect(r.body.errors.environment).toContain('required');
    // priority=High → rule doesn't fire
    const ok = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FC' }, summary: 'x', duedate: '2030-01-01', priority: { name: 'High' } } });
    expect(ok.status).toBe(201);
    // environment provided satisfies the rule
    const ok2 = await authed(app)
      .post('/rest/api/2/issue')
      .send({
        fields: { project: { key: 'FC' }, summary: 'x', duedate: '2030-01-01', priority: { name: 'Highest' }, environment: 'prod' },
      });
    expect(ok2.status).toBe(201);
  });

  it('required field may not be cleared on edit', async () => {
    const k = (await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FC' }, summary: 'x', duedate: '2030-01-01' } })
      .expect(201)).body.key;
    const r = await authed(app).put(`/rest/api/2/issue/${k}`).send({ fields: { duedate: null } });
    expect(r.status).toBe(400);
    expect(r.body.errors.duedate).toContain('required');
    await authed(app).put(`/rest/api/2/issue/${k}`).send({ fields: { duedate: '2030-02-02' } }).expect(204);
  });

  it('unbound project stays unrestricted', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'UF', name: 'UF' }).expect(201);
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'UF' }, summary: 'x' } })
      .expect(201);
  });
});

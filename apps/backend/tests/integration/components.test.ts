import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { getDurableRunner } from '../../src/lib/jobs.js';
import { registerImportHandlers } from '../../src/import/service.js';

async function project(key: string) {
  return prisma.project.create({
    data: {
      key, name: key,
      permissionSchemeId: (await prisma.permissionScheme.findFirstOrThrow({ where: { name: 'Default Permission Scheme' } })).id,
    },
  });
}

describe('Sprint 019 — Components, Versions & Release Hub', () => {
  beforeAll(async () => {
    await ensureTestAuth();
    await (await import('../../src/seed.js')).seedPermissionDefaults();
    registerImportHandlers();
  });

  // ---------- US1 components ----------

  it('component CRUD is Jira-shaped with issue counts', async () => {
    await project('COMP');
    const create = await authed(app)
      .post('/rest/api/2/component')
      .send({ name: 'Auth', project: 'COMP', description: 'Identity' })
      .expect(201);
    expect(create.body.name).toBe('Auth');
    expect(create.body.assigneeType).toBe('PROJECT_DEFAULT');
    const id = create.body.id;

    const list = await authed(app).get('/rest/api/2/project/COMP/components').expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].issueCount).toBe(0);

    const upd = await authed(app).put(`/rest/api/2/component/${id}`).send({ description: 'IAM' }).expect(200);
    expect(upd.body.description).toBe('IAM');

    // issue with the component bumps the count
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'COMP' }, summary: 'c1', components: [{ name: 'Auth' }] } })
      .expect(201);
    const rel = await authed(app).get(`/rest/api/2/component/${id}/relatedIssueCounts`).expect(200);
    expect(rel.body.issueCount).toBe(1);
  });

  it('component default assignee applies on create when assignee omitted', async () => {
    await project('LEAD');
    const me = await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } });
    await authed(app)
      .post('/rest/api/2/component')
      .send({ name: 'Security', project: 'LEAD', leadAccountId: me.id, assigneeType: 'COMPONENT_LEAD' })
      .expect(201);
    const res = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'LEAD' }, summary: 'auto-assign', components: [{ name: 'Security' }] } })
      .expect(201);
    const issue = await authed(app).get(`/rest/api/2/issue/${res.body.key}`).expect(200);
    expect(issue.body.fields.components[0].name).toBe('Security');
    expect(issue.body.fields.assignee?.accountId ?? issue.body.fields.assignee?.id).toBe(me.id);
  });

  // ---------- US2 versions & release hub ----------

  it('version CRUD, ordering via move, and project list', async () => {
    await project('REL');
    for (const n of ['1.0', '1.1', '2.0']) {
      await authed(app).post('/rest/api/2/version').send({ name: n, project: 'REL' }).expect(201);
    }
    const list1 = await authed(app).get('/rest/api/2/project/REL/versions').expect(200);
    expect(list1.body.map((v: { name: string }) => v.name)).toEqual(['1.0', '1.1', '2.0']);

    // move 2.0 to First
    const two = list1.body.find((v: { name: string }) => v.name === '2.0');
    await authed(app).post(`/rest/api/2/version/${two.id}/move`).send({ position: 'First' }).expect(200);
    const list2 = await authed(app).get('/rest/api/2/project/REL/versions').expect(200);
    expect(list2.body.map((v: { name: string }) => v.name)).toEqual(['2.0', '1.0', '1.1']);
  });

  it('issue fixVersions/affectsVersions edit via fields + update ops, JQL resolves', async () => {
    await project('FV');
    await authed(app).post('/rest/api/2/version').send({ name: 'v1', project: 'FV' }).expect(201);
    const res = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FV' }, summary: 'ver', fixVersions: [{ name: 'v1' }], versions: [{ name: 'v1' }] } })
      .expect(201);
    const key = res.body.key;
    const issue = await authed(app).get(`/rest/api/2/issue/${key}`).expect(200);
    expect(issue.body.fields.fixVersions[0].name).toBe('v1');
    expect(issue.body.fields.versions[0].name).toBe('v1');

    // JQL: fixVersion = v1, affectedVersion = v1, unreleasedVersions()
    const s1 = await authed(app).get('/rest/api/2/search/').query({ jql: `key = ${key} AND fixVersion = v1` }).expect(200);
    expect(s1.body.total).toBe(1);
    const s2 = await authed(app).get('/rest/api/2/search/').query({ jql: `key = ${key} AND affectedVersion in unreleasedVersions("FV")` }).expect(200);
    expect(s2.body.total).toBe(1);
    const s3 = await authed(app).get('/rest/api/2/search/').query({ jql: `fixVersion = earliestUnreleasedVersion("FV")` }).expect(200);
    expect(s3.body.total).toBe(1);

    // remove via update op
    await authed(app)
      .put(`/rest/api/2/issue/${key}`)
      .send({ update: { fixVersions: [{ remove: { name: 'v1' } }] } })
      .expect(204);
    const empty = await authed(app).get('/rest/api/2/search/').query({ jql: `key = ${key} AND fixVersion IS EMPTY` }).expect(200);
    expect(empty.body.total).toBe(1);
  });

  it('release stamps releaseDate, emits event, and release notes group by type', async () => {
    await project('NOTES');
    const v = await authed(app).post('/rest/api/2/version').send({ name: '1.2', project: 'NOTES' }).expect(201);
    const i1 = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'NOTES' }, summary: 'done-1', fixVersions: [{ name: '1.2' }] } })
      .expect(201);
    // transition To Do → In Progress → Done (resolution required by validator)
    const step = async () => {
      const tr = await authed(app).get(`/rest/api/2/issue/${i1.body.key}/transitions`).expect(200);
      return tr.body.transitions as { id: string; name: string }[];
    };
    const start = (await step()).find((t) => /start progress/i.test(t.name));
    await authed(app).post(`/rest/api/2/issue/${i1.body.key}/transitions`).send({ transition: { id: start.id } }).expect(204);
    const done = (await step()).find((t) => /^done$/i.test(t.name));
    await authed(app).post(`/rest/api/2/issue/${i1.body.key}/transitions`)
      .send({ transition: { id: done.id }, fields: { resolution: { name: 'Done' } } }).expect(204);

    const rel = await authed(app).post(`/rest/api/2/version/${v.body.id}/release`).send({ releaseDate: '2026-12-01' }).expect(200);
    expect(rel.body.released).toBe(true);
    expect(rel.body.releaseDate).toBe('2026-12-01');

    const ev = await prisma.domainEvent.findFirst({ where: { type: 'jira:version_released' } });
    expect(ev).toBeTruthy();

    const notes = await authed(app).get(`/rest/api/2/version/${v.body.id}/releasenotes`).expect(200);
    const keys = notes.body.groups.flatMap((g: { issues: { key: string }[] }) => g.issues.map((i: { key: string }) => i.key));
    expect(keys).toContain(i1.body.key);

    // releasedVersions() excludes unreleased
    const s = await authed(app).get('/rest/api/2/search/').query({ jql: `fixVersion in releasedVersions("NOTES")` }).expect(200);
    expect(s.body.total).toBe(1);
  });

  it('delete with moveIssuesTo swaps refs', async () => {
    await project('DEL');
    const a = await authed(app).post('/rest/api/2/component').send({ name: 'A', project: 'DEL' }).expect(201);
    const b = await authed(app).post('/rest/api/2/component').send({ name: 'B', project: 'DEL' }).expect(201);
    const res = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'DEL' }, summary: 'x', components: [{ name: 'A' }] } })
      .expect(201);
    await authed(app).delete(`/rest/api/2/component/${a.body.id}`).query({ moveIssuesTo: b.body.id }).expect(204);
    const issue = await authed(app).get(`/rest/api/2/issue/${res.body.key}`).expect(200);
    expect(issue.body.fields.components[0].name).toBe('B');
  });

  it('fixture import covers components/versions + issue joins', async () => {
    const fx = {
      '/rest/api/3/users/search': [],
      '/rest/api/3/project/IMP': { id: '900', key: 'IMP', name: 'Importer' },
      '/rest/api/3/issuetype': [{ id: '1', name: 'Task' }],
      '/rest/api/3/status': [{ id: '10', name: 'To Do' }],
      '/rest/api/3/priority': [{ id: '3', name: 'Medium' }],
      '/rest/api/3/resolution': [],
      '/rest/api/3/role': [],
      '/rest/api/3/filter/search': { values: [] },
      '/rest/api/3/workflow/search': { values: [] },
      '/rest/api/3/field': [],
      '/rest/api/3/project/IMP/components': [
        { id: 'c1', name: 'Auth', project: 'IMP', assigneeType: 'COMPONENT_LEAD' },
      ],
      '/rest/api/3/project/IMP/versions': [
        { id: 'v1', name: '1.0', project: 'IMP', released: false },
      ],
      '/rest/api/3/search': {
        issues: [{
          id: '10001', key: 'IMP-1',
          fields: {
            summary: 'i', issuetype: { name: 'Task' }, status: { name: 'To Do' },
            priority: { name: 'Medium' }, project: { key: 'IMP' },
            components: [{ id: 'c1', name: 'Auth' }],
            fixVersions: [{ id: 'v1', name: '1.0' }],
            versions: [{ id: 'v1', name: '1.0' }],
          },
        }],
        total: 1, startAt: 0, maxResults: 50,
      },
    };
    const res = await authed(app)
      .post('/api/internal/migration/jira-cloud')
      .send({ projectKeys: ['IMP'], fixture: fx })
      .expect(202);
    await getDurableRunner().flush();
    const job = (await authed(app).get(`/api/internal/migration/${res.body.id}`).expect(200)).body;
    expect(job.stage).toBe('done');
    const issue = await prisma.issue.findFirstOrThrow({ where: { project: { key: 'IMP' } }, include: { components: { include: { component: true } }, versionRefs: { include: { version: true } } } });
    expect(issue.components[0].component.name).toBe('Auth');
    expect(issue.versionRefs.map((r) => `${r.kind}:${r.version.name}`).sort()).toEqual(['affects:1.0', 'fix:1.0']);
  });

  // ---------- US3 CF pickers ----------

  it('version_picker/component_picker CF types validate project entities', async () => {
    await project('CFP');
    await authed(app).post('/rest/api/2/version').send({ name: '2.0', project: 'CFP' }).expect(201);
    await authed(app).post('/rest/api/2/component').send({ name: 'UI', project: 'CFP' }).expect(201);

    const vf = await authed(app)
      .post('/api/internal/customfields')
      .send({ name: 'Target release', type: 'version_picker', context: { projectKeys: ['CFP'] } })
      .expect(201);
    const cf = await authed(app)
      .post('/api/internal/customfields')
      .send({ name: 'Area', type: 'component_picker', context: { projectKeys: ['CFP'] } })
      .expect(201);

    const issue = await authed(app)
      .post('/rest/api/2/issue')
      .send({
        fields: {
          project: { key: 'CFP' }, summary: 'x',
          [vf.body.id]: { name: '2.0' },
          [cf.body.id]: { id: (await prisma.component.findFirstOrThrow({ where: { name: 'UI' } })).id },
        },
      })
      .expect(201);
    const got = await authed(app).get(`/rest/api/2/issue/${issue.body.key}`).expect(200);
    expect(got.body.fields[vf.body.id].name).toBe('2.0');
    expect(got.body.fields[cf.body.id].name).toBe('UI');

    // Cross-project / missing entities rejected.
    const bad = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'CFP' }, summary: 'y', [vf.body.id]: { name: 'nope' } } })
      .expect(400);
    expect(bad.body.errors[vf.body.id]).toMatch(/not found/);
  });
});

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { authed } from '../request.js';
import app from '../../src/main.js';


const uid = () => Math.random().toString(36).slice(2, 10);

async function seedProject(key = 'AG') {
  await authed(app).post('/rest/api/2/project').send({ key, name: 'Agent' }).expect(201);
}

describe('self-describing API', () => {
  it('serverInfo is Jira-shaped and unauthenticated', async () => {
    const res = await request(app).get('/rest/api/2/serverInfo').expect(200);
    expect(res.body.deploymentType).toBe('Server');
    expect(res.body.serverTitle).toBe('TrackForge');
    expect(res.body.baseUrl).toContain('http');
  });

  it('/field lists system fields in Jira shape', async () => {
    const res = await authed(app).get('/rest/api/2/field').expect(200);
    const ids = res.body.map((f: { id: string }) => f.id);
    for (const id of ['summary', 'issuetype', 'status', 'priority', 'assignee', 'reporter', 'project']) {
      expect(ids).toContain(id);
    }
    const summary = res.body.find((f: { id: string }) => f.id === 'summary');
    expect(summary.schema.system).toBe('summary');
    expect(summary.custom).toBe(false);
  });

  it('createmeta returns issue types then field metadata', async () => {
    await seedProject('CM');
    const types = await authed(app).get('/rest/api/2/issue/createmeta/CM/issuetypes').expect(200);
    expect(types.body.issuetypes.length).toBeGreaterThanOrEqual(5);
    const bug = types.body.issuetypes.find((t: { name: string }) => t.name === 'Bug');

    const fields = await authed(app)
      .get(`/rest/api/2/issue/createmeta/CM/issuetypes/${bug.id}`)
      .expect(200);
    const byId = Object.fromEntries(fields.body.values.map((v: { fieldId: string }) => [v.fieldId, v]));
    expect(byId.summary.required).toBe(true);
    expect(byId.priority.allowedValues.map((v: { name: string }) => v.name)).toContain('High');
    expect(byId.assignee.autoCompleteUrl).toContain('assignable/search');
  });

  it('editmeta returns editable fields', async () => {
    await seedProject('EM');
    const issue = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'EM' }, summary: 'x' } })
      .expect(201);
    const res = await authed(app).get(`/rest/api/2/issue/${issue.body.key}/editmeta`).expect(200);
    expect(Object.keys(res.body.fields)).toEqual(
      expect.arrayContaining(['summary', 'description', 'status', 'priority', 'assignee'])
    );
  });
});

describe('fields / expand selection', () => {
  it('fields=summary,status returns only those fields', async () => {
    await seedProject('FS');
    const issue = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FS' }, summary: 'selective' } })
      .expect(201);
    const res = await authed(app)
      .get(`/rest/api/2/issue/${issue.body.key}?fields=summary,status`)
      .expect(200);
    expect(Object.keys(res.body.fields).sort()).toEqual(['status', 'summary']);
    expect(res.body.fields.summary).toBe('selective');
  });

  it('POST /search honours jql + fields', async () => {
    await seedProject('PS');
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'PS' }, summary: 'findme' } })
      .expect(201);
    const res = await authed(app)
      .post('/rest/api/2/search')
      .send({ jql: 'project = PS', fields: ['summary'] })
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(Object.keys(res.body.issues[0].fields)).toEqual(['summary']);
  });

  it('expand=names and schema annotate the response', async () => {
    await seedProject('EX');
    const issue = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'EX' }, summary: 'expanded' } })
      .expect(201);
    const res = await authed(app)
      .get(`/rest/api/2/issue/${issue.body.key}?expand=names,schema`)
      .expect(200);
    expect(res.body.names.summary).toBe('Summary');
    expect(res.body.schema.priority.system).toBe('priority');
  });
});

describe('idempotency', () => {
  it('replays the same response and creates exactly one issue', async () => {
    await seedProject('ID');
    const key = `test-${uid()}`;
    const body = { fields: { project: { key: 'ID' }, summary: 'once' } };

    const first = await authed(app).post('/rest/api/2/issue').set('Idempotency-Key', key).send(body).expect(201);
    const second = await authed(app).post('/rest/api/2/issue').set('Idempotency-Key', key).send(body).expect(201);
    expect(second.headers['x-trackforge-idempotent-replay']).toBe('true');
    expect(second.body.key).toBe(first.body.key);

    const search = await authed(app).get('/rest/api/2/search?jql=project%20%3D%20ID');
    expect(search.body.total).toBe(1);
  });

  it('rejects same key with different body as 422', async () => {
    await seedProject('ID2');
    const key = `test-${uid()}`;
    await authed(app)
      .post('/rest/api/2/issue')
      .set('Idempotency-Key', key)
      .send({ fields: { project: { key: 'ID2' }, summary: 'one' } })
      .expect(201);
    const res = await authed(app)
      .post('/rest/api/2/issue')
      .set('Idempotency-Key', key)
      .send({ fields: { project: { key: 'ID2' }, summary: 'two' } });
    expect(res.status).toBe(422);
  });
});

describe('dryRun', () => {
  it('validates and previews a create without persisting', async () => {
    await seedProject('DR');
    const res = await authed(app)
      .post('/rest/api/2/issue?dryRun=true')
      .send({ fields: { project: { key: 'DR' }, summary: 'preview', priority: { name: 'High' } } })
      .expect(200);
    expect(res.headers['x-trackforge-dryrun']).toBe('true');
    expect(res.body.issue.fields.summary).toBe('preview');
    expect(res.body.changes.map((c: { field: string }) => c.field)).toContain('priority');
    const search = await authed(app).get('/rest/api/2/search?jql=project%20%3D%20DR');
    expect(search.body.total).toBe(0);
  });

  it('dryRun update shows the diff', async () => {
    await seedProject('DRU');
    const issue = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'DRU' }, summary: 'orig' } })
      .expect(201);
    const res = await authed(app)
      .put(`/rest/api/2/issue/${issue.body.key}?dryRun=true`)
      .send({ fields: { summary: 'changed', priority: { name: 'Highest' } } })
      .expect(200);
    const summaryItem = res.body.changes.find((c: { field: string }) => c.field === 'summary');
    expect(summaryItem.fromString).toBe('orig');
    expect(summaryItem.toString).toBe('changed');
    const fetched = await authed(app).get(`/rest/api/2/issue/${issue.body.key}`);
    expect(fetched.body.fields.summary).toBe('orig');
  });
});

describe('validation quality', () => {
  it('invalid priority lists allowed values', async () => {
    await seedProject('AV');
    const res = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'AV' }, summary: 'x', priority: { name: 'Urgent' } } });
    expect(res.status).toBe(400);
    expect(res.body.errors['fields.priority']).toMatch(/Allowed: .*Highest.*Lowest/);
  });
});

describe('bulk create', () => {
  it('creates valid items and reports per-item errors', async () => {
    await seedProject('BK');
    const res = await authed(app)
      .post('/rest/api/2/issue/bulk')
      .send({
        issueUpdates: [
          { fields: { project: { key: 'BK' }, summary: 'good 1' } },
          { fields: { project: { key: 'BK' }, summary: 'bad', priority: { name: 'Nope' } } },
          { fields: { project: { key: 'BK' }, summary: 'good 2' } },
        ],
      })
      .expect(201);
    expect(res.body.issues).toHaveLength(2);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].index).toBe(1);
  });
});

describe('assignee resolution variants', () => {
  it('assigns by display name for Jira-Server clients', async () => {
    await seedProject('AN');
    const issue = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'AN' }, summary: 'x' } })
      .expect(201);
    await authed(app)
      .put(`/rest/api/2/issue/${issue.body.key}/assignee`)
      .send({ name: 'Test Admin' })
      .expect(204);
    const res = await authed(app).get(`/rest/api/2/issue/${issue.body.key}`);
    expect(res.body.fields.assignee.displayName).toBe('Test Admin');
  });
});

describe('openapi drift', () => {
  it('documents every mounted route', async () => {
    const res = await authed(app).get('/rest/api/2/openapi.json').expect(200);
    const doc = res.body;
    expect(doc.openapi).toBe('3.1.0');

    // Walk the Express stack and assert every route is documented.
    const docPaths = Object.keys(doc.paths).map(normalizePath);
    const actual = listRoutes(Object.keys(doc.paths));
    const undocumented: string[] = [];
    for (const r of actual) {
      // `GET *` is the SPA static-file fallback, not API surface.
      if (r.path === '*') continue;
      const docPath = normalizePath(r.path);
      const idx = docPaths.indexOf(docPath);
      const pathItem = idx >= 0 ? doc.paths[Object.keys(doc.paths)[idx]] : undefined;
      if (!pathItem || !pathItem[r.method.toLowerCase()]) {
        undocumented.push(`${r.method} ${docPath}`);
      }
    }
    expect(undocumented).toEqual([]);
  });
});

/** Strip trailing slash, unescape `\.`, unify `:param`/`{param}` → `{}`. */
function normalizePath(p: string): string {
  return p
    .replace(/\\\./g, '.')
    .replace(/\/$/, '')
    .replace(/:([^/]+)/g, '{}')
    .replace(/\{[^}]+\}/g, '{}');
}

/** Enumerate mounted routes from the Express app (test-local, dev-only). */
function listRoutes(docPaths: string[]): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  // Express 5: app.router (was app._router) and layers carry opaque `matchers`
  // functions instead of a regexp — the raw mount path is not stored. Probe
  // each matcher with candidate paths: a non-end mount matcher returns
  // `{ path: <matched prefix> }` for any path under it.
  const stack = (app as unknown as { router: { stack: any[] } }).router.stack;

  // Mirror of the app.use mounts in main.ts — the fallback candidates so a
  // fully-undocumented mount still resolves to its prefix (the mount path
  // always matches its own matcher). Keep in sync with main.ts.
  const MOUNT_PREFIXES = [
    '/api/internal', '/api/internal/admin', '/api/internal/admin/idps',
    '/api/internal/admin/oauth', '/api/internal/ai', '/api/internal/auth',
    '/api/internal/automation', '/api/internal/boards', '/api/internal/bulk',
    '/api/internal/customfields', '/api/internal/dev',
    '/api/internal/dev/gitlab/connections', '/api/internal/dev/repositories',
    '/api/internal/docs', '/api/internal/export', '/api/internal/filters',
    '/api/internal/issues', '/api/internal/issuesecurityschemes',
    '/api/internal/jql', '/api/internal/me', '/api/internal/metadata',
    '/api/internal/notificationschemes', '/api/internal/projects',
    '/api/internal/proposals', '/api/internal/reports', '/api/internal/roadmap',
    '/api/internal/search', '/rest/agile/1.0', '/rest/agile/1.0/backlog',
    '/rest/agile/1.0/board', '/rest/api/2', '/rest/api/3', '/rest/devinfo/0.10',
    '/rest/webhooks/1.0', '/scim/v2',
  ];
  const candidates = [
    ...docPaths.map((p) => p.replace(/\{[^}]+\}/g, 'x')),
    ...MOUNT_PREFIXES,
  ];

  const mountPath = (
    layer: {
      slash?: boolean;
      matchers?: ((p: string) => { path: string } | false)[];
    },
    prefix: string
  ): string => {
    if (layer.slash) return ''; // bare router.use(subRouter) mount
    // Inner routers see the path with the outer mount prefix already stripped,
    // so probe them with prefix-relative candidates.
    const rel = candidates
      .filter((c) => c === prefix || c.startsWith(prefix + '/'))
      .map((c) => c.slice(prefix.length) || '/');
    for (const m of layer.matchers ?? []) {
      for (const c of rel.length ? rel : ['/']) {
        const r = m(c);
        if (r) return r.path;
      }
    }
    return '';
  };

  const walk = (layers: any[], prefix: string) => {
    for (const layer of layers) {
      if (layer.route) {
        const path = prefix + layer.route.path;
        for (const method of Object.keys(layer.route.methods)) {
          if (method !== '_all') out.push({ method: method.toUpperCase(), path });
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer, prefix));
      }
    }
  };
  walk(stack, '');
  return out;
}

import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { prisma } from '../../src/prisma.js';
import { getDurableRunner } from '../../src/lib/jobs.js';
import { registerImportHandlers, startImport } from '../../src/import/service.js';
import { MemoryStore, setAttachmentStore } from '../../src/ports/attachmentStore.js';
import { createJiraServerSource, serverPath, assertServerBaseUrl } from '../../src/import/jiraServerClient.js';
import { createJiraSource, JiraApiError } from '../../src/import/jiraClient.js';
import { importerRegistry } from '../../src/import/importers.js';
import type { JiraSource } from '../../src/import/types.js';

beforeAll(() => registerImportHandlers());

const admin = async () => (await prisma.user.findFirstOrThrow({ where: { isAdmin: true } })).id;

const USER_U1 = { self: 'https://jira.example.com/rest/api/2/user?key=u1', key: 'u1', name: 'alice', displayName: 'Alice A', active: true, avatarUrls: {} };
const USER_U2 = { self: 'https://jira.example.com/rest/api/2/user?key=u2', key: 'u2', name: 'bob', displayName: 'Bob B', active: true, avatarUrls: {} };

const ISSUE = {
  id: '10001', key: 'TF-1', self: 'https://jira.example.com/rest/api/2/issue/10001',
  fields: {
    summary: 'Server issue', issuetype: { id: '1', name: 'Task' }, status: { id: '1', name: 'To Do' },
    priority: { id: '3', name: 'Medium' }, resolution: null,
    assignee: USER_U1, reporter: USER_U2, labels: [], created: '2024-01-01T10:00:00.000+0000',
    comment: { comments: [], total: 0 }, attachment: [], issuelinks: [],
    customfield_20001: 5, // resolved as 'Story Points' via preflight aliases
    customfield_20002: [{ value: 'Impediment' }], // resolved as 'Flagged'
  },
};

/** Server-shaped fixture — keys are what Server/DC actually serves (api/2 + agile). */
function serverFixture(userOverrides: Partial<typeof USER_U1> = {}): Record<string, unknown> {
  const u1 = { ...USER_U1, ...userOverrides };
  return {
    '/rest/api/2/serverInfo': { version: '9.12.0', buildNumber: 912000, baseUrl: 'https://jira.example.com' },
    '/rest/api/2/field': [
      { id: 'customfield_20001', name: 'Story Points', custom: true, schema: { custom: 'x:float' } },
      { id: 'customfield_20002', name: 'Flagged', custom: true, schema: { custom: 'x:multicheckboxes' } },
    ],
    '/rest/api/2/user/search': [u1, USER_U2],
    '/rest/api/2/groups/picker': { groups: [] },
    '/rest/api/2/role': [],
    '/rest/api/2/project/TF': { id: '100', key: 'TF', name: 'Server Project', lead: u1 },
    '/rest/api/2/project/TF/role': {},
    '/rest/api/2/project/TF/components': [],
    '/rest/api/2/project/TF/versions': [],
    '/rest/api/2/issuetype': [{ id: '1', name: 'Task' }],
    '/rest/api/2/status': [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }],
    '/rest/api/2/priority': [{ id: '3', name: 'Medium' }],
    '/rest/api/2/resolution': [],
    '/rest/api/2/workflow': [],
    '/rest/api/2/search': { issues: [{ ...ISSUE, fields: { ...ISSUE.fields, assignee: u1 } }], total: 1 },
    '/rest/api/2/issue/TF-1/worklog': { worklogs: [], total: 0 },
    '/rest/api/2/issue/TF-1/watchers': { watchers: [], watchCount: 0 },
    '/rest/api/2/issue/TF-1/votes': { votes: 0, voters: [] },
    '/rest/api/2/issue/TF-1/remotelink': [],
    '/rest/agile/1.0/board': { values: [] },
    '/rest/api/2/issueLinkType': { issueLinkTypes: [] },
    '/rest/api/2/filter/favourite': [],
    '/rest/api/2/issuesecurityschemes': { issueSecuritySchemes: [] },
    '/rest/api/2/issuetypescheme': { issueTypeSchemes: [] },
    '/rest/api/2/fieldconfigurations': { values: [] },
  };
}

describe('jira-server source (048)', () => {
  it('rewrites api/3→api/2 at the boundary and normalizes user beans', async () => {
    const seen: string[] = [];
    const inner: JiraSource = {
      async get<T>(path: string) { seen.push(path); return { key: 'u9', name: 'x', displayName: 'X' } as T; },
      async *paged<T>(path: string, itemsKey?: string) {
        seen.push(path);
        if (itemsKey) return;
        yield { key: 'u9', name: 'x', displayName: 'X' } as T;
      },
    };
    const src = await createJiraServerSource({ baseUrl: 'https://jira.example.com', authMode: 'pat', inner, projectKeys: ['TF'] });
    const bean = await src.get<{ accountId: string }>('/rest/api/3/user', { key: 'u9' });
    expect(seen[0]).toBe('/rest/api/2/user');
    expect(bean.accountId).toBe('u9'); // FR-003: key is the stable identity
    for await (const _ of src.paged('/rest/api/3/priority')) { /* drain */ }
    expect(seen[1]).toBe('/rest/api/2/priority');
    expect(serverPath('/rest/api/3/issue/TF-1/watchers')).toBe('/rest/api/2/issue/TF-1/watchers');
    expect(serverPath('/rest/agile/1.0/board')).toBe('/rest/agile/1.0/board');
  });

  it('SC-002: PAT sends Bearer on every request, never Basic', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    const src = createJiraSource({ baseUrl: 'https://jira.example.com', email: '', apiToken: 'pat-secret', authMode: 'pat', fetchImpl });
    await src.get('/rest/api/2/serverInfo');
    await src.get('/rest/api/2/project/TF');
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.auth).toBe('Bearer pat-secret');
  });

  it('SC-003: off-origin absolute URLs fetch without Authorization + warn (SC-003/FR-002)', async () => {
    const calls: { url: string; auth?: string }[] = [];
    const warns: string[] = [];
    const fetchImpl = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization });
      return new Response(JSON.stringify({ version: '9.12.0' }), { status: 200 });
    }) as typeof fetch;
    const src = createJiraSource({
      baseUrl: 'https://jira.example.com', email: 'a@b.c', apiToken: 'tok', fetchImpl,
      onWarn: (m) => warns.push(m),
    });
    await src.getBinary('https://attacker.example.com/exfil.png');
    expect(calls[0].auth).toBeUndefined();
    expect(warns.some((w) => w.includes('attacker.example.com'))).toBe(true);
    await src.get('/rest/api/2/serverInfo');
    expect(calls[1].auth).toMatch(/^Basic /);
  });

  it('SSRF guard: private targets need allowPrivate; non-http rejected', async () => {
    // IP literals keep the checks DNS-free (egress resolves real hostnames).
    await expect(assertServerBaseUrl('https://93.184.216.34')).resolves.not.toThrow();
    await expect(assertServerBaseUrl('http://localhost:8080')).rejects.toThrow(/allowPrivate/);
    await expect(assertServerBaseUrl('https://10.0.0.5/jira')).rejects.toThrow(/allowPrivate/);
    await expect(assertServerBaseUrl('http://127.0.0.1', { allowPrivate: true })).resolves.not.toThrow();
    await expect(assertServerBaseUrl('file:///etc/passwd')).rejects.toThrow(/scheme/);
  });

  it('FR-006: user discovery unions user/search + groups[] + issue refs, deduped by key', async () => {
    const inner: JiraSource = {
      async get<T>(path: string) {
        if (path === '/rest/api/2/user/search') return [USER_U1] as T; // search misses u2 entirely
        return null as T;
      },
      async *paged<T>(path: string) {
        if (path === '/rest/api/2/group/member') { yield USER_U2 as T; yield USER_U1 as T; }
        if (path === '/rest/api/2/search') yield { key: 'TF-1', fields: { reporter: { key: 'u3', name: 'carol', displayName: 'Carol' } } } as T;
      },
    };
    const src = await createJiraServerSource({ baseUrl: 'https://jira.example.com', authMode: 'pat', inner, projectKeys: ['TF'], groups: ['devs'] });
    const users: { key?: string; accountId?: string }[] = [];
    for await (const u of src.paged<{ key?: string; accountId?: string }>('/rest/api/3/users/search')) users.push(u);
    const keys = users.map((u) => u.key ?? u.accountId).sort();
    expect(keys).toEqual(['u1', 'u2', 'u3']); // union, no dupes
    expect(users.find((u) => (u.key ?? '') === 'u3')?.accountId).toBe('u3');
  });

  it('US5-2: deltaFrom narrows Server search exactly like Cloud (updated >= JQL)', async () => {
    const paramsSeen: Record<string, unknown>[] = [];
    const inner: JiraSource = {
      async get<T>() { return null as T; },
      // eslint-disable-next-line require-yield -- async-generator shape required by JiraSource
      async *paged(path: string, _itemsKey?: string, params?: Record<string, unknown>) {
        if (path === '/rest/api/2/search') paramsSeen.push(params ?? {});
      },
    };
    const src = await createJiraServerSource({ baseUrl: 'https://jira.example.com', authMode: 'pat', inner, projectKeys: ['TF'] });
    const ctx = {
      job: { id: 'j-delta', projectKeys: ['TF'], stageData: { deltaFrom: '2024-06-01T00:00:00.000Z' } },
      prisma: null, resolve: async () => null, record: async () => {}, warn: () => {},
    };
    const { issueImporter } = await import('../../src/import/importers.js');
     
    for await (const _ of issueImporter.discover(src, ctx as any)) { /* drain */ }
    expect(paramsSeen.length).toBeGreaterThan(0);
    expect(String(paramsSeen[0].jql)).toContain('updated >= "2024-06-01T00:00:00.000Z"');
    expect(String(paramsSeen[0].jql)).toContain('project in (TF)');
  });

  it('filter/search falls back to favourites with a warning; workflow/search maps to /rest/api/2/workflow', async () => {
    const warns: string[] = [];
    const inner: JiraSource = {
      async get<T>(path: string) {
        if (path === '/rest/api/2/filter/favourite') return [{ id: '10', name: 'Fav', jql: 'project=TF', owner: USER_U1 }] as T;
        if (path === '/rest/api/2/workflow') return [{ name: 'wf', steps: [] }] as T;
        throw new JiraApiError(404, path, 'nope');
      },
      // eslint-disable-next-line require-yield -- async-generator shape required by JiraSource
      async *paged(path: string) { throw new JiraApiError(404, path, `unexpected paged ${path}`); },
    };
    const src = await createJiraServerSource({ baseUrl: 'https://jira.example.com', authMode: 'pat', inner, onWarn: (m) => warns.push(m) });
    const filters: unknown[] = [];
    for await (const f of src.paged('/rest/api/3/filter/search')) filters.push(f);
    expect(filters).toHaveLength(1);
    expect(warns.some((w) => w.includes('no filter enumeration'))).toBe(true);
    const wfs: unknown[] = [];
    for await (const w of src.paged('/rest/api/3/workflow/search')) wfs.push(w);
    expect((wfs[0] as { id: { name: string } }).id.name).toBe('wf');
  });

  it('SC-005 contract: no api/3 or Cloud-only path ever reaches the inner source', async () => {
    const paths: string[] = [];
    const canned = (path: string): unknown => {
      if (path === '/rest/api/2/user/search') return [USER_U1];
      if (path.includes('/rest/api/2/search')) return { issues: [ISSUE], total: 1 };
      if (path === '/rest/api/2/group/member') return { values: [USER_U2] };
      if (path === '/rest/api/2/filter/favourite') return [{ id: '10' }];
      if (path === '/rest/api/2/workflow') return [{ name: 'wf', steps: [{ id: '1', linkedStatusName: 'To Do' }] }];
      if (path === '/rest/api/2/field') {
        return [{ id: 'customfield_20001', name: 'Team', custom: true, schema: { custom: 'x:select' } }];
      }
      if (path.includes('createmeta')) {
        return { projects: [{ issuetypes: [{ fields: { customfield_20001: { allowedValues: [{ id: 'v1', value: 'Alpha' }] } } }] }] };
      }
      if (/components$|versions$|issuetype$|status$|priority$|resolution$|\/role$|remotelink$|comment$/.test(path)) return [{ id: '1', name: 'x' }];
      if (path.includes('/rest/agile/1.0/board')) return { values: [{ id: 1, name: 'B' }] };
      return { values: [{ id: '1', name: 'x' }], issueSecuritySchemes: [], issueTypeSchemes: [], total: 1 };
    };
    const inner: JiraSource = {
      async get<T>(path: string) { paths.push(path); return canned(path) as T; },
      async *paged<T>(path: string, itemsKey?: string) {
        paths.push(path);
        const body = canned(path);
        const rows = itemsKey ? (((body as Record<string, unknown>)[itemsKey] as T[]) ?? []) : (body as T[]);
        for (const r of Array.isArray(rows) ? rows : []) yield r;
      },
      async getBinary(path: string) { paths.push(path); return Buffer.from('x'); },
    };
    const src = await createJiraServerSource({
      baseUrl: 'https://jira.example.com', authMode: 'pat', inner, projectKeys: ['TF'],
      onWarn: () => {},
    });
    const ctx = {
      job: { id: 'j-contract', projectKeys: ['TF'], stageData: {} },
      prisma: null,
      resolve: async () => null,
      record: async () => {},
      warn: () => {},
    };
    for (const imp of importerRegistry) {
      try {
         
        for await (const _ of imp.discover(src as any, ctx as any)) { /* drain */ }
      } catch {
        /* discover may reject on canned shapes — paths already recorded */
      }
    }
    expect(paths.length).toBeGreaterThan(5);
    for (const p of paths) {
      expect(p.includes('/rest/api/3/')).toBe(false);
    }
    // Cloud-only enumeration paths must never reach the wire on Server.
    for (const banned of ['/rest/api/2/users/search', '/rest/api/2/workflow/search', '/rest/api/2/filter/search', '/fieldconfigurations']) {
      expect(paths.filter((p) => p.includes(banned))).toEqual([]);
    }
    // And the Server equivalents DID run.
    expect(paths).toContain('/rest/api/2/user/search');
    expect(paths).toContain('/rest/api/2/workflow');
    expect(paths).toContain('/rest/api/2/filter/favourite');
    expect(paths).toContain('/rest/api/2/issue/createmeta');
    expect(paths.some((p) => p.startsWith('/rest/agile/1.0/board'))).toBe(true);
  });
});

describe('jira-server pipeline (048)', () => {
  it('route validation: basic requires username; private baseUrl needs allowPrivate', async () => {
    const a = await authed(app);
    await a.post('/api/internal/migration/jira-server')
      .send({ baseUrl: 'https://jira.example.com', authMode: 'basic', apiToken: 't', projectKeys: ['TF'] })
      .expect(400);
    await a.post('/api/internal/migration/jira-server')
      .send({ baseUrl: 'http://192.168.1.10', authMode: 'pat', apiToken: 't', projectKeys: ['TF'] })
      .expect(400);
    await a.post('/api/internal/migration/jira-server')
      .send({ baseUrl: 'https://jira.example.com', authMode: 'pat', projectKeys: ['TF'] })
      .expect(400); // no token at all
  });

  it('imports a Server fixture: attribution via normalized accountId, alias-mapped fields', async () => {
    const job = await startImport(await admin(), {
      fixture: serverFixture(), source: 'jira-server', projectKeys: ['TF'], authMode: 'pat', apiToken: 'x',
    });
    await getDurableRunner().flush();
    const done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.stage).toBe('done');
    const sd = done.stageData as { serverInfo?: { version?: string }; fieldAliases?: Record<string, string> };
    expect(sd.serverInfo?.version).toBe('9.12.0');
    expect(sd.fieldAliases?.storyPoints).toBe('customfield_20001'); // resolved by name
    expect(sd.fieldAliases?.flagged).toBe('customfield_20002');
    // users keyed by Jira key
    const alice = await prisma.user.findFirstOrThrow({ where: { email: 'jira-u1@import.local' } });
    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'TF' } });
    const issue = await prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 1 } });
    expect(issue.assigneeId).toBe(alice.id);
    expect(issue.storyPoints).toBe(5);
    // flagged lands on the imported system CF ('Flagged'), not a stray CF sweep
    const flaggedCf = await prisma.customField.findFirstOrThrow({ where: { name: 'Flagged' } });
    const flaggedCv = await prisma.customFieldValue.findUniqueOrThrow({
      where: { issueId_fieldId: { issueId: issue.id, fieldId: flaggedCf.id } },
    });
    expect(flaggedCv.value).toEqual(['Impediment']);
    // Story Points rode the column alias — never a generic CF value write.
    const spCf = await prisma.customField.findFirstOrThrow({ where: { name: 'Story Points' } });
    expect(
      await prisma.customFieldValue.findUnique({
        where: { issueId_fieldId: { issueId: issue.id, fieldId: spCf.id } },
      }),
    ).toBeNull();
  });

  it('gh-epic-link resolves to parentId — child emitted before its epic still links', async () => {
    const fx = serverFixture();
    // Localized field names (Spanish Jira) — name matching misses these; the
    // schema.custom suffix resolution is what binds them (EGM2 regression).
    (fx['/rest/api/2/field'] as unknown[]).push(
      { id: 'customfield_20004', name: 'Enlace de épica', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
      { id: 'customfield_20005', name: 'Nombre de épica', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-label' } }
    );
    (fx['/rest/api/2/issuetype'] as unknown[]).push({ id: '5', name: 'Epic' });
    const base = {
      status: { id: '1', name: 'To Do' }, priority: { id: '3', name: 'Medium' }, resolution: null,
      assignee: USER_U1, reporter: USER_U2, labels: [], created: '2024-01-01T10:00:00.000+0000',
      comment: { comments: [], total: 0 }, attachment: [], issuelinks: [],
    };
    // ORDER BY key ASC yields TF-3 before TF-9 — the epic-link fix must not
    // depend on parents preceding children in the search stream.
    const child = { id: '10003', key: 'TF-3', fields: { ...base, summary: 'story', issuetype: { id: '1', name: 'Task' }, customfield_20004: 'TF-9' } };
    const epic = { id: '10009', key: 'TF-9', fields: { ...base, summary: '', issuetype: { id: '5', name: 'Epic' }, customfield_20005: 'The Epic' } };
    const tf1 = (fx['/rest/api/2/search'] as { issues: unknown[] }).issues[0];
    fx['/rest/api/2/search'] = { issues: [tf1, child, epic], total: 3 };
    for (const k of ['TF-3', 'TF-9']) {
      fx[`/rest/api/2/issue/${k}/worklog`] = { worklogs: [], total: 0 };
      fx[`/rest/api/2/issue/${k}/watchers`] = { watchers: [], watchCount: 0 };
      fx[`/rest/api/2/issue/${k}/votes`] = { votes: 0, voters: [] };
      fx[`/rest/api/2/issue/${k}/remotelink`] = [];
    }
    const job = await startImport(await admin(), {
      fixture: fx, source: 'jira-server', projectKeys: ['TF'], authMode: 'pat', apiToken: 'x',
    });
    let done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    for (let i = 0; i < 200 && done.stage !== 'done' && done.stage !== 'failed'; i++) {
      await getDurableRunner().flush();
      await new Promise((r) => setTimeout(r, 100));
      done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    expect(done.error, `job failed: ${done.error}`).toBeNull();
    expect(done.stage).toBe('done');
    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'TF' } });
    const [tf3, tf9] = await Promise.all([
      prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 3 } }),
      prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 9 } }),
    ]);
    expect(tf3.parentId).toBe(tf9.id);
    expect(tf9.summary).toBe('The Epic'); // empty summary falls back to Epic Name
    // The epic-link TARGET's type is inferred epic-level — Server /issuetype
    // carries no hierarchyLevel, so gh-epic-link targets mark it.
    const epicType = await prisma.issueType.findFirstOrThrow({ where: { name: 'Epic' } });
    expect(epicType.hierarchyLevel).toBe(1);
    const taskType = await prisma.issueType.findFirstOrThrow({ where: { name: 'Task' } });
    expect(taskType.hierarchyLevel).toBe(0);
    // Epic Link/Name are column-mapped — never generic CF writes.
    expect(
      await prisma.customField.count({ where: { name: { in: ['Enlace de épica', 'Nombre de épica'] } } })
    ).toBe(0);
    const report = done.report as { verify?: { diffs: string[] }[] };
    for (const v of report.verify ?? []) expect(v.diffs).toEqual([]);
  });

  it('reconstructed workflow attaches to the project — real statuses, not the seeded Simple set', async () => {
    const fx = serverFixture();
    // Localized statuses like EGM2 — Server /workflow enumeration yields no
    // step detail, so the reconstructed workflow must attach to the project or
    // transitions fall back to 'Simple' (To Do / In Progress / Done).
    const st = [
      { id: '1', name: 'Por hacer', statusCategory: { key: 'new' } },
      { id: '2', name: 'Listo', statusCategory: { key: 'done' } },
    ];
    fx['/rest/api/2/status'] = st;
    fx['/rest/api/2/project/TF/statuses'] = [{ id: 't1', name: 'Task', statuses: st }];
    const job = await startImport(await admin(), {
      fixture: fx, source: 'jira-server', projectKeys: ['TF'], authMode: 'pat', apiToken: 'x',
    });
    let done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    for (let i = 0; i < 200 && done.stage !== 'done' && done.stage !== 'failed'; i++) {
      await getDurableRunner().flush();
      await new Promise((r) => setTimeout(r, 100));
      done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    expect(done.error, `job failed: ${done.error}`).toBeNull();
    expect(done.stage).toBe('done');

    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'TF' } });
    const wf = await prisma.workflow.findUniqueOrThrow({
      where: { name: 'TF workflow (reconstructed)' },
      include: { transitions: { include: { toStatus: true, rules: true } } },
    });
    expect(project.workflowId).toBe(wf.id);
    // Every imported status reachable via a global transition named after it.
    expect(wf.transitions.map((t) => t.toStatus.name).sort()).toEqual(['Listo', 'Por hacer']);
    for (const t of wf.transitions) {
      expect(t.fromStatusId).toBeNull();
      expect(t.name).toBe(t.toStatus.name);
    }
    // Simplified-workflow resolution post-functions by target category.
    expect(wf.transitions.find((t) => t.toStatus.name === 'Listo')!.rules[0])
      .toMatchObject({ kind: 'postFunction', type: 'setResolution' });
    expect(wf.transitions.find((t) => t.toStatus.name === 'Por hacer')!.rules[0])
      .toMatchObject({ kind: 'postFunction', type: 'clearResolution' });
  });

  it('greenhopper CFs map native — rank, story points, labels merge, jpo-parent, epic status', async () => {
    const fx = serverFixture();
    // All localized names — every binding here is schema.custom resolution,
    // which is also what makes migration automatic on any language pack.
    (fx['/rest/api/2/field'] as unknown[]).push(
      { id: 'customfield_20004', name: 'Enlace de épica', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
      { id: 'customfield_30001', name: 'Puntos de historia', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:jsw-story-points' } },
      { id: 'customfield_30002', name: 'Marcado', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-flagged' } },
      { id: 'customfield_30003', name: 'Rango', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
      { id: 'customfield_30004', name: 'Etiquetas', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:labels' } },
      { id: 'customfield_30005', name: 'Enlace padre', custom: true, schema: { custom: 'com.atlassian.jpo:jpo-parent' } },
      { id: 'customfield_30006', name: 'Estado épica', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-status' } }
    );
    (fx['/rest/api/2/issuetype'] as unknown[]).push({ id: '5', name: 'Epic' }, { id: '6', name: 'Initiative' });
    const base = {
      status: { id: '1', name: 'To Do' }, priority: { id: '3', name: 'Medium' }, resolution: null,
      assignee: USER_U1, reporter: USER_U2, labels: [], created: '2024-01-01T10:00:00.000+0000',
      comment: { comments: [], total: 0 }, attachment: [], issuelinks: [],
    };
    // key-ASC emits TF-3 (epic) → TF-5 (initiative) → TF-9 (story): the story
    // buffers until its epic releases; jpo-parent chains epic → initiative.
    const epic = { id: '10003', key: 'TF-3', fields: { ...base, summary: 'epic', issuetype: { id: '5', name: 'Epic' }, customfield_30005: 'TF-5', customfield_30006: 'Done' } };
    const init = { id: '10005', key: 'TF-5', fields: { ...base, summary: 'initiative', issuetype: { id: '6', name: 'Initiative' } } };
    const story = {
      id: '10009', key: 'TF-9',
      fields: {
        ...base, summary: 'story', issuetype: { id: '1', name: 'Task' },
        labels: ['native-label'],
        customfield_20004: 'TF-3',
        customfield_30001: 7,
        customfield_30002: [{ value: 'Impediment' }],
        customfield_30003: '0|i0000a:',
        customfield_30004: ['backend', 'squad-a'],
      },
    };
    const tf1 = (fx['/rest/api/2/search'] as { issues: unknown[] }).issues[0];
    fx['/rest/api/2/search'] = { issues: [tf1, epic, init, story], total: 4 };
    for (const k of ['TF-3', 'TF-5', 'TF-9']) {
      fx[`/rest/api/2/issue/${k}/worklog`] = { worklogs: [], total: 0 };
      fx[`/rest/api/2/issue/${k}/watchers`] = { watchers: [], watchCount: 0 };
      fx[`/rest/api/2/issue/${k}/votes`] = { votes: 0, voters: [] };
      fx[`/rest/api/2/issue/${k}/remotelink`] = [];
    }
    const job = await startImport(await admin(), {
      fixture: fx, source: 'jira-server', projectKeys: ['TF'], authMode: 'pat', apiToken: 'x',
    });
    let done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    for (let i = 0; i < 200 && done.stage !== 'done' && done.stage !== 'failed'; i++) {
      await getDurableRunner().flush();
      await new Promise((r) => setTimeout(r, 100));
      done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    expect(done.error, `job failed: ${done.error}`).toBeNull();
    expect(done.stage).toBe('done');
    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'TF' } });
    const [tf3, tf5, tf9] = await Promise.all([
      prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 3 } }),
      prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 5 } }),
      prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 9 } }),
    ]);
    // Native columns — not CF storage.
    expect(tf9.storyPoints).toBe(7);
    expect(tf9.rank).toBe('0|i0000a:');
    expect(tf9.labels.sort()).toEqual(['backend', 'native-label', 'squad-a']);
    // jpo-parent chains epic → initiative; generalized hierarchy promotes by
    // child level + 1 (story 0 → epic 1 → initiative 2).
    expect(tf9.parentId).toBe(tf3.id);
    expect(tf3.parentId).toBe(tf5.id);
    expect((await prisma.issueType.findFirstOrThrow({ where: { name: 'Epic' } })).hierarchyLevel).toBe(1);
    expect((await prisma.issueType.findFirstOrThrow({ where: { name: 'Initiative' } })).hierarchyLevel).toBe(2);
    // Flagged → seeded system CF value.
    const flagCf = await prisma.customField.findFirstOrThrow({ where: { alias: 'flagged' } });
    const flagVal = await prisma.customFieldValue.findUnique({
      where: { issueId_fieldId: { issueId: tf9.id, fieldId: flagCf.id } },
    });
    expect(flagVal?.value).toEqual(['Impediment']);
    // gh-epic-status imports as a real select CF carrying the value.
    const statusCf = await prisma.customField.findFirstOrThrow({ where: { name: 'Estado épica' } });
    expect(statusCf.type).toBe('select');
    const statusVal = await prisma.customFieldValue.findUnique({
      where: { issueId_fieldId: { issueId: tf3.id, fieldId: statusCf.id } },
    });
    expect((statusVal?.value as { value?: string })?.value ?? statusVal?.value).toBe('Done');
    // Column-mapped fields never materialize as generic CFs.
    expect(
      await prisma.customField.count({
        where: { name: { in: ['Puntos de historia', 'Marcado', 'Rango', 'Enlace padre', 'Etiquetas'] } },
      })
    ).toBe(0);
  });

  it('SC-004: a renamed Server user re-runs without duplicates (key is identity)', async () => {
    const fx = serverFixture({ name: 'alice-renamed', displayName: 'Alice Renamed' });
    const job = await startImport(await admin(), {
      fixture: fx, source: 'jira-server', projectKeys: ['TF'], authMode: 'pat', apiToken: 'x',
    });
    await getDurableRunner().flush();
    const done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.stage).toBe('done');
    const users = await prisma.user.findMany({ where: { email: 'jira-u1@import.local' } });
    expect(users).toHaveLength(1); // same external key → update, not a second user
  });

  it('preflight refuses a Cloud baseUrl with remediation (US1-3)', async () => {
    const job = await startImport(await admin(), {
      fixture: { '/rest/api/2/serverInfo': { deploymentType: 'Cloud', version: '1001.0.0' } },
      source: 'jira-server', projectKeys: ['TF'], authMode: 'pat', apiToken: 'x',
    });
    await getDurableRunner().flush();
    const done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.stage).toBe('failed');
    expect(done.error).toMatch(/jira-cloud/);
  });
});

// ---------- SC-001: recorded-fixture e2e at scale ----------

/** Synthetic Jira Server 9.x site: 500 issues + CFs (instance-specific ids),
 *  sprints, comments, attachments, worklogs, watchers, links. */
function bigServerFixture(n = 500): Record<string, unknown> {
  const users = Array.from({ length: 12 }, (_, i) => ({
    self: `https://jira.example.com/rest/api/2/user?key=u${i}`,
    key: `u${i}`, name: `user${i}`, displayName: `User ${i}`, active: true, avatarUrls: {},
  }));
  const issues = Array.from({ length: n }, (_, i) => {
    const num = i + 1;
    const u = users[i % users.length];
    const next = num < n ? num + 1 : null;
    return {
      id: String(20000 + num), key: `TF-${num}`,
      fields: {
        summary: `Server issue ${num}`, issuetype: { id: '1', name: 'Task' },
        status: { id: num % 3 === 0 ? '2' : '1', name: num % 3 === 0 ? 'Done' : 'To Do' },
        priority: { id: '3', name: 'Medium' }, resolution: num % 3 === 0 ? { id: '1', name: 'Done' } : null,
        assignee: u, reporter: users[(i + 1) % users.length],
        labels: [`l${i % 5}`], created: '2024-01-01T10:00:00.000+0000', updated: '2024-02-01T10:00:00.000+0000',
        comment: {
          comments: [
            { id: `${num}01`, author: u, body: 'comment a on ' + num, created: '2024-01-02T10:00:00.000+0000' },
            { id: `${num}02`, author: users[(i + 2) % users.length], body: 'wiki *markup* here', created: '2024-01-03T10:00:00.000+0000' },
          ],
          total: 2,
        },
        attachment: num <= 5
          ? [{ id: `a${num}`, filename: `f${num}.txt`, content: `https://jira.example.com/secure/attachment/a${num}` }]
          : [],
        issuelinks: next
          ? [{ id: `L${num}`, type: { id: '1', name: 'Blocks' }, outwardIssue: { id: String(20000 + next), key: `TF-${next}` } }]
          : [],
        customfield_20001: (i % 8) + 1,               // Story Points
        customfield_20002: i % 10 === 0 ? [{ value: 'Impediment' }] : null, // Flagged
        customfield_20003: [`com.atlassian.greenhopper.service.sprint.Sprint@ab12[id=5,rapidViewId=1,state=ACTIVE,name=Sprint 5]`],
        customfield_20010: { id: 'v1', value: 'Alpha' }, // Team select
      },
    };
  });
  const fixture: Record<string, unknown> = {
    '/rest/api/2/serverInfo': { version: '9.12.0', buildNumber: 912000, baseUrl: 'https://jira.example.com' },
    '/rest/api/2/field': [
      { id: 'customfield_20001', name: 'Story Points', custom: true, schema: { custom: 'x:float' } },
      { id: 'customfield_20002', name: 'Flagged', custom: true, schema: { custom: 'x:multicheckboxes' } },
      { id: 'customfield_20003', name: 'Sprint', custom: true, schema: { custom: 'gh:sprint' } },
      { id: 'customfield_20010', name: 'Team', custom: true, schema: { custom: 'x:select' } },
    ],
    '/rest/api/2/user/search': users,
    '/rest/api/2/groups/picker': { groups: [{ name: 'devs' }] },
    '/rest/api/2/group/member': { values: users.slice(0, 4) },
    '/rest/api/2/role': [],
    '/rest/api/2/project/TF': { id: '100', key: 'TF', name: 'Big Server', lead: users[0] },
    '/rest/api/2/project/TF/role': {},
    '/rest/api/2/project/TF/components': [{ id: 'c1', name: 'Backend' }, { id: 'c2', name: 'Web' }],
    '/rest/api/2/project/TF/versions': [{ id: 'v9', name: 'v9.0' }],
    '/rest/api/2/issuetype': [{ id: '1', name: 'Task' }, { id: '2', name: 'Bug' }],
    '/rest/api/2/status': [
      { id: '1', name: 'To Do', statusCategory: { key: 'new' } },
      { id: '2', name: 'Done', statusCategory: { key: 'done' } },
    ],
    '/rest/api/2/priority': [{ id: '3', name: 'Medium' }],
    '/rest/api/2/resolution': [{ id: '1', name: 'Done' }],
    '/rest/api/2/workflow': [{ name: 'default', steps: [{ id: '1', linkedStatusName: 'To Do' }] }],
    '/rest/api/2/search': { issues, total: n },
    '/rest/agile/1.0/board': { values: [{ id: 1, name: 'TF board', type: 'scrum' }] },
    '/rest/agile/1.0/board/1/configuration': { columnConfig: { columns: [] } },
    '/rest/agile/1.0/board/1/quickfilter': { values: [] },
    '/rest/agile/1.0/board/1/sprint': { values: [{ id: 5, name: 'Sprint 5', state: 'active' }] },
    '/rest/api/2/issueLinkType': { issueLinkTypes: [{ id: '1', name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }] },
    '/rest/api/2/filter/favourite': [{ id: '10', name: 'All TF', jql: 'project=TF', owner: users[0] }],
    '/rest/api/2/issuesecurityschemes': { issueSecuritySchemes: [] },
    '/rest/api/2/issuetypescheme': { issueTypeSchemes: [] },
    '/rest/api/2/issue/createmeta': {
      projects: [{ issuetypes: [{ fields: { customfield_20010: { allowedValues: [{ id: 'v1', value: 'Alpha' }, { id: 'v2', value: 'Beta' }] } } }] }],
    },
  };
  for (let num = 1; num <= n; num++) {
    fixture[`/rest/api/2/issue/TF-${num}/worklog`] = {
      worklogs: [{ id: `w${num}`, author: users[num % users.length], timeSpent: '1h', timeSpentSeconds: 3600, started: '2024-01-05T09:00:00.000+0000' }],
    };
    fixture[`/rest/api/2/issue/TF-${num}/watchers`] = { watchers: [users[num % users.length]], watchCount: 1 };
    fixture[`/rest/api/2/issue/TF-${num}/votes`] = { votes: 0, voters: [] };
    fixture[`/rest/api/2/issue/TF-${num}/remotelink`] = [];
  }
  for (let num = 1; num <= 5; num++) {
    fixture[`https://jira.example.com/secure/attachment/a${num}`] = { $binary: Buffer.from(`bytes-${num}`).toString('base64') };
  }
  return fixture;
}

describe('SC-001 recorded-fixture e2e (048)', () => {
  it('imports a 500-issue Server site with zero unexplained diffs', { timeout: 300_000 }, async () => {
    setAttachmentStore(new MemoryStore());
    const job = await startImport(await admin(), {
      fixture: bigServerFixture(), source: 'jira-server', projectKeys: ['TF'], authMode: 'pat', apiToken: 'x',
    });
    // the queued drain owns the run — flush() polls ~1s while in-flight, so
    // loop until the job reaches a terminal stage.
    let done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    for (let i = 0; i < 600 && done.stage !== 'done' && done.stage !== 'failed'; i++) {
      await getDurableRunner().flush();
      await new Promise((r) => setTimeout(r, 150));
      done = await prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    }
    expect(done.error, `job failed: ${done.error}`).toBeNull();
    expect(done.stage).toBe('done');
    const report = done.report as { applyErrors?: unknown[]; verify?: { diffs: string[] }[] };
    expect(report.applyErrors ?? []).toEqual([]);
    for (const v of report.verify ?? []) expect(v.diffs).toEqual([]);

    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'TF' } });
    expect(await prisma.issue.count({ where: { projectId: project.id } })).toBe(500);
    // entities landed: comments, worklogs, watchers, links, sprint, attachments
    const [comments, worklogs, links, attachments] = await Promise.all([
      prisma.comment.count({ where: { issue: { projectId: project.id } } }),
      prisma.worklog.count({ where: { issue: { projectId: project.id } } }),
      prisma.issueLink.count(),
      prisma.attachment.count({ where: { issue: { projectId: project.id } } }),
    ]);
    expect(comments).toBe(1000);
    expect(worklogs).toBe(500);
    expect(links).toBe(499);
    expect(attachments).toBe(5);
    const watchers = await prisma.watcher.count({ where: { issue: { projectId: project.id } } });
    expect(watchers).toBeGreaterThanOrEqual(500);
    // sprint alias resolved by name → every issue is a sprint member
    const members = await prisma.issueSprint.count({ where: { issue: { projectId: project.id } } });
    expect(members).toBe(500);
    // select CF option came from createmeta allowedValues
    const teamCf = await prisma.customField.findFirstOrThrow({ where: { name: 'Team' } });
    const ctx = await prisma.customFieldContext.findFirstOrThrow({ where: { fieldId: teamCf.id } });
    const opts = await prisma.customFieldOption.findMany({ where: { contextId: ctx.id } });
    expect(opts.map((o) => o.value)).toContain('Alpha');
    expect(opts.map((o) => o.value)).toContain('Beta');
  });
});

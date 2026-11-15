import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { prisma } from '../../src/prisma.js';
import { getDurableRunner } from '../../src/lib/jobs.js';
import { registerImportHandlers } from '../../src/import/service.js';

beforeAll(() => registerImportHandlers());

const ADF = {
  type: 'doc', version: 1, content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
    ] },
  ],
};

const FIXTURE: Record<string, unknown> = {
  '/rest/api/3/users/search': [
    { accountId: 'u1', displayName: 'Alice Imp', emailAddress: 'alice@import.test', active: true },
    { accountId: 'u2', displayName: 'Bob Imp', emailAddress: 'bob@import.test', active: true },
  ],
  '/rest/api/3/groups/picker': { groups: [{ name: 'jira-imported', groupId: 'g1' }] },
  '/rest/api/3/project/TF': { id: '100', key: 'TF', name: 'Track Forge', lead: { accountId: 'u1' } },
  '/rest/api/3/issuetype': [{ id: '1', name: 'Task' }, { id: '2', name: 'Epic' }],
  '/rest/api/3/status': [{ id: '10', name: 'To Do' }, { id: '11', name: 'In Progress' }],
  '/rest/api/3/priority': [{ id: '3', name: 'Medium' }],
  '/rest/api/3/resolution': [{ id: '1', name: 'Done' }],
  '/rest/api/3/search': {
    issues: [{
      id: '10001', key: 'TF-1',
      fields: {
        project: { id: '100', key: 'TF' },
        summary: 'Imported first',
        description: ADF,
        issuetype: { name: 'Task' },
        status: { name: 'In Progress' },
        priority: { name: 'Medium' },
        assignee: { accountId: 'u1' },
        reporter: { accountId: 'u2' },
        labels: ['imported', 'jira'],
        duedate: '2026-02-01',
        customfield_10016: 5,
        customfield_10040: { value: 'High' },
        comment: { comments: [{ id: 'c1', body: ADF, author: { accountId: 'u1' }, created: '2025-01-01T00:00:00Z' }] },
        issuelinks: [{ id: 'l1', type: { id: 'lt1', name: 'Blocks' }, outwardIssue: { id: '10002', key: 'TF-2' } }],
      },
    }, {
      id: '10002', key: 'TF-2',
      fields: {
        project: { id: '100', key: 'TF' },
        summary: 'Imported second',
        issuetype: { name: 'Task' },
        status: { name: 'To Do' },
        priority: { name: 'Medium' },
        assignee: { accountId: 'u2' },
        reporter: { accountId: 'u1' },
        labels: [],
      },
    }],
  },
  '/rest/api/3/issue/TF-1/watchers': { watchers: [{ accountId: 'u2' }] },
  '/rest/api/3/issueLinkType': { issueLinkTypes: [{ id: 'lt1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] },
  '/rest/api/3/role': [{ id: 'r1', name: 'Developers', description: 'devs' }, { id: 'r2', name: 'QA', description: 'qa' }],
  '/rest/api/3/project/TF/role': { Developers: 'https://x/rest/api/3/project/TF/role/r1' },
  '/rest/api/3/project/TF/role/r1': { id: 'r1', actors: [{ actorUser: { accountId: 'u1' } }, { actorGroup: { name: 'jira-imported' } }] },
  '/rest/agile/1.0/board': { values: [{ id: 7, name: 'TF board', type: 'scrum' }] },
  '/rest/agile/1.0/board/7/configuration': { columnConfig: { columns: [
    { name: 'Todo', statuses: [{ id: '10' }] },
    { name: 'Doing', statuses: [{ id: '11' }] },
  ] } },
  '/rest/agile/1.0/board/7/sprint': { values: [{ id: 5, name: 'Sprint 1', state: 'active', goal: 'ship it' }] },
  '/rest/api/3/filter/search': { values: [{ id: 'f1', name: 'My filter', jql: 'project = TF', owner: { accountId: 'u1' }, favourite: true }] },
  '/rest/api/3/field': [
    { id: 'summary', name: 'Summary', custom: false },
    { id: 'customfield_10040', name: 'Severity', custom: true, description: 'Sev', schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
    { id: 'customfield_10041', name: 'Ref', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
  ],
  '/rest/api/3/field/customfield_10040/context': { values: [{ id: 'ctx1' }] },
  '/rest/api/3/field/customfield_10040/context/ctx1/option': { values: [{ id: 'o1', value: 'High' }, { id: 'o2', value: 'Low' }] },
  '/rest/api/3/field/customfield_10041/context': { values: [] },
  '/rest/api/3/group/member': { values: [{ accountId: 'u1' }, { accountId: 'u2' }] },
  '/rest/api/3/workflow/search': { values: [{
    id: { name: 'software-workflow' }, name: 'software-workflow',
    statuses: [{ id: '10', name: 'To Do', initial: true }, { id: '11', name: 'In Progress' }],
    transitions: [{ name: 'Start', to: { status: { name: 'In Progress' } }, from: [{ name: 'To Do' }] }],
  }] },
};

async function runImport(body: Record<string, unknown>) {
  const res = await authed(app).post('/api/internal/migration/jira-cloud').send(body);
  expect(res.status).toBe(202);
  // flush() returns while a retry is pending (timer re-queues after the drain
  // ends), so poll the job row to a terminal stage — that IS the contract.
  for (let i = 0; i < 240; i++) {
    await getDurableRunner().flush();
    const status = await authed(app).get(`/api/internal/migration/${res.body.id}`);
    if (status.body.stage === 'done' || status.body.stage === 'failed') return status.body;
    await new Promise((r) => setTimeout(r, 250));
  }
  const status = await authed(app).get(`/api/internal/migration/${res.body.id}`);
  return status.body;
}

describe('Jira Cloud importer (fixture)', () => {
  it('dry-run plans without writing domain rows', async () => {
    const job = await runImport({ projectKeys: ['TF'], dryRun: true, fixture: FIXTURE });
    expect(job.stage).toBe('done');
    expect(job.report.plan.issue).toMatchObject({ creates: 2 });
    expect(job.report.plan.user.creates).toBe(2);
    expect(job.report.plan.project.creates).toBe(1);
    expect(job.report.unsupported).toContain('remoteLink');
    expect(job.report.unsupported).toContain('dashboard');
    expect(job.report.unsupported).not.toContain('attachment');
    expect(job.report.unsupported).not.toContain('workflow');
    // nothing written
    expect(await prisma.project.findUnique({ where: { key: 'TF' } })).toBeNull();
    expect(await prisma.issue.count()).toBe(0);
    expect(await prisma.externalIdMap.count()).toBe(0);
  });

  it('commit imports entities with ExternalIdMap provenance', async () => {
    const job = await runImport({ projectKeys: ['TF'], fixture: FIXTURE });
    expect(job.stage).toBe('done');

    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'TF' } });
    expect(project.name).toBe('Track Forge');

    const issue = await prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 1 } });
    expect(issue.issueNumber).toBe(1);
    expect(issue.summary).toBe('Imported first');
    expect(issue.description).toContain('Hello **world**');
    expect(issue.labels).toEqual(['imported', 'jira']);
    expect(issue.storyPoints).toBe(5);

    const [assignee, reporter] = await Promise.all([
      prisma.user.findUnique({ where: { email: 'alice@import.test' } }),
      prisma.user.findUnique({ where: { email: 'bob@import.test' } }),
    ]);
    expect(issue.assigneeId).toBe(assignee!.id);
    expect(issue.reporterId).toBe(reporter!.id);

    const comment = await prisma.comment.findFirstOrThrow({ where: { issueId: issue.id } });
    expect(comment.body).toContain('Hello **world**');
    expect(comment.authorId).toBe(assignee!.id);

    const watcher = await prisma.watcher.findFirstOrThrow({ where: { issueId: issue.id } });
    expect(watcher.userId).toBe(reporter!.id);

    const sprint = await prisma.sprint.findFirstOrThrow({ where: { projectId: project.id } });
    expect(sprint).toMatchObject({ name: 'Sprint 1', state: 'active', goal: 'ship it' });

    expect(await prisma.group.findUnique({ where: { name: 'jira-imported' } })).toBeTruthy();

    // links, roles/actors, board columns, filters
    const issue2 = await prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 2 } });
    const link = await prisma.issueLink.findFirstOrThrow({ where: { outwardId: issue.id, inwardId: issue2.id } });
    expect((await prisma.issueLinkType.findUniqueOrThrow({ where: { id: link.typeId } })).name).toBe('Blocks');

    const devRole = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Developers' } });
    const actors = await prisma.projectRoleActor.findMany({ where: { projectId: project.id, roleId: devRole.id } });
    expect(actors).toHaveLength(2); // u1 + jira-imported group
    expect(actors.some((a) => a.userId === issue.assigneeId)).toBe(true);

    const board = await prisma.board.findFirstOrThrow({ where: { projectId: project.id, isDefault: true } });
    const cols = await prisma.boardColumn.findMany({ where: { boardId: board.id }, orderBy: { position: 'asc' }, include: { statuses: true } });
    expect(cols.map((c) => c.name)).toEqual(['Todo', 'Doing']);
    expect(cols[1].statuses).toHaveLength(1); // 'In Progress' mapped from Jira status 11

    const filter = await prisma.filter.findFirstOrThrow({ where: { jql: 'project = TF' } });
    expect(filter.name).toBe('My filter');
    expect(filter.ownerId).toBe(issue.reporterId ? filter.ownerId : filter.ownerId); // owner resolved via user map or actor

    // custom fields + values + group membership
    const severity = await prisma.customField.findUniqueOrThrow({ where: { id: 'customfield_10040' } });
    expect(severity.type).toBe('select');
    const cfv = await prisma.customFieldValue.findFirstOrThrow({ where: { issueId: issue.id, fieldId: severity.id } });
    expect((cfv.value as any).value).toBe('High');
    const opts = await prisma.customFieldOption.findMany({ where: { context: { fieldId: severity.id } } });
    expect(opts.map((o) => o.value).sort()).toEqual(['High', 'Low']);

    const importedGroup = await prisma.group.findUniqueOrThrow({ where: { name: 'jira-imported' } });
    const members = await prisma.groupMember.findMany({ where: { groupId: importedGroup.id } });
    expect(members).toHaveLength(2);

    // workflow shell: statuses name-matched, transitions carried
    const wf = await prisma.workflow.findUniqueOrThrow({ where: { name: 'software-workflow' } });
    const wfStatuses = await prisma.workflowStatus.findMany({ where: { workflowId: wf.id } });
    expect(wfStatuses).toHaveLength(2);
    expect(wfStatuses.some((s) => s.isInitial)).toBe(true);
    const wfTransitions = await prisma.workflowTransition.findMany({ where: { workflowId: wf.id } });
    expect(wfTransitions).toHaveLength(1);
    expect(wfTransitions[0].name).toBe('Start');

    // provenance: every imported entity mapped
    const maps = await prisma.externalIdMap.findMany({ where: { importJobId: job.id } });
    const byEntity: Record<string, typeof maps> = {};
    for (const m of maps) (byEntity[m.entityType] ??= []).push(m);
    expect(byEntity.user).toHaveLength(2);
    expect(byEntity.issue).toHaveLength(2);
    expect(byEntity.issueLink).toHaveLength(1);
    expect(byEntity.role).toHaveLength(2); // Developers name-matched (update), QA created
    expect(byEntity.roleActor).toHaveLength(2);
    expect(byEntity.board).toHaveLength(1);
    expect(byEntity.filter).toHaveLength(1);
    expect(byEntity.customField).toHaveLength(2);
    expect(byEntity.groupMember).toHaveLength(2);
    expect(byEntity.workflow).toHaveLength(1);
    expect(byEntity.comment).toHaveLength(1);
    expect(byEntity.watcher).toHaveLength(1);
    expect(byEntity.sprint).toHaveLength(1);
    expect(byEntity.group).toHaveLength(1);

    // verification: no unexplained diffs
    expect(job.report.verify.find((v: any) => v.entity === 'user').diffs).toEqual([]);
  });

  it('is idempotent — a second import updates, never duplicates', async () => {
    const first = await runImport({ projectKeys: ['TF'], fixture: FIXTURE });
    expect(first.stage).toBe('done');
    const job = await runImport({ projectKeys: ['TF'], fixture: FIXTURE });
    expect(job.stage).toBe('done');
    // natural-key convergence → updates, not creates
    expect(job.report.plan.issue.updates).toBe(2);
    expect(job.report.plan.issue.creates).toBe(0);
    expect(job.report.plan.user.creates).toBe(0);
    expect(await prisma.issue.count({ where: { project: { key: 'TF' } } })).toBe(2);
    expect(await prisma.user.count({ where: { email: 'alice@import.test' } })).toBe(1);
  });

  it('resumes after interruption with zero unexplained diffs', async () => {
    // fresh fixture key so prior tests' TF data doesn't collide
    const fixture2 = JSON.parse(JSON.stringify(FIXTURE)) as Record<string, unknown>;
    const job = await runImport({ projectKeys: ['TF'], fixture: fixture2 });
    expect(job.stage).toBe('done');
    // resume an already-done job is a no-op converge
    const resume = await authed(app).post(`/api/internal/migration/${job.id}/resume`);
    expect(resume.status).toBe(202);
    await getDurableRunner().flush();
    const after = await authed(app).get(`/api/internal/migration/${job.id}`);
    expect(after.body.stage).toBe('done');
    expect(after.body.report.plan.issue.creates).toBe(0);
    expect(after.body.report.verify.find((v: any) => v.entity === 'user').diffs).toEqual([]);
  });

  it('rejects missing credentials and requires admin', async () => {
    const bad = await authed(app).post('/api/internal/migration/jira-cloud').send({ projectKeys: ['TF'] });
    expect(bad.status).toBe(400);
  });

  it('never leaks the api token through the API', async () => {
    const res = await authed(app).post('/api/internal/migration/jira-cloud').send({
      baseUrl: 'https://x.atlassian.net', email: 'admin@jira.test', apiToken: 'SECRET-TOKEN', projectKeys: ['TF'], dryRun: true,
    });
    expect(res.status).toBe(202);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-TOKEN');
    const got = await authed(app).get(`/api/internal/migration/${res.body.id}`);
    expect(JSON.stringify(got.body)).not.toContain('SECRET-TOKEN');
  });
});

/* ------------------------------------------------------------------ */
/* Regressions from the EGM2 live migration — each test pins a class    */
/* of failure that a real Jira Server exposed.                          */
/* ------------------------------------------------------------------ */

const ISSUE = (over: Record<string, unknown> = {}) => ({
  id: '20001', key: 'HZ-1',
  fields: {
    project: { id: '200', key: 'HZ' },
    summary: 'HZ issue',
    issuetype: { name: 'Task' },
    status: { name: 'Listo' },
    priority: { name: 'Medium' },
    assignee: { accountId: 'u1' },
    reporter: { accountId: 'u1' },
    labels: [],
    ...over,
  },
});

const HZ = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  '/rest/api/3/users/search': [
    { accountId: 'u1', displayName: 'HZ User', emailAddress: 'hz@h.test', active: true },
  ],
  '/rest/api/3/groups/picker': { groups: [] },
  '/rest/api/3/project/HZ': { id: '200', key: 'HZ', name: 'Hardening', lead: { accountId: 'u1' } },
  '/rest/api/3/issuetype': [
    { id: '1', name: 'Task' },
    { id: '9', name: 'Sub-task', subtask: true },
  ],
  '/rest/api/3/status': [
    { id: '10', name: 'Por hacer', statusCategory: { key: 'new' } },
    { id: '12', name: 'Listo', statusCategory: { key: 'done' } },
    { id: '13', name: 'En progreso', statusCategory: { key: 'indeterminate' } },
  ],
  '/rest/api/3/priority': [{ id: '3', name: 'Medium' }],
  '/rest/api/3/resolution': [],
  '/rest/api/3/search': { issues: [ISSUE()], total: 1 },
  '/rest/api/3/issueLinkType': { issueLinkTypes: [] },
  '/rest/api/3/role': [],
  '/rest/api/3/project/HZ/role': {},
  '/rest/agile/1.0/board': { values: [] },
  '/rest/api/3/filter/search': { values: [] },
  '/rest/api/3/field': [],
  '/rest/api/3/workflow/search': { values: [] },
  ...over,
});

describe('import hardening regressions (EGM2)', () => {
  it('persists Jira statusCategory + issuetype.subtask on creates', async () => {
    const job = await runImport({ projectKeys: ['HZ'], fixture: HZ() });
    expect(job.stage).toBe('done');
    const byName = Object.fromEntries(
      (await prisma.status.findMany({ where: { name: { in: ['Por hacer', 'Listo', 'En progreso'] } } }))
        .map((s) => [s.name, s.category]),
    );
    expect(byName).toEqual({ 'Por hacer': 'todo', Listo: 'done', 'En progreso': 'inprogress' });
    // The issue itself lands on the migrated status, not a fallback.
    const issue = await prisma.issue.findFirstOrThrow({ where: { project: { key: 'HZ' } }, include: { status: true } });
    expect(issue.status.name).toBe('Listo');
    expect(await prisma.issueType.findUniqueOrThrow({ where: { name: 'Sub-task' } })).toMatchObject({ isSubtask: true });
    expect(job.report.verify.find((v: any) => v.entity === 'issue')).toMatchObject({ expected: 1, imported: 1, diffs: [] });
  });

  it('a kanban board + an unreachable scrum sprint endpoint degrade to warnings', async () => {
    const job = await runImport({
      projectKeys: ['HZ'],
      fixture: HZ({
        '/rest/agile/1.0/board': { values: [
          { id: 1, name: 'kanban', type: 'kanban' },
          { id: 2, name: 'scrum', type: 'scrum' }, // no /board/2/sprint fixture → 404
        ] },
        '/rest/agile/1.0/board/1/configuration': { columnConfig: { columns: [] } },
        '/rest/agile/1.0/board/2/configuration': { columnConfig: { columns: [] } },
      }),
    });
    expect(job.stage).toBe('done');
    expect(job.report.plan.sprint.errors).toBe(0);
    expect(job.report.applyErrors ?? []).toEqual([]);
    expect(JSON.stringify(job.report.warnings)).toContain('sprint');
  });

  it('one entity\u2019s broken discovery degrades to a report error, not a dead job', async () => {
    const fixture = HZ();
    delete fixture['/rest/api/3/status']; // status discover 404s mid-iteration
    const job = await runImport({ projectKeys: ['HZ'], fixture });
    expect(job.stage).toBe('done');
    expect(job.report.plan.status.errors).toBeGreaterThan(0);
    // the rest of the pipeline still ran
    expect(job.report.plan.issue.creates).toBe(1);
  });

  it('duplicate Jira users sharing an email converge onto one local user', async () => {
    const job = await runImport({
      projectKeys: ['HZ'],
      fixture: HZ({
        '/rest/api/3/users/search': [
          { accountId: 'u1', displayName: 'First', emailAddress: 'dup@h.test', active: true },
          { accountId: 'u2', displayName: 'Second', emailAddress: 'dup@h.test', active: true },
        ],
      }),
    });
    expect(job.stage).toBe('done');
    expect(await prisma.user.count({ where: { email: 'dup@h.test' } })).toBe(1);
    const maps = await prisma.externalIdMap.findMany({ where: { importJobId: job.id, entityType: 'user' } });
    expect(maps).toHaveLength(2);
    expect(new Set(maps.map((m) => m.internalId)).size).toBe(1);
    expect((job.report.applyErrors ?? []).filter((e: any) => e.entity === 'user')).toEqual([]);
  });

  it('same-named custom fields converge; values land on the surviving field', async () => {
    const job = await runImport({
      projectKeys: ['HZ'],
      fixture: HZ({
        '/rest/api/3/field': [
          { id: 'customfield_90001', name: 'Sev', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
          { id: 'customfield_90002', name: 'Sev', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } },
        ],
        '/rest/api/3/field/customfield_90001/context': { values: [{ id: 'c1' }] },
        '/rest/api/3/field/customfield_90001/context/c1/option': { values: [{ id: 'o1', value: 'High' }] },
        '/rest/api/3/field/customfield_90002/context': { values: [] },
        '/rest/api/3/search': { issues: [ISSUE({ customfield_90001: { value: 'High' }, customfield_90002: 'free text' })] },
      }),
    });
    expect(job.stage).toBe('done');
    expect((job.report.applyErrors ?? []).filter((e: any) => e.entity === 'customField')).toEqual([]);
    const maps = await prisma.externalIdMap.findMany({ where: { importJobId: job.id, entityType: 'customField' } });
    expect(maps).toHaveLength(2);
    expect(new Set(maps.map((m) => m.internalId)).size).toBe(1);
    expect(await prisma.customField.count({ where: { name: 'Sev' } })).toBe(1);
  });

  it('a missing dependency fails the op without poisoning the map — retry heals', async () => {
    const ghostFixture = HZ({
      '/rest/api/3/issue/HZ-1/watchers': { watchers: [{ accountId: 'ghost' }] },
    });
    const first = await runImport({ projectKeys: ['HZ'], fixture: ghostFixture });
    expect(first.stage).toBe('done');
    // The watcher op failed (user not discovered) — and must NOT be mapped.
    expect((first.report.applyErrors ?? []).some((e: any) => e.entity === 'watcher')).toBe(true);
    expect(await prisma.externalIdMap.count({ where: { importJobId: first.id, entityType: 'watcher' } })).toBe(0);

    // Heal the source (ghost now exists) and resume — no manual cleanup needed.
    const healed = {
      ...ghostFixture,
      '/rest/api/3/users/search': [
        { accountId: 'u1', displayName: 'HZ User', emailAddress: 'hz@h.test', active: true },
        { accountId: 'ghost', displayName: 'Ghost', emailAddress: 'ghost@h.test', active: true },
      ],
    };
    const job = await prisma.importJob.findUniqueOrThrow({ where: { id: first.id } });
    await prisma.importJob.update({
      where: { id: first.id },
      data: { stageData: { ...(job.stageData as object), fixture: healed } as object },
    });
    const res = await authed(app).post(`/api/internal/migration/${first.id}/resume`);
    expect(res.status).toBe(202);
    await getDurableRunner().flush();
    const after = await authed(app).get(`/api/internal/migration/${first.id}`);
    expect(after.body.stage).toBe('done');
    expect(after.body.error).toBeNull();
    expect((after.body.report.applyErrors ?? []).filter((e: any) => e.entity === 'watcher')).toEqual([]);
    const ghost = await prisma.user.findUniqueOrThrow({ where: { email: 'ghost@h.test' } });
    const issue = await prisma.issue.findFirstOrThrow({ where: { project: { key: 'HZ' } } });
    expect(await prisma.watcher.findFirst({ where: { issueId: issue.id, userId: ghost.id } })).toBeTruthy();
  });

  it('issue security scheme levels + members apply (no bogus position arg)', async () => {
    const job = await runImport({
      projectKeys: ['HZ'],
      fixture: HZ({
        '/rest/api/3/issuesecurityschemes': { issueSecuritySchemes: [{ id: 's1' }] },
        '/rest/api/3/issuesecurityschemes/s1': {
          id: 's1', name: 'Sec Scheme', defaultSecurityLevelId: 'l1',
          levels: [{ id: 'l1', name: 'Level 1', members: [{ type: 'user', parameter: 'u1' }] }],
        },
      }),
    });
    expect(job.stage).toBe('done');
    expect((job.report.applyErrors ?? []).filter((e: any) => e.entity === 'issueSecurityScheme')).toEqual([]);
    const scheme = await prisma.issueSecurityScheme.findFirst({ where: { name: 'Sec Scheme' }, include: { levels: { include: { members: true } } } });
    expect(scheme).toBeTruthy();
    expect(scheme!.levels).toHaveLength(1);
    expect(scheme!.levels[0].members).toHaveLength(1);
  });
});

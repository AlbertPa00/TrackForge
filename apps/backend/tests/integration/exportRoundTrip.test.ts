import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { prisma } from '../../src/prisma.js';
import { getDurableRunner } from '../../src/lib/jobs.js';
import { registerImportHandlers } from '../../src/import/service.js';

beforeAll(() => registerImportHandlers());

const seed = async () => {
  const agent = await authed(app);
  const u = await prisma.user.findFirstOrThrow();
  const p = await prisma.project.create({ data: { key: 'RT', name: 'Round Trip', leadId: u.id } });
  const type = await prisma.issueType.findFirstOrThrow();
  const status = await prisma.status.findFirstOrThrow();
  const prio = await prisma.priority.findFirstOrThrow();
  const i1 = await prisma.issue.create({
    data: {
      projectId: p.id, issueNumber: 1, summary: 'Alpha', description: 'first',
      issueTypeId: type.id, statusId: status.id, priorityId: prio.id,
      reporterId: u.id, assigneeId: u.id, labels: ['x', 'y'],
    },
  });
  const i2 = await prisma.issue.create({
    data: {
      projectId: p.id, issueNumber: 2, summary: 'Beta',
      issueTypeId: type.id, statusId: status.id, priorityId: prio.id,
      reporterId: u.id, parentId: i1.id,
    },
  });
  await prisma.comment.create({ data: { issueId: i1.id, authorId: u.id, body: 'note one' } });
  const lt = await prisma.issueLinkType.findFirstOrThrow();
  await prisma.issueLink.create({ data: { typeId: lt.id, outwardId: i1.id, inwardId: i2.id } });
  await prisma.component.create({ data: { projectId: p.id, name: 'ui' } });
  const comp = await prisma.component.findFirstOrThrow({ where: { projectId: p.id } });
  await prisma.issueComponent.create({ data: { issueId: i1.id, componentId: comp.id } });
  const hist = await prisma.changeHistory.create({
    data: { issueId: i1.id, authorId: u.id, channel: 'import' },
  });
  await prisma.changeItem.create({
    data: { historyId: hist.id, field: 'status', fieldtype: 'jira', fromString: 'To Do', toString: 'Done' },
  });
  return { agent, projectId: p.id };
};

describe('039 round-trip export → reimport', () => {
  it('exports a project to a Jira-shaped fixture map', async () => {
    const { agent } = await seed();
    const res = await agent.get('/api/internal/migration/export/RT').expect(200);
    const fx = res.body.fixture as any;
    expect(fx['/rest/api/3/search'].issues).toHaveLength(2);
    const rt1 = fx['/rest/api/3/search'].issues.find((i: any) => i.key === 'RT-1');
    expect(rt1.fields.summary).toBe('Alpha');
    expect(rt1.fields.labels.sort()).toEqual(['x', 'y']);
    expect(rt1.fields.comment.comments[0].body).toBe('note one');
    expect(rt1.fields.components[0].name).toBe('ui');
    expect(rt1.fields.issuelinks).toHaveLength(1);
    expect(rt1.fields.changelog.histories).toHaveLength(1);
    const rt2 = fx['/rest/api/3/search'].issues.find((i: any) => i.key === 'RT-2');
    expect(rt2.fields.parent.key).toBe('RT-1');
    expect(fx['/rest/api/3/users/search'].length).toBeGreaterThan(0);
  });

  it('reimports the exported fixture and restores identical structure', async () => {
    const { agent } = await seed();
    const fx = (await agent.get('/api/internal/migration/export/RT').expect(200)).body.fixture;
    // wipe the project (child rows have no cascade — delete bottom-up)
    const proj = await prisma.project.findUniqueOrThrow({ where: { key: 'RT' } });
    const issueIds = (await prisma.issue.findMany({ where: { projectId: proj.id }, select: { id: true } })).map((i) => i.id);
    const histIds = (await prisma.changeHistory.findMany({ where: { issueId: { in: issueIds } }, select: { id: true } })).map((h) => h.id);
    await prisma.changeItem.deleteMany({ where: { historyId: { in: histIds } } });
    await prisma.changeHistory.deleteMany({ where: { issueId: { in: issueIds } } });
    await prisma.issueLink.deleteMany({ where: { OR: [{ outwardId: { in: issueIds } }, { inwardId: { in: issueIds } }] } });
    await prisma.issueComponent.deleteMany({ where: { issueId: { in: issueIds } } });
    await prisma.comment.deleteMany({ where: { issueId: { in: issueIds } } });
    await prisma.issue.deleteMany({ where: { projectId: proj.id } });
    await prisma.component.deleteMany({ where: { projectId: proj.id } });
    await prisma.project.delete({ where: { key: 'RT' } });
    expect(await prisma.issue.count({ where: { project: { key: 'RT' } } })).toBe(0);

    const res = await agent.post('/api/internal/migration/jira-cloud').send({
      fixture: fx, projectKeys: ['RT'],
    }).expect(202);
    await getDurableRunner().flush();
    const job = (await agent.get(`/api/internal/migration/${res.body.id}`)).body;
    expect(job.stage).toBe('done');
    expect(job.report.errors ?? []).toEqual([]);

    const p = await prisma.project.findUniqueOrThrow({ where: { key: 'RT' } });
    const issues = await prisma.issue.findMany({
      where: { projectId: p.id }, orderBy: { issueNumber: 'asc' },
      include: { comments: true, components: { include: { component: true } }, histories: { include: { items: true } }, parent: true },
    });
    expect(issues).toHaveLength(2);
    expect(issues[0].summary).toBe('Alpha');
    expect(issues[0].labels.sort()).toEqual(['x', 'y']);
    expect(issues[0].comments[0].body).toBe('note one');
    expect(issues[0].components[0].component.name).toBe('ui');
    expect(issues[1].parent?.summary).toBe('Alpha');
    const links = await prisma.issueLink.count({
      where: { OR: [{ outwardId: issues[0].id }, { inwardId: issues[0].id }] },
    });
    expect(links).toBe(1);
    const h = issues[0].histories.find((x) => x.channel === 'import');
    expect(h).toBeTruthy();
    expect(h!.items[0].field).toBe('status');
    expect(h!.items[0].toString).toBe('Done');
  });
});

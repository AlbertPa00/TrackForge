import { describe, it, expect } from 'vitest';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { prisma } from '../../src/prisma.js';

const seed = async () => {
  const a = await authed(app);
  const u = await prisma.user.findFirstOrThrow();
  const p = await prisma.project.create({ data: { key: 'RM', name: 'Roadmap', leadId: u.id } });
  const board = await prisma.board.create({ data: { projectId: p.id, name: 'RM board', type: 'scrum' } });
  const epic = await prisma.issueType.findFirstOrThrow({ where: { hierarchyLevel: 1 } });
  const story = await prisma.issueType.findFirstOrThrow({ where: { name: 'Story' } });
  const todo = await prisma.status.findFirstOrThrow({ where: { category: 'todo' } });
  const done = await prisma.status.findFirstOrThrow({ where: { category: 'done' } });
  const prio = await prisma.priority.findFirstOrThrow();
  const mk = async (n: number, typeId: string, statusId: string, extra: object = {}) =>
    prisma.issue.create({
      data: { projectId: p.id, issueNumber: n, summary: `i${n}`, issueTypeId: typeId, statusId: statusId, priorityId: prio.id, reporterId: u.id, ...extra },
    });
  const e1 = await mk(1, epic.id, todo.id, { dueDate: new Date('2026-06-01') });
  const e2 = await mk(2, epic.id, todo.id, { dueDate: new Date('2026-08-01') });
  const s1 = await mk(3, story.id, done.id, { parentId: e1.id });
  await mk(4, story.id, todo.id, { parentId: e1.id });
  await mk(5, story.id, todo.id); // unparented story — issues level only
  // startdate CF + values
  const cf = await prisma.customField.upsert({
    where: { id: 'customfield_10003' },
    update: {},
    create: { id: 'customfield_10003', seq: 10003, name: 'Start date', type: 'date', searcherType: 'date', alias: 'startdate', systemManaged: true },
  });
  await prisma.customFieldValue.create({ data: { issueId: e1.id, fieldId: cf.id, value: '2026-03-01' } });
  await prisma.customFieldValue.create({ data: { issueId: e2.id, fieldId: cf.id, value: '2026-05-15' } });
  await prisma.customFieldValue.create({ data: { issueId: s1.id, fieldId: cf.id, value: '2026-03-05' } });
  // Blocks link e1 → e2
  const lt = await prisma.issueLinkType.findFirstOrThrow();
  await prisma.issueLink.create({ data: { typeId: lt.id, outwardId: e1.id, inwardId: e2.id } });
  // version pin
  await prisma.version.create({ data: { projectId: p.id, name: 'v1.0', releaseDate: new Date('2026-07-01') } });
  return { a, board, e1, e2 };
};

describe('041 /api/internal/roadmap', () => {
  it('level=epics: bars with dates, rollup progress, links, version pins', async () => {
    const { a, board } = await seed();
    const res = await a.get(`/api/internal/roadmap/${board.id}`).expect(200);
    expect(res.body.board.projectKey).toBe('RM');
    expect(res.body.epics).toHaveLength(2);
    const e1 = res.body.epics.find((e: { key: string }) => e.key === 'RM-1');
    expect(e1.start).toBe('2026-03-01');
    expect(e1.due).toBe('2026-06-01');
    expect(e1.progress).toEqual({ done: 1, total: 2, pct: 50 });
    // e1 blocks e2 — scoped to on-screen epics
    expect(e1.links).toEqual([{ id: expect.any(String), typeId: expect.any(String), type: expect.any(String), direction: 'outward', key: 'RM-2' }]);
    expect(res.body.versions).toEqual([{ name: 'v1.0', releaseDate: '2026-07-01', released: false, startDate: null }]);
    expect(res.body.range.start <= '2026-03-01').toBe(true);
  });

  it('level=issues: every row with parent keys and subtask/standalone items', async () => {
    const { a, board } = await seed();
    const res = await a.get(`/api/internal/roadmap/${board.id}?level=issues`).expect(200);
    expect(res.body.issues).toHaveLength(5);
    const s1 = res.body.issues.find((i: { key: string }) => i.key === 'RM-3');
    expect(s1.parent).toBe('RM-1');
    expect(s1.start).toBe('2026-03-05');
    const solo = res.body.issues.find((i: { key: string }) => i.key === 'RM-5');
    expect(solo.parent).toBeNull();
    expect(solo.start).toBeNull(); // unscheduled row — UI ghost bar
  });

  it('status filter narrows rows', async () => {
    const { a, board } = await seed();
    const res = await a.get(`/api/internal/roadmap/${board.id}?level=issues&status=Done`);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].status.category).toBe('done');
  });
});

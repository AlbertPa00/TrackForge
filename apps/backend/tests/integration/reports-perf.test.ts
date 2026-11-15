// Sprint 027/028 perf gate — 50k-issue fixture, 90-day CFD < 1 s p95.
// Seeds one project/board with 50k issues and ~35k status changes, then
// times getCfd directly (service-level; HTTP adds constant overhead).
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../../src/prisma.js';
import { getCfd } from '../../src/services/reportService.js';
import { ensureTestAuth } from '../request.js';
import type { Actor } from '../../src/lib/auth.js';

const ISSUES = 50_000;
const DAYS = 90;
const P95_BUDGET_MS = 1000;

describe('reports perf gate (027/028)', () => {
  beforeEach(async () => {
    const { user } = await ensureTestAuth();
    const [todo, inprog, done] = await Promise.all(
      ['To Do', 'In Progress', 'Done'].map((name) => prisma.status.findFirstOrThrow({ where: { name } }))
    );
    const type = await prisma.issueType.findFirstOrThrow({ where: { name: 'Task' } });
    const prio = (await prisma.priority.findFirst())!;
    const project = await prisma.project.create({
      data: { key: 'PERF', name: 'Perf', projectType: 'software', leadId: user.id },
    });
    const board = await prisma.board.create({
      data: { name: 'Perf board', projectId: project.id, type: 'scrum' },
    });
    const cols = await Promise.all(
      ['To Do', 'In Progress', 'Done'].map((name, position) =>
        prisma.boardColumn.create({ data: { boardId: board.id, name, position } })
      )
    );
    await prisma.boardColumnStatus.createMany({
      data: [
        { columnId: cols[0].id, statusId: todo.id },
        { columnId: cols[1].id, statusId: inprog.id },
        { columnId: cols[2].id, statusId: done.id },
      ],
    });

    // 50k issues — deterministic ids so change rows can reference them cheaply.
    const statusIds = [todo.id, inprog.id, done.id];
    for (let b = 0; b < ISSUES; b += 5000) {
      await prisma.issue.createMany({
        data: Array.from({ length: Math.min(5000, ISSUES - b) }, (_, i) => {
          const n = b + i + 1;
          return {
            id: `perf-${n}`,
            projectId: project.id,
            issueNumber: n,
            summary: `perf ${n}`,
            issueTypeId: type.id,
            statusId: statusIds[n % 3],
            priorityId: prio.id,
            reporterId: user.id,
            createdAt: new Date(Date.now() - (n % 120) * 86400_000),
          };
        }),
      });
    }

    // ~35k status-change histories across 70% of issues (0-3 changes each).
    const histories: { id: string; issueId: string; authorId: string; createdAt: Date }[] = [];
    const items: { historyId: string; field: string; fromString: string; toString: string }[] = [];
    const names = ['To Do', 'In Progress', 'Done'];
    let h = 0;
    for (let n = 1; n <= ISSUES * 0.7; n++) {
      const changes = n % 3;
      for (let c = 0; c < changes; c++) {
        const hid = `hist-${h++}`;
        histories.push({
          id: hid,
          issueId: `perf-${n}`,
          authorId: user.id,
          createdAt: new Date(Date.now() - ((n + c * 13) % 100) * 86400_000),
        });
        items.push({
          historyId: hid,
          field: 'status',
          fromString: names[(n + c) % 3],
          toString: names[(n + c + 1) % 3],
        });
      }
    }
    for (let b = 0; b < histories.length; b += 5000) {
      await prisma.changeHistory.createMany({ data: histories.slice(b, b + 5000) });
      await prisma.changeItem.createMany({ data: items.slice(b, b + 5000) });
    }
  }, 300_000);

  it(`90-day CFD over 50k issues stays under ${P95_BUDGET_MS}ms p95`, async () => {
    const user = (await prisma.user.findFirst({ where: { isAdmin: true } }))!;
    const actor: Actor = { user, channel: 'api' };
    const board = (await prisma.board.findFirst({ where: { name: 'Perf board' } }))!;

    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const cfd = await getCfd(actor, board.id, DAYS);
      timings.push(performance.now() - t0);
      expect(cfd.series.length).toBeGreaterThan(DAYS - 2);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.floor(timings.length * 0.95) - 1] ?? timings[timings.length - 1];
     
    console.log(`[perf] getCfd 90d × 5: ${timings.map((t) => t.toFixed(0)).join('ms, ')}ms — p95 ${p95.toFixed(0)}ms`);
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 300_000);
});

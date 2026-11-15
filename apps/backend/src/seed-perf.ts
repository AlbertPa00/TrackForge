// Sprint 016 H1-d — deterministic 50k-issue fixture for perf budgets.
// Seeded PRNG => identical data on every run; createMany batches for speed.
// Usage: pnpm --filter backend seed:perf (against DATABASE_URL).

import { prisma } from './prisma.js';
import { spreadRanks } from './lib/lexorank.js';
import { ensureProjectBoard, seedPermissionDefaults, seedSystemCustomFields } from './seed.js';

const PROJECTS = 20;
const ISSUES_PER_PROJECT = 2_500; // 50k total
const COMMENTS_TARGET = 20_000;
const LINKS_TARGET = 5_000;
const CF_FRACTION = 0.3;

/** mulberry32 — small deterministic PRNG. */
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(0xc0ffee);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const chance = (p: number) => rnd() < p;

const LABELS = [
  'backend',
  'frontend',
  'api',
  'urgent',
  'customer',
  'debt',
  'perf',
  'security',
  'docs',
  'mobile',
  'infra',
  'ux',
  'regression',
  'flaky',
  'review',
  'blocked',
  'quickfix',
  'migration',
  'audit',
  'i18n',
];
const DESC = 'Deterministic perf-fixture issue. '.repeat(14);
const POINTS = [1, 2, 3, 5, 8, 13];

export async function seedPerf() {
  if (await prisma.project.findUnique({ where: { key: 'PERF01' } })) {
    console.log('perf fixture already present (PERF01 exists) — skipping');
    return;
  }
  const admin = await prisma.user.findFirst({ where: { isAdmin: true } });
  const simple = await prisma.workflow.findUnique({ where: { name: 'Simple' } });
  if (!admin || !simple) throw new Error('run db:seed first (needs admin user + Simple workflow)');

  const [task, bug, story] = await Promise.all(
    (['Task', 'Bug', 'Story'] as const).map((n) => prisma.issueType.findUniqueOrThrow({ where: { name: n } }))
  );
  const statuses = await prisma.status.findMany();
  const byCat = (c: string) => statuses.filter((s) => s.category === c);
  const priorities = await prisma.priority.findMany();
  const doneRes = await prisma.resolution.findUnique({ where: { name: 'Done' } });
  const blocks = await prisma.issueLinkType.findUniqueOrThrow({ where: { name: 'Blocks' } });
  // ~35% todo, 40% in-progress, 25% done — a realistic board mix.
  const doneIds = new Set(byCat('done').map((s) => s.id));
  const statusOf = () => {
    const r = rnd();
    const cat = r < 0.35 ? 'todo' : r < 0.75 ? 'inprogress' : 'done';
    return pick(byCat(cat)).id;
  };

  console.log('creating 20 perf projects...');
  const projects = [];
  for (let i = 1; i <= PROJECTS; i++) {
    const key = `PERF${String(i).padStart(2, '0')}`;
    const p = await prisma.project.create({
      data: { key, name: `Perf ${key}`, leadId: admin.id, workflowId: simple.id },
    });
    await ensureProjectBoard(p.id);
    projects.push(p);
  }
  await seedPermissionDefaults(); // wire the default scheme onto new projects

  // PERF01 = scrum board with sprint history for report/sprint JQL budgets.
  const p1 = projects[0]!;
  const p1Board = await prisma.board.findFirstOrThrow({ where: { projectId: p1.id } });
  await prisma.board.update({ where: { id: p1Board.id }, data: { type: 'scrum' } });
  const week = 7 * 86_400_000;
  const now = Date.now();
  const sprints = [];
  for (let i = 0; i < 6; i++) {
    sprints.push(
      await prisma.sprint.create({
        data: {
          projectId: p1.id,
          boardId: p1Board.id,
          name: `PERF01 Sprint ${i + 1}`,
          state: i < 3 ? 'closed' : i === 3 ? 'active' : 'future',
          sequence: i + 1,
          startDate: new Date(now - (6 - i) * 2 * week),
          endDate: new Date(now - (4 - i) * 2 * week),
          completeDate: i < 3 ? new Date(now - (4 - i) * 2 * week) : null,
        },
      })
    );
  }

  console.log('creating 50k issues (batches of 2500/project)...');
  for (const p of projects) {
    const ranks = spreadRanks(ISSUES_PER_PROJECT);
    const isScrum = p.id === p1.id;
    const rows = [];
    for (let n = 1; n <= ISSUES_PER_PROJECT; n++) {
      const statusId = statusOf();
      const isDone = doneIds.has(statusId);
      rows.push({
        projectId: p.id,
        issueNumber: n,
        summary: `${pick(['Fix', 'Add', 'Improve', 'Investigate', 'Refactor'])} ${pick(['login', 'search', 'export', 'pipeline', 'cache', 'billing', 'sync', 'dashboard'])} flow ${n}`,
        description: chance(0.5) ? DESC : null,
        issueTypeId: pick([task.id, bug.id, story.id]),
        statusId,
        priorityId: pick(priorities).id,
        reporterId: admin.id,
        assigneeId: chance(0.7) ? admin.id : null,
        labels: chance(0.4) ? [pick(LABELS)] : chance(0.1) ? [pick(LABELS), pick(LABELS)] : [],
        storyPoints: chance(0.6) ? pick(POINTS) : null,
        rank: ranks[n - 1]!,
        // PERF01: issues 1-1200 spread over closed/active sprints
        sprintId: isScrum && n <= 1200 ? sprints[Math.min(3, Math.floor(n / 300))]!.id : null,
        resolutionId: isDone && chance(0.8) ? doneRes?.id : null,
        resolutionDate: isDone && chance(0.8) ? new Date(now - Math.floor(rnd() * 60) * 86_400_000) : null,
      });
    }
    await prisma.issue.createMany({ data: rows });
    await prisma.project.update({ where: { id: p.id }, data: { issueCounter: ISSUES_PER_PROJECT } });
    process.stdout.write(` ${p.key}`);
  }
  console.log('\nissue sprint history...');
  // IssueSprint rows for PERF01 sprint assignments (addedAt/removedAt for closed).
  const p1Issues = await prisma.issue.findMany({
    where: { projectId: p1.id, issueNumber: { lte: 1200 } },
    select: { id: true, sprintId: true, issueNumber: true },
  });
  await prisma.issueSprint.createMany({
    data: p1Issues.map((i) => ({
      issueId: i.id,
      sprintId: i.sprintId!,
      addedAt: new Date(now - 4 * week),
      removedAt: i.issueNumber <= 900 ? new Date(now - 2 * week) : null, // closed sprints removed
    })),
  });

  console.log('comments...');
  const commentIssues = await prisma.issue.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, issueNumber: { lte: 500 } },
    select: { id: true },
  });
  const commentRows = commentIssues
    .flatMap((i) => [
      { issueId: i.id, authorId: admin.id, body: `Triage note — ${pick(LABELS)} area.` },
      { issueId: i.id, authorId: admin.id, body: 'Follow-up: verified against fixture data.' },
    ])
    .slice(0, COMMENTS_TARGET);
  for (let i = 0; i < commentRows.length; i += 5000) {
    await prisma.comment.createMany({ data: commentRows.slice(i, i + 5000) });
  }

  console.log('links...');
  const linkIssues = await prisma.issue.findMany({
    where: { projectId: p1.id, issueNumber: { lte: 600 } },
    select: { id: true },
  });
  const seen = new Set<string>();
  const linkRows = [];
  while (linkRows.length < LINKS_TARGET) {
    const a = pick(linkIssues).id;
    const b = pick(linkIssues).id;
    if (a === b) continue;
    const k = `${a}|${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    linkRows.push({ typeId: blocks.id, outwardId: a, inwardId: b });
  }
  for (let i = 0; i < linkRows.length; i += 2500) {
    await prisma.issueLink.createMany({ data: linkRows.slice(i, i + 2500) });
  }

  console.log('custom field...');
  await seedSystemCustomFields(); // ensure system CFs exist first
  const cf = await prisma.customField.create({
    data: {
      id: 'customfield_90000',
      seq: 90000,
      name: 'Perf Track',
      type: 'select',
      searcherType: 'exact',
      contexts: {
        create: {
          isGlobal: true,
          options: {
            create: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((v, i) => ({ value: v, position: i })),
          },
        },
      },
    },
    include: { contexts: { include: { options: true } } },
  });
  const ctx = cf.contexts[0]!;
  const cfIssues = await prisma.issue.findMany({
    where: { projectId: { in: projects.map((p) => p.id) } },
    select: { id: true },
    take: Math.floor(PROJECTS * ISSUES_PER_PROJECT * CF_FRACTION),
  });
  for (let i = 0; i < cfIssues.length; i += 5000) {
    await prisma.customFieldValue.createMany({
      data: cfIssues.slice(i, i + 5000).map((iss) => {
        const opt = pick(ctx.options);
        return { issueId: iss.id, fieldId: cf.id, value: { id: opt.id, value: opt.value } };
      }),
    });
  }

  console.log('done — 20 projects × 2500 issues, 20k comments, 5k links, 15k CF values, PERF01 sprints.');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  seedPerf()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

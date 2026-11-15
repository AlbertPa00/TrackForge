/**
 * Search benchmark (Sprint 010 acceptance):
 *   10,000 issues across 20 projects; JQL query latency p95 must be < 300 ms.
 *
 *   1. Start the backend (dev or test DB).
 *   2. TRACKFORGE_TOKEN=tfp_... tsx scripts/bench-search.ts
 *
 * The fixture is created once via bulk inserts (skipped on re-runs).
 * BENCH_PROJECTS/BENCH_ISSUES override the default scale.
 */
import { prisma } from '../src/prisma.js';

const BASE = process.env.TRACKFORGE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.TRACKFORGE_TOKEN ?? '';
const N_PROJECTS = Number(process.env.BENCH_PROJECTS ?? 20);
const N_ISSUES = Number(process.env.BENCH_ISSUES ?? 500); // per project
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 30); // timed queries per scenario

async function ensureFixture() {
  const existing = await prisma.project.count({ where: { key: { startsWith: 'BENCH' } } });
  if (existing >= N_PROJECTS) {
    console.log(`bench fixture present (${existing} BENCH projects)`);
    return;
  }
  console.log(`seeding bench fixture: ${N_PROJECTS} projects × ${N_ISSUES} issues…`);
  const reporter = await prisma.user.findFirst({ where: { isAdmin: true } });
  const [statuses, priorities, task] = await Promise.all([
    prisma.status.findMany({ orderBy: { sequence: 'asc' } }),
    prisma.priority.findMany({ orderBy: { sequence: 'asc' } }),
    prisma.issueType.findFirst({ where: { name: 'Task' } }),
  ]);
  if (!task || statuses.length < 2 || priorities.length < 2) {
    throw new Error('seed data missing — run the normal seed first');
  }
  const workflow = await prisma.workflow.findFirst({ orderBy: { name: 'asc' } });
  const board = await prisma.board.findFirst();

  const WORDS = ['login', 'export', 'notification', 'cache', 'sync', 'render', 'import', 'triage', 'report', 'audit'];
  for (let p = 0; p < N_PROJECTS; p++) {
    const key = `BENCH${String(p).padStart(2, '0')}`;
    const project = await prisma.project.upsert({
      where: { key },
      update: {},
      create: {
        key,
        name: `Bench Project ${p}`,
        leadId: reporter?.id,
        workflowId: workflow?.id,
      },
    });
    const rows = Array.from({ length: N_ISSUES }, (_, i) => ({
      projectId: project.id,
      issueNumber: i + 1,
      summary: `${WORDS[(p + i) % WORDS.length]} issue ${p}-${i} ${i % 7 === 0 ? 'urgent' : 'routine'}`,
      description: i % 5 === 0 ? `Detailed description for ${p}-${i} covering ${WORDS[i % WORDS.length]} and audit trail` : null,
      issueTypeId: task.id,
      statusId: statuses[(p + i) % statuses.length]!.id,
      priorityId: priorities[(p + i) % priorities.length]!.id,
      reporterId: reporter?.id,
      assigneeId: i % 3 === 0 ? reporter?.id : null,
      labels: i % 4 === 0 ? ['bench', `p${p % 5}`] : [],
      createdAt: new Date(Date.now() - ((p * N_ISSUES + i) % 90) * 86_400_000),
      updatedAt: new Date(Date.now() - (i % 30) * 86_400_000),
      rank: `0|${String(i).padStart(6, '0')}`,
    }));
    await prisma.issue.createMany({ data: rows });
    if ((p + 1) % 5 === 0) console.log(`  ${p + 1}/${N_PROJECTS} projects done`);
  }
  // ensure at least one board exists for sanity (boards not part of the bench)
  void board;
}

async function timed(jql: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/rest/api/2/search?${new URLSearchParams({ jql, maxResults: '50' })}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  await res.json();
  return performance.now() - t0;
}

function pct(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

async function main() {
  if (!TOKEN) throw new Error('TRACKFORGE_TOKEN required');
  await ensureFixture();

  const scenarios = [
    ['cross-project text search', 'text ~ "notification"'],
    ['project-scoped filter', 'project = BENCH00 AND statusCategory = "In Progress"'],
    ['boolean + order', 'project IN (BENCH01, BENCH02) AND priority = High ORDER BY created DESC, key ASC'],
    ['relative date + function', 'assignee = currentUser() AND created >= -30d ORDER BY updated DESC'],
    ['full-text + labels', 'text ~ "audit" AND labels = bench ORDER BY priority ASC'],
  ] as const;

  let allOk = true;
  console.log(`\n${ROUNDS} timed rounds per scenario (target p95 < 300 ms):`);
  for (const [name, jql] of scenarios) {
    const times: number[] = [];
    for (let i = 0; i < ROUNDS; i++) times.push(await timed(jql));
    const p50 = pct(times, 0.5), p95 = pct(times, 0.95), p99 = pct(times, 0.99);
    const ok = p95 < 300;
    if (!ok) allOk = false;
    console.log(`  ${ok ? 'ok ' : 'FAIL'} ${name.padEnd(32)} p50 ${p50.toFixed(0)}ms  p95 ${p95.toFixed(0)}ms  p99 ${p99.toFixed(0)}ms`);
  }
  await prisma.$disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

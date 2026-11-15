// Sprint 016 H1-d — query budgets on the 50k fixture (seed:perf).
// Usage: backend running + fixture seeded, then `pnpm --filter backend perf:check`.
// Budgets (sprint doc): issue GET p95<100ms, search/CF-JQL p95<300ms,
// board 500 cards p95<400ms, backlog 1k p95<500ms, permission eval p95<5ms.
// Exit 1 on breach — attach a query plan hint for the failing case.

import { prisma } from '../src/prisma.js';
import { hasPermission } from '../src/services/permissionService.js';

const BASE = process.env.TRACKFORGE_URL ?? 'http://localhost:3000';
const RUNS = 25;

const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
const budgets = { 'issue GET': 100, 'search+CF JQL': 300, 'board 500': 400, 'backlog 1k': 500, 'permission eval': 5 };

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function sample(fn: () => Promise<unknown>, n = RUNS) {
  await fn(); // warm
  const xs: number[] = [];
  for (let i = 0; i < n; i++) xs.push(await timed(fn));
  return { p50: xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!, p95: p95(xs), max: Math.max(...xs) };
}

async function main() {
  // token: env or mint via admin login
  let token = process.env.TRACKFORGE_TOKEN;
  if (!token) {
    const login = await fetch(`${BASE}/api/internal/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@trackforge.local', password: 'trackforge' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const mint = await fetch(`${BASE}/api/internal/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'perf-check', scopes: ['read', 'write', 'admin'] }),
    });
    token = (await mint.json()).secret;
  }
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const get = (path: string) => fetch(`${BASE}${path}`, { headers }).then((r) => { if (!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json(); });
  const post = (path: string, body: unknown) =>
    fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => { if (!r.ok) throw new Error(`${path} -> ${r.status}`); return r.json(); });

  const boards = await get('/rest/agile/1.0/board');
  const perfBoard = boards.values?.find((b: { name?: string }) => b.name?.includes('PERF')) ?? boards.values?.[0];
  const boardId = perfBoard?.id ?? perfBoard?.key;

  const results: { name: string; p50: number; p95: number; max: number; budget: number; ok: boolean }[] = [];
  const report = (name: keyof typeof budgets, s: { p50: number; p95: number; max: number }) =>
    results.push({ name, ...s, budget: budgets[name], ok: s.p95 < budgets[name] });

  report('issue GET', await sample(() => get('/rest/api/2/issue/PERF01-2500')));
  report('search+CF JQL', await sample(() => post('/rest/api/2/search', { jql: 'project = PERF01 AND "Perf Track" IS NOT EMPTY', maxResults: 50, fields: ['summary'] }), 15));
  report('board 500', await sample(() => get(`/rest/agile/1.0/board/${boardId}/issue?maxResults=500`), 10));
  report('backlog 1k', await sample(() => get(`/rest/agile/1.0/board/${boardId}/backlog?maxResults=1000`), 10));

  // permission eval is a service-level budget — measure in-process, not over HTTP.
  const admin = await prisma.user.findFirstOrThrow({ where: { isAdmin: true } });
  const perfProject = await prisma.project.findFirstOrThrow({ where: { key: 'PERF01' } });
  report('permission eval', await sample(
    () => hasPermission({ user: admin, channel: 'api' }, 'BROWSE_PROJECTS', { projectId: perfProject.id }),
    100,
  ));

  console.log('\nname                p50ms    p95ms    maxms    budget  result');
  let fail = 0;
  for (const r of results) {
    console.log(`${r.name.padEnd(18)} ${String(r.p50.toFixed(1)).padStart(7)} ${String(r.p95.toFixed(1)).padStart(8)} ${String(r.max.toFixed(1)).padStart(8)} ${String(r.budget).padStart(8)}  ${r.ok ? 'OK' : 'BREACH'}`);
    if (!r.ok) fail++;
  }
  if (fail) {
    // attach a query-plan hint for the breach (the doc requires plan attachment)
    const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (FORMAT TEXT) SELECT "id" FROM "Issue" WHERE "projectId" = $1 ORDER BY "rank" LIMIT 50`,
      perfProject.id,
    ).catch(() => []);
    console.error(`\n${fail} budget breach(es). Slowest path plan hint:\n${plan.map((p) => p['QUERY PLAN']).join('\n')}`);
    process.exit(1);
  }
  console.log('\nAll budgets met.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

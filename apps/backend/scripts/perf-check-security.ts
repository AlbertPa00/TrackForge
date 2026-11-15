// Sprint 031 perf gate — issue-security predicate + CF JQL on the 50k
// fixture (seed:perf). Budget: 014's search+CF JQL p95<300ms + 20% => 360ms.
//
// Measures the shared visibleIssuesWhere(actor) predicate under load:
//   A) baseline — no scheme bound (predicate composed, all rows pass the
//      unsecured branch — the cost every un-secured deployment pays).
//   B) active — scheme bound to all 20 PERF projects, ~10% of issues held
//      at a level whose ONLY member is a non-admin user. The admin token
//      then fails every member branch per secured row (worst case).
// Tears down bindings/levels afterwards so the fixture returns to baseline.
//
// Usage: backend running + `pnpm --filter backend perf:check:security`.

import { prisma } from '../src/prisma.js';

const BASE = process.env.TRACKFORGE_URL ?? 'http://localhost:3000';
const RUNS = 15;
const BUDGET_MS = 360; // 014 search+CF JQL p95 300ms + 20% (031 spec)

const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

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

async function getToken(): Promise<string> {
  if (process.env.TRACKFORGE_TOKEN) return process.env.TRACKFORGE_TOKEN;
  const login = await fetch(`${BASE}/api/internal/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@trackforge.local', password: 'trackforge' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const mint = await fetch(`${BASE}/api/internal/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'perf-check-security', scopes: ['read', 'write', 'admin'] }),
  });
  return (await mint.json()).secret;
}

async function ensureSecState(): Promise<{ schemeId: string; levelId: string; secured: number }> {
  // level whose only member is a non-admin user => admin must fail every
  // member branch for each secured row (predicate worst case).
  const member = await prisma.user.findFirstOrThrow({ where: { isAdmin: false } });
  let scheme = await prisma.issueSecurityScheme.findFirst({ where: { name: 'PERF-SEC' } });
  scheme ??= await prisma.issueSecurityScheme.create({
    data: { name: 'PERF-SEC', description: 'perf-gate scheme' },
  });
  let level = await prisma.securityLevel.findFirst({ where: { schemeId: scheme.id, name: 'Confidential' } });
  level ??= await prisma.securityLevel.create({
    data: {
      schemeId: scheme.id,
      name: 'Confidential',
      members: { create: [{ kind: 'user', ref: member.id }] },
    },
  });
  await prisma.project.updateMany({
    where: { key: { startsWith: 'PERF' } },
    data: { issueSecuritySchemeId: scheme.id },
  });
  // ~10% of issues secured — issueNumber % 10 = 0 covers every 10th issue.
  // Both columns: effSecurityLevelId is the denormalized predicate column
  // (fixture has no parents, so eff == own).
  const secured = await prisma.$executeRaw`
    UPDATE "Issue" SET "securityLevelId" = ${level.id}, "effSecurityLevelId" = ${level.id}
    WHERE "issueNumber" % 10 = 0
      AND "projectId" IN (SELECT "id" FROM "Project" WHERE "key" LIKE 'PERF%')`;
  return { schemeId: scheme.id, levelId: level.id, secured };
}

async function teardown() {
  await prisma.issue.updateMany({
    where: { project: { key: { startsWith: 'PERF' } } },
    data: { securityLevelId: null, effSecurityLevelId: null },
  });
  await prisma.project.updateMany({
    where: { key: { startsWith: 'PERF' } },
    data: { issueSecuritySchemeId: null },
  });
}

async function main() {
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown) =>
    fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => {
      if (!r.ok) throw new Error(`${path} -> ${r.status}`);
      return r.json();
    });
  const cfJql = { jql: 'project = PERF01 AND "Perf Track" IS NOT EMPTY', maxResults: 50, fields: ['summary'] };
  const plainJql = { jql: 'project = PERF01', maxResults: 50, fields: ['summary'] };

  const results: { name: string; p50: number; p95: number; max: number; budget: number; ok: boolean }[] = [];
  const report = (name: string, s: { p50: number; p95: number; max: number }) =>
    results.push({ name, ...s, budget: BUDGET_MS, ok: s.p95 < BUDGET_MS });

  // A — baseline: predicate composed but every project unbound.
  await teardown();
  report('baseline CF JQL', await sample(() => post('/rest/api/2/search', cfJql)));
  report('baseline plain JQL', await sample(() => post('/rest/api/2/search', plainJql)));

  // B — active: scheme bound + ~10% secured, admin is not a member.
  const { secured } = await ensureSecState();
  console.log(`scheme bound to 20 PERF projects, ${secured} issues secured (member: non-admin only)\n`);
  report('secured CF JQL', await sample(() => post('/rest/api/2/search', cfJql)));
  report('secured plain JQL', await sample(() => post('/rest/api/2/search', plainJql)));

  await teardown();
  console.log(`\nname                p50ms    p95ms    maxms    budget  result`);
  let fail = 0;
  for (const r of results) {
    console.log(`${r.name.padEnd(18)} ${String(r.p50.toFixed(1)).padStart(7)} ${String(r.p95.toFixed(1)).padStart(8)} ${String(r.max.toFixed(1)).padStart(8)} ${String(r.budget).padStart(8)}  ${r.ok ? 'OK' : 'BREACH'}`);
    if (!r.ok) fail++;
  }
  if (fail) {
    const plan = await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN (FORMAT TEXT) SELECT "id" FROM "Issue" WHERE "projectId" IN (SELECT "id" FROM "Project" WHERE "key" LIKE 'PERF%') ORDER BY "rank" LIMIT 50`,
    ).catch(() => []);
    console.error(`\n${fail} budget breach(es). Plan hint:\n${plan.map((p) => p['QUERY PLAN']).join('\n')}`);
    process.exit(1);
  }
  console.log('\nAll budgets met.');
}

main()
  .catch((e) => {
    console.error(e);
    teardown().finally(() => process.exit(1));
  })
  .finally(() => prisma.$disconnect());

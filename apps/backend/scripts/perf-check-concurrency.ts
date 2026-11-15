// Concurrency soak gate — N simultaneous virtual users against a live backend.
// Complements perf-check.ts (latency budgets at low concurrency): this proves
// the server stays correct under connection pressure — no 5xx, no dropped
// sockets, still healthy after the burst.
//
// Usage: backend running (+ `pnpm seed:perf` for the full 50k keyspace), then
//   pnpm --filter backend perf:check:concurrency
//
// Env:
//   TRACKFORGE_URL    default http://localhost:3000
//   TRACKFORGE_TOKEN  if unset, TOKEN_POOL PATs are minted via admin login
//   CONCURRENCY       virtual users, default 10000
//   DURATION_SEC      steady-state seconds after ramp, default 30
//   RAMP_SEC          seconds to reach full concurrency, default 10
//   REQ_TIMEOUT_MS    per-request timeout, default 15000
//   TOKEN_POOL        distinct PATs (rate-limit buckets), default ceil(C/100)
//   SSE_HOLD          extra sockets held on /events/stream for the run, default 0
//   WRITE_PCT         fraction of requests that add a comment instead, default 0
//   MAX_ERROR_RATE    tolerated failure fraction, default 0.005
//
// Gates: error rate <= MAX_ERROR_RATE (5xx + timeouts + transport errors) and
// /healthz + /readyz green after the run. 429s are reported, not failed — they
// mean the per-principal rate limit did its job (raise TOKEN_POOL or RATE_LIMIT
// for a clean run). Node's global fetch can't be used here: its undici
// dispatcher caps at ~10 sockets per origin, so the soak would be fake.

import http from 'node:http';
import https from 'node:https';

const BASE = new URL(process.env.TRACKFORGE_URL ?? 'http://localhost:3000');
const isHttps = BASE.protocol === 'https:';
const mod = isHttps ? https : http;

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10_000);
const DURATION_MS = Number(process.env.DURATION_SEC ?? 30) * 1000;
const RAMP_MS = Number(process.env.RAMP_SEC ?? 10) * 1000;
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS ?? 15_000);
const TOKEN_POOL = Math.min(200, Number(process.env.TOKEN_POOL ?? Math.ceil(CONCURRENCY / 100)));
const SSE_HOLD = Number(process.env.SSE_HOLD ?? 0);
const WRITE_PCT = Number(process.env.WRITE_PCT ?? 0);
const MAX_ERROR_RATE = Number(process.env.MAX_ERROR_RATE ?? 0.005);

const agent: http.Agent = isHttps
  ? new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY + SSE_HOLD + 64 })
  : new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY + SSE_HOLD + 64 });

type Outcome = { status: number; ms: number; fail?: 'timeout' | 'transport'; errCode?: string };
type Call = {
  method?: string;
  path: string;
  body?: string;
  token?: string;
  wantJson?: boolean;
  extraHeaders?: Record<string, string>;
};
type Result = Outcome & { headers?: http.IncomingHttpHeaders; json?: any };

function call(o: Call): Promise<Result> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let done = false;
    let timedOut = false;
    const finish = (r: Result) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const req = mod.request(
      {
        hostname: BASE.hostname,
        port: Number(BASE.port) || (isHttps ? 443 : 80),
        path: o.path,
        method: o.method ?? 'GET',
        agent,
        headers: {
          ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
          'Content-Type': 'application/json',
          ...(o.body ? { 'Content-Length': String(Buffer.byteLength(o.body)) } : {}),
          ...o.extraHeaders,
        },
      },
      (res) => {
        if (!o.wantJson) {
          res.resume(); // drain so the keep-alive socket frees up
          res.on('end', () => finish({ status: res.statusCode ?? 0, ms: performance.now() - t0, headers: res.headers }));
        } else {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let json: any;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              /* non-JSON body — json stays undefined */
            }
            finish({ status: res.statusCode ?? 0, ms: performance.now() - t0, headers: res.headers, json });
          });
        }
        res.on('close', () => finish({ status: 0, ms: performance.now() - t0, fail: 'transport', errCode: 'res-close' }));
      },
    );
    req.setTimeout(REQ_TIMEOUT_MS, () => {
      timedOut = true;
      req.destroy();
    });
    req.on('error', (e: NodeJS.ErrnoException) =>
      finish({ status: 0, ms: performance.now() - t0, fail: timedOut ? 'timeout' : 'transport', errCode: e.code ?? e.message }),
    );
    req.on('close', () =>
      finish({ status: 0, ms: performance.now() - t0, fail: timedOut ? 'timeout' : 'transport', errCode: 'req-close' }),
    );
    if (o.body) req.write(o.body);
    req.end();
  });
}

// ---- stats ----

const lat: number[] = [];
const statusHisto = new Map<number, number>();
const errKinds = { timeout: 0, transport: 0, serverErr: 0, otherErr: 0, throttled: 0 };
const errCodes = new Map<string, number>();
const epStats = new Map<string, { n: number; bad: number }>();
let inFlight = 0;
let peakInFlight = 0;
let maxMs = 0;

function record(ep: string, r: Outcome) {
  lat.push(r.ms);
  if (r.ms > maxMs) maxMs = r.ms;
  statusHisto.set(r.status, (statusHisto.get(r.status) ?? 0) + 1);
  const s = epStats.get(ep) ?? { n: 0, bad: 0 };
  s.n++;
  if (r.errCode) errCodes.set(r.errCode, (errCodes.get(r.errCode) ?? 0) + 1);
  let bad = false;
  if (r.fail === 'timeout') {
    errKinds.timeout++;
    bad = true;
  } else if (r.fail === 'transport') {
    errKinds.transport++;
    bad = true;
  } else if (r.status === 429) {
    errKinds.throttled++;
  } else if (r.status >= 500) {
    errKinds.serverErr++;
    bad = true;
  } else if (r.status < 200 || r.status >= 300) {
    errKinds.otherErr++;
    bad = true;
  }
  if (bad) s.bad++;
  epStats.set(ep, s);
}

function quantiles(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0);
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99) };
}

// ---- workload ----

interface Ctx {
  issueKey(): string;
  jql(): string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

async function discover(token: string): Promise<Ctx> {
  // perf fixture => deterministic 50k keyspace (PERF01..20, issues 1..2500)
  const probe = await call({ path: '/rest/api/2/issue/PERF01-2500?fields=summary', token });
  if (probe.status === 200) {
    console.log('perf fixture detected — using PERF keyspace');
    return {
      issueKey: () => `PERF${pad2(1 + Math.floor(Math.random() * 20))}-${1 + Math.floor(Math.random() * 2500)}`,
      jql: () => `project = PERF${pad2(1 + Math.floor(Math.random() * 20))} ORDER BY created DESC`,
    };
  }
  // generic seeded DB: grab whatever issues exist
  const r = await call({
    method: 'POST',
    path: '/rest/api/2/search',
    token,
    wantJson: true,
    body: JSON.stringify({ jql: 'created >= -3650d ORDER BY created DESC', maxResults: 50, fields: ['summary'] }),
  });
  const keys: string[] = (r.json?.issues ?? []).map((i: { key: string }) => i.key);
  if (!keys.length) throw new Error('no issues found — run db:seed or seed:perf first');
  console.log(`no perf fixture — using ${keys.length} discovered issue keys`);
  return {
    issueKey: () => keys[Math.floor(Math.random() * keys.length)]!,
    jql: () => 'created >= -3650d ORDER BY created DESC',
  };
}

function pickCall(ctx: Ctx): { name: string; method?: string; path: string; body?: string } {
  if (WRITE_PCT > 0 && Math.random() < WRITE_PCT) {
    return {
      name: 'comment POST',
      method: 'POST',
      path: `/rest/api/2/issue/${ctx.issueKey()}/comment`,
      body: JSON.stringify({ body: `concurrency soak probe ${Date.now()}` }),
    };
  }
  const r = Math.random() * 100;
  if (r < 50) return { name: 'issue GET', path: `/rest/api/2/issue/${ctx.issueKey()}` };
  if (r < 75) {
    return {
      name: 'search POST',
      method: 'POST',
      path: '/rest/api/2/search',
      body: JSON.stringify({ jql: ctx.jql(), maxResults: 50, fields: ['summary'] }),
    };
  }
  if (r < 85) return { name: 'events feed', path: '/api/internal/events?limit=50' };
  if (r < 95) return { name: 'board list', path: '/rest/agile/1.0/board' };
  return { name: 'myself', path: '/rest/api/2/myself' };
}

// ---- auth ----

async function mintTokens(n: number): Promise<string[]> {
  if (process.env.TRACKFORGE_TOKEN) return [process.env.TRACKFORGE_TOKEN];
  const login = await call({
    method: 'POST',
    path: '/api/internal/auth/login',
    body: JSON.stringify({ email: 'admin@trackforge.local', password: 'trackforge' }),
  });
  const cookie = (login.headers?.['set-cookie'] ?? [])[0]?.split(';')[0] ?? '';
  if (login.status !== 200 || !cookie) throw new Error(`admin login failed (${login.status})`);
  console.log(`minting ${n} PATs (rate-limit buckets)...`);
  const secrets: string[] = [];
  for (let i = 0; i < n; i += 10) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(10, n - i) }, (_, j) =>
        call({
          method: 'POST',
          path: '/api/internal/tokens',
          wantJson: true,
          extraHeaders: { Cookie: cookie },
          body: JSON.stringify({ name: `conc-soak-${i + j}`, scopes: ['read', 'write'] }),
        }).then((r) => String(r.json?.secret ?? '')),
      ),
    );
    secrets.push(...batch.filter(Boolean));
  }
  if (!secrets.length) throw new Error('token mint failed');
  return secrets;
}

// ---- optional SSE hold ----

const sse = { opened: 0, failed: 0, droppedEarly: 0 };
const sseReqs: http.ClientRequest[] = [];

function holdSse(token: string, until: number) {
  const req = mod.request(
    {
      hostname: BASE.hostname,
      port: Number(BASE.port) || (isHttps ? 443 : 80),
      path: '/api/internal/events/stream',
      agent,
      headers: { Authorization: `Bearer ${token}` },
    },
    (res) => {
      if (res.statusCode === 200) sse.opened++;
      else sse.failed++;
      res.on('data', () => {});
      res.on('close', () => {
        if (performance.now() < until) sse.droppedEarly++;
      });
    },
  );
  req.setTimeout(0);
  req.on('error', () => sse.failed++);
  req.end();
  sseReqs.push(req);
}

// ---- main ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tokens = await mintTokens(TOKEN_POOL);
  const ctx = await discover(tokens[0]!);
  const endAt = performance.now() + RAMP_MS + DURATION_MS;

  console.log(
    `\nsoak: ${CONCURRENCY} users | ramp ${RAMP_MS / 1000}s | hold ${DURATION_MS / 1000}s | ` +
      `tokens ${tokens.length} | write ${WRITE_PCT * 100}% | sse ${SSE_HOLD}`,
  );

  for (let i = 0; i < SSE_HOLD; i++) holdSse(tokens[i % tokens.length]!, endAt);

  const t0 = performance.now();
  const progress = setInterval(() => {
    const el = (performance.now() - t0) / 1000;
    const errs = errKinds.timeout + errKinds.transport + errKinds.serverErr + errKinds.otherErr;
    console.log(
      `  ${el.toFixed(0).padStart(4)}s  in-flight ${String(inFlight).padStart(6)}  done ${lat.length}  ` +
        `rps ${(lat.length / el).toFixed(0)}  err ${errs}  429 ${errKinds.throttled}`,
    );
  }, 5000);

  const worker = async (id: number) => {
    const token = tokens[id % tokens.length]!;
    await sleep((id / CONCURRENCY) * RAMP_MS);
    while (performance.now() < endAt) {
      const c = pickCall(ctx);
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      const r = await call({ ...c, token });
      inFlight--;
      record(c.name, r);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
  clearInterval(progress);
  const wall = (performance.now() - t0) / 1000;
  for (const r of sseReqs) r.destroy();

  // ---- report ----

  const total = lat.length;
  const failures = errKinds.timeout + errKinds.transport + errKinds.serverErr + errKinds.otherErr;
  const errRate = total ? failures / total : 1;
  console.log(`\ntotal ${total} req | ${wall.toFixed(1)}s wall | ${(total / wall).toFixed(0)} rps | peak in-flight ${peakInFlight}`);
  const qs = quantiles(lat);
  console.log(`lat  p50 ${qs.p50.toFixed(0)}ms  p95 ${qs.p95.toFixed(0)}ms  p99 ${qs.p99.toFixed(0)}ms  max ${maxMs.toFixed(0)}ms`);
  console.log(`status: ${[...statusHisto.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s || 'ERR'}×${n}`).join('  ')}`);
  console.log(`errors: timeout ${errKinds.timeout} | transport ${errKinds.transport} | 5xx ${errKinds.serverErr} | other ${errKinds.otherErr} | 429 ${errKinds.throttled}`);
  if (errCodes.size) {
    console.log(`err codes: ${[...errCodes.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join('  ')}`);
  }
  console.log('\nendpoint           n         rps      bad');
  for (const [name, s] of [...epStats.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${name.padEnd(15)} ${String(s.n).padStart(9)} ${(s.n / wall).toFixed(0).padStart(8)} ${String(s.bad).padStart(8)}`);
  }
  if (SSE_HOLD) console.log(`\nSSE hold: ${sse.opened}/${SSE_HOLD} opened, ${sse.droppedEarly} dropped early, ${sse.failed} failed`);

  // post-run health — did the server survive?
  const hz = await call({ path: '/healthz' });
  const rz = await call({ path: '/readyz' });
  console.log(`\npost-run: healthz ${hz.status} readyz ${rz.status}`);

  let fail = 0;
  if (errRate > MAX_ERROR_RATE) {
    console.error(`GATE BREACH: error rate ${(errRate * 100).toFixed(2)}% > ${MAX_ERROR_RATE * 100}%`);
    fail++;
  }
  if (hz.status !== 200 || rz.status !== 200) {
    console.error('GATE BREACH: server unhealthy after soak');
    fail++;
  }
  if (errKinds.throttled > total * 0.01) {
    console.warn(`note: ${errKinds.throttled} req 429'd — raise TOKEN_POOL (now ${tokens.length}) or RATE_LIMIT for a cleaner run`);
  }
  console.log(fail ? `\n${fail} gate breach(es).` : '\nConcurrency gate: PASS');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

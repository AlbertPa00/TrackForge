import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { getDurableRunner, resetDurableRunner, withAdvisoryLock } from '../../src/lib/jobs.js';
import { ensureTestAuth, authed } from '../request.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pin the in-memory adapter — Prisma auto-loads .env, so a dev's REDIS_URL
// would otherwise flip the factory to BullMQ and break the timing assertions.
// '' (not delete): the var must stay present or a later file's .env load
// re-injects the dev URL — falsy still selects the in-memory runner.
let savedRedis: string | undefined;
beforeAll(() => {
  savedRedis = process.env.REDIS_URL;
  process.env.REDIS_URL = '';
  resetDurableRunner();
});
afterAll(() => {
  process.env.REDIS_URL = savedRedis ?? '';
  resetDurableRunner();
});

describe('016 ops surface', () => {
  beforeAll(async () => {
    await ensureTestAuth();
  });

  it('GET /healthz liveness without auth', async () => {
    const r = await request(app).get('/healthz').expect(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('GET /readyz reports db+jobs ok', async () => {
    const r = await request(app).get('/readyz').expect(200);
    expect(r.body.status).toBe('ready');
    expect(r.body.checks.db).toBe('ok');
    expect(r.body.checks.jobs).toBe('ok');
  });

  it('GET /metrics emits prometheus text', async () => {
    await request(app).get('/healthz');
    const r = await request(app).get('/metrics').expect(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.text).toContain('tf_requests_total');
    expect(r.text).toContain('tf_request_latency_ms_bucket');
    expect(r.text).toContain('tf_job_queue');
    expect(r.text).toContain('tf_outbox_undispatched');
    expect(r.text).toContain('tf_backup_last_success_seconds');
  });

  it('GET /metrics honors METRICS_BEARER gate (044 US2-3)', async () => {
    process.env.METRICS_BEARER = 'test-bearer-token';
    try {
      await request(app).get('/metrics').expect(401);
      await request(app).get('/metrics')
        .set('Authorization', 'Bearer wrong').expect(401);
      await request(app).get('/metrics')
        .set('Authorization', 'Bearer test-bearer-token').expect(200);
    } finally {
      delete process.env.METRICS_BEARER;
    }
  });
});

describe('016 DurableRunner', () => {
  it('enqueues, dedupes by key, retries failed jobs', async () => {
    const runner = getDurableRunner();
    let runs = 0;
    runner.register('test.echo', async () => { runs += 1; });

    const j1 = await runner.enqueue('test.echo', { a: 1 }, { key: 'k1' });
    const dup = await runner.enqueue('test.echo', { a: 1 }, { key: 'k1' });
    expect(j1).not.toBeNull();
    expect(dup).toBeNull(); // deduped

    await sleep(20);
    const done = await runner.get(j1!.id);
    expect(done?.state).toBe('completed');
    expect(runs).toBe(1);
  });

  it('retries with backoff then dead-letters after 3 attempts', async () => {
    const runner = getDurableRunner();
    runner.register('test.fail', async () => { throw new Error('boom'); });
    const j = await runner.enqueue('test.fail', {}, { key: 'k-fail' });
    await sleep(400);
    const failed = await runner.get(j!.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.attemptsMade).toBe(3);
    expect(failed?.failedReason).toContain('boom');
  });

  it('admin jobs API lists/gets/retries; non-admin forbidden', async () => {
    const runner = getDurableRunner();
    let runs = 0;
    let shouldFail = true;
    runner.register('test.retry', async () => {
      runs += 1;
      if (shouldFail) throw new Error('first run fails');
    });
    const j = await runner.enqueue('test.retry', {}, { key: 'k-retry' });
    await sleep(400); // 3 attempts + backoff → dead-lettered
    expect((await runner.get(j!.id))?.state).toBe('failed');

    await request(app).get('/api/internal/admin/jobs').expect(401);

    const list = await authed(app)
      .get('/api/internal/admin/jobs?state=failed')
      .expect(200);
    const found = list.body.jobs.find((x: { id: string }) => x.id === j!.id);
    expect(found).toBeTruthy();

    shouldFail = false;
    await authed(app)
      .post(`/api/internal/admin/jobs/${j!.id}/retry`)
      .expect(202);
    await sleep(30);
    expect((await runner.get(j!.id))?.state).toBe('completed');
    expect(runs).toBe(4);
  });

  it('dedupe key releases at terminal state so periodic ticks re-enqueue', async () => {
    const runner = getDurableRunner();
    let runs = 0;
    runner.register('test.periodic', async () => { runs += 1; });
    const a = await runner.enqueue('test.periodic', {}, { key: 'k-per' });
    await sleep(30);
    expect((await runner.get(a!.id))?.state).toBe('completed');
    const b = await runner.enqueue('test.periodic', {}, { key: 'k-per' });
    expect(b).not.toBeNull(); // completed job's key is free again
    await sleep(30);
    expect(runs).toBe(2);
  });
});

describe('016 multi-instance single-exec (SC-001)', () => {
  it('advisory lock admits exactly one of two concurrent tick contenders', async () => {
    let ran = 0;
    const slow = async () => {
      ran += 1;
      await sleep(120); // hold the lock long enough to overlap
    };
    const [r1, r2] = await Promise.all([withAdvisoryLock('test.lock', slow), withAdvisoryLock('test.lock', slow)]);
    expect(ran).toBe(1);
    expect([r1, r2].filter((r) => r !== null).length).toBe(1);
  });
});

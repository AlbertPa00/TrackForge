import { describe, it, expect, afterAll } from 'vitest';
import { BullMQDurableRunner } from '../../src/lib/jobsBullmq.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// vitest forces REDIS_URL empty; the live suite opts in via REDIS_URL_TEST.
const REDIS = process.env.REDIS_URL_TEST;

/**
 * Live BullMQ adapter check — runs only when REDIS_URL_TEST is set (dev with
 * the compose Redis service, or a CI job that provisions one). Otherwise the
 * in-memory adapter covers the port contract.
 */
describe.skipIf(!REDIS)('016 BullMQDurableRunner (live Redis)', () => {
  const runner = new BullMQDurableRunner(REDIS!);
  afterAll(async () => {
    await runner.queue?.obliterate?.().catch(() => {});
    await runner.close();
  });

  it('enqueues and completes with idempotency dedupe', async () => {
    let runs = 0;
    runner.register('bm.echo', async () => { runs += 1; });
    const j = await runner.enqueue('bm.echo', { n: 1 }, { key: `t-${Date.now()}` });
    expect(j).not.toBeNull();
    const dup = await runner.enqueue('bm.echo', { n: 1 }, { key: j!.id });
    expect(dup).toBeNull();

    for (let i = 0; i < 50 && (await runner.get(j!.id))?.state !== 'completed'; i++) await sleep(100);
    expect((await runner.get(j!.id))?.state).toBe('completed');
    expect(runs).toBe(1);
  });

  it('dead-letters after attempts and retry() requeues', async () => {
    let runs = 0;
    let fail = true;
    runner.register('bm.retry', async () => {
      runs += 1;
      if (fail) throw new Error('boom');
    });
    const j = await runner.enqueue('bm.retry', {}, { attempts: 2 });
    for (let i = 0; i < 80 && (await runner.get(j!.id))?.state !== 'failed'; i++) await sleep(100);
    const failed = await runner.get(j!.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.attemptsMade).toBe(2);

    fail = false;
    await runner.retry(j!.id);
    for (let i = 0; i < 50 && (await runner.get(j!.id))?.state !== 'completed'; i++) await sleep(100);
    expect((await runner.get(j!.id))?.state).toBe('completed');
    expect(runs).toBe(3);

    const listed = await runner.list('completed');
    expect(listed.some((x) => x.id === j!.id)).toBe(true);
  });
});

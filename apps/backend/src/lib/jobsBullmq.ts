import { Queue, Worker, type Job as BullJob, type JobsOptions } from 'bullmq';
import type { Job, JobOptions } from './jobs.js';
import { logger } from './logger.js';

/** Shared surface both adapters expose (016 FR-001 port). */
export interface DurablePort {
  register(name: string, handler: (p: unknown, j: Job) => Promise<void>): void;
  enqueue(name: string, payload: unknown, opts?: JobOptions): Promise<Job | null>;
  list(state?: string): Promise<Job[]>;
  get(id: string): Promise<Job | null>;
  retry(id: string): Promise<void>;
  /** Drain queued work — synchronous for the memory adapter, best-effort wait for BullMQ. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

type BullState = Job['state'];
function mapState(s: string): BullState {
  if (s === 'wait' || s === 'delayed' || s === 'waiting-children' || s === 'paused') return 'waiting';
  if (s === 'completed' || s === 'failed' || s === 'active') return s;
  return 'waiting';
}

async function mapBull(b: BullJob): Promise<Job> {
  return {
    id: b.id ?? '',
    name: b.name,
    payload: b.data,
    key: b.id,
    attemptsMade: b.attemptsMade,
    failedReason: b.failedReason || undefined,
    state: mapState(await b.getState()),
  };
}

/**
 * Production adapter (016): BullMQ on Redis. `jobId = key` dedupes in-flight
 * enqueues; `attempts`+exponential backoff give at-least-once with dead-letter;
 * a single shared queue + Worker gives cluster-wide distribution.
 */
export class BullMQDurableRunner implements DurablePort {
  readonly queue: Queue; // exposed for tests/ops (e.g. obliterate)
  private worker: Worker;
  private handlers = new Map<string, (p: unknown, j: Job) => Promise<void>>();

  constructor(redisUrl: string) {
    const connection = { url: redisUrl };
    this.queue = new Queue('trackforge', {
      connection,
      defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
    });
    this.worker = new Worker(
      'trackforge',
      async (b) => {
        const handler = this.handlers.get(b.name);
        if (!handler) throw new Error(`No handler for job '${b.name}'`);
        await handler(b.data, await mapBull(b));
      },
      { connection, concurrency: 4 }
    );
    this.worker.on('failed', (b, err) => {
      logger.warn({ jobId: b?.id, name: b?.name, err: String(err) }, 'job failed');
    });
  }

  register(name: string, handler: (p: unknown, j: Job) => Promise<void>) {
    this.handlers.set(name, handler);
  }

  async enqueue(name: string, payload: unknown, opts: JobOptions = {}): Promise<Job | null> {
    const addOpts: JobsOptions = {
      attempts: opts.attempts ?? 3,
      backoff: { type: 'exponential', delay: 100 },
      ...(opts.key ? { jobId: opts.key } : {}),
    };
    if (opts.key) {
      const existing = await this.queue.getJob(opts.key);
      if (existing) {
        const st = mapState(await existing.getState());
        if (st === 'waiting' || st === 'active') return null; // deduped in-flight
        // Terminal job with the same key (e.g. a periodic tick) — remove so a
        // fresh run can be enqueued. BullMQ dedupes jobId forever otherwise.
        await existing.remove().catch(() => {});
      }
    }
    const j = await this.queue.add(name, payload, addOpts);
    return mapBull(j);
  }

  async list(state?: string): Promise<Job[]> {
    const states = state
      ? [state === 'waiting' ? 'wait' : (state as 'active' | 'completed' | 'failed' | 'wait')]
      : ['wait', 'active', 'completed', 'failed', 'delayed'];
    const jobs = await this.queue.getJobs(states as never);
    return Promise.all(jobs.map(mapBull));
  }

  async get(id: string): Promise<Job | null> {
    const j = await this.queue.getJob(id);
    return j ? mapBull(j) : null;
  }

  async retry(id: string): Promise<void> {
    const j = await this.queue.getJob(id);
    await j?.retry();
  }

  /** Best-effort: wait until the queue has no waiting/active jobs (≈2s cap). */
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const pending = await this.queue.getJobs(['wait', 'active', 'delayed']);
      if (pending.length === 0) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}

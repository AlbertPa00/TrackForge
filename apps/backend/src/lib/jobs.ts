// JobRunner port (FR-006) — the outbox dispatcher and periodic jobs sit behind
// this interface so Sprint 016 can swap the in-process adapter for the shared
// Redis+BullMQ runner without touching event producers.

import { prisma } from '../prisma.js';
import { BullMQDurableRunner, type DurablePort } from './jobsBullmq.js';

export interface JobRunner {
  register(name: string, fn: () => Promise<void>, intervalMs: number): void;
  start(): void;
  stop(): void;
  /** Exposed for tests — run one dispatch+deliver cycle synchronously. */
  runOnce(name: string): Promise<void>;
}

class InProcessJobRunner implements JobRunner {
  private jobs = new Map<
    string,
    { fn: () => Promise<void>; intervalMs: number; timer?: NodeJS.Timeout; lastRun: number }
  >();
  private running = false;

  register(name: string, fn: () => Promise<void>, intervalMs: number) {
    this.jobs.set(name, { fn, intervalMs, lastRun: 0 });
  }

  start() {
    if (this.running) return;
    this.running = true;
    for (const [name, job] of this.jobs) {
      const loop = async () => {
        if (!this.running) return;
        try {
          await job.fn();
        } catch (e) {
          console.error(`[jobs] ${name} failed:`, e);
        }
        const j = this.jobs.get(name);
        if (j && this.running) j.timer = setTimeout(loop, j.intervalMs);
      };
      // stagger starts so jobs don't stampede on boot
      job.timer = setTimeout(loop, Math.min(job.intervalMs, 250 + Math.random() * 500));
    }
  }

  stop() {
    this.running = false;
    for (const j of this.jobs.values()) if (j.timer) clearTimeout(j.timer);
  }

  async runOnce(name: string) {
    const j = this.jobs.get(name);
    if (j) await j.fn();
    // Ticks enqueue onto the durable runner — drain it so tests that await
    // runOnce observe the job's effects synchronously.
    await (durableRunner as { flush?: () => Promise<void> } | null)?.flush?.();
  }
}

export const jobRunner: JobRunner = new InProcessJobRunner();

// ---------- advisory lock (the multi-instance mechanism — see docs/ha.md) ----------

// 065 audit G3 — distinct lock key per job type. Every periodic job used to
// share one key, so a long job didn't just serialize siblings: try-lock
// failures silently SKIPPED their ticks entirely.
function lockKeyFor(name: string): number {
  // FNV-1a 32-bit — stable across restarts; collision-cost is a missed tick.
  let h = 0x811c9dc5;
  for (const c of `tf-job:${name}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2_147_483_647; // int4-safe — pg accepts (bigint) keys
}

/**
 * Runs `fn` under a transaction-scoped advisory lock. `pg_try_advisory_xact_lock`
 * pins the lock to the interactive-transaction connection (Prisma guarantees
 * single-connection transactions) and auto-releases at commit — safe under the
 * connection pool, where session-level lock/unlock could land on different
 * pooled connections and leak the lock.
 *
 * 065 audit G3 — the transaction carries an EXPLICIT timeout (default 5 min;
 * Prisma's interactive default is 5s and used to kill long-running jobs
 * mid-flight, releasing the lock and stranding job state).
 */
export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { timeoutMs?: number } = {}
): Promise<T | null> {
  const key = lockKeyFor(name);
  return prisma.$transaction(
    async (tx) => {
      const got = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${key}) AS locked`;
      if (!got[0]?.locked) return null; // another instance holds the lock
      return fn();
    },
    { timeout: opts.timeoutMs ?? 300_000 }
  );
}

// ---------- Sprint 016: durable jobs (enqueue/retry/inspect) ----------

export interface JobOptions {
  key?: string; // idempotency key — dedupes while queued/running
  attempts?: number; // default 3
}
export interface Job {
  id: string;
  name: string;
  payload: unknown;
  key?: string; // idempotency key (BullMQ jobId) — dedupes while in-flight
  attemptsMade: number;
  failedReason?: string;
  state: 'waiting' | 'active' | 'completed' | 'failed';
}

/**
 * Deterministic in-memory durable runner (016 dev/test adapter). The BullMQ
 * adapter (prod, REDIS_URL) implements the same surface — see
 * docs/hardening-backlog.md.
 */
export class DurableRunner {
  private handlers = new Map<string, (p: unknown, j: Job) => Promise<void>>();
  private jobs = new Map<string, Job>();
  private queued: string[] = [];
  private keys = new Set<string>();
  private seq = 0;
  private running = false;
  private timers: NodeJS.Timeout[] = [];

  register(name: string, handler: (p: unknown, j: Job) => Promise<void>) {
    this.handlers.set(name, handler);
  }

  async enqueue(name: string, payload: unknown, opts: JobOptions = {}): Promise<Job | null> {
    if (opts.key && this.keys.has(opts.key)) return null; // deduped
    const job: Job = { id: `mem-${++this.seq}`, name, payload, key: opts.key, attemptsMade: 0, state: 'waiting' };
    this.jobs.set(job.id, job);
    if (opts.key) this.keys.add(opts.key);
    this.queued.push(job.id);
    queueMicrotask(() => void this.drain());
    return job;
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.queued.shift(); id; id = this.queued.shift()) {
        const job = this.jobs.get(id);
        if (!job || job.state !== 'waiting') continue;
        const handler = this.handlers.get(job.name);
        job.state = 'active';
        job.attemptsMade += 1;
        try {
          if (!handler) throw new Error(`No handler for job '${job.name}'`);
          await handler(job.payload, job);
          job.state = 'completed';
        } catch (e) {
          job.failedReason = String(e);
          job.state = job.attemptsMade >= 3 ? 'failed' : 'waiting';
          if (job.state === 'waiting') {
            this.timers.push(
              setTimeout(() => {
                this.queued.push(job.id);
                void this.drain();
              }, 50 * job.attemptsMade)
            );
          }
        }
        // Release the dedupe key on terminal state — otherwise a periodic
        // job (same key every tick) could only ever run once. Retry-pending
        // jobs keep their key so duplicates can't double-queue.
        if (job.state !== 'waiting' && job.key) this.keys.delete(job.key);
      }
    } finally {
      this.running = false;
      // 065 audit G9 — the dev runner accumulated every finished job forever.
      // Bound the map: oldest terminal entries drop past the newest 500.
      if (this.jobs.size > 500) {
        let drop = this.jobs.size - 500;
        for (const [id, j] of this.jobs) {
          if (drop <= 0) break;
          if (j.state === 'completed' || j.state === 'failed') {
            this.jobs.delete(id);
            drop--;
          }
        }
      }
      if (this.queued.length) void this.drain();
    }
  }

  async list(state?: string) {
    return [...this.jobs.values()].filter((j) => !state || j.state === state);
  }
  async get(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async retry(id: string) {
    const j = this.jobs.get(id);
    if (j) {
      j.state = 'waiting';
      j.failedReason = undefined;
      this.queued.push(id);
      void this.drain();
    }
  }
  /** Test/ops hook — run the queued backlog to empty (incl. in-flight drain). */
  async flush() {
    for (let i = 0; i < 200; i++) {
      if (!this.running && this.queued.length === 0) return;
      if (!this.running) await this.drain();
      else await new Promise((r) => setTimeout(r, 5));
    }
  }

  async close() {
    this.timers.forEach(clearTimeout);
  }
}

/**
 * 072 — probed failover adapter. `BullMQDurableRunner` connects lazily and
 * never fails fast on a dead Redis: ticks silently vanish and the outbox
 * stalls (observed live: 26 undispatched events, zero inbox materialization).
 * This wrapper probes Redis health and falls back to the Postgres/in-process
 * runner — ticks then run locally and handlers still serialize on the
 * Postgres advisory lock, so multi-instance correctness is preserved.
 */
export class FailoverRunner implements DurablePort {
  private bull: BullMQDurableRunner;
  private mem = new DurableRunner();
  private degraded = false;
  private probing = false;
  private lastProbeAt = 0;
  private lastError: string | null = null;
  private probeTimer: NodeJS.Timeout;

  constructor(private redisUrl: string) {
    this.bull = new BullMQDurableRunner(redisUrl);
    // Periodic health probe — flips runner mode both ways without restart.
    this.probeTimer = setInterval(() => void this.probe(), 5_000);
    this.probeTimer.unref?.();
    void this.probe();
  }

  private async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      await Promise.race([
        this.bull.queue.getJobCounts(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('redis probe timeout')), 1_000)),
      ]);
      if (this.degraded) console.warn('[jobs] redis recovered — durable runner back to bullmq');
      this.degraded = false;
      this.lastError = null;
    } catch (e) {
      if (!this.degraded) console.error('[jobs] redis unreachable — durable runner degraded to postgres fallback:', e);
      this.degraded = true;
      this.lastError = String(e instanceof Error ? e.message : e);
    } finally {
      this.lastProbeAt = Date.now();
      this.probing = false;
    }
  }

  private active(): DurablePort {
    return this.degraded ? this.mem : this.bull;
  }

  register(name: string, handler: (p: unknown, j: Job) => Promise<void>): void {
    // Both runners always get the handler so a mid-flight failover keeps
    // ticking — the Postgres advisory lock prevents double execution.
    this.bull.register(name, handler);
    this.mem.register(name, handler);
  }

  async enqueue(name: string, payload: unknown, opts: JobOptions = {}): Promise<Job | null> {
    try {
      const job = await Promise.race([
        this.active().enqueue(name, payload, opts),
        new Promise<Job | null>((_, rej) => setTimeout(() => rej(new Error('enqueue timeout')), 1_000)),
      ]);
      if (job !== null) return job;
      // BullMQ deduped (returned null) — nothing to do.
      if (!this.degraded) return null;
      return this.mem.enqueue(name, payload, opts);
    } catch (e) {
      if (!this.degraded) {
        console.error('[jobs] enqueue failed — switching to postgres fallback:', e);
        this.degraded = true;
        this.lastError = String(e instanceof Error ? e.message : e);
      }
      return this.mem.enqueue(name, payload, opts);
    }
  }

  list(state?: string) {
    return this.active().list(state);
  }
  get(id: string) {
    return this.active().get(id);
  }
  retry(id: string) {
    return this.active().retry(id);
  }
  async flush() {
    await this.active().flush();
    if (this.degraded) await this.mem.flush();
  }
  async close() {
    clearInterval(this.probeTimer);
    await Promise.allSettled([this.bull.close(), this.mem.close()]);
  }

  status() {
    return {
      mode: this.degraded ? ('postgres_fallback' as const) : ('bullmq' as const),
      degraded: this.degraded,
      lastProbeAt: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      lastError: this.lastError,
    };
  }
}

let durableRunner: DurablePort | null = null;
/**
 * 016 FR-001: the durable-job port. BullMQ on Redis when `REDIS_URL` is set
 * (prod / multi-instance), deterministic in-memory otherwise (dev, tests).
 * 072 — wrapped in FailoverRunner so a dead Redis degrades instead of
 * silently stalling the outbox.
 */
export function getDurableRunner(): DurablePort {
  if (!durableRunner) {
    durableRunner = process.env.REDIS_URL ? new FailoverRunner(process.env.REDIS_URL) : new DurableRunner();
  }
  return durableRunner;
}

/** 072 — runner health for /fleet/health. */
export function runnerStatus(): { mode: string; degraded: boolean; lastProbeAt: string | null; lastError: string | null } {
  const r = getDurableRunner();
  if (r instanceof FailoverRunner) return r.status();
  return { mode: process.env.REDIS_URL ? 'bullmq' : 'inprocess', degraded: false, lastProbeAt: null, lastError: null };
}
/** Test hook — force a fresh adapter (e.g. after changing REDIS_URL). */
export function resetDurableRunner() {
  void durableRunner?.close();
  durableRunner = null;
}

import { beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import { prisma } from '../src/prisma.js';
import {
  seedMetadata,
  seedWorkflows,
  seedSystemCustomFields,
  seedPermissionDefaultsImpl,
  enqueueSeedTask,
} from '../src/seed.js';
import { getDurableRunner } from '../src/lib/jobs.js';
import { invalidateJqlCtxCache } from '../src/jql/ctxCache.js';
import { ensureTestAuth } from './request.js';

// Every supertest request used to open AND close its own loopback socket
// (globalAgent has keepAlive: false) — thousands of TIME_WAIT sockets per
// suite, and under load a connect() occasionally timed out (ETIMEDOUT, the
// "concurrent creates" flake). One keep-alive pool reuses sockets instead.
const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
http.globalAgent = keepAliveAgent;

/**
 * Fast wipe: one statement, one implicit transaction. session_replication_role
 * 'replica' suspends FK triggers for the transaction's duration, so tables can
 * be deleted in any order (~5ms vs ~500ms for TRUNCATE over 55 tables).
 * Requires a superuser test DB role; falls back to TRUNCATE … CASCADE if the
 * test database's role lacks the privilege.
 */
const DELETE_ALL_SQL = `DO $$ DECLARE r RECORD; BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  FOR r IN SELECT tablename FROM pg_tables
           WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  LOOP EXECUTE 'DELETE FROM ' || quote_ident(r.tablename); END LOOP;
END $$`;

let truncateSql: string | null = null;

async function wipeDb() {
  if (!truncateSql) {
    try {
      await prisma.$executeRawUnsafe(DELETE_ALL_SQL);
      return;
    } catch {
      const rows = await prisma.$queryRaw<{ tablename: string }[]>`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
      const tables = rows.map((r) => `"${r.tablename.replace(/"/g, '""')}"`).join(', ');
      truncateSql = `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`;
    }
  }
  await prisma.$executeRawUnsafe(truncateSql);
}

/**
 * Runs seeds concurrently but always waits for all of them. Promise.all would
 * reject on the first failure while sibling seeds keep running detached —
 * their writes then race the next test's wipe/seed and cascade failures
 * through the whole file (P2002s, deadlocks, FK violations).
 */
async function seedAll(seeds: Promise<unknown>[]) {
  const results = await Promise.allSettled(seeds);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}

beforeEach(async () => {
  invalidateJqlCtxCache(); // wiped metadata must not leak through the JQL snapshot
  // Detached durable jobs (attachment purges/thumbnails, import/bulk replays)
  // outlive the test that enqueued them — including setTimeout retries — and
  // their writes deadlock the wipe. Flush in-flight work and cancel pending
  // retry timers before touching the DB.
  const runner = getDurableRunner() as unknown as { flush?: () => Promise<void>; close?: () => void };
  await runner.flush?.();
  runner.close?.();
  // Join the seed serialization queue: a request-scoped seedPermissionDefaults
  // (POST /project → createProject) or a test-hook call can never interleave
  // the wipe — it either finishes before we start or runs after we finish.
  await enqueueSeedTask(async () => {
    await wipeDb();
    // Independent seeds run concurrently; stage 2 depends on statuses
    // (metadata) and on the admin user (ensureTestAuth → groupMember rows).
    await seedAll([seedMetadata(), seedSystemCustomFields(), ensureTestAuth()]);
    await seedAll([seedWorkflows(), seedPermissionDefaultsImpl()]);
  });
});

afterAll(async () => {
  keepAliveAgent.destroy(); // pooled keep-alive sockets hold the event loop
  await prisma.$disconnect();
});

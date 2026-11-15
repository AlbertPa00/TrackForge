import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    fileParallelism: false,
    // Share one module graph across files — the per-test DB wipe provides
    // isolation, and skipping per-file app re-import saves ~3-5s per file.
    // maxConcurrency:1 is required: with a shared context vitest would
    // otherwise interleave files (default 5) and concurrent beforeEach wipes
    // race each other on the single test database.
    isolate: false,
    maxConcurrency: 1,
    // Hooks and tests do real DB work (wipe+reseed, fixture setup via HTTP).
    // Abandoned hooks/requests keep running detached and race the next
    // beforeEach wipe — timeouts must comfortably exceed worst-case seed time.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Isolated database so test runs never wipe development data.
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://trackforge:trackforge@localhost:5433/trackforge_test',
      VITEST: 'true',
      // Prisma's client auto-loads .env — without this, a dev's REDIS_URL
      // would flip getDurableRunner() to BullMQ inside tests. Forced empty so
      // tests always get the in-memory adapter; the live BullMQ suite opts in
      // via REDIS_URL_TEST.
      REDIS_URL: process.env.REDIS_URL_TEST ?? '',
      // Request logging emits one pino line per API call — thousands of
      // captured stdout lines per suite. Errors still surface.
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'error',
    },
  },
});

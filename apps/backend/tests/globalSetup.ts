import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const prismaCli = require.resolve('prisma/build/index.js');

// Must mirror vitest.config.ts test.env — globalSetup runs in the main
// process where test.env is NOT applied, so .env's dev DATABASE_URL must
// never leak through to prisma here.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://trackforge:trackforge@localhost:5433/trackforge_test';

/**
 * Applies pending migrations to the test database before the suite runs.
 * `migrate deploy` is a no-op when the DB is current (~1s) and prevents the
 * classic "client regenerated, test DB stale → P2021/P2022 on every request"
 * failure mode when the schema drifts mid-development.
 */
export default function globalSetup() {
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: backendDir,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

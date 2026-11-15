// Ops path: drive an existing ImportJob end-to-end outside the HTTP server —
// useful when the dev server runs stale code or a job must be re-run after
// infrastructure hiccups. Also: `pnpm --filter backend import:run <jobId>`.
// Usage:
//   npx tsx scripts/run-import-job.ts <importJobId>
import { runImport } from '../src/import/service.js';

const jobId = process.argv[2];
if (!jobId) {
  console.error('usage: tsx scripts/run-import-job.ts <importJobId>');
  process.exit(2);
}

await runImport(jobId);
console.log(`import ${jobId} done`);
process.exit(0);

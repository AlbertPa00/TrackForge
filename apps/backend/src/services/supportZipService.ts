// 044 US3 — support zip: sanitized diagnostics for help requests.
// HARD RULE (SC-004): no secret VALUES ever enter the bundle — keys matching
// secret-ish names emit "<set>"/"<unset>" only, and the assembled payload is
// rescanned for token/secret patterns before zipping (defense in depth).
import { prisma } from '../prisma.js';
import { getDurableRunner } from '../lib/jobs.js';
import { zipStore, type ZipEntry } from '../lib/zipStore.js';
import { lastBackupStatus, listBackups } from './backupService.js';

const SECRET_NAME = /(SECRET|PASSWORD|PASS|TOKEN|KEY|CREDENTIAL|DSN|_URL$)/i;
// Values safe to include verbatim — no credentials by convention.
const SAFE_VALUE_KEYS = new Set(['PUBLIC_BASE_URL', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION']);
const SECRET_VALUE = /(tfp_[A-Za-z0-9_-]+|postgres(ql)?:\/\/[^@\s]+@|-----BEGIN [A-Z ]*PRIVATE KEY)/g;

function sanitizeConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = [
    'NODE_ENV',
    'PORT',
    'PUBLIC_BASE_URL',
    'ATTACHMENT_STORAGE',
    'ATTACHMENT_DIR',
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_REGION',
    'REDIS_URL',
    'DATABASE_URL',
    'SESSION_SECRET',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'SMTP_FROM',
    'SMTP_TLS',
    'RATE_LIMIT',
    'LOG_LEVEL',
    'EVENT_RETENTION_DAYS',
    'BACKUP_ENABLED',
    'BACKUP_DIR',
    'BACKUP_KEEP',
    'WEBHOOK_ALLOW_PRIVATE',
    'TF_VERSION',
    'TF_SCM_REVISION',
  ];
  for (const k of keys) {
    const v = process.env[k];
    if (SECRET_NAME.test(k) && !SAFE_VALUE_KEYS.has(k)) out[k] = v ? '<set>' : '<unset>';
    else if (v === undefined) out[k] = '<unset>';
    else out[k] = v;
  }
  return out;
}

async function recentErrors(): Promise<unknown[]> {
  const failed = await getDurableRunner().list('failed');
  return failed.slice(-50).map((j) => ({
    name: j.name,
    attemptsMade: j.attemptsMade,
    failedReason: String(j.failedReason ?? '')
      .replace(SECRET_VALUE, '<redacted>')
      .slice(0, 300),
  }));
}

export async function buildSupportZip(): Promise<Buffer> {
  const checks: Record<string, string> = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch {
    checks.db = 'fail';
  }
  const waiting = await getDurableRunner().list('waiting');
  const failed = await getDurableRunner().list('failed');
  const { buildMeta } = await import('../lib/buildInfo.js');
  const meta = buildMeta();
  const manifest = {
    generatedAt: new Date().toISOString(),
    version: meta.version,
    scm: meta.scm,
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
    counts: {
      issues: await prisma.issue.count().catch(() => -1),
      users: await prisma.user.count().catch(() => -1),
      projects: await prisma.project.count().catch(() => -1),
    },
  };
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'config.json', data: Buffer.from(JSON.stringify(sanitizeConfig(), null, 2)) },
    {
      name: 'checks.json',
      data: Buffer.from(
        JSON.stringify(
          {
            checks,
            queue: { waiting: waiting.length, failed: failed.length },
            backup: await lastBackupStatus(),
            backups: await listBackups(),
          },
          null,
          2
        )
      ),
    },
    { name: 'recent-errors.json', data: Buffer.from(JSON.stringify(await recentErrors(), null, 2)) },
  ];
  const zip = zipStore(entries);
  // SC-004: assembled-payload rescan — fail closed if anything secret-looking
  // slipped through a field we didn't anticipate.
  const blob = zip.toString('utf8');
  if (SECRET_VALUE.test(blob)) {
    throw new Error('support zip blocked: secret-like content detected in payload');
  }
  return zip;
}

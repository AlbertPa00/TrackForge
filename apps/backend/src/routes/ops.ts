import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { prisma } from '../prisma.js';
import { getDurableRunner } from '../lib/jobs.js';
import { ah, isDryRun } from '../lib/http.js';
import { requireAdmin } from '../middleware/auth.js';
import { qs } from '../lib/validation.js';

/** Sprint 016 US2 — ops surface. Registered directly on the app before auth so
 *  probes never need credentials (and enumerate as clean paths, not router mounts). */
export const adminJobsRouter: RouterType = Router(); // /api/internal/admin/jobs

const started = Date.now();
let requests = 0;
let errors = 0;
const buckets = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];
const hist = new Array(buckets.length + 1).fill(0) as number[];

/** Request counters — install as early middleware. */
export function metricsMiddleware(
  _req: unknown,
  res: { on: (ev: string, f: () => void) => void; statusCode: number },
  next: () => void
) {
  const t0 = performance.now();
  res.on('finish', () => {
    const ms = performance.now() - t0;
    requests += 1;
    if (res.statusCode >= 500) errors += 1;
    const i = buckets.findIndex((b) => ms <= b);
    hist[i === -1 ? buckets.length : i] += 1;
  });
  next();
}

export function healthz(_req: Request, res: Response) {
  res.json({ status: 'ok', uptimeSec: Math.floor((Date.now() - started) / 1000) });
}

export async function readyz(_req: Request, res: Response) {
  const checks: Record<string, string> = {};
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = 'ok';
  } catch {
    checks.db = 'fail';
  }
  checks.jobs = getDurableRunner() ? 'ok' : 'fail';
  const ready = Object.values(checks).every((v) => v === 'ok');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
}

export async function metrics(req: Request, res: Response) {
  // 044 US2: /metrics is unauthenticated by design (scrape endpoint) — gate it
  // with a shared bearer when METRICS_BEARER is set (prod profile sets it).
  const bearer = process.env.METRICS_BEARER;
  if (bearer && req.headers.authorization !== `Bearer ${bearer}`) {
    res.status(401).json({ errorMessages: ['Metrics requires METRICS_BEARER authorization.'], errors: {} });
    return;
  }
  const failed = await getDurableRunner().list('failed');
  const waiting = await getDurableRunner().list('waiting');
  const events = await prisma.domainEvent.count({ where: { dispatchedAt: null } }).catch(() => -1);
  const { lastBackupStatus } = await import('../services/backupService.js');
  const last = await lastBackupStatus().catch(() => null);
  let out = '# HELP tf_requests_total Total HTTP requests\n# TYPE tf_requests_total counter\n';
  out += `tf_requests_total ${requests}\n`;
  out += '# HELP tf_requests_errors_total HTTP 5xx responses\n# TYPE tf_requests_errors_total counter\n';
  out += `tf_requests_errors_total ${errors}\n`;
  out += '# HELP tf_request_latency_ms Request latency histogram\n# TYPE tf_request_latency_ms histogram\n';
  let cum = 0;
  for (const [i, b] of buckets.entries()) {
    cum += hist[i] as number;
    out += `tf_request_latency_ms_bucket{le="${b}"} ${cum}\n`;
  }
  out += `tf_request_latency_ms_bucket{le="+Inf"} ${requests}\n`;
  out += '# HELP tf_job_queue Jobs by state\n# TYPE tf_job_queue gauge\n';
  out += `tf_job_queue{state="waiting"} ${waiting.length}\ntf_job_queue{state="failed"} ${failed.length}\n`;
  out += '# HELP tf_outbox_undispatched Outbox events awaiting dispatch\n# TYPE tf_outbox_undispatched gauge\n';
  out += `tf_outbox_undispatched ${events}\n`;
  out +=
    '# HELP tf_backup_last_success_seconds Unix time of last successful backup\n# TYPE tf_backup_last_success_seconds gauge\n';
  out += `tf_backup_last_success_seconds ${last?.ok && last.id ? Math.floor(new Date(last.at).getTime() / 1000) : 0}\n`;
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(out);
}

// 065 audit E1 — every async handler is ah()-wrapped: an unhandled rejection
// on Express 4 (e.g. Redis down in the job runner) used to kill the process.
adminJobsRouter.get(
  '/jobs',
  requireAdmin,
  ah(async (req, res) => {
    const state = typeof qs(req.query.state) === 'string' ? qs(req.query.state) : undefined;
    res.json({ jobs: await getDurableRunner().list(state) });
  })
);
adminJobsRouter.get(
  '/jobs/:id',
  requireAdmin,
  ah(async (req, res) => {
    const j = await getDurableRunner().get(ps(req.params.id));
    if (!j) {
      res.status(404).json({ errorMessages: ['Job not found.'], errors: {} });
      return;
    }
    res.json(j);
  })
);
adminJobsRouter.post(
  '/jobs/:id/retry',
  requireAdmin,
  ah(async (req, res) => {
    const j = await getDurableRunner().get(ps(req.params.id));
    if (!j) {
      res.status(404).json({ errorMessages: ['Job not found.'], errors: {} });
      return;
    }
    await getDurableRunner().retry(j.id);
    res.status(202).json({ retried: j.id });
  })
);

// ---------- 044 US1/US3 — system status + backup visibility ----------

adminJobsRouter.get(
  '/system/status',
  requireAdmin,
  ah(async (_req, res) => {
    const { lastBackupStatus, listBackups } = await import('../services/backupService.js');
    const { lastCheck, updateCheckEnabled } = await import('../services/updateCheckService.js');
    const checks: Record<string, string> = {};
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
    }
    try {
      if (process.env.ATTACHMENT_STORAGE === 's3') {
        const { getAttachmentStore } = await import('../ports/attachmentStore.js');
        await getAttachmentStore().listKeys?.();
      }
      checks.storage = 'ok';
    } catch {
      checks.storage = 'fail';
    }
    const waiting = await getDurableRunner().list('waiting');
    const failed = await getDurableRunner().list('failed');
    const { buildMeta } = await import('../lib/buildInfo.js');
    const meta = buildMeta();
    res.json({
      version: meta.version,
      scm: meta.scm,
      uptimeSec: Math.floor((Date.now() - started) / 1000),
      checks,
      queue: { waiting: waiting.length, failed: failed.length },
      backup: await lastBackupStatus(),
      backups: (await listBackups()).length,
      update: updateCheckEnabled() ? await lastCheck() : null,
      updateCheckEnabled: updateCheckEnabled(),
    });
  })
);

// 044 US5 — opt-in update check trigger (the daily job lives in dispatchService).
adminJobsRouter.post(
  '/system/updatecheck',
  requireAdmin,
  ah(async (_req, res) => {
    const { updateCheckEnabled, checkForUpdates } = await import('../services/updateCheckService.js');
    if (!updateCheckEnabled()) {
      res.status(409).json({ errorMessages: ['Update check is disabled (UPDATE_CHECK_ENABLED).'], errors: {} });
      return;
    }
    res.json(await checkForUpdates());
  })
);

adminJobsRouter.get(
  '/system/backups',
  requireAdmin,
  ah(async (_req, res) => {
    const { listBackups } = await import('../services/backupService.js');
    res.json({ backups: await listBackups() });
  })
);

adminJobsRouter.post(
  '/system/backup',
  requireAdmin,
  ah(async (_req, res) => {
    const { runBackup, recordBackupFailure } = await import('../services/backupService.js');
    try {
      const manifest = await runBackup();
      res.status(201).json(manifest);
    } catch (e) {
      await recordBackupFailure(e);
      res.status(500).json({ errorMessages: [`Backup failed: ${(e as Error).message}`], errors: {} });
    }
  })
);

adminJobsRouter.post(
  '/system/backups/:id/verify',
  requireAdmin,
  ah(async (req, res) => {
    const { verifyBackup } = await import('../services/backupService.js');
    try {
      res.json(await verifyBackup(ps(req.params.id)));
    } catch (e) {
      res.status(404).json({ errorMessages: [`Backup not found: ${(e as Error).message}`], errors: {} });
    }
  })
);

// 061 US4 — restore from the console. ?dryRun=true previews + mints a
// confirmToken; the real call requires it, verifies checksums first, then
// runs pg_restore detached (its own job table is dropped mid-restore).
adminJobsRouter.post(
  '/system/backups/:id/restore',
  requireAdmin,
  ah(async (req, res) => {
    const svc = await import('../services/backupService.js');
    if (!svc.uiRestoreEnabled()) {
      res.status(404).json({ errorMessages: ['UI restore is disabled (TF_DISABLE_UI_RESTORE).'], errors: {} });
      return;
    }
    const id = ps(req.params.id);
    const manifest = (await svc.listBackups()).find((b) => b.id === id);
    if (!manifest) {
      res.status(404).json({ errorMessages: ['Backup not found.'], errors: {} });
      return;
    }
    if (isDryRun(req)) {
      res.json({
        preview: {
          id: manifest.id,
          createdAt: manifest.createdAt,
          version: manifest.version,
          files: manifest.files.length,
          counts: manifest.counts,
        },
        warning:
          'All changes made after this backup are permanently lost. Every signed-in user, including you, is logged out. Attachment files are NOT restored — that remains a CLI step (docs/backup-restore.md).',
        confirmToken: await svc.restorePreviewToken(id),
      });
      return;
    }
    if (!(await svc.consumeRestoreToken(id, String(qs(req.query.confirmToken) ?? '') || undefined))) {
      res.status(400).json({
        errorMessages: [],
        errors: { confirmToken: 'Restore requires a confirmToken from a ?dryRun=true preview of this same backup.' },
      });
      return;
    }
    const v = await svc.verifyBackup(id);
    if (!v.ok) {
      res
        .status(409)
        .json({ errorMessages: [`Backup checksum verification failed: ${v.mismatched.join(', ')}`], errors: {} });
      return;
    }
    const { audit } = await import('../services/auditService.js');
    await audit(req, 'system.backup.restored', 'backup', id, {});
    void svc.runRestoreDetached(id);
    res.status(202).json({ started: true, backupId: id });
  })
);

adminJobsRouter.get(
  '/system/restore-status',
  requireAdmin,
  ah(async (_req, res) => {
    const { readRestoreStatus } = await import('../services/backupService.js');
    res.json(await readRestoreStatus());
  })
);

adminJobsRouter.get(
  '/system/support.zip',
  requireAdmin,
  ah(async (_req, res) => {
    try {
      const { buildSupportZip } = await import('../services/supportZipService.js');
      const zip = await buildSupportZip();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="trackforge-support-${Date.now()}.zip"`);
      res.send(zip);
    } catch (e) {
      res.status(500).json({ errorMessages: [`Support zip failed: ${(e as Error).message}`], errors: {} });
    }
  })
);

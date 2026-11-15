// Outbox dispatcher — drains undispatched DomainEvents in id order into the
// SSE hub, webhook matcher (which queues deliveries) and the notification
// generator, then marks them dispatched. All jobs run under a Postgres
// advisory lock — this IS the multi-instance mechanism (see docs/ha.md).

import { prisma } from '../prisma.js';
import { jobRunner, withAdvisoryLock, getDurableRunner } from '../lib/jobs.js';
import { sseBroadcast } from './sseHub.js';
import { matchWebhooks, deliverPending } from './webhookService.js';
import { generateNotifications } from './notificationService.js';
import {
  generateEmails,
  sendPendingMail,
  sendDigests,
  pruneOutbox,
  runSubscriptions,
  ensureDefaultScheme,
} from './mailService.js';
import { expireProposals } from './proposalService.js';
import { embedIssueIfStale } from './copilotService.js';
import { evaluateEventForRules, runScheduledRules } from './automationService.js';
import { runBackup, recordBackupFailure } from './backupService.js';

const DISPATCH_INTERVAL_MS = 500; // sub-second fan-out for live feel
const DELIVER_INTERVAL_MS = 1_000; // deliveries poll their own nextAttemptAt
const PRUNE_INTERVAL_MS = 3_600_000;
// 065 audit G9 — .env.example documents 90; the code defaulted to 30.
const RETENTION_DAYS = Number(process.env.EVENT_RETENTION_DAYS ?? 90);

/** One dispatch cycle — returns the number of events processed (testable). */
export async function dispatchEvents(): Promise<number> {
  const pending = await prisma.domainEvent.findMany({
    where: { dispatchedAt: null },
    orderBy: { id: 'asc' },
    take: 200,
  });
  if (!pending.length) return 0;
  // 070 — ack the whole batch in one write: a per-event UPDATE used to be
  // 200 round-trips (and 200 WAL flushes) on top of the handler work.
  const dispatched: bigint[] = [];
  for (const ev of pending) {
    try {
      await matchWebhooks(ev);
    } catch (e) {
      console.error(`[dispatch] webhook match failed for event ${ev.id}:`, e);
    }
    try {
      await generateNotifications(ev);
    } catch (e) {
      console.error(`[dispatch] notification generation failed for event ${ev.id}:`, e);
    }
    try {
      await generateEmails(ev); // 029 — scheme → outbox (never blocks dispatch)
    } catch (e) {
      console.error(`[dispatch] email generation failed for event ${ev.id}:`, e);
    }
    try {
      await evaluateEventForRules(ev); // 034 — automation rules (never blocks dispatch)
    } catch (e) {
      console.error(`[dispatch] automation eval failed for event ${ev.id}:`, e);
    }
    try {
      await sseBroadcast(ev);
    } catch {
      /* SSE fan-out never blocks dispatch */
    }
    dispatched.push(ev.id);
  }
  await prisma.domainEvent.updateMany({ where: { id: { in: dispatched } }, data: { dispatchedAt: new Date() } });
  return pending.length;
}

export async function pruneEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
  const { count } = await prisma.domainEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  return count;
}

export function registerJobs() {
  // Sprint 016 H1-b: work runs as durable jobs (inspectable/retryable via
  // /api/internal/admin/jobs); ticks only enqueue. Handlers keep the Postgres
  // advisory lock so a tick is single-execution even across instances that
  // each enqueue independently; BullMQ's jobId dedupe is the second layer.
  const durable = getDurableRunner();
  durable.register('outbox.dispatch', () => withAdvisoryLock('outbox.dispatch', () => dispatchEvents()).then(() => {}));
  durable.register('outbox.deliver', () => withAdvisoryLock('outbox.deliver', () => deliverPending()).then(() => {}));
  durable.register('retention.prune', () =>
    withAdvisoryLock('retention.prune', async () => {
      const n = await pruneEvents();
      if (n) console.log(`[jobs] pruned ${n} events older than ${RETENTION_DAYS}d`);
    }).then(() => {})
  );
  durable.register('proposals.expire', () =>
    withAdvisoryLock('proposals.expire', async () => {
      const n = await expireProposals();
      if (n) console.log(`[jobs] expired ${n} proposals`);
    }).then(() => {})
  );
  durable.register('embed.refresh', () => withAdvisoryLock('embed.refresh', embedStaleBatch).then(() => {}));
  // 029 — email channel: outbox drain, daily digests, subscription runs, retention.
  ensureDefaultScheme().catch((e) => console.error('[jobs] default notification scheme seed failed:', e));
  durable.register('mail.send', () => withAdvisoryLock('mail.send', () => sendPendingMail()).then(() => {}));
  durable.register('mail.digest', () =>
    withAdvisoryLock('mail.digest', () => sendDigests(), { timeoutMs: 600_000 }).then(() => {})
  );
  durable.register('mail.subscriptions', () =>
    withAdvisoryLock('mail.subscriptions', () => runSubscriptions(), { timeoutMs: 600_000 }).then(() => {})
  );
  durable.register('mail.prune', () => withAdvisoryLock('mail.prune', () => pruneOutbox()).then(() => {}));
  // 034 — scheduled automation rules run through the durable runner (exactly-once
  // per minute via the periodic:automation.schedule dedupe key).
  durable.register('automation.schedule', () =>
    withAdvisoryLock('automation.schedule', () => runScheduledRules()).then(() => {})
  );

  const tick = (name: string) => async () => {
    await durable.enqueue(name, {}, { key: `periodic:${name}` });
  };
  jobRunner.register('dispatch', tick('outbox.dispatch'), DISPATCH_INTERVAL_MS);
  jobRunner.register('deliver', tick('outbox.deliver'), DELIVER_INTERVAL_MS);
  jobRunner.register('prune', tick('retention.prune'), PRUNE_INTERVAL_MS);
  // Expire stale proposals hourly; embedding refresh runs on its own cadence
  // (LLM latency must never block event dispatch).
  jobRunner.register('expire-proposals', tick('proposals.expire'), 3_600_000);
  jobRunner.register('embed', tick('embed.refresh'), 60_000);
  jobRunner.register('mail-send', tick('mail.send'), 2_000);
  jobRunner.register('mail-digest', tick('mail.digest'), 3_600_000);
  jobRunner.register('mail-subs', tick('mail.subscriptions'), 3_600_000);
  jobRunner.register('mail-prune', tick('mail.prune'), 3_600_000);
  jobRunner.register('automation-schedule', tick('automation.schedule'), 60_000); // every minute

  // 044 US1 — scheduled backup. On by default in production; dev opts in with
  // BACKUP_ENABLED=true. Interval BACKUP_INTERVAL_MS (default 24h).
  const backupEnabled =
    process.env.BACKUP_ENABLED === 'true' ||
    (process.env.BACKUP_ENABLED !== 'false' && process.env.NODE_ENV === 'production');
  if (backupEnabled) {
    durable.register('backup.run', () =>
      withAdvisoryLock(
        'backup.run',
        async () => {
          const m = await runBackup();
          console.log(`[jobs] backup ${m.id}: ${m.files.length} files`);
        },
        { timeoutMs: 1_800_000 }
      )
        .then(() => {})
        .catch(async (e) => {
          await recordBackupFailure(e);
          throw e;
        })
    );
    jobRunner.register('backup', tick('backup.run'), Number(process.env.BACKUP_INTERVAL_MS ?? 86_400_000));
  }

  // 047 US2-2/US3-3 — agent session sweep: stalls → blocked, lapsed questions
  // → session failed(question-expired). Advisory-locked, every 5 min.
  durable.register('agentsession.sweep', () =>
    withAdvisoryLock('agentsession.sweep', async () => {
      const { sweepStaleSessions } = await import('./agentSessionService.js');
      const n = await sweepStaleSessions(Number(process.env.AGENT_SESSION_STALE_MS ?? 1_800_000));
      if (n) console.log(`[jobs] agent sweep: ${n} session(s) transitioned`);
    }).then(() => {})
  );
  jobRunner.register('agent-sweep', tick('agentsession.sweep'), 300_000);

  // 049 US2-3 — scheduled LDAP sync: enabled connections sync on their own
  // config.syncIntervalSec cadence. Advisory-locked sweep every minute.
  durable.register('directory.sync', () =>
    withAdvisoryLock('directory.sync', async () => {
      const { runDueDirectorySyncs } = await import('./directoryService.js');
      const n = await runDueDirectorySyncs();
      if (n) console.log(`[jobs] directory sync: ${n} connection(s) synced`);
    }).then(() => {})
  );
  jobRunner.register('directory-sync', tick('directory.sync'), 60_000);

  // 051 — GitLab: one-shot backfills run on the runner (resumable, deduped
  // per connection); poll-mode connections sync on a 2-min sweep.
  durable.register('gitlab.backfill', (p) =>
    withAdvisoryLock(
      'gitlab.backfill',
      async () => {
        const { backfill } = await import('./gitlabService.js');
        await backfill((p as { repoId: string }).repoId, (m) => console.log(`[jobs] gitlab backfill: ${m}`));
      },
      { timeoutMs: 1_800_000 }
    ).then(() => {})
  );
  durable.register('gitlab.poll', () =>
    withAdvisoryLock('gitlab.poll', async () => {
      const { pollSync } = await import('./gitlabService.js');
      const repos = await prisma.devRepository.findMany({ where: { provider: 'gitlab', enabled: true } });
      let n = 0;
      for (const r of repos) {
        const mode = (r.gitlab as { mode?: string } | null)?.mode ?? 'webhook';
        if (mode === 'webhook') continue;
        n += (await pollSync(r.id).catch(() => ({ synced: 0 }))).synced;
      }
      if (n) console.log(`[jobs] gitlab poll: ${n} item(s) synced`);
    }).then(() => {})
  );
  jobRunner.register('gitlab-poll', tick('gitlab.poll'), 120_000);

  // 044 US5 — opt-in update check: off unless UPDATE_CHECK_ENABLED=true.
  if (process.env.UPDATE_CHECK_ENABLED === 'true') {
    durable.register('updatecheck.run', () =>
      withAdvisoryLock('updatecheck.run', async () => {
        const { checkForUpdates } = await import('./updateCheckService.js');
        const r = await checkForUpdates();
        if (r.updateAvailable) console.log(`[jobs] update available: ${r.current} → ${r.latest}`);
      }).then(() => {})
    );
    jobRunner.register(
      'updatecheck',
      tick('updatecheck.run'),
      Number(process.env.UPDATE_CHECK_INTERVAL_MS ?? 86_400_000)
    );
  }
}

async function embedStaleBatch(): Promise<void> {
  const { getAiSettings, embeddingsConfigured } = await import('../lib/ai.js');
  const s = await getAiSettings();
  if (!s || !embeddingsConfigured(s)) return;
  // Recently updated issues whose embedding is missing or stale.
  const candidates = await prisma.issue.findMany({
    where: { project: { aiEnabled: true } },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      updatedAt: true,
      reporterId: true,
      embedding: { select: { updatedAt: true } },
    },
  });
  const fallbackUser = await prisma.user.findFirst({
    where: { isAdmin: true, active: true },
    select: { id: true },
  });
  for (const i of candidates.slice(0, 10)) {
    if (i.embedding && i.embedding.updatedAt >= i.updatedAt) continue;
    const uid = i.reporterId ?? fallbackUser?.id;
    if (!uid) continue;
    await embedIssueIfStale(i.id, uid).catch(() => undefined);
  }
}

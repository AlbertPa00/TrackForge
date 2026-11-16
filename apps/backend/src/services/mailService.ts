// Sprint 029 — email channel: MailAdapter port (nodemailer SMTP + in-memory
// test adapter), EmailOutbox durability (FR-001), notification-scheme
// resolution (scheme → event → recipients → dedupe → prefs → send, FR-002),
// per-user prefs via UserPreference KV, filter-subscription digest runs.

import type { DomainEvent } from '../lib/pc.js';
import type { Actor } from '../lib/auth.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { getSetting, putSetting } from './settingsService.js';
import { publicBaseUrl } from '../config.js';
import { encryptSecret, readSecret } from '../lib/ai.js';
import { executeSearch } from './searchService.js';
import { mt } from './mailI18n.js';
import { randomBytes } from 'node:crypto';
import { projectByKeyOr404 } from './projectService.js';

// ---------- mail config (env wins over admin settings — edge case) ----------

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  baseUrl: string;
  /** 065 audit G5 — false when nothing set SMTP_HOST (env or stored): mail
   *  falls back to localhost:1025 and every send fails silently otherwise. */
  configured: boolean;
}

const MAIL_KEY = 'mail.config';

export async function getMailConfig(): Promise<MailConfig> {
  const stored = (await getSetting<Partial<MailConfig>>(MAIL_KEY)) ?? {};
  return {
    host: process.env.SMTP_HOST ?? stored.host ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? stored.port ?? 1025),
    secure: process.env.SMTP_TLS ? process.env.SMTP_TLS === 'true' : (stored.secure ?? false),
    user: process.env.SMTP_USER ?? stored.user,
    // 065 F3 — the stored pass is AES-256-GCM encrypted at rest; readSecret
    // transparently handles legacy plaintext rows.
    pass: process.env.SMTP_PASS ?? (stored.pass ? readSecret(stored.pass) : undefined),
    from: process.env.SMTP_FROM ?? stored.from ?? 'trackforge@localhost',
    // 065 audit G1 — PUBLIC_BASE_URL is the documented variable for outbound
    // links; the old fallback hardcoded the Vite dev origin so reset/invite/
    // notification mail pointed at localhost:5173 in every default deploy.
    baseUrl: process.env.BASE_URL ?? stored.baseUrl ?? publicBaseUrl(),
    configured: Boolean(process.env.SMTP_HOST ?? stored.host),
  };
}

export async function setMailConfig(patch: Partial<MailConfig>): Promise<void> {
  const stored = (await getSetting<Partial<MailConfig>>(MAIL_KEY)) ?? {};
  // The PUT response masks pass as '•••'; a UI round-trip must not persist the
  // mask over the real password. Absent/masked preserves; '' clears.
  const { pass, ...rest } = patch;
  const next = { ...stored, ...rest };
  if (pass !== undefined && pass !== '•••') next.pass = encryptSecret(pass);
  await putSetting(MAIL_KEY, next);
}

// ---------- adapter port ----------

export interface OutboundMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailAdapter {
  send(mail: OutboundMail): Promise<void>;
}

class SmtpAdapter implements MailAdapter {
  private warned = false;
  async send(mail: OutboundMail) {
    const cfg = await getMailConfig();
    // 065 audit G5 — unconfigured SMTP falls back to localhost:1025 and every
    // send retries 3× then dies silently. Warn once so the operator sees it
    // (a dev mailhog on :1025 still works — the mail is still attempted).
    if (!cfg.configured && !this.warned) {
      this.warned = true;
      console.warn(
        '[mail] SMTP is not configured — deliveries are attempted against localhost:1025 and will fail unless a local catch-all (e.g. Mailhog) is listening. Set SMTP_HOST (Admin → Mail).'
      );
    }
    const { default: nodemailer } = await import('nodemailer');
    const tx = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
    await tx.sendMail({ from: cfg.from, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
  }
}

export class MemoryAdapter implements MailAdapter {
  sent: OutboundMail[] = [];
  failNext = false;
  async send(mail: OutboundMail) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('memory adapter: simulated failure');
    }
    this.sent.push(mail);
  }
}

let adapter: MailAdapter | null = null;
export function getMailAdapter(): MailAdapter {
  if (!adapter) adapter = process.env.VITEST ? new MemoryAdapter() : new SmtpAdapter();
  return adapter;
}
/** Test hook — inject an adapter; `resetMailAdapter()` restores default. */
export function setMailAdapter(a: MailAdapter) {
  adapter = a;
}
export function resetMailAdapter() {
  adapter = null;
}

// ---------- user prefs (UserPreference KV) ----------

const PREF_KEY = 'notify.prefs';
export interface NotifyPrefs {
  /** event → channel('email'|'inapp') → enabled. Missing = enabled. */
  events?: Record<string, Record<string, boolean>>;
  autowatch?: { create?: boolean; comment?: boolean; assign?: boolean };
  digest?: 'immediate' | 'daily';
}

export async function getNotifyPrefs(userId: string): Promise<NotifyPrefs> {
  const row = await prisma.userPreference.findUnique({ where: { userId_key: { userId, key: PREF_KEY } } });
  return (row?.value as NotifyPrefs) ?? {};
}

export async function setNotifyPrefs(userId: string, prefs: NotifyPrefs): Promise<void> {
  await prisma.userPreference.upsert({
    where: { userId_key: { userId, key: PREF_KEY } },
    create: { userId, key: PREF_KEY, value: prefs as object },
    update: { value: prefs as object },
  });
}

function prefEnabled(prefs: NotifyPrefs, event: string, channel: string): boolean {
  return prefs.events?.[event]?.[channel] !== false;
}

// ---------- event mapping ----------

/** DomainEvent.type → scheme event name (§14.1 matrix). */
export function schemeEvent(ev: DomainEvent): string {
  if (ev.type === 'jira:issue_created') return 'issue_created';
  if (ev.type === 'jira:issue_deleted') return 'issue_deleted';
  if (ev.type === 'jira:issue_updated') {
    const items = (ev.payload as { changelog?: { items?: { field?: string }[] } }).changelog?.items ?? [];
    return items.some((i) => i.field === 'assignee') ? 'issue_assigned' : 'issue_updated';
  }
  if (ev.type.startsWith('comment_')) return 'comment_created';
  if (ev.type.startsWith('worklog_')) return 'work_logged';
  if (ev.type.startsWith('sprint_')) return 'sprint_event';
  if (ev.type.startsWith('version_')) return 'version_event';
  if (ev.type.startsWith('issuelink_')) return 'issue_updated';
  // 047 — dedicated names so raw session chatter doesn't fall under 'generic'
  // and mail every watcher on each agent thought.
  if (ev.type === 'agent_question.created') return 'agent_question';
  if (ev.type === 'agent_question.answered') return 'agent_answered';
  if (ev.type === 'agent_session.blocked') return 'agent_stalled';
  if (ev.type === 'agent_session.failed') return 'agent_failed';
  if (ev.type.startsWith('agent_')) return 'agent_activity';
  return 'generic';
}

// ---------- scheme resolution (FR-002) ----------

async function schemeForProject(projectId: string | null) {
  if (projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { notificationSchemeId: true } });
    if (p?.notificationSchemeId) {
      const s = await prisma.notificationScheme.findUnique({
        where: { id: p.notificationSchemeId },
        include: { entries: true },
      });
      if (s) return s;
    }
  }
  return prisma.notificationScheme.findFirst({ where: { isDefault: true }, include: { entries: true } });
}

interface EventCtx {
  issueId: string | null;
  projectId: string | null;
  payload: Record<string, unknown>;
}

async function resolveRecipients(kind: string, ref: string | null, ctx: EventCtx): Promise<string[]> {
  const p = ctx.payload as {
    issue?: { fields?: { assignee?: { accountId?: string }; reporter?: { accountId?: string } } };
    comment?: { body?: string };
  };
  switch (kind) {
    case 'reporter':
      return p.issue?.fields?.reporter?.accountId ? [p.issue.fields.reporter.accountId] : [];
    case 'assignee':
      return p.issue?.fields?.assignee?.accountId ? [p.issue.fields.assignee.accountId] : [];
    case 'watchers': {
      if (!ctx.issueId) return [];
      const w = await prisma.watcher.findMany({ where: { issueId: ctx.issueId }, select: { userId: true } });
      return w.map((x) => x.userId);
    }
    case 'mentioned':
      return [...(p.comment?.body ?? '').matchAll(/\[~accountId:([^\]]+)\]/g)].map((m) => m[1]!);
    case 'projectlead': {
      if (!ctx.projectId) return [];
      const pr = await prisma.project.findUnique({ where: { id: ctx.projectId }, select: { leadId: true } });
      return pr?.leadId ? [pr.leadId] : [];
    }
    case 'projectrole': {
      if (!ctx.projectId || !ref) return [];
      const actors = await prisma.projectRoleActor.findMany({
        where: { projectId: ctx.projectId, roleId: ref },
        select: { userId: true, groupId: true },
      });
      const ids = actors.map((a) => a.userId).filter(Boolean) as string[];
      const gids = actors.map((a) => a.groupId).filter(Boolean) as string[];
      if (gids.length) {
        const gm = await prisma.groupMember.findMany({ where: { groupId: { in: gids } }, select: { userId: true } });
        ids.push(...gm.map((g) => g.userId));
      }
      return ids;
    }
    case 'group': {
      if (!ref) return [];
      const g = await prisma.group.findFirst({ where: { name: ref }, select: { id: true } });
      if (!g) return [];
      const gm = await prisma.groupMember.findMany({ where: { groupId: g.id }, select: { userId: true } });
      return gm.map((x) => x.userId);
    }
    case 'user':
      return ref ? [ref] : [];
    case 'delegator': {
      const d = (ctx.payload as { delegatorId?: string }).delegatorId;
      return d ? [d] : [];
    }
    default:
      return [];
  }
}

/** §14.4-shaped mail. Locale-aware (037 US1-3) — falls back to en. */
function renderMail(ev: DomainEvent, event: string, baseUrl: string, locale?: string | null) {
  const p = ev.payload as {
    issueKey?: string;
    issue?: { fields?: { summary?: string } };
    actor?: { displayName?: string } | null;
    comment?: { body?: string };
  };
  const key = p.issueKey ?? 'TF';
  const summary = p.issue?.fields?.summary ?? '';
  const who = p.actor?.displayName ?? 'Someone';
  const subject = `[${key}] ${summary} — ${mt(locale, `subj.${event}`)}`;
  const link = `${baseUrl}/browse/${key}`;
  const comment = p.comment?.body
    ? `<p style="border-left:3px solid #dfe1e6;padding-left:8px;color:#42526e">${escapeHtml(p.comment.body.slice(0, 500))}</p>`
    : '';
  const body = mt(locale, `ev.${event}`, {
    who: `<b>${escapeHtml(who)}</b>`,
    key: `<a href="${link}">${escapeHtml(key)}</a>`,
  });
  const html = `<p>${body}</p><p>${escapeHtml(summary)}</p>${comment}<p style="font-size:12px;color:#6b778c">— TrackForge · <a href="${link}">${mt(locale, 'viewIssue')}</a></p>`;
  const text = `${mt(locale, `ev.${event}`, { who, key })}: ${summary}\n${link}`;
  return { subject, html, text };
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Dispatch hook — resolves the scheme for the event's project, expands
 * recipients, dedupes, drops the actor (FR-005), applies per-user prefs,
 * and writes EmailOutbox rows (status digest when the user batches daily).
 */
export async function generateEmails(ev: DomainEvent): Promise<void> {
  const event = schemeEvent(ev);
  const ctx: EventCtx = {
    issueId: ev.issueId ?? null,
    projectId: ev.projectId ?? null,
    payload: (ev.payload ?? {}) as Record<string, unknown>,
  };
  const scheme = await schemeForProject(ctx.projectId);
  if (!scheme) return;
  const entries = scheme.entries.filter((e) => e.channel === 'email' && (e.event === event || e.event === 'generic'));

  const recipients = new Set<string>();
  for (const e of entries) {
    for (const uid of await resolveRecipients(e.recipientKind, e.recipientRef, ctx)) recipients.add(uid);
  }
  // comment mention events also notify mentioned users even when no entry maps them
  if (event === 'comment_created') {
    for (const uid of await resolveRecipients('mentioned', null, ctx)) recipients.add(uid);
  }
  // 047 — agent interrupts notify the delegator (+ assignee for questions) even
  // when the scheme has no explicit agent entry (mention parity).
  if (event === 'agent_question' || event === 'agent_stalled' || event === 'agent_failed') {
    for (const uid of await resolveRecipients('delegator', null, ctx)) recipients.add(uid);
    if (event === 'agent_question') {
      for (const uid of await resolveRecipients('assignee', null, ctx)) recipients.add(uid);
    }
  }
  recipients.delete(ev.actorId ?? '');
  if (!recipients.size) return;

  const users = await prisma.user.findMany({
    where: { id: { in: [...recipients] }, type: 'human', active: true },
  });
  if (!users.length) return;

  // 065 audit C5 — a watcher/reporter who has since lost browse (or never had
  // issue-security access) must not get the issue's summary by mail. Re-check
  // visibility per recipient at dispatch time.
  const { canSeeIssueFull, canSeeProjectId } = await import('./visibilityService.js');
  const issue = ctx.issueId
    ? await prisma.issue.findUnique({
        where: { id: ctx.issueId },
        select: {
          id: true,
          effSecurityLevelId: true,
          reporterId: true,
          assigneeId: true,
          projectId: true,
          archived: true,
        },
      })
    : null;
  const visibleUsers = [];
  for (const u of users) {
    const actor = { user: u, channel: 'api' } as Actor;
    const ok = issue
      ? await canSeeIssueFull(actor, issue)
      : ctx.projectId
        ? await canSeeProjectId(actor, ctx.projectId)
        : true;
    if (ok) visibleUsers.push(u);
  }
  if (!visibleUsers.length) return;

  const cfg = await getMailConfig();
  const p = ctx.payload as { issueKey?: string };
  for (const u of visibleUsers) {
    const prefs = await getNotifyPrefs(u.id);
    if (!prefEnabled(prefs, event, 'email')) continue;
    const mail = renderMail(ev, event, cfg.baseUrl, u.locale);
    await prisma.emailOutbox.create({
      data: {
        toUserId: u.id,
        toEmail: u.email,
        subject: mail.subject,
        body: mail.html,
        eventId: ev.id,
        eventType: event,
        issueKey: p.issueKey ?? null,
        status: prefs.digest === 'daily' ? 'digest' : 'pending',
      },
    });
  }
}

// ---------- outbox drain ----------

const MAX_ATTEMPTS = 3;

export async function sendPendingMail(): Promise<number> {
  const rows = await prisma.emailOutbox.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  let sent = 0;
  for (const r of rows) {
    try {
      await getMailAdapter().send({
        to: r.toEmail,
        subject: r.subject,
        html: r.body,
        text: r.body.replace(/<[^>]+>/g, ' ').slice(0, 1000),
      });
      await prisma.emailOutbox.update({
        where: { id: r.id },
        data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 } },
      });
      sent++;
    } catch (e) {
      const attempts = r.attempts + 1;
      await prisma.emailOutbox.update({
        where: { id: r.id },
        data: { attempts, error: String(e), status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending' },
      });
    }
  }
  return sent;
}

/** Daily batch — one summary mail per user holding their digest rows. */
export async function sendDigests(): Promise<number> {
  const rows = await prisma.emailOutbox.findMany({
    where: { status: 'digest' },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  if (!rows.length) return 0;
  const byUser = new Map<string, typeof rows>();
  for (const r of rows)
    if (r.toUserId) {
      const l = byUser.get(r.toUserId) ?? [];
      l.push(r);
      byUser.set(r.toUserId, l);
    }
  const cfg = await getMailConfig();
  // 065 audit G5 — the hourly tick sent each user's digest up to once per
  // hour. 'daily' means at most one batch a day: flush a user's queue only
  // once their oldest queued row is ~a day old.
  const cutoff = Date.now() - 20 * 3_600_000;
  let sent = 0;
  for (const [uid, list] of byUser) {
    if (list[0].createdAt.getTime() > cutoff) continue;
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { email: true, locale: true } });
    if (!u) continue;
    const items = list.map((r) => `<li>${escapeHtml(r.subject)}</li>`).join('');
    try {
      await getMailAdapter().send({
        to: u.email,
        subject: mt(u.locale, 'digestSubject', { n: list.length }),
        html: `<p>${mt(u.locale, 'digestIntro')}</p><ul>${items}</ul><p style="font-size:12px;color:#6b778c">— <a href="${cfg.baseUrl}">TrackForge</a></p>`,
        text: list.map((r) => r.subject).join('\n'),
      });
      await prisma.emailOutbox.updateMany({
        where: { id: { in: list.map((r) => r.id) } },
        data: { status: 'sent', sentAt: new Date() },
      });
      sent++;
    } catch {
      /* stays digest for the next tick */
    }
  }
  return sent;
}

/** Outbox retention — 30d per edge-cases. */
export async function pruneOutbox(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const { count } = await prisma.emailOutbox.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

// ---------- scheme CRUD ----------

export async function listSchemes() {
  // 061 US3 — bound project keys included so the console can unbind.
  return prisma.notificationScheme.findMany({
    include: { entries: true, projects: { select: { key: true } }, _count: { select: { projects: true } } },
    orderBy: { name: 'asc' },
  });
}

export async function createScheme(input: {
  name: string;
  description?: string;
  entries?: { event: string; channel?: string; recipientKind: string; recipientRef?: string }[];
}) {
  return prisma.notificationScheme.create({
    data: {
      name: input.name,
      description: input.description,
      entries: {
        create: (input.entries ?? []).map((e) => ({
          event: e.event,
          channel: e.channel ?? 'email',
          recipientKind: e.recipientKind,
          recipientRef: e.recipientRef,
        })),
      },
    },
    include: { entries: true },
  });
}

export async function updateScheme(
  id: string,
  input: {
    name?: string;
    description?: string;
    entries?: { event: string; channel?: string; recipientKind: string; recipientRef?: string }[];
  }
) {
  const existing = await prisma.notificationScheme.findUnique({ where: { id } });
  if (!existing) throw new JiraApiError(404, jiraError(['Notification scheme does not exist.']));
  await prisma.$transaction(async (tx) => {
    if (input.name !== undefined || input.description !== undefined) {
      await tx.notificationScheme.update({
        where: { id },
        data: { name: input.name ?? existing.name, description: input.description },
      });
    }
    if (input.entries) {
      await tx.notificationSchemeEntry.deleteMany({ where: { schemeId: id } });
      await tx.notificationSchemeEntry.createMany({
        data: input.entries.map((e) => ({
          schemeId: id,
          event: e.event,
          channel: e.channel ?? 'email',
          recipientKind: e.recipientKind,
          recipientRef: e.recipientRef,
        })),
      });
    }
  });
  return prisma.notificationScheme.findUnique({ where: { id }, include: { entries: true } });
}

export async function deleteScheme(id: string) {
  const s = await prisma.notificationScheme.findUnique({
    where: { id },
    include: { _count: { select: { projects: true } } },
  });
  if (!s) throw new JiraApiError(404, jiraError(['Notification scheme does not exist.']));
  if (s.isDefault) throw new JiraApiError(400, jiraError(['The default scheme cannot be deleted.']));
  await prisma.notificationScheme.delete({ where: { id } });
}

export async function assignScheme(projectKey: string, schemeId: string | null) {
  const project = await projectByKeyOr404(projectKey);
  if (schemeId) {
    const s = await prisma.notificationScheme.findUnique({ where: { id: schemeId } });
    if (!s) throw new JiraApiError(404, jiraError(['Notification scheme does not exist.']));
  }
  return prisma.project.update({ where: { id: project.id }, data: { notificationSchemeId: schemeId } });
}

/** Seeded default — mirrors 011 in-app recipients, email channel. */
export async function ensureDefaultScheme() {
  const existing = await prisma.notificationScheme.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  return prisma.notificationScheme.create({
    data: {
      name: 'Default Notification Scheme',
      description: 'Seeded default — reporter, assignee and watchers on issue events.',
      isDefault: true,
      entries: {
        create: [
          'issue_created',
          'issue_updated',
          'issue_assigned',
          'comment_created',
          'work_logged',
          'issue_deleted',
          'generic',
        ].flatMap((event) =>
          ['reporter', 'assignee', 'watchers'].map((recipientKind) => ({ event, channel: 'email', recipientKind }))
        ),
      },
    },
    include: { entries: true },
  });
}

// ---------- filter subscriptions ----------

export async function listSubscriptions(userId: string) {
  return prisma.filterSubscription.findMany({
    where: { userId },
    include: { filter: { select: { name: true, jql: true } } },
  });
}

export async function subscribeFilter(
  filterId: string,
  actor: Actor,
  input: { frequency: 'daily' | 'weekly'; dayOfWeek?: number; hour?: number }
) {
  const filter = await prisma.filter.findUnique({ where: { id: filterId }, include: { sharePerms: true } });
  // 065 audit C5 — subscribing must respect the share scope: a private filter's
  // name/JQL and its mailed results must not be reachable by id.
  const { canSeeFilter } = await import('./filterScope.js');
  if (!filter || !(await canSeeFilter(filter, actor)))
    throw new JiraApiError(404, jiraError(['Filter does not exist.']));
  return prisma.filterSubscription.create({
    data: {
      filterId,
      userId: actor.user.id,
      frequency: input.frequency,
      dayOfWeek: input.dayOfWeek ?? null,
      hour: Math.min(23, Math.max(0, input.hour ?? 9)),
      unsubscribeToken: randomBytes(24).toString('hex'),
    },
  });
}

export async function unsubscribe(idOrToken: string) {
  const sub = await prisma.filterSubscription.findFirst({
    where: { OR: [{ id: idOrToken }, { unsubscribeToken: idOrToken }] },
  });
  if (!sub) throw new JiraApiError(404, jiraError(['Subscription does not exist.']));
  await prisma.filterSubscription.delete({ where: { id: sub.id } });
}

/** Scheduler tick — mails due subscriptions their filter's first page. */
export async function runSubscriptions(now = new Date()): Promise<number> {
  const subs = await prisma.filterSubscription.findMany({ include: { filter: true, user: true } });
  let ran = 0;
  const cfg = await getMailConfig();
  for (const s of subs) {
    if (!s.user.active || s.user.type !== 'human') continue;
    if (s.lastRunAt && now.getTime() - s.lastRunAt.getTime() < 23 * 3_600_000) continue;
    if (s.frequency === 'weekly' && s.dayOfWeek != null && now.getUTCDay() !== s.dayOfWeek) continue;
    // 065 audit G5 — the stored delivery hour was never honoured; send only
    // inside the subscriber's chosen hour (UTC — the scheduler ticks hourly).
    if (now.getUTCHours() !== s.hour) continue;
    const actor = {
      user: s.user,
      channel: 'api' as const,
      projectKeys: [] as string[],
    } as unknown as Parameters<typeof executeSearch>[0];
    try {
      const r = await executeSearch(actor, { jql: s.filter.jql, startAt: 0, maxResults: 50 });
      const items = r.issues
        .map((i) => {
          const f = i.fields as { summary?: string };
          return `<li><a href="${cfg.baseUrl}/browse/${i.key}">${i.key}</a> ${escapeHtml(f.summary ?? '')}</li>`;
        })
        .join('');
      await getMailAdapter().send({
        to: s.user.email,
        subject: mt(s.user.locale, 'subscriptionSubject', { n: r.total, name: s.filter.name }),
        html: `<p>${mt(s.user.locale, 'subscriptionIntro')} <b>${escapeHtml(s.filter.name)}</b> (${r.total}):</p><ul>${items}</ul><p style="font-size:12px;color:#6b778c"><a href="${cfg.baseUrl}/unsubscribe?token=${s.unsubscribeToken}">${mt(s.user.locale, 'unsubscribe')}</a></p>`,
        text: r.issues.map((i) => i.key).join('\n'),
      });
      await prisma.filterSubscription.update({ where: { id: s.id }, data: { lastRunAt: now } });
      await prisma.emailOutbox.create({
        data: {
          toUserId: s.userId,
          toEmail: s.user.email,
          subject: `[subscription] ${s.filter.name}`,
          body: items,
          eventType: 'subscription',
          status: 'sent',
          sentAt: now,
        },
      });
      ran++;
    } catch (e) {
      await prisma.emailOutbox.create({
        data: {
          toUserId: s.userId,
          toEmail: s.user.email,
          subject: `[subscription] ${s.filter.name}`,
          body: '',
          eventType: 'subscription',
          status: 'failed',
          error: String(e),
        },
      });
    }
  }
  return ran;
}

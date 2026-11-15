// Webhooks — Jira Server-shaped registration, HMAC-signed delivery with
// retry/backoff, SSRF protection, delivery log + redeliver.

import { createHmac, randomBytes } from 'node:crypto';
import type { DomainEvent } from '@prisma/client';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { assertPublicUrl as egressAssertPublicUrl, egressFetch, isPrivateAddress } from '../lib/egress.js';
import { encryptSecret, readSecret } from '../lib/ai.js';
import { toWebhookBody } from './eventService.js';
import { parseJql } from '../jql/parser.js';
import { compileJql } from '../jql/compiler.js';
import type { Actor } from '../lib/auth.js';
import type { Prisma } from '@prisma/client';
import { resourceSelf } from '../lib/http.js';

async function auditWebhook(
  actor: Actor | null,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>
) {
  try {
    await prisma.auditEvent.create({
      data: {
        actorId: actor?.user.id ?? null,
        action,
        entityType,
        entityId,
        details: details as Prisma.InputJsonValue,
      },
    });
  } catch {
    /* auditing must never break the request path */
  }
}

function allowPrivateWebhooks() {
  return process.env.WEBHOOK_ALLOW_PRIVATE === 'true';
}

const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 8;
const DISABLE_AFTER_FAILURES = 50;
// ~24h total backoff: 30s,2m,10m,1h,3h,6h,12h (+initial attempt)
const BACKOFF_MS = [0, 30_000, 120_000, 600_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000];

// ---------- SSRF ----------
// 064 US5 — validation moved to the shared egress guard (delivery-time DNS,
// all answers, manual redirects, normalized IPv6). Names kept for callers.

export { isPrivateAddress };

export async function assertPublicUrl(raw: string): Promise<URL> {
  return egressAssertPublicUrl(raw, { allowPrivate: allowPrivateWebhooks() });
}

// ---------- CRUD ----------

function toWebhookResponse(w: {
  id: string;
  name: string;
  url: string;
  events: string[];
  jqlFilter: string | null;
  enabled: boolean;
  failureCount: number;
  excludeActorIds: string[];
  createdAt: Date;
}) {
  return {
    id: w.id,
    self: resourceSelf(`/rest/webhooks/1.0/webhook/${w.id}`),
    name: w.name,
    url: w.url,
    events: w.events,
    filters: w.jqlFilter ? { 'issue-related-events-section': w.jqlFilter } : {},
    enabled: w.enabled,
    failureCount: w.failureCount,
    excludeActorIds: w.excludeActorIds,
    created: w.createdAt.toISOString(),
  };
}

export async function createWebhook(
  actor: Actor,
  input: {
    name: string;
    url: string;
    events: string[];
    filters?: Record<string, unknown>;
    enabled?: boolean;
    secret?: string;
    excludeActorIds?: string[];
  }
) {
  if (!input.name?.trim() || !input.url || !input.events?.length) {
    throw new JiraApiError(400, jiraError(['name, url and events[] are required.']));
  }
  await assertPublicUrl(input.url);
  const jqlFilter = (input.filters?.['issue-related-events-section'] as string) ?? null;
  if (jqlFilter) parseJql(jqlFilter); // throws → 400 with positioned message
  const wh = await prisma.webhook.create({
    data: {
      name: input.name.trim(),
      url: input.url,
      events: input.events,
      jqlFilter,
      // 065 F3 — AES-256-GCM at rest; the create response returns the local
      // plaintext, never the stored ciphertext.
      secret: encryptSecret(input.secret ?? randomBytes(24).toString('hex')),
      enabled: input.enabled !== false,
      excludeActorIds: input.excludeActorIds ?? [],
      createdById: actor.user.id,
    },
  });
  await auditWebhook(actor, 'webhook.create', 'webhook', wh.id, { name: wh.name, events: wh.events });
  // 065 audit D6 — show the (possibly generated) signing secret once on create;
  // list/get responses never include it, so this is the receiver's only chance
  // to configure X-Hub-Signature-256 verification.
  return { ...toWebhookResponse(wh), secret: readSecret(wh.secret!) };
}

export async function listWebhooks() {
  const hooks = await prisma.webhook.findMany({ orderBy: { createdAt: 'asc' } });
  return { webhookCallbackResponse: hooks.map(toWebhookResponse) };
}

export async function getWebhook(id: string) {
  const wh = await prisma.webhook.findUnique({ where: { id } });
  if (!wh) throw new JiraApiError(404, jiraError(['Webhook not found.']));
  return toWebhookResponse(wh);
}

export async function updateWebhook(actor: Actor, id: string, input: Partial<Parameters<typeof createWebhook>[1]>) {
  const wh = await prisma.webhook.findUnique({ where: { id } });
  if (!wh) throw new JiraApiError(404, jiraError(['Webhook not found.']));
  if (input.url) await assertPublicUrl(input.url);
  const jqlFilter =
    input.filters !== undefined ? ((input.filters?.['issue-related-events-section'] as string) ?? null) : undefined;
  if (jqlFilter) parseJql(jqlFilter);
  const updated = await prisma.webhook.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { events: input.events } : {}),
      ...(jqlFilter !== undefined ? { jqlFilter } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled, ...(input.enabled ? { failureCount: 0 } : {}) } : {}),
      ...(input.secret !== undefined ? { secret: encryptSecret(input.secret) } : {}),
      ...(input.excludeActorIds !== undefined ? { excludeActorIds: input.excludeActorIds } : {}),
    },
  });
  await auditWebhook(actor, 'webhook.update', 'webhook', id, {});
  return toWebhookResponse(updated);
}

export async function deleteWebhook(actor: Actor, id: string) {
  const wh = await prisma.webhook.findUnique({ where: { id } });
  if (!wh) throw new JiraApiError(404, jiraError(['Webhook not found.']));
  await prisma.webhook.delete({ where: { id } });
  await auditWebhook(actor, 'webhook.delete', 'webhook', id, { name: wh.name });
}

// ---------- matching + delivery ----------

/** JQL match evaluated at dispatch time against the post-change issue. */
async function jqlMatches(jql: string, ev: DomainEvent, actor: Actor): Promise<boolean> {
  const issueKey = (ev.payload as { issueKey?: string }).issueKey;
  if (!issueKey) return false;
  const [projectKey, num] = issueKey.split('-');
  const issue = await prisma.issue.findFirst({
    where: { issueNumber: Number(num), project: { key: projectKey } },
    select: { id: true },
  });
  if (!issue) {
    // issue deleted — only evaluate bare project clauses from the payload
    const projectKeyInPayload = (ev.payload as { projectKey?: string }).projectKey;
    const m = /^\s*project\s*=\s*([A-Za-z0-9"']+)\s*$/i.exec(jql);
    return Boolean(
      m && projectKeyInPayload && m[1]!.replace(/["']/g, '').toUpperCase() === projectKeyInPayload.toUpperCase()
    );
  }
  try {
    const compiled = await compileJql(parseJql(jql), actor);
    const match = await prisma.issue.findFirst({
      where: { AND: [compiled.where, { id: issue.id }] },
      select: { id: true },
    });
    return Boolean(match);
  } catch {
    return false;
  }
}

export async function matchWebhooks(ev: DomainEvent): Promise<void> {
  const hooks = await prisma.webhook.findMany({ where: { enabled: true, events: { has: ev.type } } });
  if (!hooks.length) return;
  const systemActor = { user: { id: '', timeZone: 'UTC' }, channel: 'system', token: null } as unknown as Actor;
  for (const wh of hooks) {
    if (ev.actorId && wh.excludeActorIds.includes(ev.actorId)) continue;
    if (wh.jqlFilter && !(await jqlMatches(wh.jqlFilter, ev, systemActor))) continue;
    await prisma.webhookDelivery.create({ data: { webhookId: wh.id, eventId: ev.id } });
  }
}

export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

export async function deliverPending(): Promise<void> {
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: 50,
    include: { webhook: true, event: true },
  });
  for (const d of due) {
    await deliverOne(d.webhook, d.event, d.id, d.attempt);
  }
}

async function deliverOne(
  wh: { id: string; url: string; secret: string | null; enabled: boolean },
  ev: DomainEvent,
  deliveryId: string,
  attempt: number
) {
  if (!wh.enabled) {
    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: 'failed', error: 'webhook disabled' },
    });
    return;
  }
  const body = JSON.stringify(toWebhookBody(ev));
  const started = Date.now();
  let status: string,
    code: number | null = null,
    snippet: string | null = null,
    error: string | null = null;
  try {
    // 064 US5 — re-validate at delivery time (rebinding window) and follow
    // redirects manually with per-hop validation; signature header is stripped
    // on the first hop so a 3xx can't leak the webhook secret.
    const res = await egressFetch(
      wh.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TrackForge-Event-Id': String(ev.id),
          'X-TrackForge-Delivery-Id': deliveryId,
          ...(wh.secret ? { 'X-Hub-Signature-256': signBody(readSecret(wh.secret), body) } : {}),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
      { allowPrivate: allowPrivateWebhooks() }
    );
    code = res.status;
    snippet = (await res.text()).slice(0, 500);
    status = res.ok ? 'success' : 'pending';
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 300) : 'network error';
    status = 'pending';
  }
  const nextAttempt = attempt + 1;
  if (status === 'pending' && nextAttempt >= MAX_ATTEMPTS) status = 'dead';
  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      attempt: nextAttempt,
      status,
      responseCode: code,
      latencyMs: Date.now() - started,
      responseSnippet: snippet,
      error,
      nextAttemptAt: new Date(Date.now() + (BACKOFF_MS[Math.min(nextAttempt, BACKOFF_MS.length - 1)] ?? 43_200_000)),
    },
  });
  const failInc = status === 'success' ? { failureCount: 0 } : { failureCount: { increment: 1 } };
  const updated = await prisma.webhook.update({ where: { id: wh.id }, data: failInc });
  if (updated.failureCount >= DISABLE_AFTER_FAILURES && updated.enabled) {
    await prisma.webhook.update({ where: { id: wh.id }, data: { enabled: false } });
    await prisma.auditEvent.create({
      data: {
        action: 'webhook.auto-disabled',
        entityType: 'webhook',
        entityId: wh.id,
        details: { failures: updated.failureCount },
      },
    });
  }
}

export async function listDeliveries(webhookId: string) {
  const rows = await prisma.webhookDelivery.findMany({
    where: { webhookId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return rows.map((d) => ({
    id: d.id,
    eventId: Number(d.eventId),
    attempt: d.attempt,
    status: d.status,
    responseCode: d.responseCode,
    latencyMs: d.latencyMs,
    responseSnippet: d.responseSnippet,
    error: d.error,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
    created: d.createdAt.toISOString(),
  }));
}

export async function redeliver(deliveryId: string) {
  const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId } });
  if (!d) throw new JiraApiError(404, jiraError(['Delivery not found.']));
  return prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'pending', attempt: 0, nextAttemptAt: new Date(), error: null },
  });
}

// Transactional outbox — every mutation emits a DomainEvent inside its tx.
// A JobRunner tick dispatches undispatched rows to the SSE hub, webhook
// matcher and notification generator (at-least-once, in id order).

import type { Prisma, DomainEvent } from '../lib/pc.js';
import { prisma } from '../prisma.js';
import { resourceSelf } from '../lib/http.js';

export type EventType =
  | 'jira:issue_created'
  | 'jira:issue_updated'
  | 'jira:issue_deleted'
  | 'comment_created'
  | 'comment_updated'
  | 'comment_deleted'
  | 'issuelink_created'
  | 'issuelink_deleted'
  | 'board_configuration_changed'
  | 'sprint_created'
  | 'sprint_updated'
  | 'sprint_started'
  | 'sprint_closed'
  | 'worklog_created'
  | 'worklog_updated'
  | 'worklog_deleted';

export interface EventPayload {
  issueKey?: string;
  projectKey?: string;
  /** Jira changelog items for issue events */
  changelog?: { items: unknown[] };
  /** Issue snapshot (toIssueResponse shape) — survives deletion */
  issue?: Record<string, unknown> | null;
  comment?: unknown;
  link?: unknown;
  board?: unknown;
  sprint?: unknown;
  actor?: { accountId: string; displayName: string; agent?: boolean } | null;
  [k: string]: unknown;
}

interface ActorLike {
  user: { id: string; displayName: string; type?: string };
  channel: string;
  token?: { id: string } | null;
}

export async function emitEvent(
  tx: Prisma.TransactionClient | typeof prisma,
  actor: ActorLike | null,
  input: {
    type: EventType | string;
    projectId?: string | null;
    issueId?: string | null;
    payload: EventPayload;
  }
): Promise<DomainEvent> {
  return tx.domainEvent.create({
    data: {
      type: input.type,
      actorId: actor?.user.id ?? null,
      channel: actor?.channel ?? 'system',
      projectId: input.projectId ?? null,
      issueId: input.issueId ?? null,
      payload: {
        ...input.payload,
        actor: actor
          ? {
              accountId: actor.user.id,
              displayName: actor.user.displayName,
              agent: actor.user.type === 'agent' || undefined,
            }
          : null,
      } as Prisma.InputJsonValue,
    },
  });
}

/** Jira webhook body for a stored event (payload snapshot is authoritative). */
export function toWebhookBody(ev: DomainEvent): Record<string, unknown> {
  const p = ev.payload as EventPayload;
  const base: Record<string, unknown> = {
    timestamp: ev.occurredAt.getTime(),
    webhookEvent: ev.type,
    user: p.actor,
  };
  if (p.issue) base.issue = p.issue;
  if (p.changelog) base.changelog = { id: ev.id.toString(), items: p.changelog.items };
  if (p.comment) base.comment = p.comment;
  if (p.link) base.issueLink = p.link;
  return base;
}

/** Feed/SSE shape — leaner than the webhook body. */
export function toEventResponse(ev: DomainEvent): Record<string, unknown> {
  const p = ev.payload as EventPayload;
  return {
    id: Number(ev.id),
    type: ev.type,
    occurredAt: ev.occurredAt.toISOString(),
    actor: p.actor ?? null,
    channel: ev.channel,
    issueKey: p.issueKey ?? null,
    projectKey: p.projectKey ?? null,
    changelog: p.changelog ?? null,
    comment: p.comment ?? null,
    link: p.link ?? null,
    self: resourceSelf(`/api/internal/events/${ev.id}`),
  };
}

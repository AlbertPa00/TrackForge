import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

export async function audit(
  req: Request,
  action: string,
  entityType: string,
  entityId?: string,
  details?: Record<string, unknown>
) {
  try {
    await prisma.auditEvent.create({
      data: {
        actorId: req.actor?.user.id,
        action,
        entityType,
        entityId,
        details: (details ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: req.ip,
        userAgent: req.headers['user-agent']?.slice(0, 255),
      },
    });
  } catch {
    // auditing must never break the request path
  }
}

export interface AuditFilter {
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
}

export function auditWhere(f: AuditFilter): Prisma.AuditEventWhereInput {
  return {
    ...(f.actorId ? { actorId: f.actorId } : {}),
    ...(f.action ? { action: { contains: f.action, mode: 'insensitive' } } : {}),
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.entityId ? { entityId: f.entityId } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
}

export async function listAuditEvents(startAt = 0, maxResults = 50, filter: AuditFilter = {}) {
  const where = auditWhere(filter);
  const [total, events] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: startAt,
      take: maxResults,
      include: { actor: { select: { id: true, displayName: true, type: true } } },
    }),
  ]);
  return { total, events };
}

/** 061 US7 — distinct action names for the audit filter datalist. */
export async function distinctAuditActions(): Promise<string[]> {
  const rows = await prisma.auditEvent.findMany({
    select: { action: true },
    distinct: ['action'],
    orderBy: { action: 'asc' },
  });
  return rows.map((r) => r.action);
}

/** Audit rows for the CSV export — escaping/transport lives in lib/http sendCsv. */
export function auditEventRows(events: Awaited<ReturnType<typeof listAuditEvents>>['events']): unknown[][] {
  return [
    ['createdAt', 'actor', 'actorId', 'action', 'entityType', 'entityId', 'ip', 'details'],
    ...events.map((e) => [
      e.createdAt.toISOString(),
      e.actor?.displayName ?? '',
      e.actorId ?? '',
      e.action,
      e.entityType,
      e.entityId ?? '',
      e.ip ?? '',
      e.details ? JSON.stringify(e.details) : '',
    ]),
  ];
}

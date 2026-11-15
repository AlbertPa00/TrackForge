import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { resourceSelf } from '../lib/http.js';

export interface ChangeItemInput {
  field: string;
  fieldtype?: string;
  from?: string | null;
  fromString?: string | null;
  to?: string | null;
  toString?: string | null;
}

/** Write a changelog entry inside an existing transaction or standalone. */
export async function recordChange(
  tx: Prisma.TransactionClient | typeof prisma,
  issueId: string,
  actor: Actor,
  items: ChangeItemInput[]
) {
  if (items.length === 0) return;
  await tx.changeHistory.create({
    data: {
      issueId,
      authorId: actor.user.id,
      channel: actor.channel,
      tokenId: actor.token?.id,
      approvedById: actor.internal?.approvedById ?? null,
      items: {
        create: items.map((i) => ({
          field: i.field,
          fieldtype: i.fieldtype ?? 'jira',
          fromVal: i.from ?? null,
          fromString: i.fromString ?? null,
          toVal: i.to ?? null,
          toString: i.toString ?? null,
        })),
      },
    },
  });
}

export async function getChangelog(issueId: string, startAt = 0, maxResults = 50) {
  const [total, histories] = await Promise.all([
    prisma.changeHistory.count({ where: { issueId } }),
    prisma.changeHistory.findMany({
      where: { issueId },
      orderBy: { createdAt: 'desc' },
      skip: startAt,
      take: maxResults,
      include: { items: true, author: true, approver: true },
    }),
  ]);
  return { total, histories };
}

/** Batched getChangelog for multi-issue responses (search expand=changelog):
 *  3 queries total — grouped counts, a windowed top-N id scan per issue
 *  (rides the [issueId, createdAt] index), then one hydrated findMany —
 *  instead of 2 queries × N issues. Returns an entry for every input id. */
export async function getChangelogs(issueIds: string[], maxResults = 50) {
  type Histories = Awaited<ReturnType<typeof getChangelog>>['histories'];
  const empty = new Map<string, { total: number; histories: Histories }>(
    issueIds.map((id) => [id, { total: 0, histories: [] as unknown as Histories }])
  );
  if (!issueIds.length) return empty;
  const [counts, top] = await Promise.all([
    prisma.changeHistory.groupBy({
      by: ['issueId'],
      where: { issueId: { in: issueIds } },
      _count: { _all: true },
    }),
    prisma.$queryRaw<{ id: string; issueId: string }[]>`
      SELECT id, "issueId" FROM (
        SELECT id, "issueId",
          row_number() OVER (PARTITION BY "issueId" ORDER BY "createdAt" DESC) AS rn
        FROM "ChangeHistory"
        WHERE "issueId" = ANY(${issueIds})
      ) t WHERE rn <= ${maxResults}`,
  ]);
  const rows = top.length
    ? await prisma.changeHistory.findMany({
        where: { id: { in: top.map((t) => t.id) } },
        orderBy: { createdAt: 'desc' },
        include: { items: true, author: true, approver: true },
      })
    : [];
  const byIssue = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byIssue.get(r.issueId);
    if (list) list.push(r);
    else byIssue.set(r.issueId, [r]);
  }
  const totals = new Map(counts.map((c) => [c.issueId, c._count._all]));
  return new Map(
    issueIds.map((id) => [id, { total: totals.get(id) ?? 0, histories: byIssue.get(id) ?? [] }])
  );
}

export function toHistoryResponse(h: {
  id: string;
  createdAt: Date;
  channel: string;
  author: { id: string; displayName: string; type: string };
  approver?: { id: string; displayName: string } | null;
  items: {
    field: string;
    fieldtype: string;
    fromVal: string | null;
    fromString: string | null;
    toVal: string | null;
    toString: string | null;
  }[];
}) {
  return {
    id: h.id,
    author: {
      accountId: h.author.id,
      displayName: h.author.displayName,
      ...(h.author.type === 'agent' ? { agent: true } : {}),
    },
    ...(h.approver ? { approvedBy: { accountId: h.approver.id, displayName: h.approver.displayName } } : {}),
    channel: h.channel,
    created: h.createdAt.toISOString(),
    items: h.items.map((i) => ({
      field: i.field,
      fieldtype: i.fieldtype,
      from: i.fromVal,
      fromString: i.fromString,
      to: i.toVal,
      toString: i.toString,
    })),
  };
}

export function toChangelogResponse(histories: Parameters<typeof toHistoryResponse>[0][]) {
  return {
    startAt: 0,
    maxResults: histories.length,
    total: histories.length,
    histories: histories.map(toHistoryResponse),
  };
}

export function changelogSelf(issueKey: string) {
  return resourceSelf(`/rest/api/2/issue/${issueKey}/changelog`);
}

// Sprint 022: per-issue Jira operations — votes, remote links, clone, move.
import crypto from 'crypto';
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { emitEvent } from './eventService.js';
import { recordChange, type ChangeItemInput } from './changelogService.js';
import { resourceSelf } from '../lib/http.js';

// --- votes (Jira POST/DELETE /issue/{key}/votes; GET returns {votes, hasVoted, voters}) ---

export async function voteState(issueId: string, userId: string) {
  const votes = await prisma.issueVote.findMany({
    where: { issueId },
    include: { user: { select: { id: true, email: true, displayName: true } } },
  });
  return {
    votes: votes.length,
    hasVoted: votes.some((v) => v.userId === userId),
    voters: votes.map((v) => ({
      accountId: v.user.id,
      name: v.user.email,
      displayName: v.user.displayName,
    })),
  };
}

/** Idempotent (Jira: re-voting is a no-op 204). */
export async function addVote(issueId: string, userId: string, actor: Actor, issueKey: string) {
  // 057 US5 — join row + denormalized counter in one transaction.
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.issueVote.createMany({ data: [{ issueId, userId }], skipDuplicates: true });
    if (count) await tx.issue.update({ where: { id: issueId }, data: { voteCount: { increment: count } } });
  });
  await emitEvent(prisma, actor, { type: 'issue_voted', issueId, payload: { issueKey } });
}

export async function removeVote(issueId: string, userId: string, actor: Actor, issueKey: string) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.issueVote.deleteMany({ where: { issueId, userId } });
    if (count) await tx.issue.update({ where: { id: issueId }, data: { voteCount: { decrement: count } } });
  });
  await emitEvent(prisma, actor, { type: 'issue_unvoted', issueId, payload: { issueKey } });
}

// --- remote issue links (Jira /issue/{key}/remotelink) ---

export interface RemoteLinkInput {
  url: string;
  title: string;
  summary?: string;
  globalId?: string;
  iconUrl?: string;
}

export function toRemoteLinkResponse(
  link: {
    id: string;
    issueId: string;
    globalId: string | null;
    url: string;
    title: string;
    summary: string | null;
    iconUrl: string | null;
  },
  issueKey: string
) {
  return {
    id: link.id,
    self: resourceSelf(`/rest/api/2/issue/${issueKey}/remotelink/${link.id}`),
    globalId: link.globalId ?? undefined,
    relationship: 'relates to',
    object: {
      url: link.url,
      title: link.title,
      summary: link.summary ?? undefined,
      icon: link.iconUrl ? { url16x16: link.iconUrl, title: link.title, link: link.url } : undefined,
      status: { resolved: false },
    },
  };
}

export async function listRemoteLinks(issueId: string, issueKey: string) {
  const links = await prisma.remoteIssueLink.findMany({
    where: { issueId },
    orderBy: { createdAt: 'asc' },
  });
  return links.map((l: (typeof links)[number]) => toRemoteLinkResponse(l, issueKey));
}

export async function createRemoteLink(issueId: string, issueKey: string, input: RemoteLinkInput, actor: Actor) {
  const link = await prisma.$transaction(async (tx) => {
    const created = await tx.remoteIssueLink.create({
      data: {
        issueId,
        url: input.url,
        title: input.title,
        summary: input.summary,
        globalId: input.globalId,
        iconUrl: input.iconUrl,
      },
    });
    await recordChange(tx, issueId, actor, [{ field: 'Link', to: input.url, toString: `Remote link: ${input.title}` }]);
    await emitEvent(tx, actor, { type: 'issue_remote_link_created', issueId, payload: { issueKey, url: input.url } });
    return created;
  });
  return toRemoteLinkResponse(link, issueKey);
}

export async function deleteRemoteLink(issueId: string, linkId: string, actor: Actor, issueKey: string) {
  await prisma.$transaction(async (tx) => {
    const link = await tx.remoteIssueLink.deleteMany({ where: { id: linkId, issueId } });
    if (link.count) {
      const item: ChangeItemInput = {
        field: 'Link',
        from: linkId,
        fromString: 'Remote link removed',
        to: null,
        toString: null,
      };
      await recordChange(tx, issueId, actor, [item]);
      await emitEvent(tx, actor, { type: 'issue_remote_link_deleted', issueId, payload: { issueKey } });
    }
  });
}

// --- clone (TF extension, sprint 022) ---

export interface CloneOptions {
  summary?: string;
  includeLinks?: boolean;
  includeSubtasks?: boolean;
  includeAttachments?: boolean;
  includeWatchers?: boolean;
  includeVotes?: boolean;
  includeSprint?: boolean;
  dryRun?: boolean;
}

/** Non-tx clone plan — used by dryRun + commit. */
function cloneCreateData(src: any, newIssueNumber: number, rank: string, opts: CloneOptions) {
  return {
    projectId: src.projectId,
    issueNumber: newIssueNumber,
    rank,
    summary: opts.summary ?? `CLONE - ${src.summary}`,
    description: src.description,
    environment: src.environment,
    issueTypeId: src.issueTypeId,
    statusId: src.statusId,
    statusChangedAt: new Date(), // 033 — clone starts its own column tenure
    priorityId: src.priorityId,
    reporterId: src.reporterId,
    assigneeId: src.assigneeId,
    resolutionId: src.resolutionId,
    dueDate: src.dueDate,
    parentId: src.parentId,
    // clone drops its own level but still inherits the parent's (031 eff col)
    effSecurityLevelId: src.parent?.effSecurityLevelId ?? null,
    sprintId: opts.includeSprint === false ? null : src.sprintId,
    storyPoints: src.storyPoints,
    originalEstimateSec: src.originalEstimateSec,
    remainingEstimateSec: src.remainingEstimateSec,
    labels: src.labels,
  };
}

export async function cloneIssue(source: any, actor: Actor, opts: CloneOptions) {
  const { toIssueKey, issueNumberMax, healIssueCounter } = await import('./issueService.js');
  const srcKey = toIssueKey(source.project.key, source.issueNumber);

  if (opts.dryRun) {
    const counter = await prisma.project.findUniqueOrThrow({
      where: { id: source.projectId },
      select: { issueCounter: true },
    });
    const nextNumber = Math.max(counter.issueCounter + 1, (await issueNumberMax(source.projectId)) + 1);
    return {
      dryRun: true,
      key: toIssueKey(source.project.key, nextNumber),
      fields: cloneCreateData(source, nextNumber, '', opts),
      carry: {
        links: opts.includeLinks !== false ? (source.outLinks?.length ?? 0) : 0,
        subtasks: opts.includeSubtasks !== false ? (source.children?.length ?? 0) : 0,
        attachments: opts.includeAttachments !== false ? (source.attachments?.length ?? 0) : 0,
        watchers: opts.includeWatchers !== false ? (source.watchers?.length ?? 0) : 0,
      },
    };
  }

  // US3.3 — attachment byte copy is external I/O and never runs inside the DB
  // transaction (FR-001). Bytes copy to their final paths up front using the
  // pre-generated clone id; if the transaction below aborts, a compensating
  // delete removes them so no storage objects are orphaned.
  const cloneId = crypto.randomUUID();
  const copiedAttachments: { id: string; storagePath: string; src: any }[] = [];
  const copiedPaths: string[] = [];
  if (opts.includeAttachments !== false && (source.attachments?.length ?? 0)) {
    const { getAttachmentStore } = await import('../ports/attachmentStore.js');
    const store = getAttachmentStore();
    try {
      for (const a of source.attachments) {
        const bytes = await store.get(a.storagePath).catch(() => null);
        if (!bytes) continue;
        const id = crypto.randomUUID();
        const storagePath = `att/${cloneId}/${id}`;
        await store.put(storagePath, bytes);
        copiedAttachments.push({ id, storagePath, src: a });
        copiedPaths.push(storagePath);
      }
    } catch (err) {
      await Promise.allSettled(copiedPaths.map((p) => store.delete(p)));
      throw err;
    }
  }

  try {
    return await prisma.$transaction(async (tx) => {
      await healIssueCounter(source.projectId, tx);
      const counter = await tx.project.update({
        where: { id: source.projectId },
        data: { issueCounter: { increment: 1 } },
        select: { issueCounter: true },
      });
      const last = await tx.issue.findFirst({
        where: { projectId: source.projectId, rank: { not: '' } },
        orderBy: { rank: 'desc' },
        select: { rank: true },
      });
      const { rankAfter, initialRank } = await import('../lib/lexorank.js');
      const rank = last?.rank ? rankAfter(last.rank) : initialRank(1);

      const clone = await tx.issue.create({
        data: { id: cloneId, ...cloneCreateData(source, counter.issueCounter, rank, opts) },
      });
      const cloneKey = toIssueKey(source.project.key, clone.issueNumber);

      for (const cf of source.cfValues ?? []) {
        await tx.customFieldValue.create({
          data: { issueId: clone.id, fieldId: cf.fieldId, value: cf.value },
        });
      }
      for (const c of source.components ?? []) {
        await tx.issueComponent.create({ data: { issueId: clone.id, componentId: c.componentId } });
      }
      for (const v of source.versionRefs ?? []) {
        await tx.issueVersion.create({ data: { issueId: clone.id, versionId: v.versionId, kind: v.kind } });
      }
      // outward links only — inward links point AT the source and must not duplicate
      if (opts.includeLinks !== false) {
        for (const l of source.outLinks ?? []) {
          await tx.issueLink.create({
            data: { typeId: l.typeId, outwardId: clone.id, inwardId: l.inwardId },
          });
        }
      }
      // subtasks — shallow clone each (Jira subtasks cannot nest)
      if (opts.includeSubtasks !== false) {
        let subRank = rank; // US3.2 — each subtask gets its own rank, not the parent's
        for (const child of source.children ?? []) {
          const subCounter = await tx.project.update({
            where: { id: source.projectId },
            data: { issueCounter: { increment: 1 } },
            select: { issueCounter: true },
          });
          subRank = rankAfter(subRank);
          const sub = cloneCreateData(child, subCounter.issueCounter, subRank, opts);
          await tx.issue.create({
            data: {
              ...sub,
              summary: `CLONE - ${child.summary}`,
              parentId: clone.id,
              effSecurityLevelId: clone.effSecurityLevelId,
            },
          });
        }
      }
      if (opts.includeWatchers !== false) {
        for (const w of source.watchers ?? []) {
          await tx.watcher.upsert({
            where: { issueId_userId: { issueId: clone.id, userId: w.userId } },
            create: { issueId: clone.id, userId: w.userId },
            update: {},
          });
        }
      }
      if (opts.includeVotes !== false) {
        for (const v of source.votes ?? []) {
          await tx.issueVote.upsert({
            where: { issueId_userId: { issueId: clone.id, userId: v.userId } },
            create: { issueId: clone.id, userId: v.userId },
            update: {},
          });
        }
      }
      // attachments — rows only; bytes were copied before the tx (FR-001)
      for (const att of copiedAttachments) {
        await tx.attachment.create({
          data: {
            id: att.id,
            issueId: clone.id,
            filename: att.src.filename,
            mime: att.src.mime,
            sniffedMime: att.src.sniffedMime,
            size: att.src.size,
            storagePath: att.storagePath,
            authorId: actor.user.id,
            channel: actor.channel,
          },
        });
      }
      // Cloners link both ways (US2.2)
      const clonerType = await tx.issueLinkType.findUnique({ where: { name: 'Cloners' } });
      if (clonerType) {
        await tx.issueLink.create({
          data: { typeId: clonerType.id, outwardId: source.id, inwardId: clone.id },
        });
      }
      // caller auto-watches (US2.2)
      await tx.watcher.upsert({
        where: { issueId_userId: { issueId: clone.id, userId: actor.user.id } },
        create: { issueId: clone.id, userId: actor.user.id },
        update: {},
      });
      // US3.1 — counters reflect the real rows, including the caller's auto-watch.
      const [watcherCount, voteCount] = await Promise.all([
        tx.watcher.count({ where: { issueId: clone.id } }),
        tx.issueVote.count({ where: { issueId: clone.id } }),
      ]);
      await tx.issue.update({ where: { id: clone.id }, data: { watcherCount, voteCount } });
      await recordChange(tx, clone.id, actor, [{ field: 'Link', to: srcKey, toString: `Cloned from ${srcKey}` }]);
      await emitEvent(tx, actor, {
        type: 'issue_cloned',
        issueId: clone.id,
        payload: { issueKey: cloneKey, fromKey: srcKey },
      });
      return { dryRun: false, id: clone.id, key: cloneKey, issueNumber: clone.issueNumber };
    });
  } catch (err) {
    // Compensating delete — the tx rolled back; the copied objects have no rows.
    if (copiedPaths.length) {
      const { getAttachmentStore } = await import('../ports/attachmentStore.js');
      const store = getAttachmentStore();
      await Promise.allSettled(copiedPaths.map((p) => store.delete(p)));
    }
    throw err;
  }
}

// --- move (TF extension, sprint 022) ---

export interface MoveInput {
  projectKey: string;
  issueTypeName?: string;
  statusName?: string;
  dryRun?: boolean;
}

export async function moveIssue(source: any, input: MoveInput, actor: Actor) {
  const { toIssueKey, issueNumberMax, healIssueCounter } = await import('./issueService.js');
  const { hasPermission } = await import('./permissionService.js');
  const { JiraApiError, jiraError } = await import('../lib/errors.js');

  const target = await prisma.project.findUnique({ where: { key: input.projectKey.toUpperCase() } });
  if (!target) throw new JiraApiError(404, jiraError([], { project: 'Project does not exist.' }));

  const srcKey = toIssueKey(source.project.key, source.issueNumber);
  const [canMove, canCreate] = await Promise.all([
    hasPermission(actor, 'MOVE_ISSUES', { projectId: source.projectId }),
    hasPermission(actor, 'CREATE_ISSUES', { projectId: target.id }),
  ]);
  if (!canMove) throw new JiraApiError(403, jiraError(['You do not have permission to move this issue.']));
  if (!canCreate)
    throw new JiraApiError(
      403,
      jiraError([], { project: 'You do not have permission to create issues in the target project.' })
    );

  const targetType = input.issueTypeName
    ? await prisma.issueType.findFirst({
        where: { name: { equals: input.issueTypeName, mode: 'insensitive' }, isSubtask: source.issueType.isSubtask },
      })
    : source.issueType;
  if (!targetType)
    throw new JiraApiError(
      400,
      jiraError([], { issuetype: `Issue type ${input.issueTypeName} not found in target project.` })
    );

  const targetStatus = input.statusName
    ? await prisma.status.findFirst({ where: { name: { equals: input.statusName, mode: 'insensitive' } } })
    : null;

  // field-mapping preview: which carried values drop in the target project
  const targetComponents = await prisma.component.findMany({ where: { projectId: target.id }, select: { name: true } });
  const targetComponentNames = new Set(targetComponents.map((c) => c.name));

  const droppedComponents = (source.components ?? [])
    .filter((c: any) => !targetComponentNames.has(c.component.name))
    .map((c: any) => c.component.name);
  const targetVersions = await prisma.version.findMany({ where: { projectId: target.id }, select: { name: true } });
  const targetVersionNames = new Set(targetVersions.map((v) => v.name));

  const droppedVersions = (source.versionRefs ?? [])
    .filter((v: any) => !targetVersionNames.has(v.version.name))
    .map((v: any) => v.version.name);

  const preview = {
    dryRun: true,
    oldKey: srcKey,
    newKey: toIssueKey(target.key, Math.max(target.issueCounter + 1, (await issueNumberMax(target.id)) + 1)),
    statusMapping: { from: source.status.name, to: targetStatus?.name ?? source.status.name },
    issueType: { from: source.issueType.name, to: targetType.name },
    dropped: { components: droppedComponents, versions: droppedVersions },
    missingRequired: [] as string[],
  };
  if (input.dryRun) return preview;

  return prisma.$transaction(async (tx) => {
    await healIssueCounter(target.id, tx);
    const counter = await tx.project.update({
      where: { id: target.id },
      data: { issueCounter: { increment: 1 } },
      select: { issueCounter: true },
    });
    const oldKey = srcKey;
    const newKey = toIssueKey(target.key, counter.issueCounter);

    // name-matched target rows (carry over what survives the project switch)
    const matchedComponents = (source.components ?? []).filter((c: any) => targetComponentNames.has(c.component.name));
    const compRows = matchedComponents.length
      ? await tx.component.findMany({
          where: { projectId: target.id, name: { in: matchedComponents.map((c: any) => c.component.name) } },
        })
      : [];
    const matchedVersions = (source.versionRefs ?? []).filter((v: any) => targetVersionNames.has(v.version.name));
    const verRows = matchedVersions.length
      ? await tx.version.findMany({
          where: { projectId: target.id, name: { in: matchedVersions.map((v: any) => v.version.name) } },
        })
      : [];

    await tx.issue.update({
      where: { id: source.id },
      data: {
        projectId: target.id,
        issueNumber: counter.issueCounter,
        issueTypeId: targetType.id,
        ...(targetStatus ? { statusId: targetStatus.id, statusChangedAt: new Date() } : {}),
        sprintId: null, // sprint is board-scoped — moving projects drops it
        delegateId: null, // 047 edge — target project may exclude the agent's scope
      },
    });
    // alias old key → same issue (US3.3)
    await tx.issueKeyAlias.create({ data: { oldKey, issueId: source.id } });
    // remap join rows to the target project's component/version ids
    await tx.issueComponent.deleteMany({ where: { issueId: source.id } });
    for (const c of compRows) {
      await tx.issueComponent.create({ data: { issueId: source.id, componentId: c.id } });
    }
    await tx.issueVersion.deleteMany({ where: { issueId: source.id } });
    for (const v of matchedVersions) {
      const row = verRows.find((r) => r.name === v.version.name);
      if (row) await tx.issueVersion.create({ data: { issueId: source.id, versionId: row.id, kind: v.kind } });
    }
    // subtasks move with the parent and renumber into the target like the
    // parent (Jira move): each gets the next target counter + an IssueKeyAlias
    // for its old key. Blindly updating projectId while keeping issueNumber
    // trips @@unique([projectId, issueNumber]) on collisions and leaves both
    // the old key dangling and target.issueCounter behind (053 US5).
    const children = await tx.issue.findMany({
      where: { parentId: source.id },
      orderBy: { issueNumber: 'asc' },
      select: { id: true, issueNumber: true },
    });
    for (const child of children) {
      const childCounter = await tx.project.update({
        where: { id: target.id },
        data: { issueCounter: { increment: 1 } },
        select: { issueCounter: true },
      });
      const childOldKey = toIssueKey(source.project.key, child.issueNumber);
      const childNewKey = toIssueKey(target.key, childCounter.issueCounter);
      await tx.issue.update({
        where: { id: child.id },
        data: { projectId: target.id, issueNumber: childCounter.issueCounter, sprintId: null, delegateId: null },
      });
      await tx.issueKeyAlias.create({ data: { oldKey: childOldKey, issueId: child.id } });
      await recordChange(tx, child.id, actor, [
        { field: 'Key', from: childOldKey, fromString: childOldKey, to: childNewKey, toString: childNewKey },
        {
          field: 'Project',
          from: source.projectId,
          fromString: source.project.name,
          to: target.id,
          toString: target.name,
        },
      ]);
    }
    await recordChange(tx, source.id, actor, [
      { field: 'Key', from: oldKey, fromString: oldKey, to: newKey, toString: newKey },
      {
        field: 'Project',
        from: source.projectId,
        fromString: source.project.name,
        to: target.id,
        toString: target.name,
      },
      ...(source.delegateId
        ? [
            {
              field: 'delegate',
              from: source.delegateId,
              fromString: source.delegate?.displayName ?? source.delegateId,
              to: null,
              toString: null,
            },
          ]
        : []),
    ]);
    await emitEvent(tx, actor, {
      type: 'issue_moved',
      issueId: source.id,
      payload: { fromKey: oldKey, issueKey: newKey, projectKey: target.key },
    });
    return {
      dryRun: false,
      oldKey,
      id: source.id,
      key: newKey,
      issueNumber: counter.issueCounter,
      dropped: preview.dropped,
    };
  });
}

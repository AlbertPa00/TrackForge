import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { getIssueByKey, toIssueKey } from './issueService.js';
import { recordChange } from './changelogService.js';
import { emitEvent } from './eventService.js';
import { requirePermission } from './permissionService.js';
import type { Actor } from '../lib/auth.js';
import { resourceSelf } from '../lib/http.js';

export async function listLinkTypes() {
  const types = await prisma.issueLinkType.findMany({ orderBy: { name: 'asc' } });
  return {
    issueLinkTypes: types.map((t) => ({
      id: t.id,
      name: t.name,
      inward: t.inward,
      outward: t.outward,
      self: resourceSelf(`/rest/api/2/issueLinkType/${t.id}`),
    })),
  };
}

/** Shared validation for createLink/previewLink — resolves the type, both
 *  issues, permissions, self-link and duplicate checks. Zero writes (052). */
async function planLink(typeNameOrId: string, outwardKey: string, inwardKey: string, actor: Actor) {
  const type = await prisma.issueLinkType.findFirst({
    where: { OR: [{ id: typeNameOrId }, { name: typeNameOrId }] },
  });
  if (!type) {
    const all = await prisma.issueLinkType.findMany({ select: { name: true } });
    throw new JiraApiError(
      400,
      jiraError([], {
        'type.name': `Link type '${typeNameOrId}' not found. Allowed: ${all.map((t) => t.name).join(', ')}.`,
      })
    );
  }
  const [outward, inward] = await Promise.all([getIssueByKey(outwardKey), getIssueByKey(inwardKey)]);
  await requirePermission(actor, 'LINK_ISSUES', { projectId: outward.projectId, issue: outward });
  await requirePermission(actor, 'LINK_ISSUES', { projectId: inward.projectId, issue: inward });
  if (outward.id === inward.id) {
    throw new JiraApiError(400, jiraError([], { inwardIssue: 'An issue cannot link to itself.' }));
  }
  const existing = await prisma.issueLink.findUnique({
    where: { typeId_outwardId_inwardId: { typeId: type.id, outwardId: outward.id, inwardId: inward.id } },
  });
  if (existing) {
    throw new JiraApiError(400, jiraError([`${outwardKey} already ${type.outward} ${inwardKey}.`]));
  }
  return { type, outward, inward };
}

/** dryRun twin of createLink — identical validation, returns the would-be link (052). */
export async function previewLink(typeNameOrId: string, outwardKey: string, inwardKey: string, actor: Actor) {
  const { type } = await planLink(typeNameOrId, outwardKey, inwardKey, actor);
  return {
    dryRun: true,
    link: {
      type: { id: type.id, name: type.name, inward: type.inward, outward: type.outward },
      outwardIssue: { key: outwardKey },
      inwardIssue: { key: inwardKey },
      text: `${outwardKey} ${type.outward} ${inwardKey}`,
    },
  };
}

/** Jira: outwardIssue is the source of the outward description ("TF-1 blocks TF-2" → outward=TF-1). */
export async function createLink(typeNameOrId: string, outwardKey: string, inwardKey: string, actor: Actor) {
  const { type, outward, inward } = await planLink(typeNameOrId, outwardKey, inwardKey, actor);
  const link = await prisma.$transaction(async (tx) => {
    const l = await tx.issueLink.create({
      data: { typeId: type.id, outwardId: outward.id, inwardId: inward.id },
    });
    const outItems = [
      { field: 'Link', fieldtype: 'jira', fromString: null, toString: `This issue ${type.outward} ${inwardKey}` },
    ];
    const inItems = [
      { field: 'Link', fieldtype: 'jira', fromString: null, toString: `This issue ${type.inward} ${outwardKey}` },
    ];
    await recordChange(tx, outward.id, actor, outItems);
    await recordChange(tx, inward.id, actor, inItems);
    const linkPayload = {
      id: l.id,
      linkType: { id: type.id, name: type.name, inward: type.inward, outward: type.outward },
      sourceIssueKey: outwardKey,
      destinationIssueKey: inwardKey,
    };
    await emitEvent(tx, actor, {
      type: 'issuelink_created',
      projectId: outward.projectId,
      issueId: outward.id,
      payload: {
        issueKey: outwardKey,
        projectKey: outward.project.key,
        link: linkPayload,
        changelog: { items: outItems },
      },
    });
    await emitEvent(tx, actor, {
      type: 'jira:issue_updated',
      projectId: inward.projectId,
      issueId: inward.id,
      payload: { issueKey: inwardKey, projectKey: inward.project.key, changelog: { items: inItems } },
    });
    return l;
  });
  return link;
}

export async function deleteLink(linkId: string, actor: Actor) {
  const link = await prisma.issueLink.findUnique({
    where: { id: linkId },
    include: { outwardIssue: { include: { project: true } }, inwardIssue: { include: { project: true } }, type: true },
  });
  if (!link) throw new JiraApiError(404, jiraError(['Issue link does not exist.']));
  const outwardKey = toIssueKey(link.outwardIssue.project.key, link.outwardIssue.issueNumber);
  const inwardKey = toIssueKey(link.inwardIssue.project.key, link.inwardIssue.issueNumber);
  await requirePermission(actor, 'LINK_ISSUES', { projectId: link.outwardIssue.projectId, issue: link.outwardIssue });
  await prisma.$transaction(async (tx) => {
    const outItems = [
      { field: 'Link', fieldtype: 'jira', fromString: `This issue ${link.type.outward} ${inwardKey}`, toString: null },
    ];
    const inItems = [
      { field: 'Link', fieldtype: 'jira', fromString: `This issue ${link.type.inward} ${outwardKey}`, toString: null },
    ];
    await recordChange(tx, link.outwardId, actor, outItems);
    await recordChange(tx, link.inwardId, actor, inItems);
    await emitEvent(tx, actor, {
      type: 'issuelink_deleted',
      projectId: link.outwardIssue.projectId,
      issueId: link.outwardId,
      payload: {
        issueKey: outwardKey,
        projectKey: link.outwardIssue.project.key,
        link: {
          id: link.id,
          linkType: { id: link.type.id, name: link.type.name, inward: link.type.inward, outward: link.type.outward },
          sourceIssueKey: outwardKey,
          destinationIssueKey: inwardKey,
        },
        changelog: { items: outItems },
      },
    });
    await emitEvent(tx, actor, {
      type: 'jira:issue_updated',
      projectId: link.inwardIssue.projectId,
      issueId: link.inwardId,
      payload: { issueKey: inwardKey, projectKey: link.inwardIssue.project.key, changelog: { items: inItems } },
    });
    await tx.issueLink.delete({ where: { id: linkId } });
  });
}

export async function listResolutions() {
  const resolutions = await prisma.resolution.findMany({ orderBy: { sequence: 'asc' } });
  return resolutions.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    self: resourceSelf(`/rest/api/2/resolution/${r.id}`),
  }));
}

export async function listLabels(startAt = 0, maxResults = 100) {
  const rows = await prisma.issue.findMany({
    where: { labels: { isEmpty: false } },
    select: { labels: true },
  });
  const all = [...new Set(rows.flatMap((r) => r.labels))].sort();
  return {
    startAt,
    maxResults: Math.min(100, maxResults),
    total: all.length,
    values: all.slice(startAt, startAt + maxResults),
  };
}

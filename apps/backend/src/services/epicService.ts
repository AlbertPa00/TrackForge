// Epic endpoints — Jira agile /epic surface mapped onto parentId/hierarchy.
// `Epic Link`/`epic` writes from the issue API already route through the
// generic parent field; these endpoints expose the agile view of it.

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { parseIssueKey, toIssueKey, toIssueResponse } from './issueService.js';
import { recordChange } from './changelogService.js';
import { emitEvent } from './eventService.js';
import { requirePermission } from './permissionService.js';
import type { Actor } from '../lib/auth.js';
import type { Prisma } from '../lib/pc.js';
import { resourceSelf } from '../lib/http.js';

const issueInclude = {
  project: true,
  issueType: true,
  status: true,
  priority: true,
  sprint: true,
  assignee: true,
} as const;

async function resolveEpic(epicKey: string) {
  const { projectKey, issueNumber } = await parseIssueKey(epicKey);
  const epic = await prisma.issue.findFirst({
    where: { issueNumber, project: { key: projectKey } },
    include: { project: true, issueType: true, status: true },
  });
  if (!epic) {
    throw new JiraApiError(404, jiraError([`Epic '${epicKey}' does not exist.`]));
  }
  if (epic.issueType.hierarchyLevel !== 1) {
    throw new JiraApiError(400, jiraError([`Issue '${epicKey}' is not an Epic.`]));
  }
  return epic;
}

function toEpicResponse(epic: {
  id: string;
  issueNumber: number;
  summary: string;
  project: { key: string };
  status: { category: string };
}) {
  const key = toIssueKey(epic.project.key, epic.issueNumber);
  return {
    id: epic.id,
    key,
    self: resourceSelf(`/rest/agile/1.0/epic/${key}`),
    name: epic.summary, // no separate Epic Name field — summary doubles as it
    summary: epic.summary,
    done: epic.status.category === 'done',
  };
}

export async function getEpic(epicKey: string) {
  return toEpicResponse(await resolveEpic(epicKey));
}

export async function listEpicIssues(
  epicKey: string,
  pagination: { startAt: number; maxResults: number },
  actor?: import('../lib/auth.js').Actor
) {
  const epic = await resolveEpic(epicKey);
  const { securityGateWhere } = await import('./issueSecurityService.js');
  const { canSeeProjectId } = await import('./visibilityService.js');
  // Single-project surface (epic children share the epic's project — see
  // resolveParentRef): 064 pattern = project gate + security-only predicate.
  if (actor && !(await canSeeProjectId(actor, epic.projectId))) {
    throw new JiraApiError(404, jiraError([`Epic '${epicKey}' does not exist.`]));
  }
  const where = actor ? { AND: [{ parentId: epic.id }, await securityGateWhere(actor)] } : { parentId: epic.id };
  const [total, issues] = await Promise.all([
    prisma.issue.count({ where }),
    prisma.issue.findMany({
      where,
      orderBy: [{ rank: 'asc' }, { issueNumber: 'asc' }],
      skip: pagination.startAt,
      take: pagination.maxResults,
      include: issueInclude,
    }),
  ]);
  const { cfFieldsForIssues } = await import('./customFieldService.js');
  const cfMap = await cfFieldsForIssues(issues);
  return {
    startAt: pagination.startAt,
    maxResults: pagination.maxResults,
    total,
    issues: issues.map((i) => toIssueResponse(i, { cfFields: cfMap.get(i.id) })),
  };
}

async function resolveKeys(issueKeys: string[]) {
  const issues = [];
  for (const key of issueKeys) {
    const { projectKey, issueNumber } = await parseIssueKey(key);
    const issue = await prisma.issue.findFirst({
      where: { issueNumber, project: { key: projectKey } },
      include: {
        project: true,
        issueType: true,
        parent: { select: { id: true, issueNumber: true, project: { select: { key: true } } } },
      },
    });
    if (!issue) {
      throw new JiraApiError(400, jiraError([`Issue '${key}' does not exist.`]));
    }
    issues.push(issue);
  }
  return issues;
}

async function epicLinkChange(
  tx: Prisma.TransactionClient,
  actor: Actor | undefined | null,
  issue: { id: string; issueNumber: number; projectId: string; project: { key: string } },
  fromKey: string | null,
  toKey: string | null
) {
  const items = [{ field: 'Epic Link', fromString: fromKey, toString: toKey }];
  const a =
    actor ??
    ({
      user: { id: '', displayName: 'System', type: 'agent' },
      channel: 'system',
      token: null,
    } as unknown as Actor);
  await recordChange(tx, issue.id, a, items);
  await emitEvent(tx, a, {
    type: 'jira:issue_updated',
    projectId: issue.projectId,
    issueId: issue.id,
    payload: {
      issueKey: toIssueKey(issue.project.key, issue.issueNumber),
      projectKey: issue.project.key,
      changelog: { items },
    },
  });
}

/** POST /epic/{key}/issue — move issues under the epic. */
export async function moveIssuesToEpic(epicKey: string, issueKeys: string[], actor?: Actor) {
  const epic = await resolveEpic(epicKey);
  const issues = await resolveKeys(issueKeys);
  // H3/H2-a: epic membership edits the issue (EDIT_ISSUES on its project)
  // and schedules the epic's backlog (SCHEDULE_ISSUES on the epic project).
  if (actor) {
    await requirePermission(actor, 'SCHEDULE_ISSUES', { projectId: epic.projectId });
    for (const projectId of new Set(issues.map((i) => i.projectId))) {
      await requirePermission(actor, 'EDIT_ISSUES', { projectId });
    }
  }
  const epicIssueKey = toIssueKey(epic.project.key, epic.issueNumber);
  const { cascadeEffectiveSecurity } = await import('./issueSecurityService.js');
  await prisma.$transaction(async (tx) => {
    for (const issue of issues) {
      if (issue.id === epic.id) continue;
      if (issue.issueType.hierarchyLevel !== 0 || issue.issueType.isSubtask) {
        throw new JiraApiError(
          400,
          jiraError([`Only stories/tasks/bugs can join an epic ('${issue.issueType.name}' cannot).`])
        );
      }
      const from = issue.parent ? toIssueKey(issue.parent.project.key, issue.parent.issueNumber) : null;
      if (issue.parentId === epic.id) continue;
      const eff = issue.securityLevelId ?? epic.effSecurityLevelId;
      await tx.issue.update({
        where: { id: issue.id },
        data: { parentId: epic.id, effSecurityLevelId: eff },
      });
      await cascadeEffectiveSecurity(issue.id, eff, tx);
      await epicLinkChange(tx, actor, issue, from, epicIssueKey);
    }
  });
}

/** POST /epic/none/issue — remove issues from their epics. */
export async function removeIssuesFromEpic(issueKeys: string[], actor?: Actor) {
  const issues = await resolveKeys(issueKeys);
  if (actor) {
    for (const projectId of new Set(issues.map((i) => i.projectId))) {
      await requirePermission(actor, 'EDIT_ISSUES', { projectId });
    }
  }
  const { cascadeEffectiveSecurity } = await import('./issueSecurityService.js');
  await prisma.$transaction(async (tx) => {
    for (const issue of issues) {
      if (!issue.parentId || !issue.parent) continue;
      const from = toIssueKey(issue.parent.project.key, issue.parent.issueNumber);
      await tx.issue.update({
        where: { id: issue.id },
        data: { parentId: null, effSecurityLevelId: issue.securityLevelId },
      });
      await cascadeEffectiveSecurity(issue.id, issue.securityLevelId, tx);
      await epicLinkChange(tx, actor, issue, from, null);
    }
  });
}

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { toIssueResponse, parseIssueKey, toIssueKey, relatedIssueIds } from './issueService.js';
import { emitEvent } from './eventService.js';
import { recordChange } from './changelogService.js';
import { requirePermission } from './permissionService.js';
import type { Actor } from '../lib/auth.js';
import { securityGateWhere } from './issueSecurityService.js';
import { canSeeProjectId, visibleIssueIds } from './visibilityService.js';
import type { Prisma } from '../lib/pc.js';
import { resourceSelf } from '../lib/http.js';

const issueInclude = {
  project: true,
  issueType: true,
  status: true,
  priority: true,
  sprint: true,
  // 062 US1 — sprint rows share BacklogRow: assignee avatars and epic pills
  // both come from these fields. Flag state flows via cfFieldsForIssues.
  assignee: true,
  parent: { include: { project: true, issueType: true, status: true } },
} as const;

type SprintRow = {
  id: string;
  projectId: string;
  boardId: string;
  name: string;
  state: string;
  goal: string | null;
  startDate: Date | null;
  endDate: Date | null;
  completeDate: Date | null;
  sequence: number;
};

export function toSprintResponse(sprint: SprintRow, projectKey?: string) {
  return {
    id: sprint.id,
    self: resourceSelf(`/rest/agile/1.0/sprint/${sprint.id}`),
    state: sprint.state,
    name: sprint.name,
    goal: sprint.goal ?? undefined,
    originBoardId: sprint.boardId,
    projectKey,
    sequence: sprint.sequence,
    startDate: sprint.startDate?.toISOString(),
    endDate: sprint.endDate?.toISOString(),
    completeDate: sprint.completeDate?.toISOString(),
  };
}

/** Resolves board by id or owning project key (kept alias for 004 callers). */
async function resolveBoardForSprints(idOrKey: string) {
  const { resolveBoard } = await import('./boardService.js');
  return resolveBoard(idOrKey);
}

export async function createSprint(
  data: {
    originBoardId: string;
    name?: string;
    goal?: string;
    startDate?: string;
    endDate?: string;
  },
  actor?: Actor
) {
  const board = await resolveBoardForSprints(data.originBoardId);
  const project = board.project;
  // Jira Software: sprint lifecycle (create/start/complete/edit/delete) needs
  // MANAGE_SPRINTS; SCHEDULE_ISSUES governs assigning issues to sprints.
  if (actor) await requirePermission(actor, 'MANAGE_SPRINTS', { projectId: project.id });
  const maxSeq = await prisma.sprint.aggregate({
    where: { boardId: board.id },
    _max: { sequence: true },
  });
  const sprint = await prisma.$transaction(async (tx) => {
    const s = await tx.sprint.create({
      data: {
        projectId: project.id,
        boardId: board.id,
        name: data.name?.trim() || `${project.key} Sprint ${(maxSeq._max.sequence ?? 0) + 1}`,
        goal: data.goal,
        startDate: parseDate(data.startDate) ?? null,
        endDate: parseDate(data.endDate) ?? null,
        state: 'future',
        sequence: (maxSeq._max.sequence ?? 0) + 1,
      },
    });
    // Creating any sprint marks the board scrum.
    if (board.type !== 'scrum') {
      await tx.board.update({ where: { id: board.id }, data: { type: 'scrum' } });
    }
    if (actor) {
      await emitEvent(tx, actor, {
        type: 'sprint_created',
        projectId: project.id,
        payload: { projectKey: project.key, sprint: toSprintResponse(s, project.key) },
      });
    }
    return s;
  });
  return toSprintResponse(sprint, project.key);
}

export async function listSprints(boardIdOrKey: string, stateFilter?: string[]) {
  const board = await resolveBoardForSprints(boardIdOrKey);
  const sprints = await prisma.sprint.findMany({
    where: {
      boardId: board.id,
      state: stateFilter?.length ? { in: stateFilter } : { not: 'closed' },
    },
  });

  const order = { active: 0, future: 1, closed: 2 };
  return sprints
    .sort(
      (a, b) => order[a.state as keyof typeof order] - order[b.state as keyof typeof order] || a.sequence - b.sequence
    )
    .map((s) => toSprintResponse(s, board.project.key));
}

export async function getSprint(sprintId: string) {
  const sprint = await requireSprint(sprintId);
  const project = await prisma.project.findUnique({ where: { id: sprint.projectId } });
  return toSprintResponse(sprint, project?.key);
}

async function requireSprint(sprintId: string) {
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint) {
    throw new JiraApiError(404, jiraError(['The sprint does not exist.']));
  }
  return sprint;
}

export interface CompleteSprintOptions {
  /** Where open (non-done) issues go on close. Default: backlog. */
  moveOpenIssuesTo?: 'backlog' | 'new' | string; // 'new' | existing future-sprint id
  newSprintName?: string;
}

export async function updateSprint(
  sprintId: string,
  data: {
    name?: string;
    goal?: string | null;
    state?: string;
    startDate?: string;
    endDate?: string;
  } & CompleteSprintOptions,
  actor?: Actor
) {
  const sprint = await requireSprint(sprintId);
  if (actor) await requirePermission(actor, 'MANAGE_SPRINTS', { projectId: sprint.projectId });

  if (sprint.state === 'closed') {
    // Closed sprints are read-only (Jira PUT /sprint on closed → 400).
    throw new JiraApiError(400, jiraError(['A closed sprint cannot be edited.']));
  }
  if (data.state !== undefined && !['active', 'closed', 'future'].includes(data.state)) {
    throw new JiraApiError(400, jiraError([`Invalid sprint state '${data.state}'.`]));
  }
  if (data.state === 'future' && sprint.state === 'active') {
    throw new JiraApiError(400, jiraError(['An active sprint cannot return to future — complete it instead.']));
  }
  if (data.state === 'active' && sprint.state === 'future') {
    const other = await prisma.sprint.findFirst({
      where: { boardId: sprint.boardId, state: 'active', id: { not: sprint.id } },
    });
    if (other) {
      throw new JiraApiError(400, jiraError([`Another sprint ('${other.name}') is already active for this board.`]));
    }
  }
  // Carry-over target validation (before the tx, needs ids).
  let carrySprintId: string | null = null;
  if (data.state === 'closed' && data.moveOpenIssuesTo && data.moveOpenIssuesTo !== 'backlog') {
    if (data.moveOpenIssuesTo === 'new') {
      carrySprintId = 'new';
    } else {
      const target = await requireSprint(data.moveOpenIssuesTo);
      if (target.state !== 'future' || target.boardId !== sprint.boardId) {
        throw new JiraApiError(
          400,
          jiraError(['Incomplete issues can only move to a future sprint on the same board.'])
        );
      }
      carrySprintId = target.id;
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const updatedSprint = await tx.sprint.update({
      where: { id: sprint.id },
      data: {
        name: data.name?.trim() || undefined,
        goal: data.goal,
        state: data.state,
        startDate: data.state === 'active' && !sprint.startDate ? now : parseDate(data.startDate),
        endDate: data.state === 'closed' && !sprint.endDate ? now : parseDate(data.endDate),
        completeDate: data.state === 'closed' ? now : undefined,
      },
    });

    if (data.state === 'closed') {
      // Carry-over: open (non-done-category) issues move to backlog, an
      // existing future sprint, or a newly created one. Done issues keep
      // sprintId — they stay members of the closed sprint for reporting.
      const open = await tx.issue.findMany({
        where: { sprintId: sprint.id, status: { category: { not: 'done' } } },
        select: { id: true, issueNumber: true },
      });
      // Membership intervals end only for issues leaving the sprint.
      if (open.length) {
        await tx.issueSprint.updateMany({
          where: { sprintId: sprint.id, removedAt: null, issueId: { in: open.map((i) => i.id) } },
          data: { removedAt: now },
        });
      }
      let targetName: string | null = null;
      let targetId: string | null = null;
      if (open.length) {
        if (carrySprintId === 'new') {
          const maxSeq = await tx.sprint.aggregate({
            where: { boardId: sprint.boardId },
            _max: { sequence: true },
          });
          const proj = await tx.project.findUnique({
            where: { id: sprint.projectId },
            select: { key: true },
          });
          const created = await tx.sprint.create({
            data: {
              projectId: sprint.projectId,
              boardId: sprint.boardId,
              name: data.newSprintName?.trim() || `${proj?.key ?? ''} Sprint ${(maxSeq._max.sequence ?? 0) + 1}`,
              state: 'future',
              sequence: (maxSeq._max.sequence ?? 0) + 1,
            },
          });
          targetId = created.id;
          targetName = created.name;
        } else if (carrySprintId) {
          const target = await tx.sprint.findUnique({ where: { id: carrySprintId } });
          targetId = target!.id;
          targetName = target!.name;
        }
        const proj = await tx.project.findUnique({
          where: { id: sprint.projectId },
          select: { key: true },
        });
        for (const iss of open) {
          await tx.issue.update({
            where: { id: iss.id },
            data: { sprintId: targetId },
          });
          if (targetId) {
            await tx.issueSprint.create({
              data: { issueId: iss.id, sprintId: targetId, addedAt: now },
            });
          }
          const items = [{ field: 'Sprint', fromString: sprint.name, toString: targetName }];
          await recordChange(tx, iss.id, actor ?? systemActor(), items);
          await emitEvent(tx, actor ?? systemActor(), {
            type: 'jira:issue_updated',
            projectId: sprint.projectId,
            issueId: iss.id,
            payload: {
              issueKey: toIssueKey(proj?.key ?? '', iss.issueNumber),
              projectKey: proj?.key,
              changelog: { items },
            },
          });
        }
      }
    }

    if (actor) {
      const type =
        data.state === 'active' && sprint.state !== 'active'
          ? 'sprint_started'
          : data.state === 'closed' && sprint.state !== 'closed'
            ? 'sprint_closed'
            : 'sprint_updated';
      const proj = await tx.project.findUnique({
        where: { id: sprint.projectId },
        select: { key: true },
      });
      await emitEvent(tx, actor, {
        type,
        projectId: sprint.projectId,
        payload: { projectKey: proj?.key, sprint: toSprintResponse(updatedSprint, proj?.key) },
      });
    }

    return updatedSprint;
  });

  return toSprintResponse(updated);
}

/** DELETE /sprint/{id} — future sprints only; their issues return to backlog. */
export async function deleteSprint(sprintId: string, actor?: Actor) {
  const sprint = await requireSprint(sprintId);
  if (actor) await requirePermission(actor, 'MANAGE_SPRINTS', { projectId: sprint.projectId });
  if (sprint.state !== 'future') {
    throw new JiraApiError(400, jiraError([`Only future sprints can be deleted (this one is ${sprint.state}).`]));
  }
  await prisma.$transaction(async (tx) => {
    const members = await tx.issue.findMany({
      where: { sprintId: sprint.id },
      select: { id: true, issueNumber: true },
    });
    const now = new Date();
    await tx.issueSprint.updateMany({
      where: { sprintId: sprint.id, removedAt: null },
      data: { removedAt: now },
    });
    const proj = await tx.project.findUnique({
      where: { id: sprint.projectId },
      select: { key: true },
    });
    for (const iss of members) {
      await tx.issue.update({ where: { id: iss.id }, data: { sprintId: null } });
      const items = [{ field: 'Sprint', fromString: sprint.name, toString: null }];
      await recordChange(tx, iss.id, actor ?? systemActor(), items);
      await emitEvent(tx, actor ?? systemActor(), {
        type: 'jira:issue_updated',
        projectId: sprint.projectId,
        issueId: iss.id,
        payload: {
          issueKey: toIssueKey(proj?.key ?? '', iss.issueNumber),
          projectKey: proj?.key,
          changelog: { items },
        },
      });
    }
    await tx.sprint.delete({ where: { id: sprint.id } });
    if (actor) {
      await emitEvent(tx, actor, {
        type: 'sprint_deleted',
        projectId: sprint.projectId,
        payload: { projectKey: proj?.key, sprint: toSprintResponse(sprint, proj?.key) },
      });
    }
  });
}

function parseDate(value?: string) {
  return value ? new Date(value) : undefined;
}

export async function listSprintIssues(
  sprintId: string,
  pagination: { startAt: number; maxResults: number },
  actor?: Actor,
  opts: { quickFilterIds?: string[] } = {}
) {
  const sprint = await requireSprint(sprintId);
  // 064 gate: a sprint in a project the actor can't see doesn't exist for
  // them; the security-only predicate then covers gate 3 on the issues.
  if (actor && !(await canSeeProjectId(actor, sprint.projectId))) {
    throw new JiraApiError(404, jiraError(['The sprint does not exist.']));
  }
  // 062 US3 — board quick filters scope sprint sections the same way they
  // scope the backlog group (the sprint belongs to the board either way).
  const { quickFilterWhere, resolveBoard, backlogVisibleStatusIds } = await import('./boardService.js');
  const qfWheres = await quickFilterWhere(sprint.boardId, opts.quickFilterIds, actor);
  // Jira parity: not-started sprints hide issues in rightmost-column statuses;
  // the active sprint keeps done issues visible until completion.
  const visibleStatusIds =
    sprint.state === 'future' ? backlogVisibleStatusIds(await resolveBoard(sprint.boardId)) : null;
  const where = {
    AND: [
      { sprintId },
      ...(visibleStatusIds ? [{ statusId: { in: visibleStatusIds } }] : []),
      ...qfWheres,
      ...(actor ? [await securityGateWhere(actor)] : []),
    ],
  };
  const [total, issues] = await Promise.all([
    prisma.issue.count({ where }),
    prisma.issue.findMany({
      where,
      // Jira orders sprint issues by rank (that's what backlog/board ordering
      // edits); issueNumber breaks ties and covers legacy unranked rows.
      orderBy: [{ rank: 'asc' }, { issueNumber: 'asc' }],
      skip: pagination.startAt,
      take: pagination.maxResults,
      include: issueInclude,
    }),
  ]);
  const { cfFieldsForIssues } = await import('./customFieldService.js');
  const cfMap = await cfFieldsForIssues(issues);
  const visibleRelIds = actor ? await visibleIssueIds(actor, relatedIssueIds(issues)) : undefined;
  return {
    startAt: pagination.startAt,
    maxResults: pagination.maxResults,
    total,
    issues: issues.map((i) => toIssueResponse(i, { cfFields: cfMap.get(i.id), visibleRelIds })),
  };
}

function systemActor(): Actor {
  return {
    user: { id: '', displayName: 'System', type: 'agent' },
    channel: 'system',
    token: null,
  } as unknown as Actor;
}

/** Changelog + event for a sprint-field change on a single issue (inside tx). */
async function sprintChange(
  tx: Prisma.TransactionClient,
  actor: Actor | undefined,
  issue: { id: string; issueNumber: number; projectId: string; project: { key: string } },
  fromName: string | null,
  toName: string | null
) {
  const a = actor ?? systemActor();
  const items = [{ field: 'Sprint', fromString: fromName, toString: toName }];
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

async function resolveIssues(issueKeys: string[]) {
  const issues = [];
  for (const key of issueKeys) {
    const { projectKey, issueNumber } = await parseIssueKey(key);
    const issue = await prisma.issue.findFirst({
      where: { issueNumber, project: { key: projectKey } },
      select: {
        id: true,
        issueNumber: true,
        projectId: true,
        sprintId: true,
        project: { select: { key: true } },
        sprint: { select: { name: true } },
      },
    });
    if (!issue) {
      throw new JiraApiError(400, jiraError([`Issue '${key}' does not exist.`]));
    }
    issues.push(issue);
  }
  return issues;
}

export async function moveIssuesToSprint(sprintId: string, issueKeys: string[], actor?: Actor) {
  const sprint = await requireSprint(sprintId);
  if (actor) await requirePermission(actor, 'SCHEDULE_ISSUES', { projectId: sprint.projectId });
  if (sprint.state === 'closed') {
    throw new JiraApiError(400, jiraError(['Issues cannot be added to a closed sprint.']));
  }
  const issues = await resolveIssues(issueKeys);
  for (const issue of issues) {
    // Board is per-project today, so sprint membership is per-project too.
    if (issue.projectId !== sprint.projectId) {
      throw new JiraApiError(400, jiraError([`Issue does not belong to the sprint's project.`]));
    }
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const issue of issues) {
      await tx.issue.update({ where: { id: issue.id }, data: { sprintId: sprint.id } });
      // Close any still-open membership on another sprint, then open a new one.
      await tx.issueSprint.updateMany({
        where: { issueId: issue.id, removedAt: null },
        data: { removedAt: now },
      });
      await tx.issueSprint.create({
        data: { issueId: issue.id, sprintId: sprint.id, addedAt: now },
      });
      await sprintChange(tx, actor, issue, issue.sprint?.name ?? null, sprint.name);
    }
  });
}

export async function moveIssuesToBacklog(issueKeys: string[], actor?: Actor) {
  const issues = await resolveIssues(issueKeys);
  if (actor) {
    for (const projectId of new Set(issues.map((i) => i.projectId))) {
      await requirePermission(actor, 'SCHEDULE_ISSUES', { projectId });
    }
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const issue of issues) {
      if (!issue.sprintId) continue;
      await tx.issue.update({ where: { id: issue.id }, data: { sprintId: null } });
      await tx.issueSprint.updateMany({
        where: { issueId: issue.id, sprintId: issue.sprintId, removedAt: null },
        data: { removedAt: now },
      });
      await sprintChange(tx, actor, issue, issue.sprint?.name ?? null, null);
    }
  });
}

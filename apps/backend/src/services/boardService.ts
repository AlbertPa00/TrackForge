import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { toStatusCategory } from './metaService.js';
import { toIssueResponse, parseIssueKey, toIssueKey, relatedIssueIds } from './issueService.js';
import { rankBetween, spreadRanks } from '../lib/lexorank.js';
import { recordChange } from './changelogService.js';
import { emitEvent } from './eventService.js';
import { requirePermission } from './permissionService.js';
import type { Actor } from '../lib/auth.js';
import { securityGateWhere } from './issueSecurityService.js';
import { canSeeProjectId, visibleIssueWhere, visibleIssueIds } from './visibilityService.js';
import type { Prisma } from '../lib/pc.js';
import { resourceSelf } from '../lib/http.js';

type Where = Prisma.IssueWhereInput;

const issueInclude = {
  project: true,
  issueType: true,
  status: true,
  priority: true,
  sprint: true,
  assignee: true,
  // 062 US1 — epic pill/filter/counts need fields.parent on list payloads.
  parent: { include: { project: true, issueType: true, status: true } },
  cfValues: true,
  // 033 — card indicators via aggregate counts (no per-row joins)
  _count: { select: { comments: true, attachments: true, outLinks: true, inLinks: true } },
} as const;

const boardInclude = {
  project: true,
  columns: {
    include: { statuses: { include: { status: true } } },
    orderBy: { position: 'asc' as const },
  },
} as const;

/**
 * Resolves a board by its id, or (legacy alias) by the owning project's
 * key/id — D7. With N:1 boards (033) a project-key lookup always lands on the
 * project's **default** board, preserving the 003/004 single-board contract.
 */
export async function resolveBoard(idOrKey: string) {
  const byId = await prisma.board.findUnique({ where: { id: idOrKey }, include: boardInclude });
  if (byId) return byId;
  const board = await prisma.board.findFirst({
    where: {
      OR: [{ project: { key: idOrKey.toUpperCase() } }, { projectId: idOrKey }],
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    include: boardInclude,
  });
  if (!board) {
    throw new JiraApiError(404, jiraError([`No board could be found for '${idOrKey}'.`]));
  }
  return board;
}

function toBoardResponse(board: {
  id: string;
  name: string;
  type: string;
  isDefault?: boolean;
  project: { id: string; key: string; name: string };
}) {
  return {
    id: board.id,
    self: resourceSelf(`/rest/agile/1.0/board/${board.id}`),
    name: board.name,
    type: board.type,
    isDefault: board.isDefault ?? false,
    location: {
      projectId: board.project.id,
      projectKey: board.project.key,
      projectName: board.project.name,
    },
  };
}

export async function listBoards(projectKeyOrId?: string) {
  if (!projectKeyOrId) {
    const boards = await prisma.board.findMany({ include: boardInclude, orderBy: { createdAt: 'asc' } });
    return boards.map(toBoardResponse);
  }
  // Jira: projectKeyOrId lists ALL the project's boards; a bare board id returns it.
  const byId = await prisma.board.findUnique({ where: { id: projectKeyOrId }, include: boardInclude });
  if (byId) return [toBoardResponse(byId)];
  const boards = await prisma.board.findMany({
    where: { OR: [{ project: { key: projectKeyOrId.toUpperCase() } }, { projectId: projectKeyOrId }] },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    include: boardInclude,
  });
  if (!boards.length) {
    throw new JiraApiError(404, jiraError([`No board could be found for '${projectKeyOrId}'.`]));
  }
  return boards.map(toBoardResponse);
}

/** The board's effective JQL: saved filter's JQL when filterId is set, else the
 *  legacy direct-JQL text column. Compiles to a Where clause (FR-001). */
export async function boardFilterWhere(
  board: { filterId: string | null; filter: string | null },
  actor?: Actor
): Promise<Where | null> {
  let jql = board.filter?.trim() ?? '';
  if (board.filterId) {
    const f = await prisma.filter.findUnique({ where: { id: board.filterId }, select: { jql: true } });
    if (f) jql = f.jql;
  }
  if (!jql) return null;
  const { parseJql } = await import('../jql/parser.js');
  const { compileJql } = await import('../jql/compiler.js');
  const actor2 = actor ?? ({ user: await prisma.user.findFirstOrThrow({ where: { isAdmin: true } }) } as Actor);
  const { where } = await compileJql(parseJql(jql), actor2);
  return where as Where;
}

/** Compiles each quick filter's JQL and ANDs it onto the base where (FR-003 —
 *  quick filters compose, never replace). Invalid ids/name refs are skipped
 *  (a broken chip must not break the board — edge case in the sprint doc). */
export async function quickFilterWhere(
  boardId: string,
  quickFilterIds: string[] | undefined,
  actor?: Actor
): Promise<Where[]> {
  if (!quickFilterIds?.length) return [];
  const { parseJql, JqlParseError } = await import('../jql/parser.js');
  const { compileJql } = await import('../jql/compiler.js');
  const actor2 = actor ?? ({ user: await prisma.user.findFirstOrThrow({ where: { isAdmin: true } }) } as Actor);
  const rows = await prisma.boardQuickFilter.findMany({
    where: { boardId, id: { in: quickFilterIds } },
  });
  const wheres: Where[] = [];
  for (const qf of rows) {
    try {
      const { where } = await compileJql(parseJql(qf.jql), actor2);
      wheres.push(where as Where);
    } catch (e) {
      if (!(e instanceof JqlParseError)) throw e; // broken JQL → chip ignored, board still loads
    }
  }
  return wheres;
}

export async function getBoard(idOrKey: string) {
  return toBoardResponse(await resolveBoard(idOrKey));
}

export async function getBoardConfiguration(idOrKey: string) {
  const board = await resolveBoard(idOrKey);
  // Statuses mapped into columns vs. workflow statuses of the project.
  const mappedIds = new Set(board.columns.flatMap((c) => c.statuses.map((s) => s.statusId)));
  // 057 US4 — consult the resolved workflow: scheme → default → legacy
  // workflowId → 'Simple' (previously checked board.project.workflowId only).
  const { getProjectWorkflow } = await import('./workflowService.js');
  const wf = await getProjectWorkflow(board.projectId);
  const unmapped = wf.statuses.filter((ws) => !mappedIds.has(ws.statusId)).map((ws) => ws.status);

  return {
    id: board.id,
    name: board.name,
    type: board.type,
    filter: board.filter ? { id: board.id, jql: board.filter } : undefined,
    columnConfig: {
      columns: board.columns.map((c) => ({
        name: c.name,
        min: c.minIssues ?? undefined,
        max: c.maxIssues ?? undefined,
        statuses: c.statuses.map((s) => ({
          id: s.statusId,
          name: s.status.name,
          statusCategory: toStatusCategory(s.status.category),
        })),
      })),
      unmapped: unmapped.map((s) => ({
        id: s.id,
        name: s.name,
        statusCategory: toStatusCategory(s.category),
      })),
      constraintType: 'issueCount',
    },
  };
}

export interface ColumnInput {
  name: string;
  statusIds: string[];
  min?: number | null;
  max?: number | null;
}

export async function updateBoardConfiguration(idOrKey: string, columns: ColumnInput[], actor?: Actor) {
  const board = await resolveBoard(idOrKey);
  // H3/H2-a: board configuration is a project-admin operation (Jira: board admin).
  if (actor) await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.project.id });
  // 062 US2 — domain rules live in the service too: callers other than the
  // REST route (MCP, future importers) must hit the same validation.
  for (const [i, c] of columns.entries()) {
    if (!c.name.trim()) {
      throw new JiraApiError(400, jiraError([], { [`columns[${i}].name`]: 'Column name must not be empty.' }));
    }
    if (c.min != null && c.max != null && c.min > c.max) {
      throw new JiraApiError(
        400,
        jiraError([], { [`columns[${i}].max`]: 'Max must be greater than or equal to Min.' })
      );
    }
  }
  const statusIds = columns.flatMap((c) => c.statusIds);
  const dupes = statusIds.filter((s, i) => statusIds.indexOf(s) !== i);
  if (dupes.length) {
    throw new JiraApiError(400, jiraError([], { statuses: 'A status can only be mapped to one column.' }));
  }
  const found = await prisma.status.findMany({ where: { id: { in: statusIds } }, select: { id: true } });
  if (found.length !== statusIds.length) {
    throw new JiraApiError(400, jiraError([], { statuses: 'Unknown status id in column mapping.' }));
  }

  await prisma.$transaction(async (tx) => {
    await tx.boardColumnStatus.deleteMany({ where: { column: { boardId: board.id } } });
    await tx.boardColumn.deleteMany({ where: { boardId: board.id } });
    for (const [i, c] of columns.entries()) {
      await tx.boardColumn.create({
        data: {
          boardId: board.id,
          name: c.name,
          position: i,
          minIssues: c.min ?? null,
          maxIssues: c.max ?? null,
          statuses: { create: c.statusIds.map((sid) => ({ statusId: sid })) },
        },
      });
    }
    if (actor) {
      await emitEvent(tx, actor, {
        type: 'board_configuration_changed',
        projectId: board.projectId,
        payload: {
          projectKey: board.project.key,
          board: { id: board.id, name: board.name, columns: columns.map((c) => c.name) },
        },
      });
    }
  });
  return getBoardConfiguration(board.id);
}

export async function listBoardIssues(
  idOrKey: string,
  pagination: { startAt: number; maxResults: number } = { startAt: 0, maxResults: 200 },
  actor?: Actor,
  opts: { quickFilterIds?: string[] } = {}
) {
  const board = await resolveBoard(idOrKey);
  // 064 gate: single-project surface — check the project once, then the
  // security-only predicate covers gate 3 without enumerating all projects.
  if (actor && !(await canSeeProjectId(actor, board.projectId))) {
    throw new JiraApiError(404, jiraError(['Board does not exist or you do not have permission to see it.']));
  }

  // Scrum boards show the board's own active sprint (empty when none is
  // running); kanban boards list all issues regardless of sprint.
  const activeSprint = await prisma.sprint.findFirst({
    where: { boardId: board.id, state: 'active' },
  });
  const base =
    board.type === 'scrum'
      ? { projectId: board.projectId, sprintId: activeSprint?.id ?? '__none__' }
      : { projectId: board.projectId };
  // FR-001/FR-003: membership = project + board filter JQL + quick filters (+ sprint)
  const filterW = await boardFilterWhere(board, actor);
  const qfWheres = await quickFilterWhere(board.id, opts.quickFilterIds, actor);
  const where: Where = {
    AND: [base, ...(filterW ? [filterW] : []), ...qfWheres, ...(actor ? [await securityGateWhere(actor)] : [])],
  };

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
  const visibleRelIds = actor ? await visibleIssueIds(actor, relatedIssueIds(issues)) : undefined;
  return {
    startAt: pagination.startAt,
    maxResults: pagination.maxResults,
    total,
    activeSprint: activeSprint ?? undefined,
    issues: issues.map((i) => toIssueResponse(i, { cfFields: cfMap.get(i.id), visibleRelIds })),
  };
}

/** Jira parity: the scrum backlog and not-started sprints only show issues
 *  whose status is mapped to a column other than the board's rightmost one
 *  (its "done" column). Statuses unmapped entirely never appear either.
 *  `null` = no columns configured → no status scoping. */
export function backlogVisibleStatusIds(board: {
  columns: { statuses: { statusId: string }[] }[];
}): string[] | null {
  if (!board.columns.length) return null;
  return board.columns.slice(0, -1).flatMap((c) => c.statuses.map((s) => s.statusId));
}

/**
 * GET /board/{id}/backlog — issues with no current sprint (rank-ordered),
 * scrum boards only. Excludes issues parked in future sprints and, per Jira,
 * anything in a status mapped to the board's rightmost column.
 */
export async function listBacklog(
  idOrKey: string,
  pagination: { startAt: number; maxResults: number } = { startAt: 0, maxResults: 50 },
  actor?: Actor,
  opts: { quickFilterIds?: string[] } = {}
) {
  const board = await resolveBoard(idOrKey);
  if (board.type !== 'scrum') {
    throw new JiraApiError(400, jiraError(['Backlog is only available on scrum boards.']));
  }
  if (actor && !(await canSeeProjectId(actor, board.projectId))) {
    throw new JiraApiError(404, jiraError(['Board does not exist or you do not have permission to see it.']));
  }
  const base = { projectId: board.projectId, sprintId: null };
  const filterW = await boardFilterWhere(board, actor);
  const qfWheres = await quickFilterWhere(board.id, opts.quickFilterIds, actor);
  const visibleStatusIds = backlogVisibleStatusIds(board);
  const where: Where = {
    AND: [
      base,
      ...(visibleStatusIds ? [{ statusId: { in: visibleStatusIds } }] : []),
      ...(filterW ? [filterW] : []),
      ...qfWheres,
      ...(actor ? [await securityGateWhere(actor)] : []),
    ],
  };
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
  const visibleRelIds = actor ? await visibleIssueIds(actor, relatedIssueIds(issues)) : undefined;
  return {
    startAt: pagination.startAt,
    maxResults: pagination.maxResults,
    total,
    issues: issues.map((i) => toIssueResponse(i, { cfFields: cfMap.get(i.id), visibleRelIds })),
  };
}

/** TrackForge-native: flip board.type (kanban→scrum always; scrum→kanban needs no open sprints). */
export async function setBoardType(idOrKey: string, type: 'scrum' | 'kanban', actor?: Actor) {
  const board = await resolveBoard(idOrKey);
  if (actor) await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.project.id });
  if (!['scrum', 'kanban'].includes(type)) {
    throw new JiraApiError(400, jiraError([`Board type must be 'scrum' or 'kanban'.`]));
  }
  if (board.type === type) return toBoardResponse(board);
  if (type === 'kanban') {
    const open = await prisma.sprint.count({
      where: { boardId: board.id, state: { in: ['active', 'future'] } },
    });
    if (open) {
      throw new JiraApiError(400, jiraError(['Cannot switch to kanban while the board has future or active sprints.']));
    }
  }
  const updated = await prisma.board.update({ where: { id: board.id }, data: { type } });
  if (actor) {
    await emitEvent(prisma, actor, {
      type: 'board_configuration_changed',
      projectId: board.projectId,
      payload: { projectKey: board.project.key, board: { id: board.id, name: board.name, type } },
    });
  }
  return toBoardResponse({ ...updated, project: board.project });
}

/** dryRun twin of rankIssues — same guards, zero writes (052). */
export async function previewRankIssues(
  input: { issues: string[]; rankBeforeIssue?: string; rankAfterIssue?: string },
  actor: Actor
) {
  const keys = input.issues.map((k) => k.toUpperCase());
  if (!keys.length || (!input.rankBeforeIssue && !input.rankAfterIssue)) {
    throw new JiraApiError(400, jiraError(['Provide issues and rankBeforeIssue or rankAfterIssue.']));
  }
  if (input.rankBeforeIssue && input.rankAfterIssue) {
    throw new JiraApiError(400, jiraError(['Provide only one of rankBeforeIssue or rankAfterIssue.']));
  }
  const moved: { id: string; projectId: string }[] = [];
  for (const key of keys) {
    const { projectKey, issueNumber } = await parseIssueKey(key);
    const issue = await prisma.issue.findFirst({
      where: { issueNumber, project: { key: projectKey } },
      select: { id: true, projectId: true },
    });
    if (!issue) throw new JiraApiError(404, jiraError([`Issue ${key} does not exist.`]));
    moved.push(issue);
  }
  for (const projectId of new Set(moved.map((m) => m.projectId))) {
    await requirePermission(actor, 'SCHEDULE_ISSUES', { projectId });
  }
  // rankIssues only sees refs in the first moved issue's project, excluding
  // the moved issues — mirror that so a preview can't pass what a write rejects.
  const refKey = (input.rankBeforeIssue ?? input.rankAfterIssue)!.toUpperCase();
  const { projectKey: refPk, issueNumber: refNum } = await parseIssueKey(refKey);
  const ref = await prisma.issue.findFirst({
    where: { issueNumber: refNum, project: { key: refPk } },
    select: { id: true, projectId: true },
  });
  if (!ref || ref.projectId !== moved[0]!.projectId || moved.some((m) => m.id === ref.id)) {
    throw new JiraApiError(400, jiraError([`Cannot find issue ${refKey} to rank against.`]));
  }
  return {
    dryRun: true,
    rank: {
      issues: keys,
      rankBeforeIssue: input.rankBeforeIssue ?? null,
      rankAfterIssue: input.rankAfterIssue ?? null,
      text: `${keys.join(', ')} ${input.rankBeforeIssue ? 'before' : 'after'} ${refKey}`,
    },
  };
}

/**
 * PUT /issue/rank — move `issues` before/after a reference issue within the
 * shared rank space. Rebalances when the gap is saturated.
 */
export async function rankIssues(
  input: { issues: string[]; rankBeforeIssue?: string; rankAfterIssue?: string },
  actor: Actor
) {
  const keys = input.issues.map((k) => k.toUpperCase());
  if (!keys.length || (!input.rankBeforeIssue && !input.rankAfterIssue)) {
    throw new JiraApiError(400, jiraError(['Provide issues and rankBeforeIssue or rankAfterIssue.']));
  }
  if (input.rankBeforeIssue && input.rankAfterIssue) {
    throw new JiraApiError(400, jiraError(['Provide only one of rankBeforeIssue or rankAfterIssue.']));
  }

  const issues: { id: string; projectId: string; issueNumber: number; project: { key: string } }[] = [];
  for (const key of keys) {
    const { projectKey, issueNumber } = await parseIssueKey(key);
    const issue = await prisma.issue.findFirst({
      where: { issueNumber, project: { key: projectKey } },
      include: { project: true },
    });
    if (!issue) throw new JiraApiError(404, jiraError([`Issue ${key} does not exist.`]));
    issues.push(issue);
  }

  // H3/H2-a: reordering the backlog edits schedule data on each issue's project.
  for (const projectId of new Set(issues.map((i) => i.projectId))) {
    await requirePermission(actor, 'SCHEDULE_ISSUES', { projectId });
  }

  // Remaining issues in rank order (moved issues excluded).
  const projectId = issues[0]!.projectId;
  const ordered = await prisma.issue.findMany({
    where: { projectId, id: { notIn: issues.map((i) => i.id) } },
    orderBy: [{ rank: 'asc' }, { issueNumber: 'asc' }],
    select: { id: true, issueNumber: true, rank: true },
  });
  const keyOf = (issueNumber: number) => toIssueKey(issues[0]!.project.key, issueNumber);
  const refKey = (input.rankBeforeIssue ?? input.rankAfterIssue)!.toUpperCase();
  const refIdx = ordered.findIndex((o) => keyOf(o.issueNumber) === refKey);
  if (refIdx < 0) {
    throw new JiraApiError(400, jiraError([`Cannot find issue ${refKey} to rank against.`]));
  }

  const movedKeys = issues.map((i) => keyOf(i.issueNumber));
  const insertAt = input.rankBeforeIssue ? refIdx : refIdx + 1;

  // Fast path: take midpoints in the gap.
  const before = insertAt > 0 ? ordered[insertAt - 1]!.rank || null : null;
  const after = insertAt < ordered.length ? ordered[insertAt]!.rank || null : null;
  let cursor = before;
  const newRanks: string[] = [];
  let saturated = false;
  for (let i = 0; i < issues.length; i++) {
    const r = rankBetween(cursor, after);
    if (r === null) {
      saturated = true;
      break;
    }
    newRanks.push(r);
    cursor = r;
  }

  const emitRank = async (
    tx: Prisma.TransactionClient,
    issue: { id: string; issueNumber: number },
    newRank: string
  ) => {
    const items = [{ field: 'Rank', fromString: null, toString: newRank }];
    await recordChange(tx, issue.id, actor, items);
    await emitEvent(tx, actor, {
      type: 'jira:issue_updated',
      projectId,
      issueId: issue.id,
      payload: { issueKey: keyOf(issue.issueNumber), projectKey: issues[0]!.project.key, changelog: { items } },
    });
  };

  if (!saturated) {
    await prisma.$transaction(async (tx) => {
      for (const [i, issue] of issues.entries()) {
        await tx.issue.update({ where: { id: issue.id }, data: { rank: newRanks[i]! } });
        await emitRank(tx, issue, newRanks[i]!);
      }
    });
    return { movedIssues: movedKeys };
  }

  // Gap saturated: re-space the whole ordering (positions unchanged).
  const finalIds = [
    ...ordered.slice(0, insertAt).map((o) => o.id),
    ...issues.map((i) => i.id),
    ...ordered.slice(insertAt).map((o) => o.id),
  ];
  const ranks = spreadRanks(finalIds.length);
  await prisma.$transaction(async (tx) => {
    for (const [i, id] of finalIds.entries()) {
      await tx.issue.update({ where: { id }, data: { rank: ranks[i]! } });
    }
    for (const issue of issues) {
      await emitRank(tx, issue, ranks[finalIds.indexOf(issue.id)]!);
    }
  });
  return { movedIssues: movedKeys, rebalanced: true };
}

// ---------- 033 US1: multi-board CRUD ----------

/** Default column seed — one column per workflow status (mirrors ensureProjectBoard). */
async function seedBoardColumns(tx: Prisma.TransactionClient, boardId: string, projectId: string) {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { workflowId: true } });
  const wfStatuses = project?.workflowId
    ? await tx.workflowStatus.findMany({
        where: { workflowId: project.workflowId },
        orderBy: { position: 'asc' },
      })
    : [];
  const statuses = wfStatuses.length ? wfStatuses : await tx.status.findMany({ orderBy: { sequence: 'asc' } });
  for (const [i, s] of statuses.entries()) {
    const statusId = 'statusId' in s ? s.statusId : s.id;
    const name =
      'statusId' in s
        ? ((await tx.status.findUnique({ where: { id: s.statusId }, select: { name: true } }))?.name ?? `Column ${i}`)
        : s.name;
    await tx.boardColumn.create({
      data: {
        boardId,
        name,
        position: i,
        statuses: { create: [{ statusId }] },
      },
    });
  }
}

/** Jira POST /rest/agile/1.0/board {name, type, filterId, location}. */
export async function createBoard(
  actor: Actor,
  input: { name: string; type?: string; filterId?: string; location?: { type?: string; projectKeyOrId?: string } }
) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new JiraApiError(400, jiraError([], { name: 'Board name is required.' }));
  const type = input.type === 'scrum' ? 'scrum' : 'kanban';
  const ref = input.location?.projectKeyOrId;
  if (!ref) throw new JiraApiError(400, jiraError([], { location: 'location.projectKeyOrId is required.' }));
  const project = await prisma.project.findFirst({
    where: { OR: [{ id: ref }, { key: ref.toUpperCase() }] },
    select: { id: true, key: true, name: true },
  });
  if (!project) throw new JiraApiError(404, jiraError([`No project could be found for '${ref}'.`]));
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: project.id });
  let filterId: string | null = null;
  if (input.filterId) {
    const f = await prisma.filter.findUnique({ where: { id: input.filterId }, include: { sharePerms: true } });
    if (!f) throw new JiraApiError(400, jiraError([], { filterId: `Filter '${input.filterId}' does not exist.` }));
    const { canSeeFilter } = await import('./filterScope.js');
    if (!(await canSeeFilter(f, actor))) {
      throw new JiraApiError(400, jiraError([], { filterId: `Filter '${input.filterId}' does not exist.` }));
    }
    filterId = f.id;
  }
  const isFirst = !(await prisma.board.findFirst({ where: { projectId: project.id }, select: { id: true } }));
  const board = await prisma.$transaction(async (tx) => {
    const b = await tx.board.create({
      data: { name, type, projectId: project.id, isDefault: isFirst, filterId, createdBy: actor.user.id },
    });
    await seedBoardColumns(tx, b.id, project.id);
    return b;
  });
  await emitEvent(prisma, actor, {
    type: 'board_configuration_changed',
    projectId: project.id,
    payload: { projectKey: project.key, board: { id: board.id, name: board.name, created: true } },
  });
  return toBoardResponse({ ...board, project });
}

/** TF-native PUT — rename + filter binding (Jira has no board PUT). */
export async function updateBoard(
  actor: Actor,
  idOrKey: string,
  input: { name?: string; filterId?: string | null; filter?: string | null }
) {
  const board = await resolveBoard(idOrKey);
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.projectId });
  let filterId = board.filterId;
  if (input.filterId !== undefined) {
    if (input.filterId === null) {
      filterId = null;
    } else {
      const f = await prisma.filter.findUnique({ where: { id: input.filterId }, include: { sharePerms: true } });
      if (!f) throw new JiraApiError(400, jiraError([], { filterId: `Filter '${input.filterId}' does not exist.` }));
      const { canSeeFilter } = await import('./filterScope.js');
      if (!(await canSeeFilter(f, actor))) {
        throw new JiraApiError(400, jiraError([], { filterId: `Filter '${input.filterId}' does not exist.` }));
      }
      filterId = f.id;
    }
  }
  const updated = await prisma.board.update({
    where: { id: board.id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.filterId !== undefined ? { filterId } : {}),
      ...(input.filter !== undefined ? { filter: input.filter } : {}),
    },
    include: boardInclude,
  });
  return toBoardResponse(updated);
}

/** DELETE /rest/agile/1.0/board/{id}. The default board can only be deleted
 *  when it's the project's last board, or when promoteTo names a successor. */
export async function deleteBoard(actor: Actor, idOrKey: string, promoteTo?: string) {
  const board = await resolveBoard(idOrKey);
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.projectId });
  const siblings = await prisma.board.findMany({
    where: { projectId: board.projectId, id: { not: board.id } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (board.isDefault && siblings.length) {
    if (!promoteTo || !siblings.some((s) => s.id === promoteTo)) {
      throw new JiraApiError(
        400,
        jiraError(['Cannot delete the default board — pass promoteTo=<boardId> naming the new default.'])
      );
    }
    // one-default-per-project index: clear first, then promote — atomically.
    await prisma.$transaction([
      prisma.board.updateMany({ where: { projectId: board.projectId }, data: { isDefault: false } }),
      prisma.board.update({ where: { id: promoteTo }, data: { isDefault: true } }),
      prisma.board.delete({ where: { id: board.id } }),
    ]);
  } else {
    if (board.isDefault && !siblings.length) {
      throw new JiraApiError(400, jiraError(["Cannot delete the project's only board."]));
    }
    await prisma.board.delete({ where: { id: board.id } });
  }
  await emitEvent(prisma, actor, {
    type: 'board_configuration_changed',
    projectId: board.projectId,
    payload: { projectKey: board.project.key, board: { id: board.id, name: board.name, deleted: true } },
  });
}

/** TF-native — marks one board the project default, clears the rest. */
export async function setDefaultBoard(actor: Actor, idOrKey: string) {
  const board = await resolveBoard(idOrKey);
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.projectId });
  await prisma.$transaction([
    prisma.board.updateMany({ where: { projectId: board.projectId }, data: { isDefault: false } }),
    prisma.board.update({ where: { id: board.id }, data: { isDefault: true } }),
  ]);
  return toBoardResponse({ ...board, isDefault: true });
}

// ---------- 033 US2: quick filters ----------

const qfJson = (q: { id: string; boardId: string; name: string; jql: string; position: number }) => ({
  id: q.id,
  boardId: q.boardId,
  name: q.name,
  jql: q.jql,
  position: q.position,
});

export async function listQuickFilters(idOrKey: string) {
  const board = await resolveBoard(idOrKey);
  const rows = await prisma.boardQuickFilter.findMany({
    where: { boardId: board.id },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  });
  return rows.map(qfJson);
}

export async function getQuickFilter(idOrKey: string, qfId: string) {
  const board = await resolveBoard(idOrKey);
  const q = await prisma.boardQuickFilter.findFirst({ where: { id: qfId, boardId: board.id } });
  if (!q) throw new JiraApiError(404, jiraError([`Quick filter '${qfId}' does not exist.`]));
  return qfJson(q);
}

/** Server-side JQL validation on save (A8 — no silent broken chips). */
async function assertJqlParses(jql: string, actor: Actor) {
  const { parseJql } = await import('../jql/parser.js');
  const { assertJqlFieldRefs } = await import('../jql/compiler.js');
  try {
    const parsed = parseJql(jql);
    await assertJqlFieldRefs(actor, parsed);
  } catch (e) {
    throw new JiraApiError(400, jiraError([`Invalid quick-filter JQL: ${(e as Error).message}`]));
  }
}

export async function createQuickFilter(
  actor: Actor,
  idOrKey: string,
  input: { name: string; jql: string; position?: number }
) {
  const board = await resolveBoard(idOrKey);
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.projectId });
  const name = String(input.name ?? '').trim();
  const jql = String(input.jql ?? '').trim();
  if (!name || !jql) throw new JiraApiError(400, jiraError([], { name: 'name and jql are required.' }));
  await assertJqlParses(jql, actor);
  const q = await prisma.boardQuickFilter.create({
    data: { boardId: board.id, name, jql, position: input.position ?? 0 },
  });
  return qfJson(q);
}

export async function updateQuickFilter(
  actor: Actor,
  idOrKey: string,
  qfId: string,
  input: { name?: string; jql?: string; position?: number }
) {
  const board = await resolveBoard(idOrKey);
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.projectId });
  const q = await prisma.boardQuickFilter.findFirst({ where: { id: qfId, boardId: board.id } });
  if (!q) throw new JiraApiError(404, jiraError([`Quick filter '${qfId}' does not exist.`]));
  if (input.jql !== undefined) await assertJqlParses(input.jql, actor);
  const updated = await prisma.boardQuickFilter.update({
    where: { id: q.id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.jql !== undefined ? { jql: input.jql.trim() } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
    },
  });
  return qfJson(updated);
}

export async function deleteQuickFilter(actor: Actor, idOrKey: string, qfId: string) {
  const board = await resolveBoard(idOrKey);
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.projectId });
  const q = await prisma.boardQuickFilter.findFirst({ where: { id: qfId, boardId: board.id } });
  if (!q) throw new JiraApiError(404, jiraError([`Quick filter '${qfId}' does not exist.`]));
  await prisma.boardQuickFilter.delete({ where: { id: q.id } });
}

// ---------- 033 US3: card config ----------

export async function getCardConfig(idOrKey: string) {
  const board = await resolveBoard(idOrKey);
  return (board.cardConfig as Record<string, unknown> | null) ?? {};
}

export async function setCardConfig(actor: Actor, idOrKey: string, config: Record<string, unknown>) {
  const board = await resolveBoard(idOrKey);
  await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: board.projectId });
  await prisma.board.update({ where: { id: board.id }, data: { cardConfig: config as Prisma.InputJsonValue } });
  await emitEvent(prisma, actor, {
    type: 'board_configuration_changed',
    projectId: board.projectId,
    payload: { projectKey: board.project.key, board: { id: board.id, name: board.name, cardConfig: config } },
  });
  return config;
}

// ---------- 033 US4: issue picker ----------

/** Jira /issue/picker — key or summary search, visible-scope, small page. */
export async function pickIssues(actor: Actor, query: string, max = 10) {
  const q = query.trim();
  // Multi-project surface — the full 3-gate predicate (browse + allow-list +
  // security), not just the security gate.
  const wheres: Where[] = [await visibleIssueWhere(actor)];
  if (q) {
    const km = /^([A-Za-z]+)-(\d+)$/.exec(q);
    const pm = /^([A-Za-z]+)-?(\d*)$/.exec(q);
    wheres.push({
      OR: [
        { summary: { contains: q, mode: 'insensitive' } },
        ...(km ? [{ AND: [{ project: { key: km[1].toUpperCase() } }, { issueNumber: Number(km[2]) }] }] : []),
        ...(pm && !km ? [{ project: { key: { startsWith: pm[1].toUpperCase() } } }] : []),
      ],
    });
  }
  const issues = await prisma.issue.findMany({
    where: { AND: wheres },
    take: Math.min(50, max),
    orderBy: [{ updatedAt: 'desc' }],
    include: {
      project: { select: { key: true } },
      issueType: { select: { name: true } },
      status: { select: { name: true, category: true } },
    },
  });
  return {
    sections: [
      {
        label: 'Issues',
        issues: issues.map((i) => ({
          id: i.id,
          key: `${i.project.key}-${i.issueNumber}`,
          keyHtml: `${i.project.key}-${i.issueNumber}`,
          summary: i.summary,
          issueType: i.issueType.name,
          status: i.status.name,
          statusCategory: toStatusCategory(i.status.category).key,
        })),
      },
    ],
  };
}

/**
 * Sprint 041: /api/internal/roadmap/{boardId} — the planning-view feed.
 * Same visibility/filter composition as listBoardIssues (project + board
 * filter JQL + per-actor visibility) but WITHOUT the active-sprint clause —
 * the roadmap spans future work.
 *
 * level=epics (default): epic bars + rollup progress + Blocks links + version pins.
 * level=issues        : every issue row for the Gantt (parent links included).
 */
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { resolveBoard, boardFilterWhere } from './boardService.js';
import { securityGateWhere } from './issueSecurityService.js';
import { canSeeProjectId } from './visibilityService.js';
import { cfFieldsForIssues } from './customFieldService.js';
import { jiraDate } from '../lib/http.js';

interface RoadmapLink {
  id: string;
  typeId: string;
  type: string;
  direction: 'outward' | 'inward';
  key: string;
}
interface RoadmapRow {
  key: string;
  summary: string;
  type: string;
  isSubtask: boolean;
  status: { name: string; category: string };
  assignee: string | null;
  parent: string | null;
  start: string | null;
  due: string | null;
  progress: { done: number; total: number; pct: number };
  links: RoadmapLink[];
}

const dateOnly = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : jiraDate(d);
};

export async function getRoadmap(
  idOrKey: string,
  actor: Actor,
  opts: { level?: string; status?: string; assignee?: string; label?: string; component?: string } = {}
) {
  const board = await resolveBoard(idOrKey);
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: board.projectId },
    include: { versions: { orderBy: { releaseDate: 'asc' } } },
  });
  // 064 gate: single-project surface — check once, then the security-only
  // predicate covers gate 3 without the all-projects enumeration.
  if (!(await canSeeProjectId(actor, project.id))) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }

  const filterW = await boardFilterWhere(board, actor);
  const issues = await prisma.issue.findMany({
    where: { AND: [{ projectId: project.id }, ...(filterW ? [filterW] : []), await securityGateWhere(actor)] },
    orderBy: [{ issueNumber: 'asc' }],
    include: {
      issueType: true,
      status: true,
      assignee: true,
      reporter: true,
      parent: true,
      children: { include: { issueType: true, status: true } },
      outLinks: { include: { type: true, inwardIssue: { select: { issueNumber: true } } } },
      inLinks: { include: { type: true, outwardIssue: { select: { issueNumber: true } } } },
      cfValues: true,
    },
  });
  const cfMap = await cfFieldsForIssues(issues);
  const keyOf = (i: { issueNumber: number }) => `${project.key}-${i.issueNumber}`;

  // optional post-filters (narrow to matching rows; parents stay so the tree holds)
  const keep = (i: (typeof issues)[number]) =>
    (!opts.status || i.status.name.toLowerCase() === opts.status.toLowerCase()) &&
    (!opts.assignee || i.assignee?.email === opts.assignee || i.assignee?.displayName === opts.assignee) &&
    (!opts.label || i.labels.includes(opts.label)) &&
    (!opts.component || false); // component join filtered below via set

  let compIds: Set<string> | null = null;
  if (opts.component) {
    compIds = new Set(
      (
        await prisma.issueComponent.findMany({
          where: { component: { projectId: project.id, name: { equals: opts.component, mode: 'insensitive' } } },
          select: { issueId: true },
        })
      ).map((r) => r.issueId)
    );
  }
  const kept = new Set(issues.filter((i) => keep(i) && (!compIds || compIds.has(i.id))).map((i) => i.id));

  const rows: RoadmapRow[] = issues
    .filter((i) => kept.has(i.id))
    .map((i) => {
      const cf = cfMap.get(i.id) ?? {};
      const kids = i.children.filter((c) => !c.issueType.isSubtask);
      const doneKids = kids.filter((c) => c.status.category === 'done').length;
      const links: RoadmapLink[] = [
        ...i.outLinks.map((l) => ({
          id: l.id,
          typeId: l.typeId,
          type: l.type.outward ?? l.type.name,
          direction: 'outward' as const,
          key: l.inwardIssue ? `${project.key}-${l.inwardIssue.issueNumber}` : '?',
        })),
        ...i.inLinks.map((l) => ({
          id: l.id,
          typeId: l.typeId,
          type: l.type.inward ?? l.type.name,
          direction: 'inward' as const,
          key: l.outwardIssue ? `${project.key}-${l.outwardIssue.issueNumber}` : '?',
        })),
      ];
      const ownDone = i.status.category === 'done' ? 1 : 0;
      return {
        key: keyOf(i),
        summary: i.summary,
        type: i.issueType.name,
        isSubtask: i.issueType.isSubtask,
        status: { name: i.status.name, category: i.status.category },
        assignee: i.assignee?.displayName ?? null,
        parent: i.parent ? keyOf(i.parent) : null,
        start: dateOnly(cf.startdate),
        due: dateOnly(i.dueDate),
        progress: kids.length
          ? { done: doneKids, total: kids.length, pct: Math.round((doneKids / kids.length) * 100) }
          : { done: ownDone, total: 1, pct: i.status.category === 'done' ? 100 : 0 },
        links,
      };
    });

  const isEpicLevel = (opts.level ?? 'epics') !== 'issues';
  const epicRows = rows.filter((r) => {
    const src = issues.find((i) => keyOf(i) === r.key)!;
    return src.issueType.hierarchyLevel === 1;
  });
  const payloadRows = isEpicLevel ? epicRows : rows;

  // links scoped to rows on display (epic-only links at epic level)
  const keysOnScreen = new Set(payloadRows.map((r) => r.key));
  for (const r of payloadRows) r.links = r.links.filter((l) => keysOnScreen.has(l.key));

  const dates = payloadRows.flatMap((r) => [r.start, r.due]).filter(Boolean) as string[];
  const range = {
    start: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : jiraDate(new Date()),
    end: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : jiraDate(new Date(Date.now() + 90 * 86400_000)),
  };

  return {
    board: { id: board.id, name: board.name, type: board.type, projectKey: project.key },
    range,
    [isEpicLevel ? 'epics' : 'issues']: payloadRows,
    versions: project.versions
      .filter((v) => v.releaseDate || v.released)
      .map((v) => ({
        name: v.name,
        releaseDate: v.releaseDate ? jiraDate(v.releaseDate) : null,
        released: v.released,
        startDate: v.startDate ? jiraDate(v.startDate) : null,
      })),
  };
}

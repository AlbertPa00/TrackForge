// Search service — runs a compiled JQL query and hydrates Jira-shaped issues.

import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { parseJql } from '../jql/parser.js';
import { compileJql, type SortSpecItem } from '../jql/compiler.js';
import { toIssueResponse, expandIssueResponse, parseSelection, issueIncludeForFields, relatedIssueIds } from './issueService.js';
import { JiraApiError } from '../lib/errors.js';
import { jiraError } from '../lib/errors.js';
import { visibleIssueWhere, visibleIssueIds } from './visibilityService.js';
import { cfFieldsForIssues } from './customFieldService.js';
import { getChangelogs } from './changelogService.js';
import { JqlParseError } from '../jql/parser.js';
import { JqlFieldError } from '../jql/compiler.js';

export interface SearchParams {
  jql: string;
  startAt: number;
  maxResults: number;
  fields?: string[];
  expand?: string[];
}

type SortCandidate = {
  id: string;
  issueNumber: number;
  summary: string;
  rank: string;
  storyPoints: number | null;
  dueDate: Date | null;
  resolutionDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  project: { key: string };
  issueType: { name: string };
  status: { sequence: number };
  priority: { sequence: number };
  resolution: { sequence: number } | null;
  assignee: { displayName: string } | null;
  sprint: { name: string } | null;
  cfValues: { fieldId: string; value: unknown }[];
};

/** Candidate hydration for the memory-sort path is built from the sort spec:
 *  only the columns/relations the ordering actually reads are selected, and
 *  `cfValues` is filtered to the sorted field ids — sorting by one CF no
 *  longer drags every custom-field row of every candidate into memory.
 *  `id`/`issueNumber` are unconditional (page-id + tiebreak). */
function candidateSelectFor(spec: SortSpecItem[]) {
  const select: Record<string, unknown> = { id: true, issueNumber: true };
  const cfFieldIds: string[] = [];
  for (const item of spec) {
    if (item.kind === 'cf') {
      cfFieldIds.push(item.field.id);
      continue;
    }
    switch (item.col) {
      case 'issueNumber':
        break;
      case 'projectKey':
        select.project = { select: { key: true } };
        break;
      case 'createdAt':
      case 'updatedAt':
      case 'storyPoints':
      case 'summary':
      case 'dueDate':
      case 'resolutionDate':
      case 'rank':
      case 'remainingEstimateSec':
      case 'originalEstimateSec':
        select[item.col] = true;
        break;
      case 'prioritySeq':
        select.priority = { select: { sequence: true } };
        break;
      case 'statusSeq':
        select.status = { select: { sequence: true } };
        break;
      case 'resolutionSeq':
        select.resolution = { select: { sequence: true } };
        break;
      case 'issueTypeName':
        select.issueType = { select: { name: true } };
        break;
      case 'assigneeName':
        select.assignee = { select: { displayName: true } };
        break;
      case 'sprintName':
        select.sprint = { select: { name: true } };
        break;
    }
  }
  if (cfFieldIds.length) {
    select.cfValues = {
      select: { fieldId: true, value: true },
      where: { fieldId: { in: cfFieldIds } },
    };
  }
  return select;
}

/** Extract a comparable key from a stored CF value per field type. */
function cfSortKey(field: { type: string; searcherType: string }, stored: unknown): string | number | null {
  if (stored === null || stored === undefined) return null;
  switch (field.searcherType) {
    case 'number':
      return typeof stored === 'number' ? stored : Number(stored);
    case 'date':
    case 'text':
      return String(stored).toLowerCase();
    case 'user':
      return String((stored as { displayName?: string }).displayName ?? '').toLowerCase();
    case 'exact': {
      const v = (stored as { value?: string }).value;
      return v === undefined ? null : v.toLowerCase();
    }
    default:
      return null;
  }
}

function colSortValue(c: SortCandidate, col: string): string | number | null {
  switch (col) {
    case 'issueNumber':
      return c.issueNumber;
    case 'projectKey':
      return c.project.key;
    case 'createdAt':
      return c.createdAt.getTime();
    case 'updatedAt':
      return c.updatedAt.getTime();
    case 'storyPoints':
      return c.storyPoints;
    case 'summary':
      return c.summary.toLowerCase();
    case 'dueDate':
      return c.dueDate?.getTime() ?? null;
    case 'resolutionDate':
      return c.resolutionDate?.getTime() ?? null;
    case 'rank':
      return c.rank;
    case 'prioritySeq':
      return c.priority.sequence;
    case 'statusSeq':
      return c.status.sequence;
    case 'resolutionSeq':
      return c.resolution?.sequence ?? null;
    case 'issueTypeName':
      return c.issueType.name.toLowerCase();
    case 'assigneeName':
      return c.assignee?.displayName.toLowerCase() ?? null;
    case 'sprintName':
      return c.sprint?.name.toLowerCase() ?? null;
    default:
      return null;
  }
}

/** EMPTY sorts last in both directions; ties → issueNumber asc. */
function compareNullable(a: string | number | null, b: string | number | null, dir: 'asc' | 'desc') {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp = a < b ? -1 : a > b ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

function sortCandidates(candidates: SortCandidate[], spec: SortSpecItem[]) {
  const decorated = candidates.map((c) => {
    const keys = spec.map((item) => {
      if (item.kind === 'cf') {
        const stored = c.cfValues.find((v) => v.fieldId === item.field.id)?.value;
        return cfSortKey(item.field, stored ?? null);
      }
      return colSortValue(c, item.col);
    });
    return { c, keys };
  });
  decorated.sort((x, y) => {
    for (const [i, item] of spec.entries()) {
      const cmp = compareNullable(x.keys[i], y.keys[i], item.dir);
      if (cmp !== 0) return cmp;
    }
    return x.c.issueNumber - y.c.issueNumber;
  });
  return decorated.map((d) => d.c);
}

export async function executeSearch(actor: Actor, params: SearchParams) {
  const query = parseJql(params.jql);
  const { where, orderBy, sortSpec } = await compileJql(query, actor);

  // 065 US1 — all three visibility gates at the query layer: token allow-list
  // + BROWSE_PROJECTS (015) + issue-security level (031) via the shared
  // predicate, so totals stay correct and scoped tokens can't over-read.
  const scopedWhere = {
    AND: [where, await visibleIssueWhere(actor)],
  };

  // `?fields=` drives hydration depth — unlisted relations are never fetched.
  const { include, needsCf } = issueIncludeForFields(params.fields);
  const [total, issues] = await Promise.all([
    prisma.issue.count({ where: scopedWhere as never }),
    (async () => {
      if (sortSpec?.length) {
        // CF ordering — memory-sort the whole match set, then hydrate the page.
        const candidates = (await prisma.issue.findMany({
          where: scopedWhere as never,
          select: candidateSelectFor(sortSpec) as never,
        })) as unknown as SortCandidate[];
        const pageIds = sortCandidates(candidates, sortSpec)
          .slice(params.startAt, params.startAt + params.maxResults)
          .map((c) => c.id);
        const pageIssues = await prisma.issue.findMany({
          where: { id: { in: pageIds } },
          include,
        });
        const byId = new Map(pageIssues.map((i) => [i.id, i]));
        return pageIds.map((id) => byId.get(id)!).filter(Boolean);
      }
      return prisma.issue.findMany({
        where: scopedWhere as never,
        orderBy: orderBy as never,
        skip: params.startAt,
        take: params.maxResults,
        include,
      });
    })(),
  ]);

  const cfMap = needsCf ? await cfFieldsForIssues(issues) : new Map<string, Record<string, unknown>>();
  // Embedded relations (subtasks/parent/issuelinks) are hydrated unfiltered —
  // one batched gate check decides which of them this actor may see.
  const visibleRelIds = await visibleIssueIds(actor, relatedIssueIds(issues));
  const responses = issues.map(
    (issue) =>
      toIssueResponse(issue, {
        fields: params.fields,
        cfFields: cfMap.get(issue.id),
        actorId: actor.user.id,
        visibleRelIds,
      }) as Record<string, unknown>
  );
  // Expansions that query per issue are hoisted to one batched fetch —
  // changelog was 2 queries × N issues; listFields likewise ran per issue
  // for names/schema on any page containing a customfield_ key.
  if (params.expand?.length) {
    const changelogMap = params.expand.includes('changelog')
      ? await getChangelogs(issues.map((i) => i.id))
      : undefined;
    let cfDefs: import('./customFieldService.js').FieldWithContexts[] | undefined;
    if (
      (params.expand.includes('names') || params.expand.includes('schema')) &&
      responses.some((r) => Object.keys((r.fields ?? {}) as Record<string, unknown>).some((k) => k.startsWith('customfield_')))
    ) {
      const { listFields } = await import('./customFieldService.js');
      cfDefs = await listFields();
    }
    await Promise.all(
      responses.map((r, i) =>
        expandIssueResponse(r, issues[i], params.expand, {
          changelog: changelogMap?.get(issues[i].id),
          cfDefs,
        })
      )
    );
  }

  return {
    expand: 'schema,names',
    startAt: params.startAt,
    maxResults: params.maxResults,
    total,
    issues: responses,
  };
}

/**
 * Issue keys matching JQL, visibility-scoped and capped — for callers that
 * need the selection, not hydrated issues (automation dry-run, bulk preview).
 */
export async function issueKeysForJql(actor: Actor, jql: string, cap = 50): Promise<string[]> {
  const { where, orderBy } = await compileJql(parseJql(jql), actor);
  const issues = await prisma.issue.findMany({
    where: { AND: [where as object, await visibleIssueWhere(actor)] } as never,
    take: cap,
    ...(orderBy ? { orderBy: orderBy as never } : {}),
    select: { project: { select: { key: true } }, issueNumber: true },
  });
  return issues.map((i) => `${i.project.key}-${i.issueNumber}`);
}

/** Translate JQL errors into JiraApiError(400) for route handlers. */
export function jqlToHttpError(err: unknown): JiraApiError | null {
  if (err instanceof JqlParseError) {
    return new JiraApiError(400, jiraError([err.message]));
  }
  if (err instanceof JqlFieldError) {
    return new JiraApiError(400, jiraError([err.message]));
  }
  return null;
}

export { parseSelection };

// ---------- Sprint 068: JQL aggregation (count / group-by) ----------

export const AGGREGATE_GROUP_FIELDS = [
  'status',
  'assignee',
  'priority',
  'issuetype',
  'project',
  'reporter',
  'sprint',
] as const;
export type AggregateGroupBy = (typeof AGGREGATE_GROUP_FIELDS)[number];

/** Count + optional group-by buckets for a JQL query — visibility-scoped,
 *  same predicate as executeSearch. Powers the copilot's aggregate_issues
 *  tool so "how many X per Y" answers come from real counts, not row scans. */
export async function aggregateIssues(
  actor: Actor,
  jql: string,
  groupBy?: string
): Promise<{ total: number; groupBy: string | null; truncated: boolean; buckets: { value: string; count: number }[] }> {
  const { where } = await compileJql(parseJql(jql), actor);
  const scoped = { AND: [where as object, await visibleIssueWhere(actor)] } as never;
  const total = await prisma.issue.count({ where: scoped });
  if (!groupBy) return { total, groupBy: null, truncated: false, buckets: [] };
  if (!(AGGREGATE_GROUP_FIELDS as readonly string[]).includes(groupBy)) {
    throw new JiraApiError(
      400,
      jiraError([`Unsupported groupBy '${groupBy}' — allowed: ${AGGREGATE_GROUP_FIELDS.join(', ')}.`])
    );
  }
  const rows = await prisma.issue.findMany({
    where: scoped,
    take: 5000,
    select: {
      status: { select: { name: true } },
      assignee: { select: { displayName: true } },
      priority: { select: { name: true } },
      issueType: { select: { name: true } },
      project: { select: { key: true } },
      reporter: { select: { displayName: true } },
      sprint: { select: { name: true } },
    },
  });
  const label = (i: (typeof rows)[number]): string => {
    switch (groupBy) {
      case 'status':
        return i.status.name;
      case 'assignee':
        return i.assignee?.displayName ?? 'Unassigned';
      case 'priority':
        return i.priority.name;
      case 'issuetype':
        return i.issueType.name;
      case 'project':
        return i.project.key;
      case 'reporter':
        return i.reporter?.displayName ?? '—';
      case 'sprint':
        return i.sprint?.name ?? 'No sprint';
      default:
        return '—';
    }
  };
  const counts = new Map<string, number>();
  for (const i of rows) {
    const l = label(i);
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const buckets = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, 50);
  return { total, groupBy, truncated: rows.length < total, buckets };
}

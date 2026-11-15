/**
 * Sprint 039 US-CSV: Jira CSV backup → fixture map for the 017 pipeline.
 *
 * Parses Jira's CSV export shape (repeated headers for multi-value columns,
 * `;`-delimited comment cells, date + duration formats) into the same
 * path→response map createFixtureSource serves, so every existing
 * EntityImporter works unchanged.
 */

import { parseIssueKeyParts } from '../lib/issueKey.js';

/** Minimal RFC-4180 parser — quoted cells, embedded commas/newlines/quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function iso(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Jira CSV durations: '3h 30m' | '3600' (seconds) | '1w 2d'. */
function seconds(v: string | undefined): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim());
  let sec = 0;
  const re = /(\d+(?:\.\d+)?)\s*([wdhm])/g;
  let m;
  const mult = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 } as Record<string, number>;
  while ((m = re.exec(v))) sec += Number(m[1]) * mult[m[2]];
  return sec || null;
}

function slug(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') || 'unknown'
  );
}

/** Canonical field → accepted header aliases (mirrors the col() calls below). */
const HEADER_ALIASES: [string, string[]][] = [
  ['issueKey', ['issue key', 'key']],
  ['issueId', ['issue id', 'issueid', 'id']],
  ['summary', ['summary']],
  ['description', ['description']],
  ['issueType', ['issue type', 'issuetype', 'type']],
  ['status', ['status']],
  ['priority', ['priority']],
  ['resolution', ['resolution']],
  ['assignee', ['assignee', 'assignee id']],
  ['reporter', ['reporter', 'reporter id', 'creator']],
  ['labels', ['labels', 'label']],
  ['dueDate', ['due date', 'duedate', 'due']],
  ['parent', ['parent', 'parent key', 'parent id', 'epic link']],
  ['created', ['created']],
  ['updated', ['updated']],
  ['comment', ['comment']],
  ['attachment', ['attachment']],
  ['components', ['component/s', 'components', 'component']],
  ['fixVersions', ['fix version/s', 'fix versions', 'fixversion']],
  ['affectsVersions', ['affects version/s', 'affects versions']],
  ['watchers', ['watchers', 'watcher count']],
  ['votes', ['votes', 'vote count']],
  ['storyPoints', ['story points', 'custom field (story points)']],
  ['originalEstimate', ['original estimate', 'timeoriginalestimate']],
  ['remainingEstimate', ['remaining estimate', 'timeestimate']],
  ['flagged', ['flagged']],
  ['sprint', ['sprint']],
  ['projectKey', ['project key', 'projectkey']],
  ['projectName', ['project name', 'projectname']],
];

/** 039 preview: first-N rows + header→field resolution for the mapping UI. */
export function previewCsv(csv: string, maxRows = 10) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new Error('empty CSV');
  const headers = rows[0].map((h) => h.trim());
  const mapping: Record<string, string | null> = {};
  for (const h of new Set(headers.map((x) => x.toLowerCase()))) {
    const hit = HEADER_ALIASES.find(([, aliases]) => aliases.includes(h));
    mapping[h] = hit ? hit[0] : null;
  }
  const dataRows = rows.slice(1);
  const projectKeys = new Set<string>();
  const keyIdx = headers.findIndex((h) => /^(issue key|key)$/i.test(h));
  const projIdx = headers.findIndex((h) => /^project ?key$/i.test(h));
  for (const r of dataRows) {
    const pk =
      (projIdx >= 0 ? r[projIdx]?.trim() : '') ||
      (keyIdx >= 0 ? (parseIssueKeyParts(r[keyIdx] ?? '')?.projectKey ?? '') : '');
    if (pk) projectKeys.add(pk);
  }
  return {
    headers,
    mapping,
    unrecognized: Object.entries(mapping)
      .filter(([, v]) => !v)
      .map(([k]) => k),
    issueCount: dataRows.filter((r) => r.some((c) => c.trim())).length,
    projectKeys: [...projectKeys],
    preview: dataRows.slice(0, maxRows).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? '']))),
    totalRows: dataRows.length,
  };
}

interface Column {
  idx: number[];
  name: string;
}

export function csvToFixture(
  csv: string,
  opts: { projectKey?: string; defaultProjectName?: string } = {}
): Record<string, unknown> {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  const headers = rows[0].map((h) => h.trim());
  const cols = new Map<string, number[]>();
  headers.forEach((h, i) => {
    const key = h.toLowerCase();
    const arr = cols.get(key) ?? [];
    arr.push(i);
    cols.set(key, arr);
  });
  const col = (...names: string[]): Column | null => {
    for (const n of names) {
      const idx = cols.get(n);
      if (idx) return { idx, name: n };
    }
    return null;
  };
  const val = (r: string[], c: Column | null): string => (c ? (r[c.idx[0]] ?? '').trim() : '');
  const vals = (r: string[], c: Column | null): string[] =>
    c ? c.idx.map((i) => (r[i] ?? '').trim()).filter(Boolean) : [];

  const users = new Map<string, { accountId: string; emailAddress: string; displayName: string; active: boolean }>();
  const user = (name: string) => {
    if (!name) return null;
    const s = slug(name);
    if (!users.has(s)) {
      const email = name.includes('@') ? name.toLowerCase() : `${s}@import.local`;
      users.set(s, { accountId: `csv:${s}`, emailAddress: email, displayName: name.trim(), active: true });
    }
    return { accountId: `csv:${s}` };
  };

  const types = new Set<string>(),
    statuses = new Set<string>(),
    priorities = new Set<string>(),
    resolutions = new Set<string>();
  const projects = new Map<string, string>();
  const comps = new Map<string, Map<string, string>>(); // projectKey → compName → extId
  const vers = new Map<string, Map<string, string>>(); // projectKey → verName → extId
  const issues: Record<string, unknown>[] = [];

  const rel = (map: Map<string, Map<string, string>>, pk: string, prefix: string, names: string[]) => {
    const m = map.get(pk) ?? new Map<string, string>();
    map.set(pk, m);
    return names.map((n) => {
      if (!m.has(n)) m.set(n, `${prefix}-${slug(n)}-${m.size}`);
      return { id: m.get(n)!, name: n };
    });
  };

  const cKey = col('issue key', 'key');
  const cId = col('issue id', 'issueid', 'id');
  const cParent = col('parent', 'parent key', 'parent id', 'epic link');
  const cComment = col('comment');
  const cAttach = col('attachment');
  const cSprint = col('sprint');
  const sprintNames = new Set<string>();

  for (const r of rows.slice(1)) {
    const key = val(r, cKey);
    if (!key) continue;
    const projectKey =
      val(r, col('project key', 'projectkey')) ||
      opts.projectKey ||
      parseIssueKeyParts(key)?.projectKey ||
      key.split('-')[0];
    const projectName =
      val(r, col('project name', 'projectname')) || opts.defaultProjectName || `${projectKey} (CSV import)`;
    projects.set(projectKey, projectName);

    const type = val(r, col('issue type', 'issuetype', 'type')) || 'Task';
    const status = val(r, col('status')) || 'To Do';
    const priority = val(r, col('priority'));
    const resolution = val(r, col('resolution'));
    types.add(type);
    statuses.add(status);
    if (priority) priorities.add(priority);
    if (resolution) resolutions.add(resolution);

    const comments = vals(r, cComment).map((cell) => {
      const [dateStr, author, ...body] = cell.split(';');
      return {
        body: body.join(';').trim() || cell,
        created: iso(dateStr) ?? new Date().toISOString(),
        author: user(author ?? 'import'),
      };
    });
    for (const c of comments) for (const u of [c.author]) if (u) user((u as { accountId: string }).accountId.slice(4));

    const fields: Record<string, unknown> = {
      summary: val(r, col('summary')) || '(no summary)',
      description: val(r, col('description')) || undefined,
      issuetype: { name: type },
      status: { name: status },
      project: { key: projectKey },
      priority: priority ? { name: priority } : null,
      resolution: resolution ? { name: resolution } : null,
      assignee: user(val(r, col('assignee', 'assignee id'))),
      reporter: user(val(r, col('reporter', 'reporter id', 'creator'))),
      labels: vals(r, col('labels', 'label')),
      duedate: iso(val(r, col('due date', 'duedate', 'due'))) ?? undefined,
      parent: val(r, cParent) ? { key: val(r, cParent) } : undefined,
      created: iso(val(r, col('created'))) ?? undefined,
      updated: iso(val(r, col('updated'))) ?? undefined,
      comment: { comments, total: comments.length },
      components: rel(comps, projectKey, 'csv-comp', vals(r, col('component/s', 'components', 'component'))),
      fixVersions: rel(vers, projectKey, 'csv-ver', vals(r, col('fix version/s', 'fix versions', 'fixversion'))),
      versions: rel(vers, projectKey, 'csv-ver', vals(r, col('affects version/s', 'affects versions'))),
      watches: { watchCount: Number(val(r, col('watchers', 'watcher count'))) || 0 },
      votes: { votes: Number(val(r, col('votes', 'vote count'))) || 0 },
      customfield_10016:
        seconds(val(r, col('story points', 'custom field (story points)'))) ??
        (val(r, col('story points', 'custom field (story points)'))
          ? Number(val(r, col('story points', 'custom field (story points)'))) || null
          : null),
      timeoriginalestimate: seconds(val(r, col('original estimate', 'timeoriginalestimate'))),
      timeestimate: seconds(val(r, col('remaining estimate', 'timeestimate'))),
      customfield_10021: vals(r, col('flagged')).length ? [{ value: 'Impediment' }] : undefined,
      // Jira CSV Attachment cells are download URLs — only http(s) values get
      // a contentUrl (fetched by the fixture source); file paths plan-skip.
      attachment: vals(r, cAttach).map((u, ai) => ({
        id: `csv-att-${key}-${ai}`,
        filename: decodeURIComponent(u.split('/').pop() ?? 'file'),
        content: /^https?:\/\//i.test(u) ? u : null,
        size: 1,
      })),
      sprint: (() => {
        const s = val(r, cSprint);
        if (s) sprintNames.add(s);
        return s ? { name: s } : undefined;
      })(),
    };
    issues.push({ id: val(r, cId) || key, key, fields });
  }

  const meta = (items: Set<string>, defaults: string[]) =>
    [...new Set([...defaults, ...items])].map((name, i) => ({ id: `csv-${i}`, name }));

  const fixture: Record<string, unknown> = {
    '/rest/api/3/users/search': [...users.values()],
    '/rest/api/3/issuetype': [...types].map((name, i) => ({
      id: `csv-type-${i}`,
      name,
      subtask: /sub[- ]?task/i.test(name),
    })),
    '/rest/api/3/status': [...statuses].map((name, i) => ({
      id: `csv-status-${i}`,
      name,
      statusCategory: { key: /done|closed|resolved/i.test(name) ? 'done' : 'new' },
    })),
    '/rest/api/3/priority': meta(priorities, ['Highest', 'High', 'Medium', 'Low', 'Lowest']),
    '/rest/api/3/resolution': meta(resolutions, []),
    '/rest/api/3/search': { issues, total: issues.length, maxResults: issues.length, startAt: 0 },
    '/rest/api/3/role': [],
    '/rest/api/3/field': [],
    '/rest/api/3/issuesecurityschemes': { issueSecuritySchemes: [] },
    '/rest/api/3/issuetypescheme': { issueTypeSchemes: [] },
    '/rest/api/3/fieldconfigurations': { values: [] },
    '/rest/api/3/workflow/search': { values: [] },
    '/rest/api/3/filter/search': { values: [] },
  };
  // Sprint column → synthetic agile board + sprint rows for sprintImporter;
  // the per-issue link is fields.sprint.name resolved by issueImporter.
  if (sprintNames.size) {
    fixture['/rest/agile/1.0/board'] = { values: [{ id: 'csv-board-1', name: 'CSV board', type: 'scrum' }] };
    fixture['/rest/agile/1.0/board/csv-board-1/sprint'] = {
      values: [...sprintNames].map((name, i) => ({ id: `csv-sprint-${i}`, name, state: 'future' })),
    };
  }
  for (const [key, name] of projects) {
    fixture[`/rest/api/3/project/${key}`] = {
      id: `csv-proj-${key}`,
      key,
      name,
      lead: { accountId: [...users.values()][0]?.accountId ?? 'csv:import' },
      projectTypeKey: 'software',
    };
    fixture[`/rest/api/3/project/${key}/components`] = [...(comps.get(key)?.entries() ?? [])].map(([n, id]) => ({
      id,
      name: n,
      project: key,
    }));
    fixture[`/rest/api/3/project/${key}/versions`] = [...(vers.get(key)?.entries() ?? [])].map(([n, id], i) => ({
      id,
      name: n,
      project: key,
      sequence: i,
    }));
  }
  return fixture;
}

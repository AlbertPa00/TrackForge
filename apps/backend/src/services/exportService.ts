// Sprint 023 US4: export — CSV (RFC-4180 + UTF-8 BOM for Excel) and print HTML.
// FR-004: identical permission/JQL filtering as /search — no exfil channel.
import type { Actor } from '../lib/auth.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { executeSearch } from './searchService.js';
import { getIssueByKey, toIssueResponse } from './issueService.js';
import { toCsv } from '../lib/http.js';

const EXPORT_CAP = 10_000;
const PAGE = 500;
const DEFAULT_COLUMNS = ['key', 'summary', 'issuetype', 'status', 'priority', 'assignee', 'reporter', 'created'];

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchAllIssues(actor: Actor, jql?: string) {
  const out: Record<string, unknown>[] = [];
  let startAt = 0;
  for (;;) {
    const r = await executeSearch(actor, {
      jql: jql ?? 'ORDER BY created DESC',
      startAt,
      maxResults: PAGE,
      fields: ['*all'],
    } as never);
    out.push(...(r.issues as Record<string, unknown>[]));
    if (r.issues.length < PAGE || out.length >= EXPORT_CAP) break;
    startAt += PAGE;
  }
  if (out.length >= EXPORT_CAP) {
    throw new JiraApiError(400, jiraError([`Export exceeds the ${EXPORT_CAP}-row cap — narrow the JQL.`]));
  }
  return out;
}

function fieldVal(issue: Record<string, unknown>, col: string): unknown {
  if (col === 'key') return issue.key;
  const fields = issue.fields as Record<string, unknown>;
  return fields[col];
}

export async function exportIssues(
  actor: Actor,
  opts: { jql?: string; format: 'csv' | 'print'; columns?: string[] }
): Promise<string> {
  const issues = await fetchAllIssues(actor, opts.jql);
  const cols = opts.columns?.length ? opts.columns : DEFAULT_COLUMNS;

  if (opts.format === 'print') {
    const rows = issues
      .map(
        (i) =>
          `<tr>${cols.map((c) => `<td>${esc(fieldVal(i, c) && typeof fieldVal(i, c) === 'object' ? ((fieldVal(i, c) as any).name ?? (fieldVal(i, c) as any).displayName ?? JSON.stringify(fieldVal(i, c))) : fieldVal(i, c))}</td>`).join('')}</tr>`
      )
      .join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Issues (${issues.length})</title>
<style>body{font-family:sans-serif;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #dfe1e6;padding:6px 8px;text-align:left;font-size:13px}th{background:#f4f5f7}@media print{th{background:#eee}}</style>
</head><body><h2>TrackForge — ${issues.length} issue${issues.length === 1 ? '' : 's'}</h2>
<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></body></html>`;
  }

  return toCsv([cols, ...issues.map((i) => cols.map((c) => fieldVal(i, c)))]);
}

export async function exportIssuePrint(actor: Actor, issueKey: string): Promise<string> {
  const issue = await getIssueByKey(issueKey);
  // 065 audit C3 — full visibility: browse permission + token allow-list +
  // security level. canSeeIssue alone skipped the two project gates, so any
  // authenticated caller could print an issue they can't browse.
  const { canSeeIssueFull } = await import('./visibilityService.js');
  if (!(await canSeeIssueFull(actor, issue))) {
    const { JiraApiError, jiraError } = await import('../lib/errors.js');
    throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
  }
  const { cfFieldsForIssues } = await import('./customFieldService.js');
  const cfMap = await cfFieldsForIssues([issue]);
  const r = toIssueResponse(issue, { actorId: actor.user.id, cfFields: cfMap.get(issue.id) }) as Record<
    string,
    unknown
  >;
  const f = r.fields as Record<string, any>;
  const comments = (f.comment?.comments ?? []) as any[];
  const kv = (label: string, val: unknown) =>
    `<tr><th>${esc(label)}</th><td>${esc(typeof val === 'object' && val ? ((val as any).name ?? (val as any).displayName ?? JSON.stringify(val)) : (val ?? '—'))}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(issueKey)}</title>
<style>body{font-family:sans-serif;margin:24px;max-width:800px}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #dfe1e6;padding:6px 8px;text-align:left;font-size:13px}th{background:#f4f5f7;width:160px}pre{white-space:pre-wrap;font-family:inherit}.c{border-left:3px solid #dfe1e6;padding-left:12px;margin:12px 0}</style>
</head><body>
<h2>${esc(issueKey)} — ${esc(f.summary)}</h2>
<table>
${kv('Type', f.issuetype)}${kv('Status', f.status)}${kv('Priority', f.priority)}
${kv('Assignee', f.assignee)}${kv('Reporter', f.reporter)}${kv('Labels', (f.labels ?? []).join(', '))}
${kv('Created', f.created)}${kv('Updated', f.updated)}${kv('Due', f.duedate)}${kv('Environment', f.environment)}
</table>
<h3>Description</h3><pre>${esc(f.description ?? '—')}</pre>
<h3>Comments (${comments.length})</h3>
${comments.map((c) => `<div class="c"><b>${esc(c.author?.displayName)}</b> <i>${esc(c.created)}</i><pre>${esc(c.body)}</pre></div>`).join('')}
</body></html>`;
}

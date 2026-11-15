// Human-readable rendering for parked agent writes (proposals). The stored
// `diff` is the dry-run preview the route produced at capture time — this maps
// it to the same shape the copilot `display` contract uses ({text, fields,
// issues, markdown}) so reviewers read sentences, never raw REST payloads.
// Unknown/non-previewable proposals fall back to a method+path headline.

export interface ProposalFieldRow {
  label: string;
  from?: string | null;
  to?: string | null;
}

export interface ProposalDisplay {
  text: string;
  fields?: ProposalFieldRow[];
  issues?: { key: string; summary?: string; meta?: string; preview?: boolean }[];
  markdown?: string;
  destructive?: boolean;
}

interface Change {
  field?: string;
  fromString?: string | null;
  toString?: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  summary: 'Summary',
  description: 'Description',
  environment: 'Environment',
  status: 'Status',
  issuetype: 'Issue Type',
  issuelinks: 'Link',
  Link: 'Link',
  priority: 'Priority',
  assignee: 'Assignee',
  reporter: 'Reporter',
  labels: 'Labels',
  duedate: 'Due date',
  parent: 'Parent',
  resolution: 'Resolution',
  security: 'Security Level',
  sprint: 'Sprint',
  rank: 'Rank',
  attachment: 'Attachment',
  comment: 'Comment',
  worklog: 'Worklog',
  votes: 'Votes',
  watches: 'Watchers',
  project: 'Project',
  timeoriginalestimate: 'Original estimate',
  timeestimate: 'Remaining estimate',
  timespent: 'Time Spent',
  components: 'Component/s',
  fixVersions: 'Fix Version/s',
  versions: 'Affects Version/s',
};

function changeRows(changes: unknown): ProposalFieldRow[] {
  const list = (changes as Change[] | undefined) ?? [];
  return list.map((c) => ({ label: FIELD_LABELS[c.field ?? ''] ?? c.field ?? 'Field', from: c.fromString, to: c.toString }));
}

const ISSUE_SUBPATH = /^\/rest\/api\/2\/issue\/([^/]+)\/([^/?]+)/;
const ISSUE_SELF = /^\/rest\/api\/2\/issue\/([^/]+)\/?$/;
const ISSUE_CREATE = /^\/rest\/api\/2\/issue\/?$/;
const INTERNAL_ISSUE_OP = /^\/api\/internal\/issues\/([^/]+)\/([^/?]+)/;
const INTERNAL_BULK = /^\/api\/internal\/bulk\/([^/?]+)/;

function issueSummary(diff: unknown): { key?: string; summary?: string; status?: string } {
  const issue = (diff as { issue?: { key?: string; fields?: { summary?: string; status?: { name?: string } } } })
    ?.issue;
  return { key: issue?.key, summary: issue?.fields?.summary, status: issue?.fields?.status?.name };
}

function compositeDisplay(key: string, diff: unknown): ProposalDisplay {
  const steps = (diff as { steps?: Record<string, unknown> })?.steps ?? {};
  const fields: ProposalFieldRow[] = [];
  let markdown: string | undefined;
  const items: string[] = [];
  let transitionText: string | undefined;

  if (steps.fields) {
    fields.push(...changeRows((steps.fields as { changes?: Change[] }).changes));
  }
  if (steps.transition) {
    const t = steps.transition as { changes?: Change[]; transition?: { name?: string } };
    fields.push(...changeRows(t.changes));
    transitionText = t.transition?.name;
  }
  if (steps.comment) {
    markdown = (steps.comment as { body?: string }).body;
  }
  if (steps.worklog) {
    const w = steps.worklog as { timeSpentSeconds?: number };
    if (w.timeSpentSeconds) items.push(`Log ${Math.round(w.timeSpentSeconds / 60)}m`);
  }
  return {
    text: `${transitionText ? `${transitionText} on` : 'Update'} ${key}`,
    fields: fields.length ? fields : undefined,
    markdown,
    issues: items.length ? items.map((i) => ({ key: '', meta: i })) : undefined,
  };
}

/** Describe a proposal's intent in human terms. Never throws — bad input
 *  degrades to the method+path headline. */
export function describeProposal(p: { method: string; path: string; body?: unknown; diff?: unknown }): ProposalDisplay {
  try {
    const { method, path } = p;
    const diff = p.diff as Record<string, unknown> | undefined;

    // --- issue-subpath ops (/issue/{key}/{action}) ---
    const sub = ISSUE_SUBPATH.exec(path);
    if (sub && method !== 'GET') {
      const [, key, action] = sub;
      if (method === 'POST' && action === 'comment') {
        const body = (diff?.comment as { body?: string } | undefined)?.body ?? (p.body as { body?: string })?.body;
        return { text: `Comment on ${key}`, markdown: body };
      }
      if (method === 'POST' && action === 'watchers') {
        const user = (diff?.watch as { user?: { displayName?: string } } | undefined)?.user?.displayName;
        return { text: `Watch ${key}${user ? ` as ${user}` : ''}` };
      }
      if (method === 'POST' && action === 'worklog') {
        const w = diff?.worklog as { timeSpent?: string; comment?: string } | undefined;
        return { text: `Log work on ${key}${w?.timeSpent ? ` — ${w.timeSpent}` : ''}`, markdown: w?.comment };
      }
      if (method === 'POST' && action === 'transitions') {
        const rows = changeRows(diff?.changes as Change[] | undefined);
        const status = rows.find((r) => r.label === 'Status');
        const rest = rows.filter((r) => r !== status);
        return {
          text: status ? `${key}: ${status.from ?? '?'} → ${status.to ?? '?'}` : `Transition ${key}`,
          fields: rest.length ? rest : undefined,
        };
      }
      if (method === 'PUT' && action === 'assignee') {
        const rows = changeRows(diff?.changes as Change[] | undefined);
        const a = rows.find((r) => r.label === 'Assignee');
        return { text: `Assign ${key} to ${a?.to ?? 'Unassigned'}`, fields: restFields(rows, 'Assignee') };
      }
      if (method === 'PUT' && action === 'archive') return { text: `Archive ${key}`, destructive: true };
      if (method === 'PUT' && action === 'restore') return { text: `Restore ${key}` };
    }

    // --- issue self (/issue/{key}) ---
    const self = ISSUE_SELF.exec(path);
    if (self) {
      const key = self[1]!;
      if (method === 'PUT') {
        return diff?.steps
          ? compositeDisplay(key, diff)
          : { text: `Update ${key}`, fields: changeRows(diff?.changes as Change[] | undefined) };
      }
      if (method === 'DELETE') {
        const d = diff as { deletesSubtasks?: string[]; clearsParentOn?: string[] } | undefined;
        const notes: string[] = [];
        if (d?.deletesSubtasks?.length) notes.push(`+ ${d.deletesSubtasks.length} subtask(s)`);
        if (d?.clearsParentOn?.length) notes.push(`clears parent on ${d.clearsParentOn.join(', ')}`);
        return { text: `Delete ${key}${notes.length ? ` (${notes.join('; ')})` : ''}`, destructive: true };
      }
    }

    // --- create + bulk create ---
    if (method === 'POST' && ISSUE_CREATE.test(path)) {
      const i = issueSummary(diff);
      return {
        text: `Create ${i.key ?? 'issue'}${i.summary ? ` — ${i.summary}` : ''}`,
        fields: changeRows(diff?.changes as Change[] | undefined),
      };
    }
    if (method === 'POST' && /^\/rest\/api\/2\/issue\/bulk\/?$/.test(path)) {
      const d = diff as
        | { issues?: { index: number; preview?: { issue?: { key?: string; fields?: { summary?: string } } } }[]; errors?: { index: number; errorMessages?: string[] }[] }
        | undefined;
      const issues = (d?.issues ?? []).map((it) => ({
        key: it.preview?.issue?.key ?? `#${it.index}`,
        summary: it.preview?.issue?.fields?.summary,
        preview: true,
      }));
      const errCount = d?.errors?.length ?? 0;
      return {
        text: `Create ${issues.length || '?'} issues${errCount ? ` (${errCount} invalid)` : ''}`,
        issues,
      };
    }

    // --- links / watchers / rank ---
    if (method === 'POST' && /^\/rest\/api\/2\/issueLink\/?$/.test(path)) {
      const text = (diff?.link as { text?: string } | undefined)?.text;
      return { text: text ? `Link: ${text}` : 'Link issues' };
    }
    if (method === 'PUT' && /^\/rest\/agile\/1\.0\/issue\/rank\/?$/.test(path)) {
      const r = diff?.rank as { text?: string } | undefined;
      return { text: r?.text ? `Rank ${r.text}` : 'Rank issues' };
    }

    // --- internal ops (body-dryRun proposals) ---
    const iop = INTERNAL_ISSUE_OP.exec(path);
    if (iop) {
      const [, key, op] = iop;
      if (op === 'move') {
        const target = (p.body as { target?: { projectKey?: string } })?.target?.projectKey;
        return { text: `Move ${key}${target ? ` to ${target}` : ''}` };
      }
      if (op === 'clone') return { text: `Clone ${key}` };
      return { text: `${op} ${key}` };
    }
    const ib = INTERNAL_BULK.exec(path);
    if (ib && method === 'POST') {
      const op = ib[1]!;
      const total = (diff as { total?: number })?.total ?? (p.body as { issueKeys?: string[] })?.issueKeys?.length;
      return { text: `Bulk ${op}${total ? ` on ${total} issue(s)` : ''}`, destructive: op === 'delete' };
    }

    return { text: `${method} ${path}` };
  } catch {
    return { text: `${p.method} ${p.path}` };
  }
}

function restFields(rows: ProposalFieldRow[], skip: string): ProposalFieldRow[] | undefined {
  const rest = rows.filter((r) => r.label !== skip);
  return rest.length ? rest : undefined;
}

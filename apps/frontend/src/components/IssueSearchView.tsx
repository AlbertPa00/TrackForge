import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchIssueTypes,
  fetchLabels,
  fetchPriorities,
  searchUsers,
  fetchResolutions,
  fetchStatuses,
  fetchProjects,
  fetchPreferences,
  putPreference,
  searchAssignableUsers,
  searchIssues,
  parseJqlQueries,
  createFilter,
  fetchFilter,
  setFilterFavourite,
  updateFilter,
  exportIssuesUrl,
  type Issue,
  type SavedFilter,
} from '../api/client.js';
import IssueTable, { DEFAULT_COLUMNS, COLUMN_DEFS, type SortDir } from './IssueTable.js';
import IssueDetailView from './IssueDetailView.js';
import IssueTypeIcon from './IssueTypeIcon.js';
import { IssueKeyLink } from './IssueKey.js';
import StatusLozenge from './StatusLozenge.js';
import UserAvatar from './UserAvatar.js';
import UserHoverCard from './UserHoverCard.js';
import { useListCursor } from '../hooks/useListCursor.js';
import JqlEditor from './JqlEditor.js';
import Modal from './Modal.js';
import SelectMenu from './SelectMenu.js';
import EmptyState from './EmptyState.js';
import CreateIssueDialog from './CreateIssueDialog.js';
import BulkWizard from './BulkWizard.js';
import { imeComposing } from '../lib/ime.js';

const FILTER_SELECT =
  'h-8 pl-2 pr-1.5 rounded-[3px] border-2 border-atl-n-40 text-sm bg-atl-paper outline-none focus:border-atl-b-300 inline-flex items-center gap-1.5';
const NATIVE_SELECT =
  'h-8 pl-2 pr-7 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-600 bg-atl-paper focus:border-atl-b-300 outline-none appearance-none bg-no-repeat';
const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M1.5 3.5 5 7l3.5-3.5' stroke='%236B778C' stroke-width='1.4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")";

/** Styled chip-select for the basic-mode filter bar (was a native <select>). */
function FilterSelect({
  value,
  placeholder,
  ariaLabel,
  options,
  onChange,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const current = options.find((o) => o.value === value)?.label;
  return (
    <SelectMenu
      value={value}
      title={ariaLabel}
      ariaLabel={ariaLabel}
      label={<span className={value ? 'text-atl-n-800' : 'text-atl-n-600'}>{current ?? placeholder}</span>}
      options={[{ value: '', label: placeholder }, ...options]}
      onChange={onChange}
      buttonClassName={FILTER_SELECT}
    />
  );
}
const PAGE_SIZES = [25, 50, 100];
/** 033 US4 — quick toggles AND'd onto the committed JQL (Jira navigator chips). */
const QUICK_TOGGLES: Record<string, { label: string; clause: string }> = {
  mine: { label: 'Only my issues', clause: 'assignee = currentUser()' },
  recent: { label: 'Recently updated', clause: 'updated >= -7d' },
  watching: { label: 'Watching', clause: 'watcher = currentUser()' },
  flagged: { label: 'Flagged', clause: 'Flagged IS NOT EMPTY' },
};
const ORDERABLE = new Set([
  'key',
  'created',
  'updated',
  'priority',
  'status',
  'assignee',
  'duedate',
  'resolved',
  'resolution',
  'project',
  'summary',
  'issuetype',
  'rank',
]);

// ---------- basic ⇄ jql mapping ----------

interface BasicState {
  project: string;
  status: string;
  priority: string;
  issuetype: string;
  assignee: string;
  resolution: string;
  labels: string;
  text: string;
}

const JQL_RESERVED = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'empty',
  'null',
  'order',
  'by',
  'asc',
  'desc',
  'was',
  'changed',
  'from',
  'to',
  'before',
  'after',
  'on',
  'during',
]);

function quote(v: string) {
  return /\s/.test(v) || JQL_RESERVED.has(v.toLowerCase()) ? `"${v}"` : v;
}

export function buildBasicJql(b: BasicState, orderBy: { field: string; dir: SortDir } | null): string {
  const parts: string[] = [];
  if (b.project) parts.push(`project = ${b.project}`);
  if (b.status) parts.push(`status = ${quote(b.status)}`);
  if (b.priority) parts.push(`priority = ${quote(b.priority)}`);
  if (b.issuetype) parts.push(`issuetype = ${quote(b.issuetype)}`);
  if (b.assignee === 'EMPTY') parts.push('assignee IS EMPTY');
  else if (b.assignee === 'me') parts.push('assignee = currentUser()');
  else if (b.assignee) parts.push(`assignee = ${quote(b.assignee)}`);
  if (b.resolution === 'EMPTY') parts.push('resolution IS EMPTY');
  else if (b.resolution) parts.push(`resolution = ${quote(b.resolution)}`);
  if (b.labels) parts.push(`labels = ${quote(b.labels)}`);
  if (b.text) parts.push(`text ~ "${b.text.replace(/"/g, '')}"`);
  let jql = parts.join(' AND ');
  if (orderBy?.field && ORDERABLE.has(orderBy.field)) {
    jql += `${jql ? ' ' : ''}ORDER BY ${orderBy.field} ${orderBy.dir.toUpperCase()}`;
  }
  return jql || 'ORDER BY created DESC';
}

/** Maps a parsed where-structure back to basic mode state; null = can't express. */
export function jqlToBasic(where: unknown): BasicState | null {
  const b: BasicState = {
    project: '',
    status: '',
    priority: '',
    issuetype: '',
    assignee: '',
    resolution: '',
    labels: '',
    text: '',
  };
  if (!where) return b;
  const clauses: {
    type: string;
    field?: string;
    operator?: string;
    operand?: { kind: string; value?: string | number; items?: { kind: string; value?: string | number }[] };
  }[] = [];
  const flatten = (node: unknown): boolean => {
    const n = node as { type: string; clauses?: unknown[] };
    if (n.type === 'and') {
      return n.clauses!.every(flatten);
    }
    if (n.type === 'condition') {
      clauses.push(n as (typeof clauses)[number]);
      return true;
    }
    return false;
  };
  if (!flatten(where)) return null;
  const firstValue = (c: (typeof clauses)[number]): string | undefined => {
    const op = c.operand;
    if (!op) return undefined;
    if (op.kind === 'string') return String(op.value);
    if (op.kind === 'function')
      return String(op.value).toLowerCase().startsWith('currentuser(') ? 'currentUser()' : undefined;
    if (op.kind === 'empty') return 'EMPTY';
    if (op.kind === 'list' && op.items?.length === 1) {
      const i = op.items[0];
      if (i.kind === 'string') return String(i.value);
      if (i.kind === 'function')
        return String(i.value).toLowerCase().startsWith('currentuser(') ? 'currentUser()' : undefined;
      if (i.kind === 'empty') return 'EMPTY';
    }
    return undefined;
  };
  for (const c of clauses) {
    const v = firstValue(c);
    if (v === undefined) return null;
    const eq =
      c.operator === '=' || (c.operator === 'IN' && c.operand?.kind === 'list' && c.operand.items?.length === 1);
    if (c.field === 'project' && eq) b.project = v;
    else if (c.field === 'status' && eq) b.status = v;
    else if (c.field === 'priority' && eq) b.priority = v;
    else if (c.field === 'issuetype' && eq) b.issuetype = v;
    else if (c.field === 'assignee') {
      if (c.operator === 'IS') b.assignee = 'EMPTY';
      else if (v === 'currentUser()') b.assignee = 'me';
      else if (eq) b.assignee = v;
      else return null;
    } else if (c.field === 'resolution') {
      if (c.operator === 'IS') b.resolution = 'EMPTY';
      else if (eq) b.resolution = v;
      else return null;
    } else if (c.field === 'labels' && eq) b.labels = v;
    else if ((c.field === 'text' || c.field === 'summary') && c.operator === '~') b.text = v;
    else return null;
  }
  return b;
}

// ---------- column chooser ----------

/** Escape closes the menu — same contract as SelectMenu/modals. */
function useEscapeClose(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);
}

function ColumnChooser({ columns, onChange }: { columns: string[]; onChange: (c: string[]) => void }) {
  const [open, setOpen] = useState(false);
  useEscapeClose(open, () => setOpen(false));
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20 inline-flex items-center gap-1"
        aria-label="Choose columns"
      >
        Columns
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-40 w-52 bg-atl-paper border border-atl-n-30 rounded shadow-lg py-1.5 max-h-80 overflow-auto">
            {Object.values(COLUMN_DEFS).map((col) => {
              const checked = columns.includes(col.id);
              return (
                <label
                  key={col.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange(checked ? columns.filter((c) => c !== col.id) : [...columns, col.id])}
                  />
                  {col.label}
                </label>
              );
            })}
            <div className="border-t border-atl-n-30 mt-1 pt-1 px-3">
              <button className="text-xs text-atl-b-300 hover:underline" onClick={() => onChange(DEFAULT_COLUMNS)}>
                Restore defaults
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- save-as modal ----------

function SaveFilterModal({
  open,
  jql,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  jql: string;
  existing?: SavedFilter | null;
  onClose: () => void;
  onSaved: (f: SavedFilter) => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [visibility, setVisibility] = useState<'private' | 'all'>(existing?.visibility ?? 'private');
  useEffect(() => {
    if (open) {
      setName(existing?.name ?? '');
      setDescription(existing?.description ?? '');
      setVisibility(existing?.visibility ?? 'private');
    }
  }, [open, existing]);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      existing
        ? updateFilter(existing.id, { name, description, visibility })
        : createFilter({ name, jql, description, visibility }),
    onSuccess: (f) => {
      queryClient.invalidateQueries({ queryKey: ['filters'] });
      onSaved(f);
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-6 py-5 space-y-3">
        <h2 className="text-base font-semibold text-atl-n-800">{existing ? 'Edit filter' : 'Save as filter'}</h2>
        <div>
          <label className="block text-xs font-semibold text-atl-n-500 mb-1">Name</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full h-8 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm focus:border-atl-b-300 outline-none"
            placeholder="e.g. My open bugs"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-atl-n-500 mb-1">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full h-8 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm focus:border-atl-b-300 outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-atl-n-500 mb-1">Shared with</label>
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value as 'private' | 'all')}
            className={NATIVE_SELECT}
            style={{ backgroundImage: CHEVRON, backgroundPosition: 'right 8px center' }}
          >
            <option value="private">Only me</option>
            <option value="all">All users</option>
          </select>
        </div>
        {save.error && <p className="text-xs text-atl-r-400">{String(save.error)}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20">
            Cancel
          </button>
          <button
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
            className="h-8 px-4 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white disabled:opacity-50"
          >
            {existing ? 'Save' : 'Save filter'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- main view ----------

/** Jira navigator detail view: the compact issue rows in the middle column —
    key + summary on line one, status + assignee on line two. The key still
    links out to the full /browse page; any other row click selects the pane. */
function CompactIssueList({
  issues,
  activeKey,
  onSelect,
  selected,
  onToggle,
  groupLabel,
  indentKeys,
}: {
  issues: Issue[];
  activeKey: string;
  onSelect: (key: string) => void;
  selected?: Set<string>;
  onToggle?: (key: string, on: boolean) => void;
  groupLabel?: (issue: Issue) => string;
  indentKeys?: Set<string>;
}) {
  const cursor = useListCursor(
    issues.length,
    (i) => {
      const it = issues[i];
      if (it) onSelect(it.key);
    },
    // j/k loads the issue into the split detail pane as the cursor moves.
    (i) => {
      const it = issues[i];
      if (it) onSelect(it.key);
    }
  );
  let lastGroup: string | undefined;
  return (
    <ul>
      {issues.map((issue, idx) => {
        const gl = groupLabel?.(issue);
        const header =
          groupLabel && gl !== lastGroup ? (
            <li
              key={`__group-${gl}`}
              className="bg-atl-n-10 border-b border-atl-n-30 px-3 py-1.5 text-xs font-semibold text-atl-n-500 uppercase tracking-wide"
            >
              {gl}
            </li>
          ) : null;
        lastGroup = gl;
        const isCursor = cursor === idx;
        const active = issue.key === activeKey;
        return (
          <Fragment key={issue.id}>
            {header}
            <li
              ref={isCursor ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              aria-selected={active || undefined}
              onClick={() => onSelect(issue.key)}
              className={`border-b border-atl-n-30 last:border-0 px-3 py-2 cursor-pointer hover:bg-atl-n-10 ${
                active || selected?.has(issue.key) || isCursor ? 'bg-atl-b-50' : ''
              } ${isCursor ? 'outline outline-1 -outline-offset-1 outline-atl-b-300' : ''} ${
                indentKeys?.has(issue.key) ? 'pl-6' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                {selected !== undefined && (
                  <input
                    type="checkbox"
                    checked={selected.has(issue.key)}
                    onChange={(e) => onToggle?.(issue.key, e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${issue.key}`}
                  />
                )}
                <span className="inline-flex" title={issue.fields.issuetype.name}>
                  <IssueTypeIcon name={issue.fields.issuetype.name} hierarchyLevel={issue.fields.issuetype.hierarchyLevel} />
                </span>
                <IssueKeyLink
                  issueKey={issue.key}
                  issue={issue}
                  categoryKey={issue.fields.status.statusCategory.key}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 text-xs text-atl-b-300 hover:underline whitespace-nowrap"
                />
                <span className="truncate text-sm text-atl-n-800" title={issue.fields.summary}>
                  {issue.fields.summary}
                </span>
                <span className="ml-auto shrink-0">
                  <UserAvatar displayName={issue.fields.assignee?.displayName} size={20} />
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2 pl-6">
                <StatusLozenge name={issue.fields.status.name} categoryKey={issue.fields.status.statusCategory.key} />
                <UserHoverCard user={issue.fields.assignee}>
                  <span
                    className="text-xs text-atl-n-200 truncate"
                    title={issue.fields.assignee?.accountId ? undefined : issue.fields.assignee?.displayName ?? 'Unassigned'}
                  >
                    {issue.fields.assignee?.displayName ?? 'Unassigned'}
                  </span>
                </UserHoverCard>
              </div>
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}

export default function IssueSearchView({ fixedProjectKey }: { fixedProjectKey?: string }) {
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [basicHint, setBasicHint] = useState<string | null>(null);
  // 023 bulk selection: explicit keys, or whole-JQL mode
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectAllJql, setSelectAllJql] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewsOpen, setViewsOpen] = useState(false);
  useEscapeClose(exportOpen, () => setExportOpen(false));
  useEscapeClose(moreOpen, () => setMoreOpen(false));
  useEscapeClose(viewsOpen, () => setViewsOpen(false));
  const [extraChips, setExtraChips] = useState<Set<'resolution' | 'labels'>>(new Set());

  const mode = params.get('mode') === 'jql' ? 'jql' : 'basic';
  const project = fixedProjectKey ?? params.get('project') ?? '';
  const status = params.get('status') ?? '';
  const priority = params.get('priority') ?? '';
  const issuetype = params.get('issuetype') ?? '';
  const assignee = params.get('assignee') ?? '';
  const resolution = params.get('resolution') ?? '';
  const labels = params.get('labels') ?? '';
  const committedText = params.get('text') ?? '';
  const sortField = params.get('sort') ?? 'created';
  const dir: SortDir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const startAt = Math.max(0, Number(params.get('startAt')) || 0);
  const maxResults = PAGE_SIZES.includes(Number(params.get('maxResults'))) ? Number(params.get('maxResults')) : 50;
  const filterId = params.get('filterId') ?? '';
  const colsParam = params.get('cols') ?? '';
  // Jira navigator view switcher: 'list' (full table) or 'detail' (split — compact
  // list + the selected issue full-fidelity in a right pane). `issue` holds the key.
  const viewMode = params.get('view') === 'detail' ? 'detail' : 'list';
  const detailKey = params.get('issue') ?? '';

  const basicState: BasicState = {
    project,
    status,
    priority,
    issuetype,
    assignee,
    resolution,
    labels,
    text: committedText,
  };
  const builtJql = buildBasicJql(basicState, { field: sortField, dir });
  const jql = mode === 'jql' ? (params.get('jql') ?? builtJql) : builtJql;

  // JQL editor local state (committed on Search/Enter)
  const committedJql = params.get('jql') ?? '';
  const [jqlDraft, setJqlDraft] = useState(committedJql);
  useEffect(() => setJqlDraft(committedJql), [committedJql]);

  const [text, setText] = useState(committedText);
  useEffect(() => setText(committedText), [committedText]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (text !== committedText) update({ text, startAt: '0' });
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, committedText]);

  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  }

  // columns: URL override → user preference → defaults
  const { data: prefs } = useQuery({ queryKey: ['preferences'], queryFn: fetchPreferences, staleTime: 60_000 });
  const prefCols = Array.isArray(prefs?.['issueTable.columns'])
    ? (prefs['issueTable.columns'] as string[]).filter((c) => COLUMN_DEFS[c])
    : null;
  const columns = colsParam ? colsParam.split(',').filter((c) => COLUMN_DEFS[c]) : (prefCols ?? DEFAULT_COLUMNS);

  // loaded filter
  const { data: loadedFilter } = useQuery({
    queryKey: ['filters', 'one', filterId],
    queryFn: () => fetchFilter(filterId),
    enabled: Boolean(filterId),
  });
  useEffect(() => {
    if (loadedFilter && !committedJql) {
      const next = new URLSearchParams(params);
      next.set('jql', loadedFilter.jql);
      next.set('mode', 'jql');
      setParams(next, { replace: true });
    }
    // commit the loaded filter's JQL once on filter change
    // eslint-disable-next-line
  }, [loadedFilter?.id]);

  // validate JQL in jql mode (debounced) → error banner
  const [jqlError, setJqlError] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'jql' || !jqlDraft.trim()) {
      setJqlError(null);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const [r] = await parseJqlQueries([jqlDraft]);
        setJqlError(r.errors?.[0] ?? null);
      } catch {
        setJqlError(null);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [jqlDraft, mode]);

  // 033 US4 — quick toggles: extra clauses AND'd onto the committed JQL at
  // query time (JQL-equivalent — identical to hand-writing the same clause).
  const qtParam = params.get('qt') ?? '';
  const activeToggles = useMemo(() => qtParam.split(',').filter((t) => QUICK_TOGGLES[t]), [qtParam]);
  const searchJql = useMemo(() => {
    if (!activeToggles.length) return jql;
    const obIdx = jql.toUpperCase().lastIndexOf(' ORDER BY ');
    const base = obIdx >= 0 ? jql.slice(0, obIdx) : jql;
    const order = obIdx >= 0 ? jql.slice(obIdx) : '';
    const clauses = activeToggles.map((t) => `(${QUICK_TOGGLES[t].clause})`).join(' AND ');
    return `${base ? `${base} AND ` : ''}${clauses}${order}`;
  }, [jql, activeToggles]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['issues', searchJql, startAt, maxResults],
    queryFn: () => searchIssues(searchJql, { startAt, maxResults }),
    enabled: Boolean(searchJql.trim()) && !(mode === 'jql' && jqlError),
    placeholderData: keepPreviousData,
  });

  const { data: statuses } = useQuery({ queryKey: ['statuses'], queryFn: fetchStatuses });
  const { data: priorities } = useQuery({ queryKey: ['priorities'], queryFn: fetchPriorities });
  const { data: issueTypes } = useQuery({ queryKey: ['issuetypes'], queryFn: fetchIssueTypes });
  const { data: resolutions } = useQuery({ queryKey: ['resolutions'], queryFn: fetchResolutions });
  const { data: labelValues } = useQuery({ queryKey: ['labels'], queryFn: fetchLabels });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  // Assignee options: project-scoped assignable users when a project is
  // picked; the full user directory otherwise (previously fell back to the
  // first project, hiding everyone else).
  const { data: assignable } = useQuery({
    queryKey: project ? ['assignable', project, ''] : ['user-search', ''],
    queryFn: () => (project ? searchAssignableUsers(project, '') : searchUsers('')),
    enabled: Boolean(project || projects?.length),
  });

  const issues = data?.issues ?? [];
  const total = data?.total ?? 0;
  const pageStart = total === 0 ? 0 : startAt + 1;
  const pageEnd = Math.min(startAt + maxResults, total);
  const queryClient = useQueryClient();

  // ---- 033 US4: group-by, subtask nesting, quick toggles ----
  const groupBy = params.get('group') || (prefs?.['issueTable.groupBy'] as string) || '';
  const subNest = (params.get('st') ?? '') === '1' || prefs?.['issueTable.subtaskNest'] === true;
  const subtaskTypeIds = new Set((issueTypes ?? []).filter((t) => t.subtask).map((t) => t.id));
  const GROUPERS: Record<string, (i: (typeof issues)[number]) => string> = {
    status: (i) => i.fields.status.name,
    assignee: (i) => i.fields.assignee?.displayName ?? 'Unassigned',
    priority: (i) => i.fields.priority?.name ?? 'None',
    issuetype: (i) => i.fields.issuetype.name,
    epic: (i) => i.fields.parent?.key ?? 'No epic',
  };
  const groupFn = GROUPERS[groupBy];

  /** Nests each subtask directly beneath its parent when the parent is in `list`. */
  function nestIssues(list: typeof issues): { rows: typeof issues; indent: Set<string> } {
    const inList = new Set(list.map((i) => i.key));
    const childrenOf = new Map<string, typeof issues>();
    const isSub = (i: (typeof issues)[number]) => subtaskTypeIds.has(i.fields.issuetype.id) && Boolean(i.fields.parent);
    for (const i of list) {
      if (isSub(i) && inList.has(i.fields.parent!.key)) {
        const k = i.fields.parent!.key;
        childrenOf.set(k, [...(childrenOf.get(k) ?? []), i]);
      }
    }
    const emitted = new Set<string>();
    const indent = new Set<string>();
    const rows: typeof issues = [];
    for (const i of list) {
      if (emitted.has(i.key)) continue;
      if (isSub(i) && inList.has(i.fields.parent!.key)) continue; // emitted under parent
      rows.push(i);
      emitted.add(i.key);
      for (const c of childrenOf.get(i.key) ?? []) {
        rows.push(c);
        emitted.add(c.key);
        indent.add(c.key);
      }
    }
    for (const i of list) if (!emitted.has(i.key)) rows.push(i);
    return { rows, indent };
  }

  let displayIssues = issues;
  let indentKeys: Set<string> | undefined;
  if (groupFn) {
    const groups = new Map<string, typeof issues>();
    for (const i of issues) {
      const g = groupFn(i);
      groups.set(g, [...(groups.get(g) ?? []), i]);
    }
    const orderedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
    if (subNest) {
      const nested = orderedKeys.map((k) => nestIssues(groups.get(k)!));
      displayIssues = nested.flatMap((n) => n.rows);
      indentKeys = new Set(nested.flatMap((n) => [...n.indent]));
    } else {
      displayIssues = orderedKeys.flatMap((k) => groups.get(k)!);
    }
  } else if (subNest) {
    const n = nestIssues(issues);
    displayIssues = n.rows;
    indentKeys = n.indent;
  }

  const saveViewPref = (key: string, value: unknown) =>
    putPreference(key, value).then(() => queryClient.invalidateQueries({ queryKey: ['preferences'] }));

  // Selection resets when the result set changes
  useEffect(() => {
    setSelected(new Set());
    setSelectAllJql(false);
  }, [jql]);

  const toggleOne = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const togglePage = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of issues) {
        if (on) next.add(i.key);
        else next.delete(i.key);
      }
      return next;
    });
  const clearSelection = () => {
    setSelected(new Set());
    setSelectAllJql(false);
  };
  const selectionActive = selectAllJql || selected.size > 0;

  // Detail view: keep `issue` pointed at a row that exists — auto-select the
  // first result when it's empty or the key scrolled off the page.
  useEffect(() => {
    if (viewMode !== 'detail' || displayIssues.length === 0) return;
    if (!detailKey || !displayIssues.some((i) => i.key === detailKey)) {
      update({ issue: displayIssues[0].key });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update() closes over params; keyed on the inputs that decide it
  }, [viewMode, displayIssues, detailKey]);

  const toggleSort = (orderField: string) =>
    update(
      sortField === orderField
        ? { dir: dir === 'asc' ? 'desc' : 'asc', startAt: '0' }
        : { sort: orderField, dir: 'asc', startAt: '0' }
    );

  const switchToJql = () => update({ mode: 'jql', jql: jql, startAt: '0' });

  const switchToBasic = async () => {
    try {
      const [r] = await parseJqlQueries([jqlDraft]);
      if (r.errors?.length) {
        setBasicHint("This query can't be shown in Basic mode — fix the error or keep editing in JQL.");
        return;
      }
      const b = jqlToBasic(r.structure?.where);
      if (!b) {
        setBasicHint("This query can't be expressed in Basic mode (it uses advanced clauses).");
        return;
      }
      setBasicHint(null);
      update({
        mode: '',
        jql: '',
        project: b.project,
        status: b.status,
        priority: b.priority,
        issuetype: b.issuetype,
        assignee: b.assignee,
        resolution: b.resolution,
        labels: b.labels,
        text: b.text,
        startAt: '0',
      });
    } catch {
      setBasicHint('Could not validate the query — keep editing in JQL mode.');
    }
  };

  const runJql = (jql?: string) => {
    if (jqlError) return;
    update({ jql: jql ?? jqlDraft, startAt: '0' });
  };

  const favMutation = useMutation({
    mutationFn: ({ id, fav }: { id: string; fav: boolean }) => setFilterFavourite(id, fav),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['filters'] }),
  });

  const showStar = Boolean(loadedFilter);
  const dirty = Boolean(loadedFilter && committedJql && committedJql !== loadedFilter.jql);

  return (
    <div className={`px-6 py-5 ${viewMode === 'detail' ? 'h-[calc(100vh-3rem)] flex flex-col overflow-hidden' : ''}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-xs text-atl-n-200 mb-0.5">
            {fixedProjectKey ? (
              <>
                Projects / <span className="text-atl-n-400">{fixedProjectKey}</span>
              </>
            ) : (
              'Filters / Advanced issue search'
            )}
          </div>
          <h1 className="text-xl font-semibold text-atl-n-800 inline-flex items-center gap-2">
            {loadedFilter ? loadedFilter.name : 'Issues'}
            {showStar && (
              <button
                onClick={() => favMutation.mutate({ id: loadedFilter!.id, fav: !loadedFilter!.favourite })}
                className="text-atl-n-200 hover:text-atl-y-400"
                title={loadedFilter!.favourite ? 'Unstar filter' : 'Star filter'}
                aria-label="Toggle favourite"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill={loadedFilter!.favourite ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  strokeWidth="1.4"
                >
                  <path d="M8 1.5 10 6l4.9.4-3.7 3.2 1.1 4.8L8 11.6l-4.3 2.8 1.1-4.8-3.7-3.2L6 6z" />
                </svg>
              </button>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <button
              onClick={() => setSaveOpen(true)}
              className="h-8 px-3 rounded-[3px] text-sm text-atl-b-300 hover:bg-atl-b-50 font-medium"
            >
              Save changes
            </button>
          )}
          <button
            onClick={() => setSaveOpen(true)}
            className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20"
          >
            {loadedFilter ? 'Save as…' : 'Save as'}
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="h-8 px-3 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white"
          >
            Create issue
          </button>
        </div>
      </div>

      <div className="mb-3">
        {mode === 'jql' ? (
          <div className="flex items-start gap-3">
            <JqlEditor value={jqlDraft} onChange={setJqlDraft} onRun={runJql} error={jqlError} autoFocus />
            <button
              onClick={switchToBasic}
              className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20 shrink-0"
            >
              Basic
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-atl-n-100"
                fill="currentColor"
              >
                <path d="M11.6 10.1a5.5 5.5 0 1 0-1.5 1.5l3.1 3.1 1.4-1.4zM7.5 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
              </svg>
              <input
                type="text"
                placeholder="Contains text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="w-44 h-8 pl-8 pr-3 rounded-[3px] border-2 border-atl-n-40 text-sm focus:border-atl-b-300 outline-none"
              />
            </div>
            {!fixedProjectKey && (
              <FilterSelect
                value={project}
                placeholder="All projects"
                ariaLabel="Filter by project"
                options={(projects ?? []).map((p) => ({ value: p.key, label: `${p.key} — ${p.name}` }))}
                onChange={(v) => update({ project: v, startAt: '0' })}
              />
            )}
            <FilterSelect
              value={issuetype}
              placeholder="Type"
              ariaLabel="Filter by issue type"
              options={(issueTypes ?? []).map((t) => ({ value: t.name, label: t.name }))}
              onChange={(v) => update({ issuetype: v, startAt: '0' })}
            />
            <FilterSelect
              value={status}
              placeholder="Status"
              ariaLabel="Filter by status"
              options={(statuses ?? []).map((s) => ({ value: s.name, label: s.name }))}
              onChange={(v) => update({ status: v, startAt: '0' })}
            />
            <FilterSelect
              value={assignee}
              placeholder="Assignee"
              ariaLabel="Filter by assignee"
              options={[
                { value: 'me', label: 'Me' },
                { value: 'EMPTY', label: 'Unassigned' },
                ...(assignable ?? []).map((u) => ({ value: u.accountId, label: u.displayName })),
              ]}
              onChange={(v) => update({ assignee: v, startAt: '0' })}
            />
            <FilterSelect
              value={priority}
              placeholder="Priority"
              ariaLabel="Filter by priority"
              options={(priorities ?? []).map((p) => ({ value: p.name, label: p.name }))}
              onChange={(v) => update({ priority: v, startAt: '0' })}
            />
            {(extraChips.has('resolution') || resolution) && (
              <FilterSelect
                value={resolution}
                placeholder="Resolution"
                ariaLabel="Filter by resolution"
                options={[
                  { value: 'EMPTY', label: 'Unresolved' },
                  ...(resolutions ?? []).map((r) => ({ value: r.name, label: r.name })),
                ]}
                onChange={(v) => update({ resolution: v, startAt: '0' })}
              />
            )}
            {(extraChips.has('labels') || labels) && (
              <>
                <input
                  type="text"
                  list="tf-nav-labels"
                  placeholder="Label"
                  aria-label="Filter by label"
                  defaultValue={labels}
                  key={labels}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !imeComposing(e)) update({ labels: (e.target as HTMLInputElement).value, startAt: '0' });
                  }}
                  onBlur={(e) => {
                    if (e.target.value !== labels) update({ labels: e.target.value, startAt: '0' });
                  }}
                  className="w-28 h-8 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-600 focus:border-atl-b-300 outline-none"
                />
                <datalist id="tf-nav-labels">
                  {(labelValues ?? []).map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </>
            )}
            {(!extraChips.has('resolution') && !resolution) || (!extraChips.has('labels') && !labels) ? (
              <div className="relative">
                <button
                  onClick={() => setMoreOpen((o) => !o)}
                  className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20 inline-flex items-center gap-1"
                >
                  More
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                      d="M1.5 3.5 5 7l3.5-3.5"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      fill="none"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
                {moreOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
                    <div className="absolute left-0 top-9 z-40 w-44 bg-atl-paper border border-atl-n-30 rounded shadow-lg py-1.5">
                      {!extraChips.has('resolution') && !resolution && (
                        <button
                          className="block w-full text-left px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10"
                          onClick={() => {
                            setExtraChips((s) => new Set(s).add('resolution'));
                            setMoreOpen(false);
                          }}
                        >
                          Resolution
                        </button>
                      )}
                      {!extraChips.has('labels') && !labels && (
                        <button
                          className="block w-full text-left px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10"
                          onClick={() => {
                            setExtraChips((s) => new Set(s).add('labels'));
                            setMoreOpen(false);
                          }}
                        >
                          Labels
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : null}
            <button
              onClick={switchToJql}
              className="ml-auto h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20"
            >
              JQL
            </button>
          </div>
        )}
        {basicHint && (
          <p className="mt-2 text-xs text-atl-y-600 bg-atl-y-50 border border-atl-y-200 rounded px-3 py-1.5">
            {basicHint}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-atl-n-200">
          {data ? `${total.toLocaleString()} issue${total === 1 ? '' : 's'}` : ''}
        </span>
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setViewsOpen((o) => !o)}
              className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20 inline-flex items-center gap-1"
              aria-label="Views"
              aria-expanded={viewsOpen}
            >
              Views
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M1.5 3.5 5 7l3.5-3.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {viewsOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setViewsOpen(false)} />
                <div className="absolute right-0 top-9 z-40 w-40 bg-atl-paper border border-atl-n-30 rounded shadow-lg py-1.5">
                  {(
                    [
                      { id: 'list', label: 'List view' },
                      { id: 'detail', label: 'Detail view' },
                    ] as const
                  ).map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-atl-n-10 ${
                        viewMode === v.id ? 'text-atl-b-500 font-medium' : 'text-atl-n-700'
                      }`}
                      onClick={() => {
                        setViewsOpen(false);
                        update(v.id === 'detail' ? { view: 'detail' } : { view: '', issue: '' });
                      }}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="relative">
            <button
              onClick={() => setExportOpen((o) => !o)}
              className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20 inline-flex items-center gap-1"
              aria-label="Export"
            >
              Export
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M1.5 3.5 5 7l3.5-3.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setExportOpen(false)} />
                <div className="absolute right-0 top-9 z-40 w-48 bg-atl-paper border border-atl-n-30 rounded shadow-lg py-1.5">
                  <a
                    className="block px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10"
                    href={exportIssuesUrl({ jql: searchJql, format: 'csv', columns })}
                    onClick={() => setExportOpen(false)}
                  >
                    CSV (Excel-friendly)
                  </a>
                  <a
                    className="block px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10"
                    href={exportIssuesUrl({ jql: searchJql, format: 'print', columns })}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setExportOpen(false)}
                  >
                    Printable view
                  </a>
                </div>
              </>
            )}
          </div>
          <ColumnChooser
            columns={columns}
            onChange={(c) =>
              putPreference('issueTable.columns', c).then(() => queryClient.invalidateQueries({ queryKey: ['preferences'] }))
            }
          />
        </div>
      </div>

      {selectionActive && (
        <div className="mb-2 flex items-center gap-3 rounded bg-atl-b-50 border border-atl-b-100 px-3 py-2">
          <span className="text-sm font-medium text-atl-b-500">
            {selectAllJql ? `All ${total} matching` : `${selected.size} selected`}
          </span>
          {!selectAllJql && selected.size < total && (
            <button onClick={() => setSelectAllJql(true)} className="text-sm text-atl-b-300 hover:underline">
              Select all {total} matching this search
            </button>
          )}
          <button
            onClick={() => setWizardOpen(true)}
            className="h-7 px-3 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white"
          >
            Bulk change
          </button>
          <button onClick={clearSelection} className="text-sm text-atl-n-400 hover:underline ml-auto">
            Clear
          </button>
        </div>
      )}

      {/* 033 US4 — quick toggles + group-by + subtask nesting (persisted per user) */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {Object.entries(QUICK_TOGGLES).map(([id, t]) => {
          const on = activeToggles.includes(id);
          return (
            <button
              key={id}
              onClick={() => {
                const next = on ? activeToggles.filter((x) => x !== id) : [...activeToggles, id];
                update({ qt: next.join(','), startAt: '0' });
              }}
              title={t.clause}
              className={`rounded-[10px] px-2.5 py-0.5 text-xs font-medium border ${
                on
                  ? 'bg-atl-b-400 border-atl-b-400 text-white'
                  : 'bg-atl-paper border-atl-n-40 text-atl-n-500 hover:border-atl-b-300 hover:text-atl-b-400'
              }`}
            >
              {t.label}
            </button>
          );
        })}
        <span className="ml-3 flex items-center gap-1.5 text-xs text-atl-n-200">
          Group:
          <select
            value={groupBy}
            onChange={(e) => {
              update({ group: e.target.value || '' });
              saveViewPref('issueTable.groupBy', e.target.value || null);
            }}
            className="h-7 px-1.5 rounded-[3px] border border-atl-n-40 text-sm text-atl-n-600 bg-atl-paper"
            aria-label="Group by"
          >
            <option value="">None</option>
            <option value="status">Status</option>
            <option value="assignee">Assignee</option>
            <option value="priority">Priority</option>
            <option value="issuetype">Issue type</option>
            <option value="epic">Epic</option>
          </select>
        </span>
        <button
          onClick={() => {
            update({ st: subNest ? '' : '1' });
            saveViewPref('issueTable.subtaskNest', !subNest);
          }}
          className={`ml-1 rounded-[3px] px-2 py-1 text-xs font-medium border ${
            subNest ? 'bg-atl-b-50 border-atl-b-300 text-atl-b-400' : 'border-atl-n-40 text-atl-n-500 hover:bg-atl-n-20'
          }`}
          title="Nest subtasks under their parents"
        >
          Subtasks: {subNest ? 'nested' : 'flat'}
        </button>
      </div>

      {isLoading && <p className="text-sm text-atl-n-200 py-6">Loading issues…</p>}
      {error && <p className="text-sm text-atl-r-400 py-6">{(error as Error).message || 'Search failed.'}</p>}

      {!isLoading && !error && issues.length === 0 && (
        <div className="border border-dashed border-atl-n-40 rounded">
          <EmptyState
            title="No issues found"
            description="Try adjusting your search or filters — or create a new issue to get started."
          />
        </div>
      )}

      {issues.length > 0 && viewMode === 'list' && (
        <>
          <IssueTable
            issues={displayIssues}
            columns={columns}
            sortField={sortField}
            sortDir={dir}
            onSort={toggleSort}
            selected={selected}
            onToggle={toggleOne}
            onToggleAll={togglePage}
            /* Jira navigator default: a plain row click opens the issue in the
               detail pane (view=detail); only the key/summary links go to /browse. */
            onSelect={(key) => update({ view: 'detail', issue: key })}
            groupLabel={groupFn}
            indentKeys={indentKeys}
          />
          <div className="flex items-center justify-between mt-3 text-sm text-atl-n-300">
            <span>
              {pageStart}–{pageEnd} of {total}
            </span>
            <div className="flex items-center gap-2">
              <select
                className="h-7 px-1.5 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper"
                value={maxResults}
                onChange={(e) => update({ maxResults: e.target.value, startAt: '0' })}
                aria-label="Page size"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
              <button
                className="h-7 px-2.5 rounded-[3px] border border-atl-n-40 disabled:opacity-40 hover:bg-atl-n-20"
                disabled={startAt === 0}
                onClick={() => update({ startAt: String(Math.max(0, startAt - maxResults)) })}
              >
                Previous
              </button>
              <button
                className="h-7 px-2.5 rounded-[3px] border border-atl-n-40 disabled:opacity-40 hover:bg-atl-n-20"
                disabled={pageEnd >= total}
                onClick={() => update({ startAt: String(startAt + maxResults) })}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {/* Jira detail view: compact list on the left, the selected issue rendered
          full-fidelity on the right — the view is viewport-bounded so both
          columns scroll independently. The issue key still links to /browse. */}
      {issues.length > 0 && viewMode === 'detail' && (
        <div className="flex-1 min-h-0 flex items-stretch border border-atl-n-30 rounded">
          <div className="w-[400px] shrink-0 border-r border-atl-n-30 flex flex-col min-h-0">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <CompactIssueList
                issues={displayIssues}
                activeKey={detailKey}
                onSelect={(key) => update({ issue: key })}
                selected={selected}
                onToggle={toggleOne}
                groupLabel={groupFn}
                indentKeys={indentKeys}
              />
            </div>
            <div className="shrink-0 border-t border-atl-n-30 px-3 py-1.5 flex items-center justify-between text-sm text-atl-n-300">
              <span>
                {pageStart}–{pageEnd} of {total}
              </span>
              <div className="flex items-center gap-1">
                <button
                  className="h-7 px-2 rounded-[3px] border border-atl-n-40 disabled:opacity-40 hover:bg-atl-n-20"
                  disabled={startAt === 0}
                  onClick={() => update({ startAt: String(Math.max(0, startAt - maxResults)) })}
                  aria-label="Previous page"
                >
                  ‹
                </button>
                <button
                  className="h-7 px-2 rounded-[3px] border border-atl-n-40 disabled:opacity-40 hover:bg-atl-n-20"
                  disabled={pageEnd >= total}
                  onClick={() => update({ startAt: String(startAt + maxResults) })}
                  aria-label="Next page"
                >
                  ›
                </button>
              </div>
            </div>
          </div>
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {detailKey && <IssueDetailView issueKey={detailKey} pane />}
          </div>
        </div>
      )}

      <CreateIssueDialog open={createOpen} onClose={() => setCreateOpen(false)} defaultProjectKey={fixedProjectKey} />
      <BulkWizard
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          clearSelection();
        }}
        issueKeys={[...selected]}
        jql={selectAllJql ? searchJql : undefined}
      />
      <SaveFilterModal
        open={saveOpen}
        jql={jql}
        existing={loadedFilter ?? null}
        onClose={() => setSaveOpen(false)}
        onSaved={(f) => update({ filterId: f.id, jql: f.jql, mode: 'jql' })}
      />
    </div>
  );
}

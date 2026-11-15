import { Fragment, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useListCursor } from '../hooks/useListCursor.js';
import { fetchIssue, type Issue } from '../api/client.js';
import IssueTypeIcon from './IssueTypeIcon.js';
import { IssueKeyLink } from './IssueKey.js';
import PriorityIcon from './PriorityIcon.js';
import StatusTransitionMenu from './StatusTransitionMenu.js';
import AssigneePicker from './AssigneePicker.js';
import UserAvatar from './UserAvatar.js';
import UserHoverCard from './UserHoverCard.js';
import { formatDate, formatDateTime } from '../lib/format.js';

const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-atl-n-200';

export type SortDir = 'asc' | 'desc';

export interface ColumnDef {
  id: string;
  label: string;
  /** Tooltip on the th — for cryptic labels like 'T' or extra context. */
  headerTitle?: string;
  /** JQL field usable in ORDER BY (undefined = not sortable) */
  orderField?: string;
  className?: string;
  /** Extra classes on the td — needed for width tricks like max-w-0 */
  cellClassName?: string;
  render: (issue: Issue) => React.ReactNode;
  title?: (issue: Issue) => string | undefined;
}

export const COLUMN_DEFS: Record<string, ColumnDef> = {
  issuetype: {
    id: 'issuetype',
    label: 'T',
    headerTitle: 'Issue type',
    orderField: 'issuetype',
    className: 'w-10',
    render: (i) => <IssueTypeIcon name={i.fields.issuetype.name} hierarchyLevel={i.fields.issuetype.hierarchyLevel} />,
    title: (i) => i.fields.issuetype.name,
  },
  key: {
    id: 'key',
    label: 'Key',
    orderField: 'key',
    className: 'w-28',
    cellClassName: 'overflow-hidden',
    title: (i) => i.key,
    render: (i) => (
      <IssueKeyLink
        issueKey={i.key}
        issue={i}
        categoryKey={i.fields.status.statusCategory.key}
        className="text-atl-b-300 hover:underline whitespace-nowrap"
      />
    ),
  },
  summary: {
    id: 'summary',
    label: 'Summary',
    orderField: 'summary',
    // Expand to the free space but cap at it — the constraint must live on
    // the cell, not the link, or the summary collapses to zero width.
    cellClassName: 'w-full max-w-0',
    render: (i) => (
      <Link
        to={`/browse/${i.key}`}
        data-tf-summary
        className="text-atl-n-800 hover:text-atl-b-300 hover:underline truncate block"
        title={i.fields.summary}
      >
        {i.fields.summary}
      </Link>
    ),
  },
  status: {
    id: 'status',
    label: 'Status',
    orderField: 'status',
    className: 'w-32',
    render: (i) => (
      <StatusTransitionMenu
        issueKey={i.key}
        projectKey={i.fields.project.key}
        statusName={i.fields.status.name}
        statusCategoryKey={i.fields.status.statusCategory.key}
      />
    ),
  },
  priority: {
    id: 'priority',
    label: 'Priority',
    orderField: 'priority',
    className: 'w-24',
    render: (i) => <PriorityIcon name={i.fields.priority.name} />,
    title: (i) => i.fields.priority.name,
  },
  assignee: {
    id: 'assignee',
    label: 'Assignee',
    orderField: 'assignee',
    className: 'w-40',
    cellClassName: 'overflow-hidden',
    title: (i) => i.fields.assignee?.displayName ?? 'Unassigned',
    render: (i) => <AssigneePicker issueKey={i.key} projectKey={i.fields.project.key} assignee={i.fields.assignee} />,
  },
  reporter: {
    id: 'reporter',
    label: 'Reporter',
    className: 'w-40',
    // td-level clip: the flex chain alone can't stop a long name painting
    // over the next column (overflow visible on td by default).
    cellClassName: 'overflow-hidden',
    // Person card owns the reveal when we can fetch a profile; the td title
    // stays as fallback for refs that carry no accountId.
    title: (i) => (i.fields.reporter?.accountId ? undefined : i.fields.reporter?.displayName),
    render: (i) =>
      i.fields.reporter ? (
        <UserHoverCard user={i.fields.reporter}>
          <span className="flex items-center gap-2 min-w-0 text-atl-n-500">
            <UserAvatar displayName={i.fields.reporter.displayName} size={20} />
            <span className="truncate">{i.fields.reporter.displayName}</span>
          </span>
        </UserHoverCard>
      ) : (
        <span className="text-atl-n-100 italic">None</span>
      ),
  },
  created: {
    id: 'created',
    label: 'Created',
    orderField: 'created',
    className: 'w-28',
    render: (i) => <span className="text-atl-n-200 whitespace-nowrap">{formatDate(i.fields.created)}</span>,
    title: (i) => formatDateTime(i.fields.created),
  },
  updated: {
    id: 'updated',
    label: 'Updated',
    orderField: 'updated',
    className: 'w-28',
    render: (i) => <span className="text-atl-n-200 whitespace-nowrap">{formatDate(i.fields.updated)}</span>,
    title: (i) => formatDateTime(i.fields.updated),
  },
  duedate: {
    id: 'duedate',
    label: 'Due',
    orderField: 'duedate',
    className: 'w-28',
    title: (i) => (i.fields.duedate ? `Due ${formatDate(i.fields.duedate)}` : undefined),
    render: (i) => (
      <span className="text-atl-n-200 whitespace-nowrap">{i.fields.duedate ? formatDate(i.fields.duedate) : '—'}</span>
    ),
  },
  resolution: {
    id: 'resolution',
    label: 'Resolution',
    orderField: 'resolution',
    className: 'w-28',
    title: (i) => i.fields.resolution?.name,
    render: (i) => <span className="text-atl-n-400 truncate block">{i.fields.resolution?.name ?? '—'}</span>,
  },
  labels: {
    id: 'labels',
    label: 'Labels',
    className: 'w-40',
    cellClassName: 'overflow-hidden',
    title: (i) => (i.fields.labels?.length ? i.fields.labels.join(', ') : undefined),
    render: (i) => (
      <span className="flex flex-wrap gap-1">
        {(i.fields.labels ?? []).map((l) => (
          <span key={l} className="px-1.5 rounded bg-atl-n-20 text-xs text-atl-n-500">
            {l}
          </span>
        ))}
      </span>
    ),
  },
  project: {
    id: 'project',
    label: 'Project',
    orderField: 'project',
    className: 'w-24',
    title: (i) => `${i.fields.project.name} (${i.fields.project.key})`,
    render: (i) => <span className="text-atl-n-400">{i.fields.project.key}</span>,
  },
};

export const DEFAULT_COLUMNS = [
  'issuetype',
  'key',
  'summary',
  'status',
  'assignee',
  'duedate',
  'priority',
  'reporter',
  'updated',
];

export default function IssueTable({
  issues,
  columns = DEFAULT_COLUMNS,
  sortField,
  sortDir,
  onSort,
  selected,
  onToggle,
  onToggleAll,
  onSelect,
  groupLabel,
  indentKeys,
}: {
  issues: Issue[];
  columns?: string[];
  sortField?: string;
  sortDir?: SortDir;
  onSort?: (orderField: string) => void;
  /** 023 bulk selection — when provided, renders the checkbox column. */
  selected?: Set<string>;
  onToggle?: (key: string, on: boolean) => void;
  onToggleAll?: (on: boolean) => void;
  /** When set, a plain row click (and j/k+Enter) fires this instead of
      navigating to /browse — used to open the navigator's detail pane. */
  onSelect?: (key: string) => void;
  /** 033 — when set, inserts a group-header row whenever the label changes
   *  (issues must already be ordered so same-group rows are contiguous). */
  groupLabel?: (issue: Issue) => string;
  /** 033 — keys rendered indented (subtask nesting). */
  indentKeys?: Set<string>;
}) {
  const defs = columns.map((c) => COLUMN_DEFS[c]).filter(Boolean);
  const allOn = selected !== undefined && issues.length > 0 && issues.every((i) => selected.has(i.key));
  const colCount = defs.length + (selected !== undefined ? 1 : 0);
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Hover/focus intent warms the issue cache — detail pane and /browse both
  // read ['issue', key], so the open feels instant.
  const prefetchIssue = (key: string) =>
    void qc.prefetchQuery({ queryKey: ['issue', key], queryFn: () => fetchIssue(key), staleTime: 30_000 });
  const openAt = useCallback(
    (i: number) => {
      const it = issues[i];
      if (!it) return;
      if (onSelect) onSelect(it.key);
      else navigate(`/browse/${it.key}`);
    },
    [issues, navigate, onSelect]
  );
  const cursor = useListCursor(issues.length, openAt);
  // scrollIntoView only when the cursor actually moved — a refetch re-render
  // used to yank the table back to the cursor row every poll.
  const lastScrolled = useRef<number | null>(null);
  let lastGroup: string | undefined;
  return (
    <div tabIndex={0} role="region" aria-label="Issues table" className="border border-atl-n-30 rounded overflow-x-auto">
      <table className="w-full text-sm table-fixed">
        <thead>
          <tr className="bg-atl-n-10 border-b border-atl-n-30">
            {selected !== undefined && (
              <th className={`${TH} w-8`}>
                <input
                  type="checkbox"
                  checked={allOn}
                  onChange={(e) => onToggleAll?.(e.target.checked)}
                  aria-label="Select all on page"
                />
              </th>
            )}
            {defs.map((col) => {
              const active = col.orderField && sortField === col.orderField;
              const arrow = active && (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  {sortDir === 'asc' ? (
                    <path d="M5 2 8.5 7h-7z" fill="currentColor" />
                  ) : (
                    <path d="M5 8 1.5 3h7z" fill="currentColor" />
                  )}
                </svg>
              );
              return (
                <th
                  key={col.id}
                  className={`${TH} ${col.className ?? ''}`}
                  aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  title={
                    col.orderField && onSort
                      ? `Sort by ${col.headerTitle ?? col.label}`
                      : col.headerTitle
                  }
                >
                  {col.orderField && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(col.orderField!)}
                      className="inline-flex items-center gap-1 -mx-1 px-1 rounded select-none hover:text-atl-n-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-atl-b-300 uppercase tracking-wider font-semibold"
                    >
                      {col.label}
                      {arrow}
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {arrow}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, idx) => {
            const gl = groupLabel?.(issue);
            const header =
              groupLabel && gl !== lastGroup ? (
                <tr key={`__group-${gl}`} className="bg-atl-n-10 border-b border-atl-n-30">
                  <td
                    colSpan={colCount}
                    className="px-3 py-1.5 text-xs font-semibold text-atl-n-500 uppercase tracking-wide"
                  >
                    {gl}
                  </td>
                </tr>
              ) : null;
            lastGroup = gl;
            const indent = indentKeys?.has(issue.key);
            const isCursor = cursor === idx;
            return (
              <Fragment key={issue.id}>
                {header}
                <tr
                  ref={isCursor ? (el) => {
                    if (el && lastScrolled.current !== idx) {
                      lastScrolled.current = idx;
                      el.scrollIntoView({ block: 'nearest' });
                    }
                  } : undefined}
                  aria-selected={isCursor || undefined}
                  onMouseEnter={() => prefetchIssue(issue.key)}
                  onFocusCapture={() => prefetchIssue(issue.key)}
                  onClickCapture={(e) => {
                    // Jira navigator: clicking the summary opens the detail pane
                    // too (not /browse) — intercept in capture so router never
                    // sees it. Ctrl/cmd/shift+click still opens the full page.
                    if (!onSelect || e.ctrlKey || e.metaKey || e.shiftKey) return;
                    const link = (e.target as HTMLElement).closest('a[data-tf-summary]');
                    if (!link) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onSelect(issue.key);
                  }}
                  onClick={(e) => {
                    if (!onSelect) return;
                    // Interactive cells handle their own clicks (links, menus,
                    // pickers, checkboxes) — a plain row click selects the issue.
                    if (
                      (e.target as HTMLElement).closest(
                        'a,button,input,select,textarea,[role="menu"],[role="listbox"],[role="option"]'
                      )
                    )
                      return;
                    onSelect(issue.key);
                  }}
                  className={`border-b border-atl-n-30 last:border-0 hover:bg-atl-n-10 ${onSelect ? 'cursor-pointer' : ''} ${selected?.has(issue.key) || isCursor ? 'bg-atl-b-50' : ''} ${isCursor ? 'outline outline-1 -outline-offset-1 outline-atl-b-300' : ''}`}
                >
                  {selected !== undefined && (
                    <td className="px-3 py-2 w-8">
                      <input
                        type="checkbox"
                        checked={selected.has(issue.key)}
                        onChange={(e) => onToggle?.(issue.key, e.target.checked)}
                        aria-label={`Select ${issue.key}`}
                      />
                    </td>
                  )}
                  {defs.map((col, ci) => (
                    <td
                      key={col.id}
                      className={`px-3 py-2 ${col.cellClassName ?? ''} ${indent && ci === 0 ? 'border-l-4 border-atl-n-40 pl-6' : ''}`}
                      title={col.title?.(issue)}
                    >
                      {col.render(issue)}
                    </td>
                  ))}
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

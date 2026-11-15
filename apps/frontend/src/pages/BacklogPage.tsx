import { memo, useEffect, useMemo, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  ApiError,
  assignIssue,
  fetchAgentActivity,
  cloneIssue,
  createIssue,
  createSprint,
  deleteSprint,
  fetchBacklog,
  fetchBoard,
  fetchIssue,
  fetchMyself,
  fetchProject,
  fetchQuickFilters,
  fetchSprintIssues,
  fetchSprints,
  moveIssuesToBacklog,
  moveIssuesToSprint,
  rankIssues,
  searchIssues,
  suggestSprintScope,
  updateIssueFields,
  updateSprint,
  type AgentActivity,
  type Issue,
  type Sprint,
  type SprintScopeSuggestion,
} from '../api/client.js';
import { usePermissions } from '../hooks/usePermissions.js';
import IssueTypeIcon from '../components/IssueTypeIcon.js';
import IssueKey, { IssueKeyLink } from '../components/IssueKey.js';
import PriorityIcon from '../components/PriorityIcon.js';
import StatusLozenge from '../components/StatusLozenge.js';
import UserAvatar from '../components/UserAvatar.js';
import Modal from '../components/Modal.js';
import IssueDrawer from '../components/IssueDrawer.js';
import AgentBadge from '../components/AgentBadge.js';
import { patchIssueLists, reorderKeys } from '../lib/optimistic.js';
import { parseDate } from '../lib/format.js';
import PageHeader from '../components/PageHeader.js';
import CompleteSprintDialog from '../components/CompleteSprintDialog.js';
import { CloseIcon, SparkleIcon } from '../components/icons.js';
import { imeComposing } from '../lib/ime.js';

const ACTION_BTN =
  'h-8 px-3 rounded-[3px] bg-atl-n-30 hover:bg-atl-n-40 text-sm font-medium text-atl-n-600';
const PRIMARY_BTN =
  'h-8 px-3 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white';

/** Click-to-edit story points chip. */
function PointsChip({ issue, onSave, disabled = false }: { issue: Issue; onSave: (v: number | null) => void; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const pts = issue.fields.story_points;
  if (disabled) {
    return (
      <span
        title="Story points"
        className="w-6 h-5 rounded-full bg-atl-n-30 text-[11px] font-semibold text-atl-n-600 shrink-0 flex items-center justify-center"
      >
        {pts ?? '–'}
      </span>
    );
  }
  if (!editing) {
    return (
      <button
        title="Story points — click to estimate"
        onClick={(e) => {
          e.stopPropagation();
          setValue(pts == null ? '' : String(pts));
          setEditing(true);
        }}
        className="w-6 h-5 rounded-full bg-atl-n-30 hover:bg-atl-b-100 text-[11px] font-semibold text-atl-n-600 shrink-0 flex items-center justify-center"
      >
        {pts ?? '–'}
      </button>
    );
  }
  return (
    <input
      autoFocus
      type="number"
      min={0}
      step={0.5}
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const n = value.trim() === '' ? null : Number(value);
        if (n !== (pts ?? null)) onSave(n);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !imeComposing(e)) (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setEditing(false);
      }}
      className="w-12 h-5 rounded-full border border-atl-b-300 text-[11px] text-center outline-none"
    />
  );
}

type BacklogRowProps = {
  issue: Issue;
  dragging: boolean;
  draggable?: boolean;
  canEdit?: boolean;
  selected: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onSavePoints: (v: number | null) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onOpen: (key: string) => void;
  agentActivity?: AgentActivity;
  epicTypeIds?: Set<string>;
};

const BacklogRow = memo(function BacklogRow({
  issue,
  dragging,
  draggable = true,
  canEdit = true,
  selected,
  onToggleSelect,
  onDragStart,
  onDragEnd,
  onSavePoints,
  onContextMenu,
  onOpen,
  agentActivity,
  epicTypeIds,
}: BacklogRowProps) {
  const qc = useQueryClient();
  // Hover/focus intent warms the ['issue', key] cache — the drawer opens
  // instantly; render-defer keeps long backlogs cheap to paint.
  const prefetchIssue = () =>
    void qc.prefetchQuery({ queryKey: ['issue', issue.key], queryFn: () => fetchIssue(issue.key), staleTime: 30_000 });
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(issue.key)}
      onContextMenu={onContextMenu}
      onMouseEnter={prefetchIssue}
      onFocusCapture={prefetchIssue}
      style={{ '--defer-h': '40px' } as CSSProperties}
      className={`render-defer flex items-center gap-3 px-3 py-1.5 border-t border-atl-n-30 cursor-pointer select-none ${
        selected ? 'bg-atl-b-50' : 'bg-atl-paper hover:bg-atl-n-10'
      } ${dragging ? 'opacity-50' : ''}`}
    >
      <input
        type="checkbox"
        checked={selected}
        readOnly
        aria-label={`Select ${issue.key}`}
        className="shrink-0 accent-atl-b-400"
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(e);
        }}
      />
      <span className="inline-flex" title={issue.fields.issuetype.name}>
        <IssueTypeIcon name={issue.fields.issuetype.name} hierarchyLevel={issue.fields.issuetype.hierarchyLevel} />
      </span>
      <IssueKeyLink
        issueKey={issue.key}
        issue={issue}
        categoryKey={issue.fields.status.statusCategory.key}
        onClick={(e) => e.stopPropagation()}
        className="text-atl-b-300 hover:underline text-xs font-medium w-20 shrink-0"
      />
      <Link
        to={`/browse/${issue.key}`}
        onClick={(e) => {
          e.stopPropagation();
          // 058 US1 — plain click opens the drawer; Ctrl/Cmd/middle keeps /browse.
          if (!e.ctrlKey && !e.metaKey && e.button === 0) {
            e.preventDefault();
            onOpen(issue.key);
          }
        }}
        className="flex-1 min-w-0 truncate text-sm text-atl-n-800 hover:text-atl-b-300 hover:underline"
        title={issue.fields.summary}
      >
        {issue.fields.summary}
      </Link>
      {issue.fields.parent?.fields.issuetype && epicTypeIds?.has(issue.fields.parent.fields.issuetype.id) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(issue.fields.parent!.key);
          }}
          className="shrink-0 rounded-[3px] bg-atl-p-50 px-1.5 py-0.5 text-[11px] font-medium text-atl-p-300 max-w-[140px] truncate hover:bg-atl-p-200 hover:text-atl-p-700"
          title={`Open epic ${issue.fields.parent.key}: ${issue.fields.parent.fields.summary}`}
        >
          {issue.fields.parent.fields.summary}
        </button>
      )}
      <StatusLozenge name={issue.fields.status.name} categoryKey={issue.fields.status.statusCategory.key} />
      <AgentBadge issueKey={issue.key} activity={agentActivity} />
      <span className="inline-flex" title={`Priority: ${issue.fields.priority.name}`}>
        <PriorityIcon name={issue.fields.priority.name} />
      </span>
      <PointsChip issue={issue} onSave={onSavePoints} disabled={!canEdit} />
      <UserAvatar displayName={issue.fields.assignee?.displayName} size={20} />
    </div>
  );
}, (prev, next) =>
  // Handler props are inline closures at the call sites (fresh refs per
  // render) but only capture `issue` (compared) + stable setters/mutations —
  // ignoring them lets unchanged rows skip re-render on selection/drag churn.
  prev.issue === next.issue &&
  prev.dragging === next.dragging &&
  prev.draggable === next.draggable &&
  prev.canEdit === next.canEdit &&
  prev.selected === next.selected &&
  prev.agentActivity === next.agentActivity &&
  prev.epicTypeIds === next.epicTypeIds
);

function Group({
  title,
  meta,
  action,
  emptyText,
  over,
  onDragOver,
  onDragLeave,
  onDropCard,
  children,
  headerExtra,
  collapsible,
  defaultCollapsed,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
  headerExtra?: ReactNode;
  emptyText: string;
  over?: boolean;
  onDragOver?: (e: DragEvent) => void;
  onDragLeave?: () => void;
  onDropCard?: () => void;
  children: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [open, setOpen] = useState(!defaultCollapsed);
  const hasRows = Boolean(children && (Array.isArray(children) ? children.length : true));
  return (
    <section
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDropCard}
      className={`rounded-lg border ${over ? 'border-atl-b-200 bg-atl-b-50/50' : 'border-atl-n-30'}`}
    >
      <header className="flex items-center justify-between px-3 py-2 gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          {collapsible && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="text-atl-n-200 hover:text-atl-n-500 shrink-0"
              title={open ? 'Collapse' : 'Expand'}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" className={open ? '' : '-rotate-90'}>
                <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <h2 className="text-sm font-semibold text-atl-n-800 truncate" title={title}>{title}</h2>
          {meta && <span className="text-xs text-atl-n-100 truncate min-w-0" title={meta}>{meta}</span>}
          {headerExtra}
        </div>
        <div className="flex items-center gap-2 shrink-0">{action}</div>
      </header>
      {open &&
        (hasRows ? (
          children
        ) : (
          <div className="px-3 py-6 text-center text-sm text-atl-n-100 border-t border-atl-n-30">
            {emptyText}
          </div>
        ))}
    </section>
  );
}

export default function BacklogPage() {
  const [, setSearchParams] = useSearchParams();
  const { projectKey } = useParams<{ projectKey: string }>();
  const queryClient = useQueryClient();
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [overGroup, setOverGroup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  // Which group's "+ Create issue" row is open: 'backlog' or a sprint id.
  const [inlineCreate, setInlineCreate] = useState<string | false>(false);
  const [inlineSummary, setInlineSummary] = useState('');
  const [editingSprint, setEditingSprint] = useState<Sprint | null>(null);
  const [completingSprint, setCompletingSprint] = useState<Sprint | null>(null);
  const [startingSprint, setStartingSprint] = useState<Sprint | null>(null);
  const [suggestion, setSuggestion] = useState<SprintScopeSuggestion | null>(null);
  // UB-013 — Jira epic rail: toggleable left panel, drag rows onto an epic to
  // set its parent, click an epic to filter the backlog to its children.
  const [epicsOpen, setEpicsOpen] = useState(false);
  const [epicFilter, setEpicFilter] = useState<string | null>(null);
  // Toolbar text filter — matches issue key or summary (Jira backlog search).
  const [search, setSearch] = useState('');
  // Quick filters (Jira backlog): status-category chips + assignee picker +
  // board-configured JQL chips — one row, one meaning (062 US3).
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'indeterminate' | 'done'>('all');
  const [assigneeFilter, setAssigneeFilter] = useState('all'); // 'all' | 'me' | 'unassigned' | accountId
  const [activeQf, setActiveQf] = useState<string[]>([]); // board quick-filter ids

  const { data: board } = useQuery({
    queryKey: ['board', projectKey],
    queryFn: () => fetchBoard(projectKey!),
    enabled: Boolean(projectKey),
  });
  // 058 US5 — one-shot agent-presence map for all rows; SSE keeps it fresh.
  const { data: agentActivity } = useQuery({
    queryKey: ['agent-activity', projectKey],
    queryFn: () => fetchAgentActivity(projectKey!),
    enabled: Boolean(projectKey),
  });
  const { data: sprints } = useQuery({
    queryKey: ['sprints', projectKey],
    queryFn: () => fetchSprints(projectKey!, ['active', 'future']),
    enabled: Boolean(projectKey),
  });
  // Closed sprints are neither rendered nor fetched (no N+1 per closed sprint).
  const openSprints = (sprints ?? []).filter((s) => s.state !== 'closed');
  const [backlogLimit, setBacklogLimit] = useState(200);
  // 062 US3 — the same board-configured chips the Board page shows; they
  // filter server-side here (backlog + sprint sections alike).
  const { data: quickFilters } = useQuery({
    queryKey: ['quickfilters', board?.id],
    queryFn: () => fetchQuickFilters(board!.id),
    enabled: Boolean(board?.id),
  });
  const { data: backlogPage, isLoading, isFetching } = useQuery({
    queryKey: ['backlog', board?.id, backlogLimit, activeQf],
    queryFn: () => fetchBacklog(board!.id, 0, backlogLimit, activeQf),
    // 062 US5 — the agile backlog endpoint is scrum-only; a kanban board hit
    // it on every mount and ate a guaranteed 400.
    enabled: Boolean(board?.id) && board?.type === 'scrum',
    retry: false,
    // Refetching a larger window keeps the already-loaded rows in place.
    placeholderData: (prev) => prev,
  });
  const sprintIssueQueries = useQueries({
    queries: openSprints.map((s) => ({
      queryKey: ['sprint-issues', s.id, activeQf],
      queryFn: () => fetchSprintIssues(s.id, undefined, activeQf),
      enabled: board?.type === 'scrum',
    })),
  });

  function flashError(err: unknown) {
    setError(err instanceof ApiError ? err.message : 'Operation failed');
    setTimeout(() => setError(null), 4000);
  }

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['backlog', board?.id] });
    queryClient.invalidateQueries({ queryKey: ['sprints', projectKey] });
    queryClient.invalidateQueries({ queryKey: ['sprint-issues'] });
    queryClient.invalidateQueries({ queryKey: ['board-issues', projectKey] });
    queryClient.invalidateQueries({ queryKey: ['issues'] });
  }

  const selKeys = () => [...selected];
  // 058 US2 — every cached issue list participates in optimistic patches.
  const LIST_PREFIXES: QueryKey[] = [['backlog'], ['sprint-issues'], ['board-issues']];
  const allVisibleIssues = () => [
    ...backlogIssuesAll,
    ...openSprints.flatMap((s) => sprintIssues(s)),
  ];
  const moveToSprint = useMutation({
    mutationFn: ({ sprintId, keys }: { sprintId: string; keys: string[] }) =>
      moveIssuesToSprint(sprintId, keys),
    onMutate: ({ sprintId, keys }) => {
      const moved = allVisibleIssues().filter((i) => keys.includes(i.key));
      const rollback = patchIssueLists(queryClient, LIST_PREFIXES, (list) =>
        list.filter((i) => !keys.includes(i.key))
      );
      queryClient.setQueryData<{ issues: Issue[] }>(
        ['sprint-issues', sprintId],
        (old) => (old ? { ...old, issues: [...old.issues, ...moved] } : old)
      );
      return rollback;
    },
    onError: (err, _vars, rollback) => {
      rollback?.();
      flashError(err);
    },
    onSettled: () => {
      setSelected(new Set());
      invalidate();
    },
  });
  const moveToBacklog = useMutation({
    mutationFn: (keys: string[]) => moveIssuesToBacklog(keys),
    onMutate: (keys) => {
      const moved = allVisibleIssues().filter((i) => keys.includes(i.key));
      const rollback = patchIssueLists(queryClient, LIST_PREFIXES, (list) =>
        list.filter((i) => !keys.includes(i.key))
      );
      queryClient.setQueryData<{ issues: Issue[] }>(
        ['backlog', board?.id],
        (old) => (old ? { ...old, issues: [...old.issues, ...moved] } : old)
      );
      return rollback;
    },
    onError: (err, _vars, rollback) => {
      rollback?.();
      flashError(err);
    },
    onSettled: () => {
      setSelected(new Set());
      invalidate();
    },
  });
  const savePoints = useMutation({
    mutationFn: ({ key, points }: { key: string; points: number | null }) =>
      updateIssueFields(key, { story_points: points }),
    onMutate: ({ key, points }) =>
      patchIssueLists(queryClient, LIST_PREFIXES, (list) =>
        list.map((i) =>
          i.key === key ? { ...i, fields: { ...i.fields, story_points: points } } : i
        )
      ),
    onError: (err, _vars, rollback) => {
      rollback?.();
      flashError(err);
    },
    onSettled: invalidate,
  });
  const rank = useMutation({
    mutationFn: ({ keys, before, after }: { keys: string[]; before?: string; after?: string }) =>
      rankIssues(keys, { rankBeforeIssue: before, rankAfterIssue: after }),
    onMutate: ({ keys, before }) =>
      patchIssueLists(queryClient, LIST_PREFIXES, (list) =>
        reorderKeys(list, keys, before)
      ),
    onError: (err, _vars, rollback) => {
      rollback?.();
      flashError(err);
    },
    onSettled: invalidate,
  });
  const [createSprintOpen, setCreateSprintOpen] = useState(false);
  const suggestScope = useMutation({
    mutationFn: () => suggestSprintScope(board!.id, {}),
    onError: flashError,
    onSuccess: setSuggestion,
  });
  // 062 US4 — scope the inline-create types to the project's issue-type
  // scheme; the global /issuetype list carries ~100 imported legacy types.
  const { data: projectDetail } = useQuery({
    queryKey: ['project', projectKey],
    queryFn: () => fetchProject(projectKey!),
    enabled: Boolean(projectKey),
  });
  const issueTypes = projectDetail?.issueTypes;
  // Epic types are semantic (hierarchyLevel 1), never name-literal — imported
  // projects localize them ('Épica', 'Epic', …) so `issuetype = "Epic"` misses.
  const epicTypeIds = useMemo(
    () => new Set((issueTypes ?? []).filter((t) => t.hierarchyLevel === 1).map((t) => t.id)),
    [issueTypes]
  );
  const epicTypeNames = (issueTypes ?? []).filter((t) => t.hierarchyLevel === 1).map((t) => t.name);
  const [inlineType, setInlineType] = useState('Story');
  const inlineAdd = useMutation({
    mutationFn: async ({ summary, sprintId }: { summary: string; sprintId?: string }) => {
      const created = await createIssue({ projectKey: projectKey!, summary, issueTypeName: inlineType });
      if (sprintId) await moveIssuesToSprint(sprintId, [created.key]);
    },
    onError: flashError,
    onSuccess: () => {
      setInlineSummary('');
      setInlineCreate(false);
    },
    onSettled: invalidate,
  });

  const { data: epicResult } = useQuery({
    queryKey: ['epics', projectKey, epicTypeNames.join(',')],
    queryFn: () =>
      searchIssues(
        `project = "${projectKey}" AND issuetype in (${epicTypeNames
          .map((n) => `"${n.replace(/"/g, '\\"')}"`)
          .join(',')}) ORDER BY rank ASC`,
        { maxResults: 100 }
      ),
    enabled: Boolean(projectKey) && epicTypeNames.length > 0,
  });
  const epics = epicResult?.issues ?? [];
  const assignEpic = useMutation({
    mutationFn: ({ keys, epicKey }: { keys: string[]; epicKey: string | null }) =>
      Promise.all(keys.map((k) => updateIssueFields(k, { parent: epicKey ? { key: epicKey } : null }))),
    onError: flashError,
    onSettled: () => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['epics', projectKey] });
    },
  });
  const addEpic = useMutation({
    mutationFn: (name: string) =>
      createIssue({ projectKey: projectKey!, summary: name, issueTypeName: epicTypeNames[0] ?? 'Epic' }),
    onError: flashError,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['epics', projectKey] }),
  });

  const { data: me } = useQuery({
    queryKey: ['myself'],
    queryFn: fetchMyself,
    staleTime: Infinity,
  });
  const { can } = usePermissions({ projectKey }, [
    'SCHEDULE_ISSUES', 'EDIT_ISSUES', 'ASSIGN_ISSUES', 'CREATE_ISSUES',
  ]);
  const canSchedule = can('SCHEDULE_ISSUES');
  const canEdit = can('EDIT_ISSUES');
  const canAssign = can('ASSIGN_ISSUES');
  const canCreate = can('CREATE_ISSUES');
  const [ctxMenu, setCtxMenu] = useState<{ issue: Issue; x: number; y: number } | null>(null);
  const ctxAssign = useMutation({
    mutationFn: ({ keys, accountId }: { keys: string[]; accountId: string | null }) =>
      Promise.all(keys.map((k) => assignIssue(k, accountId))),
    onMutate: ({ keys, accountId }) =>
      patchIssueLists(queryClient, LIST_PREFIXES, (list) =>
        list.map((i) =>
          keys.includes(i.key)
            ? {
                ...i,
                fields: {
                  ...i.fields,
                  assignee:
                    accountId === null
                      ? null
                      : accountId === me?.accountId
                        ? me
                        : (allVisibleIssues()
                            .map((x) => x.fields.assignee)
                            .find((a) => a?.accountId === accountId) ??
                          ({ accountId, displayName: accountId } as Issue['fields']['assignee'])),
                },
              }
            : i
        )
      ),
    onError: (err, _vars, rollback) => {
      rollback?.();
      flashError(err);
    },
    onSettled: invalidate,
  });
  const ctxFlag = useMutation({
    mutationFn: ({ keys, on }: { keys: string[]; on: boolean }) =>
      Promise.all(
        keys.map((k) =>
          updateIssueFields(k, { customfield_10002: on ? [{ value: 'Impediment' }] : [] })
        )
      ),
    onMutate: ({ keys, on }) =>
      patchIssueLists(queryClient, LIST_PREFIXES, (list) =>
        list.map((i) =>
          keys.includes(i.key)
            ? {
                ...i,
                fields: {
                  ...i.fields,
                  customfield_10002: on ? [{ value: 'Impediment' }] : [],
                },
              }
            : i
        )
      ),
    onError: (err, _vars, rollback) => {
      rollback?.();
      flashError(err);
    },
    onSettled: invalidate,
  });
  const ctxClone = useMutation({
    mutationFn: (key: string) => cloneIssue(key, {}),
    onError: flashError,
    onSettled: invalidate,
  });

  const backlogIssuesAll = backlogPage?.issues ?? [];
  const needle = search.trim().toLowerCase();
  const matches = (i: Issue) => {
    if (needle && !i.key.toLowerCase().includes(needle) && !i.fields.summary.toLowerCase().includes(needle)) return false;
    const cat = i.fields.status.statusCategory.key;
    if (statusFilter === 'done' && cat !== 'done') return false;
    if (statusFilter === 'open' && cat === 'done') return false;
    if (statusFilter === 'indeterminate' && cat !== 'indeterminate') return false;
    if (assigneeFilter === 'me' && i.fields.assignee?.accountId !== me?.accountId) return false;
    else if (assigneeFilter === 'unassigned' && i.fields.assignee) return false;
    else if (assigneeFilter !== 'all' && assigneeFilter !== 'me' && assigneeFilter !== 'unassigned'
      && i.fields.assignee?.accountId !== assigneeFilter) return false;
    // 062 US1 — epic filter applies to sprint sections too, not just the backlog group.
    if (epicFilter && i.fields.parent?.key !== epicFilter) return false;
    return true;
  };
  const backlogIssues = backlogIssuesAll.filter(matches);
  // 062 US3 — local filters (search/status/assignee/epic) shrink the loaded
  // list; board quick filters already shrink the server total. Either way the
  // header reports filtered-of-total, not just total.
  const localFiltersActive =
    statusFilter !== 'all' || assigneeFilter !== 'all' || Boolean(search.trim()) || epicFilter !== null;
  const sprintIssues = (sprint: Sprint): Issue[] => {
    const idx = openSprints.findIndex((s) => s.id === sprint.id);
    return (sprintIssueQueries[idx]?.data?.issues ?? []).filter(matches);
  };

  // Distinct assignees across backlog + open sprints — the picker options.
  const assigneeOptions = (() => {
    const map = new Map<string, string>();
    for (const i of backlogIssuesAll)
      if (i.fields.assignee) map.set(i.fields.assignee.accountId, i.fields.assignee.displayName);
    for (const q of sprintIssueQueries)
      for (const i of q.data?.issues ?? [])
        if (i.fields.assignee) map.set(i.fields.assignee.accountId, i.fields.assignee.displayName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  })();

  // Click multi-select with shift-range support across the visible order.
  const visibleOrder: string[] = [];
  for (const s of openSprints) visibleOrder.push(...sprintIssues(s).map((i) => i.key));
  visibleOrder.push(...backlogIssues.map((i) => i.key));

  function toggleSelect(key: string, e: React.MouseEvent) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastClicked) {
        const a = visibleOrder.indexOf(lastClicked);
        const b = visibleOrder.indexOf(key);
        if (a >= 0 && b >= 0) {
          for (const k of visibleOrder.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(k);
          return next;
        }
      }
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setLastClicked(key);
  }

  function dropProps(groupId: string, onDrop: (key: string) => void) {
    return {
      onDragOver: (e: DragEvent) => {
        e.preventDefault();
        setOverGroup(groupId);
      },
      onDragLeave: () => setOverGroup((g) => (g === groupId ? null : g)),
      onDropCard: () => {
        setOverGroup(null);
        if (draggingKey) onDrop(draggingKey);
      },
      over: overGroup === groupId,
    };
  }

  const draggedKeys = (key: string) => (selected.has(key) ? selKeys() : [key]);

  // Where each visible issue currently lives: a sprint id, or 'backlog'.
  const issueHome = new Map<string, string>();
  for (const s of openSprints) for (const i of sprintIssues(s)) issueHome.set(i.key, s.id);
  for (const i of backlogIssuesAll) issueHome.set(i.key, 'backlog');

  // One drop path for every row-level drop (sprint 054 FR-001/FR-002): move the
  // dragged issues into the destination list first, then rank them before the
  // row they landed on. `dest` is 'backlog' or a sprint id.
  const dropOnRow = useMutation({
    mutationFn: async ({ keys, before, dest }: { keys: string[]; before: string; dest: string }) => {
      const relocate = keys.filter((k) => issueHome.get(k) !== dest);
      if (relocate.length) {
        if (dest === 'backlog') await moveIssuesToBacklog(relocate);
        else await moveIssuesToSprint(dest, relocate);
      }
      await rankIssues(keys, { rankBeforeIssue: before });
    },
    onError: flashError,
    onSettled: () => {
      setSelected(new Set());
      invalidate();
    },
  });

  const rowDropProps = (issue: Issue, dest: string) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    },
    onDrop: (e: DragEvent) => {
      e.stopPropagation();
      const keys = draggingKey ? draggedKeys(draggingKey) : [];
      if (keys.length && !keys.includes(issue.key)) {
        dropOnRow.mutate({ keys, before: issue.key, dest });
      }
      setDraggingKey(null);
    },
  });

  const row = (issue: Issue) => (
    <BacklogRow
      key={issue.id}
      issue={issue}
      dragging={draggingKey === issue.key}
      draggable={canSchedule}
      canEdit={canEdit}
      selected={selected.has(issue.key)}
      onToggleSelect={(e) => toggleSelect(issue.key, e)}
      onSavePoints={(v) => savePoints.mutate({ key: issue.key, points: v })}
      agentActivity={agentActivity?.issues[issue.key]}
      epicTypeIds={epicTypeIds}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', issue.key);
        setDraggingKey(issue.key);
      }}
      onDragEnd={() => setDraggingKey(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ issue, x: e.clientX, y: e.clientY });
      }}
      onOpen={(key) =>
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set('selectedIssue', key);
          return next;
        })
      }
    />
  );

  const scrum = board?.type === 'scrum';

  // Jira parity: every group (each sprint + the backlog) gets a "+ Create
  // issue" row. `groupId` is 'backlog' or the sprint id.
  const inlineCreateRow = (groupId: string, sprintId?: string) =>
    inlineCreate === groupId ? (
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-atl-n-30">
        <select
          value={inlineType}
          onChange={(e) => setInlineType(e.target.value)}
          aria-label="Issue type"
          className="h-7 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper shrink-0"
        >
          {(issueTypes ?? []).filter((t) => !t.subtask).map((t) => (
            <option key={t.id} value={t.name}>{t.name}</option>
          ))}
        </select>
        <input
          autoFocus
          value={inlineSummary}
          onChange={(e) => setInlineSummary(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !imeComposing(e) && inlineSummary.trim()) {
              inlineAdd.mutate({ summary: inlineSummary.trim(), sprintId });
            }
            if (e.key === 'Escape') setInlineCreate(false);
          }}
          placeholder="What needs to be done?"
          className="flex-1 text-sm outline-none py-1"
        />
      </div>
    ) : (
      <button
        onClick={() => setInlineCreate(groupId)}
        className="w-full text-left px-3 py-1.5 border-t border-atl-n-30 text-sm text-atl-n-200 hover:bg-atl-n-10"
      >
        + Create issue
      </button>
    );

  return (
    <div className="px-6 py-5 max-w-5xl">
      <PageHeader
        crumbs={[{ label: 'Projects' }, { label: projectKey ?? '' }]}
        title="Backlog"
        afterTitle={
          <button
            type="button"
            onClick={() => setEpicsOpen((v) => !v)}
            aria-pressed={epicsOpen}
            className={`rounded-[10px] px-2.5 py-0.5 text-xs font-medium border transition-colors ${
              epicsOpen
                ? 'bg-atl-p-300 border-atl-p-300 text-white'
                : 'bg-atl-paper border-atl-n-40 text-atl-n-500 hover:border-atl-p-300 hover:text-atl-p-300'
            }`}
          >
            EPICS
          </button>
        }
        actions={
          <>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search this board"
              aria-label="Search this board"
              className="h-8 w-48 rounded-[3px] border border-atl-n-40 px-2.5 text-sm bg-atl-paper placeholder:text-atl-n-100 focus:outline-none focus:border-atl-b-300 focus:ring-1 focus:ring-atl-b-300"
            />
            {selected.size > 0 && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-atl-n-100">{selected.size} selected</span>
                {canSchedule &&
                  openSprints
                    .map((s) => (
                      <button
                        key={s.id}
                        className={ACTION_BTN}
                        onClick={() => moveToSprint.mutate({ sprintId: s.id, keys: selKeys() })}
                      >
                        → {s.name}
                      </button>
                    ))}
                {canSchedule && (
                  <button className={ACTION_BTN} onClick={() => moveToBacklog.mutate(selKeys())}>
                    → Backlog
                  </button>
                )}
                <button className={ACTION_BTN} onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </div>
            )}
          </>
        }
      />

      {(backlogIssuesAll.length > 0 || statusFilter !== 'all' || assigneeFilter !== 'all' || activeQf.length > 0 || (quickFilters?.length ?? 0) > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-atl-n-300">Quick filters:</span>
          {(
            [
              ['all', 'All'],
              ['open', 'Open'],
              ['indeterminate', 'In progress'],
              ['done', 'Done'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={statusFilter === key}
              onClick={() => setStatusFilter(key)}
              className={`rounded-[10px] px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                statusFilter === key
                  ? 'bg-atl-b-50 border-atl-b-300 text-atl-b-400'
                  : 'bg-atl-paper border-atl-n-40 text-atl-n-500 hover:border-atl-b-300 hover:text-atl-b-300'
              }`}
            >
              {label}
            </button>
          ))}
          {/* Board-configured JQL chips — same component look as the Board page. */}
          {(quickFilters ?? []).map((qf) => {
            const on = activeQf.includes(qf.id);
            return (
              <button
                key={qf.id}
                type="button"
                aria-pressed={on}
                title={qf.jql}
                onClick={() =>
                  setActiveQf((cur) => (on ? cur.filter((id) => id !== qf.id) : [...cur, qf.id]))
                }
                className={`rounded-[10px] px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                  on
                    ? 'bg-atl-b-50 border-atl-b-300 text-atl-b-400'
                    : 'bg-atl-paper border-atl-n-40 text-atl-n-500 hover:border-atl-b-300 hover:text-atl-b-300'
                }`}
              >
                {qf.name}
              </button>
            );
          })}
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            aria-label="Filter by assignee"
            className={`h-6 rounded-[10px] border px-2 text-xs font-medium ${
              assigneeFilter !== 'all'
                ? 'bg-atl-b-50 border-atl-b-300 text-atl-b-400'
                : 'bg-atl-paper border-atl-n-40 text-atl-n-500'
            }`}
          >
            <option value="all">Assignee: anyone</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
            {assigneeOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          {(statusFilter !== 'all' || assigneeFilter !== 'all' || activeQf.length > 0) && (
            <button
              type="button"
              onClick={() => {
                setStatusFilter('all');
                setAssigneeFilter('all');
                setActiveQf([]);
              }}
              className="text-xs text-atl-b-300 hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {!scrum && board && (
        <div className="mb-3 rounded-[3px] border border-atl-y-300 bg-atl-y-50 px-3 py-2 text-sm text-atl-n-600">
          This board is a <strong>kanban</strong> board. Switch it to scrum in board settings to use
          sprints and the backlog.
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
          {error}
        </div>
      )}

      {isLoading && <p className="text-sm text-atl-n-200 py-6">Loading backlog…</p>}

      <div className="flex gap-4 items-start">
        {epicsOpen && (
          <EpicsPanel
            epics={epics}
            draggingKey={draggingKey}
            epicFilter={epicFilter}
            onSelectEpic={(k) => setEpicFilter((cur) => (cur === k ? null : k))}
            onDropOnEpic={canEdit ? (key, epicKey) => assignEpic.mutate({ keys: draggedKeys(key), epicKey }) : undefined}
            onCreateEpic={canCreate ? (name) => addEpic.mutate(name) : undefined}
            childCount={(epicKey) =>
              // 062 US1 — count children across the loaded backlog AND open
              // sprint sections; both payloads now carry fields.parent.
              backlogIssuesAll.filter((i) => i.fields.parent?.key === epicKey).length +
              sprintIssueQueries.reduce(
                (n, q) => n + (q.data?.issues ?? []).filter((i) => i.fields.parent?.key === epicKey).length,
                0
              )
            }
          />
        )}
        <div className="flex-1 min-w-0 space-y-6">
        {openSprints
          .map((sprint) => {
            const list = sprintIssues(sprint);
            // Jira shows per-status story-point totals in the sprint header.
            const pts = { new: 0, indeterminate: 0, done: 0 };
            for (const i of list) {
              const c = (i.fields.status?.statusCategory?.key ?? 'new') as keyof typeof pts;
              pts[c in pts ? c : 'new'] += i.fields.story_points ?? 0;
            }
            const fmtDay = (d?: string | null) =>
              d ? parseDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : null;
            const range = [fmtDay(sprint.startDate), fmtDay(sprint.endDate)].filter(Boolean).join(' – ');
            const button = !canSchedule ? null : sprint.state === 'active' ? (
                <button className={ACTION_BTN} onClick={() => setCompletingSprint(sprint)}>
                  Complete sprint
                </button>
              ) : (
                <button className={PRIMARY_BTN} onClick={() => setStartingSprint(sprint)}>
                  Start sprint
                </button>
              );
            return (
              <Group
                key={sprint.id}
                title={sprint.name}
                meta={`${list.length} issue${list.length === 1 ? '' : 's'}${
                  range ? ` · ${range}` : ''
                }${sprint.state === 'active' ? ' · Active' : ''}${sprint.goal ? ` · ${sprint.goal}` : ''}`}
                action={
                  <>
                    <span className="flex items-center gap-1" aria-label="Story points by status">
                      <span title={`To Do: ${pts.new} pts`} className="min-w-6 px-1.5 py-0.5 rounded-full bg-atl-n-40 text-[11px] font-medium text-atl-n-700 text-center">{pts.new}</span>
                      <span title={`In Progress: ${pts.indeterminate} pts`} className="min-w-6 px-1.5 py-0.5 rounded-full bg-atl-b-50 text-[11px] font-medium text-atl-b-400 text-center">{pts.indeterminate}</span>
                      <span title={`Done: ${pts.done} pts`} className="min-w-6 px-1.5 py-0.5 rounded-full bg-atl-g-50 text-[11px] font-medium text-atl-g-500 text-center">{pts.done}</span>
                    </span>
                    {button}
                    {canSchedule && (
                      <button
                        className={ACTION_BTN}
                        // 062 US5 — single action; ⋯ impersonates an overflow menu.
                        title="Edit sprint name, goal, or delete"
                        onClick={() => setEditingSprint(sprint)}
                      >
                        Edit
                      </button>
                    )}
                  </>
                }
                emptyText="Plan a sprint by dragging issues here."
                {...dropProps(`sprint-${sprint.id}`, (key) =>
                  moveToSprint.mutate({ sprintId: sprint.id, keys: draggedKeys(key) })
                )}
              >
                {list.map((issue) => (
                  <div key={issue.id} {...rowDropProps(issue, sprint.id)}>
                    {row(issue)}
                  </div>
                ))}
                {/* Creating inside a sprint requires CREATE + SCHEDULE. */}
                {canCreate && canSchedule && inlineCreateRow(sprint.id, sprint.id)}
              </Group>
            );
          })}

        <Group
          title="Backlog"
          meta={
            localFiltersActive
              ? `${backlogIssues.length} of ${backlogPage?.total ?? backlogIssuesAll.length} issues`
              : `${backlogPage?.total ?? backlogIssues.length} issue${(backlogPage?.total ?? 0) === 1 ? '' : 's'}`
          }
          action={
            <div className="flex gap-2">
              {scrum && canSchedule && (
                <button
                  className={ACTION_BTN}
                  title="Let the copilot suggest a sprint scope"
                  onClick={() => suggestScope.mutate()}
                  disabled={suggestScope.isPending}
                >
                  {suggestScope.isPending ? 'Thinking…' : (<><SparkleIcon size={12} className="inline-block align-[-2px] mr-1" />Suggest scope</>)}
                </button>
              )}
              {canSchedule && (
                <button
                  className={ACTION_BTN}
                  title="Creates a future sprint — set name, dates and goal"
                  onClick={() => setCreateSprintOpen(true)}
                  disabled={!scrum}
                >
                  Create sprint
                </button>
              )}
            </div>
          }
          emptyText="Your backlog is empty."
          {...dropProps('backlog', (key) => moveToBacklog.mutate(draggedKeys(key)))}
        >
          {backlogIssues.map((issue) => (
            <div key={issue.id} {...rowDropProps(issue, 'backlog')}>
              {row(issue)}
            </div>
          ))}
          {backlogIssues.length === 0 &&
            (backlogIssuesAll.length > 0 || localFiltersActive || activeQf.length > 0) && (
            <div className="px-3 py-6 text-center text-sm text-atl-n-100 border-t border-atl-n-30">
              No issues match the current filters.{' '}
              <button
                type="button"
                className="text-atl-b-300 hover:underline"
                onClick={() => {
                  setStatusFilter('all');
                  setAssigneeFilter('all');
                  setSearch('');
                  setEpicFilter(null);
                  setActiveQf([]);
                }}
              >
                Clear all filters
              </button>
            </div>
          )}
          {canCreate && inlineCreateRow('backlog')}
          {(backlogPage?.total ?? 0) > backlogIssuesAll.length && (
            <button
              type="button"
              onClick={() => setBacklogLimit((n) => n + 200)}
              disabled={isFetching}
              className="w-full py-2 text-sm font-medium text-atl-b-300 hover:bg-atl-n-10 disabled:opacity-60"
            >
              {isFetching
                ? 'Loading…'
                : `Load more (${backlogPage!.total - backlogIssuesAll.length} remaining)`}
            </button>
          )}
        </Group>

        {/* Jira parity: closed sprints don't render in the backlog — their
            issues live in reports and the issue view. */}
        </div>
      </div>

      {suggestion && (
        <Modal open onClose={() => setSuggestion(null)}>
          <h2 className="px-5 pt-4 pb-2 text-base font-semibold text-atl-n-800">
            Suggested sprint scope
          </h2>
          <p className="px-5 pb-2 text-xs text-atl-n-200">
            {/* 062 US4 — honest framing over fake specificity (052 trust goal). */}
            Heuristic grouping from the copilot — review before moving.
          </p>
          <div className="px-5 pb-5 space-y-4 max-h-96 overflow-y-auto">
            <div>
              <h3 className="text-xs font-semibold uppercase text-atl-g-500 mb-1">
                Pick for next sprint
              </h3>
              {suggestion.picks.length === 0 && (
                <p className="text-sm text-atl-n-200">No picks.</p>
              )}
              {suggestion.picks.map((p) => (
                <div key={p.key} className="flex items-baseline gap-2 py-0.5 text-sm">
                  <Link to={`/browse/${p.key}`} className="text-atl-b-300 font-medium w-20 shrink-0">
                    {p.key}
                  </Link>
                  <span className="text-atl-n-200 text-xs">{p.reason}</span>
                </div>
              ))}
            </div>
            {suggestion.deferred.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold uppercase text-atl-n-200 mb-1">Deferred</h3>
                {suggestion.deferred.map((d) => (
                  <div key={d.key} className="flex items-baseline gap-2 py-0.5 text-sm">
                    <Link to={`/browse/${d.key}`} className="text-atl-n-400 font-medium w-20 shrink-0">
                      {d.key}
                    </Link>
                    <span className="text-atl-n-200 text-xs">{d.reason}</span>
                  </div>
                ))}
              </div>
            )}
            {suggestion.picks.length > 0 && openSprints.some((s) => s.state === 'future') && (
              <button
                className={PRIMARY_BTN}
                onClick={() => {
                  const target = openSprints.find((s) => s.state === 'future')!;
                  moveToSprint.mutate({
                    sprintId: target.id,
                    keys: suggestion.picks.map((p) => p.key),
                  });
                  setSuggestion(null);
                }}
              >
                Move picks to {openSprints.find((s) => s.state === 'future')?.name}
              </button>
            )}
            <div className="flex justify-end">
              <button className={ACTION_BTN} onClick={() => setSuggestion(null)}>
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {createSprintOpen && (
        <CreateSprintDialog
          originBoardId={board?.id ?? projectKey!}
          onClose={() => setCreateSprintOpen(false)}
          onError={flashError}
          onDone={() => {
            setCreateSprintOpen(false);
            invalidate();
          }}
        />
      )}
      {startingSprint && (
        <StartSprintDialog
          sprint={startingSprint}
          issueCount={sprintIssues(startingSprint).length}
          onClose={() => setStartingSprint(null)}
          onError={flashError}
          onDone={() => {
            setStartingSprint(null);
            invalidate();
          }}
        />
      )}
      {completingSprint && (
        <CompleteSprintDialog
          sprint={completingSprint}
          issues={sprintIssues(completingSprint)}
          futureSprints={openSprints.filter((s) => s.state === 'future')}
          onClose={() => setCompletingSprint(null)}
          onError={flashError}
          onDone={() => {
            setCompletingSprint(null);
            invalidate();
          }}
        />
      )}
      {editingSprint && (
        <EditSprintDialog
          sprint={editingSprint}
          onClose={() => setEditingSprint(null)}
          onError={flashError}
          onDone={() => {
            setEditingSprint(null);
            invalidate();
          }}
        />
      )}

      {ctxMenu &&
        (() => {
          const issue = ctxMenu.issue;
          const keys = draggedKeys(issue.key);
          const flagged = Boolean(
            (issue.fields.customfield_10002 as unknown[] | undefined)?.length
          );
          const inSprintIds = openSprints
            .filter(
              (s) =>
                sprintIssues(s).some((i) => i.key === issue.key)
            )
            .map((s) => s.id);
          const targetSprints = openSprints.filter(
            (s) => !inSprintIds.includes(s.id)
          );
          const firstBacklogKey = backlogIssuesAll[0]?.key;
          const lastBacklogKey = backlogIssuesAll[backlogIssuesAll.length - 1]?.key;
          const items: CtxItem[] = [
            { label: 'Open', to: `/browse/${issue.key}` },
            ...(canAssign || canEdit || canCreate ? [{ sep: true } as CtxItem] : []),
            ...(canAssign
              ? [{
                  label:
                    me && issue.fields.assignee?.accountId === me.accountId
                      ? 'Unassign'
                      : 'Assign to me',
                  disabled: !me,
                  onClick: () =>
                    ctxAssign.mutate({
                      keys,
                      accountId:
                        issue.fields.assignee?.accountId === me?.accountId
                          ? null
                          : (me?.accountId ?? null),
                    }),
                } as CtxItem]
              : []),
            ...(canEdit
              ? [{
                  label: flagged ? 'Remove flag' : 'Add flag',
                  onClick: () => ctxFlag.mutate({ keys, on: !flagged }),
                } as CtxItem]
              : []),
            ...(canCreate ? [{ label: 'Clone', onClick: () => ctxClone.mutate(issue.key) } as CtxItem] : []),
            ...(canSchedule ? [{ sep: true } as CtxItem] : []),
            ...(canSchedule
              ? [
                  // 062 US5 — the plain "move" Jira users reach for first;
                  // it keeps rank-append semantics (unlike send-to-top/bottom).
                  ...(inSprintIds.length > 0
                    ? [{
                        label: 'Move to backlog',
                        onClick: () => moveToBacklog.mutate(keys),
                      } as CtxItem]
                    : []),
                  {
                    label: 'Send to top of backlog',
                    disabled: inSprintIds.length === 0 && firstBacklogKey === issue.key,
                    onClick: () => {
                      if (inSprintIds.length > 0) {
                        moveToBacklog.mutateAsync(keys).then(() => {
                          if (firstBacklogKey) rank.mutate({ keys, before: firstBacklogKey });
                        });
                      } else if (firstBacklogKey && firstBacklogKey !== issue.key) {
                        rank.mutate({ keys, before: firstBacklogKey });
                      }
                    },
                  } as CtxItem,
                  {
                    label: 'Send to bottom of backlog',
                    disabled: inSprintIds.length === 0 && lastBacklogKey === issue.key,
                    onClick: () => {
                      if (inSprintIds.length > 0) {
                        moveToBacklog.mutateAsync(keys).then(() => {
                          if (lastBacklogKey) rank.mutate({ keys, after: lastBacklogKey });
                        });
                      } else if (lastBacklogKey && lastBacklogKey !== issue.key) {
                        rank.mutate({ keys, after: lastBacklogKey });
                      }
                    },
                  } as CtxItem,
                  ...targetSprints.map((s): CtxItem => ({
                    label: `Send to ${s.name}`,
                    onClick: () => moveToSprint.mutate({ sprintId: s.id, keys }),
                  })),
                ]
              : []),
          ];
          return (
            <BacklogContextMenu
              x={ctxMenu.x}
              y={ctxMenu.y}
              items={items}
              onClose={() => setCtxMenu(null)}
            />
          );
        })()}

      <IssueDrawer />
    </div>
  );
}

function CreateSprintDialog({
  originBoardId,
  onClose,
  onError,
  onDone,
}: {
  originBoardId: string;
  onClose: () => void;
  onError: (e: unknown) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goal, setGoal] = useState('');
  const invalidRange = Boolean(startDate && endDate && endDate < startDate);
  const create = useMutation({
    mutationFn: () =>
      createSprint({
        originBoardId,
        name: name.trim() || undefined,
        goal: goal.trim() || undefined,
        // YYYY-MM-DD parses as UTC — append a time so the chosen calendar day
        // is local, matching format.ts parseDate semantics.
        startDate: startDate ? new Date(`${startDate}T00:00:00`).toISOString() : undefined,
        endDate: endDate ? new Date(`${endDate}T23:59:59.999`).toISOString() : undefined,
      }),
    onError,
    onSuccess: onDone,
  });
  return (
    <Modal open onClose={onClose}>
      <h2 className="px-5 pt-4 pb-2 text-base font-semibold text-atl-n-800">Create sprint</h2>
      <div className="px-5 pb-5">
      <label className="block text-xs font-medium text-atl-n-200 mb-1" htmlFor="sprint-name">
        Sprint name
      </label>
      <input
        id="sprint-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Auto-named if blank"
        className="w-full h-8 px-2 mb-3 rounded-[3px] border border-atl-n-40 text-sm"
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium text-atl-n-200 mb-1" htmlFor="sprint-start">
            Start date
          </label>
          <input
            id="sprint-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full h-8 px-2 mb-3 rounded-[3px] border border-atl-n-40 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-atl-n-200 mb-1" htmlFor="sprint-end">
            End date
          </label>
          <input
            id="sprint-end"
            type="date"
            min={startDate || undefined}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full h-8 px-2 mb-3 rounded-[3px] border border-atl-n-40 text-sm"
          />
        </div>
      </div>
      {invalidRange && (
        <p className="text-xs text-atl-r-500 -mt-1 mb-3">End date must be after the start date.</p>
      )}
      <label className="block text-xs font-medium text-atl-n-200 mb-1" htmlFor="sprint-goal">
        Sprint goal
      </label>
      <textarea
        id="sprint-goal"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={2}
        className="w-full px-2 py-1.5 mb-4 rounded-[3px] border border-atl-n-40 text-sm"
      />
      <div className="flex justify-end gap-2">
        <button className={ACTION_BTN} onClick={onClose}>
          Cancel
        </button>
        <button className={PRIMARY_BTN} onClick={() => create.mutate()} disabled={create.isPending || invalidRange}>
          Create
        </button>
      </div>
      </div>
    </Modal>
  );
}

function StartSprintDialog({
  sprint,
  issueCount,
  onClose,
  onError,
  onDone,
}: {
  sprint: Sprint;
  issueCount: number;
  onClose: () => void;
  onError: (e: unknown) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal ?? '');
  const [weeks, setWeeks] = useState(2);
  const start = useMutation({
    mutationFn: () =>
      updateSprint(sprint.id, {
        state: 'active',
        name: name.trim() || undefined,
        goal: goal.trim() || null,
        endDate: new Date(Date.now() + weeks * 7 * 86400_000).toISOString(),
      }),
    onError,
    onSuccess: onDone,
  });
  return (
    <Modal open onClose={onClose}>
      <h2 className="px-5 pt-4 pb-2 text-base font-semibold text-atl-n-800">Start sprint</h2>
      <div className="px-5 pb-5">
      <p className="text-sm text-atl-n-100 mb-3">
        <strong>{issueCount}</strong> issue{issueCount === 1 ? '' : 's'} will be included in this
        sprint.
      </p>
      <label className="block text-xs font-medium text-atl-n-200 mb-1">Sprint name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full h-8 px-2 mb-3 rounded-[3px] border border-atl-n-40 text-sm"
      />
      <label className="block text-xs font-medium text-atl-n-200 mb-1">Duration</label>
      <select
        value={weeks}
        onChange={(e) => setWeeks(Number(e.target.value))}
        className="w-full h-8 px-2 mb-3 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper"
      >
        {[1, 2, 3, 4].map((w) => (
          <option key={w} value={w}>
            {w} week{w === 1 ? '' : 's'}
          </option>
        ))}
      </select>
      <label className="block text-xs font-medium text-atl-n-200 mb-1">Sprint goal</label>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={2}
        className="w-full px-2 py-1.5 mb-4 rounded-[3px] border border-atl-n-40 text-sm"
      />
      <div className="flex justify-end gap-2">
        <button className={ACTION_BTN} onClick={onClose}>
          Cancel
        </button>
        <button className={PRIMARY_BTN} onClick={() => start.mutate()} disabled={start.isPending}>
          Start
        </button>
      </div>
      </div>
    </Modal>
  );
}

function EditSprintDialog({
  sprint,
  onClose,
  onError,
  onDone,
}: {
  sprint: Sprint;
  onClose: () => void;
  onError: (e: unknown) => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(sprint.name);
  const [goal, setGoal] = useState(sprint.goal ?? '');
  const save = useMutation({
    mutationFn: () =>
      updateSprint(sprint.id, { name: name.trim() || undefined, goal: goal.trim() || null }),
    onError,
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => deleteSprint(sprint.id),
    onError,
    onSuccess: onDone,
  });
  const [confirmDel, setConfirmDel] = useState(false);
  return (
    <Modal open onClose={onClose}>
      <h2 className="px-5 pt-4 pb-2 text-base font-semibold text-atl-n-800">Edit sprint</h2>
      <div className="px-5 pb-5">
      <label className="block text-xs font-medium text-atl-n-200 mb-1">Sprint name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full h-8 px-2 mb-3 rounded-[3px] border border-atl-n-40 text-sm"
      />
      <label className="block text-xs font-medium text-atl-n-200 mb-1">Sprint goal</label>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        rows={2}
        className="w-full px-2 py-1.5 mb-4 rounded-[3px] border border-atl-n-40 text-sm"
      />
      <div className="flex justify-between">
        {sprint.state === 'future' ? (
          confirmDel ? (
            <button
              className="h-8 px-3 rounded-[3px] text-sm font-medium bg-atl-r-400 text-white hover:bg-atl-r-300"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Confirm delete
            </button>
          ) : (
            <button
              className="h-8 px-3 rounded-[3px] text-sm font-medium text-atl-r-500 hover:bg-atl-r-50"
              onClick={() => setConfirmDel(true)}
              title="Issues return to the backlog"
            >
              Delete sprint
            </button>
          )
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button className={ACTION_BTN} onClick={onClose}>
            Cancel
          </button>
          <button className={PRIMARY_BTN} onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </button>
        </div>
      </div>
      </div>
    </Modal>
  );
}

/** UB-013 — Jira backlog epic rail: list epics, drag rows onto one to set its
 *  parent, click to filter the backlog to its children, inline create. */
function EpicsPanel({
  epics,
  draggingKey,
  epicFilter,
  onSelectEpic,
  onDropOnEpic,
  onCreateEpic,
  childCount,
}: {
  epics: Issue[];
  draggingKey: string | null;
  epicFilter: string | null;
  onSelectEpic: (key: string) => void;
  /** Undefined when the viewer lacks EDIT_ISSUES (no epic drop targets). */
  onDropOnEpic?: (draggedKey: string, epicKey: string) => void;
  /** Undefined when the viewer lacks CREATE_ISSUES (no create affordance). */
  onCreateEpic?: (name: string) => void;
  childCount: (epicKey: string) => number;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [over, setOver] = useState<string | null>(null);

  const dropOn = (epicKey: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!onDropOnEpic) return;
      e.preventDefault();
      setOver(epicKey);
    },
    onDragLeave: () => setOver((o) => (o === epicKey ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const key = draggingKey ?? e.dataTransfer.getData('text/plain');
      if (key && key !== epicKey) onDropOnEpic?.(key, epicKey);
    },
  });

  return (
    <aside className="w-56 shrink-0 rounded-lg border border-atl-n-30 bg-atl-paper self-start sticky top-4">
      <header className="px-3 py-2 border-b border-atl-n-30">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-atl-n-200">Epics</h2>
      </header>
      <ul className="max-h-[50vh] overflow-y-auto py-1">
        {epics.map((e) => (
          <li key={e.id}>
            <div
              {...dropOn(e.key)}
              className={`w-full text-left px-3 py-2 flex items-center gap-2 border-l-2 ${
                over === e.key
                  ? 'border-atl-p-300 bg-atl-p-50'
                  : epicFilter === e.key
                    ? 'border-atl-p-300 bg-atl-p-50/60'
                    : 'border-transparent hover:bg-atl-n-10'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectEpic(e.key)}
                className="flex-1 min-w-0 text-left"
                title={epicFilter === e.key ? 'Show all issues' : `Show only ${e.key} issues`}
              >
                <span className="block text-sm text-atl-n-800 truncate" title={e.fields.summary}>{e.fields.summary}</span>
                <span className="block text-[11px] text-atl-n-200">
                  <IssueKey
                    issueKey={e.key}
                    categoryKey={e.fields.status.statusCategory.key}
                  />{' '}
                  · {childCount(e.key)} issue{childCount(e.key) === 1 ? '' : 's'}
                </span>
              </button>
              {epicFilter === e.key && (
                <span className="text-[10px] font-medium text-atl-p-300 shrink-0">Filtered</span>
              )}
            </div>
          </li>
        ))}
        {epics.length === 0 && (
          <li className="px-3 py-4 text-xs text-atl-n-100 italic">No epics yet.</li>
        )}
      </ul>
      {epicFilter && (
        <button
          type="button"
          onClick={() => onSelectEpic(epicFilter)}
          className="w-full px-3 py-1.5 border-t border-atl-n-30 text-xs text-atl-n-300 hover:bg-atl-n-10 text-left"
        >
          <CloseIcon size={11} className="inline-block align-[-1px] mr-1" />Clear epic filter
        </button>
      )}
      {creating ? (
        <div className="px-3 py-2 border-t border-atl-n-30">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !imeComposing(e) && name.trim()) {
                onCreateEpic?.(name.trim());
                setName('');
                setCreating(false);
              }
              if (e.key === 'Escape') { setName(''); setCreating(false); }
            }}
            placeholder="Epic name"
            aria-label="Epic name"
            className="w-full h-7 px-2 rounded-[3px] border border-atl-n-40 text-sm focus:border-atl-b-300 outline-none"
          />
        </div>
      ) : onCreateEpic ? (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full px-3 py-2 border-t border-atl-n-30 text-xs font-medium text-atl-n-300 hover:bg-atl-n-10 text-left"
        >
          + Create epic
        </button>
      ) : null}
    </aside>
  );
}

type CtxItem =
  | { sep: true }
  | { sep?: false; label: string; to?: string; disabled?: boolean; onClick?: () => void };

/** UB-014 — Jira backlog right-click menu: open/assign/flag/clone plus
 *  send-to-sprint and backlog reordering shortcuts. */
function BacklogContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - 230));
  const top = Math.max(8, Math.min(y, window.innerHeight - items.length * 32 - 16));

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        role="menu"
        aria-label="Issue actions"
        className="fixed z-50 min-w-[200px] rounded-[3px] border border-atl-n-40 bg-atl-paper py-1 shadow-lg"
        style={{ left, top }}
      >
        {items.map((item, i) =>
          item.sep ? (
            <div key={i} role="separator" className="my-1 border-t border-atl-n-30" />
          ) : item.to ? (
            <Link
              key={i}
              role="menuitem"
              to={item.to}
              onClick={onClose}
              className="block px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10"
            >
              {item.label}
            </Link>
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                item.onClick?.();
                onClose();
              }}
              className="block w-full text-left px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10 disabled:opacity-40"
            >
              {item.label}
            </button>
          )
        )}
      </div>
    </>
  );
}

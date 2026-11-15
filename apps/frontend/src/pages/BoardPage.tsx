import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  createBoard,
  executeTransition,
  fetchBoards,
  fetchBoardConfiguration,
  fetchAgentActivity,
fetchBoardIssues,
  fetchCardConfig,
  fetchIssue,
  fetchPreferences,
  fetchQuickFilters,
  fetchSprintIssues,
  fetchSprints,
  fetchTransitions,
  putPreference,
  rankIssues,
  type Transition,
} from '../api/client.js';
import BoardCard from '../components/BoardCard.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { kbDropTargets, kbFilteredIndex } from '../lib/kbDnd.js';
import BoardColumn from '../components/BoardColumn.js';
import CompleteSprintDialog from '../components/CompleteSprintDialog.js';
import Modal from '../components/Modal.js';
import IssueDrawer from '../components/IssueDrawer.js';
import { patchIssueLists, reorderKeys } from '../lib/optimistic.js';
import TransitionScreenModal from '../components/TransitionScreenModal.js';
import SelectMenu from '../components/SelectMenu.js';
import UserAvatar from '../components/UserAvatar.js';
import { parseDate } from '../lib/format.js';

// Sentinel for the "Unassigned" avatar in the board's assignee filter.
const UNASSIGNED = '__unassigned__';

const GROUP_BY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'assignee', label: 'Assignee' },
  { value: 'epic', label: 'Epic' },
  { value: 'priority', label: 'Priority' },
  { value: 'subtasks', label: 'Subtasks' },
];

interface PendingDrop {
  issueKey: string;
  transitions: Transition[]; // candidates whose `to` status lives in the target column
  rankAfterIssue?: string;
  rankBeforeIssue?: string;
}

export default function BoardPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // Hover/focus intent warms the ['issue', key] cache — drawer/page opens
  // feel instant. staleTime keeps re-hovers on a fresh issue from refetching.
  const prefetchIssue = (key: string) =>
    void queryClient.prefetchQuery({ queryKey: ['issue', key], queryFn: () => fetchIssue(key), staleTime: 30_000 });
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  // Mouse drop-position indicator — which card is hovered + above/below its midline.
  const [dropTarget, setDropTarget] = useState<{ key: string; after: boolean } | null>(null);
  // 037 US2-2 — keyboard DnD: Space on a focused card lifts it, arrows move the
  // insertion slot, Space/Enter drops (same handleDrop path), Esc cancels.
  const [kbDrag, setKbDrag] = useState<{ key: string; lane: string; colIdx: number; pos: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
  const [completing, setCompleting] = useState(false);
  const [creatingBoard, setCreatingBoard] = useState(false);
  const [activeQfIds, setActiveQfIds] = useState<string[]>([]);
const [boardSearch, setBoardSearch] = useState('');
const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null);
const [showAllAssignees, setShowAllAssignees] = useState(false);
const [groupBy, setGroupBy] = useState<string | null>(null);

  // 033 — boardRef: explicit ?board=<id> deep link, else the project key which
  // the backend resolves to the project's default board.
  const boardRef = searchParams.get('board') ?? projectKey!;

  const { data: boards } = useQuery({
    queryKey: ['boards', projectKey],
    queryFn: () => fetchBoards(projectKey!),
    enabled: Boolean(projectKey),
  });
  const { data: config } = useQuery({
    queryKey: ['board-config', boardRef],
    queryFn: () => fetchBoardConfiguration(boardRef),
    enabled: Boolean(boardRef),
  });
  const { data: quickFilters } = useQuery({
    queryKey: ['quickfilters', boardRef],
    queryFn: () => fetchQuickFilters(boardRef),
    enabled: Boolean(boardRef),
  });
  const { data: cardConfig } = useQuery({
    queryKey: ['cardconfig', boardRef],
    queryFn: () => fetchCardConfig(boardRef),
    enabled: Boolean(boardRef),
  });
  const { data: prefs } = useQuery({ queryKey: ['preferences'], queryFn: fetchPreferences });
  const viewKey = `boardview.${boardRef}`;
  const viewPref = (prefs?.[viewKey] ?? {}) as { hideDone?: boolean };
  const hideDone = viewPref.hideDone ?? cardConfig?.hideDone ?? false;

  const { data: issuePage, isLoading } = useQuery({
    queryKey: ['board-issues', boardRef, activeQfIds],
    queryFn: () => fetchBoardIssues(boardRef, { quickFilterIds: activeQfIds }),
    enabled: Boolean(boardRef),
  });
  const { data: sprints } = useQuery({
    queryKey: ['sprints', boardRef],
    queryFn: () => fetchSprints(boardRef, ['active', 'future']),
    enabled: Boolean(boardRef),
  });
  // 058 US5 — one-shot agent-presence map for all cards; SSE keeps it fresh.
  const { data: agentActivity } = useQuery({
    queryKey: ['agent-activity', projectKey],
    queryFn: () => fetchAgentActivity(projectKey!),
    enabled: Boolean(projectKey),
  });
  const activeSprint = sprints?.find((s) => s.state === 'active');
  const futureSprints = (sprints ?? []).filter((s) => s.state === 'future');
  const { data: sprintIssuePage } = useQuery({
    queryKey: ['sprint-issues', activeSprint?.id],
    queryFn: () => fetchSprintIssues(activeSprint!.id),
    enabled: Boolean(activeSprint) && completing,
  });
  const board = boards?.find((b) => b.id === (searchParams.get('board') ?? '')) ??
    boards?.find((b) => b.isDefault) ?? boards?.[0] ?? null;
  const scrum = board?.type === 'scrum';

  // Project-scoped permissions gate every write affordance on the board
  // (per-issue checks would cost one request per card; project schemes rarely
  // vary within a board).
  const { can, canAdmin } = usePermissions({ projectKey }, [
    'TRANSITION_ISSUES', 'SCHEDULE_ISSUES', 'EDIT_ISSUES', 'DELETE_ISSUES',
    'LINK_ISSUES', 'CREATE_ISSUES', 'MOVE_ISSUES', 'ADMINISTER_PROJECTS',
  ]);
  const canDrag = can('TRANSITION_ISSUES') || can('SCHEDULE_ISSUES');
  const canManageSprints = can('SCHEDULE_ISSUES');
  // Stable prop identity for memoized BoardCard — `can` is a fresh closure
  // per render, so key the memo on the boolean results instead.
  const canEdit = can('EDIT_ISSUES');
  const canLink = can('LINK_ISSUES');
  const canCreate = can('CREATE_ISSUES');
  const canMove = can('MOVE_ISSUES');
  const canDelete = can('DELETE_ISSUES');
  const cardPerms = useMemo(
    () => ({ flag: canEdit, link: canLink, clone: canCreate, move: canMove, convert: canEdit, delete: canDelete }),
    [canEdit, canLink, canCreate, canMove, canDelete]
  );

  function showError(message: string) {
    setError(message);
    setTimeout(() => setError(null), 5000);
  }

  const transitionMutation = useMutation({
    mutationFn: ({
      issueKey,
      transitionId,
      body,
    }: {
      issueKey: string;
      transitionId: string;
      body?: { fields?: Record<string, unknown>; comment?: string };
      /** 058 US2 — target status for the optimistic column move. */
      toStatus?: Transition['to'];
    }) => executeTransition(issueKey, transitionId, body),
    // 058 US2 — move the card to its new status instantly; roll back on error.
    onMutate: ({ issueKey, toStatus }) => {
      if (!toStatus) return undefined;
      return patchIssueLists(queryClient, [['board-issues', boardRef]], (list) =>
        list.map((i) =>
          i.key === issueKey
            ? { ...i, fields: { ...i.fields, status: toStatus } }
            : i
        )
      );
    },
    onError: (err, _vars, rollback) => {
      rollback?.();
      showError(err instanceof ApiError ? err.message : 'Transition failed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['board-issues', boardRef] });
      queryClient.invalidateQueries({ queryKey: ['issues'] });
      setDraggingKey(null);
    },
  });

  const rankMutation = useMutation({
    mutationFn: ({
      issues,
      rankAfterIssue,
      rankBeforeIssue,
    }: {
      issues: string[];
      rankAfterIssue?: string;
      rankBeforeIssue?: string;
    }) => rankIssues(issues, { rankAfterIssue, rankBeforeIssue }),
    // 058 US2 — drop renders in under a frame; restore order on failure.
    onMutate: ({ issues: keys, rankAfterIssue, rankBeforeIssue }) =>
      patchIssueLists(queryClient, [['board-issues', boardRef]], (list) =>
        reorderKeys(list, keys, rankBeforeIssue, rankAfterIssue)
      ),
    onError: (err, _vars, rollback) => {
      rollback?.();
      showError(err instanceof ApiError ? err.message : 'Reordering failed');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['board-issues', boardRef] }),
  });

  const prefMutation = useMutation({
    mutationFn: (patch: { hideDone?: boolean }) =>
      putPreference(viewKey, { ...viewPref, ...patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['preferences'] }),
  });

  const columns = config?.columnConfig.columns ?? [];
  const allIssues = issuePage?.issues ?? [];

  // 033 — swimlanes: group cards into horizontal lanes (none|assignee|epic|priority|subtasks)
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set());
  const swimlaneBy = groupBy ?? cardConfig?.swimlaneBy ?? 'none';
  const laneOf = (i: (typeof allIssues)[number]): string => {
    switch (swimlaneBy) {
      case 'assignee': return i.fields.assignee?.displayName ?? 'Unassigned';
      case 'priority': return i.fields.priority?.name ?? 'None';
      case 'epic': return i.fields.parent?.key ?? 'No epic';
      case 'subtasks': return i.fields.parent ? i.fields.parent.key : 'Everything else';
      default: return '';
    }
  };
  const laneKeys = swimlaneBy === 'none'
    ? ['']
    : [...new Set(allIssues.map(laneOf))].sort((a, b) =>
        a === 'No epic' || a === 'Everything else' ? 1 : b === 'No epic' || b === 'Everything else' ? -1 : a.localeCompare(b)
      );
  // Hide-done: cards in done-category columns disappear (per-user pref, FR-005).
  const doneColStatusIds = hideDone
    ? new Set(
        columns
          .filter((c) => c.statuses.every((s) => s.statusCategory.key === 'done'))
          .flatMap((c) => c.statuses.map((s) => s.id))
      )
    : null;
  // UB-018 — Jira board header: text search + click-avatar assignee filter (client-side).
  const searchQ = boardSearch.trim().toLowerCase();
  const issues = allIssues
    .filter((i) => (doneColStatusIds ? !doneColStatusIds.has(i.fields.status.id) : true))
    .filter(
      (i) =>
        !searchQ ||
        i.fields.summary.toLowerCase().includes(searchQ) ||
        i.key.toLowerCase().includes(searchQ)
    )
    .filter((i) =>
      !assigneeFilter ||
      (assigneeFilter === UNASSIGNED
        ? !i.fields.assignee
        : i.fields.assignee?.accountId === assigneeFilter)
    );
  const boardAssignees = [
    ...new Map(
      allIssues
        .map((i) => i.fields.assignee)
        .filter((a): a is { accountId: string; displayName: string } => Boolean(a))
        .map((a) => [a.accountId, a])
    ).values(),
  ];

  // Group issues per column by the column's mapped status ids (order = rank).
  const columnize = (list: typeof issues) =>
    columns.map((col) => {
      const ids = new Set(col.statuses.map((s) => s.id));
      return list.filter((i) => ids.has(i.fields.status.id));
    });
  const issuesByColumn = columnize(issues);

  // While a card is keyboard-lifted, capture arrows/Space/Enter/Esc
  // document-wide (capture phase beats the card's own lift handler).
  useEffect(() => {
    if (!kbDrag) return;
    const laneIssues = swimlaneBy === 'none' ? issues : issues.filter((i) => laneOf(i) === kbDrag.lane);
    const laneCols = columnize(laneIssues);
    const list = (ci: number) => (laneCols[ci] ?? []).filter((i) => i.key !== kbDrag.key);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault(); e.stopPropagation();
        const ci = Math.min(columns.length - 1, Math.max(0, kbDrag.colIdx + (e.key === 'ArrowRight' ? 1 : -1)));
        const pos = Math.min(kbDrag.pos, list(ci).length);
        setKbDrag({ ...kbDrag, colIdx: ci, pos });
        setAnnounce(`Column ${columns[ci].name}, position ${pos + 1} of ${list(ci).length + 1}`);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        const len = list(kbDrag.colIdx).length;
        const pos = Math.min(len, Math.max(0, kbDrag.pos + (e.key === 'ArrowDown' ? 1 : -1)));
        setKbDrag({ ...kbDrag, pos });
        setAnnounce(`${columns[kbDrag.colIdx].name}, position ${pos + 1} of ${len + 1}`);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        const t = kbDropTargets(laneCols[kbDrag.colIdx] ?? [], kbDrag.key, kbDrag.pos);
        setAnnounce(`Dropped ${kbDrag.key} in ${columns[kbDrag.colIdx].name}, position ${kbDrag.pos + 1}`);
        void handleDrop(kbDrag.key, kbDrag.colIdx, t.before, t.after);
        setKbDrag(null);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        setAnnounce(`Move cancelled. ${kbDrag.key} returned to its original position.`);
        setKbDrag(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columnize/laneOf/handleDrop are render-scoped
  }, [kbDrag, issues, columns, swimlaneBy]);

  async function handleDrop(
    issueKey: string | null,
    columnIndex: number,
    beforeIssueKey?: string,
    afterIssueKey?: string
  ) {
    setDropTarget(null);
    if (!issueKey) return;
    const issue = issues.find((i) => i.key === issueKey);
    if (!issue) return;
    const targetStatuses = new Set(columns[columnIndex].statuses.map((s) => s.id));
    const sameColumn = targetStatuses.has(issue.fields.status.id);
    // PUT /issue/rank takes exactly ONE anchor — sending both before+after is a
    // 400. Dropping on a card means "rank before it"; only the column-body drop
    // (append at end) anchors after the last card.
    const pos = beforeIssueKey
      ? { rankBeforeIssue: beforeIssueKey }
      : afterIssueKey
        ? { rankAfterIssue: afterIssueKey }
        : undefined;

    if (sameColumn) {
      // In-column reorder only. The no-op case is "dropped where it already
      // is" (target position anchored on the card itself, or no position) —
      // NOT the card being the column's last: it must still be able to move up.
      if (beforeIssueKey === issueKey || afterIssueKey === issueKey) return;
      if (!pos) return;
      rankMutation.mutate({ issues: [issueKey], ...pos });
      return;
    }

    // Cross-column move: pick a valid transition whose target is in this column.
    const available = await fetchTransitions(issueKey).catch(() => [] as Transition[]);
    const candidates = available.filter((t) => targetStatuses.has(t.to.id));
    if (candidates.length === 0) {
      showError(
        `No workflow transition from "${issue.fields.status.name}" into "${columns[columnIndex].name}".`
      );
      setDraggingKey(null);
      return;
    }
    if (candidates.length === 1 && !candidates[0].hasScreen) {
      transitionMutation.mutate({
        issueKey,
        transitionId: candidates[0].id,
        toStatus: candidates[0].to,
      });
      if (pos) rankMutation.mutate({ issues: [issueKey], ...pos });
      return;
    }
    // Multiple candidates or a screen is required — let the user choose/submit.
    setPendingDrop({ issueKey, transitions: candidates, ...pos });
  }

  // The drop context plus the transition the user actually picked for it —
  // with several screen-bearing candidates, falling back to the first one
  // would submit fields through the wrong transition.
  const [screenFor, setScreenFor] = useState<{ drop: PendingDrop; transition: Transition } | null>(null);

  return (
    <div className="flex flex-col h-full">
      <div aria-live="polite" className="absolute w-px h-px overflow-hidden" style={{ clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)' }}>
        {announce}
      </div>
      <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
        <div>
          <div className="text-xs text-atl-n-200 mb-0.5">
            Projects / <span className="text-atl-n-400">{projectKey}</span>
          </div>
          <h1 className="text-xl font-semibold text-atl-n-800 flex items-center gap-2 min-w-0">
            {/* 033 — board switcher: every project board + create entry.
                Styled SelectMenu (was a native <select> in the page title). */}
            <SelectMenu
              value={board?.id ?? ''}
              title="Switch board"
              label={
                <span className="truncate max-w-96" title={board?.name}>{board?.name ?? 'Loading…'}</span>
              }
              options={[
                ...(boards ?? []).map((b) => ({
                  value: b.id,
                  label: b.name + (b.isDefault ? ' (default)' : ''),
                })),
                { value: '__create__', label: '+ Create board…' },
              ]}
              onChange={(v) => {
                if (v === '__create__') {
                  setCreatingBoard(true);
                  return;
                }
                setActiveQfIds([]);
                setSearchParams({ board: v });
              }}
              buttonClassName="inline-flex items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 -ml-1.5 hover:bg-atl-n-20 min-w-0"
            />
            {activeSprint && (
              <span className="text-atl-n-200 font-normal min-w-0 truncate" title={activeSprint.name}>
                {activeSprint.name}
              </span>
            )}
          </h1>
          {activeSprint && (activeSprint.startDate || activeSprint.endDate || activeSprint.goal) && (
            <p className="text-xs text-atl-n-200 mt-0.5">
              {activeSprint.startDate &&
                `${parseDate(activeSprint.startDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – `}
              {activeSprint.endDate &&
                `${parseDate(activeSprint.endDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · `}
              {activeSprint.endDate && (
                <>
                  {Math.max(
                    0,
                    Math.ceil((parseDate(activeSprint.endDate).getTime() - Date.now()) / 86400000)
                  )}{' '}
                  days remaining
                </>
              )}
              {activeSprint.goal ? ` · ${activeSprint.goal}` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => prefMutation.mutate({ hideDone: !hideDone })}
            aria-pressed={hideDone}
            className={`rounded-[3px] px-3 py-1.5 text-sm font-medium border ${
              hideDone
                ? 'bg-atl-b-50 border-atl-b-300 text-atl-b-400'
                : 'text-atl-n-400 hover:bg-atl-n-20 border-atl-n-30'
            }`}
            title="Hide issues in done-status columns"
          >
            Hide done
          </button>
          {scrum && activeSprint && canManageSprints && (
            <button
              onClick={() => setCompleting(true)}
              className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-atl-n-400 hover:bg-atl-n-20 border border-atl-n-30"
            >
              Complete sprint
            </button>
          )}
          {canAdmin && (
            <Link
              to={`/projects/${projectKey}/board/settings?board=${encodeURIComponent(board?.id ?? '')}`}
              className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-atl-n-400 hover:bg-atl-n-20 border border-atl-n-30"
            >
              Board settings
            </Link>
          )}
        </div>
      </div>

      {/* UB-018 — Jira board header row 2: text search + member-avatar quick filter. */}
      <div className="px-6 pb-2 flex items-center gap-3 shrink-0">
        <div className="relative">
          <svg
            width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"
            className="absolute left-2 top-1/2 -translate-y-1/2 text-atl-n-100"
          >
            <path d="M11.6 10.1a5.5 5.5 0 1 0-1.5 1.5l3.1 3.1 1.4-1.4zM7.5 11a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
          </svg>
          <input
            type="search"
            value={boardSearch}
            onChange={(e) => setBoardSearch(e.target.value)}
            placeholder="Search board"
            aria-label="Search board"
            className="h-8 w-44 pl-7 pr-2 rounded-[3px] border-2 border-atl-n-40 text-sm focus:border-atl-b-300 outline-none bg-atl-paper"
          />
        </div>
        <div className="flex items-center -space-x-1" role="group" aria-label="Filter by assignee">
          {(showAllAssignees ? boardAssignees : boardAssignees.slice(0, 8)).map((a) => (
            <button
              key={a.accountId}
              type="button"
              onClick={() => setAssigneeFilter((cur) => (cur === a.accountId ? null : a.accountId))}
              title={a.displayName}
              aria-pressed={assigneeFilter === a.accountId}
              className={`rounded-full transition-transform hover:-translate-y-0.5 ${
                assigneeFilter === a.accountId
                  ? 'ring-2 ring-atl-b-400 ring-offset-1 z-10 relative'
                  : assigneeFilter
                    ? 'opacity-40'
                    : ''
              }`}
            >
              <UserAvatar displayName={a.displayName} size={28} />
            </button>
          ))}
          {!showAllAssignees && boardAssignees.length > 8 && (
            <button
              type="button"
              onClick={() => setShowAllAssignees(true)}
              title={`${boardAssignees.length - 8} more assignees`}
              aria-label={`Show ${boardAssignees.length - 8} more assignees`}
              className="h-7 min-w-7 px-1 rounded-full bg-atl-n-30 text-[11px] font-medium text-atl-n-500 hover:bg-atl-n-40 relative z-10"
            >
              +{boardAssignees.length - 8}
            </button>
          )}
          {allIssues.some((i) => !i.fields.assignee) && (
            <button
              type="button"
              onClick={() => setAssigneeFilter((cur) => (cur === UNASSIGNED ? null : UNASSIGNED))}
              title="Unassigned"
              aria-label="Filter to unassigned issues"
              aria-pressed={assigneeFilter === UNASSIGNED}
              className={`ml-1 h-7 min-w-7 rounded-full border-2 border-dashed border-atl-n-40 text-[11px] font-medium text-atl-n-300 hover:border-atl-n-100 ${
                assigneeFilter === UNASSIGNED ? 'ring-2 ring-atl-b-400 border-atl-b-300 text-atl-b-400' : ''
              }`}
            >
              ?
            </button>
          )}
          {assigneeFilter && (
            <button
              type="button"
              onClick={() => setAssigneeFilter(null)}
              className="ml-2 text-xs text-atl-n-200 hover:text-atl-n-400"
            >
              Clear
            </button>
          )}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-atl-n-200">
          Group by
          <SelectMenu
            value={groupBy ?? swimlaneBy}
            title="Swimlane grouping (overrides board settings)"
            label={
              <span className="text-sm text-atl-n-600">
                {GROUP_BY_OPTIONS.find((o) => o.value === (groupBy ?? swimlaneBy))?.label ?? 'None'}
              </span>
            }
            options={GROUP_BY_OPTIONS}
            onChange={setGroupBy}
          />
        </label>
      </div>

      {/* Quick-filter chips — AND-composed server-side (FR-003). */}
      {(quickFilters ?? []).length > 0 && (
        <div className="px-6 pb-3 flex flex-wrap items-center gap-1.5 shrink-0">
          {quickFilters!.map((qf) => {
            const on = activeQfIds.includes(qf.id);
            return (
              <button
                key={qf.id}
                onClick={() =>
                  setActiveQfIds((ids) => (on ? ids.filter((x) => x !== qf.id) : [...ids, qf.id]))
                }
                title={qf.jql}
                aria-pressed={on}
                className={`rounded-[10px] px-2.5 py-0.5 text-xs font-medium border transition-colors ${
                  on
                    ? 'bg-atl-b-400 border-atl-b-400 text-white'
                    : 'bg-atl-paper border-atl-n-40 text-atl-n-500 hover:border-atl-b-300 hover:text-atl-b-400'
                }`}
              >
                {qf.name}
              </button>
            );
          })}
          {activeQfIds.length > 0 && (
            <button
              onClick={() => setActiveQfIds([])}
              className="text-xs text-atl-n-200 hover:text-atl-n-400 ml-1"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="mx-6 mb-3 rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500 shrink-0">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-x-auto px-6 pb-6">
        {isLoading ? (
          <div className="flex gap-4 items-start" aria-label="Loading board">
            {[0, 1, 2, 3].map((col) => (
              <div key={col} className="w-64 shrink-0 rounded-[3px] bg-atl-n-20 p-2 space-y-2">
                <div className="h-3 w-24 rounded bg-atl-n-40 animate-pulse" />
                {[0, 1, 2].map((card) => (
                  <div key={card} className="rounded-[3px] bg-atl-paper p-3 space-y-2 shadow-sm">
                    <div className="h-3 w-full rounded bg-atl-n-40 animate-pulse" />
                    <div className="h-3 w-2/3 rounded bg-atl-n-30 animate-pulse" />
                    <div className="flex justify-between">
                      <div className="h-3 w-12 rounded bg-atl-n-30 animate-pulse" />
                      <div className="h-5 w-5 rounded-full bg-atl-n-40 animate-pulse" />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : scrum && !activeSprint ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <p className="text-sm font-medium text-atl-n-600 mb-1">No active sprint</p>
            <p className="text-xs text-atl-n-200 mb-4">
              Plan work in the backlog, then start a sprint to see it here.
            </p>
            <Link
              to={`/projects/${projectKey}/backlog`}
              className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500"
            >
              Go to backlog
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3 h-full overflow-y-auto">
            {laneKeys.map((lane) => {
              const laneIssues = swimlaneBy === 'none' ? issues : issues.filter((i) => laneOf(i) === lane);
              const laneCols = lane === '' ? issuesByColumn : columnize(laneIssues);
              const collapsed = collapsedLanes.has(lane);
              return (
                <div key={lane || '__board'} className={swimlaneBy === 'none' ? 'h-full' : ''}>
                  {swimlaneBy !== 'none' && (
                    <button
                      onClick={() =>
                        setCollapsedLanes((s) => {
                          const n = new Set(s);
                          if (n.has(lane)) n.delete(lane);
                          else n.add(lane);
                          return n;
                        })
                      }
                      className="w-full text-left px-2 py-1 mb-1.5 text-xs font-semibold text-atl-n-500 hover:bg-atl-n-20 rounded-[3px] flex items-center gap-1.5"
                    >
                      <svg width="8" height="8" viewBox="0 0 8 8" className={collapsed ? '' : 'rotate-90'}>
                        <path d="M1.5 1 5.5 4 1.5 7z" fill="currentColor" />
                      </svg>
                      {lane}
                      <span className="font-normal text-atl-n-200">({laneIssues.length})</span>
                    </button>
                  )}
                  {!collapsed && (
                    <div className="flex gap-4 items-start">
                      {columns.map((col, ci) => {
                        const columnIssues = laneCols[ci];
                        // WIP min/max apply to the whole column — a lane slice
                        // would hide a breach (or cry wolf) under swimlanes.
                        const colTotal = issuesByColumn[ci]?.length ?? columnIssues.length;
                        const overMax = col.max !== undefined && colTotal > col.max;
                        const underMin = col.min !== undefined && colTotal < col.min;
                        const points = cardConfig?.statistics?.includes('points')
                          ? columnIssues.reduce((s, i) => s + (Number(i.fields.story_points) || 0), 0)
                          : null;
                        return (
                          <BoardColumn
                            key={col.name}
                            name={points !== null ? `${col.name} · ${points} pts` : col.name}
                            count={columnIssues.length}
                            max={col.max}
                            violated={overMax || underMin}
                            onDropCard={() => handleDrop(draggingKey, ci, undefined, columnIssues.at(-1)?.key)}
                          >
                            {columnIssues.map((issue, idx) => {
                              const kbActive = kbDrag?.lane === lane && kbDrag.colIdx === ci;
                              const filteredIdx = kbActive
                                ? kbFilteredIndex(columnIssues, kbDrag.key, idx)
                                : -1;
                              return (
                                <div
                                  key={issue.id}
                                  tabIndex={0}
                                  aria-label={
                                    canDrag
                                      ? `${issue.key} — ${issue.fields.summary}. Press Enter to open, Space to move with arrow keys.`
                                      : `${issue.key} — ${issue.fields.summary}`
                                  }
                                  // Hover/focus intent warms the issue cache —
                                  // the drawer opens instantly on click.
                                  onMouseEnter={() => prefetchIssue(issue.key)}
                                  onFocus={() => prefetchIssue(issue.key)}
                                  className={`render-defer relative rounded-[3px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-atl-b-400 ${
                                    kbDrag?.key === issue.key ? 'outline outline-2 outline-atl-b-400' : ''
                                  }`}
                                  onKeyDown={(e) => {
                                    if (e.key === ' ' && !kbDrag && canDrag) {
                                      e.preventDefault();
                                      setKbDrag({ key: issue.key, lane, colIdx: ci, pos: idx });
                                      setAnnounce(`Lifted ${issue.key}. Arrow keys move the target slot, Space or Enter drops, Escape cancels.`);
                                    } else if (e.key === 'Enter' && e.target === e.currentTarget && !kbDrag) {
                                      // Plain Enter opens the drawer (mirrors the click path).
                                      e.preventDefault();
                                      setSearchParams((prev) => {
                                        const next = new URLSearchParams(prev);
                                        next.set('selectedIssue', issue.key);
                                        return next;
                                      });
                                    }
                                  }}
                                  onDragOver={(e) => {
                                    e.preventDefault();
                                    if (draggingKey === issue.key) return;
                                    const rect = e.currentTarget.getBoundingClientRect();
                                    const after = e.clientY > rect.top + rect.height / 2;
                                    if (dropTarget?.key !== issue.key || dropTarget.after !== after) {
                                      setDropTarget({ key: issue.key, after });
                                    }
                                  }}
                                  onDragLeave={() => {
                                    if (dropTarget?.key === issue.key) setDropTarget(null);
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const after = dropTarget?.key === issue.key && dropTarget.after;
                                    setDropTarget(null);
                                    handleDrop(
                                      draggingKey,
                                      ci,
                                      after ? columnIssues[idx + 1]?.key : issue.key,
                                      after ? issue.key : idx === 0 ? undefined : columnIssues[idx - 1].key
                                    );
                                  }}
                                >
                                  {/* Mouse-drag insertion line (above/below midpoint). */}
                                  {dropTarget?.key === issue.key && (
                                    <div
                                      className={`pointer-events-none absolute left-1 right-1 h-0.5 rounded bg-atl-b-400 z-10 ${
                                        dropTarget.after ? '-bottom-[5px]' : '-top-[5px]'
                                      }`}
                                    />
                                  )}
                                  {kbActive && filteredIdx === kbDrag.pos && issue.key !== kbDrag.key && (
                                    <div className="h-0.5 bg-atl-b-400 rounded mx-1 mb-1" />
                                  )}
                                  <BoardCard
                                    issue={issue}
                                    dragging={draggingKey === issue.key}
                                    draggable={canDrag}
                                    can={cardPerms}
                                    cardConfig={cardConfig}
                                    agentActivity={agentActivity?.issues[issue.key]}
                                    onDragStart={(e) => {
                                      e.dataTransfer.effectAllowed = 'move';
                                      e.dataTransfer.setData('text/plain', issue.key);
                                      setDraggingKey(issue.key);
                                    }}
                                    onDragEnd={() => { setDraggingKey(null); setDropTarget(null); }}
                                    onClick={(e) => {
                                      // 058 US1 — plain click opens the drawer;
                                      // Ctrl/Cmd-click keeps /browse muscle memory.
                                      if (e.ctrlKey || e.metaKey) navigate(`/browse/${issue.key}`);
                                      else setSearchParams((prev) => {
                                        const next = new URLSearchParams(prev);
                                        next.set('selectedIssue', issue.key);
                                        return next;
                                      });
                                    }}
                                  />
                                </div>
                              );
                            })}
                            {kbDrag?.lane === lane && kbDrag.colIdx === ci &&
                              kbDrag.pos === columnIssues.filter((i) => i.key !== kbDrag.key).length && (
                              <div className="h-0.5 bg-atl-b-400 rounded mx-1 mt-1" />
                            )}
                          </BoardColumn>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Ambiguous drop — pick which transition to take into the column. */}
      <Modal open={pendingDrop !== null && screenFor === null} onClose={() => setPendingDrop(null)}>
        {pendingDrop && (
          <div className="p-4">
            <h2 className="text-sm font-semibold text-atl-n-800 mb-3">
              Move {pendingDrop.issueKey} — choose a transition
            </h2>
            <div className="space-y-1">
              {pendingDrop.transitions.map((t) => (
                <button
                  key={t.id}
                  onClick={() =>
                    t.hasScreen
                      ? setScreenFor({ drop: pendingDrop, transition: t })
                      : (transitionMutation.mutate({ issueKey: pendingDrop.issueKey, transitionId: t.id, toStatus: t.to }),
                        (pendingDrop.rankAfterIssue || pendingDrop.rankBeforeIssue) &&
                          rankMutation.mutate({
                            issues: [pendingDrop.issueKey],
                            rankAfterIssue: pendingDrop.rankAfterIssue,
                            rankBeforeIssue: pendingDrop.rankBeforeIssue,
                          }),
                        setPendingDrop(null))
                  }
                  className="w-full text-left rounded-[3px] border border-atl-n-30 px-3 py-2 hover:bg-atl-n-10"
                >
                  <span className="block text-sm font-medium text-atl-n-800">{t.name}</span>
                  <span className="block text-xs text-atl-n-200">→ {t.to.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Modal>

      <TransitionScreenModal
        transition={screenFor?.transition ?? null}
        issueKey={screenFor?.drop.issueKey ?? ''}
        onClose={() => {
          setScreenFor(null);
          setPendingDrop(null);
        }}
        submitting={transitionMutation.isPending}
        onSubmit={(body) => {
          if (!screenFor) return;
          const { drop, transition: t } = screenFor;
          transitionMutation.mutate({ issueKey: drop.issueKey, transitionId: t.id, body, toStatus: t.to });
          if (drop.rankAfterIssue || drop.rankBeforeIssue) {
            rankMutation.mutate({
              issues: [drop.issueKey],
              rankAfterIssue: drop.rankAfterIssue,
              rankBeforeIssue: drop.rankBeforeIssue,
            });
          }
          setScreenFor(null);
          setPendingDrop(null);
        }}
      />

      {completing && activeSprint && sprintIssuePage && (
        <CompleteSprintDialog
          sprint={activeSprint}
          // Never fall back to the board list — it's search/assignee/hideDone
          // filtered and would lie about the sprint's real open count.
          issues={sprintIssuePage.issues}
          futureSprints={futureSprints}
          onClose={() => setCompleting(false)}
          onError={(e) =>
            showError(e instanceof ApiError ? e.message : 'Could not complete sprint')
          }
          onDone={() => {
            setCompleting(false);
            queryClient.invalidateQueries({ queryKey: ['board-issues', boardRef] });
            queryClient.invalidateQueries({ queryKey: ['sprints', boardRef] });
          }}
        />
      )}

      <Modal open={creatingBoard} onClose={() => setCreatingBoard(false)}>
        <CreateBoardForm
          projectKey={projectKey!}
          onCancel={() => setCreatingBoard(false)}
          onCreated={(b) => {
            setCreatingBoard(false);
            setActiveQfIds([]);
            queryClient.invalidateQueries({ queryKey: ['boards', projectKey] });
            setSearchParams({ board: b.id });
          }}
          onError={(m) => showError(m)}
        />
      </Modal>

      <IssueDrawer />
    </div>
  );
}

/** 033 — Jira's "Create board" (name + type + optional direct JQL). */
function CreateBoardForm({
  projectKey,
  onCreated,
  onCancel,
  onError,
}: {
  projectKey: string;
  onCreated: (b: { id: string }) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'kanban' | 'scrum'>('kanban');
  const [filterJql, setFilterJql] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const b = await createBoard({ name: name.trim(), type, projectKeyOrId: projectKey });
      if (filterJql.trim()) {
        const { updateBoard } = await import('../api/client.js');
        await updateBoard(b.id, { filter: filterJql.trim() });
      }
      return b;
    },
    onSuccess: onCreated,
    onError: (e) => onError(e instanceof ApiError ? e.message : 'Could not create board'),
  });
  return (
    <div className="p-4 w-96">
      <h2 className="text-sm font-semibold text-atl-n-800 mb-3">Create board</h2>
      <label className="block text-xs text-atl-n-200 mb-1">Name</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={`${projectKey} board`}
        className="w-full rounded-[3px] border border-atl-n-40 px-2 py-1.5 text-sm mb-3 focus:border-atl-b-300 focus:outline-none"
      />
      <label className="block text-xs text-atl-n-200 mb-1">Type</label>
      <select
        value={type}
        onChange={(e) => setType(e.target.value as 'kanban' | 'scrum')}
        className="w-full rounded-[3px] border border-atl-n-40 px-2 py-1.5 text-sm mb-3 bg-atl-paper"
      >
        <option value="kanban">Kanban</option>
        <option value="scrum">Scrum</option>
      </select>
      <label className="block text-xs text-atl-n-200 mb-1">
        Filter JQL <span className="text-atl-n-100">(optional — scopes board membership)</span>
      </label>
      <input
        value={filterJql}
        onChange={(e) => setFilterJql(e.target.value)}
        placeholder='e.g. type = Bug'
        className="w-full rounded-[3px] border border-atl-n-40 px-2 py-1.5 text-sm mb-4 font-mono focus:border-atl-b-300 focus:outline-none"
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-[3px] px-3 py-1.5 text-sm text-atl-n-400 hover:bg-atl-n-20"
        >
          Cancel
        </button>
        <button
          onClick={() => create.mutate()}
          disabled={!name.trim() || create.isPending}
          className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 disabled:opacity-50"
        >
          {create.isPending ? 'Creating…' : 'Create board'}
        </button>
      </div>
    </div>
  );
}

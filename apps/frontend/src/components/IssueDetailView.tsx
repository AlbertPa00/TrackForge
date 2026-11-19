import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchIssue,
  fetchMyself,
  fetchPriorities,
  fetchProject,
  fetchEditMeta,
  fetchWatchers,
  fetchComponents,
  fetchVersions,
  addWatcher,
  removeWatcher,
  voteIssue,
  unvoteIssue,
  recordRecentView,
  updateIssueFields,
  createIssuesBulk,
  aiSummarize,
  aiDraft,
  aiBreakdown,
  aiSuggestResolution,
  postAiOutcome,
  fetchSimilarIssues,
  fetchTransitions,
  executeTransition,
  assignIssue,
  exportIssuesUrl,
  exportIssuePrintUrl,
  fetchBoard,
  fetchSprints,
  moveIssuesToSprint,
  moveIssuesToBacklog,
  ApiError,
  type Issue,
  type IssueFieldUpdate,
  type Transition,
  type ResolutionInsight,
} from '../api/client.js';
import IssueTypeIcon from './IssueTypeIcon.js';
import PriorityIcon from './PriorityIcon.js';
import StatusTransitionMenu from './StatusTransitionMenu.js';
import TransitionScreenModal from './TransitionScreenModal.js';
import UserAvatar from './UserAvatar.js';
import UserHoverCard from './UserHoverCard.js';
import { CloseIcon, PencilIcon } from './icons.js';
import AssigneePicker from './AssigneePicker.js';
import InlineEdit from './InlineEdit.js';
import { recordRecentIssue } from './TopNav.js';
import { Markdown, MarkdownEditor } from './Markdown.js';
import LabelsEditor from './LabelsEditor.js';
import EntityRefPicker from './EntityRefPicker.js';
import ActivitySection from './ActivitySection.js';
import TimeTrackingPanel from './TimeTrackingPanel.js';
import ChildIssuesPanel from './ChildIssuesPanel.js';
import AttachmentsPanel from './AttachmentsPanel.js';
import LinkedIssuesPanel from './LinkedIssuesPanel.js';
import DevelopmentPanel from './DevelopmentPanel.js';
import AgentSessionsPanel from './AgentSessionsPanel.js';
import DeliverableProvenanceStrip from './DeliverableProvenanceStrip.js';
import IssueProposalsPanel from './IssueProposalsPanel.js';
import DelegatePicker from './DelegatePicker.js';
import IssueActionsMenu from './IssueActionsMenu.js';
import { CfEditor } from './CustomFields.js';
import IssuePicker from './IssuePicker.js';
import IssueKey, { IssueKeyLink } from './IssueKey.js';
import { useIssuePermissions } from '../hooks/usePermissions.js';
import { markIssueWrite, lastIssueWrite } from '../lib/issueWrites.js';
import { patchIssue } from '../lib/optimistic.js';
import DiffView from './DiffView.js';
import { formatDate, formatDateTime } from '../lib/format.js';
import { useDateFormat } from '../hooks/useDateFormat.js';

/** 042 F-005: Jira-style parent editor — click value → picker; clear via ✕. */
function ParentEditor({
  issueKey,
  parent,
  onSave,
  disabled = false,
}: {
  issueKey: string;
  parent?: Issue['fields']['parent'] | null;
  onSave: (key: string | null) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState('');
  if (!editing) {
    return (
      <span className="group inline-flex items-center gap-1.5 rounded px-1 py-0.5">
        {parent ? (
          <IssueKeyLink
            issueKey={parent.key}
            categoryKey={parent.fields.status?.statusCategory?.key}
            className="text-atl-b-300 hover:underline"
          />
        ) : (
          <span className="text-atl-n-200">None</span>
        )}
        {!disabled && (
          <button
            type="button"
            aria-label="Edit parent"
            onClick={() => setEditing(true)}
            className="opacity-0 group-hover:opacity-100 text-atl-n-200 hover:text-atl-n-500"
          >
            <PencilIcon size={13} />
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <IssuePicker
        value={v}
        onChange={setV}
        excludeKey={issueKey}
        autoFocus
        placeholder="Parent issue…"
        onSelect={(i) => {
          onSave(i.key);
          setV('');
          setEditing(false);
        }}
      />
      {parent && (
        <button
          type="button"
          title="Remove parent"
          onClick={() => {
            onSave(null);
            setEditing(false);
          }}
          className="text-xs text-atl-n-200 hover:text-atl-n-500"
        >
          Clear
        </button>
      )}
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
        className="text-atl-n-200 hover:text-atl-n-500"
      >
        <CloseIcon size={12} />
      </button>
    </span>
  );
}

/** Sprint field editor — sprint membership lives on the sprint API (rank +
 *  state rules), so this edits via move calls, not the issue field PUT.
 *  Scrum boards only; SCHEDULE_ISSUES-gated by the caller. */
function SprintEditor({
  issueKey,
  projectKey,
  sprint,
  disabled = false,
}: {
  issueKey: string;
  projectKey: string;
  sprint?: { id: string; name: string } | null;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const { data: board } = useQuery({
    queryKey: ['board', projectKey],
    queryFn: () => fetchBoard(projectKey),
    staleTime: 60_000,
  });
  const scrum = board?.type === 'scrum';
  const { data: sprints } = useQuery({
    queryKey: ['sprints', board?.id, 'assignable'],
    queryFn: () => fetchSprints(board!.id, ['future', 'active']),
    enabled: editing && scrum,
  });
  const move = useMutation({
    mutationFn: (sprintId: string | null) =>
      sprintId ? moveIssuesToSprint(sprintId, [issueKey]) : moveIssuesToBacklog([issueKey]),
    onSuccess: () => {
      markIssueWrite(issueKey);
      // Sprint↔backlog moves must repaint both lists and the board.
      for (const k of [['issue', issueKey], ['issues'], ['board-issues'], ['backlog'], ['sprint-issues'], ['sprints']]) {
        qc.invalidateQueries({ queryKey: k });
      }
    },
  });

  if (!editing || !scrum) {
    return (
      <span className="group inline-flex items-center gap-1.5 rounded px-1 py-0.5">
        {sprint ? (
          <span className="text-atl-b-300">{sprint.name}</span>
        ) : (
          <span className="text-atl-n-200">None</span>
        )}
        {!disabled && scrum && (
          <button
            type="button"
            aria-label="Edit sprint"
            onClick={() => setEditing(true)}
            className="opacity-0 group-hover:opacity-100 text-atl-n-200 hover:text-atl-n-500"
          >
            <PencilIcon size={13} />
          </button>
        )}
      </span>
    );
  }
  // Pin the current sprint if it's not assignable now (e.g. closed) so the
  // select still shows it rather than snapping to "None".
  const options = [...(sprints ?? [])];
  if (sprint && !options.some((s) => s.id === sprint.id)) {
    options.unshift({ id: sprint.id, name: sprint.name } as (typeof options)[number]);
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        autoFocus
        value={sprint?.id ?? ''}
        onChange={(e) => {
          const v = e.target.value || null;
          if (v !== (sprint?.id ?? null)) move.mutate(v);
          setEditing(false);
        }}
        aria-label="Sprint"
        className="h-7 max-w-48 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper"
      >
        <option value="">None (backlog)</option>
        {options.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.state === 'active' ? ' (active)' : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
        className="text-atl-n-200 hover:text-atl-n-500"
      >
        <CloseIcon size={12} />
      </button>
    </span>
  );
}

/** Jira People-module row: watcher count + watch/stop-watching link. */
function WatchersRow({ issueKey }: { issueKey: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['watchers', issueKey], queryFn: () => fetchWatchers(issueKey) });
  const toggle = useMutation({
    mutationFn: () => (data?.isWatching ? removeWatcher(issueKey) : addWatcher(issueKey)),
    // 058 US2 — flip the watch state instantly, roll back on failure.
    onMutate: () => {
      const key = ['watchers', issueKey];
      const snapshot = qc.getQueryData(key);
      qc.setQueryData(key, (old: { watchCount?: number; isWatching?: boolean } | undefined) =>
        old
          ? {
              ...old,
              isWatching: !old.isWatching,
              watchCount: Math.max(0, (old.watchCount ?? 0) + (old.isWatching ? -1 : 1)),
            }
          : old
      );
      return snapshot;
    },
    onError: (_e, _v, snapshot) => {
      if (snapshot !== undefined) qc.setQueryData(['watchers', issueKey], snapshot);
    },
    onSuccess: () => {
      markIssueWrite(issueKey);
      qc.invalidateQueries({ queryKey: ['watchers', issueKey] });
    },
  });
  return (
    <span className="inline-flex items-center gap-2 px-1 py-0.5">
      <span>{data?.watchCount ?? 0}</span>
      <button
        type="button"
        onClick={() => toggle.mutate()}
        title={data?.isWatching ? 'Stop watching this issue' : 'Watch this issue for updates'}
        className="text-atl-b-300 hover:underline"
      >
        {data?.isWatching ? 'Stop watching' : 'Watch'}
      </button>
    </span>
  );
}

/** Sprint 022: Jira People-module row — vote count + vote/remove-vote link. */
function VotesRow({ issueKey, votes }: { issueKey: string; votes?: { votes: number; hasVoted: boolean } }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => (votes?.hasVoted ? unvoteIssue(issueKey) : voteIssue(issueKey)),
    // 058 US2 — vote count/flag flips instantly, rolls back on failure.
    onMutate: () =>
      patchIssue(qc, issueKey, (issue) => ({
        ...issue,
        fields: {
          ...issue.fields,
          votes: issue.fields.votes
            ? {
                ...issue.fields.votes,
                hasVoted: !issue.fields.votes.hasVoted,
                votes: Math.max(
                  0,
                  issue.fields.votes.votes + (issue.fields.votes.hasVoted ? -1 : 1)
                ),
              }
            : issue.fields.votes,
        },
      })),
    onError: (_e, _v, rollback) => rollback?.(),
    onSuccess: () => {
      markIssueWrite(issueKey);
      qc.invalidateQueries({ queryKey: ['issue', issueKey] });
    },
  });
  return (
    <span className="inline-flex items-center gap-2 px-1 py-0.5">
      <span>{votes?.votes ?? 0}</span>
      <button
        type="button"
        onClick={() => toggle.mutate()}
        title={votes?.hasVoted ? 'Remove your vote' : 'Vote for this issue'}
        className="text-atl-b-300 hover:underline"
      >
        {votes?.hasVoted ? 'Remove vote' : 'Vote'}
      </button>
    </span>
  );
}

/** Sprint 012: issue-level AI — summary, description draft, epic breakdown, similar issues. */
export function AiPanel({ issue }: { issue: Issue }) {
  const qc = useQueryClient();
  const key = issue.key;
  const isEpic = issue.fields.issuetype.hierarchyLevel === 1;
  const [summary, setSummary] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [children, setChildren] = useState<
    { summary: string; acceptanceCriteria: string; description?: string }[] | null
  >(null);
  const [childPicks, setChildPicks] = useState<Set<number>>(new Set());
  // 058 US4 — per-child progress + created links for breakdown apply.
  const [childStatus, setChildStatus] = useState<Record<number, 'pending' | 'done' | 'error'>>({});
  const [childKeys, setChildKeys] = useState<Record<number, string>>({});
  const [batchId, setBatchId] = useState<string | null>(null);
  const [aiError, setAiError] = useState('');
  // 058 US4 — changelog-backed undo: restore the pre-apply description.
  const [undo, setUndo] = useState<{ previous: string } | null>(null);
  // 067 — resolution insight: suggestion card + apply-through-transition state.
  const [insight, setInsight] = useState<ResolutionInsight | null>(null);
  const [resolveTargets, setResolveTargets] = useState<Transition[] | null>(null);
  const [applyScreen, setApplyScreen] = useState<Transition | null>(null);
  const [appliedResolution, setAppliedResolution] = useState<string | null>(null);

  const fail = (e: unknown) =>
    setAiError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));

  const summarize = useMutation({
    mutationFn: () => aiSummarize(key),
    onSuccess: (r) => {
      setAiError('');
      setSummary(r.summary);
    },
    onError: fail,
  });
  const draftDesc = useMutation({
    mutationFn: () => aiDraft(key, { summary: issue.fields.summary, existing: issue.fields.description ?? '' }),
    onSuccess: (r) => {
      setAiError('');
      setDraft(r.draft);
    },
    onError: fail,
  });
  const breakdown = useMutation({
    mutationFn: () => aiBreakdown(key),
    onSuccess: (r) => {
      setAiError('');
      setChildren(r.children);
      setChildPicks(new Set(r.children.map((_, i) => i)));
    },
    onError: fail,
  });
  const similar = useQuery({
    queryKey: ['similar', key],
    queryFn: () => fetchSimilarIssues(key),
    retry: false,
  });
  // 058 US4 — apply the draft via the normal REST write path so it lands in
  // the changelog; undo restores the captured pre-apply value (also changelog'd).
  const applyDraft = useMutation({
    mutationFn: () => updateIssueFields(key, { description: draft }),
    onMutate: () => setUndo({ previous: issue.fields.description ?? '' }),
    onSuccess: () => {
      postAiOutcome('draft', 'accepted');
      setDraft(null);
      markIssueWrite(key);
      void qc.invalidateQueries({ queryKey: ['issue', key] });
    },
    onError: fail,
  });
  const undoDraft = useMutation({
    mutationFn: () => updateIssueFields(key, { description: undo?.previous ?? '' }),
    onSuccess: () => {
      setUndo(null);
      markIssueWrite(key);
      void qc.invalidateQueries({ queryKey: ['issue', key] });
    },
    onError: fail,
  });
  const createChildren = useMutation({
    mutationFn: async () => {
      const picked = (children ?? [])
        .map((c, i) => ({ c, i }))
        .filter(({ i }) => childPicks.has(i));
      // 058 US4 — one bulk call; the batchId makes a retried Apply replay the
      // already-created items instead of duplicating them (057).
      const id = batchId ?? `ai-${key}-${Date.now()}`;
      setBatchId(id);
      setChildStatus(Object.fromEntries(picked.map(({ i }) => [i, 'pending' as const])));
      const result = await createIssuesBulk(
        picked.map(({ c }) => ({
          fields: {
            project: { key: issue.fields.project.key },
            summary: c.summary,
            issuetype: { name: 'Story' },
            description: c.description
              ? `${c.description}\n\n## Acceptance criteria\n- ${c.acceptanceCriteria}`
              : `## Acceptance criteria\n- ${c.acceptanceCriteria}`,
            parent: { key },
          },
        })),
        id
      );
      // Per-child progress: bulk returns created issues in order; errors carry
      // failedElementNumber pointing at the picked index.
      const failed = new Set(
        (result.errors ?? [])
          .map((e) => e.failedElementNumber)
          .filter((n): n is number => typeof n === 'number')
      );
      let created = 0;
      const status: Record<number, 'done' | 'error'> = {};
      const keys: Record<number, string> = {};
      picked.forEach(({ i }, ordinal) => {
        if (failed.has(ordinal)) {
          status[i] = 'error';
        } else {
          status[i] = 'done';
          keys[i] = result.issues[created++]?.key ?? '';
        }
      });
      setChildStatus(status);
      setChildKeys(keys);
      return { failed: failed.size, total: picked.length };
    },
    onSuccess: ({ failed }) => {
      postAiOutcome('breakdown', failed === 0 ? 'accepted' : 'failed');
      markIssueWrite(key);
      void qc.invalidateQueries({ queryKey: ['issue', key] });
    },
    onError: fail,
  });

  // 067 — suggestion is read-only; Apply always goes through the normal
  // transition endpoint so validators, permissions and changelog run (FR-005).
  const suggestRes = useMutation({
    mutationFn: () => aiSuggestResolution(key),
    onSuccess: (r) => {
      setAiError('');
      setInsight(r);
      setResolveTargets(null);
      setAppliedResolution(null);
    },
    onError: fail,
  });
  const applyTransition = useMutation({
    mutationFn: ({
      transitionId,
      body,
    }: {
      transitionId: string;
      body?: { fields?: Record<string, unknown>; comment?: string };
    }) => executeTransition(key, transitionId, body),
    onSuccess: (_d, vars) => {
      const used = (vars.body?.fields?.resolution as { name?: string } | undefined)?.name;
      postAiOutcome('resolution', used === insight?.resolution?.name ? 'accepted' : 'edited');
      setAppliedResolution(used ?? null);
      setInsight(null);
      setResolveTargets(null);
      setApplyScreen(null);
      markIssueWrite(key);
      void qc.invalidateQueries({ queryKey: ['issue', key] });
    },
    onError: fail,
  });
  const prepareApply = useMutation({
    mutationFn: () => fetchTransitions(key),
    onSuccess: (list) => {
      setAiError('');
      // Only transitions landing on a done-category status can resolve the issue.
      const resolving = list.filter((t) => t.to.statusCategory.key === 'done');
      setResolveTargets(resolving);
      if (resolving.length === 1) pickTransition(resolving[0]!);
    },
    onError: fail,
  });
  function pickTransition(t: Transition) {
    if (t.hasScreen) {
      setApplyScreen(t);
    } else if (insight?.resolution) {
      applyTransition.mutate({
        transitionId: t.id,
        body: { fields: { resolution: { name: insight.resolution.name } } },
      });
    }
  }

  const busy = summarize.isPending || draftDesc.isPending || breakdown.isPending || suggestRes.isPending;
  return (
    <div className="mb-4 border border-atl-n-30 rounded">
      <div className="px-4 py-2.5 border-b border-atl-n-30 flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="text-atl-b-300">
          <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
        </svg>
        <h3 className="text-xs font-semibold text-atl-n-300">AI</h3>
      </div>
      <div className="px-4 py-3 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => summarize.mutate()}
            disabled={busy}
            className="h-7 px-2.5 rounded bg-atl-n-10 hover:bg-atl-n-20 text-xs font-medium text-atl-n-700 disabled:opacity-50"
          >
            {summarize.isPending ? 'Summarising…' : 'Summarize'}
          </button>
          <button
            onClick={() => draftDesc.mutate()}
            disabled={busy}
            className="h-7 px-2.5 rounded bg-atl-n-10 hover:bg-atl-n-20 text-xs font-medium text-atl-n-700 disabled:opacity-50"
          >
            {draftDesc.isPending ? 'Drafting…' : 'Draft description'}
          </button>
          {isEpic && (
            <button
              onClick={() => breakdown.mutate()}
              disabled={busy}
              className="h-7 px-2.5 rounded bg-atl-n-10 hover:bg-atl-n-20 text-xs font-medium text-atl-n-700 disabled:opacity-50"
            >
              {breakdown.isPending ? 'Breaking down…' : 'Break down'}
            </button>
          )}
          {!issue.fields.resolution && similar.data !== undefined && (
            <button
              onClick={() => suggestRes.mutate()}
              disabled={busy}
              className="h-7 px-2.5 rounded bg-atl-n-10 hover:bg-atl-n-20 text-xs font-medium text-atl-n-700 disabled:opacity-50"
            >
              {suggestRes.isPending ? 'Suggesting…' : 'Suggest resolution'}
            </button>
          )}
        </div>
        {aiError && <div className="rounded bg-atl-r-50 px-2.5 py-1.5 text-xs text-atl-r-500">{aiError}</div>}
        {summary && (
          <div className="text-sm text-atl-n-700">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1">Summary</div>
            <Markdown text={summary} />
          </div>
        )}
        {draft && (
          <div className="text-sm text-atl-n-700">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1">
              Draft description — diff
            </div>
            <DiffView before={issue.fields.description ?? ''} after={draft} />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={() => applyDraft.mutate()}
                disabled={applyDraft.isPending}
                className="h-7 px-2.5 rounded bg-atl-b-300 hover:bg-atl-b-400 text-white text-xs font-medium disabled:opacity-50"
              >
                {applyDraft.isPending ? 'Applying…' : 'Apply description'}
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(draft).catch(() => undefined);
                }}
                className="text-xs text-atl-b-300 hover:underline"
              >
                Copy to clipboard
              </button>
              <button
                onClick={() => {
                  postAiOutcome('draft', 'discarded');
                  setDraft(null);
                }}
                className="text-xs text-atl-n-300 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {undo && !draft && (
          <div className="flex items-center gap-2 text-xs text-atl-n-500">
            <span>Description updated by AI draft.</span>
            <button
              onClick={() => undoDraft.mutate()}
              disabled={undoDraft.isPending}
              className="font-medium text-atl-b-300 hover:underline disabled:opacity-50"
            >
              {undoDraft.isPending ? 'Restoring…' : 'Undo'}
            </button>
          </div>
        )}
        {children && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1.5">
              Proposed stories
            </div>
            <ul className="space-y-1.5">
              {children.map((c, i) => (
                <li key={i} className="rounded bg-atl-n-10 px-2.5 py-1.5 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={childPicks.has(i)}
                    disabled={createChildren.isPending || childStatus[i] === 'done'}
                    onChange={() =>
                      setChildPicks((s) => {
                        const n = new Set(s);
                        if (n.has(i)) n.delete(i);
                        else n.add(i);
                        return n;
                      })
                    }
                    aria-label={`Include story ${i + 1}`}
                    className="mt-0.5 accent-atl-b-400 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-atl-n-800">
                      {childKeys[i] ? (
                        <Link to={`/browse/${childKeys[i]}`} className="text-atl-b-300 hover:underline">
                          {childKeys[i]}
                        </Link>
                      ) : null}
                      {childKeys[i] ? ' ' : ''}{c.summary}
                    </div>
                    <div className="text-[11px] text-atl-n-500 mt-0.5">{c.acceptanceCriteria}</div>
                  </div>
                  {childStatus[i] === 'done' && (
                    <span className="ml-auto shrink-0 text-[10px] font-medium text-atl-g-500">created</span>
                  )}
                  {childStatus[i] === 'error' && (
                    <span className="ml-auto shrink-0 text-[10px] font-medium text-atl-r-500">failed</span>
                  )}
                  {childStatus[i] === 'pending' && (
                    <span className="ml-auto shrink-0 text-[10px] text-atl-n-300">creating…</span>
                  )}
                </li>
              ))}
            </ul>
            <button
              onClick={() => createChildren.mutate()}
              disabled={
                createChildren.isPending ||
                childPicks.size === 0 ||
                [...childPicks].every((i) => childStatus[i] === 'done')
              }
              className="mt-2 h-7 px-2.5 rounded bg-atl-b-300 hover:bg-atl-b-400 text-white text-xs font-medium disabled:opacity-50"
            >
              {createChildren.isPending
                ? 'Creating…'
                : Object.values(childStatus).some((s) => s === 'error')
                  ? 'Retry failed'
                  : `Create ${childPicks.size} ${childPicks.size === 1 ? 'story' : 'stories'}`}
            </button>
            <button
              onClick={() => {
                postAiOutcome('breakdown', 'discarded');
                setChildren(null);
                setChildStatus({});
                setChildKeys({});
                setBatchId(null);
              }}
              className="mt-2 ml-3 text-xs text-atl-n-300 hover:underline"
            >
              {Object.keys(childStatus).length ? 'Done' : 'Dismiss'}
            </button>
          </div>
        )}
        {(similar.data?.issues.length ?? 0) > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1">Similar issues</div>
            <ul className="space-y-1">
              {similar.data!.issues.map((s) => (
                <li key={s.key}>
                  <Link
                    to={`/browse/${s.key}`}
                    className="flex items-center gap-1.5 text-xs hover:bg-atl-n-10 rounded px-1 py-0.5 -mx-1"
                  >
                    <IssueKey
                      issueKey={s.key}
                      categoryKey={s.statusCategory}
                      className="text-atl-b-300 whitespace-nowrap"
                    />
                    <span className="text-atl-n-600 truncate" title={s.summary}>{s.summary}</span>
                    <span className="ml-auto text-[10px] text-atl-n-200" title={`${Math.round(s.score * 100)}% similar`}>{Math.round(s.score * 100)}%</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        {insight && !insight.resolution && (
          <div className="text-xs text-atl-n-300">
            Not enough resolved similar issues to suggest a resolution.
            <button onClick={() => setInsight(null)} className="ml-2 hover:underline">
              Dismiss
            </button>
          </div>
        )}
        {insight?.resolution && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1">
              Resolution insight
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded bg-atl-n-10 px-1.5 py-0.5 text-[11px] font-medium text-atl-n-800">
                {insight.resolution.name}
              </span>
              {insight.confidence && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    insight.confidence === 'high'
                      ? 'bg-atl-g-50 text-atl-g-500'
                      : insight.confidence === 'medium'
                        ? 'bg-atl-y-50 text-atl-y-500'
                        : 'bg-atl-n-10 text-atl-n-300'
                  }`}
                >
                  {insight.confidence} confidence
                </span>
              )}
            </div>
            {insight.diagnosis && <p className="mt-1.5 text-sm text-atl-n-700">{insight.diagnosis}</p>}
            {insight.basedOn.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {insight.basedOn.map((b) => (
                  <Link
                    key={b.key}
                    to={`/browse/${b.key}`}
                    title={`${b.summary} — resolved ${b.resolution}`}
                    className="rounded bg-atl-n-10 hover:bg-atl-n-20 px-1.5 py-0.5 text-[11px] text-atl-n-600"
                  >
                    <IssueKey issueKey={b.key} categoryKey={b.statusCategory} className="text-atl-b-300" />
                    {' · '}
                    {b.resolution}
                    {' · '}
                    {Math.round(b.score * 100)}%
                  </Link>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-3">
              {(resolveTargets === null || resolveTargets.length === 1) && (
                <button
                  onClick={() => prepareApply.mutate()}
                  disabled={prepareApply.isPending || applyTransition.isPending}
                  className="h-7 px-2.5 rounded bg-atl-b-300 hover:bg-atl-b-400 text-white text-xs font-medium disabled:opacity-50"
                >
                  {prepareApply.isPending || applyTransition.isPending
                    ? 'Applying…'
                    : `Apply ${insight.resolution.name}`}
                </button>
              )}
              {resolveTargets !== null && resolveTargets.length === 0 && (
                <span className="text-xs text-atl-n-300">
                  No resolving transition from {issue.fields.status.name}.
                </span>
              )}
              {resolveTargets !== null && resolveTargets.length > 1 && (
                <span className="flex items-center gap-1.5">
                  {resolveTargets.map((t) => (
                    <button
                      key={t.id}
                      onClick={() => pickTransition(t)}
                      disabled={applyTransition.isPending}
                      className="h-7 px-2.5 rounded bg-atl-b-300 hover:bg-atl-b-400 text-white text-xs font-medium disabled:opacity-50"
                    >
                      {t.name}
                    </button>
                  ))}
                </span>
              )}
              <button
                onClick={() => {
                  postAiOutcome('resolution', 'discarded');
                  setInsight(null);
                  setResolveTargets(null);
                }}
                className="text-xs text-atl-n-300 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {appliedResolution && !insight && (
          <div className="text-xs text-atl-n-500">Issue resolved as {appliedResolution} from an AI suggestion.</div>
        )}
      </div>
      <TransitionScreenModal
        transition={applyScreen}
        issueKey={key}
        projectKey={issue.fields.project.key}
        initialResolution={insight?.resolution?.name}
        onClose={() => setApplyScreen(null)}
        submitting={applyTransition.isPending}
        error={applyTransition.isError ? (applyTransition.error as Error).message : null}
        onSubmit={(body) => {
          if (!applyScreen) return;
          // A screen without a resolution field still applies the suggestion
          // through the normal validated field path.
          const fields = { ...(body.fields ?? {}) };
          if (!('resolution' in fields) && insight?.resolution) {
            fields.resolution = { name: insight.resolution.name };
          }
          applyTransition.mutate({ transitionId: applyScreen.id, body: { ...body, fields } });
        }}
      />
    </div>
  );
}

function DetailRow({ label, children, clip = true }: { label: string; children: ReactNode; clip?: boolean }) {
  return (
    <div className="flex items-center py-2 min-w-0">
      <dt className="w-32 shrink-0 text-xs font-medium text-atl-n-200">{label}</dt>
      <dd
        className={`text-sm text-atl-n-700 min-w-0 flex-1 ${
          clip ? 'whitespace-nowrap overflow-hidden text-ellipsis' : ''
        }`}
      >
        {children}
      </dd>
    </div>
  );
}

/** Bordered field box with a collapse chevron — Jira's module chrome
    (Details / People / Dates / Agile all collapse via the ⌃ toggle). */
function ModuleBox({
  title,
  children,
  className = 'mb-4',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`border border-atl-n-30 rounded ${className}`}>
      <div className={`flex items-center justify-between px-4 py-2.5 ${open ? 'border-b border-atl-n-30' : ''}`}>
        <h3 className="text-xs font-semibold text-atl-n-300">{title}</h3>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
          className="text-atl-n-200 hover:text-atl-n-500"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className={`transition-transform ${open ? '' : 'rotate-180'}`}
            aria-hidden="true"
          >
            <path
              d="M2 7.5 6 3.5l4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {open && children}
    </div>
  );
}

/** Unbordered center-column section with the same collapse toggle — Jira's
    Description / Issue Links modules collapse without a surrounding box. */
function CollapsibleSection({
  title,
  children,
  className = 'mb-6',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className={className}>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-atl-n-300">{title}</h2>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${title}`}
          className="text-atl-n-200 hover:text-atl-n-500"
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            className={`transition-transform ${open ? '' : 'rotate-180'}`}
            aria-hidden="true"
          >
            <path
              d="M2 7.5 6 3.5l4 4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {open && children}
    </section>
  );
}

/** Jira's issue-level Export ⌄ — same menu the navigator shows, scoped to this issue. */
function IssueExportMenu({ issueKey }: { issueKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Export"
        aria-expanded={open}
        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-[3px] text-[13px] font-medium bg-atl-n-10 text-atl-n-500 hover:bg-atl-n-20"
      >
        Export
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-40 w-48 bg-atl-paper border border-atl-n-30 rounded shadow-lg py-1.5">
            <a
              className="block px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10"
              href={exportIssuesUrl({ jql: `key = ${issueKey}`, format: 'csv' })}
              onClick={() => setOpen(false)}
            >
              CSV (Excel-friendly)
            </a>
            <a
              className="block px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10"
              href={exportIssuePrintUrl(issueKey)}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
            >
              Printable view
            </a>
          </div>
        </>
      )}
    </div>
  );
}

/** Small secondary button for the Jira-style action bar under the title. */
function IssueAction({ label, icon, onClick }: { label: string; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-[3px] border border-atl-n-30 px-2.5 py-1.5 text-sm font-medium text-atl-n-600 hover:bg-atl-n-20"
    >
      {icon}
      {label}
    </button>
  );
}

// Mounted-instance registry: the navigator's split pane and the drawer can be
// alive at once — document-level shortcuts must not fire in every mounted view.
const liveViews = new Set<number>();
let viewSeq = 0;

export default function IssueDetailView({
  issueKey,
  pane = false,
}: {
  issueKey: string;
  /** Rendered inside the navigator's split detail pane — key links out to the full page. */
  pane?: boolean;
}) {
  const qc = useQueryClient();
  const viewId = useRef(0);
  if (!viewId.current) viewId.current = ++viewSeq;
  useEffect(() => {
    liveViews.add(viewId.current);
    return () => { liveViews.delete(viewId.current); };
  }, []);
  const [editingDescription, setEditingDescription] = useState(false);
  const [editSummary, setEditSummary] = useState(false);
  const [showEmptyCf, setShowEmptyCf] = useState(false);
  const { format: formatDateForUser } = useDateFormat();

  const {
    data: issue,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['issue', issueKey],
    queryFn: () => fetchIssue(issueKey!),
    enabled: Boolean(issueKey),
    retry: false,
  });
  useEffect(() => {
    if (issue) {
      recordRecentIssue(issue.key, issue.fields.summary, issue.fields.status.statusCategory.key);
      void recordRecentView(issue.key).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on key only; re-recording on every refetch would spam recents
  }, [issue?.key]);
  // Full-page view only — drawer/navigator panes don't own the tab title.
  // Navigating away re-triggers App's pathname-title effect, so no restore needed.
  useEffect(() => {
    if (!pane && issue) document.title = `${issue.key} — ${issue.fields.summary} - TrackForge`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- title cares about identity, not every field refetch
  }, [pane, issue?.key, issue?.fields.summary]);

  // "Updated elsewhere" — the SSE stream refetches this issue; when `updated`
  // moves forward without a local save, tell the user (conflict awareness).
  // Local writes are marked in lib/issueWrites (here + child components +
  // self-actor SSE events) so the user's own edits never trip the banner.
  const seenUpdated = useRef<string | null>(null);
  const [updatedElsewhere, setUpdatedElsewhere] = useState(false);
  // Issue switches reuse this component (navigator split-view, linked-issue
  // navigation): the detector baseline and per-issue edit state must reset or
  // the new issue's `updated` compares against the old issue's timestamp and
  // the banner lies. Declared BEFORE the detector so it wins same-commit races.
  useEffect(() => {
    seenUpdated.current = null;
    setUpdatedElsewhere(false);
    setEditingDescription(false);
    setEditSummary(false);
    setShowEmptyCf(false);
  }, [issueKey]);
  useEffect(() => {
    if (!issue) return;
    const updated = issue.fields.updated;
    if (seenUpdated.current === null) {
      seenUpdated.current = updated;
    } else if (updated !== seenUpdated.current) {
      if (Date.now() - lastIssueWrite(issue.key) > 3_000) setUpdatedElsewhere(true);
      seenUpdated.current = updated;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the updated timestamp only; full-issue dep would reset the detector on any field change
  }, [issue?.fields.updated]);
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself });
  const { can } = useIssuePermissions(issueKey);
  const canEdit = can('EDIT_ISSUES');
  const { data: priorities } = useQuery({ queryKey: ['priorities'], queryFn: fetchPriorities });
  // Type-change options come from the issue's project scheme, not the global
  // /issuetype list (~100 imported legacy types).
  const { data: issueTypes } = useQuery({
    queryKey: ['project', issue?.fields.project.key],
    queryFn: () => fetchProject(issue!.fields.project.key),
    select: (p) => p.issueTypes ?? [],
    enabled: Boolean(issue?.fields.project.key),
  });
  const { data: components } = useQuery({
    queryKey: ['components', issue?.fields.project.key],
    queryFn: () => fetchComponents(issue!.fields.project.key),
    enabled: Boolean(issue?.fields.project.key),
  });
  const { data: versions } = useQuery({
    queryKey: ['versions', issue?.fields.project.key],
    queryFn: () => fetchVersions(issue!.fields.project.key),
    enabled: Boolean(issue?.fields.project.key),
  });
  const { data: editMeta } = useQuery({
    queryKey: ['editmeta', issueKey],
    queryFn: () => fetchEditMeta(issueKey!),
    enabled: Boolean(issueKey),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: (fields: IssueFieldUpdate) => updateIssueFields(issueKey!, fields),
    onSuccess: () => {
      markIssueWrite(issueKey!);
      // Field edits (type/priority/labels…) must repaint everywhere the row
      // shows — prefix-matches cover all parametrized variants.
      for (const k of [['issue', issueKey], ['issues'], ['board-issues'], ['backlog'], ['sprint-issues']]) {
        qc.invalidateQueries({ queryKey: k });
      }
    },
  });
  const saveField = (fields: IssueFieldUpdate) => save.mutateAsync(fields).then(() => undefined);

  // Action bar: notify the owning panel (tf:<action>:<key>) and scroll it into view.
  const issueAction = (event: string, selector: string) => {
    if (!issue) return;
    window.dispatchEvent(new Event(`${event}:${issue.key}`));
    document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const canAssign = can('ASSIGN_ISSUES');
  const canTransition = can('TRANSITION_ISSUES');
  const canComment = can('ADD_COMMENTS');

  // Jira issue shortcuts (037): e edit, a assign, i assign-to-me, m comment.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only the newest mounted view responds (navigator pane + drawer both alive).
      if (Math.max(...liveViews) !== viewId.current) return;
      // An open modal owns the keyboard — don't trigger edits behind it.
      if (document.querySelector('[data-tf-modal]')) return;
      const t = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable) return;
      if (e.key === 'e' && canEdit) {
        e.preventDefault();
        setEditSummary(true);
      } else if (e.key === 'a' && canAssign) {
        e.preventDefault();
        document.querySelector<HTMLElement>('[data-tf-assign]')?.click();
      } else if (e.key === 'm' && canComment) {
        e.preventDefault();
        document.querySelector<HTMLElement>('[data-tf-comment]')?.focus();
      } else if (e.key === 'i' && canAssign) {
        e.preventDefault();
        const meId = (qc.getQueryData(['myself']) as { accountId?: string } | undefined)?.accountId;
        if (meId) {
          void assignIssue(issueKey!, meId).then(() => {
            markIssueWrite(issueKey!);
            qc.invalidateQueries({ queryKey: ['issue', issueKey] });
            qc.invalidateQueries({ queryKey: ['issues'] });
          });
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [issueKey, qc, canEdit, canAssign, canComment]);

  if (isLoading) {
    const bar = (cls: string, key?: number) => <div key={key} className={`rounded bg-atl-n-20 animate-pulse ${cls}`} />;
    return (
      <div className="flex-1 px-8 py-5">
        {bar('h-3 w-48 mb-3')}
        {bar('h-7 w-2/3 mb-4')}
        <div className="flex gap-2 mb-8">
          {bar('h-8 w-24')}
          {bar('h-8 w-32')}
          {bar('h-8 w-24')}
        </div>
        <div className={`grid gap-8 ${pane ? 'grid-cols-1' : 'grid-cols-[1fr_320px]'}`}>
          <div className="space-y-3">
            {bar('h-4 w-24')}
            {bar('h-24 w-full')}
            {bar('h-4 w-24')}
            {bar('h-16 w-full')}
          </div>
          <div className="space-y-2">
            {bar('h-8 w-32 mb-3')}
            {Array.from({ length: 10 }).map((_, i) => bar('h-4 w-full', i))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !issue) {
    const status = error instanceof ApiError ? error.status : 0;
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-24">
        <p className="text-lg font-semibold text-atl-n-500 mb-2">
          {status === 404 ? "You can't view this issue" : 'Something went wrong'}
        </p>
        <p className="text-sm text-atl-n-200 mb-4">
          {status === 404
            ? 'It may have been deleted, or the issue key is incorrect.'
            : 'The issue could not be loaded.'}
        </p>
        <Link to="/projects" className="text-sm text-atl-b-300 hover:underline">
          Back to projects
        </Link>
      </div>
    );
  }

  const { fields } = issue;
  const isFlagged = Array.isArray(fields.flagged) ? fields.flagged.length > 0 : Boolean(fields.flagged);

  return (
    // Keyed on the loaded issue: switching keys remounts every descendant, so
    // per-issue edit state (InlineEdit drafts, pickers, transition screens,
    // comment composer) can never bleed — or save — onto a different issue.
    <div key={issue.key} className="flex-1 min-w-0 min-h-0 overflow-y-auto bg-atl-paper">
      <div className="max-w-6xl mx-auto px-8 py-5">
        {updatedElsewhere && (
          <div className="mb-3 flex items-center gap-3 rounded-[3px] border border-atl-y-75 bg-atl-y-50 px-3 py-2 text-[13px] text-atl-n-800">
            <span className="font-medium">This issue was updated elsewhere.</span>
            <button
              className="text-atl-b-300 hover:underline"
              onClick={() => {
                setUpdatedElsewhere(false);
                qc.invalidateQueries({ queryKey: ['issue', issueKey] });
                qc.invalidateQueries({ queryKey: ['comments', issueKey] });
              }}
            >
              Refresh to see changes
            </button>
            <button
              className="ml-auto text-atl-n-200 hover:text-atl-n-500"
              onClick={() => setUpdatedElsewhere(false)}
              aria-label="Dismiss"
            >
              <CloseIcon size={12} />
            </button>
          </div>
        )}
        <div className="flex items-start justify-between">
          <nav className="text-xs text-atl-n-200 mb-3 flex items-center gap-1.5">
            <Link to="/projects" className="hover:underline">
              Projects
            </Link>
            <span>/</span>
            <Link to={`/projects/${fields.project.key}`} className="hover:underline">
              {fields.project.name}
            </Link>
            {fields.parent && (
              <>
                <span>/</span>
                <IssueKeyLink
                  issueKey={fields.parent.key}
                  categoryKey={fields.parent.fields.status?.statusCategory?.key}
                  className="hover:underline text-atl-b-300"
                />
              </>
            )}
            <span>/</span>
            {pane ? (
              <IssueKeyLink
                issueKey={issue.key}
                categoryKey={fields.status.statusCategory.key}
                className="text-atl-b-300 hover:underline"
              />
            ) : (
              <IssueKey
                issueKey={issue.key}
                categoryKey={fields.status.statusCategory.key}
                className="text-atl-n-400"
              />
            )}
          </nav>
          <div className="flex items-center gap-2">
            <IssueExportMenu issueKey={issue.key} />
            <IssueActionsMenu
              issueKey={issue.key}
              hasSubtasks={fields.subtasks.length > 0}
              flagged={isFlagged}
              issuetypeName={fields.issuetype.name}
              issuetypeSubtask={fields.issuetype.subtask}
              projectKey={fields.project.key}
              can={{
                flag: canEdit,
                link: can('LINK_ISSUES'),
                clone: can('CREATE_ISSUES'),
                move: can('MOVE_ISSUES'),
                convert: canEdit,
                delete: can('DELETE_ISSUES'),
              }}
            />
          </div>
        </div>

        <div className="flex items-start gap-2 mb-1">
          {/* Icon centers on the summary's first line (h1 is text-2xl/snug →
              ~33px line box); items-start keeps it there on wrapped summaries. */}
          <span className="flex h-8 shrink-0 items-center" title={fields.issuetype.name}>
            <IssueTypeIcon name={fields.issuetype.name} hierarchyLevel={fields.issuetype.hierarchyLevel} size={18} />
          </span>
          {isFlagged && (
            <span
              className="mt-1.5 inline-flex items-center gap-1 rounded bg-atl-r-50 px-1.5 py-0.5 text-xs font-medium text-atl-r-500"
              title="Flagged — impediment"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M3 1h1v14H3V1zm3 1h8l-2.5 3.5L14 9H6V5z" />
              </svg>
              Flagged
            </span>
          )}
          <InlineEdit
            value={fields.summary}
            mode="input"
            allowEmpty={false}
            ariaLabel="Edit summary"
            title="Edit summary (e)"
            startEditing={editSummary}
            onEditingChange={setEditSummary}
            disabled={!canEdit}
            onSave={(v) => saveField({ summary: v })}
            display={(v) => <h1 className="text-2xl font-semibold text-atl-n-800 leading-snug px-1 -mx-1">{v}</h1>}
          />
        </div>

        {/* Jira action bar — Attach / Add child / Link issue under the
              summary. Status lives in the Details row below (editable via the
              transition menu there) — rendering it here too duplicated it.
              Buttons dispatch tf:* events; the owning panels listen and open
              their inline forms. */}
        <div className="flex items-center gap-2 mt-3">
          {can('CREATE_ATTACHMENTS') && (
            <IssueAction
              label="Attach"
              onClick={() => issueAction('tf:attach', '[data-tf-attachments]')}
              icon={
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M11.3 3.3 6.8 7.8a2.3 2.3 0 0 0 3.3 3.3l4.2-4.2a4 4 0 1 0-5.7-5.7L4.2 5.6A5.5 5.5 0 1 0 12 13.4l-.8-.8a4 4 0 1 1-5.7-5.7L10 2.4a2.6 2.6 0 1 1 3.7 3.7L9.4 10.4a1 1 0 0 1-1.4-1.4l4.5-4.5z" />
                </svg>
              }
            />
          )}
          {can('CREATE_ISSUES') && (
            <IssueAction
              label="Add child issue"
              onClick={() => issueAction('tf:add-child', '[data-tf-children]')}
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M8 3v10M3 8h10" />
                </svg>
              }
            />
          )}
          {can('LINK_ISSUES') && (
            <IssueAction
              label="Link issue"
              onClick={() => issueAction('tf:link-issue', '[data-tf-linked-issues]')}
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M6.5 9.5a3 3 0 0 0 4.2.2l2-2a3 3 0 0 0-4.2-4.2l-1.1 1.1M9.5 6.5a3 3 0 0 0-4.2-.2l-2 2a3 3 0 0 0 4.2 4.2l1.1-1.1" />
                </svg>
              }
            />
          )}
        </div>

        {/* Narrow contexts (drawer, navigator pane) can't afford the fixed
            320px rail — stack it under the main column instead. */}
        <div className={`grid gap-8 mt-6 ${pane ? 'grid-cols-1' : 'grid-cols-[1fr_320px]'}`}>
          <section>
            {/* Jira Server/DC layout: the main field grid sits at the top of
                  the center column; the right rail keeps only
                  People/Dates/Agile/Time-tracking modules. */}
            <ModuleBox title="Details" className="mb-6">
              {/* auto-fill collapses to one column when the box is too narrow
                  for a 128px label + usable value in each of two columns. */}
              <dl className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-x-8 px-4 py-1">
                <DetailRow label="Issue type" clip={false}>
                  <InlineEdit
                    value={fields.issuetype.name}
                    mode="select"
                    disabled={!canEdit}
                    options={(issueTypes ?? [])
                      .filter((t) => t.name === fields.issuetype.name || !t.subtask)
                      .map((t) => ({
                        value: t.name,
                        label: t.name,
                        icon: <IssueTypeIcon name={t.name} hierarchyLevel={t.hierarchyLevel} />,
                      }))}
                    onSave={(v) => saveField({ issuetype: { name: v } })}
                    display={(v) => (
                      <span className="inline-flex items-center gap-1.5 px-1 py-0.5 min-w-0 max-w-full">
                        <IssueTypeIcon
                          name={v}
                          hierarchyLevel={(issueTypes ?? []).find((t) => t.name === v)?.hierarchyLevel}
                        />
                        <span className="truncate" title={v}>{v}</span>
                      </span>
                    )}
                  />
                </DetailRow>
                <DetailRow label="Priority" clip={false}>
                  <InlineEdit
                    value={fields.priority.name}
                    mode="select"
                    disabled={!canEdit}
                    options={(priorities ?? []).map((p) => ({
                      value: p.name,
                      label: p.name,
                      icon: <PriorityIcon name={p.name} />,
                    }))}
                    onSave={(v) => saveField({ priority: { name: v } })}
                    display={(v) => (
                      <span className="inline-flex items-center gap-1.5 px-1 py-0.5 min-w-0 max-w-full">
                        <PriorityIcon name={v} />
                        <span className="truncate" title={v}>{v}</span>
                      </span>
                    )}
                  />
                </DetailRow>
                <DetailRow label="Status">
                  {/* Status invariant preserved: the "edit" is the transition
                        menu — picking a target status POSTs the transition. */}
                  <StatusTransitionMenu
                    issueKey={issue.key}
                    projectKey={fields.project.key}
                    statusName={fields.status.name}
                    statusCategoryKey={fields.status.statusCategory.key}
                    disabled={!canTransition}
                  />
                </DetailRow>
                <DetailRow label="Resolution">
                  {/* Status invariant: resolution moves via transitions only,
                        never a direct edit — same rule as PUT fields.status. */}
                  <span className="px-1 py-0.5" title={fields.resolution?.name}>{fields.resolution?.name ?? 'Unresolved'}</span>
                </DetailRow>
                <DetailRow label="Affects versions" clip={false}>
                  <EntityRefPicker
                    label="Edit affects versions"
                    values={fields.versions ?? []}
                    options={(versions ?? []).filter(
                      (v) => !v.archived || (fields.versions ?? []).some((f) => f.id === v.id)
                    )}
                    disabled={!canEdit}
                    onSave={(refs) => saveField({ versions: refs.map((r) => ({ id: r.id })) })}
                  />
                </DetailRow>
                <DetailRow label="Fix versions" clip={false}>
                  <EntityRefPicker
                    label="Edit fix versions"
                    values={fields.fixVersions ?? []}
                    options={(versions ?? []).filter(
                      (v) => !v.archived || (fields.fixVersions ?? []).some((f) => f.id === v.id)
                    )}
                    disabled={!canEdit}
                    onSave={(refs) => saveField({ fixVersions: refs.map((r) => ({ id: r.id })) })}
                  />
                </DetailRow>
                <DetailRow label="Components" clip={false}>
                  <EntityRefPicker
                    label="Edit components"
                    values={fields.components ?? []}
                    options={components ?? []}
                    disabled={!canEdit}
                    onSave={(refs) => saveField({ components: refs.map((r) => ({ id: r.id })) })}
                  />
                </DetailRow>
                <DetailRow label="Labels" clip={false}>
                  <LabelsEditor labels={fields.labels} disabled={!canEdit} onSave={(labels) => saveField({ labels })} />
                </DetailRow>
                {(() => {
                  // Jira renders each field once — drop CF aliases that
                  // duplicate the native rows above (Story Points is the
                  // same backing field as story_points).
                  const NATIVE_ROWS = new Set(['story points', 'sprint', 'epic link', 'epic name', 'flagged']);
                  const cfMetas = Object.values(editMeta?.fields ?? {})
                    .filter((m) => m.fieldId.startsWith('customfield_') && m.operations.includes('set'))
                    .filter((m) => !NATIVE_ROWS.has(m.name.toLowerCase()))
                    .sort((a, b) => a.name.localeCompare(b.name));
                  const filled = cfMetas.filter((m) => {
                    const v = fields[m.fieldId];
                    return v !== null && v !== undefined && v !== '' && (!Array.isArray(v) || v.length > 0);
                  });
                  const empty = cfMetas.filter((m) => !filled.includes(m));
                  const renderRow = (m: (typeof cfMetas)[number]) => (
                    <DetailRow key={m.fieldId} label={m.name} clip={false}>
                      <CfEditor
                        meta={m}
                        value={fields[m.fieldId]}
                        projectKey={fields.project.key}
                        disabled={!canEdit}
                        onSave={(v) => saveField({ [m.fieldId]: v } as IssueFieldUpdate)}
                      />
                    </DetailRow>
                  );
                  return (
                    <>
                      {filled.map(renderRow)}
                      {empty.length > 0 && (showEmptyCf ? empty.map(renderRow) : null)}
                      {/* Toggle lives in a dd so the dl keeps only dt/dd descendants. */}
                      {empty.length > 0 && (
                        <div className="col-span-full">
                          <dt className="sr-only">Custom field visibility</dt>
                          <dd>
                            <button
                              type="button"
                              onClick={() => setShowEmptyCf((v) => !v)}
                              className="mt-1 text-xs font-medium text-atl-b-300 hover:underline"
                            >
                              {showEmptyCf
                                ? 'Hide empty fields'
                                : `Show ${empty.length} more field${empty.length === 1 ? '' : 's'}`}
                            </button>
                          </dd>
                        </div>
                      )}
                    </>
                  );
                })()}
              </dl>
            </ModuleBox>
            <DeliverableProvenanceStrip
              issueKey={issue.key}
              projectKey={fields.project.key}
              canEdit={canEdit}
            />
            <CollapsibleSection title="Description" className="mb-6">
              {editingDescription ? (
                <MarkdownEditor
                  value={fields.description ?? ''}
                  issueKey={issue.key}
                  projectKey={fields.project.key}
                  onSave={async (v) => {
                    await saveField({ description: v || null });
                    setEditingDescription(false);
                  }}
                  onCancel={() => setEditingDescription(false)}
                />
              ) : canEdit ? (
                <button
                  type="button"
                  onClick={() => setEditingDescription(true)}
                  className="w-full rounded px-1 py-1 -mx-1 text-left hover:bg-atl-n-20"
                  aria-label="Edit description"
                >
                  {fields.description ? (
                    <Markdown text={fields.description} />
                  ) : (
                    <p className="text-sm text-atl-n-100 italic">Add a description…</p>
                  )}
                </button>
              ) : (
                <div className="px-1 py-1 -mx-1">
                  {fields.description ? (
                    <Markdown text={fields.description} />
                  ) : (
                    <p className="text-sm text-atl-n-100 italic">No description</p>
                  )}
                </div>
              )}
            </CollapsibleSection>

            <ChildIssuesPanel issue={issue} />
            <AttachmentsPanel issue={issue} />
            <IssueProposalsPanel issueKey={issueKey!} />
            <AgentSessionsPanel issueKey={issueKey!} />
            <LinkedIssuesPanel issue={issue} />
            <ActivitySection issue={issue} me={me ? { accountId: me.accountId, isAdmin: me.isAdmin } : undefined} />
          </section>

          <aside>
            {/* Jira Server/DC right rail: People → Dates → Agile →
                  Time tracking → Development → AI. The main field grid lives
                  in the center column. */}
            <ModuleBox title="People">
              <dl className="px-4 py-2">
                <DetailRow label="Assignee" clip={false}>
                  <AssigneePicker
                    issueKey={issue.key}
                    projectKey={fields.project.key}
                    assignee={fields.assignee}
                    disabled={!canAssign}
                  />
                </DetailRow>
                <DetailRow label="Delegate" clip={false}>
                  <DelegatePicker issueKey={issue.key} delegate={fields.delegate} disabled={!canEdit} />
                </DetailRow>
                <DetailRow label="Reporter">
                  <UserHoverCard user={fields.reporter}>
                    <span className="inline-flex items-center gap-2 min-w-0 max-w-full">
                      <UserAvatar displayName={fields.reporter?.displayName} size={20} />
                      {fields.reporter?.accountId ? (
                        <Link
                          to={`/profile/${fields.reporter.accountId}`}
                          className="text-atl-n-700 hover:text-atl-b-300 hover:underline truncate"
                          title={fields.reporter.displayName}
                        >
                          {fields.reporter.displayName}
                        </Link>
                      ) : (
                        (fields.reporter?.displayName ?? 'None')
                      )}
                    </span>
                  </UserHoverCard>
                </DetailRow>
                <DetailRow label="Votes" clip={false}>
                  <VotesRow issueKey={issue.key} votes={fields.votes} />
                </DetailRow>
                <DetailRow label="Watchers" clip={false}>
                  <WatchersRow issueKey={issue.key} />
                </DetailRow>
              </dl>
            </ModuleBox>

            <ModuleBox title="Dates">
              <dl className="px-4 py-2">
                <DetailRow label="Due date" clip={false}>
                  <InlineEdit
                    value={fields.duedate ?? ''}
                    mode="date"
                    ariaLabel="Edit due date"
                    disabled={!canEdit}
                    display={(v) =>
                      v ? (
                        <span className="text-sm text-atl-n-700">{formatDateForUser(v)}</span>
                      ) : (
                        <span className="italic text-sm text-atl-n-100">None</span>
                      )
                    }
                    onSave={(v) => saveField({ duedate: v || null })}
                  />
                </DetailRow>
                <DetailRow label="Created">
                  <span className="text-xs text-atl-n-300" title={formatDateTime(fields.created)}>
                    {formatDate(fields.created)}
                  </span>
                </DetailRow>
                <DetailRow label="Updated">
                  <span className="text-xs text-atl-n-300" title={formatDateTime(fields.updated)}>
                    {formatDate(fields.updated)}
                  </span>
                </DetailRow>
                {fields.resolutiondate && (
                  <DetailRow label="Resolved">
                    <span className="text-xs text-atl-n-300" title={formatDateTime(fields.resolutiondate)}>
                      {formatDate(fields.resolutiondate)}
                    </span>
                  </DetailRow>
                )}
              </dl>
            </ModuleBox>

            <ModuleBox title="Agile">
              <dl className="px-4 py-2">
                <DetailRow label="Sprint" clip={false}>
                  <SprintEditor
                    issueKey={issue.key}
                    projectKey={fields.project.key}
                    sprint={fields.sprint}
                    disabled={!can('SCHEDULE_ISSUES')}
                  />
                </DetailRow>
                <DetailRow label="Story points" clip={false}>
                  <InlineEdit
                    value={fields.story_points == null ? '' : String(fields.story_points)}
                    mode="input"
                    disabled={!canEdit}
                    onSave={(v) => {
                      const t = v.trim();
                      if (t !== '' && !Number.isFinite(Number(t)))
                        return Promise.reject(new Error('Story points must be a number'));
                      return saveField({ story_points: t === '' ? null : Number(t) });
                    }}
                    display={(v) => <span className="px-1 py-0.5">{v || 'None'}</span>}
                  />
                </DetailRow>
                <DetailRow label="Parent" clip={false}>
                  <ParentEditor
                    issueKey={issue.key}
                    parent={fields.parent}
                    disabled={!canEdit}
                    onSave={(key) => saveField({ parent: key ? { key } : null })}
                  />
                </DetailRow>
              </dl>
            </ModuleBox>

            <TimeTrackingPanel issue={issue} />
            <DevelopmentPanel issueKey={issueKey!} />
            <AiPanel issue={issue} />
          </aside>
        </div>
      </div>
    </div>
  );
}

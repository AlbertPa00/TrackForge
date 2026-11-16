import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { markIssueWrite } from '../lib/issueWrites.js';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchComments,
  fetchEditMeta,
  addComment,
  editComment,
  deleteComment,
  fetchWorklogs,
  editWorklog,
  deleteWorklog,
  searchAssignableUsers,
  renderMentions,
  type Issue,
  type Comment,
  type Worklog,
} from '../api/client.js';
import UserAvatar from './UserAvatar.js';
import UserHoverCard from './UserHoverCard.js';
import { MyMonthLogStrip } from './TimeLoggedCard.js';
import ConfirmDialog from './ConfirmDialog.js';
import { Markdown, MarkdownEditor } from './Markdown.js';
import { formatDateTime, parseDate } from '../lib/format.js';
import { useIssuePermissions } from '../hooks/usePermissions.js';

type Tab = 'all' | 'comments' | 'worklogs' | 'history';

// Jira changelog labels — history items store field ids, Jira shows names.
const FIELD_LABELS: Record<string, string> = {
  summary: 'Summary',
  description: 'Description',
  environment: 'Environment',
  status: 'Status',
  issuetype: 'Issue Type',
  issuelinks: 'Link',
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
  key: 'Key',
  components: 'Component/s',
  fixVersions: 'Fix Version/s',
  versions: 'Affects Version/s',
};

function fieldLabel(field: string, meta?: Record<string, { name?: string }>) {
  return meta?.[field]?.name ?? FIELD_LABELS[field] ?? field;
}

function relative(iso: string) {
  const diff = Date.now() - parseDate(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return formatDateTime(iso);
}

/** Composer on the shared MarkdownEditor — toolbar, preview, @-mentions,
 *  paste-images, Ctrl+Enter to post. Draft mirrors into `body` for the
 *  drawer's unsaved-changes guard. */
function CommentComposer({
  issueKey,
  projectKey,
  onPosted,
}: {
  issueKey: string;
  projectKey: string;
  onPosted: () => void;
}) {
  const qc = useQueryClient();
  // Remounting the editor clears its internal draft after post/cancel.
  const [resetN, setResetN] = useState(0);

  return (
    <MarkdownEditor
      key={`${issueKey}-${resetN}`}
      value=""
      saveLabel="Comment"
      submitOnModEnter
      placeholder="Add a comment… (@ to mention, Ctrl+Enter to post)"
      inputProps={{ 'data-tf-comment': true, rows: 3, title: 'Comment — press m to focus' }}
      issueKey={issueKey}
      projectKey={projectKey}
      onSave={async (v) => {
        await addComment(issueKey, v);
        markIssueWrite(issueKey);
        qc.invalidateQueries({ queryKey: ['comments', issueKey] });
        setResetN((n) => n + 1);
        onPosted();
      }}
      onCancel={() => setResetN((n) => n + 1)}
    />
  );
}

function CommentItem({
  c,
  issueKey,
  projectKey,
  meId,
  isAdmin,
  usersMap,
}: {
  c: Comment;
  issueKey: string;
  projectKey?: string;
  meId?: string;
  isAdmin?: boolean;
  usersMap: Map<string, string>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const qc = useQueryClient();
  const canEdit = c.author.accountId === meId || isAdmin;
  const edited = c.updated !== c.created;

  const del = useMutation({
    mutationFn: () => deleteComment(issueKey, c.id),
    onSuccess: () => {
      setConfirmDel(false);
      markIssueWrite(issueKey);
      qc.invalidateQueries({ queryKey: ['comments', issueKey] });
    },
  });

  const resolved = useMemo(() => renderMentions(c.body, usersMap), [c.body, usersMap]);

  return (
    <li className="flex gap-3">
      <UserAvatar displayName={c.author.displayName} size={24} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-atl-n-300">
          <UserHoverCard user={c.author}>
            <Link
              to={`/profile/${c.author.accountId}`}
              className="font-medium text-atl-n-700 hover:text-atl-b-300 hover:underline"
            >
              {c.author.displayName}
            </Link>
          </UserHoverCard>
          {c.author.agent && <span className="ml-1 rounded bg-atl-n-20 px-1 text-[10px]">AGENT</span>}
          <span className="ml-2" title={formatDateTime(c.created)}>{relative(c.created)}</span>
          {edited && <span className="ml-1">· edited</span>}
          {c.channel && c.channel !== 'ui' && <span className="ml-1 text-atl-n-200">via {c.channel}</span>}
        </div>
        {editing ? (
          <MarkdownEditor
            value={c.body}
            issueKey={issueKey}
            projectKey={projectKey}
            onSave={async (v) => {
              await editComment(issueKey, c.id, v);
              markIssueWrite(issueKey);
              qc.invalidateQueries({ queryKey: ['comments', issueKey] });
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <Markdown text={resolved} className="mt-0.5" />
            {canEdit && (
              <div className="mt-0.5 flex gap-2 text-xs text-atl-n-200">
                <button type="button" className="hover:underline" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button type="button" className="hover:underline" onClick={() => setConfirmDel(true)}>
                  Delete
                </button>
              </div>
            )}
          </>
        )}
        <ConfirmDialog
          open={confirmDel}
          title="Delete comment"
          body="Delete this comment? This can't be undone."
          pending={del.isPending}
          error={del.isError ? (del.error as Error).message : null}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirmDel(false)}
        />
      </div>
    </li>
  );
}

/** `datetime-local` value for an ISO timestamp, in the user's local zone. */
function localDateTime(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function WorklogItem({
  w,
  issueKey,
  meId,
  isAdmin,
}: {
  w: Worklog;
  issueKey: string;
  meId?: string;
  isAdmin?: boolean;
}) {
  const qc = useQueryClient();
  const canEdit = w.author.accountId === meId || isAdmin;
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [timeSpent, setTimeSpent] = useState(w.timeSpent);
  const [comment, setComment] = useState(w.comment ?? '');
  const [started, setStarted] = useState(localDateTime(w.started));
  const [billable, setBillable] = useState(w.billable ?? false);

  const done = () => {
    markIssueWrite(issueKey);
    qc.invalidateQueries({ queryKey: ['worklogs', issueKey] });
    qc.invalidateQueries({ queryKey: ['issue', issueKey] });
  };
  const del = useMutation({
    mutationFn: () => deleteWorklog(issueKey, w.id),
    onSuccess: () => {
      setConfirmDel(false);
      done();
    },
  });
  const edit = useMutation({
    mutationFn: () =>
      editWorklog(issueKey, w.id, {
        timeSpent: timeSpent.trim() || undefined,
        comment: comment.trim() || undefined,
        started: started ? new Date(started).toISOString() : undefined,
        billable,
      }),
    onSuccess: () => {
      setEditing(false);
      done();
    },
  });
  return (
    <li className="flex gap-3">
      <UserAvatar displayName={w.author.displayName} size={24} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-atl-n-300">
          {w.author.accountId ? (
            <Link
              to={`/profile/${w.author.accountId}`}
              className="font-medium text-atl-n-700 hover:text-atl-b-300 hover:underline"
            >
              {w.author.displayName}
            </Link>
          ) : (
            <span className="font-medium text-atl-n-700">{w.author.displayName}</span>
          )}
          {w.author.agent && <span className="ml-1 rounded bg-atl-n-20 px-1 text-[10px]">AGENT</span>}
          <span className="ml-2">
            logged <span className="font-medium text-atl-n-700">{w.timeSpent}</span>
          </span>
          {w.billable && <span className="ml-1 rounded bg-atl-g-100 px-1 text-[10px] text-atl-g-500">BILLABLE</span>}
          <span className="ml-2" title={formatDateTime(w.started)}>{relative(w.started)}</span>
          {w.updated !== w.created && <span className="ml-1">· edited</span>}
        </div>
        {editing ? (
          <div className="mt-1 space-y-2 rounded border border-atl-n-30 p-3">
            <div className="flex gap-3">
              <label className="block">
                <span className="mb-0.5 block text-[11px] font-semibold text-atl-n-300">Time spent</span>
                <input
                  value={timeSpent}
                  onChange={(e) => setTimeSpent(e.target.value)}
                  placeholder="e.g. 2h 30m"
                  className="w-28 rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
                />
              </label>
              <label className="block">
                <span className="mb-0.5 block text-[11px] font-semibold text-atl-n-300">Date started</span>
                <input
                  type="datetime-local"
                  value={started}
                  onChange={(e) => setStarted(e.target.value)}
                  className="rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
                />
              </label>
              <label className="flex items-end gap-1.5 pb-1 text-sm text-atl-n-700">
                <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
                Billable
              </label>
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="Work description"
              className="w-full rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
            />
            {edit.isError && <p className="text-xs text-atl-r-400">{(edit.error as Error).message}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!timeSpent.trim() || edit.isPending}
                onClick={() => edit.mutate()}
                className="rounded bg-atl-b-300 px-3 py-1 text-sm font-medium text-white hover:bg-atl-b-400 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded px-3 py-1 text-sm text-atl-n-300 hover:bg-atl-n-20"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {w.comment && <Markdown text={w.comment} className="mt-0.5" />}
            {canEdit && (
              <div className="mt-0.5 flex gap-2 text-xs text-atl-n-200">
                <button type="button" className="hover:underline" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button type="button" className="hover:underline" onClick={() => setConfirmDel(true)}>
                  Delete
                </button>
              </div>
            )}
          </>
        )}
        <ConfirmDialog
          open={confirmDel}
          title="Delete worklog"
          body={`Delete this work log of ${w.timeSpent}? This can't be undone.`}
          pending={del.isPending}
          error={del.isError ? (del.error as Error).message : null}
          onConfirm={() => del.mutate()}
          onClose={() => setConfirmDel(false)}
        />
      </div>
    </li>
  );
}

export default function ActivitySection({
  issue,
  me,
}: {
  issue: Issue;
  me?: { accountId: string; isAdmin?: boolean };
}) {
  const [tab, setTab] = useState<Tab>('all');
  const [newestFirst, setNewestFirst] = useState(true);
  const [commentMax, setCommentMax] = useState(10);
  const { can } = useIssuePermissions(issue.key);
  const canComment = can('ADD_COMMENTS');
  // One fetch, server-ordered: the window always starts at the first comment
  // *in the chosen direction* — newest-first shows the newest `commentMax`,
  // oldest-first shows the oldest (previously a count probe + tail window that
  // surfaced the wrong end of the thread in one direction).
  const { data: commentsPage } = useQuery({
    queryKey: ['comments', issue.key, commentMax, newestFirst ? 'desc' : 'asc'],
    queryFn: () =>
      fetchComments(issue.key, {
        startAt: 0,
        maxResults: commentMax,
        orderBy: newestFirst ? '-created' : 'created',
      }),
    placeholderData: keepPreviousData,
  });
  // shared cache with IssueDetailPage — resolves customfield_* ids to names
  const { data: editMeta } = useQuery({
    queryKey: ['editmeta', issue.key],
    queryFn: () => fetchEditMeta(issue.key),
    staleTime: 60_000,
  });
  const { data: worklogsPage } = useQuery({
    queryKey: ['worklogs', issue.key],
    queryFn: () => fetchWorklogs(issue.key),
  });
  const comments = commentsPage?.comments ?? [];
  const worklogs = worklogsPage?.worklogs ?? [];
  const histories = issue.changelog?.histories ?? [];

  // users map for mention rendering
  const { data: users } = useQuery({
    queryKey: ['users-map', issue.fields.project.key],
    queryFn: () => searchAssignableUsers(issue.fields.project.key, ''),
    staleTime: 60_000,
  });
  const usersMap = useMemo(() => new Map((users ?? []).map((u) => [u.accountId, u.displayName])), [users]);

  type Entry = { kind: 'comment' | 'history' | 'worklog'; at: string; node: React.JSX.Element };
  const entries: Entry[] = [];
  if (tab === 'all' || tab === 'worklogs') {
    for (const w of worklogs) {
      entries.push({
        kind: 'worklog',
        at: w.started,
        node: <WorklogItem key={`w-${w.id}`} w={w} issueKey={issue.key} meId={me?.accountId} isAdmin={me?.isAdmin} />,
      });
    }
  }
  if (tab === 'all' || tab === 'comments') {
    for (const c of comments) {
      entries.push({
        kind: 'comment',
        at: c.created,
        node: (
          <CommentItem
            key={`c-${c.id}`}
            c={c}
            issueKey={issue.key}
            projectKey={issue.fields.project.key}
            meId={me?.accountId}
            isAdmin={me?.isAdmin}
            usersMap={usersMap}
          />
        ),
      });
    }
  }
  if (tab === 'all' || tab === 'history') {
    for (const h of histories) {
      entries.push({
        kind: 'history',
        at: h.created,
        node: (
          <li key={`h-${h.id}`} className="flex gap-3">
            <UserAvatar displayName={h.author.displayName} size={24} />
            <div className="text-sm">
              <div className="text-xs text-atl-n-300">
                {h.author.accountId ? (
                  <Link
                    to={`/profile/${h.author.accountId}`}
                    className="font-medium text-atl-n-700 hover:text-atl-b-300 hover:underline"
                  >
                    {h.author.displayName}
                  </Link>
                ) : (
                  <span className="font-medium text-atl-n-700">{h.author.displayName}</span>
                )}
                <span className="ml-2" title={formatDateTime(h.created)}>{relative(h.created)}</span>
                {h.channel !== 'ui' && <span className="ml-1 text-atl-n-200">via {h.channel}</span>}
              </div>
              <ul className="mt-0.5 space-y-0.5">
                {h.items.map((item, i) => (
                  <li key={i} className="text-xs text-atl-n-300">
                    {item.fromString || item.toString
                      ? `${fieldLabel(item.field, editMeta?.fields)}: ${item.fromString ?? 'None'} → ${item.toString ?? 'None'}`
                      : fieldLabel(item.field, editMeta?.fields)}
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ),
      });
    }
  }
  entries.sort((a, b) => (newestFirst ? (a.at < b.at ? 1 : -1) : a.at > b.at ? 1 : -1));

  return (
    <section className="mt-8">
      <div className="mb-3 flex gap-1 border-b border-atl-n-30">
        {(['all', 'comments', 'worklogs', 'history'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-sm capitalize border-b-2 -mb-px ${
              tab === t
                ? 'border-atl-b-300 font-medium text-atl-n-800'
                : 'border-transparent text-atl-n-300 hover:text-atl-n-500'
            }`}
          >
            {t === 'all'
              ? 'All'
              : t === 'comments'
                ? `Comments (${commentsPage?.total ?? comments.length})`
                : t === 'worklogs'
                  ? `Worklogs (${worklogsPage?.total ?? worklogs.length})`
                  : 'History'}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setNewestFirst((v) => !v)}
          className="ml-auto -mb-px px-3 py-1.5 text-xs text-atl-n-300 hover:text-atl-n-500"
        >
          {newestFirst ? 'Newest first ▾' : 'Oldest first ▴'}
        </button>
      </div>
      {(tab === 'all' || tab === 'comments') && canComment && (
        <div className="mb-4">
          <CommentComposer
            issueKey={issue.key}
            projectKey={issue.fields.project.key}
            onPosted={() => setTab('comments')}
          />
        </div>
      )}
      {(tab === 'all' || tab === 'comments') && (commentsPage?.total ?? 0) > comments.length && (
        <button
          type="button"
          onClick={() => setCommentMax((m) => m + 20)}
          className="mb-3 text-xs font-medium text-atl-b-300 hover:underline"
        >
          Show {commentsPage!.total - comments.length} {newestFirst ? 'earlier' : 'later'} comments
        </button>
      )}
      {tab === 'worklogs' && <MyMonthLogStrip />}
      {entries.length === 0 ? (
        <p className="text-sm text-atl-n-100 italic">No activity yet</p>
      ) : (
        <ul className="space-y-4">{entries.map((e) => e.node)}</ul>
      )}
    </section>
  );
}

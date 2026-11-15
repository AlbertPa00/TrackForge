import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchChildren, createIssue, type Issue } from '../api/client.js';
import IssueTypeIcon from './IssueTypeIcon.js';
import { IssueKeyLink } from './IssueKey.js';
import StatusLozenge from './StatusLozenge.js';
import UserAvatar from './UserAvatar.js';
import { useIssuePermissions } from '../hooks/usePermissions.js';
import { useIssueWrite } from '../lib/useIssueWrite.js';
import { imeComposing } from '../lib/ime.js';

/** "Child issues" panel: progress bar, rows, inline create (epic children or subtasks). */
export default function ChildIssuesPanel({ issue }: { issue: Issue }) {
  const markWrite = useIssueWrite(issue.key);
  const { can } = useIssuePermissions(issue.key);
  const canCreate = can('CREATE_ISSUES');
  const [adding, setAdding] = useState(false);
  const [summary, setSummary] = useState('');
  const isEpic = issue.fields.issuetype.name === 'Epic';

  const { data: children } = useQuery({
    queryKey: ['children', issue.key],
    queryFn: () => fetchChildren(issue.key),
  });

  const create = useMutation({
    mutationFn: async () => {
      await createIssue({
        projectKey: issue.fields.project.key,
        summary,
        issueTypeName: isEpic ? 'Task' : 'Subtask',
        parentKey: issue.key,
      });
    },
    onSuccess: () => {
      setSummary('');
      setAdding(false);
      markWrite([['children', issue.key]]);
    },
  });

  // Issue-view action bar dispatches tf:add-child:<key> to open the inline form.
  useEffect(() => {
    const ev = `tf:add-child:${issue.key}`;
    const open = () => {
      if (canCreate) setAdding(true);
    };
    window.addEventListener(ev, open);
    return () => window.removeEventListener(ev, open);
  }, [issue.key, canCreate]);

  const rows = children ?? [];
  const done = rows.filter((c) => c.fields.status?.statusCategory?.key === 'done').length;
  const pct = rows.length ? Math.round((done / rows.length) * 100) : 0;

  if (!isEpic && issue.fields.subtasks.length === 0 && rows.length === 0 && !adding) {
    return (
      <section className="mt-6" data-tf-children>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-atl-n-300">Subtasks</h2>
          {canCreate && (
            <button type="button" onClick={() => setAdding(true)} className="text-xs text-atl-b-300 hover:underline">
              Create subtask
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="mt-6" data-tf-children>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-atl-n-300">
          {isEpic ? `Child issues (${done} of ${rows.length} done)` : `Subtasks (${done} of ${rows.length} done)`}
        </h2>
        {canCreate && (
          <button type="button" onClick={() => setAdding(true)} className="text-xs text-atl-b-300 hover:underline">
            {isEpic ? 'Create child' : 'Create subtask'}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <div className="mb-2 h-1.5 w-full rounded bg-atl-n-20">
          <div className="h-1.5 rounded bg-atl-g-300 transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      <ul className="divide-y divide-atl-n-20 rounded border border-atl-n-30">
        {rows.map((c) => (
          <li key={c.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-atl-n-10">
            <span className="inline-flex" title={c.fields.issuetype.name}>
              <IssueTypeIcon name={c.fields.issuetype.name} hierarchyLevel={c.fields.issuetype.hierarchyLevel} size={14} />
            </span>
            <IssueKeyLink
              issueKey={c.key}
              categoryKey={c.fields.status?.statusCategory?.key}
              className="text-xs text-atl-b-300 hover:underline shrink-0"
            />
            <span className="min-w-0 flex-1 truncate text-sm text-atl-n-700" title={c.fields.summary}>{c.fields.summary}</span>
            {c.fields.status && (
              <StatusLozenge name={c.fields.status.name} categoryKey={c.fields.status.statusCategory.key} />
            )}
            <UserAvatar displayName={c.fields.assignee?.displayName} size={18} />
          </li>
        ))}
      </ul>
      {adding && (
        <div className="mt-2 flex gap-2">
          <input
            autoFocus
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !imeComposing(e) && summary.trim()) create.mutate();
              if (e.key === 'Escape') setAdding(false);
            }}
            placeholder={`What needs to be done?`}
            className="flex-1 rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
          />
          <button
            type="button"
            disabled={!summary.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="rounded bg-atl-b-300 px-3 py-1 text-sm font-medium text-white hover:bg-atl-b-400 disabled:opacity-50"
          >
            Create
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="rounded px-2 py-1 text-sm text-atl-n-300 hover:bg-atl-n-20"
          >
            Cancel
          </button>
        </div>
      )}
      {create.isError && <p className="mt-1 text-xs text-atl-r-400">{(create.error as Error).message}</p>}
    </section>
  );
}

import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  createVersion,
  deleteVersion,
  fetchMyPermissions,
  fetchMyself,
  fetchReleaseNotes,
  fetchVersionIssueCounts,
  fetchVersions,
  moveVersion,
  releaseVersion,
  searchIssues,
  updateVersion,
  type ReleaseNotes,
  type Version,
} from '../api/client.js';
import EmptyState from '../components/EmptyState.js';
import Modal from '../components/Modal.js';
import PageHeader from '../components/PageHeader.js';
import RowMenu from '../components/RowMenu.js';
import StatusLozenge from '../components/StatusLozenge.js';
import { IssueKeyLink } from '../components/IssueKey.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT =
  'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';

function notesToMarkdown(n: ReleaseNotes): string {
  const lines = [`# Release notes — ${n.project} ${n.version.name}`, ''];
  if (n.groups.length === 0) lines.push('_No resolved issues._');
  for (const g of n.groups) {
    lines.push(`## ${g.issueType.name}`);
    for (const i of g.issues) lines.push(`- **${i.key}** ${i.summary}`);
    lines.push('');
  }
  return lines.join('\n');
}

function notesToCsv(n: ReleaseNotes): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return [
    'issueType,key,summary',
    ...n.groups.flatMap((g) => g.issues.map((i) => [esc(g.issueType.name), i.key, esc(i.summary)].join(','))),
  ].join('\n');
}

function download(filename: string, text: string, mime: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const CATEGORY_ORDER: Record<string, number> = { done: 0, indeterminate: 1, new: 2 };

export default function ReleasesPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const qc = useQueryClient();
  const { data: versions } = useQuery({
    queryKey: ['versions', projectKey],
    queryFn: () => fetchVersions(projectKey!),
    enabled: Boolean(projectKey),
  });
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself });
  const { data: myPerms } = useQuery({
    queryKey: ['mypermissions', projectKey],
    queryFn: () => fetchMyPermissions({ projectKey: projectKey!, permissions: ['ADMINISTER_PROJECTS'] }),
    enabled: Boolean(projectKey),
  });
  const canAdmin = Boolean(me?.isAdmin) || Boolean(myPerms?.permissions?.ADMINISTER_PROJECTS?.havePermission);

  const [editing, setEditing] = useState<Version | 'new' | null>(null);
  // Jira releases hub: status tabs; archived versions only show on their tab.
  const [statusFilter, setStatusFilter] = useState<'unreleased' | 'released' | 'archived'>('unreleased');
  const [deleting, setDeleting] = useState<Version | null>(null);
  const [swapFix, setSwapFix] = useState('');
  const [swapAffected, setSwapAffected] = useState('');
  const [notes, setNotes] = useState<{ version: Version; data: ReleaseNotes } | null>(null);
  const [err, setErr] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['versions', projectKey] });
    qc.invalidateQueries({ queryKey: ['versionCounts'] });
    qc.invalidateQueries({ queryKey: ['versionIssues'] });
  };
  const release = useMutation({
    mutationFn: (v: Version) => releaseVersion(v.id),
    onSuccess: invalidate,
    onError: (e) => setErr((e as ApiError).message),
  });
  const del = useMutation({
    mutationFn: (v: Version) =>
      deleteVersion(v.id, {
        moveFixIssuesTo: swapFix || undefined,
        moveAffectedIssuesTo: swapAffected || undefined,
      }),
    onSuccess: () => { setDeleting(null); setSwapFix(''); setSwapAffected(''); invalidate(); },
    onError: (e) => setErr((e as ApiError).message),
  });
  const move = useMutation({
    mutationFn: (a: { id: string; position: 'Earlier' | 'Later' }) => moveVersion(a.id, { position: a.position }),
    onSuccess: invalidate,
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <div className="px-6 py-5 max-w-4xl">
      <PageHeader
        crumbs={[{ label: 'Projects' }, { label: projectKey ?? '' }]}
        title="Releases"
        actions={
          canAdmin ? (
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="h-8 px-3 rounded-[3px] bg-atl-b-300 text-white text-sm font-medium hover:bg-atl-b-400"
            >
              Create version
            </button>
          ) : undefined
        }
      />
      <p className="text-sm text-atl-n-200 mb-6">
        Versions track releases of {projectKey}. Release a version to stamp its release date and generate notes.
      </p>
      {err && <div className="mb-4 rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{err}</div>}

      <div className="mb-4 inline-flex rounded-[3px] bg-atl-n-20 p-0.5" role="tablist" aria-label="Version status">
        {(['unreleased', 'released', 'archived'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={statusFilter === s}
            onClick={() => setStatusFilter(s)}
            className={`h-7 px-3 rounded-[3px] text-sm font-medium capitalize ${
              statusFilter === s ? 'bg-atl-paper text-atl-n-800 shadow-sm' : 'text-atl-n-400 hover:text-atl-n-600'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {(versions ?? [])
          .filter((v) =>
            statusFilter === 'archived'
              ? v.archived
              : !v.archived && (statusFilter === 'released' ? v.released : !v.released)
          )
          .map((v, i, filtered) => (
          <VersionCard
            key={v.id}
            version={v}
            projectKey={projectKey!}
            canAdmin={canAdmin}
            isFirst={i === 0}
            isLast={i === filtered.length - 1}
            onEdit={() => setEditing(v)}
            onDelete={() => setDeleting(v)}
            onRelease={() => release.mutate(v)}
            onMove={(position) => move.mutate({ id: v.id, position })}
            onNotes={async () => setNotes({ version: v, data: await fetchReleaseNotes(v.id) })}
          />
        ))}
        {(versions ?? []).filter((v) =>
          statusFilter === 'archived'
            ? v.archived
            : !v.archived && (statusFilter === 'released' ? v.released : !v.released)
        ).length === 0 && (
          <div className="border border-atl-n-30 rounded">
            <EmptyState
              title={versions?.length ? `No ${statusFilter} versions` : 'No versions yet'}
              description={canAdmin && !versions?.length ? 'Create one to start tracking a release.' : undefined}
            />
          </div>
        )}
      </div>

      <VersionModal
        editing={editing}
        projectKey={projectKey!}
        onClose={() => setEditing(null)}
        onSaved={invalidate}
      />

      <Modal open={Boolean(deleting)} onClose={() => setDeleting(null)}>
        <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
          <h2 className="text-lg font-semibold text-atl-n-800">Delete {deleting?.name}?</h2>
        </div>
        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-atl-n-600">Issues referencing this version keep their history.</p>
          <div>
            <label className={LABEL}>Move fix-version refs to (optional)</label>
            <select className={INPUT} value={swapFix} onChange={(e) => setSwapFix(e.target.value)}>
              <option value="">Just remove the refs</option>
              {(versions ?? []).filter((x) => x.id !== deleting?.id).map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL}>Move affects-version refs to (optional)</label>
            <select className={INPUT} value={swapAffected} onChange={(e) => setSwapAffected(e.target.value)}>
              <option value="">Just remove the refs</option>
              {(versions ?? []).filter((x) => x.id !== deleting?.id).map((x) => (
                <option key={x.id} value={x.id}>{x.name}</option>
              ))}
            </select>
          </div>
          {del.isError && <p className="text-xs text-atl-r-400">{(del.error as ApiError).message}</p>}
        </div>
        <div className="px-6 pb-5 flex justify-end gap-2">
          <button type="button" onClick={() => setDeleting(null)} className="h-8 px-3 rounded-[3px] bg-atl-n-20 text-sm text-atl-n-700 hover:bg-atl-n-30">
            Cancel
          </button>
          <button
            type="button"
            disabled={del.isPending}
            onClick={() => deleting && del.mutate(deleting)}
            className="h-8 px-3 rounded-[3px] bg-atl-r-300 text-white text-sm font-medium hover:bg-atl-r-400 disabled:opacity-40"
          >
            {del.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </Modal>

      <Modal open={Boolean(notes)} onClose={() => setNotes(null)}>
        <div className="px-6 pt-5 pb-4 border-b border-atl-n-30 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-atl-n-800">Release notes — {notes?.version.name}</h2>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => notes && download(`release-notes-${notes.version.name}.md`, notesToMarkdown(notes.data), 'text/markdown')}
              className="h-7 px-2.5 rounded-[3px] bg-atl-n-20 text-xs text-atl-n-700 hover:bg-atl-n-30"
            >
              Export .md
            </button>
            <button
              type="button"
              onClick={() => notes && download(`release-notes-${notes.version.name}.csv`, notesToCsv(notes.data), 'text/csv')}
              className="h-7 px-2.5 rounded-[3px] bg-atl-n-20 text-xs text-atl-n-700 hover:bg-atl-n-30"
            >
              Export .csv
            </button>
          </div>
        </div>
        <div className="px-6 py-4 max-h-[60vh] overflow-y-auto">
          {notes?.data.groups.length === 0 && <p className="text-sm text-atl-n-200">No resolved issues in this version.</p>}
          {notes?.data.groups.map((g) => (
            <div key={g.issueType.name} className="mb-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-atl-n-300 mb-1.5">{g.issueType.name}</h3>
              <ul className="space-y-1">
                {g.issues.map((i) => (
                  <li key={i.key} className="text-sm">
                    {/* Release notes list only resolved issues — Jira strikes them. */}
                    <IssueKeyLink
                      issueKey={i.key}
                      categoryKey="done"
                      className="text-atl-b-400 hover:underline font-medium"
                    />{' '}
                    <span className="text-atl-n-700">{i.summary}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

function VersionCard({
  version: v,
  projectKey,
  canAdmin,
  isFirst,
  isLast,
  onEdit,
  onDelete,
  onRelease,
  onMove,
  onNotes,
}: {
  version: Version;
  projectKey: string;
  canAdmin: boolean;
  isFirst: boolean;
  isLast: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRelease: () => void;
  onMove: (p: 'Earlier' | 'Later') => void;
  onNotes: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = useQuery({
    queryKey: ['versionCounts', v.id],
    queryFn: () => fetchVersionIssueCounts(v.id),
  });
  const issues = useQuery({
    queryKey: ['versionIssues', v.id],
    queryFn: () =>
      searchIssues(`project = ${projectKey} AND fixVersion = "${v.name}" ORDER BY status`, { maxResults: 100 }),
    enabled: expanded,
  });

  const total = counts.data?.issuesFixedCount ?? 0;
  const done = counts.data?.issuesDoneCount ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const byCategory = new Map<string, { name: string; issues: { key: string; summary: string; status: string; categoryKey: string }[] }>();
  for (const i of issues.data?.issues ?? []) {
    const cat = i.fields.status?.statusCategory?.key ?? 'new';
    if (!byCategory.has(cat)) byCategory.set(cat, { name: i.fields.status?.statusCategory?.name ?? cat, issues: [] });
    byCategory.get(cat)!.issues.push({ key: i.key, summary: i.fields.summary ?? '', status: i.fields.status?.name ?? '', categoryKey: cat });
  }
  const groups = [...byCategory.entries()].sort((a, b) => (CATEGORY_ORDER[a[0]] ?? 9) - (CATEGORY_ORDER[b[0]] ?? 9));

  return (
    <div className="border border-atl-n-30 rounded">
      <div className="px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="text-atl-n-200 hover:text-atl-n-500 w-4"
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-atl-n-800">{v.name}</span>
            {v.released ? (
              <span className="rounded-full bg-atl-g-100 text-atl-g-500 px-2 py-0.5 text-[11px] font-medium">Released</span>
            ) : (
              <span className="rounded-full bg-atl-b-50 text-atl-b-400 px-2 py-0.5 text-[11px] font-medium">Unreleased</span>
            )}
            {v.archived && (
              <span className="rounded-full bg-atl-n-20 text-atl-n-300 px-2 py-0.5 text-[11px] font-medium">Archived</span>
            )}
          </div>
          <div className="text-xs text-atl-n-200 mt-0.5">
            {v.startDate && `Start ${v.startDate.slice(0, 10)} · `}
            {v.releaseDate ? `Release ${v.releaseDate.slice(0, 10)}` : 'No release date'}
            {v.description && ` · ${v.description}`}
          </div>
          {total > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-atl-n-20 overflow-hidden">
                <div className="h-full bg-atl-g-400" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-xs text-atl-n-300">{done}/{total} done</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onNotes} className="h-7 px-2 rounded-[3px] bg-atl-n-20 text-xs text-atl-n-700 hover:bg-atl-n-30">
            Release notes
          </button>
          {canAdmin && !v.released && (
            <button type="button" onClick={onRelease} className="h-7 px-2 rounded-[3px] bg-atl-b-300 text-white text-xs font-medium hover:bg-atl-b-400">
              Release
            </button>
          )}
          {canAdmin && (
            <RowMenu
              items={[
                { label: 'Edit', onClick: onEdit },
                { label: 'Move earlier', onClick: () => onMove('Earlier'), disabled: isFirst },
                { label: 'Move later', onClick: () => onMove('Later'), disabled: isLast },
                { label: 'Delete', onClick: onDelete, danger: true },
              ]}
            />
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-atl-n-30 px-4 py-3 bg-atl-n-10">
          {issues.isLoading && <p className="text-xs text-atl-n-200">Loading issues…</p>}
          {groups.length === 0 && issues.data && (
            <p className="text-xs text-atl-n-200">No issues have this as a fix version.</p>
          )}
          {groups.map(([cat, g]) => (
            <div key={cat} className="mb-3 last:mb-0">
              <h4 className="text-[11px] font-semibold uppercase tracking-wide text-atl-n-300 mb-1">{g.name} ({g.issues.length})</h4>
              <ul className="space-y-1">
                {g.issues.map((i) => (
                  <li key={i.key} className="text-sm flex items-center gap-2">
                    <IssueKeyLink
                      issueKey={i.key}
                      categoryKey={i.categoryKey}
                      className="text-atl-b-400 hover:underline font-medium w-20 shrink-0"
                    />
                    <span className="text-atl-n-700 flex-1 truncate" title={i.summary}>{i.summary}</span>
                    <StatusLozenge name={i.status} categoryKey={i.categoryKey} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionModal({
  editing,
  projectKey,
  onClose,
  onSaved,
}: {
  editing: Version | 'new' | null;
  projectKey: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = editing === 'new';
  const v = isNew ? null : editing;
  const [name, setName] = useState(v?.name ?? '');
  const [description, setDescription] = useState(v?.description ?? '');
  const [startDate, setStartDate] = useState(v?.startDate?.slice(0, 10) ?? '');
  const [releaseDate, setReleaseDate] = useState(v?.releaseDate?.slice(0, 10) ?? '');
  const [released, setReleased] = useState(v?.released ?? false);
  const [archived, setArchived] = useState(v?.archived ?? false);
  const [err, setErr] = useState('');

  const save = useMutation({
    mutationFn: () =>
      isNew
        ? createVersion({
            project: projectKey, name,
            description: description || undefined,
            startDate: startDate || undefined, releaseDate: releaseDate || undefined,
            released, archived,
          })
        : updateVersion(v!.id, {
            name, description,
            startDate: startDate || undefined, releaseDate: releaseDate || undefined,
            released, archived,
          }),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e) => setErr((e as ApiError).message),
  });

  return (
    <Modal open={Boolean(editing)} onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-lg font-semibold text-atl-n-800">{isNew ? 'Create version' : `Edit ${v?.name}`}</h2>
      </div>
      <div className="px-6 py-4 space-y-4">
        {err && <div className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{err}</div>}
        <div>
          <label className={LABEL}>Name</label>
          <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. 1.2.0" />
        </div>
        <div>
          <label className={LABEL}>Description</label>
          <textarea className={INPUT + ' h-16 py-2 resize-y'} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={LABEL}>Start date</label>
            <input type="date" className={INPUT} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className={LABEL}>Release date</label>
            <input type="date" className={INPUT} value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-atl-n-700">
          <input type="checkbox" checked={released} onChange={(e) => setReleased(e.target.checked)} />
          Released
        </label>
        <label className="flex items-center gap-2 text-sm text-atl-n-700">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
          Archived (hidden from pickers)
        </label>
      </div>
      <div className="px-6 pb-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-8 px-3 rounded-[3px] bg-atl-n-20 text-sm text-atl-n-700 hover:bg-atl-n-30">
          Cancel
        </button>
        <button
          type="button"
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
          className="h-8 px-3 rounded-[3px] bg-atl-b-300 text-white text-sm font-medium hover:bg-atl-b-400 disabled:opacity-40"
        >
          {save.isPending ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

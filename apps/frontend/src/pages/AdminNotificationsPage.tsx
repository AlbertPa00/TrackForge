// 061 US3 — /admin/notifications: notification schemes (event → recipient
// matrix) and project binding. The 029 backend had no console at all.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  fetchNotificationSchemes, createNotificationScheme, updateNotificationScheme,
  deleteNotificationScheme, assignNotificationScheme, fetchProjects,
  type NotificationScheme, type NotificationSchemeEntry,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import { useFlag } from '../components/Flag.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT = 'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';
const BTN = 'h-8 px-3 rounded-[3px] text-sm font-medium';
const PRIMARY = BTN + ' bg-atl-b-400 hover:bg-atl-b-500 text-white disabled:opacity-40';
const SUBTLE = BTN + ' text-atl-n-500 hover:bg-atl-n-20';

// Model comments in schema.prisma (NotificationSchemeEntry).
const EVENTS = [
  'issue_created', 'issue_updated', 'issue_deleted', 'issue_assigned',
  'comment_created', 'work_logged', 'sprint_event', 'version_event',
  'mentioned', 'generic',
] as const;
const KINDS = [
  'reporter', 'assignee', 'watchers', 'mentioned', 'projectlead',
  'projectrole', 'group', 'user',
] as const;
const NEEDS_REF = new Set(['projectrole', 'group', 'user']);
const REF_HINT: Record<string, string> = {
  projectrole: 'Role id', group: 'Group name', user: 'Account id',
};

function SchemeDialog({ scheme, onClose }: { scheme: NotificationScheme | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(scheme?.name ?? '');
  const [description, setDescription] = useState(scheme?.description ?? '');
  const [entries, setEntries] = useState<NotificationSchemeEntry[]>(
    (scheme?.entries ?? []).map((e) => ({ event: e.event, recipientKind: e.recipientKind, recipientRef: e.recipientRef ?? undefined })),
  );
  const [error, setError] = useState('');

  const setEntry = (i: number, patch: Partial<NotificationSchemeEntry>) =>
    setEntries(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        entries: entries.map((e) => ({ ...e, channel: 'email' })),
      };
      return scheme ? updateNotificationScheme(scheme.id, body) : createNotificationScheme(body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notification-schemes'] });
      onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  return (
    <Modal open onClose={onClose}>
      <div className="p-5 w-[640px]">
        <h2 className="text-base font-semibold text-atl-n-800 mb-4">{scheme ? `Edit ${scheme.name}` : 'New notification scheme'}</h2>
        {error && <p className="rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500 mb-3">{error}</p>}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div><label className={LABEL}>Name</label><input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className={LABEL}>Description</label><input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        <label className={LABEL}>Notifications — who gets emailed on each event</label>
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {entries.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <select className={INPUT} value={e.event} onChange={(ev) => setEntry(i, { event: ev.target.value })}>
                {EVENTS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <select className={INPUT + ' !w-44'} value={e.recipientKind} onChange={(ev) => setEntry(i, { recipientKind: ev.target.value, recipientRef: undefined })}>
                {KINDS.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              {NEEDS_REF.has(e.recipientKind) && (
                <input
                  className={INPUT + ' !w-44 font-mono text-xs'}
                  placeholder={REF_HINT[e.recipientKind] ?? 'Ref'}
                  value={e.recipientRef ?? ''}
                  onChange={(ev) => setEntry(i, { recipientRef: ev.target.value || undefined })}
                />
              )}
              <button className={SUBTLE + ' text-atl-r-500 shrink-0'} onClick={() => setEntries(entries.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
        </div>
        <button
          className={SUBTLE + ' mt-2'}
          onClick={() => setEntries([...entries, { event: 'issue_updated', recipientKind: 'assignee' }])}
        >
          + Add notification
        </button>
        <div className="flex justify-end gap-2 mt-5">
          <button className={SUBTLE} onClick={onClose}>Cancel</button>
          <button
            className={PRIMARY}
            disabled={save.isPending || !name.trim() || entries.some((e) => NEEDS_REF.has(e.recipientKind) && !e.recipientRef?.trim())}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminNotificationsPage() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['notification-schemes'], queryFn: fetchNotificationSchemes });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [dlg, setDlg] = useState<NotificationScheme | null | 'new'>(null);
  const [deleting, setDeleting] = useState<NotificationScheme | null>(null);
  const [assigning, setAssigning] = useState<Record<string, string>>({});

  const del = useMutation({
    mutationFn: (id: string) => deleteNotificationScheme(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notification-schemes'] });
      setDeleting(null);
    },
  });
  const assign = useMutation({
    mutationFn: ({ projectKey, schemeId }: { projectKey: string; schemeId: string | null }) =>
      assignNotificationScheme(projectKey, schemeId),
    onSuccess: (_r, v) => {
      flag.success(v.schemeId ? `Bound to ${v.projectKey}` : `Unbound from ${v.projectKey}`);
      void qc.invalidateQueries({ queryKey: ['notification-schemes'] });
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Assignment failed'),
  });

  const rows = schemes.data?.schemes ?? [];
  const unboundProjects = (s: NotificationScheme) =>
    (projects.data ?? []).filter((p) => !(s.projects ?? []).some((b) => b.key === p.key));

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-atl-n-800">Notification schemes</h1>
        <button className={PRIMARY} onClick={() => setDlg('new')}>New scheme</button>
      </div>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-6">
        Who gets emailed on issue events, per project. Requires working SMTP (Administration → Mail).
      </p>

      {schemes.isLoading ? (
        <p className="text-sm text-atl-n-200">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="No schemes" description="Create a notification scheme to email users on issue events." />
      ) : (
        <section className="border border-atl-n-30 rounded bg-atl-paper">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-atl-n-200 border-b border-atl-n-30">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Notifications</th>
                <th className="px-3 py-2 font-medium">Projects</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-atl-n-30 last:border-0 align-top">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-atl-n-700">
                      {s.name}
                      {s.isDefault && <span className="ml-2 text-[10px] text-atl-n-300 border border-atl-n-40 rounded px-1">default</span>}
                    </div>
                    {s.description && <div className="text-xs text-atl-n-300">{s.description}</div>}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-atl-n-500">{s.entries.length} entr{s.entries.length === 1 ? 'y' : 'ies'}</td>
                  <td className="px-3 py-2.5 max-w-[300px]">
                    <div className="flex flex-wrap items-center gap-1">
                      {(s.projects ?? []).map((p) => (
                        <span key={p.key} className="inline-flex items-center gap-1 text-xs bg-atl-n-20 rounded px-1.5 py-0.5 text-atl-n-600">
                          {p.key}
                          <button
                            aria-label={`Unbind ${p.key}`}
                            className="text-atl-n-200 hover:text-atl-r-500"
                            onClick={() => assign.mutate({ projectKey: p.key, schemeId: null })}
                          >✕</button>
                        </span>
                      ))}
                      <select
                        className="h-6 text-xs border border-atl-n-40 rounded-[3px] text-atl-n-500"
                        value={assigning[s.id] ?? ''}
                        onChange={(e) => {
                          const key = e.target.value;
                          setAssigning({ ...assigning, [s.id]: '' });
                          if (key) assign.mutate({ projectKey: key, schemeId: s.id });
                        }}
                      >
                        <option value="">Bind project…</option>
                        {unboundProjects(s).map((p) => <option key={p.key} value={p.key}>{p.key} — {p.name}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right space-x-1 whitespace-nowrap">
                    <button className={SUBTLE} onClick={() => setDlg(s)}>Edit</button>
                    {!s.isDefault && (
                      <button className={SUBTLE + ' text-atl-r-500'} onClick={() => setDeleting(s)}>Delete</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {dlg === 'new' && <SchemeDialog scheme={null} onClose={() => setDlg(null)} />}
      {dlg && dlg !== 'new' && <SchemeDialog scheme={dlg} onClose={() => setDlg(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete "${deleting?.name ?? ''}"?`}
        body={`Projects bound to this scheme (${deleting?.projects?.length ?? 0}) fall back to the default notification scheme.`}
        confirmLabel="Delete scheme"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (deleting) del.mutate(deleting.id); }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

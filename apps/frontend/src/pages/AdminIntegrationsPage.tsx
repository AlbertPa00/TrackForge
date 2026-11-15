// 038/051 admin UI — /admin/integrations: GitLab dev-tool connections.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  fetchGitlabConnections,
  createGitlabConnection,
  updateGitlabConnection,
  deleteGitlabConnection,
  testGitlabConnection,
  backfillGitlabConnection,
  syncGitlabConnection,
  type GitlabConnection,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import { formatDateTime } from '../lib/format.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT =
  'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';
const BTN = 'h-8 px-3 rounded-[3px] text-sm font-medium';
const PRIMARY = BTN + ' bg-atl-b-400 hover:bg-atl-b-500 text-white disabled:opacity-40';
const SUBTLE = BTN + ' text-atl-n-500 hover:bg-atl-n-20';
const ERR = 'rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500';

function ConnDialog({
  conn,
  onClose,
  onSecret,
}: {
  conn: GitlabConnection | null;
  onClose: () => void;
  onSecret: (s: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(conn?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(conn?.baseUrl ?? 'https://gitlab.com');
  const [tokenRef, setTokenRef] = useState(conn?.apiTokenRef ?? 'env:GITLAB_TOKEN');
  const [groupPath, setGroupPath] = useState(conn?.groupPath ?? '');
  const [projectIds, setProjectIds] = useState((conn?.projectIds ?? []).join(', '));
  const [mode, setMode] = useState(conn?.mode ?? 'webhook');
  const [verifySsl, setVerifySsl] = useState(conn?.verifySsl ?? true);
  const [signingToken, setSigningToken] = useState('');
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(tokenRef.trim() ? { apiTokenRef: tokenRef.trim() } : {}),
        ...(groupPath.trim() ? { groupPath: groupPath.trim() } : {}),
        projectIds: projectIds
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n)),
        mode,
        verifySsl,
        ...(signingToken.trim() ? { signingToken: signingToken.trim() } : {}),
      };
      if (conn) return updateGitlabConnection(conn.id, body);
      return createGitlabConnection({ apiTokenRef: 'env:GITLAB_TOKEN', ...body });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['gitlab-conns'] });
      const s = (r as { webhookSecret?: string }).webhookSecret;
      if (s) onSecret(s);
      else onClose();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Save failed'),
  });

  return (
    <Modal open onClose={onClose}>
      <div className="p-5 w-[480px]">
        <h2 className="text-base font-semibold text-atl-n-800 mb-4">
          {conn ? 'Edit connection' : 'New GitLab connection'}
        </h2>
        {error && <div className={ERR + ' mb-3'}>{error}</div>}
        <div className="space-y-3">
          <div>
            <label className={LABEL}>Name</label>
            <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className={LABEL}>Base URL</label>
            <input
              className={INPUT + ' font-mono text-xs'}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div>
            <label className={LABEL}>API token secret ref (env:VAR)</label>
            <input
              className={INPUT + ' font-mono text-xs'}
              value={tokenRef}
              onChange={(e) => setTokenRef(e.target.value)}
              placeholder={conn?.apiTokenRef ?? ''}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Group path (optional)</label>
              <input
                className={INPUT + ' font-mono text-xs'}
                value={groupPath}
                onChange={(e) => setGroupPath(e.target.value)}
              />
            </div>
            <div>
              <label className={LABEL}>Project IDs (csv, optional)</label>
              <input
                className={INPUT + ' font-mono text-xs'}
                value={projectIds}
                onChange={(e) => setProjectIds(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Sync mode</label>
              <select
                className={INPUT}
                value={mode}
                onChange={(e) => setMode(e.target.value as 'webhook' | 'poll' | 'both')}
              >
                <option value="webhook">Webhook</option>
                <option value="poll">Polling</option>
                <option value="both">Both</option>
              </select>
            </div>
            <div>
              <label className={LABEL}>Signing token (optional)</label>
              <input
                className={INPUT + ' font-mono text-xs'}
                value={signingToken}
                onChange={(e) => setSigningToken(e.target.value)}
                placeholder={conn?.hasSigningToken ? '(unchanged)' : ''}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-atl-n-600">
            <input type="checkbox" checked={verifySsl} onChange={(e) => setVerifySsl(e.target.checked)} /> Verify TLS
            certificates
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className={SUBTLE} onClick={onClose}>
            Cancel
          </button>
          <button
            className={PRIMARY}
            disabled={save.isPending || !name.trim() || !baseUrl.trim()}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ConnRow({
  conn,
  onEdit,
  onDelete,
}: {
  conn: GitlabConnection;
  onEdit: (c: GitlabConnection) => void;
  onDelete: (c: GitlabConnection) => void;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const inv = () => void qc.invalidateQueries({ queryKey: ['gitlab-conns'] });
  const act = (fn: () => Promise<unknown>, ok: string) => async () => {
    setNote('');
    try {
      const r = (await fn()) as { ok?: boolean; error?: string; queued?: boolean };
      setNote(r && r.ok === false ? (r.error ?? 'Failed') : ok);
      inv();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'Failed');
    }
  };
  return (
    <tr className="border-b border-atl-n-30 last:border-0">
      <td className="px-3 py-2.5">
        <div className="font-medium text-atl-n-700">{conn.name}</div>
        <div className="text-xs text-atl-n-300 font-mono">{conn.baseUrl}</div>
        <div className="text-[10px] text-atl-n-200 font-mono mt-0.5">{conn.webhookUrl}</div>
      </td>
      <td className="px-3 py-2.5 text-xs text-atl-n-500">
        {conn.mode}
        {conn.groupPath ? ` · ${conn.groupPath}` : ''}
      </td>
      <td className="px-3 py-2.5 text-sm">
        {conn.enabled ? (
          <span className="text-atl-g-500 font-medium">Enabled</span>
        ) : (
          <span className="text-atl-n-300">Disabled</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-xs text-atl-n-400">
        {conn.lastError ? (
          <span className="text-atl-r-500">{conn.lastError}</span>
        ) : conn.lastTestAt ? (
          `tested ${formatDateTime(conn.lastTestAt)}`
        ) : (
          '—'
        )}
      </td>
      <td className="px-3 py-2.5 text-right space-x-1 whitespace-nowrap">
        <button className={SUBTLE} onClick={act(() => testGitlabConnection(conn.id), 'Connected')}>
          Test
        </button>
        <button className={SUBTLE} onClick={act(() => backfillGitlabConnection(conn.id), 'Backfill queued')}>
          Backfill
        </button>
        {conn.mode !== 'webhook' && (
          <button className={SUBTLE} onClick={act(() => syncGitlabConnection(conn.id), 'Synced')}>
            Poll now
          </button>
        )}
        <button
          className={SUBTLE}
          onClick={act(
            () => updateGitlabConnection(conn.id, { enabled: !conn.enabled }),
            conn.enabled ? 'Disabled' : 'Enabled'
          )}
        >
          {conn.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className={SUBTLE} onClick={() => onEdit(conn)}>
          Edit
        </button>
        <button className={SUBTLE + ' text-atl-r-500'} onClick={() => onDelete(conn)}>
          Delete
        </button>
        {note && <span className="block text-xs text-atl-n-300 mt-1">{note}</span>}
      </td>
    </tr>
  );
}

export default function AdminIntegrationsPage() {
  const qc = useQueryClient();
  const conns = useQuery({ queryKey: ['gitlab-conns'], queryFn: fetchGitlabConnections });
  const [dlg, setDlg] = useState<GitlabConnection | null | 'new'>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<GitlabConnection | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => deleteGitlabConnection(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gitlab-conns'] });
      setDeleting(null);
    },
  });

  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-atl-n-800">Development integrations</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-6">
        GitLab connections feed the Development panel — commits, branches, MRs, pipelines.
      </p>

      <section className="border border-atl-n-30 rounded bg-atl-paper">
        <div className="px-4 py-2.5 border-b border-atl-n-30 flex items-center justify-between">
          <h2 className="text-xs font-semibold text-atl-n-300">GitLab connections</h2>
          <button className={PRIMARY} onClick={() => setDlg('new')}>
            New connection
          </button>
        </div>
        {!conns.data?.connections.length ? (
          <EmptyState
            title="No connections"
            description="Connect a GitLab instance to link commits and merge requests to issues."
          />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-atl-n-200 border-b border-atl-n-30">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Mode</th>
                <th className="px-3 py-2 font-medium">State</th>
                <th className="px-3 py-2 font-medium">Last check</th>
                <th className="px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {conns.data!.connections.map((c) => (
                <ConnRow key={c.id} conn={c} onEdit={setDlg} onDelete={setDeleting} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {dlg === 'new' && <ConnDialog conn={null} onClose={() => setDlg(null)} onSecret={setSecret} />}
      {dlg && dlg !== 'new' && <ConnDialog conn={dlg} onClose={() => setDlg(null)} onSecret={setSecret} />}
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete "${deleting?.name ?? ''}"?`}
        body="This stops Development panel sync for the connection's projects and disables its webhook endpoint. Commits and branches already linked to issues are kept."
        confirmLabel="Delete connection"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => {
          if (deleting) del.mutate(deleting.id);
        }}
        onClose={() => setDeleting(null)}
      />
      {secret && (
        <Modal
          open
          onClose={() => {
            setSecret(null);
            setDlg(null);
          }}
        >
          <div className="p-5 max-w-lg">
            <h2 className="text-base font-semibold text-atl-n-800 mb-2">Webhook secret</h2>
            <p className="text-sm text-atl-n-500 mb-3">
              Configure this secret on the GitLab webhook. It is never shown again.
            </p>
            <code className="block break-all rounded bg-atl-n-10 border border-atl-n-30 px-3 py-2 text-xs font-mono text-atl-n-700">
              {secret}
            </code>
            <div className="flex justify-end mt-4">
              <button
                className={PRIMARY}
                onClick={() => {
                  setSecret(null);
                  setDlg(null);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

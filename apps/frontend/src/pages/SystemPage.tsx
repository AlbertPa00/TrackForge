// 044 US3 — /admin/system: instance health, backup management, support zip.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchSystemStatus,
  fetchBackups,
  runBackupNow,
  verifyBackupSet,
  supportZipUrl,
  runUpdateCheck,
  fetchBanner,
  setBanner,
  previewBackupRestore,
  restoreBackup,
  fetchRestoreStatus,
  type RestorePreview,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import EmptyState from '../components/EmptyState.js';
import { formatDateTime } from '../lib/format.js';

const fmt = (s: number) => {
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

function CheckBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        background: ok ? 'var(--tf-success-bg)' : 'var(--tf-danger-bg)',
        color: ok ? 'var(--tf-success)' : 'var(--tf-danger)',
      }}
    >
      <span aria-hidden>{ok ? '✓' : '✗'}</span>
      {label}
    </span>
  );
}

export default function SystemPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['system-status'], queryFn: fetchSystemStatus, refetchInterval: 15_000 });
  const backups = useQuery({ queryKey: ['system-backups'], queryFn: fetchBackups });
  const [verifyMsg, setVerifyMsg] = useState<Record<string, string>>({});
  const [restoreFor, setRestoreFor] = useState<RestorePreview | null>(null);
  const restore = useQuery({
    queryKey: ['restore-status'],
    queryFn: fetchRestoreStatus,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 2000 : 15_000),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['system-status'] });
    void qc.invalidateQueries({ queryKey: ['system-backups'] });
  };
  const run = useMutation({ mutationFn: runBackupNow, onSuccess: invalidate });
  const check = useMutation({ mutationFn: runUpdateCheck, onSuccess: invalidate });
  const verify = useMutation({
    mutationFn: verifyBackupSet,
    onSuccess: (r) =>
      setVerifyMsg((p) => ({ ...p, [r.id]: r.ok ? 'checksums OK' : `MISMATCH: ${r.mismatched.join(', ')}` })),
  });
  const s = status.data;

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-semibold text-atl-n-800 mb-1">System</h1>
      <p style={{ color: 'var(--tf-text-subtle)', marginTop: 0 }}>Instance health, backups, and diagnostics.</p>

      {status.isError && <p role="alert">Failed to load system status.</p>}
      {s && (
        <section style={{ border: '1px solid var(--tf-border)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
          <h2 style={{ fontSize: 14, marginTop: 0 }}>Instance</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: '160px 1fr', rowGap: 6, margin: 0 }}>
            <dt>Version</dt>
            <dd style={{ margin: 0 }}>
              {s.version} <code style={{ fontSize: 11 }}>({s.scm})</code>
            </dd>
            <dt>Uptime</dt>
            <dd style={{ margin: 0 }}>{fmt(s.uptimeSec)}</dd>
            <dt>Queue</dt>
            <dd style={{ margin: 0 }}>
              {s.queue.waiting} waiting · {s.queue.failed} failed
            </dd>
            <dt>Checks</dt>
            <dd style={{ margin: 0, display: 'flex', gap: 8 }}>
              {Object.entries(s.checks).map(([k, v]) => (
                <CheckBadge key={k} ok={v === 'ok'} label={`${k} ${v}`} />
              ))}
            </dd>
            <dt>Updates</dt>
            <dd style={{ margin: 0 }}>
              {!s.updateCheckEnabled ? (
                <span style={{ color: 'var(--tf-text-subtle)' }}>update check disabled (UPDATE_CHECK_ENABLED)</span>
              ) : s.update?.updateAvailable ? (
                <CheckBadge ok={false} label={`Update available: ${s.update.latest}`} />
              ) : (
                <CheckBadge ok label={s.update ? `up to date (${s.update.latest})` : 'no check yet'} />
              )}
              {s.updateCheckEnabled && (
                <button
                  onClick={() => check.mutate()}
                  disabled={check.isPending}
                  style={{ padding: '2px 8px', fontSize: 12, marginLeft: 8 }}
                >
                  {check.isPending ? 'Checking…' : 'Check now'}
                </button>
              )}
              {s.update?.error && <span style={{ color: 'var(--tf-danger)', marginLeft: 8 }}>{s.update.error}</span>}
              {s.update?.url && s.update.updateAvailable && (
                <a href={s.update.url} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}>
                  Release notes
                </a>
              )}
            </dd>
          </dl>
        </section>
      )}

      <section style={{ border: '1px solid var(--tf-border)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 14, margin: 0 }}>Backups</h2>
          <button onClick={() => run.mutate()} disabled={run.isPending} style={{ padding: '6px 12px' }}>
            {run.isPending ? 'Running…' : 'Run backup now'}
          </button>
        </div>
        {s?.backup && (
          <p style={{ fontSize: 13, marginBottom: 8 }}>
            Last run: <CheckBadge ok={s.backup.ok} label={s.backup.ok ? `ok ${s.backup.id ?? ''}` : 'failed'} />{' '}
            {formatDateTime(s.backup.at)}
            {s.backup.error && <span style={{ color: 'var(--tf-danger)' }}> — {s.backup.error}</span>}
          </p>
        )}
        {restore.data && restore.data.state !== 'idle' && (
          <p role="status" style={{ fontSize: 13, marginBottom: 8 }}>
            Restore:{' '}
            {restore.data.state === 'running' ? (
              <CheckBadge ok={false} label={`restoring ${restore.data.backupId}… you may be signed out`} />
            ) : restore.data.state === 'done' ? (
              <CheckBadge ok label={`restored ${restore.data.backupId}`} />
            ) : (
              <CheckBadge ok={false} label={`restore failed${restore.data.error ? ` — ${restore.data.error}` : ''}`} />
            )}
          </p>
        )}
        {run.isError && (
          <p role="alert" style={{ color: 'var(--tf-danger)' }}>
            {(run.error as Error).message}
          </p>
        )}
        {(backups.data?.backups.length ?? 0) === 0 ? (
          <EmptyState title="No backups yet" description="Scheduled backups run daily in production; or run one now." />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--tf-text-subtle)' }}>
                <th style={{ padding: '6px 4px' }}>Backup</th>
                <th>Created</th>
                <th>Issues</th>
                <th>Version</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {backups.data!.backups.map((b) => (
                <tr key={b.id} style={{ borderTop: '1px solid var(--tf-border)' }}>
                  <td style={{ padding: '6px 4px' }}>
                    <code>{b.id}</code>
                  </td>
                  <td>{formatDateTime(b.createdAt)}</td>
                  <td>{b.counts.issues ?? '—'}</td>
                  <td>{b.version}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button onClick={() => verify.mutate(b.id)} style={{ padding: '2px 8px', fontSize: 12 }}>
                      Verify
                    </button>
                    <button
                      onClick={async () => setRestoreFor(await previewBackupRestore(b.id).catch(() => null))}
                      style={{ padding: '2px 8px', fontSize: 12, marginLeft: 4, color: 'var(--tf-danger)' }}
                    >
                      Restore
                    </button>
                    {verifyMsg[b.id] && <span style={{ marginLeft: 8, fontSize: 12 }}>{verifyMsg[b.id]}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ border: '1px solid var(--tf-border)', borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Announcement banner</h2>
        <p style={{ fontSize: 13, color: 'var(--tf-text-subtle)' }}>
          Shown site-wide under the top navigation. Leave empty to hide.
        </p>
        <BannerEditor />
      </section>

      <section style={{ border: '1px solid var(--tf-border)', borderRadius: 8, padding: 16 }}>
        <h2 style={{ fontSize: 14, marginTop: 0 }}>Support</h2>
        <p style={{ fontSize: 13 }}>
          Download a sanitized diagnostics bundle — version, config with secrets redacted, health checks, and recent job
          errors.
        </p>
        <a href={supportZipUrl} download>
          <button style={{ padding: '6px 12px' }}>Download support zip</button>
        </a>
      </section>

      {restoreFor && <RestoreDialog preview={restoreFor} onClose={() => setRestoreFor(null)} />}
    </div>
  );
}

/** 061 US4 — typed-confirmation restore dialog. The dryRun preview carries the
 *  manifest + confirmToken; launch fires only after the user types RESTORE. */
function RestoreDialog({ preview, onClose }: { preview: RestorePreview; onClose: () => void }) {
  const qc = useQueryClient();
  const [phrase, setPhrase] = useState('');
  const launch = useMutation({
    mutationFn: () => restoreBackup(preview.preview.id, preview.confirmToken),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['restore-status'] });
      onClose();
    },
  });
  return (
    <Modal open onClose={onClose} labelledBy="restore-title">
      <div className="p-6 w-[520px]">
        <h2 id="restore-title" className="text-[18px] font-medium text-atl-n-800 mb-2">
          Restore database from backup
        </h2>
        <dl style={{ display: 'grid', gridTemplateColumns: '110px 1fr', rowGap: 4, fontSize: 13, margin: '0 0 12px' }}>
          <dt style={{ color: 'var(--tf-text-subtle)' }}>Backup</dt>
          <dd style={{ margin: 0 }}>
            <code>{preview.preview.id}</code>
          </dd>
          <dt style={{ color: 'var(--tf-text-subtle)' }}>Created</dt>
          <dd style={{ margin: 0 }}>{formatDateTime(preview.preview.createdAt)}</dd>
          <dt style={{ color: 'var(--tf-text-subtle)' }}>Version</dt>
          <dd style={{ margin: 0 }}>{preview.preview.version}</dd>
          <dt style={{ color: 'var(--tf-text-subtle)' }}>Issues</dt>
          <dd style={{ margin: 0 }}>{preview.preview.counts.issues ?? '—'}</dd>
        </dl>
        <p
          role="alert"
          style={{
            fontSize: 13,
            color: 'var(--tf-danger)',
            background: 'var(--tf-danger-bg)',
            padding: '8px 10px',
            borderRadius: 4,
          }}
        >
          {preview.warning}
        </p>
        <label className="block text-sm text-atl-n-700 mb-3">
          Type <code className="font-semibold">RESTORE</code> to confirm
          <input
            className="mt-1 w-full rounded-[3px] border border-atl-n-40 px-2 py-1.5"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            autoFocus
          />
        </label>
        {launch.isError && (
          <p role="alert" style={{ color: 'var(--tf-danger)', fontSize: 13 }}>
            {(launch.error as Error).message}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <button onClick={onClose} style={{ padding: '6px 12px' }}>
            Cancel
          </button>
          <button
            onClick={() => launch.mutate()}
            disabled={phrase !== 'RESTORE' || launch.isPending}
            style={{ padding: '6px 12px', background: 'var(--tf-danger)', color: '#fff', borderRadius: 3, border: 0 }}
          >
            {launch.isPending ? 'Restoring…' : 'Restore now'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 060 stretch — Jira "Announcement banner" editor. */
function BannerEditor() {
  const qc = useQueryClient();
  const banner = useQuery({ queryKey: ['banner'], queryFn: fetchBanner });
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => setBanner(text ?? ''),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['banner'] }),
  });
  const value = text ?? banner.data?.message ?? '';
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <textarea
        rows={2}
        style={{ flex: 1, padding: '6px 8px', fontSize: 13, border: '1px solid var(--tf-border)', borderRadius: 6 }}
        placeholder="Maintenance window Sunday 02:00–04:00 UTC…"
        value={value}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        style={{ padding: '6px 12px', alignSelf: 'flex-end' }}
        disabled={save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

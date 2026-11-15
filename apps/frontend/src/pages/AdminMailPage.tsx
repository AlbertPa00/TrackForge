// 061 US3 — /admin/mail: SMTP configuration, test send, and the outbox.
// The endpoints shipped in 029 but had no console — invites, resets and
// notifications silently degrade when this is unconfigured.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  fetchMailConfig, saveMailConfig, testMailConfig, fetchMailOutbox,
  type MailConfig,
} from '../api/client.js';
import { useFlag } from '../components/Flag.js';
import EmptyState from '../components/EmptyState.js';
import { formatDate } from '../lib/format.js';

const LABEL = 'block text-xs font-semibold text-atl-n-300 mb-1';
const INPUT = 'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';
const BTN = 'h-8 px-3 rounded-[3px] text-sm font-medium';
const PRIMARY = BTN + ' bg-atl-b-400 hover:bg-atl-b-500 text-white disabled:opacity-40';
const SUBTLE = BTN + ' text-atl-n-500 hover:bg-atl-n-20';
const STATUSES = ['', 'pending', 'sent', 'failed', 'skipped', 'digest'] as const;

function SmtpTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const { data: cfg, isLoading } = useQuery({ queryKey: ['admin-mail'], queryFn: fetchMailConfig });
  const [f, setF] = useState<Partial<MailConfig> | null>(null);
  const [pass, setPass] = useState('');
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState('');

  // Snapshot the loaded config once so typing doesn't refetch-reset.
  const form = f ?? (cfg ? { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, from: cfg.from, baseUrl: cfg.baseUrl } : null);
  const set = (k: keyof MailConfig, v: unknown) => setF({ ...(form as MailConfig), [k]: v });

  const save = useMutation({
    mutationFn: () => saveMailConfig({ ...form, ...(pass ? { pass } : {}) }),
    onSuccess: () => {
      flag.success('Mail settings saved');
      setPass('');
      setF(null);
      void qc.invalidateQueries({ queryKey: ['admin-mail'] });
    },
    onError: (e) => flag.error(e instanceof ApiError ? e.message : 'Save failed'),
  });
  const test = useMutation({
    mutationFn: () => testMailConfig(testTo.trim() || undefined),
    onSuccess: (d) => setTestMsg(`Test mail sent to ${d.to}`),
    onError: (e) => setTestMsg(e instanceof ApiError ? e.message : 'Test failed'),
  });

  if (isLoading || !form) return <p className="text-sm text-atl-n-200">Loading…</p>;
  const env = cfg?.envOverrides ?? [];
  return (
    <div className="max-w-xl space-y-4">
      {env.length > 0 && (
        <p className="rounded-[3px] border border-atl-y-300 bg-atl-y-50 px-3 py-2 text-xs text-atl-y-500">
          These fields are overridden by environment variables and editing them here has no effect: <span className="font-mono">{env.join(', ')}</span>
        </p>
      )}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2"><label className={LABEL}>SMTP host</label><input className={INPUT} value={form.host ?? ''} onChange={(e) => set('host', e.target.value)} /></div>
        <div><label className={LABEL}>Port</label><input className={INPUT} type="number" value={form.port ?? 0} onChange={(e) => set('port', Number(e.target.value))} /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={LABEL}>Username (optional)</label><input className={INPUT} value={form.user ?? ''} onChange={(e) => set('user', e.target.value || undefined)} /></div>
        <div><label className={LABEL}>Password</label><input className={INPUT} type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={cfg?.pass ? '(unchanged)' : '(not set)'} /></div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className={LABEL}>From address</label><input className={INPUT} value={form.from ?? ''} onChange={(e) => set('from', e.target.value)} /></div>
        <div><label className={LABEL}>Base URL (links in mail)</label><input className={INPUT} value={form.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)} /></div>
      </div>
      <label className="flex items-center gap-2 text-sm text-atl-n-600">
        <input type="checkbox" checked={form.secure ?? false} onChange={(e) => set('secure', e.target.checked)} />
        Use TLS (SMTPS / STARTTLS as the server offers)
      </label>
      <div className="flex items-center gap-3 pt-1">
        <button className={PRIMARY} disabled={save.isPending || !form.host || !form.from} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <div className="flex items-center gap-2 border-l border-atl-n-30 pl-3">
          <input className={INPUT + ' !w-56'} placeholder="Test recipient (blank = you)" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <button className={SUBTLE} disabled={test.isPending} onClick={() => { setTestMsg(''); test.mutate(); }}>
            {test.isPending ? 'Sending…' : 'Send test'}
          </button>
        </div>
      </div>
      {testMsg && <p className={`text-xs ${testMsg.startsWith('Test mail') ? 'text-atl-g-500' : 'text-atl-r-500'}`}>{testMsg}</p>}
      <p className="text-xs text-atl-n-200">
        When this is unconfigured, user invites, password resets and notification mail silently do nothing — the Users page will show a copyable invite link instead.
      </p>
    </div>
  );
}

function OutboxTab() {
  const [status, setStatus] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['admin-outbox', status],
    queryFn: () => fetchMailOutbox(status || undefined),
  });
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <select className={INPUT + ' !w-44'} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
        </select>
        {data && <span className="text-xs text-atl-n-300">{data.total} message{data.total === 1 ? '' : 's'}</span>}
      </div>
      {isLoading ? (
        <p className="text-sm text-atl-n-200">Loading…</p>
      ) : !data || data.outbox.length === 0 ? (
        <EmptyState title="No mail" description="Queued and sent mail appears here." />
      ) : (
        <table className="w-full text-sm border border-atl-n-30 rounded-[3px] overflow-hidden">
          <thead>
            <tr className="bg-atl-n-10 text-left text-xs uppercase text-atl-n-200">
              <th className="px-3 py-2">To</th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Event</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {data.outbox.map((r) => (
              <tr key={r.id} className="border-t border-atl-n-30 align-top">
                <td className="px-3 py-2 text-xs text-atl-n-600">{r.toEmail}</td>
                <td className="px-3 py-2 text-atl-n-700 max-w-[280px]">
                  <div className="truncate" title={r.subject}>{r.subject}</div>
                  {r.error && <div className="text-xs text-atl-r-500 truncate" title={r.error}>{r.error}</div>}
                </td>
                <td className="px-3 py-2 text-xs text-atl-n-400">{r.eventType ?? '—'}{r.issueKey ? ` · ${r.issueKey}` : ''}</td>
                <td className="px-3 py-2">
                  <span className={`text-[11px] font-medium rounded px-1.5 py-0.5 ${
                    r.status === 'sent' ? 'text-atl-g-500 bg-atl-g-50'
                      : r.status === 'failed' ? 'text-atl-r-500 bg-atl-r-50'
                        : 'text-atl-n-300 bg-atl-n-20'
                  }`}>
                    {r.status}{r.attempts > 1 ? ` ×${r.attempts}` : ''}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-atl-n-300 whitespace-nowrap">{formatDate(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function AdminMailPage() {
  const [tab, setTab] = useState<'smtp' | 'outbox'>('smtp');
  return (
    <div className="p-6 max-w-5xl">
      <h1 className="text-xl font-semibold text-atl-n-800">Mail</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-6">Outbound SMTP configuration and the delivery outbox.</p>
      <div className="flex gap-1 border-b border-atl-n-30 mb-6">
        {(['smtp', 'outbox'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t ${tab === t ? 'bg-atl-paper border border-b-white border-atl-n-30 -mb-px text-atl-b-400' : 'text-atl-n-300 hover:text-atl-n-500'}`}
          >
            {t === 'smtp' ? 'SMTP' : 'Outbox'}
          </button>
        ))}
      </div>
      {tab === 'smtp' ? <SmtpTab /> : <OutboxTab />}
    </div>
  );
}

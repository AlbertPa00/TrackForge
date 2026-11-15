// 021 US2 — /admin/audit: filtered audit viewer + CSV export + JSON detail.
import { useState, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchAdminUsers, fetchAuditEvents, fetchAuditActions, auditCsvUrl, type AuditFilter } from '../api/client.js';
import EmptyState from '../components/EmptyState.js';
import { formatDateTime } from '../lib/format.js';

const PAGE = 50;
const input = 'border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';
const fmt = (iso: string) => formatDateTime(iso);

export default function AdminAuditPage() {
  const [params, setParams] = useSearchParams();
  const [startAt, setStartAt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const users = useQuery({ queryKey: ['admin-users'], queryFn: fetchAdminUsers });
  // 061 US7 — distinct action names so the filter isn't guess-typing.
  const actions = useQuery({ queryKey: ['audit-actions'], queryFn: fetchAuditActions, staleTime: 60_000 });

  const filter: AuditFilter = {
    actorId: params.get('actorId') ?? undefined,
    action: params.get('action') ?? undefined,
    entityType: params.get('entityType') ?? undefined,
    entityId: params.get('entityId') ?? undefined,
    from: params.get('from') ?? undefined,
    to: params.get('to') ?? undefined,
  };
  const set = (k: string, v: string) => {
    setStartAt(0);
    setParams(
      (p) => {
        if (v) p.set(k, v);
        else p.delete(k);
        return p;
      },
      { replace: true }
    );
  };

  const audit = useQuery({
    queryKey: ['admin-audit', filter, startAt],
    queryFn: () => fetchAuditEvents({ ...filter, startAt, maxResults: PAGE }),
  });
  const total = audit.data?.total ?? 0;
  const events = audit.data?.events ?? [];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-atl-n-800">Audit log</h1>
          <p className="text-sm text-atl-n-200 mt-0.5">Who did what — configuration, auth, content mutations.</p>
        </div>
        <a
          className="px-3 py-1.5 text-sm font-medium text-atl-b-400 border border-atl-b-75 hover:bg-atl-b-50 rounded"
          href={auditCsvUrl({ ...filter, maxResults: 1000 })}
          download
        >
          Export CSV
        </a>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select className={input} value={filter.actorId ?? ''} onChange={(e) => set('actorId', e.target.value)}>
          <option value="">Any actor</option>
          {(users.data ?? []).map((u) => (
            <option key={u.accountId} value={u.accountId}>
              {u.displayName}
            </option>
          ))}
        </select>
        <input
          className={`${input} w-40`}
          placeholder="Action (e.g. user.updated)"
          list="audit-action-names"
          value={filter.action ?? ''}
          onChange={(e) => set('action', e.target.value)}
        />
        <datalist id="audit-action-names">
          {(actions.data ?? []).map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
        <input
          className={`${input} w-32`}
          placeholder="Entity type"
          value={filter.entityType ?? ''}
          onChange={(e) => set('entityType', e.target.value)}
        />
        <input
          className={`${input} w-44`}
          placeholder="Entity id"
          value={filter.entityId ?? ''}
          onChange={(e) => set('entityId', e.target.value)}
        />
        <input
          className={input}
          type="date"
          value={filter.from ?? ''}
          onChange={(e) => set('from', e.target.value)}
          aria-label="From date"
        />
        <input
          className={input}
          type="date"
          value={filter.to ?? ''}
          onChange={(e) => set('to', e.target.value)}
          aria-label="To date"
        />
        {Object.values(filter).some(Boolean) && (
          <button
            className="text-sm text-atl-b-400 hover:underline"
            onClick={() => {
              setStartAt(0);
              setParams({}, { replace: true });
            }}
          >
            Clear
          </button>
        )}
      </div>

      {audit.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {audit.data && events.length === 0 && <EmptyState title="No audit events match" />}

      {events.length > 0 && (
        <div className="bg-atl-paper border border-atl-n-30 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Actor</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Entity</th>
                <th className="px-4 py-2">IP</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <Fragment key={e.id}>
                  <tr className="border-b border-atl-n-20">
                    <td className="px-4 py-2 text-atl-n-500 text-xs whitespace-nowrap">{fmt(e.createdAt)}</td>
                    <td className="px-4 py-2 text-atl-n-800">
                      {e.actor?.displayName ?? '—'}
                      {e.actor?.agent && <span className="ml-1 text-[11px] text-atl-p-300">agent</span>}
                    </td>
                    <td className="px-4 py-2">
                      <code className="text-[13px] text-atl-n-700">{e.action}</code>
                    </td>
                    <td className="px-4 py-2 text-atl-n-500 text-xs" title={e.entityId ?? undefined}>
                      {e.entityType ?? '—'}
                      {e.entityId ? ` · ${e.entityId.slice(0, 8)}…` : ''}
                    </td>
                    <td className="px-4 py-2 text-atl-n-300 text-xs">{e.ip ?? '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        className="text-sm text-atl-b-400 hover:underline"
                        onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                      >
                        {expanded === e.id ? 'Hide' : 'Detail'}
                      </button>
                    </td>
                  </tr>
                  {expanded === e.id && (
                    <tr className="border-b border-atl-n-20 bg-atl-n-10">
                      <td colSpan={6} className="px-4 py-3">
                        <pre className="text-xs text-atl-n-600 whitespace-pre-wrap break-all">
                          {JSON.stringify({ entityId: e.entityId, details: e.details }, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE && (
        <div className="mt-3 flex items-center gap-3 text-sm text-atl-n-500">
          <button
            className="text-atl-b-400 hover:underline disabled:text-atl-n-100 disabled:no-underline"
            disabled={startAt === 0}
            onClick={() => setStartAt(Math.max(0, startAt - PAGE))}
          >
            ← Previous
          </button>
          <span>
            {startAt + 1}–{Math.min(total, startAt + PAGE)} of {total}
          </span>
          <button
            className="text-atl-b-400 hover:underline disabled:text-atl-n-100 disabled:no-underline"
            disabled={startAt + PAGE >= total}
            onClick={() => setStartAt(startAt + PAGE)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

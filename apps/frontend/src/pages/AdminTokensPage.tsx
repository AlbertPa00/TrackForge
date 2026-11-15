// 021 US2 — /admin/tokens: every user's PATs, revoke, jump to token audit trail.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAllAdminTokens, revokeToken, type AdminUser, type ApiTokenInfo } from '../api/client.js';
import Modal from '../components/Modal.js';
import EmptyState from '../components/EmptyState.js';
import { formatDateTime } from '../lib/format.js';

interface Row extends ApiTokenInfo {
  owner: AdminUser;
}

const fmt = (iso: string | null) => (iso ? formatDateTime(iso) : '—');

export default function AdminTokensPage() {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<Row | null>(null);
  const [filter, setFilter] = useState('');

  // 061 US5 — aggregate endpoint: 1 request instead of 1 + N users fan-out.
  const tokens = useQuery({ queryKey: ['admin-tokens'], queryFn: fetchAllAdminTokens });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeToken(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-tokens'] });
      setConfirm(null);
    },
  });

  const rows = (tokens.data ?? []).filter((r) => {
    const q = filter.toLowerCase();
    return (
      !q ||
      r.name.toLowerCase().includes(q) ||
      r.owner.displayName.toLowerCase().includes(q) ||
      r.owner.emailAddress.toLowerCase().includes(q)
    );
  });

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-atl-n-800">API tokens</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-4">
        Personal access tokens across all users. Revoking takes effect immediately.
      </p>

      <input
        className="mb-3 w-72 border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm"
        placeholder="Filter by name or owner"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />

      {tokens.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {tokens.data && rows.length === 0 && <EmptyState title="No tokens" />}

      {rows.length > 0 && (
        <div className="bg-atl-paper border border-atl-n-30 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Owner</th>
                <th className="px-4 py-2">Scopes</th>
                <th className="px-4 py-2">Projects</th>
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-atl-n-20 last:border-0">
                  <td className="px-4 py-2 text-atl-n-800">
                    {t.name} <span className="text-xs text-atl-n-100">{t.prefix}…</span>
                  </td>
                  <td className="px-4 py-2 text-atl-n-500">
                    {t.owner.displayName}
                    <span className="text-xs text-atl-n-100"> · {t.owner.emailAddress}</span>
                  </td>
                  <td className="px-4 py-2">
                    {t.scopes.map((s) => (
                      <span
                        key={s}
                        className="mr-1 text-[11px] font-medium text-atl-n-500 bg-atl-n-20 rounded px-1.5 py-0.5"
                      >
                        {s}
                      </span>
                    ))}
                  </td>
                  <td className="px-4 py-2 text-atl-n-500 text-xs">
                    {t.projectKeys.length ? t.projectKeys.join(', ') : 'all'}
                  </td>
                  <td className="px-4 py-2 text-atl-n-500 text-xs">{fmt(t.lastUsedAt)}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-[11px] font-medium rounded px-1.5 py-0.5 ${t.revokedAt ? 'text-atl-n-200 bg-atl-n-20' : 'text-atl-g-500 bg-atl-g-50'}`}
                    >
                      {t.revokedAt ? 'Revoked' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right space-x-2">
                    <Link
                      className="text-sm text-atl-b-400 hover:underline"
                      to={`/admin/audit?entityType=token&entityId=${encodeURIComponent(t.id)}`}
                    >
                      Activity
                    </Link>
                    {!t.revokedAt && (
                      <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirm(t)}>
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirm && (
        <Modal open onClose={() => setConfirm(null)} labelledBy="revoke-title">
          <div className="p-6 w-[420px]">
            <h2 id="revoke-title" className="text-[18px] font-medium text-atl-n-800 mb-2">
              Revoke "{confirm.name}"?
            </h2>
            <p className="text-sm text-atl-n-500 mb-5">
              {confirm.owner.displayName}'s token stops working immediately — sessions and agents using it get 401.
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-sm text-atl-n-500 hover:bg-atl-n-20 rounded"
                onClick={() => setConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 text-sm font-medium text-white bg-atl-r-400 hover:bg-atl-r-500 rounded"
                onClick={() => revoke.mutate(confirm.id)}
              >
                Revoke token
              </button>
            </div>
            {revoke.isError && <div className="mt-3 text-sm text-atl-r-400">{(revoke.error as Error).message}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

// 028 org metrics — /admin/organization: instance totals, 30-day issue growth,
// domain-activity by type. Data from GET /api/internal/reports/org (admin-gated).
import { useQuery } from '@tanstack/react-query';
import { fetchOrgMetrics } from '../api/client.js';
import { ACCENT, SVG } from '../lib/palette.js';

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-atl-n-30 rounded px-4 py-3 bg-atl-paper">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">{label}</div>
      <div className="text-2xl font-semibold text-atl-n-800 mt-1">{value.toLocaleString()}</div>
    </div>
  );
}

/** Minimal SVG line chart for the 30-day issue-growth series. */
function GrowthChart({ data }: { data: Record<string, number> }) {
  const days = [...Array(30)].map((_, i) => {
    const d = new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10);
    return { day: d, count: data[d] ?? 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.count));
  const W = 640; const H = 120; const PAD = 4;
  const x = (i: number) => PAD + (i / (days.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const pts = days.map((d, i) => `${x(i)},${y(d.count)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" role="img" aria-label="Issues created per day, last 30 days">
      <polyline points={pts} fill="none" stroke={ACCENT.blue} strokeWidth="2" />
      <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke={SVG.n30} strokeWidth="1" />
      <text x={PAD} y={10} fontSize="9" fill={SVG.label}>max {max}/day</text>
    </svg>
  );
}

export default function AdminOrgPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['orgMetrics'], queryFn: fetchOrgMetrics });
  if (isLoading) return <div className="p-6 text-sm text-atl-n-200">Loading…</div>;
  if (error || !data) return <div className="p-6 text-sm text-atl-r-400">Failed to load organization metrics.</div>;

  const maxActivity = Math.max(1, ...data.activityByType.map((a) => a.count));
  return (
      <div className="p-6 max-w-4xl">
        <h1 className="text-xl font-semibold text-atl-n-800 mb-1">Organization</h1>
        <p className="text-sm text-atl-n-200 mb-6">Instance-wide metrics across every visible project.</p>

        <div className="grid grid-cols-3 gap-3 mb-6">
          <StatCard label="Issues" value={data.totals.issues} />
          <StatCard label="Users" value={data.totals.users} />
          <StatCard label="Projects" value={data.totals.projects} />
        </div>

        <section className="border border-atl-n-30 rounded mb-6 bg-atl-paper">
          <div className="px-4 py-2.5 border-b border-atl-n-30">
            <h2 className="text-xs font-semibold text-atl-n-300">Issue growth — last 30 days</h2>
          </div>
          <div className="px-4 py-3">
            <GrowthChart data={data.issueGrowth30d} />
          </div>
        </section>

        <section className="border border-atl-n-30 rounded bg-atl-paper">
          <div className="px-4 py-2.5 border-b border-atl-n-30">
            <h2 className="text-xs font-semibold text-atl-n-300">Activity by type</h2>
          </div>
          <div className="px-4 py-3 space-y-2">
            {data.activityByType.length === 0 && (
              <p className="text-sm text-atl-n-200 py-2">No domain events recorded yet.</p>
            )}
            {data.activityByType.map((a) => (
              <div key={a.type} className="flex items-center gap-3">
                <span className="w-48 shrink-0 text-xs text-atl-n-600 font-mono truncate" title={a.type}>{a.type}</span>
                <div className="flex-1 h-3.5 bg-atl-n-20 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-atl-b-300 rounded-sm"
                    style={{ width: `${(a.count / maxActivity) * 100}%` }}
                  />
                </div>
                <span className="w-14 text-right text-xs text-atl-n-500 tabular-nums">{a.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
  );
}

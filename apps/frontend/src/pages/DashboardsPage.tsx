// Sprint 026 — dashboards page: left rail picker (Jira "Manage dashboards"
// hybrid), header actions, column grid of gadget cards with per-type
// renderers, add/configure/remove gadgets. Data via the aggregate
// /api/internal/dashboards/{id}/data endpoint (viewer-context).
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchDashboards,
  fetchDashboard,
  createDashboard,
  updateDashboard,
  deleteDashboard,
  copyDashboard,
  fetchGadgetTypes,
  addGadget,
  updateGadget,
  deleteGadget,
  fetchDashboardData,
  fetchAllBoards,
  fetchProjects,
  fetchVisibleFilters,
  type DashboardGadget,
  type GadgetTypeDef,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import { IssueKeyLink } from '../components/IssueKey.js';
import RowMenu from '../components/RowMenu.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import SelectMenu from '../components/SelectMenu.js';
import JqlEditor from '../components/JqlEditor.js';
import { CloseIcon, GearIcon } from '../components/icons.js';
import { CHART } from '../lib/palette.js';
import { formatDateTime, parseDate } from '../lib/format.js';

const btn = 'px-2.5 py-1 text-xs font-medium rounded border border-atl-n-40 bg-atl-paper text-atl-n-500 hover:bg-atl-n-20';
const input = 'w-full rounded border border-atl-n-40 px-2 py-1.5 text-sm';

type GadgetDatum = { gadget: DashboardGadget; data?: any; error?: string };

function IssueRows({ issues }: { issues: any[] }) {
  if (!issues?.length) return <p className="text-sm text-atl-n-200 py-3">No matching issues.</p>;
  return (
    <ul className="divide-y divide-atl-n-20">
      {issues.map((i) => (
        <li key={i.key} className="py-1.5 flex items-baseline gap-2 text-sm">
          <IssueKeyLink
            issueKey={i.key}
            categoryKey={i.fields?.status?.statusCategory?.key}
            className="text-atl-b-400 hover:underline font-medium shrink-0"
          />
          <span className="truncate" title={i.fields?.summary}>{i.fields?.summary}</span>
          <span className="ml-auto shrink-0 text-xs text-atl-n-200">{i.fields?.status?.name}</span>
        </li>
      ))}
    </ul>
  );
}

const PALETTE = [
  CHART.blue,
  CHART.green,
  CHART.yellow,
  CHART.red,
  CHART.purple,
  CHART.teal,
  CHART.orange,
  CHART.lightGreen,
];

function Bars({ groups }: { groups: { name: string; count: number }[] }) {
  const max = Math.max(1, ...groups.map((g) => g.count));
  if (!groups.length) return <p className="text-sm text-atl-n-200 py-3">No data.</p>;
  return (
    <div className="space-y-1.5 py-1">
      {groups.map((g, i) => (
        <div key={g.name} className="flex items-center gap-2 text-sm">
          <span className="w-24 truncate text-atl-n-500" title={g.name}>{g.name}</span>
          <div className="flex-1 h-4 bg-atl-n-20 rounded">
            <div
              className="h-4 rounded"
              style={{ width: `${(g.count / max) * 100}%`, background: PALETTE[i % PALETTE.length] }}
            />
          </div>
          <span className="w-8 text-right text-xs text-atl-n-200">{g.count}</span>
        </div>
      ))}
    </div>
  );
}

function GadgetBody({ type, data }: { type: string; data: any }) {
  if (!data) return <p className="text-sm text-atl-n-200 py-3">Loading…</p>;
  if (data.error) return <p className="text-sm text-atl-r-500 py-3">{data.message ?? data.error}</p>;
  switch (type) {
    case 'assigned-to-me':
    case 'filter-results':
    case 'recently-updated':
    case 'watched-issues':
      return (
        <>
          {data.filter && <p className="text-xs text-atl-n-200 pb-1">Filter: {data.filter.name}</p>}
          <IssueRows issues={data.issues} />
          {data.total > data.issues?.length && (
            <p className="text-xs pt-1">
              <Link
                to={data.filter?.jql ? `/issues?mode=jql&jql=${encodeURIComponent(data.filter.jql)}` : '/issues'}
                className="text-atl-b-400 hover:underline"
              >
                …and {data.total - data.issues.length} more
              </Link>
            </p>
          )}
        </>
      );
    case 'pie-chart':
      return <Bars groups={data.groups} />;
    case 'two-dimensional': {
      const { xLabels = [], yLabels = [], cells = {} } = data;
      return (
        <div className="overflow-x-auto py-1">
          <table className="text-xs border-collapse">
            <thead>
              <tr>
                <th className="p-1 text-left text-atl-n-200">
                  {String(data.ystatType)}＼{String(data.xstatType)}
                </th>
                {xLabels.map((x: string) => (
                  <th key={x} className="p-1 font-medium text-atl-n-500">
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {yLabels.map((y: string) => (
                <tr key={y}>
                  <td className="p-1 text-atl-n-500">{y}</td>
                  {xLabels.map((x: string) => (
                    <td key={x} className="p-1 text-center">
                      {cells[JSON.stringify([x, y])] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'created-vs-resolved': {
      const days = [...new Set([...Object.keys(data.created ?? {}), ...Object.keys(data.resolved ?? {})])].sort();
      const max = Math.max(1, ...days.map((d) => Math.max(data.created?.[d] ?? 0, data.resolved?.[d] ?? 0)));
      return (
        <div className="flex items-end gap-px h-24 py-2">
          {days.map((d) => (
            <div
              key={d}
              className="flex-1 flex items-end justify-center gap-px"
              title={`${d}: +${data.created?.[d] ?? 0} / −${data.resolved?.[d] ?? 0}`}
            >
              <div
                className="w-1/2 bg-atl-r-300 rounded-t"
                style={{ height: `${((data.created?.[d] ?? 0) / max) * 100}%` }}
              />
              <div
                className="w-1/2 bg-atl-g-300 rounded-t"
                style={{ height: `${((data.resolved?.[d] ?? 0) / max) * 100}%` }}
              />
            </div>
          ))}
          {!days.length && <p className="text-sm text-atl-n-200">No data.</p>}
        </div>
      );
    }
    case 'sprint-health': {
      if (!data.sprint) return <p className="text-sm text-atl-n-200 py-3">{data.message ?? 'No active sprint.'}</p>;
      const c = data.counts;
      const total = Math.max(1, data.total);
      return (
        <div className="py-2">
          <p className="text-sm font-medium text-atl-n-800 pb-1.5">{data.sprint.name}</p>
          <div className="flex h-3 rounded overflow-hidden bg-atl-n-20">
            <div className="bg-atl-g-300" style={{ width: `${(c.done / total) * 100}%` }} />
            <div className="bg-atl-b-400" style={{ width: `${(c.inProgress / total) * 100}%` }} />
            <div className="bg-atl-n-40" style={{ width: `${((c.todo + c.other) / total) * 100}%` }} />
          </div>
          <p className="text-xs text-atl-n-200 pt-1.5">
            {c.done} done · {c.inProgress} in progress · {c.todo} to do
          </p>
        </div>
      );
    }
    case 'burndown-chart': {
      const s = data.series;
      if (!s?.length) return <p className="text-sm text-atl-n-200 py-3">{data.message ?? 'No sprint data.'}</p>;
      const max = Math.max(1, ...s.map((p: any) => p.scope));
      const n = Math.max(1, s.length - 1);
      const X = (i: number) => (i / n) * 100;
      const Y = (v: number) => 34 - (v / max) * 30;
      const pts = s.map((p: any, i: number) => `${X(i)},${Y(p.remaining)}`).join(' ');
      const scopePts = s.map((p: any, i: number) => `${X(i)},${Y(p.scope)}`).join(' ');
      const fmtDay = (d: string) => parseDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      return (
        <div className="py-2">
          <p className="text-sm font-medium text-atl-n-800">{data.sprint?.name}</p>
          <svg viewBox="0 0 100 40" className="w-full h-28" preserveAspectRatio="none">
            {/* gridlines: top (max scope) + baseline */}
            <line x1="0" y1={Y(max)} x2="100" y2={Y(max)} stroke="#DFE1E6" strokeWidth="0.3" />
            <line x1="0" y1={Y(0)} x2="100" y2={Y(0)} stroke="#DFE1E6" strokeWidth="0.3" />
            <polyline points={scopePts} fill="none" stroke={CHART.gray} strokeWidth="0.8" />
            <line
              x1={X(0)}
              y1={Y(max)}
              x2={X(s.length - 1)}
              y2={Y(0)}
              stroke={CHART.green}
              strokeWidth="0.8"
              strokeDasharray="2 1.5"
            />
            <polyline points={pts} fill="none" stroke={CHART.blue} strokeWidth="1.2" />
            <text x="1" y={Y(max) + 3} fontSize="3" fill="#8993A4">
              {max}
            </text>
            <text x="1" y={Y(0) - 1} fontSize="3" fill="#8993A4">
              0
            </text>
            <text x="0" y="39.5" fontSize="3" fill="#8993A4">
              {fmtDay(s[0].date)}
            </text>
            <text x="100" y="39.5" fontSize="3" fill="#8993A4" textAnchor="end">
              {fmtDay(s[s.length - 1].date)}
            </text>
          </svg>
          <p className="text-xs text-atl-n-200">
            {data.issueCount} issues · latest remaining {s[s.length - 1].remaining} pts
          </p>
        </div>
      );
    }
    case 'velocity-chart': {
      const sprints = data.sprints ?? [];
      if (!sprints.length) return <p className="text-sm text-atl-n-200 py-3">No closed sprints yet.</p>;
      const max = Math.max(1, ...sprints.map((s: any) => s.committedPoints));
      return (
        <div className="flex items-end gap-2 h-24 py-2 overflow-x-auto">
          {sprints.slice(-8).map((s: any) => (
            <div
              key={s.sprint.id}
              className="flex flex-col items-center gap-1 shrink-0"
              title={`${s.sprint.name}: ${s.completedPoints}/${s.committedPoints}`}
            >
              <div className="flex items-end gap-px h-16">
                <div className="w-3 bg-atl-n-40 rounded-t" style={{ height: `${(s.committedPoints / max) * 100}%` }} />
                <div className="w-3 bg-atl-g-300 rounded-t" style={{ height: `${(s.completedPoints / max) * 100}%` }} />
              </div>
              <span className="text-[10px] text-atl-n-200 max-w-14 truncate">{s.sprint.name}</span>
            </div>
          ))}
        </div>
      );
    }
    case 'activity-stream': {
      const events = data.events ?? [];
      if (!events.length) return <p className="text-sm text-atl-n-200 py-3">No activity yet.</p>;
      return (
        <ul className="divide-y divide-atl-n-20">
          {events.map((e: any) => (
            <li key={e.id} className="py-1.5 text-sm">
              <span className="text-atl-n-500">{e.actor?.displayName ?? 'Someone'}</span>{' '}
              <span className="text-atl-n-200">{e.type.replace(/^jira:|_/g, ' ')}</span>{' '}
              {e.issueKey && (
                <Link to={`/browse/${e.issueKey}`} className="text-atl-b-400 hover:underline">
                  {e.issueKey}
                </Link>
              )}
              <span className="block text-[11px] text-atl-n-70">{formatDateTime(e.occurredAt)}</span>
            </li>
          ))}
        </ul>
      );
    }
    default:
      return <pre className="text-xs text-atl-n-200 overflow-auto">{JSON.stringify(data, null, 1)}</pre>;
  }
}

function ConfigForm({
  def,
  value,
  onChange,
}: {
  def: GadgetTypeDef;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
}) {
  // 058 US6 — board/filter/project fields render as pickers, not raw-UUID inputs.
  const { data: boards } = useQuery({ queryKey: ['all-boards'], queryFn: fetchAllBoards });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const { data: filters } = useQuery({ queryKey: ['visible-filters'], queryFn: () => fetchVisibleFilters() });
  const picker = (f: { type: string }): { value: string; label: string }[] | null => {
    if (f.type === 'board') return (boards ?? []).map((b) => ({ value: b.id, label: b.name }));
    if (f.type === 'project') return (projects ?? []).map((p) => ({ value: p.key, label: `${p.key} — ${p.name}` }));
    if (f.type === 'filter') return (filters ?? []).map((fl) => ({ value: fl.id, label: fl.name }));
    return null;
  };
  return (
    <div className="space-y-2">
      {def.configFields.map((f) => (
        <label key={f.key} className="block text-sm">
          <span className="text-xs font-medium text-atl-n-500">
            {f.label}
            {f.required ? ' *' : ''}
          </span>
          {f.type === 'jql' ? (
            <JqlEditor value={String(value[f.key] ?? '')} onChange={(v) => onChange({ ...value, [f.key]: v })} />
          ) : picker(f) ? (
            <select
              className={input}
              value={String(value[f.key] ?? f.default ?? '')}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            >
              <option value="">Select {f.label.toLowerCase()}…</option>
              {picker(f)!.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              className={input}
              value={String(value[f.key] ?? f.default ?? '')}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
            />
          )}
        </label>
      ))}
    </div>
  );
}

export default function DashboardsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [selType, setSelType] = useState('');
  const [cfg, setCfg] = useState<Record<string, unknown>>({});
  const [editingGadget, setEditingGadget] = useState<GadgetDatum | null>(null);
  const [removingGadget, setRemovingGadget] = useState<DashboardGadget | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delPending, setDelPending] = useState(false);
  const [delTarget, setDelTarget] = useState<{ id: string; name: string } | null>(null);
  const [pageError, setPageError] = useState('');
  const [search, setSearch] = useState('');

  const { data: list } = useQuery({ queryKey: ['dashboards'], queryFn: fetchDashboards });
  const dashboards = list?.dashboards ?? [];
  const currentId = id;
  const { data: dash } = useQuery({
    queryKey: ['dashboard', currentId],
    queryFn: () => fetchDashboard(currentId!),
    enabled: !!currentId,
  });
  const { data: data } = useQuery({
    queryKey: ['dashboard-data', currentId],
    queryFn: () => fetchDashboardData(currentId!),
    enabled: !!currentId,
    refetchInterval: 60_000,
  });
  const { data: gadgetTypes } = useQuery({ queryKey: ['gadget-types'], queryFn: fetchGadgetTypes });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dashboards'] });
    qc.invalidateQueries({ queryKey: ['dashboard', currentId] });
    qc.invalidateQueries({ queryKey: ['dashboard-data', currentId] });
  };
  const mut = (fn: () => Promise<unknown>) =>
    fn()
      .then(invalidate)
      .catch((e) => setPageError((e as Error).message));

  const columns = dash?.layout?.columns ?? 2;
  const grid: DashboardGadget[][] = Array.from({ length: columns }, () => []);
  for (const g of data?.gadgets ?? []) {
    const col = Math.min(columns - 1, Math.max(0, g.gadget.position.column));
    grid[col].push(g.gadget);
  }
  const dataFor = (gid: string) => data?.gadgets.find((x) => x.gadget.id === gid);

  if (!list) return <div className="p-8 text-sm text-atl-n-200">Loading…</div>;

  // Jira parity: /dashboards is a manage list (search + Name/Owner/actions);
  // the dashboard itself lives at /dashboards/:id.
  if (!id) {
    const q = search.trim().toLowerCase();
    const filtered = dashboards.filter((d) => !q || d.name.toLowerCase().includes(q));
    return (
      <>
        <div className="px-6 py-5 max-w-7xl">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-xl font-semibold text-atl-n-800">Dashboards</h1>
            <button
              className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500"
              onClick={() => setCreateOpen(true)}
            >
              Create dashboard
            </button>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search dashboards"
            aria-label="Search dashboards"
            className="mb-4 h-9 w-72 rounded-[3px] border-2 border-atl-n-40 px-3 text-sm focus:border-atl-b-300 outline-none"
          />
          {pageError && (
            <div className="mb-4 rounded border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
              {pageError}
            </div>
          )}
          {!filtered.length ? (
            <div className="border border-atl-n-30 rounded">
              <EmptyState
                title={q ? 'No dashboards match' : 'No dashboards yet'}
                description={
                  q ? `Nothing matches "${search.trim()}".` : 'Create a dashboard to start tracking your work.'
                }
                action={
                  !q ? (
                    <button className={btn} onClick={() => setCreateOpen(true)}>
                      Create dashboard
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <section className="rounded-[3px] border border-atl-n-30 bg-atl-paper">
              <header className="grid grid-cols-[1fr_12rem_3rem] items-center gap-3 px-4 py-2 border-b border-atl-n-30 text-[11px] font-semibold uppercase tracking-wide text-atl-n-200">
                <span>Name</span>
                <span>Owner</span>
                <span />
              </header>
              <ul className="divide-y divide-atl-n-20">
                {filtered.map((d) => (
                  <li key={d.id} className="grid grid-cols-[1fr_12rem_3rem] items-center gap-3 px-4 py-2">
                    <span className="min-w-0">
                      <Link to={`/dashboards/${d.id}`} className="text-sm font-medium text-atl-b-400 hover:underline">
                        {d.name}
                      </Link>
                      {d.description && (
                        <span className="block text-xs text-atl-n-200 truncate" title={d.description}>{d.description}</span>
                      )}
                    </span>
                    <span className="text-sm text-atl-n-500 truncate" title={d.owner.name}>{d.owner.name}</span>
                    <span className="text-right">
                      <RowMenu
                        ariaLabel={`Actions for ${d.name}`}
                        items={[
                          { label: 'Open', onClick: () => navigate(`/dashboards/${d.id}`) },
                          {
                            label: 'Copy',
                            onClick: () =>
                              void mut(async () => {
                                const c = await copyDashboard(d.id);
                                navigate(`/dashboards/${c.id}`);
                              }),
                          },
                          {
                            label: 'Delete',
                            danger: true,
                            onClick: () => {
                              setDelTarget({ id: d.id, name: d.name });
                              setDelOpen(true);
                            },
                          },
                        ]}
                      />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <Modal open={createOpen} onClose={() => setCreateOpen(false)}>
          <div className="p-5">
            <h2 className="text-base font-semibold text-atl-n-800 pb-3">Create dashboard</h2>
            <input
              className={input}
              placeholder="Name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2 pt-3">
              <button className={btn} onClick={() => setCreateOpen(false)}>
                Cancel
              </button>
              <button
                className="px-3 py-1 text-sm font-medium rounded bg-atl-b-400 text-white hover:bg-atl-b-300"
                disabled={!newName.trim()}
                onClick={() =>
                  mut(async () => {
                    const d = await createDashboard({ name: newName.trim() });
                    setCreateOpen(false);
                    setNewName('');
                    navigate(`/dashboards/${d.id}`);
                  })
                }
              >
                Create
              </button>
            </div>
          </div>
        </Modal>

        <ConfirmDialog
          open={delOpen}
          title="Delete dashboard"
          body={
            <>
              Delete <span className="font-medium">"{delTarget?.name}"</span>? This cannot be undone.
            </>
          }
          pending={delPending}
          onConfirm={() => {
            if (!delTarget) return;
            setDelPending(true);
            mut(() => deleteDashboard(delTarget.id))
              .then(() => {
                setDelOpen(false);
                setDelTarget(null);
              })
              .finally(() => setDelPending(false));
          }}
          onClose={() => {
            setDelOpen(false);
            setDelTarget(null);
          }}
        />
      </>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 border-r border-atl-n-40 bg-atl-paper p-3 overflow-y-auto">
        <div className="flex items-center justify-between pb-2">
          <h2 className="text-xs font-semibold uppercase text-atl-n-300">Dashboards</h2>
          <button className={btn} onClick={() => setCreateOpen(true)}>
            + New
          </button>
        </div>
        <ul className="space-y-0.5">
          {dashboards.map((d) => (
            <li key={d.id}>
              <Link
                to={`/dashboards/${d.id}`}
                className={`block rounded px-2 py-1.5 text-sm truncate ${d.id === currentId ? 'bg-atl-b-75 text-atl-b-500 font-medium' : 'text-atl-n-500 hover:bg-atl-n-20'}`}
                title={d.name}
              >
                {d.name}
              </Link>
            </li>
          ))}
          {!dashboards.length && <li className="text-sm text-atl-n-200 px-2 py-2">No dashboards yet.</li>}
        </ul>
      </aside>

      <main className="flex-1 overflow-y-auto p-5">
        {pageError && (
          <div className="mb-4 flex items-start justify-between rounded border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
            <span>{pageError}</span>
            <button
              className="ml-3 text-atl-r-400 hover:text-atl-r-500"
              onClick={() => setPageError('')}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}
        {!dash ? (
          <EmptyState
            title="Select or create a dashboard"
            description="Pick a dashboard from the list, or create one and add gadgets to track your work."
            action={
              <button className={btn} onClick={() => setCreateOpen(true)}>
                Create dashboard
              </button>
            }
          />
        ) : (
          <>
            <header className="flex items-center gap-3 pb-4">
              <div>
                <h1 className="text-xl font-semibold text-atl-n-800">{dash.name}</h1>
                {dash.description && <p className="text-sm text-atl-n-200">{dash.description}</p>}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <SelectMenu
                  value={String(columns)}
                  title="Dashboard columns"
                  label={
                    <span className="text-xs text-atl-n-500">
                      {columns} col{columns === 1 ? '' : 's'}
                    </span>
                  }
                  options={[1, 2, 3].map((n) => ({ value: String(n), label: `${n} column${n === 1 ? '' : 's'}` }))}
                  onChange={(v) => mut(() => updateDashboard(dash.id, { layout: { columns: Number(v) } }))}
                />
                <button
                  className={btn}
                  onClick={() => {
                    setSelType('');
                    setCfg({});
                    setAddOpen(true);
                  }}
                >
                  Add gadget
                </button>
                <RowMenu
                  ariaLabel="Dashboard actions"
                  items={[
                    {
                      label: 'Copy',
                      onClick: () =>
                        void mut(async () => {
                          const c = await copyDashboard(dash.id);
                          navigate(`/dashboards/${c.id}`);
                        }),
                    },
                    { label: 'Delete', danger: true, onClick: () => setDelOpen(true) },
                  ]}
                />
              </div>
            </header>

            <div
              className={`grid gap-4 ${columns === 3 ? 'grid-cols-3' : columns === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
            >
              {grid.map((col, ci) => (
                <div key={ci} className="space-y-4">
                  {col.map((g) => {
                    const entry = dataFor(g.id);
                    return (
                      <section key={g.id} className="rounded border border-atl-n-40 bg-atl-paper">
                        <header className="flex items-center gap-2 border-b border-atl-n-20 px-3 py-1.5">
                          <h3 className="text-sm font-medium text-atl-n-800">{g.title}</h3>
                          <div className="ml-auto flex gap-1">
                            <button
                              className="text-atl-n-200 hover:text-atl-b-400 px-1"
                              title="Configure"
                              onClick={() => {
                                setEditingGadget(entry!);
                                setCfg({ ...g.config });
                              }}
                            >
                              <GearIcon size={13} />
                            </button>
                            <button
                              className="text-atl-n-200 hover:text-atl-r-500 px-1"
                              title="Remove"
                              onClick={() => setRemovingGadget(g)}
                            >
                              <CloseIcon size={13} />
                            </button>
                          </div>
                        </header>
                        <div className="px-3 pb-3">
                          {entry?.error ? (
                            <p className="text-sm text-atl-r-500 py-3">{entry.error}</p>
                          ) : (
                            <GadgetBody type={g.type} data={entry?.data} />
                          )}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ))}
            </div>
            {!dash.gadgets?.length && (
              <button
                className="mt-4 rounded border-2 border-dashed border-atl-n-40 px-6 py-8 text-sm text-atl-n-200 hover:border-atl-b-400 hover:text-atl-b-400"
                onClick={() => setAddOpen(true)}
              >
                + Add your first gadget
              </button>
            )}
          </>
        )}
      </main>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)}>
        <div className="p-5">
          <h2 className="text-base font-semibold text-atl-n-800 pb-3">Create dashboard</h2>
          <input
            className={input}
            placeholder="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            autoFocus
          />
          <div className="flex justify-end gap-2 pt-3">
            <button className={btn} onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button
              className="px-3 py-1 text-sm font-medium rounded bg-atl-b-400 text-white hover:bg-atl-b-300"
              disabled={!newName.trim()}
              onClick={() =>
                mut(async () => {
                  const d = await createDashboard({ name: newName.trim() });
                  setCreateOpen(false);
                  setNewName('');
                  navigate(`/dashboards/${d.id}`);
                })
              }
            >
              Create
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={delOpen}
        title="Delete dashboard"
        body={
          <>
            Delete <span className="font-medium">"{dash?.name}"</span>? This cannot be undone.
          </>
        }
        pending={delPending}
        onConfirm={() => {
          if (!dash) return;
          setDelPending(true);
          mut(async () => {
            await deleteDashboard(dash.id);
            navigate('/dashboards');
          })
            .then(() => setDelOpen(false))
            .finally(() => setDelPending(false));
        }}
        onClose={() => setDelOpen(false)}
      />

      <ConfirmDialog
        open={!!removingGadget}
        title="Remove gadget"
        confirmLabel="Remove"
        body={
          <>
            Remove <span className="font-medium">"{removingGadget?.title}"</span> from this dashboard?
          </>
        }
        onConfirm={() => {
          if (!dash || !removingGadget) return;
          mut(() => deleteGadget(dash.id, removingGadget.id));
          setRemovingGadget(null);
        }}
        onClose={() => setRemovingGadget(null)}
      />

      <Modal open={addOpen} onClose={() => setAddOpen(false)}>
        <div className="p-5">
          <h2 className="text-base font-semibold text-atl-n-800 pb-3">Add gadget</h2>
        {!selType ? (
          <ul className="max-h-80 overflow-y-auto divide-y divide-atl-n-20">
            {gadgetTypes?.gadgets.map((t) => (
              <li key={t.type}>
                <button
                  className="w-full text-left px-2 py-2 hover:bg-atl-n-20 rounded"
                  onClick={() => {
                    setSelType(t.type);
                    // Seed declared defaults so submitting untouched works and
                    // editing one field keeps the other defaults visible/intact.
                    setCfg(
                      Object.fromEntries(
                        t.configFields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])
                      )
                    );
                  }}
                >
                  <span className="block text-sm font-medium text-atl-n-800">{t.title}</span>
                  <span className="block text-xs text-atl-n-200">{t.description}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <p className="text-sm font-medium text-atl-n-800 pb-2">
              {gadgetTypes?.gadgets.find((t) => t.type === selType)?.title}
            </p>
            <ConfigForm def={gadgetTypes!.gadgets.find((t) => t.type === selType)!} value={cfg} onChange={setCfg} />
            <div className="flex justify-end gap-2 pt-3">
              <button className={btn} onClick={() => setSelType('')}>
                Back
              </button>
              <button
                className="px-3 py-1 text-xs font-medium rounded bg-atl-b-400 text-white hover:bg-atl-b-300"
                onClick={() =>
                  mut(async () => {
                    await addGadget(dash!.id, { type: selType, config: cfg });
                    setAddOpen(false);
                  })
                }
              >
                Add
              </button>
            </div>
          </>
        )}
        </div>
      </Modal>

      <Modal open={!!editingGadget} onClose={() => setEditingGadget(null)}>
        <div className="p-5">
        {editingGadget && (
          <>
            <h2 className="text-base font-semibold text-atl-n-800 pb-3">Configure {editingGadget.gadget.title}</h2>
            <ConfigForm
              def={gadgetTypes!.gadgets.find((t) => t.type === editingGadget.gadget.type)!}
              value={cfg}
              onChange={setCfg}
            />
            <div className="flex justify-end gap-2 pt-3">
              <button className={btn} onClick={() => setEditingGadget(null)}>
                Cancel
              </button>
              <button
                className="px-3 py-1 text-xs font-medium rounded bg-atl-b-400 text-white hover:bg-atl-b-300"
                onClick={() =>
                  mut(async () => {
                    await updateGadget(dash!.id, editingGadget.gadget.id, { config: cfg });
                    setEditingGadget(null);
                  })
                }
              >
                Save
              </button>
            </div>
          </>
        )}
        </div>
      </Modal>
    </div>
  );
}

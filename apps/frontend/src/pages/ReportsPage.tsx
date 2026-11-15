import { useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  fetchBoard,
  fetchBurndown,
  fetchCfd,
  fetchControlChart,
  fetchEpicReport,
  fetchSprints,
  fetchVelocity,
  fetchReport,
  fetchVersions,
  searchIssues,
} from '../api/client.js';
import ExportMenu from '../components/ExportMenu.js';
import { IssueKeyLink } from '../components/IssueKey.js';
import PageHeader from '../components/PageHeader.js';
import SelectMenu from '../components/SelectMenu.js';
import { CHART, SVG } from '../lib/palette.js';
import { parseDate, formatSeconds } from '../lib/format.js';

const W = 640;
const H = 220;
const PAD = 32;

function BurndownChart({ boardId, sprintId }: { boardId: string; sprintId?: string }) {
  const { data } = useQuery({
    queryKey: ['burndown', boardId, sprintId],
    queryFn: () => fetchBurndown(boardId, sprintId),
    enabled: Boolean(boardId),
  });
  if (!data || data.series.length < 2) {
    return <p className="text-sm text-atl-n-200 py-6">Not enough data yet — check back after the sprint runs a day.</p>;
  }
  const max = Math.max(...data.series.map((p) => p.scope), 1);
  const x = (i: number) => PAD + (i / (data.series.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const remaining = data.series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.remaining)}`).join(' ');
  const scope = data.series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.scope)}`).join(' ');
  // Ideal guideline: start scope → 0 at end date.
  const t0 = parseDate(data.series[0].date).getTime();
  const t1 = parseDate(data.endDate).getTime();
  const xT = (t: number) => PAD + ((t - t0) / Math.max(t1 - t0, 1)) * (W - PAD * 2);
  const ideal = `M${xT(t0)},${y(data.series[0].scope)} L${Math.min(xT(t1), W - PAD)},${y(0)}`;

  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-xs text-atl-n-200">
        <span className="flex items-center gap-1"><i className="w-3 h-0.5 bg-atl-b-400 inline-block" /> Remaining</span>
        <span className="flex items-center gap-1"><i className="w-3 h-0.5 bg-atl-n-100 inline-block" /> Scope</span>
        <span className="flex items-center gap-1"><i className="w-3 border-t-2 border-dashed border-atl-g-300 inline-block" /> Guideline</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD} x2={W - PAD} y1={y(max * f)} y2={y(max * f)} stroke={SVG.n40} />
            <text x={4} y={y(max * f) + 4} fontSize="10" fill={SVG.label}>{Math.round(max * f)}</text>
          </g>
        ))}
        {/* x-axis: sprint start / mid / end dates */}
        {[
          { t: t0, anchor: 'start' as const, x: PAD },
          { t: (t0 + t1) / 2, anchor: 'middle' as const, x: xT((t0 + t1) / 2) },
          { t: t1, anchor: 'end' as const, x: Math.min(xT(t1), W - PAD) },
        ].map((l, i) => (
          <text key={i} x={l.x} y={H - PAD + 14} fontSize="10" textAnchor={l.anchor} fill={SVG.label}>
            {new Date(l.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
          </text>
        ))}
        <path d={ideal} stroke={CHART.green} strokeWidth="1.5" strokeDasharray="4 3" fill="none" />
        <path d={scope} stroke={CHART.gray} strokeWidth="1.5" fill="none" />
        <path d={remaining} stroke={CHART.blue} strokeWidth="2" fill="none" />
        {data.series.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.remaining)} r="2.5" fill={CHART.blue} />
        ))}
      </svg>
      <p className="text-xs text-atl-n-200 mt-1">
        {data.sprint.name} · {data.issueCount} issues · ends{' '}
        {parseDate(data.endDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
      </p>
    </div>
  );
}

function VelocityChart({ boardId }: { boardId: string }) {
  const { data } = useQuery({
    queryKey: ['velocity', boardId],
    queryFn: () => fetchVelocity(boardId),
    enabled: Boolean(boardId),
  });
  if (!data || !data.sprints.length) {
    return <p className="text-sm text-atl-n-200 py-6">No closed sprints yet — velocity appears after your first completed sprint.</p>;
  }
  const max = Math.max(...data.sprints.map((s) => s.committedPoints), 1);
  // Fixed W viewBox like Burndown — a small viewBox was upscaled by w-full,
  // which inflated fonts ~2x. Bars spread evenly across the chart width.
  const slot = (W - PAD * 2) / data.sprints.length;
  const barW = Math.min(64, slot * 0.62);
  const chartW = W;
  return (
    <div>
      <div className="flex items-center gap-4 mb-2 text-xs text-atl-n-200">
        <span className="flex items-center gap-1"><i className="w-3 h-3 bg-atl-n-100 inline-block rounded-sm" /> Committed</span>
        <span className="flex items-center gap-1"><i className="w-3 h-3 bg-atl-g-300 inline-block rounded-sm" /> Completed</span>
      </div>
      <svg viewBox={`0 0 ${chartW} ${H}`} className="w-full">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD} x2={chartW - PAD} y1={H - PAD - f * (H - PAD * 2)} y2={H - PAD - f * (H - PAD * 2)} stroke={SVG.n40} />
            <text x={4} y={H - PAD - f * (H - PAD * 2) + 4} fontSize="10" fill={SVG.label}>{Math.round(max * f)}</text>
          </g>
        ))}
        {data.sprints.map((s, i) => {
          const x = PAD + i * slot + (slot - barW) / 2;
          const ch = (s.committedPoints / max) * (H - PAD * 2);
          const dh = (s.completedPoints / max) * (H - PAD * 2);
          return (
            <g key={s.sprint.id}>
              <rect x={x} y={H - PAD - ch} width={barW} height={ch} fill={CHART.gray} rx="2" />
              <rect x={x} y={H - PAD - dh} width={barW} height={dh} fill={CHART.green} rx="2" />
              <text x={x + barW / 2} y={H - PAD + 14} fontSize="10" textAnchor="middle" fill={SVG.label}>
                {s.sprint.name.length > 10 ? `${s.sprint.name.slice(0, 9)}…` : s.sprint.name}
              </text>
              <text x={x + barW / 2} y={H - PAD - ch - 4} fontSize="10" textAnchor="middle" fill={SVG.n500}>
                {s.committedPoints}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-atl-n-200 mt-1">
        Average velocity:{' '}
        {Math.round(
          (data.sprints.reduce((a, s) => a + s.completedPoints, 0) / data.sprints.length) * 10
        ) / 10}{' '}
        pts/sprint
      </p>
    </div>
  );
}

function BurndownSection({
  board,
  sprints,
}: {
  board: { id: string };
  sprints?: { id: string; name: string; state: string }[];
}) {
  const [sprintId, setSprintId] = useState<string>('');
  return (
    <div>
      <div className="flex items-center justify-end mb-3">
        <span className="flex items-center gap-2">
          <ExportMenu name="burndown" csvPath={`/board/${board.id}/burndown${sprintId ? `?sprintId=${sprintId}` : ''}`} />
          <SelectMenu
            value={sprintId}
            title="Sprint"
            label={
              <span className="text-sm text-atl-n-600">
                {sprints?.find((s) => s.id === sprintId)?.name ?? 'Active sprint'}
              </span>
            }
            options={[
              { value: '', label: 'Active sprint' },
              ...(sprints ?? []).map((s) => ({ value: s.id, label: `${s.name} (${s.state})` })),
            ]}
            onChange={setSprintId}
          />
        </span>
      </div>
      <BurndownChart boardId={board.id} sprintId={sprintId || undefined} />
    </div>
  );
}

// Jira parity: /reports is a gallery of report cards; each card opens its own
// page at /reports/<id> so one report owns the viewport (and deep-links).
interface ReportCtx {
  board?: { id: string };
  sprints?: { id: string; name: string; state: string }[];
  projectKey: string;
}

const REPORT_GROUPS: {
  name: string;
  reports: { id: string; name: string; description: string; render: (c: ReportCtx) => ReactNode }[];
}[] = [
  {
    name: 'Agile',
    reports: [
      {
        id: 'burndown',
        name: 'Burndown chart',
        description: 'Track remaining work in the sprint against the ideal pace.',
        render: (c) => c.board && <BurndownSection board={c.board} sprints={c.sprints} />,
      },
      {
        id: 'velocity',
        name: 'Velocity chart',
        description: 'Committed vs completed story points for recent sprints.',
        render: (c) =>
          c.board && (
            <div>
              <div className="flex justify-end mb-3">
                <ExportMenu name="velocity" csvPath={`/board/${c.board.id}/velocity`} />
              </div>
              <VelocityChart boardId={c.board.id} />
            </div>
          ),
      },
      {
        id: 'cumulative-flow',
        name: 'Cumulative flow',
        description: 'How issues in each status accumulate over time.',
        render: (c) =>
          c.board && (
            <div>
              <div className="flex justify-end mb-3">
                <ExportMenu name="cumulative-flow" csvPath={`/cfd/${c.board.id}`} />
              </div>
              <CfdChart boardId={c.board.id} />
            </div>
          ),
      },
      {
        id: 'control-chart',
        name: 'Control chart',
        description: 'Cycle time per issue vs the rolling average.',
        render: (c) =>
          c.board && (
            <div>
              <div className="flex justify-end mb-3">
                <ExportMenu name="control-chart" csvPath={`/control/${c.board.id}`} />
              </div>
              <ControlChart boardId={c.board.id} />
            </div>
          ),
      },
      {
        id: 'epic-report',
        name: 'Epic report',
        description: 'Progress towards completing an epic.',
        render: (c) => c.board && <EpicReport boardId={c.board.id} />,
      },
    ],
  },
  {
    name: 'Issue analysis',
    reports: [
      {
        id: 'project-summary',
        name: 'Project summary',
        description: 'Open issues broken down by status, type and priority.',
        render: (c) => <ProjectSummarySection projectKey={c.projectKey} />,
      },
      {
        id: 'pie',
        name: 'Pie chart',
        description: 'Issue counts grouped by a statistic of your choice.',
        render: (c) => <PieSection jql={`project = ${c.projectKey}`} />,
      },
      {
        id: 'two-dimensional',
        name: 'Two-dimensional',
        description: 'Issues distributed across two statistics.',
        render: (c) => <TwoDimMatrix jql={`project = ${c.projectKey}`} />,
      },
      {
        id: 'created-resolved',
        name: 'Created vs resolved',
        description: 'Created and resolved issues over a date range.',
        render: (c) => <CreatedResolvedChart jql={`project = ${c.projectKey}`} />,
      },
      {
        id: 'average-age',
        name: 'Average age',
        description: 'How long unresolved issues have been open.',
        render: (c) => <AverageAgeChart jql={`project = ${c.projectKey}`} />,
      },
      {
        id: 'resolution-time',
        name: 'Resolution time',
        description: 'Average days taken to resolve issues.',
        render: (c) => <ResolutionTimeChart jql={`project = ${c.projectKey}`} />,
      },
    ],
  },
  {
    name: 'Time tracking & releases',
    reports: [
      {
        id: 'workload',
        name: 'User workload',
        description: 'Open issues, points and remaining estimates per assignee.',
        render: (c) => <WorkloadTable projectKey={c.projectKey} />,
      },
      {
        id: 'time-tracking',
        name: 'Time tracking',
        description: 'Original vs remaining estimates across issues.',
        render: (c) => <TimeTrackingSection projectKey={c.projectKey} />,
      },
      {
        id: 'timesheet',
        name: 'Timesheet',
        description: 'Time logged per user over the last 14 days.',
        render: (c) => <TimesheetSection projectKey={c.projectKey} />,
      },
      {
        id: 'version-report',
        name: 'Version report',
        description: 'Progress and forecast towards a release version.',
        render: (c) => <VersionReportSection projectKey={c.projectKey} />,
      },
    ],
  },
];

const ALL_REPORTS = REPORT_GROUPS.flatMap((g) => g.reports);

export default function ReportsPage() {
  const { projectKey, reportId } = useParams<{ projectKey: string; reportId?: string }>();
  const { data: board } = useQuery({
    queryKey: ['board', projectKey],
    queryFn: () => fetchBoard(projectKey!),
    enabled: Boolean(projectKey),
  });
  const { data: sprints } = useQuery({
    queryKey: ['sprints', projectKey, 'closed'],
    queryFn: () => fetchSprints(projectKey!, ['closed', 'active']),
    enabled: Boolean(projectKey),
  });
  const ctx: ReportCtx = { board: board ?? undefined, sprints, projectKey: projectKey ?? '' };
  const def = reportId ? ALL_REPORTS.find((r) => r.id === reportId) : undefined;

  if (reportId && !def) {
    return <Navigate to={`/projects/${projectKey}/reports`} replace />;
  }

  if (def) {
    return (
      <div className="px-6 py-5 max-w-4xl">
        <PageHeader
          crumbs={[
            { label: 'Projects' },
            { label: projectKey ?? '' },
            { label: 'Reports', to: `/projects/${projectKey}/reports` },
            { label: def.name },
          ]}
          title={def.name}
        />
        <section className="rounded-lg border border-atl-n-30 p-4 bg-atl-paper">
          {board || !['burndown', 'velocity', 'cumulative-flow', 'control-chart', 'epic-report'].includes(def.id)
            ? def.render(ctx)
            : <p className="text-sm text-atl-n-200 py-6">Loading board…</p>}
        </section>
      </div>
    );
  }

  return (
    <div className="px-6 py-5 max-w-4xl">
      <PageHeader crumbs={[{ label: 'Projects' }, { label: projectKey ?? '' }]} title="Reports" />
      {REPORT_GROUPS.map((g) => (
        <section key={g.name} className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-atl-n-200 mb-2">
            {g.name}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {g.reports.map((r) => (
              <Link
                key={r.id}
                to={`/projects/${projectKey}/reports/${r.id}`}
                className="block rounded-lg border border-atl-n-30 bg-atl-paper p-4 hover:border-atl-b-300 hover:shadow-sm transition-shadow"
              >
                <div className="flex items-center gap-2 mb-1">
                  <svg width="16" height="16" viewBox="0 0 16 16" className="text-atl-n-300" fill="currentColor" aria-hidden="true">
                    <rect x="2" y="8" width="3" height="6" rx="0.5" />
                    <rect x="6.5" y="5" width="3" height="9" rx="0.5" />
                    <rect x="11" y="2" width="3" height="12" rx="0.5" />
                  </svg>
                  <span className="text-sm font-semibold text-atl-n-800">{r.name}</span>
                </div>
                <p className="text-xs text-atl-n-300">{r.description}</p>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const CFD_COLORS = [CHART.blue, CHART.green, CHART.yellow, CHART.red, CHART.purple, CHART.teal];

function CfdChart({ boardId }: { boardId: string }) {
  const { data } = useQuery({ queryKey: ['cfd', boardId], queryFn: () => fetchCfd(boardId, 30) });
  if (!data?.series.length) return <p className="text-sm text-atl-n-200 py-6">No flow data yet.</p>;
  const cols = data.columns;
  const max = Math.max(1, ...data.series.map((p) => cols.reduce((a, c) => a + (p.counts[c] ?? 0), 0)));
  const H = 30;
  return (
    <div>
      <svg viewBox={`0 0 100 ${H}`} className="w-full h-44" preserveAspectRatio="none">
        {cols.map((col, ci) => {
          // stacked area: cumulative baseline of columns < ci
          const top = data.series.map((p, i) => {
            const below = cols.slice(0, ci + 1).reduce((a, c) => a + (p.counts[c] ?? 0), 0);
            return `${(i / Math.max(1, data.series.length - 1)) * 100},${H - (below / max) * (H - 2)}`;
          });
          const bottom = [...data.series].reverse().map((p, ri) => {
            const i = data.series.length - 1 - ri;
            const below = cols.slice(0, ci).reduce((a, c) => a + (p.counts[c] ?? 0), 0);
            return `${(i / Math.max(1, data.series.length - 1)) * 100},${H - (below / max) * (H - 2)}`;
          });
          return <polygon key={col} points={[...top, ...bottom].join(' ')} fill={CFD_COLORS[ci % CFD_COLORS.length]} opacity="0.75" />;
        })}
      </svg>
      <div className="flex gap-3 mt-2">
        {cols.map((c, i) => (
          <span key={c} className="inline-flex items-center gap-1 text-xs text-atl-n-300">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: CFD_COLORS[i % CFD_COLORS.length] }} />{c}
          </span>
        ))}
      </div>
    </div>
  );
}

function ControlChart({ boardId }: { boardId: string }) {
  const { data } = useQuery({ queryKey: ['control', boardId], queryFn: () => fetchControlChart(boardId, 30) });
  if (!data?.issues.length) return <p className="text-sm text-atl-n-200 py-6">No completed issues in range.</p>;
  const max = Math.max(1, ...data.issues.map((i) => i.cycleDays));
  const n = data.issues.length;
  return (
    <div>
      <svg viewBox="0 0 100 34" className="w-full h-40" preserveAspectRatio="none">
        <line x1="0" x2="100" y1={32 - (data.mean / max) * 28} y2={32 - (data.mean / max) * 28} stroke={CHART.red} strokeDasharray="1.5 1" strokeWidth="0.5" />
        {data.issues.map((i, idx) => (
          <circle key={i.key} cx={(idx / Math.max(1, n - 1)) * 98 + 1} cy={32 - (i.cycleDays / max) * 28} r="0.9" fill={CHART.blue}>
            <title>{i.key}: {i.cycleDays}d</title>
          </circle>
        ))}
        <polyline
          points={data.rolling.map((r, i) => `${(i / Math.max(1, n - 1)) * 98 + 1},${32 - (r.avg / max) * 28}`).join(' ')}
          fill="none" stroke={CHART.green} strokeWidth="1"
        />
      </svg>
      <p className="text-xs text-atl-n-300 mt-1">
        {n} issues · mean {data.mean}d · σ {data.stddev}d · <span className="text-atl-g-300">rolling avg</span> · <span className="text-atl-r-400">mean line</span>
      </p>
    </div>
  );
}

function EpicReport({ boardId }: { boardId: string }) {
  const { data: epics } = useQuery({
    queryKey: ['epics', boardId],
    queryFn: () => searchIssues(`issuetype = Epic ORDER BY created DESC`, { maxResults: 5 }),
  });
  const [key, setKey] = useState('');
  const epicKey = key || epics?.issues?.[0]?.key;
  const { data } = useQuery({
    queryKey: ['epic-report', epicKey],
    queryFn: () => fetchEpicReport(epicKey!),
    enabled: !!epicKey,
  });
  if (!epics?.issues.length) return <p className="text-sm text-atl-n-200 py-6">No epics in this project.</p>;
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <SelectMenu
          value={epicKey ?? ''}
          title="Epic"
          label={<span className="text-sm">{epicKey}</span>}
          options={epics.issues.map((i: { key: string; fields: { summary: string } }) => ({
            value: i.key,
            label: `${i.key} — ${i.fields.summary}`,
          }))}
          onChange={setKey}
          buttonClassName="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper inline-flex items-center gap-1.5"
        />
        {epicKey && <ExportMenu chart={false} name={`epic-${epicKey}`} csvPath={`/epic/${epicKey}`} />}
      </div>
      {data && (
        <div>
          <div className="flex h-3 rounded overflow-hidden bg-atl-n-20 mb-2">
            <div className="bg-atl-g-300" style={{ width: `${data.percentComplete}%` }} />
          </div>
          <p className="text-sm text-atl-n-500">
            {data.completed}/{data.total} issues · {data.completedPoints}/{data.totalPoints} pts · {data.percentComplete}% complete
            {data.forecast.sprintsRemaining != null && ` · ~${data.forecast.sprintsRemaining} sprint(s) remaining at ${data.forecast.velocityPerSprint} pts/sprint`}
          </p>
          {data.remainingIssues.length > 0 && (
            <ul className="mt-2 divide-y divide-atl-n-20">
              {data.remainingIssues.slice(0, 8).map((i) => (
                <li key={i.key} className="py-1 text-sm">
                  <Link to={`/browse/${i.key}`} className="text-atl-b-400 hover:underline font-medium">{i.key}</Link>{' '}
                  <span className="text-atl-n-400">{i.summary}</span>
                  <span className="text-xs text-atl-n-200 ml-1">({i.status})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Sprint 028: general, time & release report renderers ----------

const SLICE_COLORS = [CHART.blue, CHART.green, CHART.yellow, CHART.red, CHART.purple, CHART.teal, CHART.gray, CHART.lightGreen];
const STAT_TYPES = ['status', 'priority', 'assignee', 'issuetype', 'reporter', 'resolution', 'project'];

const fmtSec = formatSeconds;

function PieSection({ jql }: { jql: string }) {
  const [statType, setStatType] = useState('status');
  const { data } = useQuery({
    queryKey: ['rpt-pie', jql, statType],
    queryFn: () => fetchReport<{ total: number; groups: { name: string; count: number }[] }>(
      `/pie?jql=${encodeURIComponent(jql)}&statType=${statType}`),
  });
  if (!data) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Pie chart</h2>
        <span className="flex items-center gap-2">
          <ExportMenu chart={false} name="pie" csvPath={`/pie?jql=${encodeURIComponent(jql)}&statType=${statType}`} />
          <SelectMenu
            value={statType}
            title="Statistic type"
            label={<span className="text-sm">{statType}</span>}
            options={STAT_TYPES.map((t) => ({ value: t, label: t }))}
            onChange={setStatType}
            buttonClassName="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper inline-flex items-center gap-1.5"
          />
        </span>
      </div>
      {!data.groups.length ? <p className="text-sm text-atl-n-200 py-4">No issues in scope.</p> : (
        <div>
          <div className="flex h-3 rounded overflow-hidden bg-atl-n-20 mb-2">
            {data.groups.map((g, i) => (
              <div key={g.name} style={{ width: `${(g.count / data.total) * 100}%`, background: SLICE_COLORS[i % SLICE_COLORS.length] }} title={`${g.name}: ${g.count}`} />
            ))}
          </div>
          <ul className="divide-y divide-atl-n-20">
            {data.groups.map((g, i) => (
              <li key={g.name} className="py-1 text-sm flex justify-between">
                <span className="text-atl-n-500 flex items-center gap-2">
                  <i className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
                  {g.name}
                </span>
                <span className="text-atl-n-300">{g.count} ({Math.round((g.count / data.total) * 100)}%)</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TwoDimMatrix({ jql }: { jql: string }) {
  const [xstatType, setX] = useState('status');
  const [ystatType, setY] = useState('assignee');
  const { data } = useQuery({
    queryKey: ['rpt-2d', jql, xstatType, ystatType],
    queryFn: () => fetchReport<{ total: number; xLabels: string[]; yLabels: string[]; cells: Record<string, number> }>(
      `/two-dimensional?jql=${encodeURIComponent(jql)}&xstatType=${xstatType}&ystatType=${ystatType}`),
  });
  if (!data) return null;
  const sel = (v: string, set: (s: string) => void, label: string) => (
    <SelectMenu
      value={v}
      title={label}
      label={<span className="text-sm">{v}</span>}
      options={STAT_TYPES.map((t) => ({ value: t, label: t }))}
      onChange={set}
      buttonClassName="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper inline-flex items-center gap-1.5"
    />
  );
  const maxCell = Math.max(1, ...Object.values(data.cells));
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Two-dimensional</h2>
        <div className="flex items-center gap-2 text-xs text-atl-n-300">
          <ExportMenu chart={false} name="two-dimensional" csvPath={`/two-dimensional?jql=${encodeURIComponent(jql)}&xstatType=${xstatType}&ystatType=${ystatType}`} />
          {sel(ystatType, setY, 'rows')} × {sel(xstatType, setX, 'columns')}
        </div>
      </div>
      {!data.total ? <p className="text-sm text-atl-n-200 py-4">No issues in scope.</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr className="text-xs text-atl-n-200">
                <th className="py-1 pr-3 text-left font-medium">{ystatType} \ {xstatType}</th>
                {data.xLabels.map((x) => <th key={x} className="pr-3 font-medium">{x}</th>)}
                <th className="font-medium">T</th>
              </tr>
            </thead>
            <tbody>
              {data.yLabels.map((y) => {
                const row = data.xLabels.map((x) => data.cells[JSON.stringify([x, y])] ?? 0);
                return (
                  <tr key={y} className="border-t border-atl-n-20">
                    <td className="py-1 pr-3 text-atl-n-500">{y}</td>
                    {row.map((c, i) => (
                      <td key={i} className="pr-3">
                        <span className="inline-block min-w-6 text-center rounded-sm px-1"
                          style={{ background: c ? `rgba(0,82,204,${0.08 + 0.55 * (c / maxCell)})` : 'transparent' }}>
                          {c || ''}
                        </span>
                      </td>
                    ))}
                    <td className="text-atl-n-300">{row.reduce((a, b) => a + b, 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreatedResolvedChart({ jql }: { jql: string }) {
  const [days, setDays] = useState(30);
  const [cumulative, setCumulative] = useState(false);
  const { data } = useQuery({
    queryKey: ['rpt-cvr', jql, days, cumulative],
    queryFn: () => fetchReport<{ series: { date: string; created: number; resolved: number }[] }>(
      `/created-vs-resolved?jql=${encodeURIComponent(jql)}&days=${days}&cumulative=${cumulative}`),
  });
  if (!data) return null;
  const max = Math.max(1, ...data.series.flatMap((p) => [p.created, p.resolved]));
  const n = data.series.length;
  const x = (i: number) => PAD + (i / Math.max(1, n - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = (k: 'created' | 'resolved') =>
    data.series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p[k])}`).join(' ');
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Created vs resolved</h2>
        <div className="flex items-center gap-3">
          <ExportMenu name="created-vs-resolved" csvPath={`/created-vs-resolved?jql=${encodeURIComponent(jql)}&days=${days}&cumulative=${cumulative}`} />
          <label className="text-xs text-atl-n-300 flex items-center gap-1">
            <input type="checkbox" checked={cumulative} onChange={(e) => setCumulative(e.target.checked)} /> Cumulative
          </label>
          <SelectMenu
            value={String(days)}
            title="Days"
            label={<span className="text-sm">{days} days</span>}
            options={[7, 14, 30, 90].map((d) => ({ value: String(d), label: `${d} days` }))}
            onChange={(v) => setDays(Number(v))}
            buttonClassName="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper inline-flex items-center gap-1.5"
          />
        </div>
      </div>
      {!n ? <p className="text-sm text-atl-n-200 py-4">No activity in range.</p> : (
        <div>
          <div className="flex items-center gap-4 mb-2 text-xs text-atl-n-200">
            <span className="flex items-center gap-1"><i className="w-3 h-0.5 bg-atl-b-400 inline-block" /> Created</span>
            <span className="flex items-center gap-1"><i className="w-3 h-0.5 bg-atl-g-300 inline-block" /> Resolved</span>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl">
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PAD} x2={W - PAD} y1={y(max * f)} y2={y(max * f)} stroke={SVG.n40} />
                <text x={4} y={y(max * f) + 4} fontSize="10" fill={SVG.label}>{Math.round(max * f)}</text>
              </g>
            ))}
            <path d={line('created')} stroke={CHART.blue} strokeWidth="2" fill="none" />
            <path d={line('resolved')} stroke={CHART.green} strokeWidth="2" fill="none" />
          </svg>
        </div>
      )}
    </div>
  );
}

function WorkloadTable({ projectKey }: { projectKey: string }) {
  const { data } = useQuery({
    queryKey: ['rpt-workload', projectKey],
    queryFn: () => fetchReport<{ users: { user: string; openIssues: number; points: number; remainingEstimateSec: number }[] }>(
      `/workload?projectKey=${projectKey}`),
  });
  if (!data) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">User workload</h2>
        <ExportMenu chart={false} name="workload" csvPath={`/workload?projectKey=${projectKey}`} />
      </div>
      {!data.users.length ? <p className="text-sm text-atl-n-200 py-4">No open issues.</p> : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-atl-n-200 border-b border-atl-n-30">
              <th className="py-1 font-medium">Assignee</th><th className="font-medium">Open issues</th>
              <th className="font-medium">Points</th><th className="font-medium">Remaining est.</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.user} className="border-b border-atl-n-20">
                <td className="py-1.5 text-atl-n-500">{u.user}</td>
                <td className="text-atl-n-400">{u.openIssues}</td>
                <td className="text-atl-n-400">{u.points}</td>
                <td className="text-atl-n-400">{fmtSec(u.remainingEstimateSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AverageAgeChart({ jql }: { jql: string }) {
  const { data } = useQuery({
    queryKey: ['rpt-age', jql],
    queryFn: () => fetchReport<{ unresolved: number; buckets: { bucket: string; issues: number; avgAgeDays: number }[] }>(
      `/average-age?jql=${encodeURIComponent(`${jql} AND resolution = Unresolved`)}`),
  });
  if (!data) return null;
  const max = Math.max(1, ...data.buckets.map((b) => b.issues));
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Average age <span className="font-normal text-atl-n-200">({data.unresolved} unresolved)</span></h2>
        <ExportMenu name="average-age" csvPath={`/average-age?jql=${encodeURIComponent(`${jql} AND resolution = Unresolved`)}`} />
      </div>
      {!data.buckets.length ? <p className="text-sm text-atl-n-200 py-4">No unresolved issues.</p> : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-2xl">
          {data.buckets.map((b, i) => {
            const bw = (W - PAD * 2) / data.buckets.length - 8;
            const bx = PAD + i * ((W - PAD * 2) / data.buckets.length);
            const bh = (b.issues / max) * (H - PAD * 2);
            return (
              <g key={b.bucket}>
                <rect x={bx} y={H - PAD - bh} width={bw} height={bh} fill={CHART.purple} rx="2">
                  <title>{b.bucket}: {b.issues} issues, avg {b.avgAgeDays}d</title>
                </rect>
                <text x={bx + bw / 2} y={H - PAD + 14} fontSize="10" textAnchor="middle" fill={SVG.label}>{b.bucket}</text>
                <text x={bx + bw / 2} y={H - PAD - bh - 4} fontSize="10" textAnchor="middle" fill={SVG.n500}>{b.issues}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function ResolutionTimeChart({ jql }: { jql: string }) {
  const [groupBy, setGroupBy] = useState('priority');
  const { data } = useQuery({
    queryKey: ['rpt-rt', jql, groupBy],
    queryFn: () => fetchReport<{ resolved: number; groups: { name: string; issues: number; avgDays: number }[] }>(
      `/resolution-time?jql=${encodeURIComponent(jql)}&groupBy=${groupBy}`),
  });
  if (!data) return null;
  const max = Math.max(0.1, ...data.groups.map((g) => g.avgDays));
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Resolution time <span className="font-normal text-atl-n-200">({data.resolved} resolved)</span></h2>
        <span className="flex items-center gap-2">
          <ExportMenu chart={false} name="resolution-time" csvPath={`/resolution-time?jql=${encodeURIComponent(jql)}&groupBy=${groupBy}`} />
          <SelectMenu
            value={groupBy}
            title="Group by"
            label={<span className="text-sm">{groupBy}</span>}
            options={['priority', 'issuetype', 'assignee', 'status'].map((t) => ({ value: t, label: t }))}
            onChange={setGroupBy}
            buttonClassName="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper inline-flex items-center gap-1.5"
          />
        </span>
      </div>
      {!data.groups.length ? <p className="text-sm text-atl-n-200 py-4">No resolved issues.</p> : (
        <ul className="divide-y divide-atl-n-20">
          {data.groups.map((g, i) => (
            <li key={g.name} className="py-1.5 text-sm flex items-center gap-3">
              <span className="w-28 text-atl-n-500 truncate" title={g.name}>{g.name}</span>
              <span className="flex-1 h-3 rounded-sm" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length], width: `${(g.avgDays / max) * 100}%`, maxWidth: '70%' }} />
              <span className="text-atl-n-300 text-xs">{g.avgDays}d avg · {g.issues} issues</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TimeTrackingSection({ projectKey }: { projectKey: string }) {
  const { data } = useQuery({
    queryKey: ['rpt-tt', projectKey],
    queryFn: () => fetchReport<{ totals: { originalEstimateSec: number; timeSpentSec: number; remainingEstimateSec: number }; issues: { key: string; summary: string; done: boolean; originalEstimateSec: number; timeSpentSec: number; remainingEstimateSec: number }[] }>(
      `/time-tracking?projectKey=${projectKey}`),
  });
  if (!data) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Time tracking</h2>
        <ExportMenu chart={false} name="time-tracking" csvPath={`/time-tracking?projectKey=${projectKey}`} />
      </div>
      {!data.issues.length ? <p className="text-sm text-atl-n-200 py-4">No estimates or worklogs in this project.</p> : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-atl-n-200 border-b border-atl-n-30">
              <th className="py-1 font-medium">Issue</th><th className="font-medium">Original</th>
              <th className="font-medium">Spent</th><th className="font-medium">Remaining</th>
            </tr>
          </thead>
          <tbody>
            {data.issues.slice(0, 10).map((i) => (
              <tr key={i.key} className="border-b border-atl-n-20">
                <td className="py-1.5">
                  <IssueKeyLink
                    issueKey={i.key}
                    categoryKey={i.done ? 'done' : undefined}
                    className="text-atl-b-400 hover:underline font-medium"
                  />{' '}
                  <span className="text-atl-n-400">{i.summary}</span>
                </td>
                <td className="text-atl-n-400">{fmtSec(i.originalEstimateSec)}</td>
                <td className="text-atl-n-400">{fmtSec(i.timeSpentSec)}</td>
                <td className="text-atl-n-400">{fmtSec(i.remainingEstimateSec)}</td>
              </tr>
            ))}
            <tr className="font-semibold text-atl-n-600">
              <td className="py-1.5">Total ({data.issues.length})</td>
              <td>{fmtSec(data.totals.originalEstimateSec)}</td>
              <td>{fmtSec(data.totals.timeSpentSec)}</td>
              <td>{fmtSec(data.totals.remainingEstimateSec)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

function TimesheetSection({ projectKey }: { projectKey: string }) {
  const { data } = useQuery({
    queryKey: ['rpt-ts', projectKey],
    queryFn: () => fetchReport<{ workdaySec: number; users: { user: string; totalSec: number; days: Record<string, number> }[]; totalsByDay: Record<string, number> }>(
      `/timesheet?projectKey=${projectKey}`),
  });
  if (!data) return null;
  const dates = Object.keys(data.totalsByDay).sort();
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Timesheet <span className="font-normal text-atl-n-200">(last 14 days)</span></h2>
        <ExportMenu chart={false} name="timesheet" csvPath={`/timesheet?projectKey=${projectKey}`} />
      </div>
      {!data.users.length ? <p className="text-sm text-atl-n-200 py-4">No work logged.</p> : (
        <div className="overflow-x-auto">
          <table className="text-sm">
            <thead>
              <tr className="text-left text-xs text-atl-n-200 border-b border-atl-n-30">
                <th className="py-1 pr-4 font-medium">User</th>
                {dates.map((d) => <th key={d} className="pr-3 font-medium">{d.slice(5)}</th>)}
                <th className="font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.user} className="border-b border-atl-n-20">
                  <td className="py-1.5 pr-4 text-atl-n-500">{u.user}</td>
                  {dates.map((d) => (
                    <td key={d} className="pr-3 text-atl-n-400" style={u.days[d] && u.days[d] < data.workdaySec ? { color: SVG.red } : undefined}>
                      {u.days[d] ? fmtSec(u.days[d]) : '—'}
                    </td>
                  ))}
                  <td className="text-atl-n-600 font-medium">{fmtSec(u.totalSec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VersionReportSection({ projectKey }: { projectKey: string }) {
  const { data: versions } = useQuery({ queryKey: ['versions', projectKey], queryFn: () => fetchVersions(projectKey) });
  const [id, setId] = useState('');
  const versionId = id || versions?.[0]?.id;
  const { data } = useQuery({
    queryKey: ['rpt-version', versionId],
    queryFn: () => fetchReport<{ version: { name: string; releaseDate?: string }; issues: number; doneIssues: number; percentDone: number; remainingPoints: number; remainingEstimateSec: number; forecast: { velocityPerSprint: number | null; predictedDate: string | null; confidence: string } }>(
      `/version/${versionId}`),
    enabled: Boolean(versionId),
  });
  if (!versions) return null;
  if (!versions.length) return <p className="text-sm text-atl-n-200 py-4">No versions in this project.</p>;
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Version report</h2>
        <span className="flex items-center gap-2">
          {versionId && <ExportMenu chart={false} name="version-report" csvPath={`/version/${versionId}`} />}
          <SelectMenu
            value={versionId ?? ''}
            title="Version"
            label={<span className="text-sm">{versions.find((v) => v.id === versionId)?.name ?? 'Version'}</span>}
            options={versions.map((v) => ({
              value: v.id,
              label: `${v.name}${v.released ? ' (released)' : ''}`,
            }))}
            onChange={setId}
            buttonClassName="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper inline-flex items-center gap-1.5"
          />
        </span>
      </div>
      {data && (
        <div>
          <div className="flex h-3 rounded overflow-hidden bg-atl-n-20 mb-2">
            <div className="bg-atl-g-300" style={{ width: `${data.percentDone}%` }} />
          </div>
          <p className="text-sm text-atl-n-500">
            {data.doneIssues}/{data.issues} issues · {data.percentDone}% done
            {data.remainingPoints ? ` · ${data.remainingPoints} pts remaining` : ''}
            {data.remainingEstimateSec ? ` · ${fmtSec(data.remainingEstimateSec)} remaining` : ''}
          </p>
          <p className="text-xs text-atl-n-300 mt-1">
            {data.forecast.predictedDate
              ? `Forecast: ${data.forecast.predictedDate} at ${data.forecast.velocityPerSprint} pts/sprint (confidence: ${data.forecast.confidence})`
              : `No forecast — needs a closed sprint with points (confidence: ${data.forecast.confidence})`}
            {data.version.releaseDate ? ` · planned ${String(data.version.releaseDate).slice(0, 10)}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}

function ProjectSummarySection({ projectKey }: { projectKey: string }) {
  const { data } = useQuery({
    queryKey: ['rpt-project', projectKey],
    queryFn: () => fetchReport<{ openIssues: number; byStatus: { name: string; category?: string; count: number }[]; byType: { name: string; count: number }[]; byPriority: { name: string; count: number }[] }>(
      `/project/${projectKey}`),
  });
  if (!data) return null;
  const col = (title: string, rows: { name: string; count: number }[]) => (
    <div className="flex-1">
      <h3 className="text-xs font-semibold text-atl-n-300 uppercase tracking-wide mb-1">{title}</h3>
      <ul className="divide-y divide-atl-n-20">
        {rows.map((r) => (
          <li key={r.name} className="py-1 text-sm flex justify-between">
            <span className="text-atl-n-500">{r.name}</span><span className="text-atl-n-300">{r.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-atl-n-800">Project summary <span className="font-normal text-atl-n-200">({data.openIssues} open)</span></h2>
        <ExportMenu chart={false} name="project-summary" csvPath={`/project/${projectKey}`} />
      </div>
      <div className="flex gap-8">
        {col('Status', data.byStatus)}
        {col('Type', data.byType)}
        {col('Priority', data.byPriority)}
      </div>
    </div>
  );
}

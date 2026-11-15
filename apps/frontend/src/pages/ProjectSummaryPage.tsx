// 058 US7 — project landing page (/projects/:key). Fixed five-widget layout:
// status donut, recent activity, open-by-priority, upcoming versions, and
// workload + live agent activity. Better-than-Jira: agent presence is a
// first-class widget, not a plugin.
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchProject, fetchProjectSummary } from '../api/client.js';
import PageHeader from '../components/PageHeader.js';
import { IssueKeyLink } from '../components/IssueKey.js';
import UserHoverCard from '../components/UserHoverCard.js';

const CARD = 'rounded border border-atl-n-30 bg-atl-paper';
const CARD_H = 'border-b border-atl-n-30 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200';

const CATEGORY_COLOR: Record<string, string> = {
  new: '#8993A4',
  indeterminate: '#0C66E4',
  done: '#1F845A',
};

/** SVG donut for the status rollup — fixed size, no chart lib (D14). */
function Donut({ data }: { data: { label: string; count: number; color: string }[] }) {
  const total = data.reduce((n, d) => n + d.count, 0) || 1;
  const R = 54;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width="140" height="140" viewBox="0 0 140 140" className="shrink-0">
        <g transform="rotate(-90 70 70)">
          {data.map((d, i) => {
            const frac = d.count / total;
            const el = (
              <circle
                key={i}
                cx="70" cy="70" r={R}
                fill="none"
                stroke={d.color}
                strokeWidth="20"
                strokeDasharray={`${frac * C} ${C}`}
                strokeDashoffset={-acc * C}
              />
            );
            acc += frac;
            return el;
          })}
        </g>
        <text x="70" y="66" textAnchor="middle" className="fill-atl-n-800" fontSize="22" fontWeight="600">
          {total}
        </text>
        <text x="70" y="84" textAnchor="middle" className="fill-atl-n-300" fontSize="10">
          issues
        </text>
      </svg>
      <ul className="min-w-0 space-y-1 text-xs">
        {data.map((d) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.color }} />
            <span className="truncate text-atl-n-700" title={d.label}>{d.label}</span>
            <span className="ml-auto pl-3 font-medium text-atl-n-800">{d.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function rel(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export default function ProjectSummaryPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const { data: project } = useQuery({
    queryKey: ['project', projectKey],
    queryFn: () => fetchProject(projectKey!),
    enabled: Boolean(projectKey),
  });
  const { data: s, isLoading } = useQuery({
    queryKey: ['project-summary', projectKey],
    queryFn: () => fetchProjectSummary(projectKey!),
    enabled: Boolean(projectKey),
  });

  const maxPriority = Math.max(1, ...(s?.openByPriority.map((p) => p.count) ?? []));
  const maxLoad = Math.max(1, ...(s?.workload.map((w) => w.open) ?? []));

  return (
    <div className="h-full overflow-y-auto">
      <PageHeader
        title={project ? `${project.name} (${project.key})` : projectKey ?? ''}
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: project?.name ?? projectKey ?? '' }]}
      />
      <div className="p-5">
        {isLoading || !s ? (
          <div className="text-sm text-atl-n-300">Loading project summary…</div>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {/* status rollup */}
            <section className={CARD}>
              <h3 className={CARD_H}>Status overview</h3>
              <div className="p-4">
                {s.statusRollup.length ? (
                  <Donut
                    data={s.statusRollup.map((r) => ({
                      label: r.status,
                      count: r.count,
                      color: CATEGORY_COLOR[r.category] ?? CATEGORY_COLOR.new!,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-atl-n-300">No issues yet.</p>
                )}
                <div className="mt-3 text-xs text-atl-n-300">
                  {s.totals.open} open · {s.totals.issues} total
                </div>
              </div>
            </section>

            {/* recent activity */}
            <section className={`${CARD} xl:col-span-2`}>
              <h3 className={CARD_H}>Recent activity</h3>
              <ul className="max-h-72 divide-y divide-atl-n-30 overflow-y-auto">
                {s.activity.map((a, i) => (
                  <li key={i} className="flex items-baseline gap-3 px-4 py-2 text-xs">
                    <IssueKeyLink
                      issueKey={a.issueKey}
                      className="shrink-0 font-medium text-atl-b-300 hover:underline"
                    />
                    <span className="min-w-0 truncate text-atl-n-700" title={a.text || a.issueSummary}>
                      {a.type === 'comment' ? '💬' : '✎'} {a.text || a.issueSummary}
                    </span>
                    <span className="ml-auto shrink-0 text-atl-n-300">
                      <UserHoverCard user={{ accountId: a.actorAccountId, displayName: a.actor, agent: a.agent }}>
                        <span>{a.actor}</span>
                      </UserHoverCard>
                      {a.agent && <span className="ml-1 rounded bg-atl-n-20 px-1 text-[9px]">AGENT</span>}
                      {a.channel !== 'ui' && <span className="ml-1 text-atl-n-200">via {a.channel}</span>}
                      {' · '}
                      {rel(a.at)}
                    </span>
                  </li>
                ))}
                {s.activity.length === 0 && (
                  <li className="px-4 py-6 text-sm text-atl-n-300">No activity yet.</li>
                )}
              </ul>
            </section>

            {/* open by priority */}
            <section className={CARD}>
              <h3 className={CARD_H}>Open by priority</h3>
              <ul className="space-y-2 p-4">
                {s.openByPriority.map((p) => (
                  <li key={p.priority}>
                    <div className="mb-0.5 flex justify-between text-xs">
                      <span className="text-atl-n-700">{p.priority}</span>
                      <span className="font-medium text-atl-n-800">{p.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-atl-n-20">
                      <div
                        className="h-1.5 rounded-full bg-atl-b-300"
                        style={{ width: `${(p.count / maxPriority) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
                {s.openByPriority.length === 0 && (
                  <li className="text-sm text-atl-n-300">Nothing open.</li>
                )}
              </ul>
            </section>

            {/* upcoming versions */}
            <section className={CARD}>
              <h3 className={CARD_H}>Upcoming versions</h3>
              <ul className="divide-y divide-atl-n-30">
                {s.upcomingVersions.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <Link
                      to={`/projects/${projectKey}/releases`}
                      className="min-w-0 truncate font-medium text-atl-n-800 hover:text-atl-b-300"
                      title={v.name}
                    >
                      {v.name}
                    </Link>
                    <span className="ml-auto shrink-0 text-xs text-atl-n-300">
                      {v.issueCount} issue{v.issueCount === 1 ? '' : 's'}
                      {v.releaseDate ? ` · ${v.releaseDate}` : ' · no date'}
                    </span>
                  </li>
                ))}
                {s.upcomingVersions.length === 0 && (
                  <li className="px-4 py-6 text-sm text-atl-n-300">No unreleased versions.</li>
                )}
              </ul>
            </section>

            {/* workload + agents */}
            <section className={CARD}>
              <h3 className={CARD_H}>Workload &amp; agents</h3>
              <div className="p-4">
                {(s.agents.running + s.agents.blocked + s.agents.needsAnswer) > 0 ? (
                  <div className="mb-3 rounded bg-atl-b-50 px-3 py-2 text-xs text-atl-n-700">
                    <span className="font-medium">
                      {s.agents.running + s.agents.blocked + s.agents.needsAnswer} live agent session
                      {s.agents.running + s.agents.blocked + s.agents.needsAnswer === 1 ? '' : 's'}
                    </span>
                    {s.agents.needsAnswer > 0 && (
                      <span className="ml-2 font-medium text-atl-y-500">
                        {s.agents.needsAnswer} needs an answer
                      </span>
                    )}
                    <div className="mt-0.5 text-atl-n-300">{s.agents.agents.join(', ')}</div>
                  </div>
                ) : (
                  <div className="mb-3 text-xs text-atl-n-300">No agents working this project right now.</div>
                )}
                <ul className="space-y-2">
                  {s.workload.map((w) => (
                    <li key={w.user}>
                      <div className="mb-0.5 flex justify-between text-xs">
                        <span className="text-atl-n-700">
                          <UserHoverCard user={{ accountId: w.accountId, displayName: w.user, agent: w.agent }}>
                            <span>{w.user}</span>
                          </UserHoverCard>
                          {w.agent && <span className="ml-1 rounded bg-atl-n-20 px-1 text-[9px]">AGENT</span>}
                        </span>
                        <span className="font-medium text-atl-n-800">{w.open}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-atl-n-20">
                        <div
                          className={`h-1.5 rounded-full ${w.agent ? 'bg-atl-p-300' : 'bg-atl-g-400'}`}
                          style={{ width: `${(w.open / maxLoad) * 100}%` }}
                        />
                      </div>
                    </li>
                  ))}
                  {s.workload.length === 0 && (
                    <li className="text-sm text-atl-n-300">Nothing assigned.</li>
                  )}
                </ul>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

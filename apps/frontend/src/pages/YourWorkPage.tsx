// "Your work" — Jira's home: tabbed lists (Worked on / Viewed / Assigned to you /
// Watching / Reported by you) + recent-projects right rail. Driven by /api/internal/me/work.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { fetchMyWork, fetchProposals, type Issue } from '../api/client.js';
import { PROJECT_COLORS } from '../lib/palette.js';
import IssueTypeIcon from '../components/IssueTypeIcon.js';
import { IssueKeyLink } from '../components/IssueKey.js';
import EmptyState from '../components/EmptyState.js';
import StatusLozenge from '../components/StatusLozenge.js';
import PriorityIcon from '../components/PriorityIcon.js';
import UserHoverCard from '../components/UserHoverCard.js';
import TimeLoggedCard from '../components/TimeLoggedCard.js';
import { formatDateTime } from '../lib/format.js';

function IssueRow({ issue }: { issue: Issue }) {
  const f = issue.fields;
  const navigate = useNavigate();
  // Row is a clickable div (backlog pattern) so the key can be a real
  // IssueKeyLink anchor with its hovercard — nested <a> in <a> is invalid.
  return (
    <div
      onClick={() => navigate(`/browse/${issue.key}`)}
      className="flex items-center gap-3 px-3 py-2 hover:bg-atl-n-20 rounded-sm group cursor-pointer"
    >
      <span className="inline-flex" title={f.issuetype?.name ?? 'task'}>
        <IssueTypeIcon name={f.issuetype?.name ?? 'task'} size={16} />
      </span>
      <IssueKeyLink
        issueKey={issue.key}
        issue={issue}
        categoryKey={f.status?.statusCategory?.key}
        onClick={(e) => e.stopPropagation()}
        className="text-[12px] font-medium text-atl-b-400 w-[104px] shrink-0 hover:underline"
      />
      <Link
        to={`/browse/${issue.key}`}
        onClick={(e) => e.stopPropagation()}
        className="flex-1 text-[13px] text-atl-n-800 truncate group-hover:underline"
        title={f.summary}
      >
        {f.summary}
      </Link>
      <span className="inline-flex items-center gap-1 text-[11px] text-atl-n-300 min-w-[64px] max-w-[96px] overflow-hidden" title={f.priority?.name}>
        {f.priority?.name && <PriorityIcon name={f.priority.name} size={13} />}
        <span className="truncate">{f.priority?.name}</span>
      </span>
      <span className="min-w-[76px] text-center">
        <StatusLozenge name={f.status?.name ?? ''} categoryKey={f.status?.statusCategory?.key} />
      </span>
      <UserHoverCard user={f.assignee}>
        <span
          className="text-[11px] text-atl-n-300 min-w-[90px] max-w-[90px] text-right truncate"
          title={f.assignee?.accountId ? undefined : f.assignee?.displayName}
        >
          {f.assignee?.displayName ?? '—'}
        </span>
      </UserHoverCard>
    </div>
  );
}

type TabId = 'worked' | 'viewed' | 'assigned' | 'watching' | 'reported';

const TABS: { id: TabId; label: string }[] = [
  { id: 'worked', label: 'Worked on' },
  { id: 'viewed', label: 'Viewed' },
  { id: 'assigned', label: 'Assigned to you' },
  { id: 'watching', label: 'Watching' },
  { id: 'reported', label: 'Reported by you' },
];

const EMPTY: Record<TabId, string> = {
  worked: 'Issues you create or comment on will show here.',
  viewed: 'Issues you recently viewed will show here.',
  assigned: 'Nothing assigned to you right now.',
  watching: 'Issues you watch will show here.',
  reported: 'Issues you reported will show here.',
};

export default function YourWorkPage() {
  const { data, isLoading } = useQuery({ queryKey: ['mywork'], queryFn: fetchMyWork });
  const [tab, setTab] = useState<TabId>('worked');
  // Agent writes waiting on this user's review — the list is already scoped
  // server-side (administered projects + own), so a nonzero count means the
  // user can act. The banner is the only always-on approvals surface; the
  // inbox itself lives at /approvals.
  const { data: pendingProposals } = useQuery({
    queryKey: ['proposals', 'pending'],
    queryFn: () => fetchProposals({ status: 'pending' }),
  });
  const pendingCount = pendingProposals?.total ?? 0;

  if (isLoading || !data) {
    return <div className="p-8 text-atl-n-300">Loading…</div>;
  }

  const viewedIssues = data.recent
    .map((r) => ({ issue: r.issue, viewedAt: r.viewedAt, key: r.key }))
    .filter((r): r is { issue: Issue; viewedAt: string; key: string } => Boolean(r.issue));

  const lists: Record<TabId, Issue[]> = {
    worked: data.worked,
    viewed: viewedIssues.map((v) => v.issue),
    assigned: data.assigned,
    watching: data.watching,
    reported: data.reported,
  };
  const viewedAt = new Map(viewedIssues.map((v) => [v.key, v.viewedAt]));

  // Recent projects deduped from viewed issues — Jira shows them as a card
  // row above the issue lists.
  const recentProjects: { key: string; name: string }[] = [];
  const seenProjects = new Set<string>();
  for (const v of viewedIssues) {
    const p = v.issue.fields.project;
    if (p && !seenProjects.has(p.key)) {
      seenProjects.add(p.key);
      recentProjects.push({ key: p.key, name: p.name });
    }
  }

  return (
    <div className="flex-1 overflow-auto bg-atl-n-20">
      <div className="max-w-[1100px] mx-auto py-8 px-6">
        <h1 className="text-[24px] font-semibold text-atl-n-800 mb-6">Your work</h1>
        {pendingCount > 0 && (
          <Link
            to="/approvals"
            className="mb-6 flex items-center gap-3 rounded-[3px] border border-atl-y-300 bg-atl-y-50 px-4 py-3 hover:bg-atl-y-75 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0 text-atl-y-500" fill="currentColor">
              <path d="M8 1.5 1.5 13.5h13L8 1.5zm0 3.7 4.2 6.6H3.8L8 5.2zm-.8 3.3h1.6v1.9H7.2V8.5zm0 2.9h1.6v1.9H7.2v-1.9z" />
            </svg>
            <span className="text-sm font-medium text-atl-n-800">
              {pendingCount} agent {pendingCount === 1 ? 'write is' : 'writes are'} waiting for your review
            </span>
            <span className="ml-auto shrink-0 text-sm font-medium text-atl-b-300">Review →</span>
          </Link>
        )}
        {recentProjects.length > 0 && (
          <div className="mb-6 flex gap-3 overflow-x-auto pb-1">
            {recentProjects.map((p) => {
              const bg = PROJECT_COLORS[[...p.name].reduce((a, c) => a + c.charCodeAt(0), 0) % PROJECT_COLORS.length];
              return (
                <Link
                  key={p.key}
                  to={`/projects/${p.key}`}
                  className="flex items-center gap-3 min-w-[200px] rounded-[3px] border border-atl-n-40 bg-atl-paper px-3 py-2.5 shadow-sm hover:shadow"
                >
                  <span
                    className="flex h-8 w-8 items-center justify-center rounded-md text-[11px] font-bold text-white shrink-0"
                    style={{ backgroundColor: bg }}
                  >
                    {p.key.slice(0, 2)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-atl-n-800" title={p.name}>{p.name}</span>
                    <span className="block text-[11px] text-atl-n-300">{p.key}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
        <TimeLoggedCard />
        <div className="items-start">
          <section className="bg-atl-paper border border-atl-n-40 rounded-[3px] shadow-sm">
            <div role="tablist" aria-label="Your work lists" className="flex border-b border-atl-n-40 px-2">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`px-3 py-2.5 text-[13px] font-medium border-b-2 -mb-px ${
                    tab === t.id
                      ? 'border-atl-b-400 text-atl-b-400'
                      : 'border-transparent text-atl-n-500 hover:text-atl-n-800'
                  }`}
                >
                  {t.label}
                  <span className="ml-1.5 text-[11px] text-atl-n-300">{lists[t.id].length}</span>
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="py-1 min-h-[120px]">
              {lists[tab].length === 0 ? (
                <EmptyState title={EMPTY[tab]} />
              ) : (
                <>
                  <div className="flex items-center gap-3 px-3 py-1.5 border-b border-atl-n-30 text-[10px] font-semibold uppercase tracking-wider text-atl-n-200">
                    <span className="w-4" />
                    <span className="w-[104px]">Key</span>
                    <span className="flex-1">Summary</span>
                    <span className="min-w-[64px]">Priority</span>
                    <span className="min-w-[76px] text-center">Status</span>
                    <span className="min-w-[90px] text-right">Assignee</span>
                  </div>
                  {tab === 'viewed'
                    ? lists.viewed.map((i) => (
                        <div key={i.key} className="flex items-center">
                          <div className="flex-1 min-w-0">
                            <IssueRow issue={i} />
                          </div>
                          <span className="pr-3 text-[11px] text-atl-n-300 whitespace-nowrap">
                            {formatDateTime(viewedAt.get(i.key)!)}
                          </span>
                        </div>
                      ))
                    : lists[tab].map((i) => <IssueRow key={i.id} issue={i} />)}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

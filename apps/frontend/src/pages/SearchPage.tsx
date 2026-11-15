import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchFavouriteFilters, fetchMyFilters, type SavedFilter } from '../api/client.js';
import IssueSearchView from '../components/IssueSearchView.js';

/** Jira's built-in navigator filters — each is just a JQL preset. */
const SYSTEM_FILTERS: { name: string; to: string }[] = [
  { name: 'My open issues', to: `/issues?mode=jql&jql=${encodeURIComponent('assignee = currentUser() AND resolution IS EMPTY ORDER BY updated DESC')}` },
  { name: 'Reported by me', to: `/issues?mode=jql&jql=${encodeURIComponent('reporter = currentUser() ORDER BY created DESC')}` },
  { name: 'All issues', to: '/issues' },
  { name: 'Open issues', to: `/issues?mode=jql&jql=${encodeURIComponent('resolution IS EMPTY ORDER BY updated DESC')}` },
  { name: 'Done issues', to: `/issues?mode=jql&jql=${encodeURIComponent('statusCategory = Done ORDER BY resolved DESC')}` },
  { name: 'Created recently', to: `/issues?mode=jql&jql=${encodeURIComponent('created >= -1w ORDER BY created DESC')}` },
  { name: 'Resolved recently', to: `/issues?mode=jql&jql=${encodeURIComponent('resolved >= -1w ORDER BY resolved DESC')}` },
  { name: 'Updated recently', to: `/issues?mode=jql&jql=${encodeURIComponent('updated >= -1w ORDER BY updated DESC')}` },
  { name: 'Viewed recently', to: `/issues?mode=jql&jql=${encodeURIComponent('lastViewed >= -1w')}` },
];

/** Jira navigator's left panel: system filters + starred + owned, collapsible. */
function FiltersPanel({ collapsed }: { collapsed: boolean }) {
  const [params] = useSearchParams();
  const activeId = params.get('filterId') ?? '';
  const activeJql = params.get('jql') ?? '';
  const { data: favourites } = useQuery({ queryKey: ['filters', 'favourite'], queryFn: fetchFavouriteFilters });
  const { data: mine } = useQuery({ queryKey: ['filters', 'my'], queryFn: fetchMyFilters });
  if (collapsed) return null;

  const starred = favourites ?? [];
  const owned = (mine ?? []).filter((f) => !starred.some((s) => s.id === f.id));

  const row = (f: SavedFilter) => (
    <li key={f.id}>
      <Link
        to={`/issues?filterId=${f.id}`}
        className={`block truncate px-3 py-1.5 rounded-[3px] text-sm ${
          activeId === f.id ? 'bg-atl-b-50 text-atl-b-500 font-medium' : 'text-atl-n-600 hover:bg-atl-n-10'
        }`}
        title={`${f.name} — ${f.jql}`}
      >
        {f.name}
      </Link>
    </li>
  );

  return (
    <div className="h-full overflow-y-auto py-4">
      <div className="flex items-center justify-between px-3 mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">Filters</span>
        <Link to="/filters" className="text-xs text-atl-b-300 hover:underline">
          Manage
        </Link>
      </div>
      <ul className="mb-3 space-y-0.5">
        {SYSTEM_FILTERS.map((f) => {
          const jql = new URLSearchParams(f.to.split('?')[1] ?? '').get('jql') ?? '';
          const active = f.to === '/issues' ? !activeId && !activeJql : jql === activeJql;
          return (
            <li key={f.name}>
              <Link
                to={f.to}
                className={`block truncate px-3 py-1.5 rounded-[3px] text-sm ${
                  active ? 'bg-atl-b-50 text-atl-b-500 font-medium' : 'text-atl-n-600 hover:bg-atl-n-10'
                }`}
                title={f.name}
              >
                {f.name}
              </Link>
            </li>
          );
        })}
      </ul>
      {starred.length > 0 && (
        <>
          <div className="px-3 mb-1 text-xs text-atl-n-200">Starred</div>
          <ul className="mb-3 space-y-0.5">{starred.map(row)}</ul>
        </>
      )}
      <div className="px-3 mb-1 text-xs text-atl-n-200">My filters</div>
      {owned.length === 0 && starred.length === 0 ? (
        <p className="px-3 text-xs text-atl-n-200">
          No filters yet — save this search with "Save as".
        </p>
      ) : (
        <ul className="space-y-0.5">{owned.map(row)}</ul>
      )}
    </div>
  );
}

/** Global advanced issue search — cross-project, Basic ⇄ JQL, saved filters. */
export default function SearchPage() {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('tf:issues.filtersPanel') === 'collapsed'
  );
  const toggle = () => {
    setCollapsed((c) => {
      localStorage.setItem('tf:issues.filtersPanel', c ? 'open' : 'collapsed');
      return !c;
    });
  };
  return (
    <div className="flex items-start">
      <div
        className={`shrink-0 border-r border-atl-n-30 sticky top-12 h-[calc(100vh-3rem)] transition-[width] ${
          collapsed ? 'w-0 border-r-0' : 'w-56'
        }`}
      >
        <FiltersPanel collapsed={collapsed} />
      </div>
      <button
        onClick={toggle}
        aria-label={collapsed ? 'Show filters panel' : 'Hide filters panel'}
        title={collapsed ? 'Show filters' : 'Hide filters'}
        className="sticky top-12 shrink-0 mt-6 -ml-0 z-10 w-5 h-12 rounded-r bg-atl-paper border border-l-0 border-atl-n-30 text-atl-n-200 hover:text-atl-n-500 hover:bg-atl-n-10 flex items-center justify-center"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          {collapsed ? <path d="M2 1l3 3-3 3" /> : <path d="M6 1L3 4l3 3" />}
        </svg>
      </button>
      <div className="flex-1 min-w-0">
        <IssueSearchView />
      </div>
    </div>
  );
}

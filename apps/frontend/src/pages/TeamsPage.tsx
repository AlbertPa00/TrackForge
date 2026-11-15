import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchPeople } from '../api/client.js';
import EmptyState from '../components/EmptyState.js';
import UserAvatar from '../components/UserAvatar.js';
import UserHoverCard from '../components/UserHoverCard.js';

const PAGE = 50;

/** Jira parity: one flat, searchable people directory. Membership + open-issue
 *  counts come from /api/internal/people — paginated server-side, so the page
 *  browses the whole roster instead of the old 50-hit picker cap. */
export default function TeamsPage() {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const people = useInfiniteQuery({
    queryKey: ['people', debounced],
    queryFn: ({ pageParam }) => fetchPeople(debounced, pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.isLast ? undefined : last.startAt + last.values.length),
  });
  const rows = people.data?.pages.flatMap((p) => p.values) ?? [];
  const lastPage = people.data?.pages.at(-1);

  // accountId, not displayName — stable when two people share a name.
  const memberJql = (accountId: string) =>
    `/issues?mode=jql&jql=${encodeURIComponent(
      `assignee = "${accountId}" AND statusCategory != Done`
    )}`;

  return (
    <div className="px-6 py-5 max-w-3xl">
      <div className="text-xs text-atl-n-200 mb-0.5">Directory</div>
      <h1 className="text-xl font-semibold text-atl-n-800 mb-1">People</h1>
      <p className="text-sm text-atl-n-200 mb-5">
        Everyone with access to this site and their open assignments.
      </p>

      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people"
        aria-label="Search people"
        className="mb-4 h-9 w-72 rounded-[3px] border-2 border-atl-n-40 px-3 text-sm focus:border-atl-b-300 outline-none"
      />

      {people.isLoading && <p className="text-sm text-atl-n-200 py-6">Loading people…</p>}
      {!people.isLoading && !rows.length && (
        <div className="border border-atl-n-30 rounded">
          <EmptyState
            title={debounced ? 'No people found' : 'No people yet'}
            description={
              debounced
                ? `Nobody matches "${debounced}".`
                : 'People appear here once they have access.'
            }
          />
        </div>
      )}

      {!!rows.length && (
        <section className="rounded-[3px] border border-atl-n-30 bg-atl-paper">
          <header className="grid grid-cols-[1fr_6rem_5rem] items-center gap-3 px-4 py-2 border-b border-atl-n-30 text-[11px] font-semibold uppercase tracking-wide text-atl-n-200">
            <span>Name</span>
            <span className="text-right">Open issues</span>
            <span />
          </header>
          <ul className="divide-y divide-atl-n-20">
            {rows.map((m) => (
              <li key={m.accountId} className="grid grid-cols-[1fr_6rem_5rem] items-center gap-3 px-4 py-2">
                <span className="flex items-center gap-3 min-w-0">
                  <UserAvatar displayName={m.displayName} size={24} />
                  <UserHoverCard user={m}>
                    <Link
                      to={`/profile/${m.accountId}`}
                      className="text-sm text-atl-n-700 hover:text-atl-b-300 hover:underline min-w-0 truncate"
                      title={m.displayName}
                    >
                      {m.displayName}
                    </Link>
                  </UserHoverCard>
                </span>
                <span className="text-sm text-atl-n-300 text-right tabular-nums">{m.openIssueCount}</span>
                <span className="text-right">
                  {m.openIssueCount > 0 && (
                    <Link to={memberJql(m.accountId)} className="text-xs text-atl-b-300 hover:underline">
                      View issues
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {people.hasNextPage && (
            <div className="border-t border-atl-n-20 px-4 py-2 text-center">
              <button
                type="button"
                disabled={people.isFetchingNextPage}
                onClick={() => void people.fetchNextPage()}
                className="text-sm text-atl-b-300 hover:underline disabled:opacity-50"
              >
                {people.isFetchingNextPage
                  ? 'Loading…'
                  : `Show more (${rows.length} of ${lastPage?.total ?? rows.length})`}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

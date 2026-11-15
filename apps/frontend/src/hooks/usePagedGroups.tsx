import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchGroups } from '../api/client.js';

const PAGE = 50;

/** Server-paged, name-filtered group list — every admin group picker/dialog
 *  shares this so large directories never truncate at the first 100 rows.
 *  Callers pass the raw input value; debouncing is handled here.
 *  The ['admin-groups'] key prefix keeps existing mutation invalidations. */
export function usePagedGroups(query: string, enabled = true) {
  const [debounced, setDebounced] = useState(query.trim());
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const q = useInfiniteQuery({
    queryKey: ['admin-groups', 'paged', debounced],
    queryFn: ({ pageParam }) => fetchGroups(debounced || undefined, pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.groups.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled,
  });
  return {
    ...q,
    groups: q.data?.pages.flatMap((p) => p.groups) ?? [],
    total: q.data?.pages.at(-1)?.total ?? 0,
    debounced,
  };
}

/** Inline "show more" footer for group lists rendered inside scroll boxes. */
export function PagedGroupsFooter({
  loaded,
  total,
  isFetchingNextPage,
  fetchNextPage,
}: {
  loaded: number;
  total: number;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  return (
    <div className="px-2 py-1.5 text-center">
      <button
        type="button"
        disabled={isFetchingNextPage}
        onClick={fetchNextPage}
        className="text-xs text-atl-b-300 hover:underline disabled:opacity-50"
      >
        {isFetchingNextPage ? 'Loading…' : `Show more groups (${loaded} of ${total})`}
      </button>
    </div>
  );
}

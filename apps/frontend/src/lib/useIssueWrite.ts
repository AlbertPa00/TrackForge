// 065 US7 — the markIssueWrite + issue-query-invalidation pair that 14
// components each hand-rolled. Non-component callers (api/events.ts,
// lib/commands.ts) keep calling markIssueWrite directly.
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useCallback } from 'react';
import { markIssueWrite } from './issueWrites.js';

/** Returns a `mark(extraKeys?)` that stamps the local write and refreshes
 *  every surface an issue row can appear on: the detail query, the issues
 *  list/search, board cards, the backlog page, and sprint sections. Only
 *  active observers refetch — stale inactive ones repaint on next mount. */
export function useIssueWrite(issueKey: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (extraKeys: QueryKey[] = []) => {
      markIssueWrite(issueKey);
      const keys: QueryKey[] = [
        ['issue', issueKey],
        ['issues'],
        ['board-issues'],
        ['backlog'],
        ['sprint-issues'],
        ...extraKeys,
      ];
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    },
    [issueKey, queryClient]
  );
}

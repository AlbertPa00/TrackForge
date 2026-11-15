import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { Issue } from '../api/client.js';

type IssueList = { issues?: Issue[] } | Issue[] | undefined;

/**
 * 058 US2 — snapshot every cached issue list under `prefixes`, apply `fn` to
 * each, and return a rollback that restores the snapshots. Pair it with
 * TanStack Query's `onMutate`/`onError` so optimistic mutations can never
 * silently diverge from the server.
 */
export function patchIssueLists(
  qc: QueryClient,
  prefixes: QueryKey[],
  fn: (issues: Issue[], queryKey: QueryKey) => Issue[]
): () => void {
  const snapshots: [QueryKey, unknown][] = [];
  for (const prefix of prefixes) {
    snapshots.push(...qc.getQueriesData({ queryKey: prefix }));
    qc.setQueriesData({ queryKey: prefix }, (old: IssueList) => {
      if (!old) return old;
      if (Array.isArray(old)) return fn(old, prefix);
      if (!Array.isArray(old.issues)) return old;
      return { ...old, issues: fn(old.issues, prefix) };
    });
  }
  return () => snapshots.forEach(([k, d]) => qc.setQueryData(k, d));
}

/** Same contract as {@link patchIssueLists} for a single cached `['issue', key]`. */
export function patchIssue(
  qc: QueryClient,
  issueKey: string,
  fn: (issue: Issue) => Issue
): () => void {
  const key: QueryKey = ['issue', issueKey];
  const snapshot = qc.getQueryData<Issue>(key);
  qc.setQueryData<Issue>(key, (old) => (old ? fn(old) : old));
  return () => {
    if (snapshot !== undefined) qc.setQueryData(key, snapshot);
  };
}

/** Move `keys` so they land before `beforeKey` (or after `afterKey`) in a list. */
export function reorderKeys(
  issues: Issue[],
  keys: string[],
  beforeKey?: string,
  afterKey?: string
): Issue[] {
  const keySet = new Set(keys);
  const moving = issues.filter((i) => keySet.has(i.key));
  const rest = issues.filter((i) => !keySet.has(i.key));
  const anchorKey = beforeKey ?? afterKey;
  if (!moving.length) return issues;
  if (!anchorKey) return [...rest, ...moving];
  const idx = rest.findIndex((i) => i.key === anchorKey);
  if (idx === -1) return issues;
  const at = beforeKey ? idx : idx + 1;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

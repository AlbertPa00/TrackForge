// Shared write tracker for the "This issue was updated elsewhere" detector.
// The detector watches fields.updated advancing without a local write — but
// most issue mutations live in child components (assignee, transitions,
// comments, links, attachments, worklogs, votes/watch) and all of them
// invalidate the issue query, so each needs to mark its write. SSE events
// also mark themselves when the actor is the current user (api/events.ts).
const writes = new Map<string, number>();

/** Call whenever a local mutation succeeds for `issueKey`. */
export function markIssueWrite(issueKey: string): void {
  writes.set(issueKey, Date.now());
}

/** Timestamp of the last local write for `issueKey` (0 = never). */
export function lastIssueWrite(issueKey: string): number {
  return writes.get(issueKey) ?? 0;
}

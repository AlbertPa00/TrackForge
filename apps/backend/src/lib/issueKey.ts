// Sprint 065 US4 — single source for issue-key parsing. ~29 hand-rolled
// `split('-')` sites had diverged on case handling (`parseIssueKey` accepts
// lowercase, bulkService's regex didn't) and on whether a malformed key is
// an error or a non-match. Two spellings remain: the pure parser here, and
// the 404-throwing `parseIssueKey` in issueService for route paths.

export interface IssueKeyParts {
  projectKey: string;
  issueNumber: number;
}

const ISSUE_KEY_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

/** `PROJ-123` → parts (project key normalized to uppercase), or null when the
 *  string is not an issue key at all. */
export function parseIssueKeyParts(key: string): IssueKeyParts | null {
  const m = ISSUE_KEY_RE.exec(key.trim());
  return m ? { projectKey: m[1].toUpperCase(), issueNumber: Number(m[2]) } : null;
}

/** Prisma `where` fragment for the (projectKey, issueNumber) unique pair. */
export function issueKeyToWhere(key: string): { issueNumber: number; project: { key: string } } | null {
  const parts = parseIssueKeyParts(key);
  return parts ? { issueNumber: parts.issueNumber, project: { key: parts.projectKey } } : null;
}

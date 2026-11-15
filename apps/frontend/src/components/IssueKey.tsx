import { Link } from 'react-router-dom';
import type { Issue } from '../api/client.js';
import IssueHoverCard from './IssueHoverCard.js';

/** Jira: a struck-through key means the issue sits in a done-category status
 *  (Done, Closed, Cancelled…) — the category, never the status name. */
export const isDoneCategory = (categoryKey?: string | null): boolean => categoryKey === 'done';

const strike = (categoryKey?: string | null) => (isDoneCategory(categoryKey) ? 'line-through' : '');

export default function IssueKey({
  issueKey,
  categoryKey,
  className = '',
}: {
  issueKey: string;
  categoryKey?: string | null;
  className?: string;
}) {
  return <span className={`${strike(categoryKey)} ${className}`}>{issueKey}</span>;
}

export function IssueKeyLink({
  issueKey,
  categoryKey,
  className = '',
  onClick,
  preview = true,
  issue,
}: {
  issueKey: string;
  categoryKey?: string | null;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  /** Jira-style preview card on hover/focus; pass the row's `issue` to skip
   *  the lazy fetch, or `preview={false}` to opt out. */
  preview?: boolean;
  issue?: Issue;
}) {
  const link = (
    // truncate: width-capped call sites (e.g. backlog's w-20) ellipsize the key
    // instead of letting it paint into the next column; the preview card still
    // shows it in full.
    <Link to={`/browse/${issueKey}`} onClick={onClick} className={`truncate ${strike(categoryKey)} ${className}`}>
      {issueKey}
    </Link>
  );
  if (!preview) return link;
  return (
    // shrink-0 on the anchor wrapper: the key is atomic — a squeezed wrapper
    // would let it paint over the neighboring summary.
    <IssueHoverCard issueKey={issueKey} issue={issue} anchorClassName="shrink-0">
      {link}
    </IssueHoverCard>
  );
}

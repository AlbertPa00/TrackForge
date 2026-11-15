import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchIssue, type Issue } from '../api/client.js';
import IssueTypeIcon from './IssueTypeIcon.js';
import PriorityIcon from './PriorityIcon.js';
import StatusLozenge from './StatusLozenge.js';
import UserAvatar from './UserAvatar.js';
import HoverCard from './HoverCard.js';
import { formatDateTime, formatRelative } from '../lib/format.js';

/**
 * Jira-style issue preview on hover/focus of an issue-key link. The card is
 * supplemental only — everything it shows lives at /browse/{key}. When the
 * row's `issue` is provided no fetch happens; otherwise the full issue is
 * loaded lazily on first open and cached by react-query.
 */
export default function IssueHoverCard({
  issueKey,
  issue,
  children,
  anchorClassName,
}: {
  issueKey: string;
  /** When the caller already has the Issue (e.g. a table row) — skips the fetch. */
  issue?: Issue;
  children: React.ReactNode;
  /** Forwarded to the HoverCard anchor span — pass `shrink-0` for triggers
   *  that must never be squeezed (issue keys are atomic). */
  anchorClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  const { data: fetched } = useQuery({
    queryKey: ['issue', issueKey],
    queryFn: () => fetchIssue(issueKey),
    enabled: open && !issue,
    staleTime: 30_000,
  });
  const shown = issue ?? fetched;

  return (
    <HoverCard
      onOpenChange={setOpen}
      anchorClassName={anchorClassName}
      renderCard={() =>
        shown ? <CardBody issue={shown} /> : <div className="text-xs text-atl-n-200">Loading preview…</div>
      }
    >
      {children}
    </HoverCard>
  );
}

function CardBody({ issue }: { issue: Issue }) {
  const f = issue.fields;
  return (
    <>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="inline-flex" title={f.issuetype.name}>
          <IssueTypeIcon name={f.issuetype.name} hierarchyLevel={f.issuetype.hierarchyLevel} />
        </span>
        <span className="text-xs font-medium text-atl-b-300">{issue.key}</span>
        <span className="ml-auto">
          <StatusLozenge name={f.status.name} categoryKey={f.status.statusCategory.key} title={null} />
        </span>
      </div>
      <div className="mb-2 line-clamp-2 text-sm text-atl-n-800" title={f.summary}>{f.summary}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <span className="text-atl-n-200">Assignee</span>
        <span className="flex items-center gap-1.5 min-w-0">
          <UserAvatar displayName={f.assignee?.displayName} size={16} />
          <span className="truncate text-atl-n-700" title={f.assignee?.displayName}>{f.assignee?.displayName ?? 'Unassigned'}</span>
        </span>
        <span className="text-atl-n-200">Reporter</span>
        <span className="truncate text-atl-n-700" title={f.reporter?.displayName}>{f.reporter?.displayName ?? '—'}</span>
        <span className="text-atl-n-200">Priority</span>
        <span className="flex items-center gap-1 text-atl-n-700">
          <PriorityIcon name={f.priority.name} size={12} />
          {f.priority.name}
        </span>
        <span className="text-atl-n-200">Updated</span>
        <span className="text-atl-n-700" title={formatDateTime(f.updated)}>
          {formatRelative(f.updated)}
        </span>
      </div>
    </>
  );
}

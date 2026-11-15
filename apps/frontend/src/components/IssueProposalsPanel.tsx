// Pending proposals for this issue — an agent's parked write lands here so a
// reviewer can approve / edit-approve / reject without leaving the issue.
// Visibility is server-side (own proposals + administered projects + admins),
// so the panel only appears for users who can act. Live via SSE (events.ts).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchProposals, type Proposal } from '../api/client.js';
import { describeProposal } from '../lib/proposalDisplay.js';
import { markIssueWrite } from '../lib/issueWrites.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { Markdown } from './Markdown.js';
import UserAvatar from './UserAvatar.js';
import { ProposalActions, ProposalPreview, ProposalRawDetails } from './ProposalView.js';

function IssueProposalCard({ proposal: p, onResolved }: { proposal: Proposal; onResolved: () => void }) {
  const display = describeProposal(p);
  return (
    <li
      className={`rounded border p-3 space-y-2.5 ${
        display.destructive ? 'border-atl-r-300 bg-atl-r-50/40' : 'border-atl-y-300 bg-atl-y-50/40'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-atl-n-800" title={display.text}>{display.text}</span>
        <span className="ml-auto shrink-0 rounded bg-atl-y-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-atl-y-500">
          pending
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-atl-n-200">
        <UserAvatar displayName={p.principal.displayName} size={16} />
        <span className="truncate font-medium text-atl-n-500" title={p.principal.displayName}>{p.principal.displayName}</span>
        {p.principal.agent && <span className="uppercase">· agent</span>}
        <span>via {p.channel}</span>
        <span className="ml-auto shrink-0" title={formatDateTime(p.createdAt)}>
          {formatRelative(p.createdAt)}
        </span>
      </div>
      {p.rationale && (
        <div className="rounded-md bg-atl-b-50 border border-atl-b-75 px-2.5 py-1.5 text-xs text-atl-n-700">
          <Markdown text={p.rationale} />
        </div>
      )}
      <ProposalPreview display={display} />
      <ProposalRawDetails proposal={p} />
      <ProposalActions proposal={p} onResolved={onResolved} compact />
    </li>
  );
}

export default function IssueProposalsPanel({ issueKey }: { issueKey: string }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['issue-proposals', issueKey],
    queryFn: () => fetchProposals({ status: 'pending', issue: issueKey }),
    refetchInterval: 60_000,
  });
  const list = data?.proposals ?? [];
  if (!list.length) return null;

  const refresh = () => {
    // The approved replay writes as the agent — mark it so the "updated
    // elsewhere" detector doesn't flag the change the reviewer just applied.
    markIssueWrite(issueKey);
    void qc.invalidateQueries({ queryKey: ['issue-proposals', issueKey] });
    void qc.invalidateQueries({ queryKey: ['issue', issueKey] });
    void qc.invalidateQueries({ queryKey: ['comments', issueKey] });
    void qc.invalidateQueries({ queryKey: ['proposals'] });
  };

  return (
    <section className="bg-atl-paper rounded shadow-sm p-4 space-y-3">
      <h2 className="text-sm font-semibold text-atl-n-800">Pending approvals</h2>
      <p className="text-xs text-atl-n-300">
        {list.length === 1 ? "An agent's write on this issue" : `${list.length} agent writes on this issue`} waiting
        for review. Approving re-validates against current data.
      </p>
      <ul className="space-y-2">
        {list.map((p) => (
          <IssueProposalCard key={p.id} proposal={p} onResolved={refresh} />
        ))}
      </ul>
    </section>
  );
}

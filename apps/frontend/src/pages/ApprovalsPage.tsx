import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  bulkResolveProposals,
  fetchProposal,
  fetchProposals,
  type Proposal,
} from '../api/client.js';
import UserAvatar from '../components/UserAvatar.js';
import IssueKey, { IssueKeyLink } from '../components/IssueKey.js';
import SelectMenu from '../components/SelectMenu.js';
import { Markdown } from '../components/Markdown.js';
import { describeProposal } from '../lib/proposalDisplay.js';
import { ProposalActions, ProposalPreview, ProposalRawDetails } from '../components/ProposalView.js';
import { formatRelative, formatDateTime } from '../lib/format.js';

const METHOD_STYLE: Record<string, string> = {
  POST: 'bg-atl-g-50 text-atl-g-500',
  PUT: 'bg-atl-b-50 text-atl-b-500',
  DELETE: 'bg-atl-r-50 text-atl-r-500',
  PATCH: 'bg-atl-y-50 text-atl-y-500',
};

const STATUS_STYLE: Record<Proposal['status'], string> = {
  pending: 'bg-atl-y-50 text-atl-y-500',
  approved: 'bg-atl-g-50 text-atl-g-500',
  rejected: 'bg-atl-r-50 text-atl-r-500',
  expired: 'bg-atl-n-20 text-atl-n-500',
  failed: 'bg-atl-r-50 text-atl-r-500',
};

const LOZENGE = 'rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider';

function ProposalDetail({ proposal, onResolved }: { proposal: Proposal; onResolved: () => void }) {
  const pending = proposal.status === 'pending';
  const display = describeProposal(proposal);
  return (
    <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-atl-n-30 bg-atl-paper">
      {/* Header */}
      <div className="border-b border-atl-n-30 px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-atl-n-800">{display.text}</div>
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <span className={`${LOZENGE} ${METHOD_STYLE[proposal.method] ?? 'bg-atl-n-20 text-atl-n-600'}`}>
                {proposal.method}
              </span>
              <code className="text-[11px] text-atl-n-300 break-all">{proposal.path}</code>
            </div>
            {proposal.issue && (
              <span className="mt-1.5 inline-block text-sm">
                <IssueKeyLink
                  issueKey={proposal.issue.key}
                  categoryKey={proposal.issue.statusCategory}
                  className="text-atl-b-300 hover:underline"
                />{' '}
                <span className="text-atl-b-300">— {proposal.issue.summary}</span>
              </span>
            )}
          </div>
          <span className={`${LOZENGE} shrink-0 ${STATUS_STYLE[proposal.status]}`}>{proposal.status}</span>
        </div>
        <div className="mt-2.5 flex items-center gap-2 text-sm text-atl-n-500">
          <UserAvatar displayName={proposal.principal.displayName} size={22} />
          <span className="font-medium text-atl-n-700">{proposal.principal.displayName}</span>
          {proposal.principal.agent && (
            <span className={`${LOZENGE} bg-atl-n-20 text-atl-n-500`}>agent</span>
          )}
          {proposal.token && (
            <span className="text-atl-n-200">
              via {proposal.token.name}{proposal.token.revoked ? ' (revoked)' : ''}
            </span>
          )}
          <span className="text-atl-n-200">·</span>
          <span className="text-atl-n-200">{proposal.channel}</span>
          <span className="text-atl-n-200">·</span>
          <span className="text-atl-n-200" title={formatDateTime(proposal.createdAt)}>
            {formatRelative(proposal.createdAt)}
          </span>
        </div>
      </div>

      <div className="px-5 py-4">
        {proposal.rationale && (
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1.5">Agent rationale</div>
            <div className="rounded-md bg-atl-b-50 border border-atl-b-75 px-3.5 py-2.5 text-sm text-atl-n-700">
              <Markdown text={proposal.rationale} />
            </div>
          </div>
        )}

        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 mb-1.5">
            {proposal.diff ? 'Proposed changes (validated preview)' : 'Request'}
          </div>
          <ProposalPreview display={display} />
          <div className="mt-2">
            <ProposalRawDetails proposal={proposal} />
          </div>
        </div>

        {proposal.appliedWithEdits && (
          <div className="mt-4 rounded-md bg-atl-b-50 px-3.5 py-2.5 text-sm text-atl-n-700">
            Applied with edits by the approver.
          </div>
        )}
        {proposal.status === 'failed' && proposal.reason && (
          <div className="mt-4 rounded-md bg-atl-r-50 px-3.5 py-2.5 text-sm text-atl-r-500">{proposal.reason}</div>
        )}
        {proposal.resolvedBy && (
          <div className="mt-4 text-xs text-atl-n-200">
            {proposal.status} by {proposal.resolvedBy.displayName} · {proposal.resolvedAt ? formatDateTime(proposal.resolvedAt) : ''}
            {proposal.reason && proposal.status !== 'failed' && <> — {proposal.reason}</>}
          </div>
        )}

        {pending && (
          <div className="mt-5 rounded-md border border-atl-n-30 bg-atl-n-10 px-4 py-3.5">
            <ProposalActions proposal={proposal} onResolved={onResolved} />
            <p className="mt-2.5 text-xs text-atl-n-200">
              Approving re-validates the request against current data — a stale proposal fails safely instead of applying.
              The change is recorded as {proposal.principal.displayName} with your approval in the changelog.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ApprovalsPage() {
  const [selected, setSelected] = useState<Proposal | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();

  // Deep link (?proposal=<id>) — notification clicks land here when the write
  // has no issue context, or when the reviewer came straight from a link.
  const deepLinkId = searchParams.get('proposal');
  const { data: deepLinked } = useQuery({
    queryKey: ['proposal', deepLinkId],
    queryFn: () => fetchProposal(deepLinkId!),
    enabled: !!deepLinkId,
  });

  // proposal_* SSE events invalidate the 'proposals' key (events.ts) — the
  // 15s poll was redundant.
  const { data, isLoading } = useQuery({
    queryKey: ['proposals', statusFilter],
    queryFn: () => fetchProposals(statusFilter === 'pending' ? { status: 'pending' } : {}),
  });
  const proposals = data?.proposals ?? [];

  const refresh = () => {
    setChecked(new Set());
    void qc.invalidateQueries({ queryKey: ['proposals'] });
    void qc.invalidateQueries({ queryKey: ['proposal'] });
  };

  const bulk = useMutation({
    mutationFn: (action: 'approve' | 'reject') => bulkResolveProposals([...checked], action),
    onSuccess: refresh,
  });

  const toggle = (id: string) =>
    setChecked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Explicit selection wins; otherwise honour the deep link. Clicking a list
  // row also clears the param so refreshing stays on the manual selection.
  // Prefer the fresh list copy of the selected proposal so post-resolve
  // refetches render the updated status instead of the stale pending object.
  const detail =
    (selected && (proposals.find((p) => p.id === selected.id) ?? selected)) ??
    deepLinked ??
    null;
  const select = (p: Proposal) => {
    setSelected(p);
    if (deepLinkId) setSearchParams({}, { replace: true });
  };

  return (
    <div className="flex-1 min-h-0 overflow-hidden bg-atl-n-10">
      <div className="h-full flex gap-4 px-6 py-4">
        {/* List column */}
        <div className="w-[400px] shrink-0 flex flex-col min-h-0 rounded-lg border border-atl-n-30 bg-atl-paper overflow-hidden">
          <div className="px-4 py-3 border-b border-atl-n-30 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold text-atl-n-800">Approvals</h1>
              <p className="text-xs text-atl-n-200 mt-0.5">
                {proposals.length} {statusFilter === 'pending' ? 'pending' : ''} {proposals.length === 1 ? 'proposal' : 'proposals'}
              </p>
            </div>
            <SelectMenu
              value={statusFilter}
              label={statusFilter === 'pending' ? 'Pending' : 'All'}
              onChange={(v) => setStatusFilter(v as 'pending' | 'all')}
              ariaLabel="Filter by status"
              options={[
                { value: 'pending', label: 'Pending' },
                { value: 'all', label: 'All' },
              ]}
            />
          </div>
          {checked.size > 0 && (
            <div className="px-4 py-2 border-b border-atl-n-30 flex items-center gap-2 bg-atl-n-10">
              <span className="text-xs font-medium text-atl-n-500">{checked.size} selected</span>
              <button
                onClick={() => bulk.mutate('approve')}
                disabled={bulk.isPending}
                className="ml-auto h-7 px-3 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-white text-xs font-medium disabled:opacity-50"
              >
                Approve all
              </button>
              <button
                onClick={() => bulk.mutate('reject')}
                disabled={bulk.isPending}
                className="h-7 px-3 rounded-[3px] border border-atl-n-40 bg-atl-paper text-xs text-atl-n-700 hover:bg-atl-n-10 disabled:opacity-50"
              >
                Reject all
              </button>
            </div>
          )}
          <div className="flex-1 overflow-auto">
            {isLoading && (
              <div className="p-3 space-y-2" aria-label="Loading approvals">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="rounded-md border border-atl-n-20 p-3 space-y-2">
                    <div className="flex gap-2">
                      <div className="h-4 w-12 rounded bg-atl-n-30 animate-pulse" />
                      <div className="h-4 w-24 rounded bg-atl-n-20 animate-pulse" />
                    </div>
                    <div className="h-3 w-3/4 rounded bg-atl-n-20 animate-pulse" />
                  </div>
                ))}
              </div>
            )}
            {!isLoading && proposals.length === 0 && (
              <div className="p-8 text-center">
                <div className="text-sm font-medium text-atl-n-500">No {statusFilter === 'pending' ? 'pending ' : ''}proposals</div>
                <p className="mt-1 text-xs text-atl-n-200">
                  Agent writes that need a human's OK land here.
                </p>
              </div>
            )}
            {proposals.map((p) => {
              const d = describeProposal(p);
              return (
                <button
                  key={p.id}
                  onClick={() => select(p)}
                  className={`w-full text-left px-4 py-3 border-b border-atl-n-10 hover:bg-atl-n-10 flex items-start gap-3 ${
                    detail?.id === p.id ? 'bg-atl-b-50 hover:bg-atl-b-50' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked.has(p.id)}
                    onChange={() => toggle(p.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select proposal ${p.id}`}
                    className="mt-1 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {p.issue ? (
                        <IssueKey
                          issueKey={p.issue.key}
                          categoryKey={p.issue.statusCategory}
                          className="text-[13px] font-medium text-atl-n-800 shrink-0"
                        />
                      ) : (
                        <span className={`${LOZENGE} ${METHOD_STYLE[p.method] ?? 'bg-atl-n-20 text-atl-n-600'}`}>
                          {p.method}
                        </span>
                      )}
                      <span className="min-w-0 truncate text-[13px] font-medium text-atl-n-800" title={d.text}>{d.text}</span>
                      <span className={`${LOZENGE} ml-auto shrink-0 ${STATUS_STYLE[p.status]}`}>
                        {p.status}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-atl-n-500 truncate" title={p.issue?.summary ?? p.path}>
                      {p.issue?.summary ?? p.path}
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-atl-n-200">
                      <UserAvatar displayName={p.principal.displayName} size={16} />
                      <span className="truncate" title={p.principal.displayName}>{p.principal.displayName}</span>
                      {p.principal.agent && <span className="uppercase">· agent</span>}
                      <span className="ml-auto shrink-0" title={formatDateTime(p.createdAt)}>
                        {formatRelative(p.createdAt)}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail column */}
        {detail ? (
          <ProposalDetail key={detail.id} proposal={detail} onResolved={refresh} />
        ) : proposals.length === 0 && !isLoading ? (
          <div className="flex-1 flex items-center justify-center rounded-lg border border-atl-n-30 bg-atl-paper">
            <div className="text-center px-8">
              <div className="mx-auto mb-3 h-10 w-10 rounded-full bg-atl-g-50 text-atl-g-500 grid place-items-center">
                <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.2 12.4 2.6 8.8l1.4-1.4 2.2 2.2 5.8-5.8 1.4 1.4z" />
                </svg>
              </div>
              <div className="text-sm font-medium text-atl-n-500">
                No {statusFilter === 'pending' ? 'pending' : ''} proposals — all caught up
              </div>
              <p className="mt-1 text-xs text-atl-n-200 max-w-xs">
                When an agent in approval mode writes via the API or MCP, it lands here for review.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center rounded-lg border border-atl-n-30 bg-atl-paper">
            <div className="text-center text-sm text-atl-n-200">
              Select a proposal to review
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

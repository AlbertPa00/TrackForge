// Shared rendering + review controls for parked agent writes (proposals).
// Used by the Approvals inbox (/approvals) and the issue-page review panel —
// humans read the `display` summary; raw payloads stay behind a disclosure.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { approveProposal, rejectProposal, type Proposal } from '../api/client.js';
import type { ProposalDisplay } from '../lib/proposalDisplay.js';
import { Markdown } from './Markdown.js';
import IssueKey, { IssueKeyLink } from './IssueKey.js';

export function ProposalPreview({ display }: { display: ProposalDisplay }) {
  return (
    <div className="space-y-2">
      {!!display.fields?.length && (
        <div className="space-y-2.5">
          {display.fields.map((f, i) => (
            <div key={i} className="text-sm">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">{f.label}</span>
              <div className="mt-1 flex flex-col gap-1">
                {f.from != null && (
                  <div className="rounded bg-atl-r-50 text-atl-r-500 px-2 py-1 text-xs font-mono whitespace-pre-wrap">
                    − {f.from}
                  </div>
                )}
                <div className="rounded bg-atl-g-50 text-atl-g-700 px-2 py-1 text-xs font-mono whitespace-pre-wrap">
                  + {f.to ?? '(empty)'}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {display.markdown && (
        <div className="rounded-md border border-atl-n-30 bg-atl-paper px-3 py-2 text-sm">
          <Markdown text={display.markdown} />
        </div>
      )}
      {!!display.issues?.length && (
        <ul className="space-y-1">
          {display.issues.map((i, idx) => (
            <li key={idx} className="flex items-center gap-2 text-sm">
              {i.key ? (
                i.preview ? (
                  // Previewed key — the issue doesn't exist yet, don't link to a 404.
                  <IssueKey issueKey={i.key} className="shrink-0 text-[13px] font-medium text-atl-b-300" />
                ) : (
                  <IssueKeyLink issueKey={i.key} className="shrink-0 text-[13px] font-medium text-atl-b-300" />
                )
              ) : null}
              {i.summary && <span className="min-w-0 truncate text-atl-n-700" title={i.summary}>{i.summary}</span>}
              {i.meta && <span className="ml-auto shrink-0 text-[11px] text-atl-n-300">{i.meta}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Raw wire payload behind an opt-in disclosure — never the default view. */
export function ProposalRawDetails({ proposal }: { proposal: Proposal }) {
  return (
    <details>
      <summary className="cursor-pointer text-[11px] text-atl-n-300 hover:text-atl-n-500">
        Details · {proposal.method} {proposal.path}
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-atl-n-10 p-2 text-[11px] text-atl-n-600">
        {JSON.stringify({ body: proposal.body, diff: proposal.diff }, null, 2)}
      </pre>
    </details>
  );
}

export function ProposalActions({
  proposal,
  onResolved,
  compact,
}: {
  proposal: Proposal;
  onResolved: () => void;
  compact?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState(() => JSON.stringify(proposal.body ?? {}, null, 2));

  const err = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const approve = useMutation({
    mutationFn: (body?: Record<string, unknown>) => approveProposal(proposal.id, body),
    onSuccess: onResolved,
    onError: err,
  });
  const reject = useMutation({
    mutationFn: () => rejectProposal(proposal.id, reason || undefined),
    onSuccess: onResolved,
    onError: err,
  });

  const approveWithEdits = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(edits);
    } catch {
      setError('Edits must be valid JSON.');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Edits must be a JSON object — the replacement request body.');
      return;
    }
    setError('');
    approve.mutate(parsed as Record<string, unknown>);
  };

  const btn = compact ? 'h-7 px-2.5 text-xs' : 'h-8 px-4 text-sm';
  return (
    <div>
      {error && <div className="mb-2 rounded bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{error}</div>}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => approve.mutate(undefined)}
          disabled={approve.isPending}
          className={`${btn} rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-white font-medium disabled:opacity-50`}
        >
          {approve.isPending ? 'Approving…' : 'Approve & apply'}
        </button>
        <button
          onClick={() => setEditing((v) => !v)}
          disabled={approve.isPending}
          title="Edit the request before approving — your version is re-validated and applied"
          className={`${btn} rounded-[3px] border border-atl-n-40 bg-atl-paper text-atl-n-700 hover:bg-atl-n-10 disabled:opacity-50`}
        >
          {editing ? 'Cancel edit' : 'Edit…'}
        </button>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Rejection reason (optional)"
          className={`${compact ? 'h-7 text-xs' : 'h-8 text-sm'} flex-1 min-w-40 max-w-xs rounded-[3px] border border-atl-n-40 px-2.5 bg-atl-paper`}
        />
        <button
          onClick={() => reject.mutate()}
          disabled={reject.isPending}
          className={`${btn} rounded-[3px] border border-atl-n-40 bg-atl-paper text-atl-n-700 hover:bg-atl-n-10 disabled:opacity-50`}
        >
          {reject.isPending ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
      {editing && (
        <div className="mt-2.5">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
            Edited request body — re-validated on apply
          </div>
          <textarea
            value={edits}
            onChange={(e) => setEdits(e.target.value)}
            rows={Math.min(14, edits.split('\n').length + 1)}
            spellCheck={false}
            className="w-full rounded border border-atl-n-40 bg-atl-paper p-2.5 font-mono text-xs text-atl-n-700 outline-none focus:border-atl-b-300"
          />
          <button
            onClick={approveWithEdits}
            disabled={approve.isPending}
            className={`${btn} mt-2 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-white font-medium disabled:opacity-50`}
          >
            {approve.isPending ? 'Approving…' : 'Approve with edits'}
          </button>
        </div>
      )}
    </div>
  );
}

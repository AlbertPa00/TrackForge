import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchIssueProvenance,
  submitDeliverableReview,
  type WorkReceipt,
} from '../api/client.js';
import ReceiptInspectorDrawer from './ReceiptInspectorDrawer.js';

const REVIEW_BADGE: Record<string, { label: string; cls: string }> = {
  awaiting_review: { label: 'Awaiting Deliverable Review', cls: 'bg-atl-y-50 text-atl-y-500 border-atl-y-75' },
  approved: { label: 'Deliverable Approved', cls: 'bg-atl-g-50 text-atl-g-500 border-atl-g-75' },
  changes_requested: { label: 'Changes Requested', cls: 'bg-atl-r-50 text-atl-r-500 border-atl-r-75' },
  stale: { label: 'Approval Stale (New Edits)', cls: 'bg-atl-y-50 text-atl-y-500 border-atl-y-75' },
};

export default function DeliverableProvenanceStrip({
  issueKey,
  projectKey,
  canEdit,
}: {
  issueKey: string;
  projectKey: string;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const [inspectReceiptId, setInspectReceiptId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [verdict, setVerdict] = useState<'approved' | 'changes_requested'>('approved');
  const [notes, setNotes] = useState('');
  const [notesTouched, setNotesTouched] = useState(false);

  const { data: prov } = useQuery({
    queryKey: ['issue-provenance', issueKey],
    queryFn: () => fetchIssueProvenance(issueKey),
    refetchInterval: 60_000,
  });

  const reviewMut = useMutation({
    mutationFn: () =>
      submitDeliverableReview(issueKey, {
        verdict,
        body: notes.trim() || undefined,
      }),
    onSuccess: () => {
      setReviewOpen(false);
      setNotes('');
      setNotesTouched(false);
      void qc.invalidateQueries({ queryKey: ['issue-provenance', issueKey] });
      void qc.invalidateQueries({ queryKey: ['issue-ledger', issueKey] });
      void qc.invalidateQueries({ queryKey: ['issue-receipts', issueKey] });
      void qc.invalidateQueries({ queryKey: ['comments', issueKey] });
      void qc.invalidateQueries({ queryKey: ['issue', issueKey] });
    },
  });

  if (!prov) return null;
  const hasTopics = prov.topics.length > 0;
  const hasReceipts = prov.receipts.length > 0;
  const drift = prov.latestDriverSession?.driftStatus;
  const hasBadDrift = Boolean(drift && drift !== 'clean' && drift !== 'untracked');
  const reviewStatus = prov.deliverableReview.status;

  if (!hasTopics && !hasReceipts && !hasBadDrift && reviewStatus === 'none') {
    return null;
  }

  const badge = REVIEW_BADGE[reviewStatus];
  const notesTooShort = verdict === 'changes_requested' && notes.trim().length < 10;
  const showNotesError = notesTouched && notesTooShort;

  return (
    <>
      <section
        aria-label="Deliverable provenance and verification"
        className="mb-4 space-y-2.5 rounded border border-atl-n-30 bg-atl-n-10 p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-atl-n-500">Deliverable & Provenance</span>
            {badge && (
              <span className={`rounded border px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
                {badge.label}
              </span>
            )}
            {prov.deliverableReview.activeApproval && (
              <span className="text-atl-n-400">
                by <strong>{prov.deliverableReview.activeApproval.reviewer.displayName}</strong>
                {prov.deliverableReview.activeApproval.pinnedHeadSha
                  ? ` · SHA ${prov.deliverableReview.activeApproval.pinnedHeadSha.slice(0, 8)}`
                  : ''}
              </span>
            )}
          </div>

          {canEdit && (hasReceipts || prov.latestDriverSession) && (
            <button
              type="button"
              onClick={() => setReviewOpen((o) => !o)}
              className="rounded bg-atl-b-400 px-2.5 py-1 text-xs font-medium text-white hover:bg-atl-b-500"
            >
              {reviewOpen ? 'Cancel Review' : reviewStatus === 'approved' ? 'Re-review Deliverable' : 'Review Deliverable'}
            </button>
          )}
        </div>

        {hasBadDrift && (
          <div className="rounded border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-xs text-atl-r-500">
            <strong>Drift alert ({drift?.replace(/_/g, ' ')}):</strong>{' '}
            {drift === 'phantom_handoff'
              ? 'The last driver session claimed completion/handoff without any corroborating Git commit or verified diff receipt.'
              : 'The last driver session modified files outside its declared stigmergic traces. Inspect receipts before approving.'}
          </div>
        )}

        {hasTopics && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-atl-n-600">
            <span className="font-medium text-atl-n-400">Authorized in Town Hall:</span>
            {prov.topics.map((t) => (
              <Link
                key={t.topicId + t.relation}
                to={`/projects/${projectKey}/town-hall?topic=${t.topicId}`}
                className="inline-flex items-center gap-1 rounded border border-atl-n-30 bg-atl-paper px-2 py-0.5 font-medium text-atl-b-400 hover:underline"
                title={t.decisionSummary ?? t.title}
              >
                <span className="uppercase text-[10px] text-atl-n-300">{t.relation}</span>
                <span className="truncate max-w-[280px]">{t.title}</span>
              </Link>
            ))}
          </div>
        )}

        {hasReceipts && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase text-atl-n-400">
              Proof Artifacts ({prov.receipts.length})
              {prov.changedFiles.length > 0 ? ` · ${prov.changedFiles.length} file(s) touched` : ''}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {prov.receipts.map((r: WorkReceipt) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setInspectReceiptId(r.id)}
                  title={`Inspect ${r.kind} receipt: ${r.summary}`}
                  className="inline-flex items-center gap-1.5 rounded border border-atl-n-30 bg-atl-paper px-2.5 py-1 text-xs text-atl-n-800 hover:border-atl-b-200 hover:bg-atl-b-50"
                >
                  <span className="font-mono text-[10px] font-semibold uppercase text-atl-b-500">{r.kind}</span>
                  <span className="font-mono text-[11px] text-atl-n-400">{r.sha256.slice(0, 8)}</span>
                  <span className="rounded bg-atl-n-20 px-1 text-[10px] text-atl-n-600">
                    {r.verification.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[11px] text-atl-b-400 underline">
                    {r.hasInlineContent || r.attachment ? 'Inspect' : 'Details'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {reviewOpen && (
          <div className="mt-2 space-y-2 rounded border border-atl-n-40 bg-atl-paper p-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-semibold text-atl-n-700">Verdict:</span>
              <button
                type="button"
                onClick={() => setVerdict('approved')}
                className={`rounded px-2.5 py-1 font-medium ${
                  verdict === 'approved' ? 'bg-atl-g-400 text-white' : 'bg-atl-n-20 text-atl-n-600'
                }`}
              >
                Approve & Pin Receipts
              </button>
              <button
                type="button"
                onClick={() => setVerdict('changes_requested')}
                className={`rounded px-2.5 py-1 font-medium ${
                  verdict === 'changes_requested' ? 'bg-atl-r-400 text-white' : 'bg-atl-n-20 text-atl-n-600'
                }`}
              >
                Request Changes (Wake Agent)
              </button>
            </div>
            <div>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onBlur={() => setNotesTouched(true)}
                aria-invalid={showNotesError || undefined}
                placeholder={
                  verdict === 'changes_requested'
                    ? 'Explain what the agent must fix (at least 10 characters — delivered to its durable inbox)…'
                    : 'Optional review notes (pinned with current SHA and receipts)…'
                }
                className="w-full rounded border border-atl-n-40 bg-atl-paper p-2 text-xs text-atl-n-800"
              />
              {showNotesError && (
                <p className="mt-0.5 text-[11px] text-atl-r-500">
                  Please provide at least 10 characters describing the requested changes.
                </p>
              )}
              {reviewMut.isError && (
                <p className="mt-0.5 text-[11px] text-atl-r-500">{(reviewMut.error as Error).message}</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={reviewMut.isPending || notesTooShort}
                onClick={() => {
                  setNotesTouched(true);
                  if (!notesTooShort) reviewMut.mutate();
                }}
                className="rounded bg-atl-b-400 px-3 py-1 text-xs font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
              >
                {reviewMut.isPending ? 'Submitting…' : verdict === 'approved' ? 'Confirm Approval' : 'Send Changes Requested'}
              </button>
            </div>
          </div>
        )}
      </section>

      <ReceiptInspectorDrawer receiptId={inspectReceiptId} onClose={() => setInspectReceiptId(null)} />
    </>
  );
}

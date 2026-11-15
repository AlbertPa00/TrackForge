import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import IssueDetailView from './IssueDetailView.js';
import IssueKey from './IssueKey.js';
import ConfirmDialog from './ConfirmDialog.js';
import { fetchIssue } from '../api/client.js';
import { useModalDialog } from '../lib/useModalDialog.js';

/**
 * 058 US1 — slide-over issue drawer for board/backlog. Selection lives in the
 * `?selectedIssue=` query param so refresh/deep-link/back-button restore it.
 * Plain clicks open the drawer; Ctrl/Cmd-click still routes to /browse/:key.
 * a11y (037): native <dialog> — focus moves in on open, Tab is contained,
 * Escape/close requests run the draft guard, focus returns to the invoker.
 */
export default function IssueDrawer() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const issueKey = params.get('selectedIssue');
  const panelRef = useRef<HTMLDialogElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Shares IssueDetailView's cache entry — no extra request.
  const { data: issue } = useQuery({
    queryKey: ['issue', issueKey],
    queryFn: () => fetchIssue(issueKey!),
    enabled: !!issueKey,
  });

  const hasCommentDraft = () =>
    Boolean(
      panelRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-tf-comment]')
        ?.value.trim()
    );

  const close = () => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.delete('selectedIssue');
    return next;
  });

  const requestClose = () => {
    // Unsaved-changes guard — a non-empty comment draft survives in the DOM
    // even though the component state is buried inside IssueDetailView.
    if (hasCommentDraft()) setConfirmDiscard(true);
    else close();
  };

  // Guarded: Esc and outside presses route through requestClose so the draft
  // guard runs first. A nested modal (e.g. transition dialog inside
  // IssueDetailView, or the discard confirm) is topmost in the top layer, so
  // Escape reaches it instead of the drawer — no manual check needed.
  useModalDialog({ ref: panelRef, open: !!issueKey, onClose: requestClose, guarded: true });

  if (!issueKey) return null;

  return (
    <dialog
      ref={panelRef}
      aria-label={`Issue ${issueKey}`}
      className="tf-drawer m-0 ml-auto flex h-full max-h-full w-full flex-col border-0 border-l border-atl-n-30 bg-atl-paper p-0 shadow-2xl outline-none sm:w-[min(760px,92vw)]"
    >
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-atl-n-30 shrink-0">
        <IssueKey
          issueKey={issueKey}
          categoryKey={issue?.fields.status.statusCategory.key}
          className="text-xs font-medium text-atl-n-200"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(`/browse/${issueKey}`)}
            className="text-xs text-atl-b-300 hover:underline"
          >
            Open full page →
          </button>
          <button
            onClick={requestClose}
            aria-label="Close drawer"
            className="h-6 w-6 rounded text-atl-n-300 hover:bg-atl-n-20 hover:text-atl-n-700"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <IssueDetailView key={issueKey} issueKey={issueKey} pane />
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard comment?"
        body="Your comment draft will be lost when the drawer closes."
        confirmLabel="Discard"
        danger={false}
        onConfirm={() => {
          setConfirmDiscard(false);
          close();
        }}
        onClose={() => setConfirmDiscard(false)}
      />
    </dialog>
  );
}

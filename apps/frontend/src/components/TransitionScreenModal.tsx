import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchResolutions, searchAssignableUsers, type Transition } from '../api/client.js';
import Modal from './Modal.js';

/**
 * Jira-style transition screen — collects `fields` declared by the transition
 * (resolution, comment, assignee) before the transition is executed.
 * `initialResolution` (067) preselects a suggested resolution.
 */
export default function TransitionScreenModal({
  transition,
  issueKey,
  projectKey,
  initialResolution,
  onClose,
  onSubmit,
  submitting,
  error,
}: {
  transition: Transition | null;
  issueKey: string;
  projectKey?: string;
  /** Seed the resolution select (e.g. an AI suggestion); user can change it. */
  initialResolution?: string;
  onClose: () => void;
  onSubmit: (body: { fields?: Record<string, unknown>; comment?: string }) => void;
  submitting?: boolean;
  error?: string | null;
}) {
  const [resolution, setResolution] = useState('');
  const [comment, setComment] = useState('');
  const [assigneeId, setAssigneeId] = useState('');

  // Reset collected fields whenever a (different) transition opens the screen
  // — previously a stale comment/assignee could leak across transitions.
  const transitionId = transition?.id ?? null;
  useEffect(() => {
    if (!transitionId) return;
    setResolution(initialResolution ?? '');
    setComment('');
    setAssigneeId('');
  }, [transitionId, initialResolution]);
  const { data: resolutions } = useQuery({ queryKey: ['resolutions'], queryFn: fetchResolutions });

  const fields = transition?.fields ?? {};
  const needsResolution = 'resolution' in fields;
  const needsComment = 'comment' in fields;
  const needsAssignee = 'assignee' in fields;

  const { data: assignable } = useQuery({
    queryKey: ['assignable', projectKey, ''],
    queryFn: () => searchAssignableUsers(projectKey!, ''),
    enabled: needsAssignee && Boolean(projectKey),
  });

  function submit() {
    const body: { fields?: Record<string, unknown>; comment?: string } = {};
    if (needsResolution) {
      if (!resolution) return;
      body.fields = { resolution: { name: resolution } };
    }
    if (needsAssignee && assigneeId) {
      body.fields = { ...body.fields, assignee: { accountId: assigneeId } };
    }
    if (needsComment && comment.trim()) body.comment = comment.trim();
    onSubmit(body);
  }

  return (
    <Modal open={transition !== null} onClose={onClose}>
      {transition && (
        <div>
          <header className="px-5 py-4 border-b border-atl-n-30">
            <h2 className="text-base font-semibold text-atl-n-800">
              {transition.name} — {issueKey}
            </h2>
            <p className="text-xs text-atl-n-200 mt-0.5">
              Moving to <span className="font-medium">{transition.to.name}</span>
            </p>
          </header>
          <div className="px-5 py-4 space-y-4">
            {needsResolution && (
              <div>
                <label className="block text-xs font-semibold text-atl-n-200 mb-1">
                  Resolution <span className="text-atl-r-500">*</span>
                </label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  autoFocus
                  className="w-full rounded-[3px] border border-atl-n-40 bg-atl-n-10 px-2 py-1.5 text-sm focus:border-atl-b-300 focus:outline-none"
                >
                  <option value="">Select a resolution…</option>
                  {(resolutions ?? []).map((r) => (
                    <option key={r.id} value={r.name}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {needsAssignee && (
              <div>
                <label className="block text-xs font-semibold text-atl-n-200 mb-1">Assignee</label>
                <select
                  value={assigneeId}
                  onChange={(e) => setAssigneeId(e.target.value)}
                  className="w-full rounded-[3px] border border-atl-n-40 bg-atl-n-10 px-2 py-1.5 text-sm focus:border-atl-b-300 focus:outline-none"
                >
                  <option value="">Automatic</option>
                  {(assignable ?? []).map((u) => (
                    <option key={u.accountId} value={u.accountId}>
                      {u.displayName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {needsComment && (
              <div>
                <label className="block text-xs font-semibold text-atl-n-200 mb-1">Comment</label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  placeholder="Add a comment (optional)"
                  className="w-full rounded-[3px] border border-atl-n-40 bg-atl-n-10 px-2 py-1.5 text-sm focus:border-atl-b-300 focus:outline-none"
                />
              </div>
            )}
            {error && <p className="text-xs text-atl-r-500">{error}</p>}
          </div>
          <footer className="px-5 py-3 border-t border-atl-n-30 flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-atl-n-400 hover:bg-atl-n-20"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={submitting || (needsResolution && !resolution)}
              className="rounded-[3px] px-3 py-1.5 text-sm font-medium bg-atl-b-400 text-white hover:bg-atl-b-300 disabled:opacity-50"
            >
              {transition.name}
            </button>
          </footer>
        </div>
      )}
    </Modal>
  );
}

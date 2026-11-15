import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { logWork } from '../api/client.js';
import Modal from './Modal.js';
import { useIssueWrite } from '../lib/useIssueWrite.js';

/** Sprint 024 — Jira "Log work" dialog: duration + optional comment + estimate adjustment. */
export default function LogWorkDialog({
  issueKey,
  remainingEstimate,
  open,
  onClose,
}: {
  issueKey: string;
  remainingEstimate?: string;
  open: boolean;
  onClose: () => void;
}) {
  const [timeSpent, setTimeSpent] = useState('');
  const [comment, setComment] = useState('');
  const [billable, setBillable] = useState(false);
  const [adjust, setAdjust] = useState<'auto' | 'leave' | 'new' | 'manual'>('auto');
  // Separate values per mode — "Set to 2d" must not leak into "Reduce by".
  const [newEstimate, setNewEstimate] = useState('');
  const [reduceBy, setReduceBy] = useState('');
  const markWrite = useIssueWrite(issueKey);

  const reset = () => {
    setTimeSpent('');
    setComment('');
    setBillable(false);
    setAdjust('auto');
    setNewEstimate('');
    setReduceBy('');
  };

  const save = useMutation({
    mutationFn: () =>
      logWork(issueKey, {
        timeSpent,
        comment: comment.trim() || undefined,
        billable: billable || undefined,
        adjustEstimate: adjust,
        newEstimate: adjust === 'new' ? newEstimate : undefined,
        reduceBy: adjust === 'manual' ? reduceBy : undefined,
      }),
    onSuccess: () => {
      markWrite([['worklogs', issueKey]]);
      reset();
      onClose();
    },
  });

  const cancel = () => {
    reset();
    onClose();
  };

  return (
    <Modal open={open} onClose={cancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (timeSpent.trim() && !save.isPending) save.mutate();
        }}
      >
        <div className="px-5 py-4 border-b border-atl-n-30">
          <h2 className="text-lg font-medium text-atl-n-800">Log work — {issueKey}</h2>
        </div>
        <div className="px-5 py-4 space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-atl-n-300">Time spent *</span>
            <input
              autoFocus
              value={timeSpent}
              onChange={(e) => setTimeSpent(e.target.value)}
              placeholder="e.g. 1w 2d 4h 30m"
              className="w-full rounded border border-atl-n-40 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-atl-n-300">Work description</span>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={3}
              placeholder="What did you do?"
              className="w-full rounded border border-atl-n-40 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-atl-n-700">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
            Billable
          </label>
          <fieldset>
            <span className="mb-1 block text-xs font-semibold text-atl-n-300">Remaining estimate</span>
            <div className="space-y-1.5 text-sm text-atl-n-700">
              <label className="flex items-center gap-2">
                <input type="radio" name="adjust" checked={adjust === 'auto'} onChange={() => setAdjust('auto')} />
                Adjust automatically{remainingEstimate ? ` (was ${remainingEstimate})` : ''}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="adjust" checked={adjust === 'leave'} onChange={() => setAdjust('leave')} />
                Leave estimate unset / unchanged{remainingEstimate ? ` (${remainingEstimate})` : ''}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="adjust" checked={adjust === 'new'} onChange={() => setAdjust('new')} />
                Set to
                <input
                  value={adjust === 'new' ? newEstimate : ''}
                  onChange={(e) => {
                    setAdjust('new');
                    setNewEstimate(e.target.value);
                  }}
                  placeholder="e.g. 2d"
                  className="w-24 rounded border border-atl-n-40 px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
                />
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="adjust" checked={adjust === 'manual'} onChange={() => setAdjust('manual')} />
                Reduce by
                <input
                  value={adjust === 'manual' ? reduceBy : ''}
                  onChange={(e) => {
                    setAdjust('manual');
                    setReduceBy(e.target.value);
                  }}
                  placeholder="e.g. 1h"
                  className="w-24 rounded border border-atl-n-40 px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200"
                />
              </label>
            </div>
          </fieldset>
          {save.isError && <p className="text-xs text-atl-r-400">{(save.error as Error).message}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-atl-n-30">
          <button
            type="button"
            onClick={cancel}
            className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!timeSpent.trim() || save.isPending}
            className="rounded bg-atl-b-300 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-400 disabled:opacity-50"
          >
            Log
          </button>
        </div>
      </form>
    </Modal>
  );
}

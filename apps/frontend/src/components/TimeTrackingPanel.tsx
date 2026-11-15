import { useState } from 'react';
import type { Issue } from '../api/client.js';
import LogWorkDialog from './LogWorkDialog.js';
import { useIssuePermissions } from '../hooks/usePermissions.js';

/** Sprint 024 — time tracking widget: progress bar + Log work button (Jira detail sidebar). */
export default function TimeTrackingPanel({ issue }: { issue: Issue }) {
  const [logOpen, setLogOpen] = useState(false);
  const { can } = useIssuePermissions(issue.key);
  const tt = issue.fields.timetracking;

  const origSec = tt?.originalEstimateSeconds;
  const spentSec = tt?.timeSpentSeconds ?? 0;
  const pct = origSec && origSec > 0 ? Math.min(100, Math.round((spentSec / origSec) * 100)) : null;

  return (
    <div className="mb-4 border border-atl-n-30 rounded">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-atl-n-30">
        <h3 className="text-xs font-semibold text-atl-n-300">Time tracking</h3>
        {can('WORK_ON_ISSUES') && (
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            className="rounded bg-atl-n-20 px-2 py-0.5 text-xs font-medium text-atl-n-700 hover:bg-atl-n-30"
          >
            Log work
          </button>
        )}
      </div>
      <div className="px-4 py-3 text-sm">
        {tt ? (
          <>
            <div className="h-1.5 rounded-full bg-atl-n-20 overflow-hidden">
              <div
                className={`h-full ${pct !== null && pct > 100 ? 'bg-atl-r-300' : 'bg-atl-b-300'}`}
                style={{ width: `${pct ?? (spentSec > 0 ? 100 : 0)}%` }}
              />
            </div>
            <dl className="mt-2 space-y-1 text-xs">
              <div className="flex justify-between">
                <dt className="text-atl-n-300">Estimated</dt>
                <dd className="text-atl-n-700">{tt.originalEstimate ?? 'None'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-atl-n-300">Logged</dt>
                <dd className="text-atl-n-700">{tt.timeSpent ?? 'None'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-atl-n-300">Remaining</dt>
                <dd className="text-atl-n-700">{tt.remainingEstimate ?? 'None'}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="text-xs text-atl-n-100 italic">No time tracked — log work or set an estimate.</p>
        )}
      </div>
      <LogWorkDialog
        issueKey={issue.key}
        remainingEstimate={tt?.remainingEstimate}
        open={logOpen}
        onClose={() => setLogOpen(false)}
      />
    </div>
  );
}

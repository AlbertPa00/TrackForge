// Sprint 023: bulk change wizard — choose op → payload → dry-run plan →
// execute → live progress/results. Mirrors Jira's 3-step bulk change.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from './Modal.js';
import { CheckIcon, CrossIcon } from './icons.js';
import {
  runBulkOp, fetchBulkJob, retryBulkJob,
  type BulkOpName, type BulkPlanItem,
} from '../api/client.js';

const OPS: { id: BulkOpName; label: string }[] = [
  { id: 'edit', label: 'Edit issues' },
  { id: 'transition', label: 'Transition issues' },
  { id: 'move', label: 'Move to project' },
  { id: 'delete', label: 'Delete issues' },
  { id: 'comment', label: 'Add comment' },
  { id: 'watch', label: 'Watch / unwatch' },
  { id: 'link', label: 'Link issues' },
];

const INPUT = 'w-full h-8 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm focus:border-atl-b-300 outline-none';

function PayloadForm({ op, p, set }: { op: BulkOpName; p: Record<string, string | boolean>; set: (k: string, v: string | boolean) => void }) {
  switch (op) {
    case 'edit':
      return (
        <div className="space-y-2">
          <label className="block text-xs text-atl-n-200">Labels (comma-separated — replaces existing)</label>
          <input className={INPUT} value={String(p.labels ?? '')} onChange={(e) => set('labels', e.target.value)} placeholder="triage, release-42" />
          <label className="block text-xs text-atl-n-200">Assignee (accountId or email; "unassigned" clears)</label>
          <input className={INPUT} value={String(p.assignee ?? '')} onChange={(e) => set('assignee', e.target.value)} placeholder="leave empty to keep" />
          <label className="block text-xs text-atl-n-200">Delegate — agent account name/id ("clear" removes)</label>
          <input className={INPUT} value={String(p.delegate ?? '')} onChange={(e) => set('delegate', e.target.value)} placeholder="leave empty to keep" />
          <label className="block text-xs text-atl-n-200">Environment</label>
          <input className={INPUT} value={String(p.environment ?? '')} onChange={(e) => set('environment', e.target.value)} placeholder="leave empty to keep" />
        </div>
      );
    case 'transition':
      return (
        <div className="space-y-2">
          <label className="block text-xs text-atl-n-200">Target status name (resolved per issue's workflow)</label>
          <input className={INPUT} value={String(p.statusName ?? '')} onChange={(e) => set('statusName', e.target.value)} placeholder="In Progress" />
        </div>
      );
    case 'move':
      return (
        <div className="space-y-2">
          <label className="block text-xs text-atl-n-200">Target project key</label>
          <input className={INPUT} value={String(p.projectKey ?? '')} onChange={(e) => set('projectKey', e.target.value)} placeholder="OPS" />
          <label className="block text-xs text-atl-n-200">Target status name (optional)</label>
          <input className={INPUT} value={String(p.statusName ?? '')} onChange={(e) => set('statusName', e.target.value)} />
        </div>
      );
    case 'delete':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={Boolean(p.deleteSubtasks)} onChange={(e) => set('deleteSubtasks', e.target.checked)} />
          Also delete subtasks
        </label>
      );
    case 'comment':
      return (
        <div className="space-y-2">
          <label className="block text-xs text-atl-n-200">Comment body (markdown)</label>
          <textarea className={`${INPUT} h-24 py-1.5`} value={String(p.body ?? '')} onChange={(e) => set('body', e.target.value)} />
        </div>
      );
    case 'watch':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={Boolean(p.unwatch)} onChange={(e) => set('unwatch', e.target.checked)} />
          Remove my watch instead of adding it
        </label>
      );
    case 'link':
      return (
        <div className="space-y-2">
          <label className="block text-xs text-atl-n-200">Link type (e.g. Blocks, Relates, Cloners)</label>
          <input className={INPUT} value={String(p.type ?? '')} onChange={(e) => set('type', e.target.value)} />
          <label className="block text-xs text-atl-n-200">Target issue key (all selected issues link outward → it)</label>
          <input className={INPUT} value={String(p.inwardKey ?? '')} onChange={(e) => set('inwardKey', e.target.value)} placeholder="OPS-9" />
        </div>
      );
  }
}

function buildPayload(op: BulkOpName, p: Record<string, string | boolean>): Record<string, unknown> {
  switch (op) {
    case 'edit': {
      const fields: Record<string, unknown> = {};
      if (p.labels) fields.labels = String(p.labels).split(',').map((s) => s.trim()).filter(Boolean);
      if (p.assignee === 'unassigned') fields.assignee = null;
      else if (p.assignee) fields.assignee = { accountId: String(p.assignee) };
      // 047 — delegate accepts name or accountId; the assignable-agent check
      // runs per issue server-side and shows up per-row in the dry-run plan.
      if (p.delegate === 'clear') fields.delegate = null;
      else if (p.delegate) fields.delegate = /^[0-9a-f-]{36}$/i.test(String(p.delegate)) ? { accountId: String(p.delegate) } : { name: String(p.delegate) };
      if (p.environment) fields.environment = String(p.environment);
      return { fields };
    }
    case 'transition': return { statusName: p.statusName };
    case 'move': return { target: { projectKey: String(p.projectKey ?? '').toUpperCase(), statusName: p.statusName || undefined } };
    case 'delete': return { deleteSubtasks: Boolean(p.deleteSubtasks) };
    case 'comment': return { body: p.body };
    case 'watch': return { unwatch: Boolean(p.unwatch) };
    case 'link': return { type: p.type, inwardKey: p.inwardKey };
    default: return {};
  }
}

function PlanTable({ plan }: { plan: BulkPlanItem[] }) {
  return (
    <div className="max-h-64 overflow-y-auto border border-atl-n-30 rounded">
      <table className="w-full text-sm">
        <tbody>
          {plan.map((r) => (
            <tr key={r.key} className="border-b border-atl-n-30 last:border-0">
              <td className="px-3 py-1.5 font-mono text-xs w-24">{r.key}</td>
              <td className={`px-3 py-1.5 w-6 ${r.ok ? 'text-atl-g-500' : 'text-atl-r-400'}`}>{r.ok ? <CheckIcon size={12} /> : <CrossIcon size={12} />}</td>
              <td className="px-3 py-1.5 text-xs text-atl-n-300">{(r.changes ?? []).join('; ')}{r.error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BulkWizard({
  open, onClose, issueKeys, jql,
}: {
  open: boolean;
  onClose: () => void;
  issueKeys: string[];
  jql?: string;
}) {
  const qc = useQueryClient();
  const [op, setOp] = useState<BulkOpName>('edit');
  const [p, setP] = useState<Record<string, string | boolean>>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const selection = jql ? { jql } : { issueKeys };

  const plan = useMutation({
    mutationFn: () => runBulkOp(op, { ...selection, payload: buildPayload(op, p), dryRun: true }),
  });
  const exec = useMutation({
    mutationFn: () => runBulkOp(op, { ...selection, payload: buildPayload(op, p), dryRun: false }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  const retry = useMutation({
    mutationFn: () => retryBulkJob(jobId!),
    onSuccess: (r) => setJobId(r.jobId),
  });

  const job = useQuery({
    queryKey: ['bulkjob', jobId],
    queryFn: () => fetchBulkJob(jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (q) => (q.state.data?.status === 'done' || q.state.data?.status === 'failed' ? false : 800),
  });
  const done = job.data?.status === 'done' || job.data?.status === 'failed';

  useEffect(() => {
    if (done) qc.invalidateQueries();
  }, [done, qc]);

  const set = (k: string, v: string | boolean) => setP((prev) => ({ ...prev, [k]: v }));
  const count = job.data?.total ?? plan.data?.total ?? issueKeys.length;
  const okCount = plan.data?.plan.filter((r) => r.ok).length ?? 0;
  const failCount = plan.data?.plan.filter((r) => !r.ok).length ?? 0;

  const close = () => { setJobId(null); plan.reset(); exec.reset(); onClose(); };

  return (
    <Modal open={open} onClose={close}>
      <div className="px-5 py-4 border-b border-atl-n-30">
        <h2 className="text-base font-semibold text-atl-n-800">Bulk change — {count} issue{count === 1 ? '' : 's'}</h2>
      </div>
      <div className="px-5 py-4 space-y-4">
        {!jobId && !plan.data && (
          <>
            <div>
              <label className="block text-xs text-atl-n-200 mb-1">Operation</label>
              <select className={INPUT} value={op} onChange={(e) => { setOp(e.target.value as BulkOpName); plan.reset(); }}>
                {OPS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
            <PayloadForm op={op} p={p} set={set} />
            {plan.isError && <p className="text-xs text-atl-r-400">{(plan.error as Error).message}</p>}
            <button
              onClick={() => plan.mutate()}
              disabled={plan.isPending}
              className="h-8 px-3 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white disabled:opacity-50"
            >
              {plan.isPending ? 'Planning…' : 'Preview changes'}
            </button>
          </>
        )}

        {!jobId && plan.data && (
          <>
            <p className="text-xs text-atl-n-300">
              <span className="text-atl-g-600 font-medium">{okCount} will change</span>
              {failCount > 0 && <span className="text-atl-r-400 font-medium"> · {failCount} cannot</span>}
            </p>
            <PlanTable plan={plan.data.plan} />
            <div className="flex gap-2">
              <button onClick={() => plan.reset()} className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20">
                Back
              </button>
              <button
                onClick={() => exec.mutate()}
                disabled={exec.isPending || okCount === 0}
                className="h-8 px-3 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white disabled:opacity-50"
              >
                {exec.isPending ? 'Starting…' : `Run on ${okCount} issue${okCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}

        {jobId && job.data && (
          <>
            <div className="flex items-center gap-3">
              <div className="flex-1 h-2 rounded bg-atl-n-30 overflow-hidden">
                <div
                  className={`h-full ${job.data.status === 'failed' ? 'bg-atl-r-400' : 'bg-atl-b-300'}`}
                  style={{ width: `${job.data.total ? (job.data.done / job.data.total) * 100 : 0}%` }}
                />
              </div>
              <span className="text-xs text-atl-n-300">{job.data.done}/{job.data.total}</span>
            </div>
            {done && (
              <p className="text-xs text-atl-n-300">
                <span className="text-atl-g-600 font-medium">{job.data.succeeded} succeeded</span>
                {job.data.failed > 0 && <span className="text-atl-r-400 font-medium"> · {job.data.failed} failed</span>}
              </p>
            )}
            <PlanTable plan={job.data.results} />
            {done && job.data.failed > 0 && (
              <button
                onClick={() => retry.mutate()}
                disabled={retry.isPending}
                className="h-8 px-3 rounded-[3px] border border-atl-n-40 text-sm hover:bg-atl-n-20"
              >
                Retry {job.data.failed} failed
              </button>
            )}
          </>
        )}
      </div>
      <div className="px-5 py-3 border-t border-atl-n-30 flex justify-end">
        <button onClick={close} className="h-8 px-3 rounded-[3px] text-sm text-atl-n-600 hover:bg-atl-n-20">
          {done ? 'Done' : 'Cancel'}
        </button>
      </div>
    </Modal>
  );
}

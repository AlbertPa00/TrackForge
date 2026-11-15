import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createWorkflow,
  deleteWorkflow,
  fetchStatuses,
  fetchWorkflows,
  type Workflow,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import StatusLozenge from '../components/StatusLozenge.js';

/** Admin workflow directory (US3) — pick a workflow to open the table editor. */
export default function WorkflowsPage() {
  const { data: workflows, isLoading } = useQuery({
    queryKey: ['workflows'],
    queryFn: fetchWorkflows,
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Workflow | null>(null);
  // 061 US5 — migrated instances carry hundreds of workflows; filter + page.
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const visible = (workflows ?? []).filter((w) => w.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageRows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // 060 US1 — workflow delete, refused by the API while bound.
  const del = useMutation({
    mutationFn: (id: string) => deleteWorkflow(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      setConfirmDel(null);
    },
  });

  // UB-017 — Jira row "Copy": duplicate statuses + transitions under a new name.
  const copy = useMutation({
    mutationFn: (w: Workflow) =>
      createWorkflow({
        name: `Copy of ${w.name}`,
        statuses: w.statuses.map((s) => ({ statusId: s.id, isInitial: s.isInitial })),
        transitions: w.transitions.map((t) => ({
          name: t.name,
          fromStatusId: t.from?.id ?? null,
          toStatusId: t.to.id,
        })),
      }),
    onSuccess: (w) => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      navigate(`/settings/workflows/${w.id}`);
    },
  });

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-atl-n-800">Workflows</h1>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500"
        >
          Add workflow
        </button>
      </div>
      <p className="text-sm text-atl-n-200 mb-6">
        Workflows define the statuses an issue moves through and the transitions between them.
      </p>
      {copy.isError && (
        <p className="mb-3 text-sm text-atl-r-400">{(copy.error as Error).message}</p>
      )}
      <input
        className="mb-3 w-72 border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm"
        placeholder="Filter by name"
        value={filter}
        onChange={(e) => { setFilter(e.target.value); setPage(0); }}
      />
      {isLoading ? (
        <p className="text-sm text-atl-n-200">Loading…</p>
      ) : (
        <>
        <table className="w-full text-sm border border-atl-n-30 rounded-[3px] overflow-hidden">
          <thead>
            <tr className="bg-atl-n-10 text-left text-xs uppercase text-atl-n-200">
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Statuses</th>
              <th className="px-3 py-2">Transitions</th>
              <th className="px-3 py-2 w-20" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((w) => (
              <tr key={w.id} className="border-t border-atl-n-30 hover:bg-atl-n-10">
                <td className="px-3 py-2 font-medium text-atl-n-800">{w.name}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex gap-1 flex-wrap">
                    {w.statuses.map((s) => (
                      <StatusLozenge key={s.id} name={s.name} categoryKey={s.statusCategory.key} />
                    ))}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-atl-n-200">{w.transitions.length} transitions</td>
                <td className="px-3 py-2 text-right space-x-3 whitespace-nowrap">
                  <Link
                    to={`/settings/workflows/${w.id}`}
                    className="text-xs font-medium text-atl-b-400 hover:underline"
                  >
                    Edit
                  </Link>
                  <button
                    type="button"
                    disabled={copy.isPending}
                    onClick={() => copy.mutate(w)}
                    className="text-xs font-medium text-atl-b-400 hover:underline disabled:opacity-50"
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDel(w)}
                    className="text-xs font-medium text-atl-r-400 hover:underline"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-2 flex items-center justify-between text-xs text-atl-n-200">
          <span>
            {visible.length === 0 ? 'No workflows match' : `${page * PAGE_SIZE + 1}–${Math.min(visible.length, (page + 1) * PAGE_SIZE)} of ${visible.length}`}
          </span>
          {pageCount > 1 && (
            <span className="space-x-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
                className="px-2 py-1 border border-atl-n-30 rounded disabled:opacity-40"
              >
                Previous
              </button>
              <span>Page {page + 1} of {pageCount}</span>
              <button
                type="button"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
                className="px-2 py-1 border border-atl-n-30 rounded disabled:opacity-40"
              >
                Next
              </button>
            </span>
          )}
        </div>
        </>
      )}

      <AddWorkflowDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body="Deletion is refused while the workflow is bound to a project or a workflow scheme."
        confirmLabel="Delete workflow"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </div>
  );
}

/** UB-017 — Jira "Add workflow": name + initial status → opens the table editor. */
function AddWorkflowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [statusId, setStatusId] = useState('');
  const { data: statuses } = useQuery({ queryKey: ['statuses'], queryFn: fetchStatuses });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () =>
      createWorkflow({
        name: name.trim(),
        statuses: [{ statusId, isInitial: true }],
        transitions: [],
      }),
    onSuccess: (w) => {
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
      onClose();
      navigate(`/settings/workflows/${w.id}`);
    },
  });
  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-6 pt-5 pb-4 border-b border-atl-n-30">
        <h2 className="text-xl font-semibold text-atl-n-800">Add workflow</h2>
      </div>
      <div className="px-6 py-4 space-y-3">
        <label className="block text-sm">
          <span className="text-atl-n-400">Name</span>
          <input
            autoFocus
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Software development workflow"
          />
        </label>
        <label className="block text-sm">
          <span className="text-atl-n-400">Initial status</span>
          <select
            className="mt-1 w-full rounded border border-atl-n-30 px-2 py-1.5 text-sm bg-atl-paper"
            value={statusId}
            onChange={(e) => setStatusId(e.target.value)}
          >
            <option value="">Select a status…</option>
            {(statuses ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        {create.isError && (
          <p className="text-xs text-atl-r-400">{(create.error as Error).message}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-atl-n-300 hover:bg-atl-n-20">
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim() || !statusId || create.isPending}
            onClick={() => create.mutate()}
            className="rounded bg-atl-b-400 px-3 py-1.5 text-sm font-medium text-white hover:bg-atl-b-500 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

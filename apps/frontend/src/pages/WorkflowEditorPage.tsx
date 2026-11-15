import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  fetchStatuses,
  fetchWorkflow,
  updateWorkflow,
  type WorkflowRule,
} from '../api/client.js';
import StatusLozenge from '../components/StatusLozenge.js';
import WorkflowDiagram from '../components/WorkflowDiagram.js';
import { CloseIcon } from '../components/icons.js';

interface DraftTransition {
  name: string;
  fromStatusId: string | null;
  toStatusId: string;
  screenFields: string[];
  rules: { kind: WorkflowRule['kind']; type: string }[];
}

const RULE_TYPES: Record<WorkflowRule['kind'], { value: string; label: string }[]> = {
  condition: [
    { value: 'onlyAssignee', label: 'Only assignee' },
    { value: 'onlyReporter', label: 'Only reporter' },
    { value: 'onlyAdmin', label: 'Only admins' },
    { value: 'onlyProjectLead', label: 'Only project lead' },
  ],
  validator: [
    { value: 'resolutionRequired', label: 'Resolution required' },
    { value: 'fieldRequired', label: 'Field required' },
  ],
  postFunction: [
    { value: 'setResolution', label: 'Set resolution' },
    { value: 'clearResolution', label: 'Clear resolution' },
    { value: 'assignToCurrentUser', label: 'Assign to current user' },
  ],
};

const SCREEN_FIELDS = ['resolution', 'comment', 'assignee'];

/** Table-based workflow editor (US3) — statuses table + transitions table + rules. */
export default function WorkflowEditorPage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const queryClient = useQueryClient();
  const { data: workflow } = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => fetchWorkflow(workflowId!),
    enabled: Boolean(workflowId),
  });
  const { data: allStatuses } = useQuery({ queryKey: ['statuses'], queryFn: fetchStatuses });

  const [statusIds, setStatusIds] = useState<string[] | null>(null);
  const [initialId, setInitialId] = useState<string | null>(null);
  const [transitions, setTransitions] = useState<DraftTransition[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'text' | 'diagram'>('text');

  // 061 US7 — reset drafts when the route param changes without a remount,
  // otherwise the previous workflow's statuses/transitions stay loaded.
  useEffect(() => {
    setStatusIds(null);
    setTransitions(null);
    setInitialId(null);
    setDirty(false);
  }, [workflowId]);

  useEffect(() => {
    if (workflow && statusIds === null) {
      setStatusIds(workflow.statuses.map((s) => s.id));
      setInitialId(workflow.statuses.find((s) => s.isInitial)?.id ?? workflow.statuses[0]?.id ?? null);
      setTransitions(
        workflow.transitions.map((t) => ({
          name: t.name,
          fromStatusId: t.from?.id ?? null,
          toStatusId: t.to.id,
          screenFields: t.screenFields,
          rules: t.rules.map((r) => ({ kind: r.kind, type: r.type })),
        }))
      );
    }
  }, [workflow, statusIds]);

  const save = useMutation({
    mutationFn: () =>
      updateWorkflow(workflowId!, {
        statuses: (statusIds ?? []).map((statusId, position) => ({
          statusId,
          isInitial: statusId === initialId,
          position,
        })),
        transitions: (transitions ?? []).map((t) => ({
          name: t.name,
          fromStatusId: t.fromStatusId,
          toStatusId: t.toStatusId,
          screenFields: t.screenFields,
          rules: t.rules,
        })),
      }),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['workflow', workflowId] });
      queryClient.invalidateQueries({ queryKey: ['workflows'] });
    },
  });

  if (!workflow || !statusIds || !transitions) {
    return <p className="p-6 text-sm text-atl-n-200">Loading workflow…</p>;
  }

  const inWorkflow = (id: string) => statusIds.includes(id);
  const nameOf = (id: string | null) =>
    id === null ? 'All statuses' : allStatuses?.find((s) => s.id === id)?.name ?? id;

  function mut(fn: () => void) {
    fn();
    setDirty(true);
  }

  const addStatusSelect = (
    <select
      value=""
      onChange={(e) => e.target.value && mut(() => setStatusIds([...statusIds, e.target.value]))}
      className="rounded-[3px] border border-atl-n-40 px-2 py-1 text-xs bg-atl-paper"
      aria-label="Add status"
    >
      <option value="">+ Add status…</option>
      {(allStatuses ?? [])
        .filter((s) => !inWorkflow(s.id))
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
    </select>
  );

  const addTransitionButton = (
    <button
      type="button"
      onClick={() =>
        mut(() =>
          setTransitions([
            ...transitions,
            {
              name: 'New transition',
              fromStatusId: statusIds[0] ?? null,
              toStatusId: statusIds[1] ?? statusIds[0] ?? '',
              screenFields: [],
              rules: [],
            },
          ])
        )
      }
      className="text-xs font-medium text-atl-b-400 hover:underline"
    >
      + Add transition
    </button>
  );

  return (
    <div className="p-6 max-w-5xl">
      <div className="text-xs text-atl-n-200 mb-1">
        <Link to="/settings/workflows" className="hover:underline">
          Workflows
        </Link>{' '}
        / {workflow.name}
      </div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-semibold text-atl-n-800">
          {workflow.name}{' '}
          <span className="text-xs font-normal text-atl-n-100">v{workflow.version}</span>
        </h1>
        <div className="flex rounded-[3px] border border-atl-n-40 overflow-hidden" role="group" aria-label="Editor mode">
          {(['text', 'diagram'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={`px-3 py-1 text-xs font-medium capitalize ${
                mode === m ? 'bg-atl-inverse text-white' : 'bg-atl-paper text-atl-n-500 hover:bg-atl-n-10'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-atl-n-200 mb-6">
        {mode === 'text'
          ? 'Table editor — statuses, transitions and rules. Saving bumps the workflow version; projects pick it up immediately.'
          : 'Diagram — statuses grouped by category, transitions as arrows. Add statuses/transitions here; names, screens and rules are edited in Table view.'}
      </p>

      {mode === 'diagram' && (
        <WorkflowDiagram
          statuses={statusIds.map((sid) => {
            const s = allStatuses?.find((x) => x.id === sid);
            return {
              id: sid,
              name: s?.name ?? sid,
              categoryKey: s?.statusCategory.key ?? 'new',
              isInitial: sid === initialId,
            };
          })}
          transitions={transitions.map((t) => ({
            name: t.name,
            fromStatusId: t.fromStatusId,
            toStatusId: t.toStatusId,
          }))}
        />
      )}
      {mode === 'diagram' && (
        <div className="mt-4 flex items-center gap-4">
          {addStatusSelect}
          {addTransitionButton}
          <span className="text-xs text-atl-n-200">
            Names, screens and rules are edited in Table view.
          </span>
        </div>
      )}

      {mode === 'text' && (
      <>

      {save.isError && (
        <div className="mb-4 rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
          {save.error instanceof ApiError ? save.error.message : 'Save failed'}
        </div>
      )}

      {/* Statuses table */}
      <h2 className="text-sm font-semibold text-atl-n-800 mb-2">Statuses</h2>
      <table className="w-full mb-6 text-sm border border-atl-n-30 rounded-[3px] overflow-hidden">
        <thead>
          <tr className="bg-atl-n-10 text-left text-xs uppercase text-atl-n-200">
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2 w-24">Initial</th>
            <th className="px-3 py-2 w-20" />
          </tr>
        </thead>
        <tbody>
          {statusIds.map((sid) => {
            const s = allStatuses?.find((x) => x.id === sid);
            return (
              <tr key={sid} className="border-t border-atl-n-30">
                <td className="px-3 py-2">
                  <StatusLozenge name={s?.name ?? sid} categoryKey={s?.statusCategory.key ?? 'new'} />
                </td>
                <td className="px-3 py-2 text-xs text-atl-n-200">{s?.statusCategory.name}</td>
                <td className="px-3 py-2">
                  <input
                    type="radio"
                    name="initial"
                    checked={initialId === sid}
                    onChange={() => mut(() => setInitialId(sid))}
                  />
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={() =>
                      mut(() => {
                        setStatusIds(statusIds.filter((x) => x !== sid));
                        setTransitions(
                          transitions.filter((t) => t.fromStatusId !== sid && t.toStatusId !== sid)
                        );
                      })
                    }
                    disabled={statusIds.length <= 1}
                    className="text-xs text-atl-r-500 hover:underline disabled:opacity-40"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-atl-n-30 bg-atl-n-10">
            <td colSpan={4} className="px-3 py-2">
              {addStatusSelect}
            </td>
          </tr>
        </tbody>
      </table>

      {/* Transitions table */}
      <h2 className="text-sm font-semibold text-atl-n-800 mb-2">Transitions</h2>
      <table className="w-full mb-4 text-sm border border-atl-n-30 rounded-[3px] overflow-hidden">
        <thead>
          <tr className="bg-atl-n-10 text-left text-xs uppercase text-atl-n-200">
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">From</th>
            <th className="px-3 py-2">To</th>
            <th className="px-3 py-2">Screen</th>
            <th className="px-3 py-2">Rules</th>
            <th className="px-3 py-2 w-16" />
          </tr>
        </thead>
        <tbody>
          {transitions.map((t, i) => (
            <tr key={i} className="border-t border-atl-n-30 align-top">
              <td className="px-3 py-2">
                <input
                  value={t.name}
                  onChange={(e) =>
                    mut(() =>
                      setTransitions(
                        transitions.map((x, j) => (j === i ? { ...x, name: e.target.value } : x))
                      )
                    )
                  }
                  className="w-36 rounded-[3px] border border-atl-n-40 px-2 py-1 text-sm focus:border-atl-b-300 focus:outline-none"
                />
              </td>
              <td className="px-3 py-2">
                <select
                  value={t.fromStatusId ?? ''}
                  onChange={(e) =>
                    mut(() =>
                      setTransitions(
                        transitions.map((x, j) =>
                          j === i ? { ...x, fromStatusId: e.target.value || null } : x
                        )
                      )
                    )
                  }
                  className="rounded-[3px] border border-atl-n-40 px-1.5 py-1 text-xs bg-atl-paper"
                >
                  <option value="">All (global)</option>
                  {statusIds.map((sid) => (
                    <option key={sid} value={sid}>
                      {nameOf(sid)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <select
                  value={t.toStatusId}
                  onChange={(e) =>
                    mut(() =>
                      setTransitions(
                        transitions.map((x, j) => (j === i ? { ...x, toStatusId: e.target.value } : x))
                      )
                    )
                  }
                  className="rounded-[3px] border border-atl-n-40 px-1.5 py-1 text-xs bg-atl-paper"
                >
                  {statusIds.map((sid) => (
                    <option key={sid} value={sid}>
                      {nameOf(sid)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-col gap-0.5">
                  {SCREEN_FIELDS.map((f) => (
                    <label key={f} className="text-xs text-atl-n-400 flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={t.screenFields.includes(f)}
                        onChange={(e) =>
                          mut(() =>
                            setTransitions(
                              transitions.map((x, j) =>
                                j === i
                                  ? {
                                      ...x,
                                      screenFields: e.target.checked
                                        ? [...x.screenFields, f]
                                        : x.screenFields.filter((y) => y !== f),
                                    }
                                  : x
                              )
                            )
                          )
                        }
                      />
                      {f}
                    </label>
                  ))}
                </div>
              </td>
              <td className="px-3 py-2">
                <div className="space-y-1">
                  {t.rules.map((r, ri) => (
                    <div key={ri} className="flex items-center gap-1 text-xs">
                      <span className="text-atl-n-100">{r.kind}:</span>
                      <span className="text-atl-n-600">{r.type}</span>
                      <button
                        onClick={() =>
                          mut(() =>
                            setTransitions(
                              transitions.map((x, j) =>
                                j === i ? { ...x, rules: x.rules.filter((_, k) => k !== ri) } : x
                              )
                            )
                          )
                        }
                        className="text-atl-r-500"
                      >
                        <CloseIcon size={12} />
                      </button>
                    </div>
                  ))}
                  <select
                    value=""
                    onChange={(e) => {
                      const [kind, type] = e.target.value.split(':');
                      if (kind && type) {
                        mut(() =>
                          setTransitions(
                            transitions.map((x, j) =>
                              j === i
                                ? { ...x, rules: [...x.rules, { kind: kind as WorkflowRule['kind'], type }] }
                                : x
                            )
                          )
                        );
                      }
                    }}
                    className="rounded-[3px] border border-atl-n-40 px-1.5 py-0.5 text-[11px] bg-atl-paper"
                  >
                    <option value="">+ rule…</option>
                    {(Object.keys(RULE_TYPES) as WorkflowRule['kind'][]).map((kind) => (
                      <optgroup key={kind} label={kind}>
                        {RULE_TYPES[kind].map((r) => (
                          <option key={r.value} value={`${kind}:${r.value}`}>
                            {r.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              </td>
              <td className="px-3 py-2">
                <button
                  onClick={() => mut(() => setTransitions(transitions.filter((_, j) => j !== i)))}
                  className="text-xs text-atl-r-500 hover:underline"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          <tr className="border-t border-atl-n-30 bg-atl-n-10">
            <td colSpan={6} className="px-3 py-2">
              {addTransitionButton}
            </td>
          </tr>
        </tbody>
      </table>
      </>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={!dirty || save.isPending}
          className="rounded-[3px] px-4 py-1.5 text-sm font-medium bg-atl-b-400 text-white hover:bg-atl-b-300 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save workflow'}
        </button>
        {dirty && <span className="text-xs text-atl-n-200">Unsaved changes</span>}
        {save.isSuccess && !dirty && <span className="text-xs text-atl-g-500">Saved</span>}
      </div>
    </div>
  );
}

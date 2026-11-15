import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  createQuickFilter,
  deleteQuickFilter,
  fetchBoardConfiguration,
  fetchCardConfig,
  fetchQuickFilters,
  fetchSprints,
  fetchStatuses,
  setBoardType,
  updateBoardConfiguration,
  updateCardConfig,
  updateQuickFilter,
  type CardConfig,
  type QuickFilter,
  type StatusRef,
} from '../api/client.js';
import StatusLozenge from '../components/StatusLozenge.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { CloseIcon } from '../components/icons.js';
import { SVG } from '../lib/palette.js';

interface DraftColumn {
  name: string;
  statusIds: string[];
  min?: number | null;
  max?: number | null;
}

/** Jira-style board columns editor: map statuses to columns, set WIP limits. */
export default function BoardSettingsPage() {
  const { projectKey } = useParams<{ projectKey: string }>();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  // 033 — ?board=<id> selects which of the project's boards to configure.
  const boardRef = searchParams.get('board') || projectKey!;
  const { data: config } = useQuery({
    queryKey: ['board-config', boardRef],
    queryFn: () => fetchBoardConfiguration(boardRef),
    enabled: Boolean(boardRef),
  });
  const { data: allStatuses } = useQuery({ queryKey: ['statuses'], queryFn: fetchStatuses });
  // 062 US2 — the scrum→kanban switch 400s while open sprints exist; surface
  // the constraint upfront instead of letting users discover it by failing.
  const { data: openSprints } = useQuery({
    queryKey: ['board-open-sprints', config?.id],
    queryFn: () => fetchSprints(config!.id, ['future', 'active']),
    enabled: Boolean(config && config.type === 'scrum'),
  });
  const switchBlocked = (openSprints?.length ?? 0) > 0;

  const [columns, setColumns] = useState<DraftColumn[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [activeSection, setActiveSection] = useState('bs-columns');

  useEffect(() => {
    if (config && columns === null) {
      setColumns(
        config.columnConfig.columns.map((c) => ({
          name: c.name,
          statusIds: c.statuses.map((s) => s.id),
          min: c.min ?? null,
          max: c.max ?? null,
        }))
      );
    }
  }, [config, columns]);

  const save = useMutation({
    mutationFn: (cols: DraftColumn[]) => updateBoardConfiguration(boardRef, cols),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['board-config', boardRef] });
      queryClient.invalidateQueries({ queryKey: ['board-issues', boardRef] });
    },
  });
  const typeSwitch = useMutation({
    mutationFn: (type: 'scrum' | 'kanban') => setBoardType(config!.id, type),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['board-config', boardRef] });
      queryClient.invalidateQueries({ queryKey: ['boards', projectKey] });
    },
  });

  // 062 US2 — refuse impossible configs before the PUT (server enforces too).
  const columnErrors = (columns ?? []).map((c) =>
    !c.name.trim()
      ? 'Column name must not be empty.'
      : c.min != null && c.max != null && c.min > c.max
        ? 'Max must be greater than or equal to Min.'
        : null
  );
  const hasColumnErrors = columnErrors.some(Boolean);

  const mapped = new Set((columns ?? []).flatMap((c) => c.statusIds));
  // Workflow-scoped unmapped statuses come from the backend; fall back to global diff.
  const unmapped =
    config?.columnConfig.unmapped?.filter((s) => !mapped.has(s.id)) ??
    (allStatuses ?? []).filter((s) => !mapped.has(s.id));

  function mutate(fn: (cols: DraftColumn[]) => DraftColumn[]) {
    setColumns((c) => (c ? fn(c) : c));
    setDirty(true);
  }

  function toggleStatus(colIdx: number, statusId: string) {
    mutate((cols) =>
      cols.map((c, i) => ({
        ...c,
        statusIds:
          i === colIdx
            ? c.statusIds.includes(statusId)
              ? c.statusIds.filter((s) => s !== statusId)
              : [...c.statusIds, statusId]
            : c.statusIds.filter((s) => s !== statusId),
      }))
    );
  }

  function statusById(id: string): StatusRef | undefined {
    return allStatuses?.find((s) => s.id === id);
  }

  if (!config || !columns) {
    return <p className="p-6 text-sm text-atl-n-200">Loading board configuration…</p>;
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="text-xs text-atl-n-200 mb-1">
        Projects / <span className="text-atl-n-400">{projectKey}</span> / Board settings
      </div>
      <h1 className="text-xl font-semibold text-atl-n-800 mb-1">{config.name} — Columns</h1>
      <p className="text-sm text-atl-n-200 mb-4">
        Map workflow statuses onto board columns and set work-in-progress limits.
      </p>

      {/* UB-010 — Jira board-settings section nav. */}
      <nav className="mb-4 flex gap-1 border-b border-atl-n-30" aria-label="Settings sections">
        {[
          ['Columns', 'bs-columns'],
          ['Quick filters', 'bs-quickfilters'],
          ['Card layout', 'bs-cardlayout'],
        ].map(([label, id]) => (
          <a
            key={id}
            href={`#${id}`}
            aria-current={activeSection === id ? 'true' : undefined}
            onClick={() => setActiveSection(id)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
              activeSection === id
                ? 'text-atl-b-400 border-atl-b-400'
                : 'text-atl-n-500 hover:text-atl-b-400 border-transparent hover:border-atl-b-300'
            }`}
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="mb-6 rounded-[3px] border border-atl-n-30 bg-atl-paper px-4 py-3 flex items-center gap-4">
        <div>
          <div className="text-sm font-semibold text-atl-n-800">Board type</div>
          <div className="text-xs text-atl-n-200">
            {config.type === 'scrum'
              ? 'Scrum — sprints, backlog, and reports are enabled.'
              : 'Kanban — continuous flow, no sprints. Switch to scrum to plan iterations.'}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          {(['scrum', 'kanban'] as const).map((t) => (
            <button
              key={t}
              onClick={() => typeSwitch.mutate(t)}
              disabled={typeSwitch.isPending || config.type === t || (t === 'kanban' && switchBlocked)}
              title={
                t === 'kanban' && switchBlocked
                  ? `Close or complete ${openSprints!.length} open sprint${openSprints!.length === 1 ? '' : 's'} before switching to kanban.`
                  : undefined
              }
              className={`h-8 px-3 rounded-[3px] text-sm font-medium capitalize ${
                config.type === t
                  ? 'bg-atl-b-400 text-white'
                  : 'bg-atl-n-30 text-atl-n-600 hover:bg-atl-n-40'
              } disabled:opacity-60`}
            >
              {t}
            </button>
          ))}
        </div>
        {typeSwitch.isError && (
          <div className="text-xs text-atl-r-500">
            {typeSwitch.error instanceof ApiError ? typeSwitch.error.message : 'Switch failed'}
          </div>
        )}
      </div>

      {save.isError && (
        <div className="mb-4 rounded-[3px] border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">
          {save.error instanceof ApiError ? save.error.message : 'Save failed'}
        </div>
      )}

      <div id="bs-columns" className="space-y-4">
        {columns.map((col, i) => (
          <div key={i} className="rounded-[3px] border border-atl-n-30 bg-atl-paper">
            <div className="flex items-center gap-3 px-4 py-3 border-b border-atl-n-30 bg-atl-n-10">
              <input
                value={col.name}
                onChange={(e) =>
                  mutate((cols) => cols.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)))
                }
                className="rounded-[3px] border border-atl-n-40 px-2 py-1 text-sm font-semibold text-atl-n-800 w-44 focus:border-atl-b-300 focus:outline-none"
              />
              <label className="text-xs text-atl-n-200 flex items-center gap-1">
                Min
                <input
                  type="number"
                  min={1}
                  value={col.min ?? ''}
                  placeholder="—"
                  onChange={(e) =>
                    mutate((cols) =>
                      cols.map((c, j) =>
                        j === i ? { ...c, min: e.target.value ? Number(e.target.value) : null } : c
                      )
                    )
                  }
                  className="w-14 rounded-[3px] border border-atl-n-40 px-1.5 py-0.5 text-xs focus:border-atl-b-300 focus:outline-none"
                />
              </label>
              <label className="text-xs text-atl-n-200 flex items-center gap-1">
                Max
                <input
                  type="number"
                  min={1}
                  value={col.max ?? ''}
                  placeholder="—"
                  onChange={(e) =>
                    mutate((cols) =>
                      cols.map((c, j) =>
                        j === i ? { ...c, max: e.target.value ? Number(e.target.value) : null } : c
                      )
                    )
                  }
                  className="w-14 rounded-[3px] border border-atl-n-40 px-1.5 py-0.5 text-xs focus:border-atl-b-300 focus:outline-none"
                />
              </label>
              {columnErrors[i] && <span className="text-xs text-atl-r-500">{columnErrors[i]}</span>}
              <button
                onClick={() => mutate((cols) => cols.filter((_, j) => j !== i))}
                disabled={columns.length <= 1}
                className="ml-auto text-xs text-atl-r-500 hover:underline disabled:opacity-40"
              >
                Remove column
              </button>
            </div>
            <div className="px-4 py-3 flex flex-wrap gap-2">
              {col.statusIds.map((sid) => {
                const s = statusById(sid);
                return (
                  <button
                    key={sid}
                    onClick={() => toggleStatus(i, sid)}
                    title="Click to unmap"
                    className="group inline-flex items-center gap-1"
                  >
                    <StatusLozenge name={s?.name ?? sid} categoryKey={s?.statusCategory.key ?? 'new'} />
                    <span className="text-atl-n-100 group-hover:text-atl-r-500"><CloseIcon size={10} /></span>
                  </button>
                );
              })}
              {col.statusIds.length === 0 && (
                <span className="text-xs text-atl-n-100 italic">No statuses — click one below to add</span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-[3px] border border-dashed border-atl-n-40 bg-atl-n-10 px-4 py-3">
        <h3 className="text-xs font-semibold uppercase text-atl-n-200 mb-2">Unmapped statuses</h3>
        <div className="flex flex-wrap gap-2">
          {unmapped.map((s) => (
            <span key={s.id} className="inline-flex items-center gap-1">
              <StatusLozenge name={s.name} categoryKey={s.statusCategory.key} />
              <select
                value=""
                onChange={(e) => {
                  const idx = Number(e.target.value);
                  if (!Number.isNaN(idx)) toggleStatus(idx, s.id);
                }}
                className="text-[10px] border border-atl-n-40 rounded bg-atl-paper"
              >
                <option value="">add to…</option>
                {columns.map((c, i) => (
                  <option key={i} value={i}>
                    {c.name}
                  </option>
                ))}
              </select>
            </span>
          ))}
          {unmapped.length === 0 && <span className="text-xs text-atl-n-100">All statuses are mapped.</span>}
        </div>
        <button
          onClick={() => mutate((cols) => [...cols, { name: 'New column', statusIds: [] }])}
          className="mt-3 text-xs font-medium text-atl-b-400 hover:underline"
        >
          + Add column
        </button>
      </div>

      <div className="mt-6 flex gap-2">
        <button
          onClick={() => save.mutate(columns)}
          disabled={!dirty || save.isPending || hasColumnErrors}
          className="rounded-[3px] px-4 py-1.5 text-sm font-medium bg-atl-b-400 text-white hover:bg-atl-b-300 disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {dirty && <span className="self-center text-xs text-atl-n-200">Unsaved changes</span>}
        {save.isSuccess && !dirty && <span className="self-center text-xs text-atl-g-500">Saved</span>}
      </div>

      <QuickFiltersSection boardRef={boardRef} />
      <CardConfigSection boardRef={boardRef} />
    </div>
  );
}

/** 033 — card layout: swimlanes, colors, days-in-column, indicators, statistics. */
function CardConfigSection({ boardRef }: { boardRef: string }) {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({
    queryKey: ['cardconfig', boardRef],
    queryFn: () => fetchCardConfig(boardRef),
  });
  const save = useMutation({
    mutationFn: (cfg: CardConfig) => updateCardConfig(boardRef, cfg),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cardconfig', boardRef] }),
  });
  const [colorDraft, setColorDraft] = useState({ field: 'priority', value: '', color: SVG.red as string });
  if (!config) return null;
  const patch = (p: Partial<CardConfig>) => save.mutate({ ...config, ...p });
  const colors = config.colors ?? {};
  return (
    <div id="bs-cardlayout" className="mt-8 rounded-[3px] border border-atl-n-30 bg-atl-paper">
      <div className="px-4 py-3 border-b border-atl-n-30 bg-atl-n-10 flex items-center">
        <h3 className="text-sm font-semibold text-atl-n-800">Card layout</h3>
        {/* 062 US5 — Columns uses explicit Save; this section saves on change.
            Saying so beats a silently divergent mental model. */}
        <span className="ml-2 text-xs text-atl-n-200">saves automatically</span>
      </div>
      <div className="px-4 py-4 space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-sm text-atl-n-600 w-40">Swimlanes</span>
          <select
            value={config.swimlaneBy ?? 'none'}
            onChange={(e) => patch({ swimlaneBy: e.target.value as CardConfig['swimlaneBy'] })}
            className="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper"
          >
            <option value="none">None</option>
            <option value="assignee">Assignee</option>
            <option value="priority">Priority</option>
            <option value="epic">Epic</option>
            <option value="subtasks">Stories (subtasks)</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {([
            ['daysInColumn', 'Days in column dots'],
            ['comments', 'Comment count'],
            ['attachments', 'Attachment count'],
            ['links', 'Link count'],
            ['flag', 'Flagged indicator'],
          ] as const).map(([key, label]) => {
            const on =
              key === 'daysInColumn'
                ? Boolean(config.daysInColumn)
                : config.indicators?.[key] === true;
            return (
              <label key={key} className="flex items-center gap-1.5 text-sm text-atl-n-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    key === 'daysInColumn'
                      ? patch({ daysInColumn: e.target.checked })
                      : patch({ indicators: { ...config.indicators, [key]: e.target.checked } })
                  }
                />
                {label}
              </label>
            );
          })}
          <label className="flex items-center gap-1.5 text-sm text-atl-n-600 cursor-pointer">
            <input
              type="checkbox"
              checked={config.statistics?.includes('points') ?? false}
              onChange={(e) =>
                patch({ statistics: e.target.checked ? ['points'] : [] })
              }
            />
            Story-point totals per column
          </label>
        </div>
        <div>
          <div className="text-sm text-atl-n-600 mb-1.5">Card colors <span className="text-xs text-atl-n-200">(first match wins — field:value)</span></div>
          <ul className="space-y-1 mb-2">
            {Object.entries(colors).map(([rule, color]) => (
              <li key={rule} className="flex items-center gap-2 text-xs">
                <span className="w-4 h-4 rounded-[2px] border border-atl-n-30" style={{ background: color }} />
                <code className="font-mono text-atl-n-600">{rule}</code>
                <button
                  onClick={() => {
                    const next = { ...colors };
                    delete next[rule];
                    patch({ colors: next });
                  }}
                  className="text-atl-r-500 hover:underline ml-1"
                >
                  remove
                </button>
              </li>
            ))}
            {Object.keys(colors).length === 0 && (
              <li className="text-xs text-atl-n-100 italic">No color rules — e.g. priority:Highest → red edge</li>
            )}
          </ul>
          <div className="flex items-center gap-2">
            <select
              value={colorDraft.field}
              onChange={(e) => setColorDraft({ ...colorDraft, field: e.target.value })}
              className="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm bg-atl-paper"
            >
              <option value="priority">priority</option>
              <option value="issuetype">issuetype</option>
              <option value="status">status</option>
            </select>
            <input
              value={colorDraft.value}
              onChange={(e) => setColorDraft({ ...colorDraft, value: e.target.value })}
              placeholder="value (e.g. Highest)"
              className="h-8 px-2 rounded-[3px] border border-atl-n-40 text-sm w-36 focus:border-atl-b-300 focus:outline-none"
            />
            <input
              type="color"
              value={colorDraft.color}
              onChange={(e) => setColorDraft({ ...colorDraft, color: e.target.value })}
              className="h-8 w-9 rounded-[3px] border border-atl-n-40 bg-atl-paper p-0.5"
            />
            <button
              onClick={() => {
                if (!colorDraft.value.trim()) return;
                patch({ colors: { ...colors, [`${colorDraft.field}:${colorDraft.value.trim()}`]: colorDraft.color } });
                setColorDraft({ ...colorDraft, value: '' });
              }}
              className="h-8 px-3 rounded-[3px] text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500"
            >
              Add rule
            </button>
          </div>
        </div>
        {save.isError && (
          <div className="text-xs text-atl-r-500">
            {save.error instanceof ApiError ? save.error.message : 'Save failed'}
          </div>
        )}
      </div>
    </div>
  );
}

/** 033 — quick filters: named JQL chips shown on the board (Jira board settings). */
function QuickFiltersSection({ boardRef }: { boardRef: string }) {
  const queryClient = useQueryClient();
  const { data: filters } = useQuery({
    queryKey: ['quickfilters', boardRef],
    queryFn: () => fetchQuickFilters(boardRef),
  });
  const [draft, setDraft] = useState<{ id?: string; name: string; jql: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['quickfilters', boardRef] });
  const saveQf = useMutation({
    mutationFn: (d: { id?: string; name: string; jql: string }) =>
      d.id ? updateQuickFilter(boardRef, d.id, { name: d.name, jql: d.jql }) : createQuickFilter(boardRef, d),
    onSuccess: () => {
      setDraft(null);
      setErr(null);
      invalidate();
    },
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Save failed'),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteQuickFilter(boardRef, id),
    onSuccess: () => {
      setConfirmDel(null);
      invalidate();
    },
  });
  // 062 US3 — destructive deletes confirm everywhere (061 US2 convention).
  const [confirmDel, setConfirmDel] = useState<QuickFilter | null>(null);
  return (
    <div id="bs-quickfilters" className="mt-8 rounded-[3px] border border-atl-n-30 bg-atl-paper">
      <div className="px-4 py-3 border-b border-atl-n-30 bg-atl-n-10 flex items-center">
        <h3 className="text-sm font-semibold text-atl-n-800">Quick filters</h3>
        <span className="ml-2 text-xs text-atl-n-200">Named JQL chips AND-composed onto the board</span>
        <button
          onClick={() => setDraft({ name: '', jql: '' })}
          className="ml-auto text-xs font-medium text-atl-b-400 hover:underline"
        >
          + Add quick filter
        </button>
      </div>
      <ul className="divide-y divide-atl-n-20">
        {(filters ?? []).map((qf: QuickFilter) => (
          <li key={qf.id} className="px-4 py-2.5 flex items-center gap-3">
            <span className="text-sm text-atl-n-800 w-40">{qf.name}</span>
            <code className="text-xs text-atl-n-400 flex-1 font-mono">{qf.jql}</code>
            <button
              onClick={() => setDraft({ id: qf.id, name: qf.name, jql: qf.jql })}
              className="text-xs text-atl-b-400 hover:underline"
            >
              Edit
            </button>
            <button
              onClick={() => setConfirmDel(qf)}
              className="text-xs text-atl-r-500 hover:underline"
            >
              Delete
            </button>
          </li>
        ))}
        {(filters ?? []).length === 0 && !draft && (
          <li className="px-4 py-3 text-xs text-atl-n-100 italic">
            No quick filters — e.g. “Only my issues” → assignee = currentUser()
          </li>
        )}
      </ul>
      {draft && (
        <div className="px-4 py-3 border-t border-atl-n-30 bg-atl-n-10 flex items-end gap-2">
          <div className="w-40">
            <label className="block text-[11px] text-atl-n-200 mb-0.5">Name</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="w-full rounded-[3px] border border-atl-n-40 px-2 py-1 text-sm focus:border-atl-b-300 focus:outline-none"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] text-atl-n-200 mb-0.5">JQL</label>
            <input
              value={draft.jql}
              onChange={(e) => setDraft({ ...draft, jql: e.target.value })}
              placeholder="assignee = currentUser()"
              className="w-full rounded-[3px] border border-atl-n-40 px-2 py-1 text-sm font-mono focus:border-atl-b-300 focus:outline-none"
            />
          </div>
          <button
            onClick={() => saveQf.mutate(draft)}
            disabled={!draft.name.trim() || !draft.jql.trim() || saveQf.isPending}
            className="rounded-[3px] px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 disabled:opacity-50"
          >
            {saveQf.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => { setDraft(null); setErr(null); }}
            className="rounded-[3px] px-3 py-1.5 text-sm text-atl-n-400 hover:bg-atl-n-20"
          >
            Cancel
          </button>
        </div>
      )}
      {err && <div className="px-4 py-2 text-xs text-atl-r-500 border-t border-atl-n-30">{err}</div>}
      <ConfirmDialog
        open={Boolean(confirmDel)}
        title="Delete quick filter"
        body={
          <>
            Delete <strong>{confirmDel?.name}</strong>? Board and backlog views stop applying{' '}
            <code className="font-mono text-xs">{confirmDel?.jql}</code>.
          </>
        }
        pending={del.isPending}
        error={del.isError ? (del.error instanceof ApiError ? del.error.message : 'Delete failed') : null}
        onConfirm={() => confirmDel && del.mutate(confirmDel.id)}
        onClose={() => setConfirmDel(null)}
      />
    </div>
  );
}

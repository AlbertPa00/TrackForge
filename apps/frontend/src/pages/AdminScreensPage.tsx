// 060 US2 — /admin/screens: screens, screen schemes, and issue-type screen
// schemes. Pure console on the 031 backend — enforcement already lives in
// createmeta/editmeta.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAdminScreens, createScreen, updateScreen, deleteScreen, setScreenTabs,
  fetchAdminScreenSchemes, createScreenScheme, updateScreenScheme, deleteScreenScheme,
  fetchIssueTypeScreenSchemes, createIssueTypeScreenScheme, updateIssueTypeScreenScheme, deleteIssueTypeScreenScheme,
  fetchFields, fetchIssueTypes, fetchProjects,
  ApiError, type AdminScreen, type AdminScreenScheme, type AdminItss, type ScreenOp,
} from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import { useFlag } from '../components/Flag.js';

const input = 'border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';
const OPS: { v: ScreenOp; l: string }[] = [
  { v: 'default', l: 'Default' },
  { v: 'create', l: 'Create' },
  { v: 'edit', l: 'Edit' },
  { v: 'view', l: 'View' },
];

// ------------------------------ Screens tab ------------------------------

type TabDraft = { name: string; fields: string[] };

/** Expanded editor: rename + tabs/ordered fields (functional ordering, no
    drag-drop — 031 precedent). */
function ScreenEditor({ screen }: { screen: AdminScreen }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const fields = useQuery({ queryKey: ['field-defs'], queryFn: fetchFields });
  const [name, setName] = useState(screen.name);
  const [description, setDescription] = useState(screen.description ?? '');
  const [tabs, setTabs] = useState<TabDraft[]>(
    screen.tabs.length
      ? screen.tabs.map((t) => ({ name: t.name, fields: t.fields.map((f) => f.fieldId) }))
      : [{ name: 'Tab 1', fields: [] }],
  );
  const [addField, setAddField] = useState<Record<number, string>>({});

  const fieldName = (id: string) => (fields.data ?? []).find((f) => f.id === id)?.name ?? id;
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin-screens'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Save failed');
  const save = useMutation({
    mutationFn: async () => {
      await updateScreen(screen.id, { name: name.trim(), description: description.trim() || undefined });
      await setScreenTabs(screen.id, tabs.filter((t) => t.name.trim()));
    },
    onSuccess: () => { flag.success(`Screen ${name.trim()} saved`); invalidate(); },
    onError,
  });

  const setTab = (i: number, t: TabDraft) => setTabs(tabs.map((x, j) => (j === i ? t : x)));
  const moveField = (ti: number, fi: number, dir: -1 | 1) => {
    const fs = [...tabs[ti].fields];
    const j = fi + dir;
    if (j < 0 || j >= fs.length) return;
    [fs[fi], fs[j]] = [fs[j], fs[fi]];
    setTab(ti, { ...tabs[ti], fields: fs });
  };

  return (
    <div className="px-4 py-3 bg-atl-n-10 border-t border-atl-n-30 space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Name</span>
          <input className={`${input} block`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Description</span>
          <input className={`${input} block w-64`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>

      {tabs.map((tab, ti) => (
        <div key={ti} className="border border-atl-n-30 rounded bg-atl-paper">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-atl-n-20">
            <input
              className={`${input} w-48`}
              value={tab.name}
              onChange={(e) => setTab(ti, { ...tab, name: e.target.value })}
              aria-label={`Tab ${ti + 1} name`}
            />
            <button
              className="text-xs text-atl-r-400 hover:underline ml-auto"
              onClick={() => setTabs(tabs.filter((_, j) => j !== ti))}
            >
              Remove tab
            </button>
          </div>
          <div className="px-3 py-2">
            {tab.fields.map((fid, fi) => (
              <div key={`${fid}-${fi}`} className="flex items-center gap-2 py-1 border-t border-atl-n-20 first:border-t-0">
                <span className="text-sm text-atl-n-800">{fieldName(fid)}</span>
                <code className="text-[11px] text-atl-n-200">{fid}</code>
                <span className="ml-auto space-x-2 whitespace-nowrap">
                  <button className="text-xs text-atl-n-300 hover:text-atl-n-700 disabled:opacity-30" disabled={fi === 0} onClick={() => moveField(ti, fi, -1)} aria-label="Move up">↑</button>
                  <button className="text-xs text-atl-n-300 hover:text-atl-n-700 disabled:opacity-30" disabled={fi === tab.fields.length - 1} onClick={() => moveField(ti, fi, 1)} aria-label="Move down">↓</button>
                  <button
                    className="text-xs text-atl-r-400 hover:underline"
                    onClick={() => setTab(ti, { ...tab, fields: tab.fields.filter((_, j) => j !== fi) })}
                  >
                    Remove
                  </button>
                </span>
              </div>
            ))}
            {tab.fields.length === 0 && <div className="py-1 text-xs text-atl-n-200">No fields on this tab.</div>}
            <div className="flex items-center gap-2 mt-2">
              <select
                className={input}
                value={addField[ti] ?? ''}
                onChange={(e) => setAddField({ ...addField, [ti]: e.target.value })}
              >
                <option value="">Add field…</option>
                {(fields.data ?? []).filter((f) => !tab.fields.includes(f.id)).map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
              <button
                className="px-2.5 py-1.5 text-sm text-atl-b-400 border border-atl-b-75 hover:bg-atl-b-50 rounded disabled:opacity-50"
                disabled={!addField[ti]}
                onClick={() => {
                  setTab(ti, { ...tab, fields: [...tab.fields, addField[ti]] });
                  setAddField({ ...addField, [ti]: '' });
                }}
              >
                Add
              </button>
            </div>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <button
          className="px-2.5 py-1.5 text-sm text-atl-b-400 border border-atl-b-75 hover:bg-atl-b-50 rounded"
          onClick={() => setTabs([...tabs, { name: `Tab ${tabs.length + 1}`, fields: [] }])}
        >
          Add tab
        </button>
        <button
          className="ml-auto px-2.5 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!name.trim() || tabs.some((t) => !t.name.trim()) || save.isPending}
          onClick={() => save.mutate()}
        >
          Save screen
        </button>
      </div>
    </div>
  );
}

function ScreensTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const screens = useQuery({ queryKey: ['admin-screens'], queryFn: fetchAdminScreens });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [confirmDel, setConfirmDel] = useState<AdminScreen | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin-screens'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createScreen({ name: newName.trim(), description: newDesc.trim() || undefined }),
    onSuccess: () => { flag.success(`Screen ${newName.trim()} created`); setNewName(''); setNewDesc(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteScreen(id),
    onSuccess: () => { flag.success('Screen deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-64`} placeholder="New screen name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input className={`${input} w-64`} placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create screen
        </button>
      </div>

      {screens.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {screens.data && screens.data.length === 0 && <EmptyState title="No screens" />}

      {(screens.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(screens.data ?? []).map((s) => (
          <div key={s.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
                <span className="ml-2 text-xs text-atl-n-200">
                  {s.tabs.length} tab{s.tabs.length === 1 ? '' : 's'} · {s.tabs.reduce((n, t) => n + t.fields.length, 0)} fields
                </span>
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? 'Hide' : 'Edit'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(s)}>Delete</button>
              </div>
            </div>
            {expanded === s.id && <ScreenEditor screen={s} />}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body="Deletion is refused while the screen is used by a screen scheme."
        confirmLabel="Delete screen"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

// --------------------------- Screen schemes tab ---------------------------

function ScreenSchemeEditor({ scheme }: { scheme: AdminScreenScheme }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const screens = useQuery({ queryKey: ['admin-screens'], queryFn: fetchAdminScreens });
  const [name, setName] = useState(scheme.name);
  const [description, setDescription] = useState(scheme.description ?? '');
  const [ops, setOps] = useState<Record<ScreenOp, string>>(() => {
    const init: Record<ScreenOp, string> = { default: '', create: '', edit: '', view: '' };
    for (const it of scheme.items) init[it.operation] = it.screenId;
    return init;
  });

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['screen-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Save failed');
  const save = useMutation({
    mutationFn: () => updateScreenScheme(scheme.id, {
      name: name.trim(),
      description: description.trim() || undefined,
      items: OPS.filter((o) => ops[o.v]).map((o) => ({ operation: o.v, screenId: ops[o.v] })),
    }),
    onSuccess: () => { flag.success(`Scheme ${name.trim()} saved`); invalidate(); },
    onError,
  });

  return (
    <div className="px-4 py-3 bg-atl-n-10 border-t border-atl-n-30 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Name</span>
          <input className={`${input} block`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Description</span>
          <input className={`${input} block w-64`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <button
          className="px-2.5 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200">
            <th className="py-1 w-32">Operation</th>
            <th className="py-1">Screen</th>
          </tr>
        </thead>
        <tbody>
          {OPS.map((o) => (
            <tr key={o.v} className="border-t border-atl-n-20">
              <td className="py-1.5 text-atl-n-800">{o.l}</td>
              <td className="py-1.5">
                <select className={input} value={ops[o.v]} onChange={(e) => setOps({ ...ops, [o.v]: e.target.value })}>
                  <option value="">{o.v === 'default' ? '— none —' : `Inherit default`}</option>
                  {(screens.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScreenSchemesTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['screen-schemes'], queryFn: fetchAdminScreenSchemes });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDel, setConfirmDel] = useState<AdminScreenScheme | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['screen-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createScreenScheme({ name: newName.trim() }),
    onSuccess: () => { flag.success(`Scheme ${newName.trim()} created`); setNewName(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteScreenScheme(id),
    onSuccess: () => { flag.success('Screen scheme deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-72`} placeholder="New scheme name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create scheme
        </button>
      </div>

      {schemes.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {schemes.data && schemes.data.length === 0 && <EmptyState title="No screen schemes" />}

      {(schemes.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(schemes.data ?? []).map((s) => (
          <div key={s.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
                <span className="ml-2 text-xs text-atl-n-200">{s.items.length} operation{s.items.length === 1 ? '' : 's'} mapped</span>
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? 'Hide' : 'Edit'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(s)}>Delete</button>
              </div>
            </div>
            {expanded === s.id && <ScreenSchemeEditor scheme={s} />}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body="Deletion is refused while the scheme is used by an issue type screen scheme."
        confirmLabel="Delete scheme"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

// ---------------------- Issue-type screen schemes tab ----------------------

function ItssEditor({ scheme }: { scheme: AdminItss }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const screenSchemes = useQuery({ queryKey: ['screen-schemes'], queryFn: fetchAdminScreenSchemes });
  const types = useQuery({ queryKey: ['issue-types'], queryFn: fetchIssueTypes });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [name, setName] = useState(scheme.name);
  const [description, setDescription] = useState(scheme.description ?? '');
  const [defaultSchemeId, setDefaultSchemeId] = useState(scheme.defaultScheme?.id ?? '');
  const [mappings, setMappings] = useState<Record<string, string>>(
    Object.fromEntries(scheme.mappings.map((m) => [m.issueType.id, m.screenScheme.id])),
  );

  const bound = (projects.data ?? []).filter((p) => p.schemeIds?.issueTypeScreen === scheme.id).map((p) => p.key);
  const ssName = (id: string) => (screenSchemes.data ?? []).find((s) => s.id === id)?.name ?? '— none —';

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['itss'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Save failed');
  const save = useMutation({
    mutationFn: () => updateIssueTypeScreenScheme(scheme.id, {
      name: name.trim(),
      description: description.trim() || undefined,
      defaultSchemeId: defaultSchemeId || null,
      mappings: Object.entries(mappings).map(([issueTypeId, screenSchemeId]) => ({ issueTypeId, screenSchemeId })),
    }),
    onSuccess: () => { flag.success(`Scheme ${name.trim()} saved`); invalidate(); },
    onError,
  });

  return (
    <div className="px-4 py-3 bg-atl-n-10 border-t border-atl-n-30 space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Name</span>
          <input className={`${input} block`} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Description</span>
          <input className={`${input} block w-64`} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-atl-n-200">Default screen scheme</span>
          <select className={`${input} block`} value={defaultSchemeId} onChange={(e) => setDefaultSchemeId(e.target.value)}>
            <option value="">— none —</option>
            {(screenSchemes.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button
          className="px-2.5 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!name.trim() || save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </button>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200">
            <th className="py-1">Issue type</th>
            <th className="py-1">Screen scheme</th>
          </tr>
        </thead>
        <tbody>
          {(types.data ?? []).map((t) => (
            <tr key={t.id} className="border-t border-atl-n-20">
              <td className="py-1.5 text-atl-n-800">
                {t.name}
                {t.subtask && <span className="ml-2 text-[11px] text-atl-n-200">sub-task</span>}
              </td>
              <td className="py-1.5">
                <select
                  className={input}
                  value={mappings[t.id] ?? ''}
                  onChange={(e) => {
                    const next = { ...mappings };
                    if (e.target.value) next[t.id] = e.target.value; else delete next[t.id];
                    setMappings(next);
                  }}
                >
                  <option value="">Default ({ssName(defaultSchemeId)})</option>
                  {(screenSchemes.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-xs text-atl-n-200">
        {bound.length ? `Bound to: ${bound.join(', ')}` : 'Not bound to any project'}
      </div>
    </div>
  );
}

function ItssTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['itss'], queryFn: fetchIssueTypeScreenSchemes });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDel, setConfirmDel] = useState<AdminItss | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['itss'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createIssueTypeScreenScheme({ name: newName.trim() }),
    onSuccess: () => { flag.success(`Scheme ${newName.trim()} created`); setNewName(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteIssueTypeScreenScheme(id),
    onSuccess: () => { flag.success('Issue type screen scheme deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-72`} placeholder="New scheme name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create scheme
        </button>
      </div>

      {schemes.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {schemes.data && schemes.data.length === 0 && <EmptyState title="No issue type screen schemes" />}

      {(schemes.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(schemes.data ?? []).map((s) => (
          <div key={s.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
                <span className="ml-2 text-xs text-atl-n-200">
                  default: {s.defaultScheme?.name ?? '—'} · {s.mappings.length} mapping{s.mappings.length === 1 ? '' : 's'} · {s._count?.projects ?? 0} project{s._count?.projects === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? 'Hide' : 'Edit'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(s)}>Delete</button>
              </div>
            </div>
            {expanded === s.id && <ItssEditor scheme={s} />}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body={confirmDel?._count?.projects
          ? `Bound to ${confirmDel._count.projects} project(s) — unbind them first.`
          : 'The scheme is not bound to any project.'}
        confirmLabel="Delete scheme"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

export default function AdminScreensPage() {
  const [tab, setTab] = useState<'screens' | 'schemes' | 'itss'>('screens');
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-atl-n-800">Screens</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-4">Which fields appear on create, edit, and view — per issue type, per project.</p>
      <div className="flex gap-1 mb-4 border-b border-atl-n-30">
        {([
          ['screens', 'Screens'],
          ['schemes', 'Screen schemes'],
          ['itss', 'Issue type screen schemes'],
        ] as const).map(([k, l]) => (
          <button
            key={k}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === k ? 'border-atl-b-400 text-atl-b-400' : 'border-transparent text-atl-n-300 hover:text-atl-n-500'}`}
            onClick={() => setTab(k)}
          >
            {l}
          </button>
        ))}
      </div>
      {tab === 'screens' && <ScreensTab />}
      {tab === 'schemes' && <ScreenSchemesTab />}
      {tab === 'itss' && <ItssTab />}
    </div>
  );
}

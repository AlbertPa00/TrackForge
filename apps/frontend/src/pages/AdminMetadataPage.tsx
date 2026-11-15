// 021 US3 — /admin/metadata: vocabularies (statuses, priorities, resolutions,
// issue types, link types) with Jira-style integrity-guarded deletes.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchMetadata, createMetadata, updateMetadata, deleteMetadata,
  ApiError, type MetadataEntity, type MetadataItem,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';

const ENTITIES: { key: MetadataEntity; label: string; singular: string; fields: { key: string; label: string; type: 'text' | 'select' | 'checkbox' | 'number'; options?: { v: string; l: string }[] }[] }[] = [
  {
    key: 'statuses', label: 'Statuses', singular: 'status',
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'category', label: 'Category', type: 'select', options: [{ v: 'todo', l: 'To do' }, { v: 'inprogress', l: 'In progress' }, { v: 'done', l: 'Done' }] },
      { key: 'sequence', label: 'Sequence', type: 'number' },
    ],
  },
  {
    key: 'priorities', label: 'Priorities', singular: 'priority',
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'color', label: 'Color (hex)', type: 'text' },
      { key: 'sequence', label: 'Sequence', type: 'number' },
    ],
  },
  {
    key: 'resolutions', label: 'Resolutions', singular: 'resolution',
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'sequence', label: 'Sequence', type: 'number' },
    ],
  },
  {
    key: 'issuetypes', label: 'Issue types', singular: 'issue type',
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'isSubtask', label: 'Sub-task type', type: 'checkbox' },
      { key: 'hierarchyLevel', label: 'Hierarchy level', type: 'number' },
    ],
  },
  {
    key: 'issuelinktypes', label: 'Link types', singular: 'link type',
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'outward', label: 'Outward description', type: 'text' },
      { key: 'inward', label: 'Inward description', type: 'text' },
    ],
  },
];

const input = 'mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';

function EditDialog({
  entity, item, onClose,
}: { entity: (typeof ENTITIES)[number]; item: MetadataItem | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of entity.fields) init[f.key] = item?.[f.key as keyof MetadataItem] ?? (f.type === 'checkbox' ? false : '');
    return init;
  });
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      for (const f of entity.fields) {
        const v = form[f.key];
        if (f.type === 'number') { if (v !== '' && v != null) body[f.key] = Number(v); continue; }
        if (v === '' || v == null) continue;
        body[f.key] = v;
      }
      return item ? updateMetadata(entity.key, item.id, body) : createMetadata(entity.key, body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-metadata', entity.key] }); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? Object.values(e.errors)[0] ?? e.errorMessages[0] ?? e.message : 'Save failed'),
  });

  return (
    <Modal open onClose={onClose} labelledBy="meta-edit-title">
      <div className="p-6 w-[440px]">
        <h2 id="meta-edit-title" className="text-[18px] font-medium text-atl-n-800 mb-4">
          {item ? 'Edit' : 'Add'} {entity.singular}
        </h2>
        <div className="space-y-3">
          {entity.fields.map((f) => f.type === 'checkbox' ? (
            <label key={f.key} className="flex items-center gap-2 text-sm text-atl-n-500">
              <input type="checkbox" checked={Boolean(form[f.key])} onChange={(e) => setForm({ ...form, [f.key]: e.target.checked })} />
              {f.label}
            </label>
          ) : f.type === 'select' ? (
            <label key={f.key} className="block">
              <span className="text-xs font-medium text-atl-n-200">{f.label}</span>
              <select className={input} value={String(form[f.key] ?? '')} onChange={(e) => setForm({ ...form, [f.key]: e.target.value || undefined })}>
                <option value="">—</option>
                {f.options?.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </select>
            </label>
          ) : (
            <label key={f.key} className="block">
              <span className="text-xs font-medium text-atl-n-200">{f.label}</span>
              <input
                className={input}
                type={f.type === 'number' ? 'number' : 'text'}
                value={String(form[f.key] ?? '')}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
            </label>
          ))}
          {error && <div className="text-sm text-atl-r-400">{error}</div>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm text-atl-n-500 hover:bg-atl-n-20 rounded" onClick={onClose}>Cancel</button>
          <button
            className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
            disabled={!String(form.name ?? '').trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {item ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminMetadataPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<MetadataEntity>('statuses');
  const [edit, setEdit] = useState<MetadataItem | null | 'new' | null>(null);
  const [confirmDel, setConfirmDel] = useState<MetadataItem | null>(null);
  const [delError, setDelError] = useState<string | null>(null);
  const entity = ENTITIES.find((e) => e.key === tab)!;

  const items = useQuery({ queryKey: ['admin-metadata', tab], queryFn: () => fetchMetadata(tab) });
  const del = useMutation({
    mutationFn: (id: string) => deleteMetadata(tab, id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-metadata', tab] }); setConfirmDel(null); setDelError(null); },
    onError: (e) => setDelError(e instanceof ApiError ? Object.values(e.errors)[0] ?? e.errorMessages[0] ?? e.message : 'Delete failed'),
  });

  const cols = entity.fields.filter((f) => f.type !== 'checkbox' || tab === 'issuetypes');

  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-atl-n-800">Metadata</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-4">The vocabularies issues are built from.</p>

      <div className="flex gap-1 mb-4 border-b border-atl-n-30">
        {ENTITIES.map((e) => (
          <button
            key={e.key}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${tab === e.key ? 'border-atl-b-400 text-atl-b-400' : 'border-transparent text-atl-n-300 hover:text-atl-n-500'}`}
            onClick={() => setTab(e.key)}
          >
            {e.label}
          </button>
        ))}
      </div>

      <div className="flex justify-end mb-3">
        <button className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded" onClick={() => setEdit('new')}>
          Add {entity.singular}
        </button>
      </div>

      {items.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {items.data && items.data.length === 0 && <EmptyState title={`No ${entity.label.toLowerCase()}`} />}

      {(items.data?.length ?? 0) > 0 && (
        <div className="bg-atl-paper border border-atl-n-30 rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
                <th className="px-4 py-2">Name</th>
                {cols.slice(1).map((f) => <th key={f.key} className="px-4 py-2">{f.label}</th>)}
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.data!.map((m) => (
                <tr key={m.id} className="border-b border-atl-n-20 last:border-0">
                  <td className="px-4 py-2 text-atl-n-800">{m.name}</td>
                  {cols.slice(1).map((f) => (
                    <td key={f.key} className="px-4 py-2 text-atl-n-500 text-xs">
                      {f.key === 'category' && m.category
                        ? <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${m.category === 'done' ? 'bg-atl-g-50 text-atl-g-500' : m.category === 'inprogress' ? 'bg-atl-b-50 text-atl-b-400' : 'bg-atl-n-20 text-atl-n-300'}`}>{m.category}</span>
                        : f.type === 'checkbox'
                          ? (m[f.key as keyof MetadataItem] ? 'yes' : '—')
                          : String(m[f.key as keyof MetadataItem] ?? '—')}
                    </td>
                  ))}
                  <td className="px-4 py-2 text-right space-x-2">
                    <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setEdit(m)}>Edit</button>
                    <button className="text-sm text-atl-r-400 hover:underline" onClick={() => { setDelError(null); setConfirmDel(m); }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {edit && <EditDialog entity={entity} item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body={tab === 'issuelinktypes'
          ? 'Deleting a link type also deletes the links made with it — the count is recorded in the audit log.'
          : 'Deletes are refused while the item is referenced (issues, workflows, board columns).'}
        pending={del.isPending}
        error={delError}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </div>
  );
}

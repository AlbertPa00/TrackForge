// Admin custom-field management — list/create/rename/soft-delete fields and
// edit context options, mirroring Jira's custom-field admin grid.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchProjects,
  listCustomFields,
  createCustomField,
  updateCustomField,
  deleteCustomField,
  updateCfContext,
  type CustomFieldAdmin,
} from '../api/client.js';
import Modal from '../components/Modal.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import { imeComposing } from '../lib/ime.js';

const HAS_OPTIONS = new Set(['select', 'radio', 'multiselect', 'checkbox', 'cascading']);

export default function CustomFieldsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['customfields'], queryFn: () => listCustomFields() });
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [deactivating, setDeactivating] = useState<{ field: CustomFieldAdmin; affected: number } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['customfields'] });

  const preview = useMutation({
    mutationFn: async (f: CustomFieldAdmin) => {
      const p = (await deleteCustomField(f.id, true)) as { affectedIssues?: number };
      return { field: f, affected: p?.affectedIssues ?? 0 };
    },
    onSuccess: setDeactivating,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const remove = useMutation({
    mutationFn: (f: CustomFieldAdmin) => deleteCustomField(f.id),
    onSuccess: () => {
      invalidate();
      setDeactivating(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const fields = data?.fields ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-5xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-semibold text-atl-n-800">Custom fields</h1>
            <p className="text-sm text-atl-n-200 mt-1">
              Fields are shown on issues in the projects their contexts apply to.
            </p>
          </div>
          <button
            onClick={() => setCreating(true)}
            className="h-9 px-4 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white"
          >
            Create custom field
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-atl-r-300 bg-atl-r-50 px-3 py-2 text-sm text-atl-r-500">{error}</div>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-atl-n-200 border-b border-atl-n-30">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Contexts</th>
              <th className="py-2 pr-4">Options</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <FieldRow
                key={f.id}
                field={f}
                projects={projects ?? []}
                expanded={expanded === f.id}
                onToggle={() => setExpanded(expanded === f.id ? null : f.id)}
                onChanged={invalidate}
                onDelete={() => preview.mutate(f)}
              />
            ))}
            {fields.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-atl-n-200">
                  No custom fields yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {creating && (
          <CreateFieldModal
            types={data?.types ?? []}
            projects={(projects ?? []).map((p) => ({ key: p.key, name: p.name }))}
            onClose={() => setCreating(false)}
            onCreated={() => {
              setCreating(false);
              invalidate();
            }}
          />
        )}
        <ConfirmDialog
          open={deactivating !== null}
          title={`Deactivate '${deactivating?.field.name}'?`}
          body={
            <>
              {deactivating?.affected ?? 0} issue(s) hold a value — values are kept but the
              field stops appearing.
            </>
          }
          confirmLabel="Deactivate"
          pending={remove.isPending}
          onConfirm={() => deactivating && remove.mutate(deactivating.field)}
          onClose={() => setDeactivating(null)}
        />
      </div>
    </div>
  );
}

function FieldRow({
  field,
  projects,
  expanded,
  onToggle,
  onChanged,
  onDelete,
}: {
  field: CustomFieldAdmin;
  projects: { id: string; key: string; name: string }[];
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(field.name);
  const rename = useMutation({
    mutationFn: () => updateCustomField(field.id, { name: name.trim() || field.name }),
    onSuccess: () => {
      setRenaming(false);
      onChanged();
    },
  });

  const ctxLabel = field.contexts.length === 0
    ? '—'
    : field.contexts
        .map((c) => {
          if (c.isGlobal) return 'Global';
          const keys = c.projects
            .map((p) => projects.find((x) => x.id === p.projectId)?.key ?? p.projectId.slice(0, 6))
            .join(', ');
          return keys || 'Projects';
        })
        .join(' · ');
  const optCount = field.contexts.reduce((n, c) => n + c.options.length, 0);

  return (
    <>
      <tr className={`border-b border-atl-n-20 ${field.active ? '' : 'opacity-55'}`}>
        <td className="py-2.5 pr-4">
          {renaming ? (
            <input
              autoFocus
              className="rounded border border-atl-b-300 px-1.5 py-0.5 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => rename.mutate()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !imeComposing(e)) rename.mutate();
                if (e.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <button onClick={() => setRenaming(true)} className="text-atl-b-300 hover:underline font-medium">
              {field.name}
            </button>
          )}
          <div className="text-[11px] text-atl-n-100 font-mono">
            {field.id}
            {field.alias && <span className="ml-1.5 text-atl-n-200">alias: {field.alias}</span>}
          </div>
        </td>
        <td className="py-2.5 pr-4 text-atl-n-500">{field.type}</td>
        <td className="py-2.5 pr-4 text-atl-n-500">{ctxLabel}</td>
        <td className="py-2.5 pr-4 text-atl-n-500">{optCount || '—'}</td>
        <td className="py-2.5 pr-4">
          {field.systemManaged ? (
            <span className="rounded bg-atl-n-20 px-1.5 py-0.5 text-[11px] text-atl-n-400">System</span>
          ) : field.active ? (
            <span className="rounded bg-atl-g-50 px-1.5 py-0.5 text-[11px] text-atl-g-500">Active</span>
          ) : (
            <span className="rounded bg-atl-n-20 px-1.5 py-0.5 text-[11px] text-atl-n-300">Inactive</span>
          )}
        </td>
        <td className="py-2.5 text-right whitespace-nowrap">
          {HAS_OPTIONS.has(field.type) && (
            <button onClick={onToggle} className="text-xs text-atl-b-300 hover:underline mr-3">
              {expanded ? 'Hide options' : 'Options'}
            </button>
          )}
          {!field.systemManaged &&
            (field.active ? (
              <button onClick={onDelete} className="text-xs text-atl-r-400 hover:underline">
                Deactivate
              </button>
            ) : (
              <ActivateButton fieldId={field.id} onChanged={onChanged} />
            ))}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-atl-n-20 bg-atl-n-10/40">
          <td colSpan={6} className="px-4 py-3">
            {field.contexts.map((c) => (
              <OptionsEditor key={c.id} field={field} ctxId={c.id} onSaved={onChanged} />
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

/** Restore a deactivated (soft-deleted) field — PUT {active:true}. */
function ActivateButton({ fieldId, onChanged }: { fieldId: string; onChanged: () => void }) {
  const m = useMutation({
    mutationFn: () => updateCustomField(fieldId, { active: true }),
    onSuccess: onChanged,
  });
  return (
    <button
      onClick={() => m.mutate()}
      disabled={m.isPending}
      className="text-xs text-atl-g-500 hover:underline disabled:opacity-50"
    >
      {m.isPending ? 'Activating…' : 'Activate'}
    </button>
  );
}

/** Line-based option editor — 'Parent > Child' syntax for cascading fields. */
function OptionsEditor({
  field,
  ctxId,
  onSaved,
}: {
  field: CustomFieldAdmin;
  ctxId: string;
  onSaved: () => void;
}) {
  const ctx = field.contexts.find((c) => c.id === ctxId)!;
  const cascading = field.type === 'cascading';
  const serialize = () =>
    ctx.options
      .map((o) =>
        [
          (o.disabled ? '!' : '') + o.value,
          ...(o.children ?? []).map((ch) => `${o.value} > ${(ch.disabled ? '!' : '') + ch.value}`),
        ].filter((_, i) => i === 0 || cascading)
      )
      .flat()
      .join('\n');
  const [text, setText] = useState(serialize);
  const [dirty, setDirty] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const byValue = new Map(ctx.options.map((o) => [o.value, o]));
      // Parse lines; merge 'Parent > Child' lines into one entry per parent.
      const parsed = new Map<string, { id?: string; value: string; disabled: boolean; children?: string[] }>();
      for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
        const [parentRaw, childRaw] = line.split('>').map((s) => s.trim());
        const disabled = parentRaw.startsWith('!');
        const value = disabled ? parentRaw.slice(1).trim() : parentRaw;
        const entry = parsed.get(value) ?? {
          id: byValue.get(value)?.id,
          value,
          disabled: disabled || Boolean(byValue.get(value)?.disabled),
          children: cascading ? [] : undefined,
        };
        if (childRaw !== undefined && cascading) {
          entry.children!.push(childRaw);
        }
        parsed.set(value, entry);
      }
      return updateCfContext(field.id, ctxId, { options: [...parsed.values()] });
    },
    onSuccess: () => {
      setDirty(false);
      onSaved();
    },
  });
  return (
    <div className="mb-3 last:mb-0">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-atl-n-200">
          Options — {ctx.isGlobal ? 'Global context' : `${ctx.projects.length} project(s)`}
        </span>
        {dirty && (
          <button onClick={() => save.mutate()} disabled={save.isPending} className="text-xs text-atl-b-300 hover:underline">
            {save.isPending ? 'Saving…' : 'Save options'}
          </button>
        )}
      </div>
      <textarea
        className="w-full h-28 rounded border border-atl-n-40 bg-atl-paper px-2 py-1.5 text-sm font-mono text-atl-n-700 focus:border-atl-b-300 outline-none"
        value={text}
        placeholder={cascading ? 'Parent\nParent > Child' : 'One option per line'}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
      />
      <p className="mt-0.5 text-[11px] text-atl-n-100">
        {cascading ? "One 'Parent' or 'Parent > Child' per line; prefix with ! to disable." : 'One option per line; prefix with ! to disable.'}
      </p>
      {save.isError && <p className="mt-1 text-xs text-atl-r-400">{String(save.error)}</p>}
    </div>
  );
}

function CreateFieldModal({
  types,
  projects,
  onClose,
  onCreated,
}: {
  types: string[];
  projects: { key: string; name: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [description, setDescription] = useState('');
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [optionsText, setOptionsText] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const cascading = type === 'cascading';
      const options = HAS_OPTIONS.has(type)
        ? optionsText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((line) => {
              const [p, c] = line.split('>').map((s) => s.trim());
              return c !== undefined && cascading
                ? { value: p, children: [c] }
                : p;
            })
        : undefined;
      return createCustomField({
        name: name.trim(),
        type,
        description: description.trim() || undefined,
        context: {
          projectKeys: selectedProjects.size ? [...selectedProjects] : undefined,
          options,
        },
      });
    },
    onSuccess: onCreated,
  });

  return (
    <Modal open onClose={onClose}>
      <form
        className="p-6 w-[520px] max-h-[80vh] overflow-y-auto"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <h2 className="text-[18px] font-medium text-atl-n-800 mb-4">Create custom field</h2>
        <div className="space-y-3">
          <label className="block">
            <span className="text-[12px] font-medium text-atl-n-200">Name</span>
            <input
              autoFocus
              className="mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px]"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-atl-n-200">Type</span>
            <select
              className="mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px] bg-atl-paper"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {types.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-atl-n-200">Description (optional)</span>
            <input
              className="mt-1 w-full border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div>
            <span className="text-[12px] font-medium text-atl-n-200">
              Applicable projects <span className="text-atl-n-100">(none selected = global)</span>
            </span>
            <div className="mt-1 flex flex-wrap gap-2">
              {projects.map((p) => (
                <label key={p.key} className="inline-flex items-center gap-1.5 text-[13px] text-atl-n-800">
                  <input
                    type="checkbox"
                    checked={selectedProjects.has(p.key)}
                    onChange={(e) =>
                      setSelectedProjects((cur) => {
                        const next = new Set(cur);
                        if (e.target.checked) next.add(p.key);
                        else next.delete(p.key);
                        return next;
                      })
                    }
                  />
                  {p.name} ({p.key})
                </label>
              ))}
            </div>
          </div>
          {HAS_OPTIONS.has(type) && (
            <label className="block">
              <span className="text-[12px] font-medium text-atl-n-200">
                Options {type === 'cascading' ? "('Parent' or 'Parent > Child' per line)" : '(one per line)'}
              </span>
              <textarea
                className="mt-1 w-full h-24 border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-[14px]"
                placeholder={type === 'cascading' ? 'Parent\nParent > Child' : 'One option per line'}
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
              />
            </label>
          )}
        </div>
        {create.isError && (
          <p className="mt-3 text-sm text-atl-r-400">
            {create.error instanceof Error ? create.error.message : 'Create failed'}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 px-4 rounded-[3px] text-sm font-medium text-atl-n-500 hover:bg-atl-n-20">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="h-9 px-4 rounded-[3px] bg-atl-b-400 hover:bg-atl-b-500 text-sm font-medium text-white disabled:opacity-60"
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

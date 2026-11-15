import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchComponents,
  fetchVersions,
  searchAssignableUsers,
  type CfAllowedValue,
  type FieldMeta,
} from '../api/client.js';
import InlineEdit from './InlineEdit.js';
import UserAvatar from './UserAvatar.js';
import { CloseIcon } from './icons.js';
import { formatDate, formatDateTime } from '../lib/format.js';
import { isSafeHref } from '../lib/url.js';
import { useDateFormat } from '../hooks/useDateFormat.js';
import { imeComposing } from '../lib/ime.js';

/** Extract the internal CF type from schema.custom ('com.trackforge.customfields:select'). */
export function cfTypeOf(meta: FieldMeta): string {
  return meta.schema.custom?.split(':').pop() ?? meta.schema.type;
}

const INPUT =
  'w-full h-8 px-2 rounded-[3px] border border-atl-b-300 bg-atl-paper text-sm text-atl-n-700 focus:outline-none focus:ring-2 focus:ring-atl-b-200';

interface OptionRef {
  id: string;
  value: string;
}

function asOption(v: unknown): OptionRef | null {
  return v && typeof v === 'object' && 'id' in (v as object)
    ? (v as OptionRef)
    : null;
}
function asOptions(v: unknown): OptionRef[] {
  return Array.isArray(v) ? (v.filter(asOption) as OptionRef[]) : [];
}

/** Read-only rendering of a stored CF value. */
export function CfDisplay({ meta, value }: { meta: FieldMeta; value: unknown }) {
  const type = cfTypeOf(meta);
  if (value === null || value === undefined || value === '') {
    return <span className="px-1 py-0.5 text-atl-n-100 italic">None</span>;
  }
  switch (type) {
    case 'select':
    case 'radio': {
      const o = asOption(value);
      return <span className="px-1 py-0.5">{o?.value ?? 'None'}</span>;
    }
    case 'cascading': {
      const o = asOption(value) as (OptionRef & { child?: OptionRef | null }) | null;
      return <span className="px-1 py-0.5">{[o?.value, o?.child?.value].filter(Boolean).join(' - ') || 'None'}</span>;
    }
    case 'multiselect':
    case 'checkbox': {
      const opts = asOptions(value);
      if (!opts.length) return <span className="px-1 py-0.5 text-atl-n-100 italic">None</span>;
      return (
        <span className="inline-flex flex-wrap gap-1 px-1 py-0.5">
          {opts.map((o) => (
            <span key={o.id} className="rounded bg-atl-n-20 px-1.5 py-0.5 text-xs text-atl-n-700">
              {o.value}
            </span>
          ))}
        </span>
      );
    }
    case 'user': {
      const u = value as { displayName?: string } | null;
      return (
        <span className="inline-flex items-center gap-1.5 px-1 py-0.5">
          <UserAvatar displayName={u?.displayName} size={20} />
          {u?.displayName ?? 'None'}
        </span>
      );
    }
    case 'checklist': {
      const items = (value as { items?: { text: string; done: boolean }[] } | null)?.items ?? [];
      if (!items.length) return <span className="px-1 py-0.5 text-atl-n-100 italic">None</span>;
      const done = items.filter((i) => i.done).length;
      return <span className="px-1 py-0.5">{done}/{items.length} done</span>;
    }
    case 'version_picker':
    case 'component_picker': {
      const e = value as { name?: string } | null;
      return <span className="px-1 py-0.5">{e?.name ?? 'None'}</span>;
    }
    case 'date':
      return <span className="px-1 py-0.5">{formatDate(String(value))}</span>;
    case 'datetime':
      return <span className="px-1 py-0.5">{formatDateTime(String(value))}</span>;
    case 'url': {
      const u = String(value);
      return isSafeHref(u) ? (
        <a href={u} target="_blank" rel="noreferrer" className="px-1 py-0.5 text-atl-b-300 hover:underline">
          {u}
        </a>
      ) : (
        <span className="px-1 py-0.5">{u}</span>
      );
    }
    default:
      return <span className="px-1 py-0.5">{String(value)}</span>;
  }
}

/**
 * Immediate-save editor for the issue detail sidebar. `onSave` receives the
 * Jira-shaped write value (or null to clear) and must return a promise.
 */
export function CfEditor({
  meta,
  value,
  projectKey,
  onSave,
  disabled = false,
}: {
  meta: FieldMeta;
  value: unknown;
  projectKey: string;
  onSave: (v: unknown) => Promise<void>;
  /** Read-only display (user lacks EDIT_ISSUES). */
  disabled?: boolean;
}) {
  const type = cfTypeOf(meta);
  const allowed = meta.allowedValues ?? [];

  if (disabled) return <CfDisplay meta={meta} value={value} />;

  switch (type) {
    case 'text':
    case 'url':
      return (
        <InlineEdit
          value={value == null ? '' : String(value)}
          onSave={(v) => onSave(v === '' ? null : v)}
          display={(v) => (v ? <span className="px-1 py-0.5">{v}</span> : <CfDisplay meta={meta} value={null} />)}
        />
      );
    case 'textarea':
      return (
        <InlineEdit
          mode="textarea"
          value={value == null ? '' : String(value)}
          onSave={(v) => onSave(v === '' ? null : v)}
          display={(v) => (v ? <span className="px-1 py-0.5 whitespace-pre-wrap">{v}</span> : <CfDisplay meta={meta} value={null} />)}
        />
      );
    case 'number':
      return (
        <InlineEdit
          value={value == null ? '' : String(value)}
          onSave={(v) => onSave(v.trim() === '' ? null : Number(v))}
          display={(v) => (v ? <span className="px-1 py-0.5">{v}</span> : <CfDisplay meta={meta} value={null} />)}
        />
      );
    case 'date':
      return <CfDateEditor meta={meta} value={value} onSave={onSave} />;
    case 'datetime':
      return (
        <input
          type="datetime-local"
          aria-label={meta.name}
          value={value == null ? '' : String(value).slice(0, 16)}
          onChange={(e) => void onSave(e.target.value ? new Date(e.target.value).toISOString() : null)}
          className="w-full rounded px-1 py-0.5 text-sm text-atl-n-700 hover:bg-atl-n-20 focus:outline-none focus:ring-2 focus:ring-atl-b-200"
        />
      );
    case 'select':
    case 'radio':
      return (
        <InlineEdit
          mode="select"
          value={asOption(value)?.value ?? ''}
          options={[{ value: '', label: 'None' }, ...allowed.map((o) => ({ value: o.value, label: o.value }))]}
          onSave={(v) => {
            const opt = allowed.find((o) => o.value === v);
            return onSave(opt ? { id: opt.id } : null);
          }}
          display={() => <CfDisplay meta={meta} value={value} />}
        />
      );
    case 'multiselect':
    case 'checkbox':
      return <MultiEditor allowed={allowed} value={value} onSave={onSave} />;
    case 'cascading':
      return <CascadeEditor allowed={allowed} value={value} onSave={onSave} />;
    case 'user':
      return <UserEditor projectKey={projectKey} value={value} onSave={onSave} />;
    case 'version_picker':
    case 'component_picker':
      return <EntityPickerEditor type={type} projectKey={projectKey} meta={meta} value={value} onSave={onSave} />;
    case 'checklist':
      return <ChecklistEditor value={value} onSave={onSave} />;
    default:
      return <CfDisplay meta={meta} value={value} />;
  }
}

/** Date CF: formatted at rest like the Due date row, native picker while editing. */
function CfDateEditor({
  meta,
  value,
  onSave,
}: {
  meta: FieldMeta;
  value: unknown;
  onSave: (v: unknown) => Promise<void>;
}) {
  const { format: formatDateForUser } = useDateFormat();
  return (
    <InlineEdit
      mode="date"
      ariaLabel={`Edit ${meta.name}`}
      value={value == null ? '' : String(value).slice(0, 10)}
      onSave={(v) => onSave(v || null)}
      display={(v) =>
        v ? <span className="px-1 py-0.5">{formatDateForUser(v)}</span> : <CfDisplay meta={meta} value={null} />
      }
    />
  );
}

/** Sprint 019 — project-scoped version/component dropdowns for CF pickers. */
function EntityPickerEditor({
  type,
  projectKey,
  meta,
  value,
  onSave,
}: {
  type: string;
  projectKey: string;
  meta: FieldMeta;
  value: unknown;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const { data: options } = useQuery({
    queryKey: [type === 'version_picker' ? 'versions' : 'components', projectKey],
    queryFn: () => (type === 'version_picker' ? fetchVersions(projectKey) : fetchComponents(projectKey)),
    enabled: editing,
  });
  const cur = value as { id?: string; name?: string } | null;
  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="w-full text-left rounded hover:bg-atl-n-20">
        <CfDisplay meta={meta} value={value} />
      </button>
    );
  }
  const list = (options ?? []).filter((o) => !('archived' in o) || !o.archived || o.id === cur?.id);
  return (
    <select
      autoFocus
      className={INPUT}
      value={cur?.id ?? ''}
      onChange={(e) => {
        const sel = list.find((x) => x.id === e.target.value);
        void onSave(sel ? { id: sel.id } : null).then(() => setEditing(false));
      }}
      onBlur={() => setEditing(false)}
    >
      <option value="">None</option>
      {list.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  );
}

/** Multi-value option CF (multiselect/checkbox): overlay dropdown like
 *  SelectDropdown/EntityRefPicker — toggles save immediately without
 *  reflowing the sidebar's <dl>. */
function MultiEditor({
  allowed,
  value,
  onSave,
}: {
  allowed: CfAllowedValue[];
  value: unknown;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const current = asOptions(value);
  const ids = new Set(current.map((o) => o.id));
  const display = <CfDisplay meta={{ schema: { type: 'array', custom: 'x:multiselect' } } as FieldMeta} value={value} />;
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setQuery(''); setEditing(true); }}
        className="w-full text-left rounded hover:bg-atl-n-20"
      >
        {display}
      </button>
    );
  }
  const toggle = (opt: CfAllowedValue) => {
    const next = ids.has(opt.id)
      ? current.filter((o) => o.id !== opt.id)
      : [...current, { id: opt.id, value: opt.value }];
    void onSave(next.length ? next.map((o) => ({ id: o.id })) : null);
  };
  const q = query.trim().toLowerCase();
  const visible = q ? allowed.filter((o) => o.value.toLowerCase().includes(q)) : allowed;
  return (
    <div
      className="relative"
      onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setEditing(false); }}
    >
      <div className="rounded ring-2 ring-atl-b-200">{display}</div>
      <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-[3px] border border-atl-n-30 bg-atl-paper shadow-lg">
        {allowed.length > 8 && (
          <div className="border-b border-atl-n-20 p-1.5">
            <input
              autoFocus
              className={INPUT}
              placeholder="Filter options…"
              aria-label="Filter options"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        <ul className="max-h-56 overflow-auto py-1">
          {visible.map((o) => (
            <li key={o.id}>
              <label
                className="flex cursor-pointer items-center gap-2 px-2 py-1 text-sm text-atl-n-700 hover:bg-atl-n-10"
                title={o.value}
              >
                <input type="checkbox" checked={ids.has(o.id)} onChange={() => toggle(o)} />
                <span className="truncate">{o.value}</span>
              </label>
            </li>
          ))}
          {visible.length === 0 && <li className="px-2 py-1.5 text-xs italic text-atl-n-100">No matching options</li>}
        </ul>
        <div className="border-t border-atl-n-20 px-2 py-1 text-right">
          <button type="button" onClick={() => setEditing(false)} className="text-xs text-atl-b-300 hover:underline">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function CascadeEditor({
  allowed,
  value,
  onSave,
}: {
  allowed: CfAllowedValue[];
  value: unknown;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const current = asOption(value) as (OptionRef & { child?: OptionRef | null }) | null;
  const parent = allowed.find((o) => o.id === current?.id) ?? null;
  const children = parent?.children ?? [];
  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="w-full text-left rounded hover:bg-atl-n-20">
        <CfDisplay meta={{ schema: { type: 'option', custom: 'x:cascading' } } as FieldMeta} value={value} />
      </button>
    );
  }
  return (
    <div className="flex gap-1.5" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setEditing(false); }}>
      <select
        autoFocus
        className={INPUT}
        value={parent?.id ?? ''}
        onChange={(e) => {
          const p = allowed.find((o) => o.id === e.target.value);
          void onSave(p ? { id: p.id } : null);
        }}
      >
        <option value="">None</option>
        {allowed.map((o) => (
          <option key={o.id} value={o.id}>{o.value}</option>
        ))}
      </select>
      {children.length > 0 && (
        <select
          className={INPUT}
          value={current?.child?.id ?? ''}
          onChange={(e) => {
            const c = children.find((o) => o.id === e.target.value);
            if (parent) void onSave({ id: parent.id, child: c ? { id: c.id } : null });
          }}
        >
          <option value="">—</option>
          {children.map((o) => (
            <option key={o.id} value={o.id}>{o.value}</option>
          ))}
        </select>
      )}
    </div>
  );
}

function UserEditor({
  projectKey,
  value,
  onSave,
}: {
  projectKey: string;
  value: unknown;
  onSave: (v: unknown) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const { data: users } = useQuery({
    queryKey: ['assignable', projectKey, ''],
    queryFn: () => searchAssignableUsers(projectKey, ''),
    enabled: editing,
  });
  const u = value as { accountId?: string; displayName?: string } | null;
  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="w-full text-left rounded hover:bg-atl-n-20">
        <CfDisplay meta={{ schema: { type: 'user', custom: 'x:user' } } as FieldMeta} value={value} />
      </button>
    );
  }
  return (
    <select
      autoFocus
      className={INPUT}
      value={u?.accountId ?? ''}
      onChange={(e) => {
        const sel = (users ?? []).find((x) => x.accountId === e.target.value);
        void onSave(sel ? { accountId: sel.accountId } : null).then(() => setEditing(false));
      }}
      onBlur={() => setEditing(false)}
    >
      <option value="">Unassigned</option>
      {(users ?? []).map((x) => (
        <option key={x.accountId} value={x.accountId}>{x.displayName}</option>
      ))}
    </select>
  );
}

function ChecklistEditor({
  value,
  onSave,
}: {
  value: unknown;
  onSave: (v: unknown) => Promise<void>;
}) {
  const items = (value as { items?: { text: string; done: boolean }[] } | null)?.items ?? [];
  const [newItem, setNewItem] = useState('');
  const commit = (items2: { text: string; done: boolean }[]) =>
    void onSave(items2.length ? { items: items2 } : null);
  return (
    <div className="space-y-0.5">
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-atl-n-10 group">
          <input
            type="checkbox"
            checked={it.done}
            onChange={() => commit(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))}
          />
          <span className={`flex-1 text-sm ${it.done ? 'line-through text-atl-n-100' : 'text-atl-n-700'}`}>
            {it.text}
          </span>
          <button
            type="button"
            onClick={() => commit(items.filter((_, j) => j !== i))}
            className="text-atl-n-100 opacity-0 group-hover:opacity-100 hover:text-atl-r-400"
          >
            <CloseIcon size={11} />
          </button>
        </div>
      ))}
      <input
        className="w-full px-1 py-0.5 text-sm text-atl-n-700 placeholder:text-atl-n-100 rounded hover:bg-atl-n-10 focus:outline-none focus:ring-1 focus:ring-atl-b-200"
        placeholder="Add an item…"
        value={newItem}
        onChange={(e) => setNewItem(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !imeComposing(e) && newItem.trim()) {
            commit([...items, { text: newItem.trim(), done: false }]);
            setNewItem('');
          }
        }}
      />
    </div>
  );
}

/**
 * Controlled input for the create dialog — `value` is the Jira-shaped write
 * value; `onChange` receives the next write value (or null to clear).
 */
export function CfFormInput({
  meta,
  value,
  projectKey,
  onChange,
}: {
  meta: FieldMeta;
  value: unknown;
  projectKey: string;
  onChange: (v: unknown) => void;
}) {
  const type = cfTypeOf(meta);
  const allowed = meta.allowedValues ?? [];
  const cls = 'w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper';

  switch (type) {
    case 'number':
      return (
        <input
          type="number"
          className={cls}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'date':
      return (
        <input
          type="date"
          aria-label={meta.name}
          className={cls}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    case 'datetime':
      return (
        <input
          type="datetime-local"
          aria-label={meta.name}
          className={cls}
          value={value == null ? '' : String(value).slice(0, 16)}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    case 'select':
    case 'radio':
      return (
        <select
          className={cls}
          value={asOption(value)?.id ?? ''}
          onChange={(e) => {
            const o = allowed.find((x) => x.id === e.target.value);
            onChange(o ? { id: o.id } : null);
          }}
        >
          <option value="">None</option>
          {allowed.map((o) => (
            <option key={o.id} value={o.id}>{o.value}</option>
          ))}
        </select>
      );
    case 'multiselect':
    case 'checkbox': {
      const ids = new Set(asOptions(value).map((o) => o.id));
      return (
        <div className="rounded-[3px] border-2 border-atl-n-40 px-2 py-1.5 space-y-0.5">
          {allowed.length === 0 && <p className="text-xs text-atl-n-200">No options configured</p>}
          {allowed.map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm text-atl-n-700">
              <input
                type="checkbox"
                checked={ids.has(o.id)}
                onChange={(e) => {
                  const cur = asOptions(value).filter((x) => x.id !== o.id);
                  onChange(e.target.checked ? [...cur, { id: o.id }] : cur.length ? cur : null);
                }}
              />
              {o.value}
            </label>
          ))}
        </div>
      );
    }
    case 'cascading': {
      const cur = asOption(value) as (OptionRef & { child?: OptionRef | null }) | null;
      const parent = allowed.find((o) => o.id === cur?.id) ?? null;
      return (
        <div className="flex gap-2">
          <select
            className={cls}
            value={parent?.id ?? ''}
            onChange={(e) => {
              const p = allowed.find((o) => o.id === e.target.value);
              onChange(p ? { id: p.id } : null);
            }}
          >
            <option value="">None</option>
            {allowed.map((o) => (
              <option key={o.id} value={o.id}>{o.value}</option>
            ))}
          </select>
          {(parent?.children?.length ?? 0) > 0 && (
            <select
              className={cls}
              value={cur?.child?.id ?? ''}
              onChange={(e) => {
                const c = parent!.children!.find((o) => o.id === e.target.value);
                onChange({ id: parent!.id, child: c ? { id: c.id } : null });
              }}
            >
              <option value="">—</option>
              {parent!.children!.map((o) => (
                <option key={o.id} value={o.id}>{o.value}</option>
              ))}
            </select>
          )}
        </div>
      );
    }
    case 'user':
      return <UserFormSelect className={cls} projectKey={projectKey} value={value} onChange={onChange} />;
    case 'version_picker':
    case 'component_picker':
      return <EntityPickerFormSelect className={cls} type={type} projectKey={projectKey} value={value} onChange={onChange} />;
    case 'checklist':
    case 'textarea':
      return (
        <textarea
          className={`${cls} h-20 py-2 resize-y`}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
    default:
      return (
        <input
          className={cls}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}

function EntityPickerFormSelect({
  className,
  type,
  projectKey,
  value,
  onChange,
}: {
  className: string;
  type: string;
  projectKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { data: options } = useQuery({
    queryKey: [type === 'version_picker' ? 'versions' : 'components', projectKey],
    queryFn: () => (type === 'version_picker' ? fetchVersions(projectKey) : fetchComponents(projectKey)),
    enabled: Boolean(projectKey),
  });
  const cur = value as { id?: string } | null;
  const list = (options ?? []).filter((o) => !('archived' in o) || !o.archived);
  return (
    <select
      className={className}
      value={cur?.id ?? ''}
      onChange={(e) => {
        const sel = list.find((x) => x.id === e.target.value);
        onChange(sel ? { id: sel.id } : null);
      }}
    >
      <option value="">None</option>
      {list.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  );
}

function UserFormSelect({
  className,
  projectKey,
  value,
  onChange,
}: {
  className: string;
  projectKey: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { data: users } = useQuery({
    queryKey: ['assignable', projectKey, ''],
    queryFn: () => searchAssignableUsers(projectKey, ''),
    enabled: Boolean(projectKey),
  });
  const u = value as { accountId?: string } | null;
  return (
    <select
      className={className}
      value={u?.accountId ?? ''}
      onChange={(e) => {
        const sel = (users ?? []).find((x) => x.accountId === e.target.value);
        onChange(sel ? { accountId: sel.accountId } : null);
      }}
    >
      <option value="">Unassigned</option>
      {(users ?? []).map((x) => (
        <option key={x.accountId} value={x.accountId}>{x.displayName}</option>
      ))}
    </select>
  );
}

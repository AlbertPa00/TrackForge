// 060 US3 — /admin/field-config: field configurations (required / hidden /
// description / default + conditional behaviour rules) and their schemes.
// Pure console on the 031 backend — enforcement lives in planCreate/update.
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchFieldConfigurations, createFieldConfiguration, updateFieldConfiguration, deleteFieldConfiguration,
  fetchFieldConfigurationSchemes, createFieldConfigurationScheme, updateFieldConfigurationScheme,
  deleteFieldConfigurationScheme,
  fetchFields, fetchIssueTypes, fetchProjects,
  ApiError, type FieldConfiguration, type FieldConfigItemInput, type FcRule, type AdminFcScheme,
} from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import EmptyState from '../components/EmptyState.js';
import { useFlag } from '../components/Flag.js';

const input = 'border border-atl-n-40 rounded-[3px] px-2 py-1.5 text-sm';

/** Text input → JSON value when it parses, else plain string. */
function parseValue(s: string): unknown {
  const t = s.trim();
  if (t === '') return undefined;
  try { return JSON.parse(t); } catch { return t; }
}
function displayValue(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

// --------------------------- rules editor ---------------------------

type RuleDraft = {
  whenField: string;
  cond: 'is' | 'isNot' | 'in' | 'empty';
  value: string;
  effect: 'required' | 'hidden' | 'defaultValue';
  effectValue: string;
};

function ruleToDraft(r: FcRule): RuleDraft {
  const w = r.when ?? {};
  const cond: RuleDraft['cond'] = w.empty ? 'empty' : w.in ? 'in' : w.isNot !== undefined ? 'isNot' : 'is';
  const raw = w.empty ? '' : w.in ? (w.in as unknown[]).map(displayValue).join(', ') : displayValue(w.isNot !== undefined ? w.isNot : w.is);
  const effect: RuleDraft['effect'] = r.required !== undefined ? 'required' : r.hidden !== undefined ? 'hidden' : 'defaultValue';
  return {
    whenField: w.field ?? '', cond, value: raw, effect,
    effectValue: effect === 'defaultValue' ? displayValue(r.defaultValue) : '',
  };
}

function draftToRule(d: RuleDraft): FcRule {
  const when: NonNullable<FcRule['when']> = { field: d.whenField };
  if (d.cond === 'empty') when.empty = true;
  else if (d.cond === 'in') when.in = d.value.split(',').map((s) => parseValue(s));
  else if (d.cond === 'isNot') when.isNot = parseValue(d.value);
  else when.is = parseValue(d.value);
  if (d.effect === 'required') return { when, required: true };
  if (d.effect === 'hidden') return { when, hidden: true };
  return { when, defaultValue: parseValue(d.effectValue) };
}

function RuleRow({
  rule, fields, onChange, onRemove,
}: {
  rule: RuleDraft;
  fields: { id: string; name: string }[];
  onChange: (r: RuleDraft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1 border-t border-atl-n-20 first:border-t-0">
      <span className="text-xs text-atl-n-300">when</span>
      <select className={input} value={rule.whenField} onChange={(e) => onChange({ ...rule, whenField: e.target.value })}>
        <option value="">field…</option>
        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
      <select
        className={input}
        value={rule.cond}
        onChange={(e) => onChange({ ...rule, cond: e.target.value as RuleDraft['cond'] })}
      >
        <option value="is">equals</option>
        <option value="isNot">does not equal</option>
        <option value="in">is one of</option>
        <option value="empty">is empty</option>
      </select>
      {rule.cond !== 'empty' && (
        <input
          className={`${input} w-28`}
          placeholder={rule.cond === 'in' ? 'a, b, c' : 'value'}
          value={rule.value}
          onChange={(e) => onChange({ ...rule, value: e.target.value })}
        />
      )}
      <span className="text-xs text-atl-n-300">then</span>
      <select
        className={input}
        value={rule.effect}
        onChange={(e) => onChange({ ...rule, effect: e.target.value as RuleDraft['effect'] })}
      >
        <option value="required">required</option>
        <option value="hidden">hidden</option>
        <option value="defaultValue">set default</option>
      </select>
      {rule.effect === 'defaultValue' && (
        <input
          className={`${input} w-28`}
          placeholder="default value"
          value={rule.effectValue}
          onChange={(e) => onChange({ ...rule, effectValue: e.target.value })}
        />
      )}
      <button className="ml-auto text-xs text-atl-r-400 hover:underline" onClick={onRemove}>Remove</button>
    </div>
  );
}

// --------------------- field configuration editor ---------------------

type ItemDraft = {
  fieldId: string; required: boolean; hidden: boolean;
  description: string; defaultValue: string; rules: RuleDraft[]; rulesOpen: boolean;
};

function FieldConfigEditor({ config }: { config: FieldConfiguration }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const fields = useQuery({ queryKey: ['field-defs'], queryFn: fetchFields });
  const [name, setName] = useState(config.name);
  const [description, setDescription] = useState(config.description ?? '');
  const [items, setItems] = useState<ItemDraft[]>(
    config.items.map((i) => ({
      fieldId: i.fieldId,
      required: i.required,
      hidden: i.hidden,
      description: i.description ?? '',
      defaultValue: displayValue(i.defaultValue),
      rules: (i.rules ?? []).map(ruleToDraft),
      rulesOpen: false,
    })),
  );
  const [addField, setAddField] = useState('');

  const fieldName = (id: string) => (fields.data ?? []).find((f) => f.id === id)?.name ?? id;
  const fieldDefs = (fields.data ?? []).map((f) => ({ id: f.id, name: f.name }));
  const addable = fieldDefs.filter((f) => !items.some((i) => i.fieldId === f.id));

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['field-configs'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Save failed');
  const save = useMutation({
    mutationFn: () => updateFieldConfiguration(config.id, {
      name: name.trim(),
      description: description.trim() || undefined,
      items: items.map<FieldConfigItemInput>((i) => ({
        fieldId: i.fieldId,
        required: i.required || undefined,
        hidden: i.hidden || undefined,
        description: i.description.trim() || undefined,
        defaultValue: parseValue(i.defaultValue),
        rules: i.rules.length ? i.rules.map(draftToRule) : undefined,
      })),
    }),
    onSuccess: () => { flag.success(`Configuration ${name.trim()} saved`); invalidate(); },
    onError,
  });

  const setItem = (i: number, next: ItemDraft) => setItems(items.map((x, j) => (j === i ? next : x)));

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
            <th className="py-1">Field</th>
            <th className="py-1 w-16">Required</th>
            <th className="py-1 w-16">Hidden</th>
            <th className="py-1">Description</th>
            <th className="py-1 w-28">Default</th>
            <th className="py-1 w-32" />
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <Fragment key={item.fieldId}>
              <tr className="border-t border-atl-n-20">
                <td className="py-1.5 text-atl-n-800">{fieldName(item.fieldId)}</td>
                <td className="py-1.5 text-center">
                  <input type="checkbox" checked={item.required} onChange={(e) => setItem(i, { ...item, required: e.target.checked })} />
                </td>
                <td className="py-1.5 text-center">
                  <input type="checkbox" checked={item.hidden} onChange={(e) => setItem(i, { ...item, hidden: e.target.checked })} />
                </td>
                <td className="py-1.5 pr-2">
                  <input className={`${input} w-full`} value={item.description} onChange={(e) => setItem(i, { ...item, description: e.target.value })} />
                </td>
                <td className="py-1.5 pr-2">
                  <input className={`${input} w-full`} placeholder="—" value={item.defaultValue} onChange={(e) => setItem(i, { ...item, defaultValue: e.target.value })} />
                </td>
                <td className="py-1.5 text-right space-x-2 whitespace-nowrap">
                  <button className="text-xs text-atl-b-400 hover:underline" onClick={() => setItem(i, { ...item, rulesOpen: !item.rulesOpen })}>
                    Rules{item.rules.length ? ` (${item.rules.length})` : ''}
                  </button>
                  <button className="text-xs text-atl-r-400 hover:underline" onClick={() => setItems(items.filter((_, j) => j !== i))}>Remove</button>
                </td>
              </tr>
              {item.rulesOpen && (
                <tr className="bg-atl-n-10">
                  <td colSpan={6} className="px-3 py-2">
                    {item.rules.map((r, ri) => (
                      <RuleRow
                        key={ri}
                        rule={r}
                        fields={fieldDefs}
                        onChange={(next) => setItem(i, { ...item, rules: item.rules.map((x, j) => (j === ri ? next : x)) })}
                        onRemove={() => setItem(i, { ...item, rules: item.rules.filter((_, j) => j !== ri) })}
                      />
                    ))}
                    <button
                      className="mt-1 text-xs text-atl-b-400 hover:underline"
                      onClick={() => setItem(i, { ...item, rules: [...item.rules, { whenField: '', cond: 'is', value: '', effect: 'required', effectValue: '' }] })}
                    >
                      + Add conditional rule
                    </button>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {items.length === 0 && (
            <tr><td colSpan={6} className="py-2 text-xs text-atl-n-200">No items — fields behave with defaults until configured.</td></tr>
          )}
        </tbody>
      </table>
      <div className="flex items-center gap-2">
        <select className={input} value={addField} onChange={(e) => setAddField(e.target.value)}>
          <option value="">Configure field…</option>
          {addable.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <button
          className="px-2.5 py-1.5 text-sm text-atl-b-400 border border-atl-b-75 hover:bg-atl-b-50 rounded disabled:opacity-50"
          disabled={!addField}
          onClick={() => {
            setItems([...items, { fieldId: addField, required: false, hidden: false, description: '', defaultValue: '', rules: [], rulesOpen: false }]);
            setAddField('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function FieldConfigsTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const configs = useQuery({ queryKey: ['field-configs'], queryFn: fetchFieldConfigurations });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDel, setConfirmDel] = useState<FieldConfiguration | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['field-configs'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createFieldConfiguration({ name: newName.trim() }),
    onSuccess: () => { flag.success(`Configuration ${newName.trim()} created`); setNewName(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteFieldConfiguration(id),
    onSuccess: () => { flag.success('Field configuration deleted'); invalidate(); setConfirmDel(null); },
    onError,
  });

  return (
    <>
      <div className="flex gap-2 mb-4">
        <input className={`${input} w-72`} placeholder="New configuration name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button
          className="px-3 py-1.5 text-sm font-medium text-white bg-atl-b-400 hover:bg-atl-b-500 rounded disabled:opacity-50"
          disabled={!newName.trim() || create.isPending}
          onClick={() => create.mutate()}
        >
          Create configuration
        </button>
      </div>

      {configs.isLoading && <div className="text-sm text-atl-n-200">Loading…</div>}
      {configs.data && configs.data.length === 0 && <EmptyState title="No field configurations" />}

      {(configs.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(configs.data ?? []).map((c) => (
          <div key={c.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{c.name}</span>
                {c.description && <span className="ml-2 text-xs text-atl-n-200">{c.description}</span>}
                <span className="ml-2 text-xs text-atl-n-200">{c.items.length} field{c.items.length === 1 ? '' : 's'} configured</span>
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                  {expanded === c.id ? 'Hide' : 'Edit'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(c)}>Delete</button>
              </div>
            </div>
            {expanded === c.id && <FieldConfigEditor config={c} />}
          </div>
        ))}
      </div>
      )}

      <ConfirmDialog
        open={confirmDel !== null}
        title={`Delete "${confirmDel?.name ?? ''}"?`}
        body="Deletion is refused while the configuration is used by a scheme."
        confirmLabel="Delete configuration"
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => { if (confirmDel) del.mutate(confirmDel.id); }}
        onClose={() => setConfirmDel(null)}
      />
    </>
  );
}

// ------------------ field configuration schemes tab ------------------

function FcSchemeEditor({ scheme }: { scheme: AdminFcScheme }) {
  const qc = useQueryClient();
  const flag = useFlag();
  const configs = useQuery({ queryKey: ['field-configs'], queryFn: fetchFieldConfigurations });
  const types = useQuery({ queryKey: ['issue-types'], queryFn: fetchIssueTypes });
  const projects = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });
  const [name, setName] = useState(scheme.name);
  const [description, setDescription] = useState(scheme.description ?? '');
  const [defaultConfigId, setDefaultConfigId] = useState(scheme.defaultConfig?.id ?? '');
  const [mappings, setMappings] = useState<Record<string, string>>(
    Object.fromEntries(scheme.mappings.map((m) => [m.issueType.id, m.config.id])),
  );

  const bound = (projects.data ?? []).filter((p) => p.schemeIds?.fieldConfiguration === scheme.id).map((p) => p.key);
  const configName = (id: string) => (configs.data ?? []).find((c) => c.id === id)?.name ?? '— none —';

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['fc-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Save failed');
  const save = useMutation({
    mutationFn: () => updateFieldConfigurationScheme(scheme.id, {
      name: name.trim(),
      description: description.trim() || undefined,
      defaultConfigId: defaultConfigId || null,
      mappings: Object.entries(mappings).map(([issueTypeId, configId]) => ({ issueTypeId, configId })),
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
          <span className="text-xs font-medium text-atl-n-200">Default configuration</span>
          <select className={`${input} block`} value={defaultConfigId} onChange={(e) => setDefaultConfigId(e.target.value)}>
            <option value="">— none —</option>
            {(configs.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
            <th className="py-1">Field configuration</th>
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
                  <option value="">Default ({configName(defaultConfigId)})</option>
                  {(configs.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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

function FcSchemesTab() {
  const qc = useQueryClient();
  const flag = useFlag();
  const schemes = useQuery({ queryKey: ['fc-schemes'], queryFn: fetchFieldConfigurationSchemes });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [confirmDel, setConfirmDel] = useState<AdminFcScheme | null>(null);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['fc-schemes'] });
  const onError = (e: unknown) => flag.error(e instanceof ApiError ? e.message : 'Request failed');
  const create = useMutation({
    mutationFn: () => createFieldConfigurationScheme({ name: newName.trim() }),
    onSuccess: () => { flag.success(`Scheme ${newName.trim()} created`); setNewName(''); invalidate(); },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteFieldConfigurationScheme(id),
    onSuccess: () => { flag.success('Scheme deleted'); invalidate(); setConfirmDel(null); },
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
      {schemes.data && schemes.data.length === 0 && <EmptyState title="No field configuration schemes" />}

      {(schemes.data?.length ?? 0) > 0 && (
      <div className="bg-atl-paper border border-atl-n-30 rounded divide-y divide-atl-n-20">
        {(schemes.data ?? []).map((s) => (
          <div key={s.id}>
            <div className="px-4 py-2.5 flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-atl-n-800">{s.name}</span>
                {s.description && <span className="ml-2 text-xs text-atl-n-200">{s.description}</span>}
                <span className="ml-2 text-xs text-atl-n-200">
                  default: {s.defaultConfig?.name ?? '—'} · {s.mappings.length} mapping{s.mappings.length === 1 ? '' : 's'} · {s._count?.projects ?? 0} project{s._count?.projects === 1 ? '' : 's'}
                </span>
              </div>
              <div className="space-x-2">
                <button className="text-sm text-atl-b-400 hover:underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                  {expanded === s.id ? 'Hide' : 'Edit'}
                </button>
                <button className="text-sm text-atl-r-400 hover:underline" onClick={() => setConfirmDel(s)}>Delete</button>
              </div>
            </div>
            {expanded === s.id && <FcSchemeEditor scheme={s} />}
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

export default function AdminFieldConfigPage() {
  const [tab, setTab] = useState<'configs' | 'schemes'>('configs');
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-atl-n-800">Field configurations</h1>
      <p className="text-sm text-atl-n-200 mt-0.5 mb-4">Required, hidden, described, and defaulted fields — with conditional rules — per issue type, per project.</p>
      <div className="flex gap-1 mb-4 border-b border-atl-n-30">
        {([
          ['configs', 'Field configurations'],
          ['schemes', 'Field configuration schemes'],
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
      {tab === 'configs' && <FieldConfigsTab />}
      {tab === 'schemes' && <FcSchemesTab />}
    </div>
  );
}

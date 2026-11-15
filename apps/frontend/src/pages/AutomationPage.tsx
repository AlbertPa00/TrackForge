import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchAutomationRules,
  fetchAutomationSchema,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  toggleAutomationRule,
  fetchAutomationRuns,
  validateAutomationRule,
  dryRunAutomationRule,
  type AutomationRule,
  type AutomationRun,
  type AutomationFieldSpec,
} from '../api/client.js';
import ConfirmDialog from '../components/ConfirmDialog.js';
import IssuePicker from '../components/IssuePicker.js';
import PageHeader from '../components/PageHeader.js';
import { usePermissions } from '../hooks/usePermissions.js';
import { formatDateTime } from '../lib/format.js';
import Modal from '../components/Modal.js';

/** 034 — project automation: rules list, JSON builder (validated server-side),
 *  run audit log with step-level expansion. */
export default function AutomationPage() {
  const { projectKey } = useParams();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['automation-rules'], queryFn: fetchAutomationRules });
  const { data: schema } = useQuery({ queryKey: ['automation-schema'], queryFn: fetchAutomationSchema });
  const [editing, setEditing] = useState<AutomationRule | 'new' | null>(null);
  const [expandedRule, setExpandedRule] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AutomationRule | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ['automation-rules'] });
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => toggleAutomationRule(id, enabled),
    onSuccess: inv,
  });
  const del = useMutation({
    mutationFn: deleteAutomationRule,
    onSuccess: () => {
      inv();
      setDeleting(null);
    },
  });
  // Rules mutate project state — write controls only for project admins.
  const { canAdmin, me } = usePermissions({ projectKey }, ['ADMINISTER_PROJECTS']);
  // Backend rule: author, project admin (project scope) or site admin (any scope).
  const canWriteRule = (r: AutomationRule) =>
    Boolean(me?.isAdmin) || r.author?.accountId === me?.accountId || (canAdmin && r.scope === 'project');

  const rules = (data?.rules ?? []).filter((r) => r.scope === 'global' || r.project?.key === projectKey);
  return (
    <div className="px-6 py-5 max-w-5xl">
      <PageHeader
        crumbs={[{ label: 'Projects' }, { label: projectKey ?? '' }]}
        title="Automation"
        actions={
          canAdmin ? (
            <button
              className="h-8 px-4 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-white font-medium disabled:opacity-50 text-sm"
              onClick={() => setEditing('new')}
            >
              Create rule
            </button>
          ) : undefined
        }
      />
      <p className="text-xs text-atl-n-300 -mt-3 mb-4">
        WHEN trigger · IF conditions · THEN actions — runs as the rule actor, every step logged.
      </p>
      {rules.length === 0 && <p className="text-sm text-atl-n-300">No automation rules for this project yet.</p>}
      <ul className="space-y-2">
        {rules.map((r) => (
          <li key={r.id} className="border border-atl-n-30 rounded bg-atl-paper">
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                className={`w-9 h-5 rounded-full relative transition-colors ${r.enabled ? 'bg-atl-g-300' : 'bg-atl-n-40'} ${canAdmin ? '' : 'opacity-50 cursor-not-allowed'}`}
                title={r.enabled ? 'Enabled' : 'Disabled'}
                disabled={!canWriteRule(r)}
                onClick={() => toggle.mutate({ id: r.id, enabled: !r.enabled })}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-atl-paper shadow transition-all ${r.enabled ? 'left-4.5 left-[18px]' : 'left-0.5'}`}
                />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-atl-n-800 truncate" title={r.name}>
                  {r.name}
                  {r.scope === 'global' && (
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-atl-b-300 bg-atl-b-50 px-1.5 py-0.5 rounded">
                      global
                    </span>
                  )}
                  {r.failureCount > 0 && (
                    <span className="ml-2 text-[10px] text-atl-r-400">failures: {r.failureCount}</span>
                  )}
                </div>
                <div
                  className="text-xs text-atl-n-300 truncate"
                  title={`${String((r.trigger as { type?: string }).type)} → ${(r.actions ?? []).map((a) => String(a.type)).join(', ')}`}
                >
                  {String((r.trigger as { type?: string }).type)} →{' '}
                  {(r.actions ?? []).map((a) => String(a.type)).join(', ')}
                  {r.actor && <span className="ml-2">· as {r.actor.displayName}</span>} · v{r.version}
                </div>
              </div>
              <button
                className="h-7 px-2 rounded-[3px] border border-atl-n-40 text-atl-n-500 hover:bg-atl-n-20 text-xs"
                onClick={() => setExpandedRule(expandedRule === r.id ? null : r.id)}
              >
                Audit log
              </button>
              {canWriteRule(r) && (
                <>
                  <button
                    className="h-7 px-2 rounded-[3px] border border-atl-n-40 text-atl-n-500 hover:bg-atl-n-20 text-xs"
                    onClick={() => setEditing(r)}
                  >
                    Edit
                  </button>
                  <button
                    className="h-7 px-2 rounded-[3px] border border-atl-n-40 text-atl-r-400 hover:bg-atl-n-20 text-xs"
                    onClick={() => setDeleting(r)}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
            {expandedRule === r.id && <RunLog ruleId={r.id} />}
          </li>
        ))}
      </ul>
      {editing && (
        <RuleEditor
          rule={editing === 'new' ? null : editing}
          projectKey={projectKey}
          schema={schema}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            inv();
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="Delete rule"
        body={
          <>
            Delete <span className="font-medium">{deleting?.name}</span>? Its run history is kept.
          </>
        }
        pending={del.isPending}
        error={del.isError ? (del.error as Error).message : null}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function RunLog({ ruleId }: { ruleId: string }) {
  const { data, isError } = useQuery({
    queryKey: ['automation-runs', ruleId],
    queryFn: () => fetchAutomationRuns(ruleId),
  });
  const [open, setOpen] = useState<string | null>(null);
  const runs = data?.runs ?? [];
  const color = (s: string) =>
    s === 'success' ? 'text-atl-g-400' : s.startsWith('skipped') ? 'text-atl-y-400' : 'text-atl-r-400';
  return (
    <div className="border-t border-atl-n-30 px-4 py-2 bg-atl-n-10">
      {isError && <p className="text-xs text-atl-r-400 py-2">Couldn't load the audit log — the request failed.</p>}
      {!isError && runs.length === 0 && <p className="text-xs text-atl-n-300 py-2">No runs yet.</p>}
      <ul className="divide-y divide-atl-n-20">
        {runs.map((r) => (
          <li key={r.id} className="py-1.5">
            <button
              className="w-full text-left text-xs flex gap-3 items-center"
              onClick={() => setOpen(open === r.id ? null : r.id)}
            >
              <span className={`font-medium ${color(r.status)}`}>{r.status}</span>
              <span className="text-atl-n-300">{formatDateTime(r.startedAt)}</span>
              <span className="text-atl-n-200">v{r.ruleVersion}</span>
              {r.error && <span className="text-atl-r-400 truncate" title={r.error}>{r.error}</span>}
            </button>
            {open === r.id && (
              <ol className="mt-1 ml-4 space-y-0.5">
                {(r.steps ?? []).map((s, i) => (
                  <li key={i} className="text-[11px] font-mono text-atl-n-500">
                    <span className="text-atl-n-300">[{s.step}]</span> {s.detail}
                    {s.error && <span className="text-atl-r-400"> — {s.error}</span>}
                    {s.result !== undefined && (
                      <span className="text-atl-n-300"> → {JSON.stringify(s.result).slice(0, 160)}</span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const TEMPLATE = {
  trigger: { type: 'issue_created' },
  conditions: [] as Record<string, unknown>[],
  actions: [{ type: 'comment', body: 'Automated comment on {{issue.key}}' }],
};

type Block = Record<string, unknown>; // {type, ...params} — params may hold raw edit strings
type KindList = { name: string; description: string; fields: AutomationFieldSpec[] }[];

const specsFor = (kinds: KindList, type: string) => kinds.find((k) => k.name === type)?.fields ?? [];

/** Serialize an edited block to the rule JSON shape; validates required/json fields. */
function blockToObj(b: Block, specs: AutomationFieldSpec[], tag: string, errs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { type: b.type };
  const specKeys = new Set(specs.map((s) => s.key));
  for (const s of specs) {
    const raw = b[s.key];
    if (s.kind === 'bool') {
      if (raw) out[s.key] = true;
      continue;
    }
    const str = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw);
    if (!str) {
      if (s.required) errs.push(`${tag}: '${s.key}' is required`);
      continue;
    }
    if (s.kind === 'csv')
      out[s.key] = str
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    else if (s.kind === 'json') {
      try {
        out[s.key] = JSON.parse(str);
      } catch {
        errs.push(`${tag}: '${s.key}' is not valid JSON`);
      }
    } else out[s.key] = str;
  }
  // Unknown keys survive editing untouched (registry schemas are passthrough).
  for (const [k, v] of Object.entries(b)) {
    if (k !== 'type' && !specKeys.has(k)) out[k] = v;
  }
  return out;
}

/** Value shown in a param input: arrays/csv join to text, objects stringify. */
function paramText(v: unknown, kind: AutomationFieldSpec['kind']): string {
  if (v === undefined || v === null) return '';
  if (kind === 'csv') return Array.isArray(v) ? v.join(', ') : String(v);
  if (kind === 'json') return typeof v === 'string' ? v : JSON.stringify(v);
  return String(v);
}

/** Keys outside the type spec — shown as advanced JSON so nothing is silently lost. */
function extrasOf(b: Block, specs: AutomationFieldSpec[]): Record<string, unknown> {
  const specKeys = new Set(['type', ...specs.map((s) => s.key)]);
  return Object.fromEntries(Object.entries(b).filter(([k]) => !specKeys.has(k)));
}

function ExtrasEditor({
  extras,
  onSave,
}: {
  extras: Record<string, unknown>;
  onSave: (o: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => (Object.keys(extras).length ? JSON.stringify(extras) : ''));
  const [bad, setBad] = useState(false);
  return (
    <div>
      <input
        className={`w-full font-mono text-[11px] border rounded px-1.5 py-1 ${bad ? 'border-atl-r-300' : 'border-atl-n-30'}`}
        placeholder='extra params (JSON, e.g. {"key":"value"}) — optional'
        value={text}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (!t.trim()) {
            setBad(false);
            onSave({});
            return;
          }
          try {
            onSave(JSON.parse(t));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <div className="text-[10px] text-atl-r-400 mt-0.5">invalid JSON — kept as typed until it parses</div>}
    </div>
  );
}

function BlockEditor({
  kinds,
  block,
  onChange,
  onRemove,
}: {
  kinds: KindList;
  block: Block;
  onChange: (b: Block) => void;
  onRemove?: () => void;
}) {
  const entry = kinds.find((k) => k.name === block.type);
  const specs = entry?.fields ?? [];
  const setParam = (key: string, v: unknown) => onChange({ ...block, [key]: v });
  return (
    <div className="border border-atl-n-30 rounded p-2.5 space-y-1.5 bg-atl-n-10/40">
      <div className="flex items-center gap-2">
        <select
          className="text-xs border border-atl-n-40 rounded px-1.5 py-1 bg-atl-paper"
          value={block.type as string}
          onChange={(e) => onChange({ type: e.target.value })}
        >
          {!entry && <option value={String(block.type)}>{String(block.type)}</option>}
          {kinds.map((k) => (
            <option key={k.name} value={k.name}>
              {k.name}
            </option>
          ))}
        </select>
        {entry && (
          <span className="text-[10px] text-atl-n-300 truncate" title={entry.description}>
            {entry.description}
          </span>
        )}
        {onRemove && (
          <button type="button" onClick={onRemove} className="ml-auto text-atl-n-300 hover:text-atl-r-400 text-xs px-1">
            ✕
          </button>
        )}
      </div>
      {specs.map((s) =>
        s.kind === 'bool' ? (
          <label key={s.key} className="flex items-center gap-2 text-xs text-atl-n-500" title={s.hint}>
            <input
              type="checkbox"
              checked={Boolean(block[s.key])}
              onChange={(e) => setParam(s.key, e.target.checked)}
            />
            {s.key}
            {s.hint ? <span className="text-atl-n-200">· {s.hint}</span> : null}
          </label>
        ) : (
          <label key={s.key} className="block">
            <span className="text-[10px] text-atl-n-300">
              {s.key}
              {s.required && <span className="text-atl-r-400"> *</span>}
              {s.hint ? ` · ${s.hint}` : ''}
            </span>
            <input
              className={`w-full text-xs border rounded px-1.5 py-1 font-mono ${s.kind === 'json' ? 'border-atl-n-40' : 'border-atl-n-40'}`}
              value={paramText(block[s.key], s.kind)}
              onChange={(e) => setParam(s.key, e.target.value)}
              spellCheck={false}
            />
          </label>
        )
      )}
      <ExtrasEditor
        key={String(block.type)}
        extras={extrasOf(block, specs)}
        onSave={(o) =>
          onChange({
            type: block.type,
            ...o,
            ...Object.fromEntries(specs.map((s) => [s.key, block[s.key]]).filter(([, v]) => v !== undefined)),
          })
        }
      />
    </div>
  );
}

function RuleEditor({
  rule,
  projectKey,
  schema,
  onClose,
  onSaved,
}: {
  rule: AutomationRule | null;
  projectKey?: string;
  schema?: { triggers: KindList; conditions: KindList; actions: KindList };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? '');
  const [trigger, setTrigger] = useState<Block>(rule?.trigger ?? TEMPLATE.trigger);
  const [conditions, setConditions] = useState<Block[]>(rule?.conditions ?? TEMPLATE.conditions);
  const [actions, setActions] = useState<Block[]>(rule?.actions ?? TEMPLATE.actions);
  const [errors, setErrors] = useState<string[]>([]);
  const [dryKey, setDryKey] = useState('');
  const [dryJql, setDryJql] = useState('');
  const [dryResult, setDryResult] = useState<string | null>(null);
  const qc = useQueryClient();

  const tKinds = schema?.triggers ?? [];
  const cKinds = schema?.conditions ?? [];
  const aKinds = schema?.actions ?? [];

  const buildBody = (): Record<string, unknown> | null => {
    const errs: string[] = [];
    const t = blockToObj(trigger, specsFor(tKinds, String(trigger.type)), 'trigger', errs);
    const cs = conditions.map((c, i) => blockToObj(c, specsFor(cKinds, String(c.type)), `condition ${i + 1}`, errs));
    const as = actions.map((a, i) => blockToObj(a, specsFor(aKinds, String(a.type)), `action ${i + 1}`, errs));
    if (!as.length) errs.push('at least one action is required');
    if (errs.length) {
      setErrors(errs);
      return null;
    }
    return { name, scope: 'project', projectKey, trigger: t, conditions: cs, actions: as };
  };

  const save = useMutation({
    mutationFn: async () => {
      const b = buildBody();
      if (!b) throw new Error('fix errors');
      const v = await validateAutomationRule(b);
      if (!v.valid) {
        setErrors(v.errors);
        throw new Error('invalid');
      }
      return rule ? updateAutomationRule(rule.id, b) : createAutomationRule(b);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automation-rules'] });
      onSaved();
    },
    onError: (e) => setErrors((prev) => (prev.length ? prev : [e instanceof Error ? e.message : 'save failed'])),
  });
  const dry = useMutation({
    mutationFn: async () => {
      if (!rule) throw new Error('save the rule first');
      return dryRunAutomationRule(rule.id, dryKey ? { issueKey: dryKey } : { jql: dryJql });
    },
    onSuccess: (r) =>
      setDryResult(
        'runs' in r && Array.isArray(r.runs)
          ? r.runs.map((x) => x.status).join(', ') || 'no issues matched'
          : (r as AutomationRun).status
      ),
    onError: (e) => setErrors([e instanceof Error ? e.message : 'dry run failed']),
  });

  const addBtn = (kinds: KindList, onAdd: (type: string) => void) => (
    <select
      className="text-xs border border-atl-n-40 rounded px-1.5 py-1 text-atl-n-500"
      value=""
      onChange={(e) => e.target.value && onAdd(e.target.value)}
    >
      <option value="">+ add…</option>
      {kinds.map((k) => (
        <option key={k.name} value={k.name}>
          {k.name}
        </option>
      ))}
    </select>
  );

  return (
    <Modal
      open
      onClose={onClose}
      label={rule ? 'Edit rule' : 'Create rule'}
      className="mx-auto mt-16 w-[560px] max-w-[92vw] max-h-[85vh] overflow-y-auto rounded bg-atl-paper p-5 shadow-xl"
    >
        <h2 className="text-base font-semibold text-atl-n-800 mb-3">{rule ? 'Edit rule' : 'Create rule'}</h2>
        <label className="block mb-3">
          <span className="text-xs font-medium text-atl-n-500">Name</span>
          <input
            className="w-full text-sm border border-atl-n-40 rounded px-2 py-1.5"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="mb-3">
          <div className="text-xs font-medium text-atl-n-500 mb-1">WHEN — trigger</div>
          <BlockEditor kinds={tKinds} block={trigger} onChange={setTrigger} />
        </div>

        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-atl-n-500">IF — conditions</span>
            {addBtn(cKinds, (t) => setConditions((c) => [...c, { type: t }]))}
          </div>
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <BlockEditor
                key={i}
                kinds={cKinds}
                block={c}
                onChange={(b) => setConditions((cs) => cs.map((x, j) => (j === i ? b : x)))}
                onRemove={() => setConditions((cs) => cs.filter((_, j) => j !== i))}
              />
            ))}
            {!conditions.length && (
              <p className="text-[11px] text-atl-n-200 italic">No conditions — the trigger alone decides.</p>
            )}
          </div>
        </div>

        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-atl-n-500">THEN — actions</span>
            {addBtn(aKinds, (t) => setActions((a) => [...a, { type: t }]))}
          </div>
          <div className="space-y-2">
            {actions.map((a, i) => (
              <BlockEditor
                key={i}
                kinds={aKinds}
                block={a}
                onChange={(b) => setActions((as) => as.map((x, j) => (j === i ? b : x)))}
                onRemove={() => setActions((as) => as.filter((_, j) => j !== i))}
              />
            ))}
          </div>
        </div>

        {errors.length > 0 && (
          <ul className="mb-3 text-xs text-atl-r-400 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i}>• {e}</li>
            ))}
          </ul>
        )}
        {rule && (
          <div className="mb-3 space-y-1.5">
            <div className="flex items-center gap-2">
              <div className="w-44">
                <IssuePicker
                  value={dryKey}
                  onChange={(v) => {
                    setDryKey(v);
                    if (v) setDryJql('');
                  }}
                  placeholder="Dry-run on issue…"
                />
              </div>
              <span className="text-[10px] text-atl-n-200">or</span>
              <input
                className="flex-1 font-mono text-[11px] border border-atl-n-40 rounded px-1.5 py-1"
                placeholder="JQL scope, e.g. project = TF AND status = Open"
                value={dryJql}
                onChange={(e) => {
                  setDryJql(e.target.value);
                  if (e.target.value) setDryKey('');
                }}
              />
              <button
                className="h-7 px-2 rounded-[3px] border border-atl-n-40 text-atl-n-500 hover:bg-atl-n-20 text-xs"
                disabled={(!dryKey && !dryJql.trim()) || dry.isPending}
                onClick={() => dry.mutate()}
              >
                Dry run
              </button>
              {dryResult && <span className="text-xs text-atl-n-400">→ {dryResult}</span>}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            className="h-7 px-2 rounded-[3px] border border-atl-n-40 text-atl-n-500 hover:bg-atl-n-20 text-sm"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="h-8 px-4 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-white font-medium disabled:opacity-50 text-sm"
            disabled={!name.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
    </Modal>
  );
}

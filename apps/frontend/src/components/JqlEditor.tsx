import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  fetchJqlAutocompleteData,
  fetchJqlSuggestions,
  nlToJql,
  type JqlSuggestion,
} from '../api/client.js';
import { imeComposing } from '../lib/ime.js';

/** Static fallback used only while /jql/autocompletedata is loading or failed. */
const FALLBACK_FIELDS = [
  'project', 'key', 'summary', 'description', 'text', 'comment', 'status',
  'statusCategory', 'issuetype', 'type', 'priority', 'resolution', 'assignee',
  'reporter', 'labels', 'parent', 'created', 'updated', 'resolved', 'duedate',
];

const FALLBACK_OPS: Record<string, string[]> = {
  default: ['=', '!=', 'IN', 'NOT IN', 'IS EMPTY', 'IS NOT EMPTY'],
  summary: ['~', '!~'],
  description: ['~', '!~'],
  text: ['~', '!~'],
  comment: ['~', '!~'],
  created: ['=', '!=', '>', '>=', '<', '<='],
  updated: ['=', '!=', '>', '>=', '<', '<='],
  resolved: ['=', '!=', '>', '>=', '<', '<='],
  duedate: ['=', '!=', '>', '>=', '<', '<='],
  key: ['=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN'],
};
const CLAUSE_KEYWORDS = ['AND', 'OR', 'NOT', 'ORDER BY'];

type Context =
  | { kind: 'field'; prefix: string }
  | { kind: 'operator'; field: string; prefix: string }
  | { kind: 'value'; field: string; prefix: string; replaceFrom: number }
  | { kind: 'keyword'; prefix: string }
  | { kind: 'none' };

/** Heuristic context detection: tokenise the text before the cursor. */
function detectContext(text: string): Context {
  const tokens: { raw: string; start: number; quoted: boolean }[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s(),]+)|([(),])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined || m[2] !== undefined) {
      tokens.push({ raw: m[1] ?? m[2]!, start: m.index, quoted: true });
    } else if (m[3] !== undefined) {
      tokens.push({ raw: m[3], start: m.index, quoted: false });
    } else if (m[4] !== undefined) {
      tokens.push({ raw: m[4], start: m.index, quoted: false });
    }
  }
  const trailingSpace = /\s$/.test(text) || text.length === 0;
  const last = trailingSpace ? null : tokens[tokens.length - 1];
  const currentPrefix = last && !last.quoted ? last.raw : '';

  // scan for the last clause boundary to know clause state
  let state: 'field' | 'operator' | 'value' | 'after' = 'field';
  let field = '';
  let depth = 0;
  const scanTo = trailingSpace ? tokens.length : tokens.length - 1;
  for (let i = 0; i < scanTo; i++) {
    const t = tokens[i];
    const up = t.raw.toUpperCase();
    if (t.raw === '(') {
      if (state === 'value') depth++;
      else state = 'field';
      continue;
    }
    if (t.raw === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) state = 'after';
      continue;
    }
    if (up === 'AND' || up === 'OR') {
      if (depth === 0) state = 'field';
      else state = 'value';
      continue;
    }
    if (up === 'NOT') {
      state = 'field';
      continue;
    }
    if (up === 'ORDER') {
      state = 'after';
      continue;
    }
    if (up === 'BY' || up === 'ASC' || up === 'DESC') continue;
    if (up === 'IN' || t.raw === '=' || t.raw === '!=' || t.raw === '~' || t.raw === '!~' || t.raw === '>' || t.raw === '>=' || t.raw === '<' || t.raw === '<=') {
      state = 'value';
      continue;
    }
    if (up === 'IS') {
      state = 'after';
      continue;
    }
    if (up === 'EMPTY' || up === 'NULL') {
      state = 'after';
      continue;
    }
    if (state === 'field') {
      field = t.raw.toLowerCase();
      state = 'operator';
      continue;
    }
    if (state === 'operator') {
      // bare word where operator expected (e.g. missing operator)
      state = 'value';
      continue;
    }
    if (state === 'value' && depth === 0 && t.raw !== ',') {
      state = 'after';
      continue;
    }
  }

  if (trailingSpace) {
    if (state === 'field') return { kind: 'field', prefix: '' };
    if (state === 'operator') return { kind: 'operator', field, prefix: '' };
    if (state === 'value') return { kind: 'value', field, prefix: '', replaceFrom: text.length };
    return { kind: 'keyword', prefix: '' };
  }
  const replaceFrom = last?.start ?? text.length;
  if (state === 'field') return { kind: 'field', prefix: currentPrefix };
  if (state === 'operator') return { kind: 'operator', field, prefix: currentPrefix };
  if (state === 'value') return { kind: 'value', field, prefix: currentPrefix, replaceFrom };
  // typing a keyword after a complete clause
  return { kind: 'keyword', prefix: currentPrefix };
}

export default function JqlEditor({
  value,
  onChange,
  onRun,
  error,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  /** When omitted the Search button is hidden (embedded contexts like webhook
      filters). Passes the JQL to run when it isn't the current draft (e.g. the
      freshly translated query — running the draft would race the onChange). */
  onRun?: (jql?: string) => void;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [ctx, setCtx] = useState<Context>({ kind: 'none' });
  const [nlMode, setNlMode] = useState(false);
  const [nlText, setNlText] = useState('');

  const translate = useMutation({
    mutationFn: () => nlToJql(nlText),
    onSuccess: (r) => {
      onChange(r.jql);
      setNlMode(false);
      setNlText('');
      // Run the translated query immediately — pass it explicitly: the parent
      // draft state hasn't flushed yet, so a bare onRun() would commit the
      // stale pre-translate JQL to the URL.
      onRun?.(r.jql);
    },
  });

  const ctxFor = (v: string, pos: number) => detectContext(v.slice(0, pos));

  const { data: meta } = useQuery({
    queryKey: ['jql-autocompletedata'],
    queryFn: fetchJqlAutocompleteData,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  // Field name → operators + display label, from the live backend registry
  // (covers custom fields cf[…], sprint/component/version, etc.). Falls back
  // to a static core list while the request is in flight or if it fails.
  const fieldOps = useMemo(() => {
    const map: Record<string, string[]> = { default: FALLBACK_OPS.default };
    if (meta) {
      for (const f of meta.visibleFieldNames) {
        const ops = f.operators.map((o) => o.toUpperCase());
        map[f.value.toLowerCase()] = ops.length ? ops : FALLBACK_OPS.default;
      }
      return map;
    }
    return { ...FALLBACK_OPS };
  }, [meta]);

  const fieldSuggestions = useMemo(() => {
    if (!meta) return FALLBACK_FIELDS.map((f) => ({ value: f, displayName: f }));
    return meta.visibleFieldNames.map((f) => ({ value: f.value, displayName: f.displayName }));
  }, [meta]);

  const { data: valueSuggestions } = useQuery({
    queryKey: ['jql-suggest', ctx.kind === 'value' ? ctx.field : '', ctx.kind === 'value' ? ctx.prefix : ''],
    queryFn: () => fetchJqlSuggestions(ctx.kind === 'value' ? ctx.field : '', ctx.kind === 'value' ? ctx.prefix : ''),
    enabled: open && ctx.kind === 'value' && Boolean(ctx.field),
    staleTime: 30_000,
  });

  const suggestions: JqlSuggestion[] = useMemo(() => {
    if (ctx.kind === 'field') {
      const p = ctx.prefix.toLowerCase();
      return fieldSuggestions
        .filter(
          (f) =>
            f.value.toLowerCase().startsWith(p) ||
            f.displayName.toLowerCase().startsWith(p),
        )
        .slice(0, 10);
    }
    if (ctx.kind === 'operator') {
      const ops = fieldOps[ctx.field] ?? fieldOps.default;
      const p = ctx.prefix.toUpperCase();
      return ops
        .filter((o) => o.startsWith(p) || p === '')
        .map((o) => ({ value: o, displayName: o }));
    }
    if (ctx.kind === 'keyword') {
      const p = ctx.prefix.toUpperCase();
      const reserved = meta?.jqlReservedWords ?? CLAUSE_KEYWORDS;
      const kws = [...new Set([...CLAUSE_KEYWORDS, ...reserved.filter((w) => /^(AND|OR|NOT|ORDER|BY|ASC|DESC|EMPTY|NULL|IN|IS)$/i.test(w))])];
      return kws
        .filter((k) => k.toUpperCase().startsWith(p))
        .slice(0, 8)
        .map((k) => ({ value: k.toUpperCase(), displayName: k.toUpperCase() }));
    }
    if (ctx.kind === 'value') {
      const fromApi = (valueSuggestions?.results ?? []).slice(0, 10);
      // Suggest functions (currentUser(), startOfDay(), membersOf(…)) too —
      // they only apply to user/date/list fields, so offer them when the
      // prefix matches regardless of field and let the server validate.
      const p = ctx.prefix.replace(/^"/, '').toLowerCase();
      const fns = (meta?.visibleFunctionNames ?? [])
        .filter((f) => f.value.toLowerCase().startsWith(p))
        .slice(0, Math.max(0, 10 - fromApi.length))
        .map((f) => ({ value: f.value, displayName: f.displayName }));
      return [...fromApi, ...fns];
    }
    return [];
  }, [ctx, valueSuggestions, meta, fieldOps, fieldSuggestions]);

  useEffect(() => setHighlight(0), [suggestions.length]);

  const apply = (s: JqlSuggestion) => {
    const el = inputRef.current;
    const pos = el?.selectionStart ?? value.length;
    const c = ctxFor(value, pos);
    // Function placeholders arrive as `membersOf(…)` — insert `membersOf()`
    // and put the cursor between the parens ready for the argument.
    const fn = /^(.*)\((…|\.\.\.)\)$/.exec(s.value);
    const insert = fn ? `${fn[1]}()` : s.value + ' ';
    const before =
      c.kind === 'value' && 'replaceFrom' in c
        ? value.slice(0, c.replaceFrom)
        : value.slice(0, pos - (ctx.kind !== 'none' && 'prefix' in ctx ? ctx.prefix.length : 0));
    const next = before + insert + value.slice(pos);
    onChange(next);
    setOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const cursor = before.length + insert.length - (fn ? 1 : 0);
      el?.setSelectionRange(cursor, cursor);
    });
  };

  if (nlMode) {
    return (
      <div className="relative flex-1 min-w-64">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              value={nlText}
              autoFocus
              spellCheck={false}
              placeholder='Describe the issues you want — e.g. "my open bugs updated this week"'
              onChange={(e) => setNlText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !imeComposing(e) && nlText.trim() && !translate.isPending) translate.mutate();
                if (e.key === 'Escape') setNlMode(false);
              }}
              aria-label="Natural language search"
              className={`w-full h-8 px-3 rounded-[3px] border-2 text-sm outline-none ${
                translate.isError ? 'border-atl-r-300' : 'border-atl-b-300'
              }`}
            />
          </div>
          <button
            onClick={() => translate.mutate()}
            disabled={!nlText.trim() || translate.isPending}
            className="h-8 px-4 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white shrink-0 disabled:opacity-50"
          >
            {translate.isPending ? 'Translating…' : 'Translate'}
          </button>
          <button
            onClick={() => setNlMode(false)}
            className="h-8 px-2 text-sm text-atl-n-400 hover:text-atl-n-600 shrink-0"
            title="Back to JQL"
          >
            JQL
          </button>
        </div>
        {translate.isError && (
          <div className="mt-1.5 text-xs text-atl-r-400 font-medium">
            {translate.error instanceof Error ? translate.error.message : 'Translation failed'}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-w-64">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={value}
            autoFocus={autoFocus}
            spellCheck={false}
            placeholder="project = TF AND statusCategory != Done ORDER BY priority DESC"
            onChange={(e) => {
              onChange(e.target.value);
              const pos = e.target.selectionStart ?? e.target.value.length;
              setCtx(ctxFor(e.target.value, pos));
              setOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && open && suggestions.length) {
                e.preventDefault();
                setHighlight((h) => (h + 1) % suggestions.length);
                return;
              }
              if (e.key === 'ArrowUp' && open && suggestions.length) {
                e.preventDefault();
                setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === 'Tab' && open && suggestions.length) {
                e.preventDefault();
                apply(suggestions[highlight]);
                return;
              }
              if (e.key === 'Enter' && !imeComposing(e)) {
                if (open && suggestions.length && ctx.kind !== 'none') {
                  apply(suggestions[highlight]);
                } else {
                  onRun?.();
                }
                return;
              }
              if (e.key === 'Escape') {
                setOpen(false);
                return;
              }
            }}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
            aria-label="JQL query"
            className={`w-full h-8 px-3 rounded-[3px] border-2 text-sm font-mono outline-none ${
              error ? 'border-atl-r-300 focus:border-atl-r-400' : 'border-atl-n-40 focus:border-atl-b-300'
            }`}
          />
          {open && suggestions.length > 0 && (
            <div className="absolute top-9 left-0 right-0 z-40 bg-atl-paper border border-atl-n-30 rounded shadow-lg max-h-64 overflow-auto">
              {suggestions.map((s, i) => (
                <button
                  key={`${s.value}-${i}`}
                  className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between ${
                    i === highlight ? 'bg-atl-b-50 text-atl-b-400' : 'text-atl-n-700 hover:bg-atl-n-10'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    apply(s);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  <span className="font-mono">{s.value}</span>
                  {s.displayName !== s.value && (
                    <span className="text-xs text-atl-n-200 truncate ml-3" title={s.displayName}>{s.displayName}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        {onRun && (
          <button
            onClick={() => onRun()}
            className="h-8 px-4 rounded-[3px] bg-atl-b-300 hover:bg-atl-b-400 text-sm font-medium text-white shrink-0"
          >
            Search
          </button>
        )}
        <button
          onClick={() => setNlMode(true)}
          title="Describe what you want in plain language — AI builds the JQL"
          className="h-8 px-2.5 rounded-[3px] border border-atl-n-40 hover:bg-atl-n-10 flex items-center gap-1.5 text-atl-b-300 shrink-0 text-sm font-medium"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0l1.8 4.6L14 5.2l-4.2 3.1L11.5 13 8 10.4 4.5 13l1.7-4.7L2 5.2l4.2-.6z" />
          </svg>
          Ask AI
        </button>
      </div>
      {error && <div className="mt-1.5 text-xs text-atl-r-400 font-medium">{error}</div>}
    </div>
  );
}

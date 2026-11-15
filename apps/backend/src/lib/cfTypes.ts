/**
 * Custom-field type registry (D19): a CF type is a registry entry — zod input
 * schema, storage↔Jira (de)serializers, searcher → JQL operators, update ops.
 * Adding a type = adding an entry here + a renderer on the frontend.
 */
import { z } from 'zod';
import { JiraApiError, jiraError } from './errors.js';
import { isAllowedExternalUrl, ALLOWED_URL_SCHEMES_LABEL } from './urls.js';

export interface CfOption {
  id: string;
  value: string;
  parentId: string | null;
  disabled: boolean;
  position: number;
}

export interface CfUserLite {
  id: string;
  displayName: string;
  emailAddress: string;
  active: boolean;
  avatarUrl?: string | null;
}

export type SearcherType = 'text' | 'exact' | 'number' | 'date' | 'user' | 'none';

interface TypeDef {
  /** Jira `schema.custom` suffix + how the value serializes in issue fields. */
  jiraType: string;
  searcher: SearcherType;
  /** ops allowed in `update` blocks (besides implicit `set`). */
  updateOps: ('add' | 'remove' | 'set')[];
  /** JQL operators this type supports. */
  jqlOps: string[];
  /** client input (Jira shape) → storage JSON. `opts` = context options. */
  parse: (input: unknown, opts: CfOption[], fieldLabel: string) => unknown;
  /** storage JSON + option lookup → Jira shape for issue responses. */
  serialize: (stored: unknown, opts: CfOption[], user?: CfUserLite | null) => unknown;
  /** storage JSON → changelog toString (human-readable). */
  toDisplay: (stored: unknown, opts: CfOption[], user?: CfUserLite | null) => string | null;
}

const bad = (field: string, msg: string, allowed?: string[]): never => {
  throw new JiraApiError(
    400,
    jiraError(allowed?.length ? [`${msg} Allowed values: ${allowed.join(', ')}`] : [msg], { [field]: msg })
  );
};

const textSchema = z.string().max(32767);
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const datetimeRe = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const urlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(isAllowedExternalUrl, { message: `URL must use an allowed scheme (${ALLOWED_URL_SCHEMES_LABEL}).` });

function optionByIdOrValue(input: unknown, opts: CfOption[], field: string): CfOption {
  const top = opts.filter((o) => !o.parentId && !o.disabled);
  if (typeof input === 'object' && input !== null && 'id' in (input as Record<string, unknown>)) {
    const id = String((input as { id: unknown }).id);
    const hit = opts.find((o) => o.id === id);
    if (hit) return hit;
  }
  const raw =
    typeof input === 'object' && input !== null && 'value' in (input as Record<string, unknown>)
      ? String((input as { value: unknown }).value)
      : String(input);
  const hit = top.find((o) => o.value.toLowerCase() === raw.toLowerCase());
  if (hit) return hit;
  return bad(
    field,
    `Option value '${raw}' is not valid for this field.`,
    top.map((o) => o.value)
  );
}

/** Stored option ref — denormalized {id, value} so reads don't join. */
function optionRef(opt: CfOption) {
  return { id: opt.id, value: opt.value };
}
/** Refresh a stored option ref's `value` from current options (rename-safe). */
function refreshRef(stored: { id: string; value: string }, opts: CfOption[]) {
  const fresh = opts.find((o) => o.id === stored.id);
  return fresh ? optionRef(fresh) : stored;
}

const checklistSchema = z.object({
  items: z.array(z.object({ text: z.string().min(1).max(500), done: z.boolean() })).max(200),
});

const DEFS: Record<string, TypeDef> = {
  text: {
    jiraType: 'string',
    searcher: 'text',
    updateOps: ['set'],
    jqlOps: ['=', '!=', '~', '!~', 'IS', 'IS NOT'],
    parse: (i, _o, _f) => (i === null ? null : textSchema.parse(i)),
    serialize: (s) => s ?? null,
    toDisplay: (s) => (s === null || s === undefined ? null : String(s)),
  },
  textarea: {
    jiraType: 'string',
    searcher: 'text',
    updateOps: ['set'],
    jqlOps: ['=', '!=', '~', '!~', 'IS', 'IS NOT'],
    parse: (i, _o, _f) => (i === null ? null : textSchema.parse(i)),
    serialize: (s) => s ?? null,
    toDisplay: (s) => (s === null || s === undefined ? null : String(s)),
  },
  url: {
    jiraType: 'string',
    searcher: 'text',
    updateOps: ['set'],
    jqlOps: ['=', '!=', '~', '!~', 'IS', 'IS NOT'],
    parse: (i, _o, f) => {
      if (i === null) return null;
      const r = urlSchema.safeParse(i);
      if (!r.success) return bad(f, `'${String(i)}' is not a valid URL.`);
      return r.data;
    },
    serialize: (s) => s ?? null,
    toDisplay: (s) => (s === null || s === undefined ? null : String(s)),
  },
  number: {
    jiraType: 'number',
    searcher: 'number',
    updateOps: ['set'],
    jqlOps: ['=', '!=', '>', '>=', '<', '<=', 'IS', 'IS NOT', 'IN', 'NOT IN'],
    parse: (i, _o, f) => {
      if (i === null) return null;
      const n =
        typeof i === 'object' && i !== null && 'value' in (i as object)
          ? Number((i as { value: unknown }).value)
          : Number(i);
      if (!Number.isFinite(n)) return bad(f, `'${String(i)}' is not a valid number.`);
      return n;
    },
    serialize: (s) => (s === null || s === undefined ? null : Number(s)),
    toDisplay: (s) => (s === null || s === undefined ? null : String(s)),
  },
  date: {
    jiraType: 'date',
    searcher: 'date',
    updateOps: ['set'],
    jqlOps: ['=', '!=', '>', '>=', '<', '<=', 'IS', 'IS NOT'],
    parse: (i, _o, f) => {
      if (i === null) return null;
      const s = String(i);
      if (!dateRe.test(s)) return bad(f, `'${s}' is not a valid date (expected YYYY-MM-DD).`);
      return s;
    },
    serialize: (s) => s ?? null,
    toDisplay: (s) => (s === null || s === undefined ? null : String(s)),
  },
  datetime: {
    jiraType: 'datetime',
    searcher: 'date',
    updateOps: ['set'],
    jqlOps: ['=', '!=', '>', '>=', '<', '<=', 'IS', 'IS NOT'],
    parse: (i, _o, f) => {
      if (i === null) return null;
      const s = String(i);
      const t = Date.parse(s);
      if (!datetimeRe.test(s) || Number.isNaN(t)) {
        return bad(f, `'${s}' is not a valid datetime (ISO 8601).`);
      }
      return new Date(t).toISOString();
    },
    serialize: (s) => s ?? null,
    toDisplay: (s) => (s === null || s === undefined ? null : String(s)),
  },
  select: {
    jiraType: 'option',
    searcher: 'exact',
    updateOps: ['set'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    parse: (i, o, f) => (i === null ? null : optionRef(optionByIdOrValue(i, o, f))),
    serialize: (s, opts) => {
      if (s === null || s === undefined) return null;
      const st = s as { id: string; value: string };
      const r = refreshRef(st, opts);
      return { id: r.id, value: r.value, self: null };
    },
    toDisplay: (s) => (s === null || s === undefined ? null : String((s as { value: string }).value)),
  },
  radio: {
    jiraType: 'option',
    searcher: 'exact',
    updateOps: ['set'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    parse: (i, o, f) => (i === null ? null : optionRef(optionByIdOrValue(i, o, f))),
    serialize: (s, opts) => {
      if (s === null || s === undefined) return null;
      const st = s as { id: string; value: string };
      const r = refreshRef(st, opts);
      return { id: r.id, value: r.value, self: null };
    },
    toDisplay: (s) => (s === null || s === undefined ? null : String((s as { value: string }).value)),
  },
  multiselect: {
    jiraType: 'array',
    searcher: 'exact',
    updateOps: ['set', 'add', 'remove'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    parse: (i, o, f) => {
      if (i === null) return null;
      const arr = Array.isArray(i) ? i : [i];
      return arr.map((v) => optionRef(optionByIdOrValue(v, o, f)));
    },
    serialize: (s, opts) =>
      (Array.isArray(s) ? s : []).map((raw) => {
        const r = refreshRef(raw as { id: string; value: string }, opts);
        return { id: r.id, value: r.value, self: null };
      }),
    toDisplay: (s) =>
      !Array.isArray(s) || !s.length ? null : s.map((r) => String((r as { value: string }).value)).join(', '),
  },
  checkbox: {
    jiraType: 'array',
    searcher: 'exact',
    updateOps: ['set', 'add', 'remove'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    parse: (i, o, f) => {
      if (i === null) return null;
      const arr = Array.isArray(i) ? i : [i];
      return arr.map((v) => optionRef(optionByIdOrValue(v, o, f)));
    },
    serialize: (s, opts) =>
      (Array.isArray(s) ? s : []).map((raw) => {
        const r = refreshRef(raw as { id: string; value: string }, opts);
        return { id: r.id, value: r.value, self: null };
      }),
    toDisplay: (s) =>
      !Array.isArray(s) || !s.length ? null : s.map((r) => String((r as { value: string }).value)).join(', '),
  },
  cascading: {
    jiraType: 'option',
    searcher: 'exact',
    updateOps: ['set'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    parse: (i, o, f) => {
      if (i === null) return null;
      const obj = i as { id?: unknown; value?: unknown; child?: { id?: unknown; value?: unknown } };
      const parent = optionByIdOrValue(obj?.id ?? obj?.value ?? i, o, f);
      if (parent.parentId) return bad(f, 'Cascading values must select a parent option first.');
      if (obj?.child === undefined || obj?.child === null) {
        return { ...optionRef(parent), child: null };
      }
      const children = o.filter((c) => c.parentId === parent.id && !c.disabled);
      const childObj = obj.child as { id?: unknown; value?: unknown };
      const childRaw = childObj.id ?? childObj.value;
      const child =
        children.find((c) => c.id === String(childRaw)) ??
        children.find((c) => c.value.toLowerCase() === String(childObj.value ?? childRaw).toLowerCase());
      if (!child) {
        return bad(
          f,
          `'${String(obj.child.value ?? childRaw)}' is not a valid child of '${parent.value}'.`,
          children.map((c) => c.value)
        );
      }
      return { ...optionRef(parent), child: optionRef(child) };
    },
    serialize: (s, opts) => {
      if (s === null || s === undefined || typeof s !== 'object') return null;
      const st = s as { id: string; value: string; child?: { id: string; value: string } | null };
      const p = refreshRef(st, opts);
      const c = st.child ? refreshRef(st.child, opts) : null;
      return { id: p.id, value: p.value, ...(c ? { child: { id: c.id, value: c.value } } : {}) };
    },
    toDisplay: (s) => {
      if (!s || typeof s !== 'object') return null;
      const st = s as { value?: string; child?: { value?: string } | null };
      return [st.value, st.child?.value].filter(Boolean).join(' - ');
    },
  },
  user: {
    jiraType: 'user',
    searcher: 'user',
    updateOps: ['set'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    // accountId/name resolution happens in the service (needs prisma); here we
    // just normalize the input to a user ref string. Storage is the
    // denormalized Jira user shape built by validateInput.
    parse: (i) => {
      if (i === null) return null;
      if (typeof i === 'object' && i !== null) {
        const o = i as { accountId?: unknown; name?: unknown; id?: unknown };
        return String(o.accountId ?? o.name ?? o.id ?? '');
      }
      return String(i);
    },
    serialize: (s) => s ?? null,
    toDisplay: (s) => {
      if (!s || typeof s !== 'object') return s == null ? null : String(s);
      return String((s as { displayName?: unknown }).displayName ?? null);
    },
  },
  group: {
    jiraType: 'group',
    searcher: 'text',
    updateOps: ['set'],
    jqlOps: ['=', '!=', 'IS', 'IS NOT'],
    // Group existence is checked in the service (needs prisma); storage is the
    // group name (stable across id changes, importer-friendly).
    parse: (i) => {
      if (i === null) return null;
      if (typeof i === 'object' && i !== null) {
        const o = i as { name?: unknown };
        return o.name ? String(o.name) : '';
      }
      return String(i);
    },
    serialize: (s) => (s ? { name: s } : null),
    toDisplay: (s) => (s == null ? null : String(s)),
  },
  // Sprint 019 — entity pickers validate against project components/versions
  // in the service (needs prisma); storage is the denormalized {id,name} ref.
  version_picker: {
    jiraType: 'version',
    searcher: 'exact',
    updateOps: ['set'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    parse: (i) => {
      if (i === null) return null;
      if (typeof i === 'object' && i !== null) {
        const o = i as { id?: unknown; name?: unknown };
        return String(o.id ?? o.name ?? '');
      }
      return String(i);
    },
    serialize: (s) => s ?? null,
    toDisplay: (s) => (s == null ? null : String((s as { name?: unknown }).name ?? s)),
  },
  component_picker: {
    jiraType: 'component',
    searcher: 'exact',
    updateOps: ['set'],
    jqlOps: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    parse: (i) => {
      if (i === null) return null;
      if (typeof i === 'object' && i !== null) {
        const o = i as { id?: unknown; name?: unknown };
        return String(o.id ?? o.name ?? '');
      }
      return String(i);
    },
    serialize: (s) => s ?? null,
    toDisplay: (s) => (s == null ? null : String((s as { name?: unknown }).name ?? s)),
  },
  checklist: {
    jiraType: 'checklist',
    searcher: 'none',
    updateOps: ['set'],
    jqlOps: [],
    parse: (i, _o, f) => {
      if (i === null) return null;
      const r = checklistSchema.safeParse(i);
      if (!r.success) return bad(f, 'Checklist must be {items:[{text,done}]}.');
      return r.data;
    },
    serialize: (s) => s ?? null,
    toDisplay: (s) => {
      const items = (s as { items?: { text: string; done: boolean }[] } | null)?.items;
      if (!items?.length) return null;
      return `${items.filter((i) => i.done).length}/${items.length} done`;
    },
  },
};

export function cfTypeDef(type: string): TypeDef {
  const def = DEFS[type];
  if (!def) throw new JiraApiError(400, jiraError([`Unknown custom field type '${type}'.`]));
  return def;
}

export const CF_TYPES = Object.keys(DEFS);

export function searcherFor(type: string): SearcherType {
  return cfTypeDef(type).searcher;
}

/** JSON-schema-ish `schema` object Jira puts on /field + createmeta entries. */
export function cfSchema(cf: { id: string; type: string }): Record<string, unknown> {
  const def = cfTypeDef(cf.type);
  const base = `com.trackforge.customfields:${cf.type}`;
  if (def.jiraType === 'array') {
    return { type: 'array', items: 'option', custom: base, customId: Number(cf.id.split('_')[1]) };
  }
  return { type: def.jiraType, custom: base, customId: Number(cf.id.split('_')[1]) };
}

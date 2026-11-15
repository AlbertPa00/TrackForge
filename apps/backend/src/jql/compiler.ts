// JQL compiler — AST → Prisma where/orderBy with DB-backed value resolution.
// Text (~) clauses compile to a raw candidate-ID prequery over the FTS vectors.

import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { resolveUserRef as userResolveRef } from '../services/userService.js';
import { Prisma } from '../lib/pc.js';
import type { JqlClause, JqlClauseCondition, JqlOperand, JqlListOperand, JqlOperator, JqlQuery } from './ast.js';
import { DATE_FUNCTIONS, SPRINT_FUNCTIONS, VERSION_FUNCTIONS, lookupField } from './fields.js';
import { jqlCtxGet, jqlCtxSet } from './ctxCache.js';
import type { FieldWithContexts } from '../services/customFieldService.js';
import {
  evalDateFunction,
  evalRelativeDate,
  parseAbsoluteDate,
  tzOffsetMs,
  zonedParts,
  type DateFunction,
} from './dates.js';
import { getTimeTrackingConfig } from '../services/settingsService.js';
import { parseDuration, type TimeTrackingConfig } from '../lib/duration.js';

export class JqlFieldError extends Error {
  field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
  }
}

type Where = Record<string, unknown>;
type OrderBy = Record<string, unknown>;

export interface CompiledSearch {
  where: Where;
  orderBy: OrderBy[];
  /**
   * Present when any ORDER BY item is a custom field — the full ordering spec
   * (CF + column items in written order). Prisma can't ORDER BY a related JSONB
   * value, so searchService memory-sorts the bounded match set.
   */
  sortSpec?: SortSpecItem[];
}

export type SortSpecItem =
  | { kind: 'cf'; field: FieldWithContexts; dir: 'asc' | 'desc' }
  | { kind: 'col'; col: string; dir: 'asc' | 'desc' };

// ---------- value resolution context (cached lookups) ----------

interface Ctx {
  actor: Actor;
  now: Date;
  tz: string;
  statuses: Map<string, string>;
  priorities: Map<string, string>;
  issueTypes: Map<string, string>;
  resolutions: Map<string, string>;
  projects: Map<string, string>;
  issueKeys: Map<string, { projectKey: string; issueNumber: number; id: string } | null>;
  users: Map<string, string | null>;
  /** 032 US3 — filter-subquery cycle guard (filter ids in the resolution stack) */
  filterStack: Set<string>;
  cfDefs?: FieldWithContexts[];
  ttCfg?: TimeTrackingConfig;
}

async function buildCtx(actor: Actor): Promise<Ctx> {
  let snap = jqlCtxGet();
  if (!snap) {
    const [statuses, priorities, issueTypes, resolutions, projects] = await Promise.all([
      prisma.status.findMany({ select: { id: true, name: true } }),
      prisma.priority.findMany({ select: { id: true, name: true } }),
      prisma.issueType.findMany({ select: { id: true, name: true } }),
      prisma.resolution.findMany({ select: { id: true, name: true } }),
      prisma.project.findMany({ select: { id: true, key: true } }),
    ]);
    snap = {
      statuses: new Map(statuses.map((s) => [s.name.toLowerCase(), s.id])),
      priorities: new Map(priorities.map((p) => [p.name.toLowerCase(), p.id])),
      issueTypes: new Map(issueTypes.map((t) => [t.name.toLowerCase(), t.id])),
      resolutions: new Map(resolutions.map((r) => [r.name.toLowerCase(), r.id])),
      projects: new Map(projects.map((p) => [p.key.toUpperCase(), p.id])),
    };
    jqlCtxSet(snap);
  }
  const tz = actor.user.timeZone ?? 'UTC';
  // validate the configured zone once — fall back to UTC on garbage values
  tzOffsetMs(tz, new Date());
  return {
    actor,
    now: new Date(),
    tz,
    statuses: snap.statuses,
    priorities: snap.priorities,
    issueTypes: snap.issueTypes,
    resolutions: snap.resolutions,
    projects: snap.projects,
    issueKeys: new Map(),
    users: new Map(),
    filterStack: new Set(),
  };
}

/** Sprint 024 — JQL duration operand: "2h"/"1w 3d" via parseDuration, bare
 *  number = raw seconds (Jira parity). */
async function resolveDurationOperand(ctx: Ctx, op: JqlOperand, field: string): Promise<number> {
  if (op.kind === 'empty') throw valueError('EMPTY', field);
  if (op.kind === 'number') {
    const n = Number(op.raw);
    if (!Number.isFinite(n) || n < 0) throw valueError(op.raw, field);
    return n;
  }
  const raw = operandText(op, field);
  ctx.ttCfg ??= await getTimeTrackingConfig();
  const sec = parseDuration(raw, ctx.ttCfg);
  if (sec === null) {
    throw new JqlFieldError(
      `'${raw}' is not a valid duration for the field '${field}'. Use e.g. "2h", "1w 3d" or seconds.`,
      field
    );
  }
  return sec;
}

/** Aggregate prequery: issue ids whose summed worklog seconds satisfy `op`. */
async function timeSpentIssueIds(op: JqlOperator, secs: number[]): Promise<string[]> {
  if (op === 'IN' || op === '=' || op === '!=' || op === 'NOT IN') {
    const cmp = op === '!=' || op === 'NOT IN' ? 'NOT IN' : 'IN';
    return prisma
      .$queryRaw<
        { id: string }[]
      >(Prisma.sql`SELECT "issueId" AS id FROM "Worklog" GROUP BY "issueId" HAVING SUM("timeSpentSec") ${Prisma.raw(cmp)} (${Prisma.join(secs)})`)
      .then((r) => r.map((x) => x.id));
  }
  const cmp = op === '>' ? '>' : op === '>=' ? '>=' : op === '<' ? '<' : '<=';
  return prisma
    .$queryRaw<
      { id: string }[]
    >(Prisma.sql`SELECT "issueId" AS id FROM "Worklog" GROUP BY "issueId" HAVING SUM("timeSpentSec") ${Prisma.raw(cmp)} ${secs[0]}`)
    .then((r) => r.map((x) => x.id));
}

/** workratio prequery: spent*100/originalEstimate — needs an estimate column. */
async function workratioIssueIds(op: JqlOperator, ratios: number[]): Promise<string[]> {
  const base = Prisma.sql`FROM "Issue" i
    LEFT JOIN (SELECT "issueId", SUM("timeSpentSec") AS spent FROM "Worklog" GROUP BY "issueId") w
      ON w."issueId" = i.id
    WHERE i."originalEstimateSec" IS NOT NULL AND i."originalEstimateSec" > 0`;
  if (op === 'IN' || op === '=' || op === '!=' || op === 'NOT IN') {
    const cmp = op === '!=' || op === 'NOT IN' ? 'NOT IN' : 'IN';
    return prisma
      .$queryRaw<
        { id: string }[]
      >(Prisma.sql`SELECT i.id ${base} AND (COALESCE(w.spent,0)*100.0/i."originalEstimateSec") ${Prisma.raw(cmp)} (${Prisma.join(ratios)})`)
      .then((r) => r.map((x) => x.id));
  }
  const cmp = op === '>' ? '>' : op === '>=' ? '>=' : op === '<' ? '<' : '<=';
  return prisma
    .$queryRaw<
      { id: string }[]
    >(Prisma.sql`SELECT i.id ${base} AND (COALESCE(w.spent,0)*100.0/i."originalEstimateSec") ${Prisma.raw(cmp)} ${ratios[0]}`)
    .then((r) => r.map((x) => x.id));
}

/** Column compare for nullable int columns (originalEstimateSec/remainingEstimateSec). */
function secCompare(col: string, op: JqlOperator, secs: number[], listMode: boolean, negated: boolean): Where {
  if (op === '=' || op === 'IN' || op === '!=' || op === 'NOT IN') {
    return nullableEqIn(col, secs, listMode, negated);
  }
  const cmp =
    op === '>' ? { gt: secs[0] } : op === '>=' ? { gte: secs[0] } : op === '<' ? { lt: secs[0] } : { lte: secs[0] };
  return { [col]: cmp };
}

function valueError(raw: string, fieldName: string): JqlFieldError {
  return new JqlFieldError(`The value '${raw}' does not exist for the field '${fieldName}'.`, fieldName);
}

async function resolveUserRef(ctx: Ctx, raw: string): Promise<string | null> {
  const key = raw.toLowerCase();
  if (ctx.users.has(key)) return ctx.users.get(key)!;
  const user = await userResolveRef(raw);
  ctx.users.set(key, user?.id ?? null);
  return user?.id ?? null;
}

const ISSUE_KEY_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

async function resolveIssueKey(
  ctx: Ctx,
  raw: string
): Promise<{ projectKey: string; issueNumber: number; id: string } | null> {
  const m = ISSUE_KEY_RE.exec(raw.trim());
  if (!m) return null;
  const projectKey = m[1].toUpperCase();
  const issueNumber = Number(m[2]);
  const cacheKey = `${projectKey}-${issueNumber}`;
  if (ctx.issueKeys.has(cacheKey)) return ctx.issueKeys.get(cacheKey)!;
  const projectId = ctx.projects.get(projectKey);
  if (!projectId) {
    ctx.issueKeys.set(cacheKey, null);
    return null;
  }
  const issue = await prisma.issue.findUnique({
    where: { projectId_issueNumber: { projectId, issueNumber } },
    select: { id: true },
  });
  const resolved = issue ? { projectKey, issueNumber, id: issue.id } : null;
  ctx.issueKeys.set(cacheKey, resolved);
  return resolved;
}

// ---------- FTS prequery ----------

async function ftsIssueIds(scope: 'text' | 'summary' | 'description' | 'comment', query: string) {
  const q = query.trim();
  if (!q) return [] as string[];
  if (scope === 'comment') {
    // 065 audit C2 — `comment ~ "word"` must not confirm the contents of a
    // visibility-restricted comment: exclude restricted rows from the FTS
    // prequery entirely (the issue itself still matches on unrestricted text).
    return prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT "issueId" AS id FROM "Comment"
      WHERE "searchVector" @@ plainto_tsquery('english', ${q})
        AND ("visibility" IS NULL OR "visibility" = 'null'::jsonb)`.then((r) => r.map((x) => x.id));
  }
  if (scope === 'text') {
    return prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Issue" WHERE "searchVector" @@ plainto_tsquery('english', ${q})
      UNION
      SELECT "issueId" AS id FROM "Comment"
      WHERE "searchVector" @@ plainto_tsquery('english', ${q})
        AND ("visibility" IS NULL OR "visibility" = 'null'::jsonb)`.then((r) => r.map((x) => x.id));
  }
  const col = scope === 'summary' ? 'summary' : 'description';
  return prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Issue"
    WHERE to_tsvector('english', coalesce(${Prisma.raw(`"${col}"`)}, '')) @@ plainto_tsquery('english', ${q})`.then(
    (r) => r.map((x) => x.id)
  );
}

// ---------- operand helpers ----------

interface DateOperand {
  start: Date;
  end: Date;
  /** true when the value represents a calendar period (day/week/month) */
  isRange: boolean;
}

async function resolveDateOperand(ctx: Ctx, op: JqlOperand, fieldName: string): Promise<DateOperand> {
  if (op.kind === 'relative') {
    const t = evalRelativeDate(op, ctx.now);
    if (op.unit === 'd' || op.unit === 'w' || op.unit === 'M' || op.unit === 'y') {
      // Jira rounds day+ relative dates to day boundaries for `=`
      const start = evalDateFunction('startofday', undefined, t, ctx.tz);
      const end = evalDateFunction('endofday', undefined, t, ctx.tz);
      return { start, end, isRange: true };
    }
    return { start: t, end: new Date(t.getTime() + 1), isRange: false };
  }
  if (op.kind === 'function') {
    if (!DATE_FUNCTIONS.has(op.name)) {
      // 032: session-derived login instants
      if (op.name === 'currentlogin' || op.name === 'previouslogin' || op.name === 'lastlogin') {
        const { evalLoginFunction } = await import('./functions.js');
        const t = await evalLoginFunction(ctx, op, fieldName);
        // no recorded login (token-only agent) → never-match sentinel
        return { start: t ?? new Date(0), end: t ? new Date(t.getTime() + 1) : new Date(1), isRange: false };
      }
      throw new JqlFieldError(`Function '${op.name}' does not exist for the field '${fieldName}'.`, fieldName);
    }
    const arg = op.args.length ? Number(op.args[0]) : undefined;
    if (arg !== undefined && !Number.isInteger(arg)) {
      throw new JqlFieldError(`Function '${op.name}' expects an integer argument.`, fieldName);
    }
    const t = evalDateFunction(op.name as DateFunction, arg, ctx.now, ctx.tz);
    // startOf*/endOf* functions span the period for `=` comparisons
    const spanMs =
      op.name === 'startofday' || op.name === 'endofday'
        ? 86_400_000
        : op.name === 'startofweek' || op.name === 'endofweek'
          ? 604_800_000
          : op.name === 'startofmonth' || op.name === 'endofmonth'
            ? null // variable — handled below
            : 60_000;
    if (spanMs === null) {
      // month span: from startOfMonth to startOfNextMonth
      const start = evalDateFunction('startofmonth', arg, ctx.now, ctx.tz);
      const end = evalDateFunction('startofmonth', (arg ?? 0) + 1, ctx.now, ctx.tz);
      return { start, end, isRange: true };
    }
    if (op.name.startsWith('startof')) {
      return { start: t, end: new Date(t.getTime() + spanMs), isRange: spanMs >= 86_400_000 };
    }
    if (op.name.startsWith('endof')) {
      return {
        start: new Date(t.getTime() - spanMs + 1),
        end: new Date(t.getTime() + 1),
        isRange: spanMs >= 86_400_000,
      };
    }
    return { start: t, end: new Date(t.getTime() + 1), isRange: false };
  }
  const raw = op.kind === 'string' ? op.value : op.kind === 'number' ? op.raw : '';
  if (!raw) {
    throw new JqlFieldError(`EMPTY is not a valid date for the field '${fieldName}'.`, fieldName);
  }
  const parsed = parseAbsoluteDate(raw, ctx.tz);
  if (!parsed) {
    throw new JqlFieldError(
      `'${raw}' is not a valid date for the field '${fieldName}'. Expected formats: "YYYY-MM-DD", "YYYY-MM-DD HH:mm", or a relative date like -7d.`,
      fieldName
    );
  }
  return { start: parsed.start, end: parsed.end, isRange: parsed.precision === 'day' };
}

// ---------- clause compiler ----------

function storyPointsWhere(op: JqlOperator, items: JqlOperand[], listMode: boolean, negated: boolean): Where {
  const field = 'storypoints';
  const nums = items.map((i) => {
    if (i.kind === 'empty') return null;
    const n = Number(operandText(i, field));
    if (!Number.isFinite(n)) throw valueError(operandText(i, field), field);
    return n;
  });
  if (op === '=' || op === 'IN') {
    return nullableEqIn('storyPoints', nums, listMode, negated) as Where;
  }
  if (op === '!=' || op === 'NOT IN') {
    const nonNull = nums.filter((n): n is number => n !== null);
    const clause: Where = nonNull.length ? { storyPoints: { notIn: nonNull } } : {};
    return { AND: [{ storyPoints: { not: null } }, clause] };
  }
  const n = nums[0];
  if (n === null || n === undefined) throw valueError('EMPTY', field);
  const cmp = op === '>' ? { gt: n } : op === '>=' ? { gte: n } : op === '<' ? { lt: n } : { lte: n };
  return { storyPoints: cmp };
}

/** Resolve `cf[NNNNN]` / `customfield_NNNNN` / quoted name / alias → field def. */
async function resolveCfField(ctx: Ctx, raw: string): Promise<FieldWithContexts> {
  if (!ctx.cfDefs) {
    const snap = jqlCtxGet();
    if (snap?.cfDefs) {
      ctx.cfDefs = snap.cfDefs as FieldWithContexts[];
    } else {
      const { listFields } = await import('../services/customFieldService.js');
      ctx.cfDefs = await listFields();
      if (snap) snap.cfDefs = ctx.cfDefs;
    }
  }
  const m = /^cf\[(\d+)\]$/i.exec(raw) ?? /^customfield_(\d+)$/i.exec(raw);
  const key = (m ? `customfield_${m[1]}` : raw).toLowerCase();
  const field = ctx.cfDefs.find((f) => f.id.toLowerCase() === key || f.alias === key || f.name.toLowerCase() === key);
  if (!field || !field.active) {
    throw new JqlFieldError(`Field '${raw}' does not exist or you do not have permission to view it.`, raw);
  }
  if (field.searcherType === 'none') {
    throw new JqlFieldError(`Field '${field.name}' does not support searching.`, field.name);
  }
  return field;
}

/** Case-insensitive contains prequery over JSONB text (Jira `~` semantics). */
async function cfTextIssueIds(fieldId: string, term: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "issueId" AS id FROM "CustomFieldValue"
    WHERE "fieldId" = ${fieldId} AND "value"::text ILIKE ${`%${term}%`}`;
  return rows.map((r) => r.id);
}

/** cf[NNNNN] / "Field Name" clause → Prisma where over CustomFieldValue. */
async function compileCfCondition(ctx: Ctx, c: JqlClauseCondition): Promise<Where> {
  const field = await resolveCfField(ctx, c.field.raw);
  const op = c.operator;

  // System-managed alias backed by a real column shares the column compiler.
  if (field.alias === 'story_points') {
    if (op === 'IS' || op === 'IS NOT') {
      return { storyPoints: op === 'IS' ? null : { not: null } };
    }
    const items = c.operand.kind === 'list' ? (c.operand as JqlListOperand).items : [c.operand as JqlOperand];
    const listMode = c.operand.kind === 'list' || op === 'IN' || op === 'NOT IN';
    return storyPointsWhere(op, items, listMode, op === '!=' || op === 'NOT IN');
  }

  const fid = field.id;
  if (op === 'IS' || op === 'IS NOT') {
    return op === 'IS' ? { cfValues: { none: { fieldId: fid } } } : { cfValues: { some: { fieldId: fid } } };
  }

  const items = c.operand.kind === 'list' ? (c.operand as JqlListOperand).items : [c.operand as JqlOperand];
  const negated = op === '!=' || op === 'NOT IN';
  const hasEmpty = items.some((i) => i.kind === 'empty');
  const vals = items.filter((i) => i.kind !== 'empty');
  const some = (match: Where) => ({ cfValues: { some: { fieldId: fid, ...match } } });
  const emptyClause: Where = { cfValues: { none: { fieldId: fid } } };

  // positive match: OR over operand values
  const positives: Where[] = [];

  switch (field.searcherType) {
    case 'exact': {
      const { allOptions } = await import('../services/customFieldService.js');
      const opts = allOptions(field);
      const ids = vals.map((i) => {
        const raw = operandText(i, field.name);
        const opt = opts.find((o) => o.id === raw) ?? opts.find((o) => o.value.toLowerCase() === raw.toLowerCase());
        if (!opt) throw valueError(raw, field.name);
        return opt.id;
      });
      const multi = field.type === 'multiselect' || field.type === 'checkbox';
      const cascading = field.type === 'cascading';
      for (const id of ids) {
        if (multi) positives.push(some({ value: { array_contains: [{ id }] } }));
        else if (cascading)
          positives.push(
            some({
              OR: [{ value: { path: ['id'], equals: id } }, { value: { path: ['child', 'id'], equals: id } }],
            })
          );
        else positives.push(some({ value: { path: ['id'], equals: id } }));
      }
      break;
    }
    case 'text': {
      if (op === '~' || op === '!~') {
        const sets = await Promise.all(vals.map((i) => cfTextIssueIds(fid, operandText(i, field.name))));
        const positive: Where =
          sets.length === 1 ? { id: { in: sets[0] } } : { OR: sets.map((s) => ({ id: { in: s } })) };
        return op === '~' ? positive : { id: { notIn: sets.flat() } };
      }
      for (const i of vals) {
        positives.push(some({ value: { equals: operandText(i, field.name) } }));
      }
      break;
    }
    case 'number': {
      const nums = vals.map((i) => {
        const n = Number(operandText(i, field.name));
        if (!Number.isFinite(n)) throw valueError(operandText(i, field.name), field.name);
        return n;
      });
      if (op === '=' || op === 'IN' || op === '!=' || op === 'NOT IN') {
        for (const n of nums) positives.push(some({ value: { equals: n } }));
      } else {
        const cmp = op === '>' ? 'gt' : op === '>=' ? 'gte' : op === '<' ? 'lt' : 'lte';
        positives.push(some({ value: { [cmp]: nums[0] } }));
      }
      break;
    }
    case 'date': {
      // 057 US4 — day-precision operands are instants aligned to ctx.tz day
      // boundaries; slicing UTC shifts the day for non-UTC zones. Format the
      // wall-clock day in ctx.tz instead.
      const fmt = (d: Date) => {
        if (field.type !== 'date') return d.toISOString();
        const { year, month, day } = zonedParts(d, ctx.tz);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${year}-${p(month + 1)}-${p(day)}`;
      };
      const ranges = await Promise.all(vals.map((i) => resolveDateOperand(ctx, i, field.name)));
      for (const r of ranges) {
        const cmp =
          op === '='
            ? { AND: [some({ value: { gte: fmt(r.start) } }), some({ value: { lt: fmt(r.end) } })] }
            : op === '!='
              ? some({ OR: [{ value: { lt: fmt(r.start) } }, { value: { gte: fmt(r.end) } }] })
              : op === '>'
                ? some({ value: { gte: fmt(r.end) } })
                : op === '>='
                  ? some({ value: { gte: fmt(r.start) } })
                  : op === '<'
                    ? some({ value: { lt: fmt(r.start) } })
                    : some({ value: { lt: fmt(r.end) } });
        positives.push(cmp);
      }
      break;
    }
    case 'user': {
      const ids: string[] = [];
      for (const i of vals) {
        if (i.kind === 'function' && i.name === 'currentuser') {
          ids.push(ctx.actor.user.id);
          continue;
        }
        const raw = operandText(i, field.name);
        const id = await resolveUserRef(ctx, raw);
        if (!id) throw valueError(raw, field.name);
        ids.push(id);
      }
      for (const id of ids) {
        positives.push(some({ value: { path: ['accountId'], equals: id } }));
      }
      break;
    }
    default:
      throw new JqlFieldError(`Field '${field.name}' does not support searching.`, field.name);
  }

  const positive: Where =
    positives.length === 0 && !hasEmpty
      ? emptyClause // empty function/list result → match nothing
      : positives.length === 1 && !hasEmpty
        ? positives[0]
        : { OR: [...positives, ...(hasEmpty ? [emptyClause] : [])] };

  if (!negated) return positive;
  // Jira: != never matches EMPTY — issue must have the field set AND not match.
  return { AND: [{ cfValues: { some: { fieldId: fid } } }, { NOT: positive }] };
}

async function compileCondition(ctx: Ctx, c: JqlClauseCondition): Promise<Where> {
  if (c.field.name === 'cf') {
    // 032 US5 — quoted/unknown names that match a system field or alias
    // ("Epic Link") compile as that field; the rest is CF resolution.
    const sys = lookupField(c.field.raw);
    if (!sys) return compileCfCondition(ctx, c);
    c = { ...c, field: { ...c.field, name: sys.name } };
  }
  const def = lookupField(c.field.name)!;
  const field = def.name;
  const op = c.operator;

  if (op === 'IS' || op === 'IS NOT') {
    const empty = op === 'IS';
    // lastViewed is scoped to the current user's view rows, not a column.
    if (field === 'lastviewed') {
      return empty
        ? { recentViews: { none: { userId: ctx.actor.user.id } } }
        : { recentViews: { some: { userId: ctx.actor.user.id } } };
    }
    return isEmptyWhere(field, empty);
  }

  // 032 US2 — WAS/WAS NOT/CHANGED compile against ChangeHistory/ChangeItem
  if (op === 'WAS' || op === 'WAS NOT' || op === 'CHANGED') {
    return compileHistory(ctx, c);
  }

  const items = c.operand.kind === 'list' ? (c.operand as JqlListOperand).items : [c.operand as JqlOperand];
  const listMode = c.operand.kind === 'list' || op === 'IN' || op === 'NOT IN';
  const negated = op === '!=' || op === 'NOT IN';

  // resolve operand values per field kind
  switch (field) {
    case 'project': {
      // 032 US5 — project-set functions (projectsLeadBy)
      if (items.some((i) => i.kind === 'function')) {
        const { evalProjectFunction } = await import('./functions.js');
        const ids = (
          await Promise.all(items.map((i) => evalProjectFunction(ctx, i as JqlOperand & { kind: 'function' }, field)))
        ).flat();
        const pos: Where = { projectId: { in: ids } };
        return negated ? { NOT: pos } : pos;
      }
      const keys = items.map((i) => operandText(i, field));
      const missing = keys.filter((k) => !ctx.projects.has(k.toUpperCase()));
      if (missing.length) throw valueError(missing[0], field);
      const allowed = ctx.actor.token?.projectKeys;
      if (allowed?.length) {
        const denied = keys.filter((k) => !allowed.includes(k.toUpperCase()));
        if (denied.length) throw valueError(denied[0], field);
      }
      const upper = keys.map((k) => k.toUpperCase());
      return eqInWhere('project', 'key', upper, listMode, negated);
    }
    case 'key': {
      // 032: issue-set functions (linkedIssues, tree pack) → id lists directly
      if (items.some((i) => i.kind === 'function')) {
        const { evalIssueFunction } = await import('./functions.js');
        const ids = (
          await Promise.all(items.map((i) => evalIssueFunction(ctx, i as JqlOperand & { kind: 'function' }, field)))
        ).flat();
        const pos: Where = { id: { in: ids } };
        return negated ? { NOT: pos } : pos;
      }
      const parsed = await Promise.all(items.map((i) => resolveIssueKey(ctx, operandText(i, field))));
      for (let i = 0; i < items.length; i++) {
        if (!parsed[i]) {
          throw new JqlFieldError(
            `An issue with key '${operandText(items[i], field)}' does not exist for field 'key'.`,
            field
          );
        }
      }
      const pairs = parsed.map((p) => p!);
      const single = (p: (typeof pairs)[number]): Where => ({
        AND: [{ project: { key: p.projectKey } }, { issueNumber: p.issueNumber }],
      });
      if (op === '>' || op === '>=' || op === '<' || op === '<=') {
        const p = pairs[0];
        const num =
          op === '>'
            ? { gt: p.issueNumber }
            : op === '>='
              ? { gte: p.issueNumber }
              : op === '<'
                ? { lt: p.issueNumber }
                : { lte: p.issueNumber };
        const kc =
          op === '>'
            ? { gt: p.projectKey }
            : op === '>='
              ? { gte: p.projectKey }
              : op === '<'
                ? { lt: p.projectKey }
                : { lte: p.projectKey };
        return {
          OR: [{ project: { key: kc } }, { AND: [{ project: { key: p.projectKey } }, { issueNumber: num }] }],
        };
      }
      const pos: Where = listMode ? { OR: pairs.map(single) } : single(pairs[0]);
      return negated ? { NOT: pos } : pos;
    }
    case 'status':
      return eqInWhere('statusId', null, resolveIds(ctx, items, field, ctx.statuses), listMode, negated);
    case 'issuetype':
      return eqInWhere('issueTypeId', null, resolveIds(ctx, items, field, ctx.issueTypes), listMode, negated);
    case 'priority': {
      const ids = resolveIds(ctx, items, field, ctx.priorities);
      // severity order: lower sequence = higher priority — Jira `priority > High`
      // means "more severe than High" → sequence < High.seq
      if (op === '>' || op === '>=' || op === '<' || op === '<=') {
        const p = await prisma.priority.findUnique({ where: { id: ids[0] }, select: { sequence: true } });
        const cmp =
          op === '>'
            ? { lt: p!.sequence }
            : op === '>='
              ? { lte: p!.sequence }
              : op === '<'
                ? { gt: p!.sequence }
                : { gte: p!.sequence };
        return { priority: { sequence: cmp } };
      }
      return eqInWhere('priorityId', null, ids, listMode, negated);
    }
    case 'statusCategory': {
      const cats = items.map((i) => {
        const raw = operandText(i, field).toLowerCase();
        const map: Record<string, string> = {
          'to do': 'todo',
          todo: 'todo',
          new: 'todo',
          'in progress': 'inprogress',
          inprogress: 'inprogress',
          indeterminate: 'inprogress',
          done: 'done',
          complete: 'done',
        };
        const cat = map[raw];
        if (!cat) throw valueError(operandText(i, field), field);
        return cat;
      });
      return eqInWhere('status', 'category', cats, listMode, negated);
    }
    case 'resolution': {
      // Jira treats `Unresolved` as EMPTY
      const ids: (string | null)[] = items.map((i) => {
        const raw = operandText(i, field);
        if (raw.toLowerCase() === 'unresolved') return null;
        const id = ctx.resolutions.get(raw.toLowerCase());
        if (!id) throw valueError(raw, field);
        return id;
      });
      return nullableEqIn('resolutionId', ids, listMode, negated);
    }
    case 'assignee':
    case 'reporter':
    case 'delegate': {
      const col = field === 'assignee' ? 'assigneeId' : field === 'reporter' ? 'reporterId' : 'delegateId';
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        if (i.kind === 'function' && i.name === 'currentuser') {
          ids.push(ctx.actor.user.id);
          continue;
        }
        if (i.kind === 'function') {
          const { evalUserFunction } = await import('./functions.js');
          ids.push(...(await evalUserFunction(ctx, i, field)));
          continue;
        }
        const raw = operandText(i, field);
        const id = await resolveUserRef(ctx, raw);
        if (!id) throw valueError(raw, field);
        ids.push(id);
      }
      return nullableEqIn(col, ids, listMode, negated);
    }
    case 'labels': {
      const vals = items.map((i) => (i.kind === 'empty' ? null : operandText(i, field)));
      const nonNull = vals.filter((v): v is string => v !== null);
      const hasEmpty = vals.includes(null);
      const positive: Where = nonNull.length
        ? listMode || nonNull.length > 1
          ? { labels: { hasSome: nonNull } }
          : { labels: { has: nonNull[0] } }
        : { labels: { isEmpty: true } };
      const clause: Where = hasEmpty
        ? nonNull.length
          ? { OR: [positive, { labels: { isEmpty: true } }] }
          : positive
        : positive;
      if (!negated) return clause;
      // NOT (has x OR has y OR isEmpty)
      return { NOT: clause };
    }
    case 'parent': {
      // 032: issue-set functions resolve to parent-id lists
      if (items.some((i) => i.kind === 'function')) {
        const { evalIssueFunction } = await import('./functions.js');
        const fns = items.filter((i) => i.kind === 'function');
        if (fns.length !== items.length && items.some((i) => i.kind !== 'function' && i.kind !== 'empty')) {
          throw new JqlFieldError(`Cannot mix functions and literal values for the field 'parent'.`, field);
        }
        const ids = (
          await Promise.all(fns.map((i) => evalIssueFunction(ctx, i as JqlOperand & { kind: 'function' }, field)))
        ).flat();
        const hasEmpty = items.some((i) => i.kind === 'empty');
        const pos: Where = hasEmpty
          ? { OR: [{ parentId: { in: ids } }, { parentId: null }] }
          : { parentId: { in: ids } };
        return negated ? { NOT: pos } : pos;
      }
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        const raw = operandText(i, field);
        const resolved = await resolveIssueKey(ctx, raw);
        if (!resolved) {
          throw new JqlFieldError(`An issue with key '${raw}' does not exist for field 'parent'.`, field);
        }
        ids.push(resolved.id);
      }
      return nullableEqIn('parentId', ids, listMode, negated);
    }
    case 'created':
    case 'updated':
    case 'resolved':
    case 'duedate': {
      const col =
        field === 'created'
          ? 'createdAt'
          : field === 'updated'
            ? 'updatedAt'
            : field === 'resolved'
              ? 'resolutionDate'
              : 'dueDate';
      const ranges = await Promise.all(items.map((i) => resolveDateOperand(ctx, i, field)));
      const positive: Where =
        ranges.length === 1 && !listMode
          ? dateCompare(col, op, ranges[0])
          : {
              OR: ranges.map((r) => dateCompare(col, op === 'NOT IN' ? '=' : op, r)),
            };
      if (op === '!=' || op === 'NOT IN') {
        // Jira: != never matches EMPTY values
        const notClauses = ranges.map((r) => ({ NOT: dateCompare(col, '=', r) }));
        return { AND: notClauses, ...(field === 'resolved' || field === 'duedate' ? { [col]: { not: null } } : {}) };
      }
      return positive;
    }
    // --- sprint 024: time tracking ---
    case 'timeestimate':
    case 'timeoriginalestimate': {
      const col = field === 'timeestimate' ? 'remainingEstimateSec' : 'originalEstimateSec';
      const secs: (number | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          secs.push(null);
          continue;
        }
        secs.push(await resolveDurationOperand(ctx, i, field));
      }
      return secCompare(col, op, secs as number[], listMode, negated);
    }
    case 'timespent': {
      const secs = items.filter((i) => i.kind !== 'empty');
      const hasEmpty = secs.length !== items.length;
      const vals = await Promise.all(secs.map((i) => resolveDurationOperand(ctx, i, field)));
      const ids = await timeSpentIssueIds(op, vals.length ? vals : [0]);
      const positive: Where = { id: { in: ids } };
      const none: Where = { worklogs: { none: {} } };
      if (!negated) return hasEmpty ? { OR: [positive, none] } : positive;
      // != never matches EMPTY (no worklogs) — same Jira rule as columns.
      const exclusion: Where = { id: { notIn: ids } };
      return hasEmpty ? { AND: [exclusion, { worklogs: { some: {} } }] } : exclusion;
    }
    case 'workratio': {
      const vals = items.filter((i) => i.kind !== 'empty');
      const nums = await Promise.all(
        vals.map(async (i) => {
          const n = Number(operandText(i, field));
          if (!Number.isFinite(n)) throw valueError(operandText(i, field), field);
          return n;
        })
      );
      const ids = await workratioIssueIds(op, nums.length ? nums : [0]);
      const positive: Where = { id: { in: ids } };
      if (!negated) return positive;
      return { AND: [{ originalEstimateSec: { not: null } }, { id: { notIn: ids } }] };
    }
    case 'worklogdate': {
      const ranges = await Promise.all(
        items.filter((i) => i.kind !== 'empty').map((i) => resolveDateOperand(ctx, i, field))
      );
      const match = (r: DateOperand, o: JqlOperator): Where => ({
        worklogs: { some: { AND: dateRangeFilters('started', o, r) } },
      });
      const positive: Where =
        ranges.length === 1 && !listMode
          ? match(ranges[0], op)
          : { OR: ranges.map((r) => match(r, op === 'NOT IN' ? '=' : op)) };
      if (negated) {
        const notClauses = ranges.map((r) => ({ NOT: match(r, '=') }));
        return { AND: notClauses };
      }
      return positive;
    }
    case 'commentdate': {
      // 068 — same shape as worklogdate: comments.some(createdAt in range).
      const hasEmpty = items.some((i) => i.kind === 'empty');
      const ranges = await Promise.all(
        items.filter((i) => i.kind !== 'empty').map((i) => resolveDateOperand(ctx, i, field))
      );
      const match = (r: DateOperand, o: JqlOperator): Where => ({
        comments: { some: { AND: dateRangeFilters('createdAt', o, r) } },
      });
      if (ranges.length === 0) {
        // `= EMPTY` / `IN (EMPTY)` — the whole operand is the empty literal.
        return negated ? { comments: { some: {} } } : { comments: { none: {} } };
      }
      const positive: Where =
        ranges.length === 1 && !listMode
          ? match(ranges[0], op)
          : { OR: ranges.map((r) => match(r, op === 'NOT IN' ? '=' : op)) };
      if (negated) {
        // != never matches EMPTY (no comments) — same Jira rule as columns.
        const notClauses = ranges.map((r) => ({ NOT: match(r, '=') }));
        return hasEmpty ? { AND: [{ comments: { some: {} } }, ...notClauses] } : { AND: notClauses };
      }
      return hasEmpty ? { OR: [positive, { comments: { none: {} } }] } : positive;
    }
    case 'lastviewed': {
      // Same shape as worklogdate, but the relation is per-user — only the
      // current user's RecentView rows count (Jira: lastViewed is per-viewer).
      const hasEmpty = items.some((i) => i.kind === 'empty');
      const ranges = await Promise.all(
        items.filter((i) => i.kind !== 'empty').map((i) => resolveDateOperand(ctx, i, field))
      );
      const match = (r: DateOperand, o: JqlOperator): Where => ({
        recentViews: {
          some: { AND: [{ userId: ctx.actor.user.id }, ...dateRangeFilters('viewedAt', o, r)] },
        },
      });
      if (ranges.length === 0) {
        // `= EMPTY` / `IN (EMPTY)` — the whole operand is the empty literal.
        if (!negated) return { recentViews: { none: { userId: ctx.actor.user.id } } };
        return { recentViews: { some: { userId: ctx.actor.user.id } } };
      }
      const positive: Where =
        ranges.length === 1 && !listMode
          ? match(ranges[0], op)
          : { OR: ranges.map((r) => match(r, op === 'NOT IN' ? '=' : op)) };
      if (negated) {
        // != never matches EMPTY (Jira rule) — `!= EMPTY` alone means "has a view".
        const notClauses = ranges.map((r) => ({ NOT: match(r, '=') }));
        return hasEmpty
          ? { AND: [{ recentViews: { some: { userId: ctx.actor.user.id } } }, ...notClauses] }
          : { AND: notClauses };
      }
      return hasEmpty ? { OR: [positive, { recentViews: { none: { userId: ctx.actor.user.id } } }] } : positive;
    }
    case 'billable': {
      const truthy = items.map((i) => {
        const raw = operandText(i, field).toLowerCase();
        if (raw !== 'true' && raw !== 'false') throw valueError(raw, field);
        return raw === 'true';
      });
      const positive: Where =
        truthy.length === 1 && !listMode
          ? { worklogs: { some: { billable: truthy[0] } } }
          : { OR: truthy.map((b) => ({ worklogs: { some: { billable: b } } })) };
      if (!negated) return positive;
      return { AND: [{ worklogs: { some: {} } }, { NOT: positive }] };
    }
    // --- sprint 032 US3: coverage fields ---
    case 'votes':
    case 'watches': {
      const col = field === 'votes' ? 'voteCount' : 'watcherCount';
      const nums = items.map((i) => {
        if (i.kind === 'empty') return null;
        const n = Number(operandText(i, field));
        if (!Number.isFinite(n)) throw valueError(operandText(i, field), field);
        return n;
      });
      if (op === '=' || op === 'IN') return nullableEqIn(col, nums, listMode, false) as Where;
      if (op === '!=' || op === 'NOT IN') {
        const nonNull = nums.filter((n): n is number => n !== null);
        return nonNull.length ? ({ [col]: { notIn: nonNull } } as Where) : {};
      }
      const n = nums[0];
      if (n === null || n === undefined) throw valueError('EMPTY', field);
      const cmp = op === '>' ? { gt: n } : op === '>=' ? { gte: n } : op === '<' ? { lt: n } : { lte: n };
      return { [col]: cmp } as Where;
    }
    case 'security': {
      // Jira `level = x` — matches the effective (inherited) security level
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        const raw = operandText(i, field);
        const lvl = await prisma.securityLevel.findFirst({
          where: { OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }] },
          select: { id: true },
        });
        if (!lvl) throw valueError(raw, field);
        ids.push(lvl.id);
      }
      return nullableEqIn('effSecurityLevelId', ids, listMode, negated);
    }
    case 'projectcategory': {
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        const raw = operandText(i, field);
        const cat = await prisma.projectCategory.findFirst({
          where: { name: { equals: raw, mode: 'insensitive' } },
          select: { id: true },
        });
        if (!cat) throw valueError(raw, field);
        ids.push(cat.id);
      }
      const nonNull = ids.filter((v): v is string => v !== null);
      const positive: Where = nonNull.length
        ? ids.includes(null)
          ? { OR: [{ project: { categoryId: { in: nonNull } } }, { project: { categoryId: null } }] }
          : { project: { categoryId: { in: nonNull } } }
        : { project: { categoryId: null } };
      return negated ? { NOT: positive } : positive;
    }
    case 'filter': {
      const wheres: Where[] = [];
      for (const i of items) {
        wheres.push(await resolveFilterWhere(ctx, operandText(i, field), field));
      }
      const positive: Where = wheres.length === 1 ? wheres[0] : { OR: wheres };
      return negated ? { NOT: positive } : positive;
    }
    case 'storypoints':
      return storyPointsWhere(op, items, listMode, negated);
    case 'sprint': {
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        if (i.kind === 'function') {
          if (!SPRINT_FUNCTIONS.has(i.name)) {
            throw new JqlFieldError(`Function '${i.name}' is not supported for the field 'sprint'.`, field);
          }
          const state =
            i.name === 'opensprints' ? ['active', 'future'] : i.name === 'closedsprints' ? ['closed'] : ['future'];
          const sprints = await prisma.sprint.findMany({
            where: { state: { in: state } },
            select: { id: true },
          });
          ids.push(...sprints.map((s) => s.id));
          continue;
        }
        // Jira takes the sprint id; we also accept the name or per-board sequence.
        const raw = operandText(i, field);
        const numeric = Number.isInteger(Number(raw)) ? [{ sequence: Number(raw) }] : [];
        const sprint = await prisma.sprint.findFirst({
          where: {
            OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }, ...numeric],
          },
          select: { id: true },
        });
        if (!sprint) throw valueError(raw, field);
        ids.push(sprint.id);
      }
      return sprintMembershipWhere(ids, listMode, negated);
    }
    // --- sprint 019: release management ---
    case 'component': {
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        if (i.kind === 'function') {
          // 032 US5 — componentsLeadBy("user")
          const { evalComponentFunction } = await import('./functions.js');
          ids.push(...(await evalComponentFunction(ctx, i, field)));
          continue;
        }
        const raw = operandText(i, field);
        const c = await prisma.component.findFirst({
          where: { OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }] },
          select: { id: true },
        });
        if (!c) throw valueError(raw, field);
        ids.push(c.id);
      }
      const nonNull = ids.filter((v): v is string => v !== null);
      const hasEmpty = ids.includes(null);
      const some: Where = { components: { some: { componentId: { in: nonNull } } } };
      const none: Where = { components: { none: {} } };
      const positive: Where = nonNull.length ? some : none;
      const clause: Where = hasEmpty ? (nonNull.length ? { OR: [positive, none] } : positive) : positive;
      // Jira: !=/NOT IN on a multi-value field also matches EMPTY — NOT(some)
      return negated ? { NOT: positive } : clause;
    }
    case 'fixversion':
    case 'affectedversion': {
      const vKind = field === 'fixversion' ? 'fix' : 'affects';
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        if (i.kind === 'function') {
          if (!VERSION_FUNCTIONS.has(i.name)) {
            throw new JqlFieldError(`Function '${i.name}' is not supported for the field '${field}'.`, field);
          }
          ids.push(...(await versionFunctionIds(i.name, i.args, field)));
          continue;
        }
        const raw = operandText(i, field);
        const v = await prisma.version.findFirst({
          where: { OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }] },
          select: { id: true },
        });
        if (!v) throw valueError(raw, field);
        ids.push(v.id);
      }
      const nonNull = ids.filter((v): v is string => v !== null);
      const hasEmpty = ids.includes(null);
      const some: Where = { versionRefs: { some: { kind: vKind, versionId: { in: nonNull } } } };
      const none: Where = { versionRefs: { none: { kind: vKind } } };
      const positive: Where = nonNull.length ? some : none;
      const clause: Where = hasEmpty ? (nonNull.length ? { OR: [positive, none] } : positive) : positive;
      return negated ? { NOT: positive } : clause;
    }
    // --- sprint 032 US5: environment + epic link ---
    case 'environment': {
      if (op === '~' || op === '!~') {
        const term = operandText(items[0], field);
        if (!term.trim()) return {};
        const w: Where = { environment: { contains: term, mode: 'insensitive' } };
        return op === '~' ? w : { NOT: w };
      }
      const vals = items.map((i) => operandText(i, field));
      const positive: Where = { environment: { in: vals } };
      return negated ? { NOT: positive } : positive;
    }
    case 'epiclink': {
      const ids: (string | null)[] = [];
      for (const i of items) {
        if (i.kind === 'empty') {
          ids.push(null);
          continue;
        }
        const raw = operandText(i, field);
        const resolved = await resolveIssueKey(ctx, raw);
        if (!resolved) {
          throw new JqlFieldError(`An issue with key '${raw}' does not exist for field 'Epic Link'.`, field);
        }
        const epic = await prisma.issue.findFirst({
          where: { id: resolved.id, issueType: { hierarchyLevel: 1 } },
          select: { id: true },
        });
        if (!epic) {
          throw new JqlFieldError(`The issue '${raw}' is not an epic.`, field);
        }
        ids.push(epic.id);
      }
      const nonNull = ids.filter((v): v is string => v !== null);
      const positive: Where = { parentId: { in: nonNull } };
      const none: Where = isEmptyWhere('epiclink', true);
      const clause: Where = ids.includes(null) ? (nonNull.length ? { OR: [positive, none] } : none) : positive;
      return negated ? { NOT: clause } : clause;
    }
    case 'summary':
    case 'description':
    case 'comment':
    case 'text': {
      const scope = field as 'summary' | 'description' | 'comment' | 'text';
      const phrases = items.map((i) => operandText(i, field));
      // empty ~ phrase is a no-op filter (Jira treats it as "matches everything")
      if (phrases.every((p) => !p.trim())) return {};
      const sets = await Promise.all(phrases.map((p) => ftsIssueIds(scope, p)));
      const positive: Where =
        sets.length === 1 ? { id: { in: sets[0] } } : { OR: sets.map((s) => ({ id: { in: s } })) };
      if (op === '!~') {
        return sets.length === 1 ? { id: { notIn: sets[0] } } : { AND: sets.map((s) => ({ id: { notIn: s } })) };
      }
      return positive;
    }
    default:
      throw new JqlFieldError(`Field '${field}' is not supported yet.`, field);
  }
}

function operandText(op: JqlOperand, field: string): string {
  if (op.kind === 'string') return op.value;
  if (op.kind === 'number') return op.raw;
  if (op.kind === 'empty') return 'EMPTY';
  if (op.kind === 'function') {
    throw new JqlFieldError(`Function '${op.name}' is not supported for the field '${field}'.`, field);
  }
  throw new JqlFieldError(`Relative dates are not supported for the field '${field}'.`, field);
}

// ---------- 032 US2 — history operators (WAS / WAS NOT / CHANGED) ----------

/** Jira's history-safe field set → ChangeItem.field spelling */
const HISTORY_FIELDS: Record<string, string> = {
  status: 'status',
  priority: 'priority',
  resolution: 'resolution',
  assignee: 'assignee',
  reporter: 'reporter',
  fixversion: 'Fix Version/s',
  sprint: 'Sprint',
};

interface HistVals {
  ids: string[];
  strings: string[];
  hasNull: boolean;
  /** version/sprint ChangeItems join multi names in toString → contains-match */
  contains: boolean;
}

function namesOf(map: Map<string, string>, ids: string[]): string[] {
  const out: string[] = [];
  for (const [name, id] of map) if (ids.includes(id)) out.push(name);
  return out;
}

async function resolveHistoryVals(ctx: Ctx, field: string, items: JqlOperand[]): Promise<HistVals> {
  const v: HistVals = { ids: [], strings: [], hasNull: false, contains: false };
  const lit = items.filter((i) => i.kind !== 'empty');
  v.hasNull = items.length !== lit.length;
  switch (field) {
    case 'status':
    case 'priority':
    case 'resolution': {
      const map = field === 'status' ? ctx.statuses : field === 'priority' ? ctx.priorities : ctx.resolutions;
      const rest: JqlOperand[] = [];
      for (const i of lit) {
        // `resolution WAS Unresolved` == EMPTY
        if (field === 'resolution' && operandText(i, field).toLowerCase() === 'unresolved') {
          v.hasNull = true;
          continue;
        }
        rest.push(i);
      }
      v.ids = resolveIds(ctx, rest, field, map);
      v.strings = namesOf(map, v.ids);
      return v;
    }
    case 'assignee':
    case 'reporter': {
      for (const i of lit) {
        if (i.kind === 'function') {
          const { evalUserFunction } = await import('./functions.js');
          v.ids.push(...(await evalUserFunction(ctx, i, field)));
          continue;
        }
        const raw = operandText(i, field);
        const id = await resolveUserRef(ctx, raw);
        if (!id) throw valueError(raw, field);
        v.ids.push(id);
        v.strings.push(raw);
      }
      return v;
    }
    case 'fixversion': {
      v.contains = true;
      for (const i of lit) {
        const raw = operandText(i, field);
        const ver = await prisma.version.findFirst({
          where: { OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }] },
          select: { id: true },
        });
        if (!ver) throw valueError(raw, field);
        v.ids.push(ver.id);
        v.strings.push(raw);
      }
      return v;
    }
    case 'sprint': {
      v.contains = true;
      for (const i of lit) {
        const raw = operandText(i, field);
        const numeric = Number.isInteger(Number(raw)) ? [{ sequence: Number(raw) }] : [];
        const s = await prisma.sprint.findFirst({
          where: { OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }, ...numeric] },
          select: { id: true },
        });
        if (!s) throw valueError(raw, field);
        v.ids.push(s.id);
        v.strings.push(raw);
      }
      return v;
    }
    default:
      throw new JqlFieldError(`The field '${field}' does not support history operators.`, field);
  }
}

/** Match a ChangeItem column by id (toVal/fromVal) or display string (toString/fromString). */
function histValMatch(col: 'to' | 'from', v: HistVals): Where[] {
  const or: Where[] = [];
  if (v.ids.length) or.push({ [`${col}Val`]: { in: v.ids } });
  for (const s of v.strings) {
    or.push({
      [`${col}String`]: v.contains ? { contains: s, mode: 'insensitive' } : { equals: s, mode: 'insensitive' },
    });
  }
  if (v.hasNull) or.push({ [`${col}Val`]: null });
  return or;
}

async function compileHistory(ctx: Ctx, c: JqlClauseCondition): Promise<Where> {
  const field = c.field.name;
  const ciField = HISTORY_FIELDS[field];
  if (!ciField) {
    throw new JqlFieldError(`The operator '${c.operator}' is not supported by the '${field}' field.`, field);
  }
  const items = c.operand.kind === 'list' ? (c.operand as JqlListOperand).items : [c.operand as JqlOperand];
  const preds = c.history ?? [];

  const histWhere: Record<string, unknown> = {};
  const itemWhere: Record<string, unknown> = { field: ciField };

  for (const p of preds) {
    switch (p.kind) {
      case 'from':
      case 'to': {
        const v = await resolveHistoryVals(ctx, field, p.operands);
        const or = histValMatch(p.kind, v);
        if (!or.length) return { id: { in: [] } };
        itemWhere.AND = [...((itemWhere.AND as Where[]) ?? []), { OR: or }];
        break;
      }
      case 'by': {
        const ids: string[] = [];
        for (const i of p.operands) {
          if (i.kind === 'function') {
            const { evalUserFunction } = await import('./functions.js');
            ids.push(...(await evalUserFunction(ctx, i, field)));
            continue;
          }
          const raw = operandText(i, field);
          const id = await resolveUserRef(ctx, raw);
          if (!id) throw valueError(raw, field);
          ids.push(id);
        }
        histWhere.authorId = { in: ids };
        break;
      }
      case 'before':
      case 'after':
      case 'on': {
        const d = await resolveDateOperand(ctx, p.operands[0], field);
        const prev = (histWhere.createdAt ?? {}) as Record<string, Date>;
        histWhere.createdAt =
          p.kind === 'before'
            ? { ...prev, lt: d.start }
            : p.kind === 'after'
              ? { ...prev, gt: d.end }
              : { ...prev, gte: d.start, lte: d.end };
        break;
      }
      case 'during': {
        const a = await resolveDateOperand(ctx, p.operands[0], field);
        const b = await resolveDateOperand(ctx, p.operands[1], field);
        const prev = (histWhere.createdAt ?? {}) as Record<string, Date>;
        histWhere.createdAt = { ...prev, gte: a.start, lte: b.end };
        break;
      }
    }
  }

  const someHist = (extra?: Record<string, unknown>): Where => ({
    histories: {
      some: { ...histWhere, items: { some: { field: ciField, ...extra } } },
    },
  });

  if (c.operator === 'CHANGED') {
    return someHist(itemWhere.AND ? { AND: itemWhere.AND as Where[] } : undefined);
  }

  // WAS [NOT]: match a transition arriving at (toVal) or departing from (fromVal) the value
  const v = await resolveHistoryVals(ctx, field, items);
  const or = [...histValMatch('to', v), ...histValMatch('from', v)];
  if (!or.length) return { id: { in: [] } };
  const hist = someHist({ OR: or });
  // plain WAS includes the current value (Jira); with predicates, history-only
  const current = preds.length === 0 ? await compileCondition(ctx, { ...c, operator: '=', history: undefined }) : null;
  const positive: Where = current ? { OR: [current, hist] } : hist;
  return c.operator === 'WAS' ? positive : { NOT: positive };
}

/** 032 US3 — `filter = "name"` → inlined subquery honoring share scope + cycle guard. */
async function resolveFilterWhere(ctx: Ctx, raw: string, field: string): Promise<Where> {
  const filter = await prisma.filter.findFirst({
    where: { OR: [{ id: raw }, { name: { equals: raw, mode: 'insensitive' } }] },
    include: { sharePerms: true },
  });
  const notFound = () => new JqlFieldError(`A value with name '${raw}' does not exist for the field 'filter'.`, field);
  if (!filter) throw notFound();
  const { canSeeFilter } = await import('../services/filterScope.js');
  if (!(await canSeeFilter(filter, ctx.actor))) throw notFound();
  if (ctx.filterStack.has(filter.id)) {
    throw new JqlFieldError(`The filter '${filter.name}' creates a circular filter reference.`, field);
  }
  const { parseJql } = await import('./parser.js');
  const inner = parseJql(filter.jql);
  ctx.filterStack.add(filter.id);
  try {
    const compiled = await compileJql(inner, ctx.actor, ctx.filterStack);
    return compiled.where;
  } finally {
    ctx.filterStack.delete(filter.id);
  }
}

function resolveIds(ctx: Ctx, items: JqlOperand[], field: string, map: Map<string, string>): string[] {
  return items.map((i) => {
    const raw = operandText(i, field);
    const id = map.get(raw.toLowerCase());
    if (!id) throw valueError(raw, field);
    return id;
  });
}

/** column equality: `eqInWhere('statusId', null, [id], false, false)` → `{statusId: id}` */
function eqInWhere(field: string, relCol: string | null, values: string[], listMode: boolean, negated: boolean): Where {
  const multi = listMode || values.length > 1;
  if (negated) {
    if (multi) {
      return relCol ? { [field]: { [relCol]: { notIn: values } } } : { [field]: { notIn: values } };
    }
    return relCol ? { [field]: { [relCol]: { not: values[0] } } } : { [field]: { not: values[0] } };
  }
  if (multi) {
    return relCol ? { [field]: { [relCol]: { in: values } } } : { [field]: { in: values } };
  }
  return relCol ? { [field]: { [relCol]: values[0] } } : { [field]: values[0] };
}

/** nullable column equality where operands may include null (EMPTY). */
function nullableEqIn(col: string, values: (string | number | null)[], listMode: boolean, negated: boolean): Where {
  const nonNull = values.filter((v): v is string | number => v !== null);
  const hasNull = values.includes(null);
  // No values at all (e.g. empty function result) → match nothing.
  if (!values.length) return { [col]: { in: [] } };
  const positive: Where =
    nonNull.length && hasNull
      ? { OR: [{ [col]: { in: nonNull } }, { [col]: null }] }
      : nonNull.length
        ? listMode || nonNull.length > 1
          ? { [col]: { in: nonNull } }
          : { [col]: nonNull[0] }
        : { [col]: null };
  if (!negated) return positive;
  // Jira: field != value only matches non-empty — and != (a, EMPTY) means "set and not in list"
  const notIn: Where = nonNull.length ? { [col]: { notIn: nonNull } } : {};
  if (hasNull) {
    // != EMPTY → not null AND not in values
    return nonNull.length ? { AND: [{ [col]: { not: null } }, notIn] } : { [col]: { not: null } };
  }
  return { AND: [{ [col]: { not: null } }, notIn] };
}

/**
 * Sprint is multi-valued in Jira — issues keep closed-sprint references.
 * Compiles to current `sprintId` OR any `IssueSprint` history row.
 */
/** 019: resolve the three version-list functions to version ids.
 *  releasedVersions()/unreleasedVersions() accept optional project keys;
 *  earliestUnreleasedVersion(project) requires one (Jira signature). */
async function versionFunctionIds(name: string, args: string[], field: string): Promise<string[]> {
  const projectFilter = args.length ? { project: { key: { in: args.map((a) => a.toUpperCase()) } } } : {};
  if (name === 'releasedversions') {
    const vs = await prisma.version.findMany({ where: { released: true, ...projectFilter }, select: { id: true } });
    return vs.map((v) => v.id);
  }
  if (name === 'unreleasedversions') {
    const vs = await prisma.version.findMany({
      where: { released: false, archived: false, ...projectFilter },
      select: { id: true },
    });
    return vs.map((v) => v.id);
  }
  if (!args.length) {
    throw new JqlFieldError(`Function 'earliestUnreleasedVersion' requires a project key argument.`, field);
  }
  const v = await prisma.version.findFirst({
    where: { released: false, archived: false, project: { key: args[0].toUpperCase() } },
    orderBy: { sequence: 'asc' },
    select: { id: true },
  });
  return v ? [v.id] : [];
}

function sprintMembershipWhere(ids: (string | null)[], listMode: boolean, negated: boolean): Where {
  const nonNull = ids.filter((v): v is string => v !== null);
  const hasNull = ids.includes(null);
  if (!ids.length) return { sprintId: { in: [] } }; // empty function result → match nothing

  const current: Where[] = nonNull.length ? [{ sprintId: { in: nonNull } }] : [];
  const history: Where = nonNull.length
    ? { sprints: { some: { sprintId: { in: nonNull } } } }
    : { sprints: { none: {} } };
  const positive: Where =
    nonNull.length && hasNull
      ? { OR: [...current, history, { sprintId: null, sprints: { none: {} } }] }
      : nonNull.length
        ? { OR: [...current, history] }
        : { AND: [{ sprintId: null }, { sprints: { none: {} } }] };
  if (!negated) return positive;

  // Jira: != never matches EMPTY — exclude current + historical membership.
  const exclusion: Where[] = nonNull.length
    ? [{ sprintId: { notIn: nonNull } }, { sprints: { none: { sprintId: { in: nonNull } } } }]
    : [];
  const set: Where = { OR: [{ sprintId: { not: null } }, { sprints: { some: {} } }] };
  return hasNull ? { AND: [set, ...exclusion] } : { AND: [set, ...exclusion] };
}

function isEmptyWhere(field: string, empty: boolean): Where {
  const col =
    field === 'assignee'
      ? 'assigneeId'
      : field === 'delegate'
        ? 'delegateId'
        : field === 'reporter'
          ? 'reporterId'
          : field === 'parent'
            ? 'parentId'
            : field === 'resolution'
              ? 'resolutionId'
              : field === 'duedate'
                ? 'dueDate'
                : field === 'resolved'
                  ? 'resolutionDate'
                  : field === 'description'
                    ? 'description'
                    : field === 'storypoints'
                      ? 'storyPoints'
                      : field === 'sprint'
                        ? 'sprintId'
                        : field === 'timeestimate'
                          ? 'remainingEstimateSec'
                          : field === 'timeoriginalestimate' || field === 'workratio'
                            ? 'originalEstimateSec'
                            : field === 'environment'
                              ? 'environment'
                              : null;
  if (field === 'timespent' || field === 'worklogdate' || field === 'billable') {
    return empty ? { worklogs: { none: {} } } : { worklogs: { some: {} } };
  }
  if (field === 'commentdate') {
    return empty ? { comments: { none: {} } } : { comments: { some: {} } };
  }
  if (field === 'labels') {
    return empty ? { labels: { isEmpty: true } } : { labels: { isEmpty: false } };
  }
  // --- sprint 019 ---
  if (field === 'component') {
    return empty ? { components: { none: {} } } : { components: { some: {} } };
  }
  if (field === 'fixversion' || field === 'affectedversion') {
    const kind = field === 'fixversion' ? 'fix' : 'affects';
    return empty ? { versionRefs: { none: { kind } } } : { versionRefs: { some: { kind } } };
  }
  // --- sprint 032 US3 ---
  if (field === 'security') {
    return empty ? { effSecurityLevelId: null } : { effSecurityLevelId: { not: null } };
  }
  if (field === 'projectcategory') {
    return empty ? { project: { categoryId: null } } : { project: { categoryId: { not: null } } };
  }
  // 032 US5 — epic link: EMPTY = no parent or a non-epic parent
  if (field === 'epiclink') {
    return empty
      ? { OR: [{ parent: null }, { parent: { issueType: { hierarchyLevel: { not: 1 } } } }] }
      : { parent: { issueType: { hierarchyLevel: 1 } } };
  }
  if (!col) throw new JqlFieldError(`Field '${field}' does not support IS EMPTY.`, field);
  return { [col]: empty ? null : { not: null } };
}

/** Same semantics as dateCompare but emits the col-side filters as an array
 *  (for nested `{ some: { AND: [...] } }` relation filters). */
function dateRangeFilters(col: string, op: JqlOperator, r: DateOperand): Where[] {
  switch (op) {
    case '!=':
      return [{ OR: [{ [col]: { lt: r.start } }, { [col]: { gte: r.end } }] }];
    case '>':
      return [{ [col]: { gte: r.end } }];
    case '>=':
      return [{ [col]: { gte: r.start } }];
    case '<':
      return [{ [col]: { lt: r.start } }];
    case '<=':
      return [{ [col]: { lt: r.end } }];
    default:
      return [{ [col]: { gte: r.start } }, { [col]: { lt: r.end } }];
  }
}

function dateCompare(col: string, op: JqlOperator, r: DateOperand): Where {
  switch (op) {
    case '=':
      return { AND: [{ [col]: { gte: r.start } }, { [col]: { lt: r.end } }] };
    case '!=':
      return { OR: [{ [col]: { lt: r.start } }, { [col]: { gte: r.end } }] };
    case '>':
      return { [col]: { gte: r.end } };
    case '>=':
      return { [col]: { gte: r.start } };
    case '<':
      return { [col]: { lt: r.start } };
    case '<=':
      return { [col]: { lt: r.end } };
    default:
      return { AND: [{ [col]: { gte: r.start } }, { [col]: { lt: r.end } }] };
  }
}

// ---------- public API ----------

/** 032 US3 — eager CF-name validation (Jira validates fields before values).
 *  Walks the where-clause resolving every cf reference up-front, so unknown
 *  field names error before value-resolution errors regardless of position. */
async function preflightCfRefs(ctx: Ctx, clause: JqlClause | null): Promise<void> {
  if (!clause) return;
  if (clause.type === 'condition') {
    if (clause.field.name === 'cf' && !lookupField(clause.field.raw)) {
      await resolveCfField(ctx, clause.field.raw);
    }
    return;
  }
  if (clause.type === 'not') return preflightCfRefs(ctx, clause.clause);
  for (const c of clause.clauses) await preflightCfRefs(ctx, c);
}

/** Field-name validation pass for /jql/parse (validates without executing). */
export async function assertJqlFieldRefs(actor: Actor, query: JqlQuery): Promise<void> {
  const ctx = await buildCtx(actor);
  await preflightCfRefs(ctx, query.where);
}

export async function compileJql(
  query: JqlQuery,
  actor: Actor,
  filterStack: Set<string> = new Set()
): Promise<CompiledSearch> {
  const ctx = await buildCtx(actor);
  ctx.filterStack = filterStack;
  await preflightCfRefs(ctx, query.where);
  let where: Where = query.where ? await compileClause(ctx, query.where) : {};

  // visibility: token project allow-list narrows unconstrained searches
  const allowed = actor.token?.projectKeys;
  if (allowed?.length) {
    where = {
      AND: [where, { project: { key: { in: allowed } } }],
    };
  }

  const orderBy: OrderBy[] = [];
  const sortSpec: SortSpecItem[] = [];
  let hasCfSort = false;
  const colSpec = (col: string, dir: 'asc' | 'desc') => sortSpec.push({ kind: 'col', col, dir });
  for (const item0 of query.orderBy) {
    const dir = item0.direction;
    let item = item0;
    if (item.field.name === 'cf') {
      // 032 US5 — quoted names matching a system field sort as that field
      const sys = lookupField(item.field.raw);
      if (sys) {
        item = { ...item, field: { ...item.field, name: sys.name } };
      } else {
        const cfField = await resolveCfField(ctx, item.field.raw);
        if (cfField.alias === 'story_points') {
          orderBy.push({ storyPoints: dir });
          colSpec('storyPoints', dir);
          continue;
        }
        if (
          cfField.searcherType === 'none' ||
          cfField.type === 'multiselect' ||
          cfField.type === 'checkbox' ||
          cfField.type === 'cascading'
        ) {
          throw new JqlFieldError(`Field '${cfField.name}' cannot be used in ORDER BY.`, cfField.name);
        }
        sortSpec.push({ kind: 'cf', field: cfField, dir });
        hasCfSort = true;
        continue;
      }
    }
    switch (item.field.name) {
      case 'key':
        orderBy.push({ project: { key: dir } }, { issueNumber: dir });
        colSpec('projectKey', dir);
        colSpec('issueNumber', dir);
        break;
      case 'created':
        orderBy.push({ createdAt: dir });
        colSpec('createdAt', dir);
        break;
      case 'updated':
        orderBy.push({ updatedAt: dir });
        colSpec('updatedAt', dir);
        break;
      case 'priority':
        // lower sequence = higher priority; Jira `priority DESC` shows severe first
        orderBy.push({ priority: { sequence: dir === 'desc' ? 'asc' : 'desc' } });
        colSpec('prioritySeq', dir === 'desc' ? 'asc' : 'desc');
        break;
      case 'status':
        orderBy.push({ status: { sequence: dir } });
        colSpec('statusSeq', dir);
        break;
      case 'issuetype':
        orderBy.push({ issueType: { name: dir } });
        colSpec('issueTypeName', dir);
        break;
      case 'assignee':
        orderBy.push({ assignee: { displayName: dir } });
        colSpec('assigneeName', dir);
        break;
      case 'duedate':
        orderBy.push({ dueDate: dir });
        colSpec('dueDate', dir);
        break;
      case 'resolved':
        orderBy.push({ resolutionDate: dir });
        colSpec('resolutionDate', dir);
        break;
      case 'resolution':
        orderBy.push({ resolution: { sequence: dir } });
        colSpec('resolutionSeq', dir);
        break;
      case 'project':
        orderBy.push({ project: { key: dir } });
        colSpec('projectKey', dir);
        break;
      case 'summary':
        orderBy.push({ summary: dir });
        colSpec('summary', dir);
        break;
      case 'rank':
        orderBy.push({ rank: dir });
        colSpec('rank', dir);
        break;
      case 'storypoints':
        orderBy.push({ storyPoints: dir });
        colSpec('storyPoints', dir);
        break;
      case 'timeestimate':
        orderBy.push({ remainingEstimateSec: dir });
        colSpec('remainingEstimateSec', dir);
        break;
      case 'timeoriginalestimate':
        orderBy.push({ originalEstimateSec: dir });
        colSpec('originalEstimateSec', dir);
        break;
      case 'sprint':
        orderBy.push({ sprint: { name: dir } });
        colSpec('sprintName', dir);
        break;
    }
  }
  if (hasCfSort) {
    // Memory sort takes over the entire ordering (searchService).
    return { where, orderBy: [], sortSpec };
  }
  if (!orderBy.length) {
    orderBy.push({ rank: 'asc' }, { project: { key: 'asc' } }, { issueNumber: 'asc' });
  }
  return { where, orderBy };
}

async function compileClause(ctx: Ctx, clause: JqlClause): Promise<Where> {
  switch (clause.type) {
    case 'and': {
      const parts = await Promise.all(clause.clauses.map((c) => compileClause(ctx, c)));
      return { AND: parts };
    }
    case 'or': {
      const parts = await Promise.all(clause.clauses.map((c) => compileClause(ctx, c)));
      return { OR: parts };
    }
    case 'not': {
      return { NOT: await compileClause(ctx, clause.clause) };
    }
    case 'condition':
      return compileCondition(ctx, clause);
  }
}

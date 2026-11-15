// Sprint 026 — dashboards & gadgets. Jira semantics:
// - visibility via DashboardPermission rows (kind 'view'|'edit'), owner, admin
// - gadget data resolved AS THE VIEWER (documented divergence from Jira's
//   owner-context quirk — per FR-002 the viewer's permissions govern)
// - data comes from existing service paths / JQL (FR-001)
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hasPermission } from './permissionService.js';
import { executeSearch } from './searchService.js';
import { getBurndown, getVelocity } from './reportService.js';
import { toEventResponse } from './eventService.js';
import type { Actor } from '../lib/auth.js';
import { resourceSelf } from '../lib/http.js';

// ---------- share-permission evaluation ----------

type PermRow = { kind: string; type: string; target: string | null; target2: string | null };

async function userGroupIds(actor: Actor): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({
    where: { userId: actor.user.id },
    select: { groupId: true },
  });
  return rows.map((r) => r.groupId);
}

async function permMatches(p: PermRow, actor: Actor): Promise<boolean> {
  switch (p.type) {
    case 'global':
    case 'loggedin':
      return true;
    case 'user':
      return p.target === actor.user.id;
    case 'group': {
      if (!p.target) return false;
      const g = await prisma.group.findFirst({
        where: { name: p.target, members: { some: { userId: actor.user.id } } },
        select: { id: true },
      });
      return Boolean(g);
    }
    case 'project': {
      if (!p.target) return false;
      const proj = await prisma.project.findUnique({ where: { key: p.target }, select: { id: true } });
      return proj ? hasPermission(actor, 'BROWSE_PROJECTS', { projectId: proj.id }) : false;
    }
    case 'project-role': {
      if (!p.target || !p.target2) return false;
      const proj = await prisma.project.findUnique({ where: { key: p.target2 }, select: { id: true } });
      if (!proj) return false;
      const groupIds = await userGroupIds(actor);
      const actorRow = await prisma.projectRoleActor.findFirst({
        where: {
          roleId: p.target,
          projectId: proj.id,
          OR: [{ userId: actor.user.id }, { groupId: { in: groupIds } }],
        },
        select: { id: true },
      });
      return Boolean(actorRow);
    }
    default:
      return false;
  }
}

type DashboardWithPerms = {
  id: string;
  ownerId: string;
  permissions: PermRow[];
};

async function hasPermKind(d: DashboardWithPerms, kind: string, actor: Actor): Promise<boolean> {
  for (const p of d.permissions) {
    if (p.kind === kind && (await permMatches(p, actor))) return true;
  }
  return false;
}

export async function canViewDashboard(d: DashboardWithPerms, actor: Actor): Promise<boolean> {
  if (d.ownerId === actor.user.id || actor.user.isAdmin) return true;
  return (await hasPermKind(d, 'view', actor)) || (await hasPermKind(d, 'edit', actor));
}

export async function canEditDashboard(d: DashboardWithPerms, actor: Actor): Promise<boolean> {
  if (d.ownerId === actor.user.id || actor.user.isAdmin) return true;
  return hasPermKind(d, 'edit', actor);
}

const dashInclude = {
  owner: { select: { displayName: true } },
  permissions: true,
  gadgets: { orderBy: [{ column: 'asc' as const }, { position: 'asc' as const }] },
};

async function requireDashboard(id: string) {
  const d = await prisma.dashboard.findUnique({ where: { id }, include: dashInclude });
  if (!d) throw new JiraApiError(404, jiraError(['Dashboard does not exist.']));
  return d;
}

async function requireVisible(id: string, actor: Actor) {
  const d = await requireDashboard(id);
  if (!(await canViewDashboard(d, actor))) {
    throw new JiraApiError(404, jiraError(['Dashboard does not exist.']));
  }
  return d;
}

async function requireEditable(id: string, actor: Actor) {
  const d = await requireVisible(id, actor);
  if (!(await canEditDashboard(d, actor))) {
    throw new JiraApiError(403, jiraError(['You do not have permission to edit this dashboard.']));
  }
  return d;
}

// ---------- serialization ----------

type GadgetRow = { id: string; type: string; config: unknown; position: number; column: number };

function toGadgetResponse(g: GadgetRow, dashboardId: string) {
  return {
    id: g.id,
    self: resourceSelf(`/rest/api/2/dashboard/${dashboardId}/gadget/${g.id}`),
    type: g.type,
    title: GADGET_REGISTRY[g.type]?.title ?? g.type,
    position: { row: g.position, column: g.column },
    config: g.config,
  };
}

export function toDashboardResponse(d: {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  isSystemDefault: boolean;
  layout: unknown;
  owner: { displayName: string };
}) {
  return {
    id: d.id,
    self: resourceSelf(`/rest/api/2/dashboard/${d.id}`),
    name: d.name,
    description: d.description ?? undefined,
    owner: { name: d.owner.displayName },
    layout: d.layout,
    isSystemDefault: d.isSystemDefault || undefined,
  };
}

const PERM_TYPES = new Set(['global', 'loggedin', 'group', 'project', 'project-role', 'user']);

function normalizePerm(input: unknown, kind: string) {
  const p = input as { type?: string; target?: string; target2?: string };
  const type = String(p?.type ?? '');
  if (!PERM_TYPES.has(type)) {
    throw new JiraApiError(400, jiraError([`Invalid share permission type '${type}'.`]));
  }
  const target = p.target !== undefined ? String(p.target) : null;
  const target2 = p.target2 !== undefined ? String(p.target2) : null;
  if ((type === 'group' || type === 'project' || type === 'user') && !target) {
    throw new JiraApiError(400, jiraError([`Share permission type '${type}' requires a target.`]));
  }
  if (type === 'project-role' && (!target || !target2)) {
    throw new JiraApiError(
      400,
      jiraError([`Share permission type 'project-role' requires target (role id) and target2 (project key).`])
    );
  }
  return { kind, type, target, target2 };
}

// ---------- CRUD ----------

export async function listDashboards(actor: Actor) {
  // Candidates: mine + system defaults + all shared rows (narrowed in JS —
  // perm evaluation needs group/role resolution per row anyway).
  const candidates = await prisma.dashboard.findMany({
    where: {
      OR: [{ ownerId: actor.user.id }, { isSystemDefault: true }, { permissions: { some: {} } }],
    },
    include: { owner: { select: { displayName: true } }, permissions: true },
    orderBy: { name: 'asc' },
  });
  const visible: typeof candidates = [];
  for (const d of candidates) {
    if (await canViewDashboard(d, actor)) visible.push(d);
  }
  return visible.map(toDashboardResponse);
}

export async function createDashboard(
  actor: Actor,
  input: {
    name: string;
    description?: string;
    layout?: { columns?: number };
    sharePermissions?: unknown[];
    editPermissions?: unknown[];
  }
) {
  if (!input.name?.trim()) throw new JiraApiError(400, jiraError([], { name: 'Name is required.' }));
  const share = (input.sharePermissions ?? [{ type: 'loggedin' }]).map((p) => normalizePerm(p, 'view'));
  const edit = (input.editPermissions ?? []).map((p) => normalizePerm(p, 'edit'));
  const columns = Math.min(3, Math.max(1, input.layout?.columns ?? 2));
  const d = await prisma.dashboard.create({
    data: {
      ownerId: actor.user.id,
      name: input.name.trim(),
      description: input.description ?? null,
      layout: { columns },
      permissions: { create: [...share, ...edit] },
    },
    include: { owner: { select: { displayName: true } } },
  });
  return toDashboardResponse(d);
}

export async function getDashboard(actor: Actor, id: string) {
  const d = await requireVisible(id, actor);
  return {
    ...toDashboardResponse(d),
    gadgets: d.gadgets.map((g) => toGadgetResponse(g, d.id)),
    sharePermissions: d.permissions.filter((p) => p.kind === 'view'),
    editPermissions: d.permissions.filter((p) => p.kind === 'edit'),
  };
}

export async function updateDashboard(
  actor: Actor,
  id: string,
  input: {
    name?: string;
    description?: string | null;
    layout?: { columns?: number };
    sharePermissions?: unknown[];
    editPermissions?: unknown[];
  }
) {
  const d = await requireEditable(id, actor);
  const share = input.sharePermissions?.map((p) => normalizePerm(p, 'view'));
  const edit = input.editPermissions?.map((p) => normalizePerm(p, 'edit'));
  const updated = await prisma.$transaction(async (tx) => {
    if (share || edit) {
      await tx.dashboardPermission.deleteMany({ where: { dashboardId: id } });
      for (const p of [...(share ?? []), ...(edit ?? [])]) {
        await tx.dashboardPermission.create({ data: { dashboardId: id, ...p } });
      }
    }
    return tx.dashboard.update({
      where: { id: d.id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.layout?.columns ? { layout: { columns: Math.min(3, Math.max(1, input.layout.columns)) } } : {}),
      },
      include: { owner: { select: { displayName: true } } },
    });
  });
  return toDashboardResponse(updated);
}

export async function deleteDashboard(actor: Actor, id: string) {
  const d = await requireDashboard(id);
  if (d.ownerId !== actor.user.id && !actor.user.isAdmin) {
    throw new JiraApiError(404, jiraError(['Dashboard does not exist.']));
  }
  await prisma.dashboard.delete({ where: { id: d.id } });
}

export async function copyDashboard(actor: Actor, id: string, name?: string) {
  const d = await requireVisible(id, actor);
  const copy = await prisma.dashboard.create({
    data: {
      ownerId: actor.user.id,
      name: name?.trim() || `Copy of ${d.name}`,
      description: d.description,
      layout: d.layout as object,
      gadgets: {
        create: d.gadgets.map((g) => ({
          type: g.type,
          config: g.config as object,
          position: g.position,
          column: g.column,
        })),
      },
      // Copied dashboards start private (Jira behavior).
    },
    include: { owner: { select: { displayName: true } } },
  });
  return toDashboardResponse(copy);
}

// ---------- gadget CRUD ----------

export async function addGadget(
  actor: Actor,
  dashboardId: string,
  input: { type: string; config?: Record<string, unknown>; position?: number; column?: number }
) {
  const d = await requireEditable(dashboardId, actor);
  if (!GADGET_REGISTRY[input.type]) {
    throw new JiraApiError(
      400,
      jiraError([`Unknown gadget type '${input.type}'. Available: ${Object.keys(GADGET_REGISTRY).join(', ')}`])
    );
  }
  // 057 US5 — declared defaults satisfy required fields; an untouched config
  // form must not 400 (pie statType=status, 2-D xstatType/ystatType, …).
  const config: Record<string, unknown> = {
    ...Object.fromEntries(
      GADGET_REGISTRY[input.type].configFields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])
    ),
    ...(input.config ?? {}),
  };
  const missing = GADGET_REGISTRY[input.type].configFields
    .filter((f) => f.required && config[f.key] === undefined)
    .map((f) => f.key);
  if (missing.length) {
    throw new JiraApiError(400, jiraError([], { config: `Missing required config: ${missing.join(', ')}` }));
  }
  const maxPos = await prisma.dashboardGadget.aggregate({
    where: { dashboardId: d.id, column: input.column ?? 0 },
    _max: { position: true },
  });
  const count = await prisma.dashboardGadget.count({ where: { dashboardId: d.id } });
  if (count >= 20) {
    throw new JiraApiError(400, jiraError(['Dashboard gadget cap reached (20).']));
  }
  const g = await prisma.dashboardGadget.create({
    data: {
      dashboardId: d.id,
      type: input.type,
      config: config as object,
      position: input.position ?? (maxPos._max.position ?? -1) + 1,
      column: Math.min(2, Math.max(0, input.column ?? 0)),
    },
  });
  return toGadgetResponse(g, d.id);
}

export async function updateGadget(
  actor: Actor,
  dashboardId: string,
  gadgetId: string,
  input: { config?: Record<string, unknown>; position?: number; column?: number }
) {
  const d = await requireEditable(dashboardId, actor);
  const g = await prisma.dashboardGadget.findFirst({ where: { id: gadgetId, dashboardId: d.id } });
  if (!g) throw new JiraApiError(404, jiraError(['Gadget does not exist.']));
  const updated = await prisma.dashboardGadget.update({
    where: { id: g.id },
    data: {
      ...(input.config !== undefined ? { config: input.config as object } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.column !== undefined ? { column: Math.min(2, Math.max(0, input.column)) } : {}),
    },
  });
  return toGadgetResponse(updated, d.id);
}

export async function deleteGadget(actor: Actor, dashboardId: string, gadgetId: string) {
  const d = await requireEditable(dashboardId, actor);
  const res = await prisma.dashboardGadget.deleteMany({ where: { id: gadgetId, dashboardId: d.id } });
  if (!res.count) throw new JiraApiError(404, jiraError(['Gadget does not exist.']));
}

// ---------- gadget registry + data resolvers ----------

type FieldType = 'jql' | 'filter' | 'number' | 'field' | 'board' | 'project' | 'boolean' | 'columns';
interface ConfigField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: unknown;
}
interface GadgetDef {
  title: string;
  description: string;
  configFields: ConfigField[];
  resolve: (config: Record<string, unknown>, actor: Actor) => Promise<unknown>;
}

const MAX_GADGET_ISSUES = 500;

async function searchIssuesFor(actor: Actor, jql: string, max: number, fields?: string[]) {
  const r = await executeSearch(actor, { jql, startAt: 0, maxResults: Math.min(max, MAX_GADGET_ISSUES), fields });
  return r;
}

const FIELD_GET: Record<string, (f: Record<string, unknown>) => string> = {
  status: (f) => (f.status as { name?: string } | undefined)?.name ?? 'None',
  priority: (f) => (f.priority as { name?: string } | undefined)?.name ?? 'None',
  issuetype: (f) => (f.issuetype as { name?: string } | undefined)?.name ?? 'None',
  assignee: (f) => (f.assignee as { displayName?: string } | undefined)?.displayName ?? 'Unassigned',
  reporter: (f) => (f.reporter as { displayName?: string } | undefined)?.displayName ?? 'None',
  project: (f) => (f.project as { key?: string } | undefined)?.key ?? 'None',
  resolution: (f) => (f.resolution as { name?: string } | undefined)?.name ?? 'Unresolved',
};

const STAT_FIELDS: ConfigField = {
  key: 'statType',
  label: 'Group by',
  type: 'field',
  required: true,
  default: 'status',
};

const MAX_RESULTS_FIELD: ConfigField = {
  key: 'maxResults',
  label: 'Number of results',
  type: 'number',
  default: 10,
};

export const GADGET_REGISTRY: Record<string, GadgetDef> = {
  'assigned-to-me': {
    title: 'Assigned to Me',
    description: 'Open issues assigned to the current user.',
    configFields: [MAX_RESULTS_FIELD],
    resolve: async (cfg, actor) => {
      const r = await searchIssuesFor(
        actor,
        'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC',
        Number(cfg.maxResults) || 10
      );
      return { issues: r.issues, total: r.total };
    },
  },
  'filter-results': {
    title: 'Filter Results',
    description: 'Issues returned by a saved filter.',
    configFields: [
      { key: 'filterId', label: 'Saved filter', type: 'filter', required: true },
      MAX_RESULTS_FIELD,
      { key: 'columns', label: 'Columns', type: 'columns' },
    ],
    resolve: async (cfg, actor) => {
      const f = await prisma.filter.findUnique({ where: { id: String(cfg.filterId) } });
      if (!f || (f.visibility !== 'all' && f.ownerId !== actor.user.id && !actor.user.isAdmin)) {
        return { error: 'filter-not-found', message: 'The saved filter does not exist or is not visible.' };
      }
      const r = await searchIssuesFor(actor, f.jql, Number(cfg.maxResults) || 10);
      return { filter: { id: f.id, name: f.name, jql: f.jql }, issues: r.issues, total: r.total };
    },
  },
  'recently-updated': {
    title: 'Recently Updated',
    description: 'Most recently updated issues, optionally scoped to a project.',
    configFields: [{ key: 'projectKey', label: 'Project', type: 'project' }, MAX_RESULTS_FIELD],
    resolve: async (cfg, actor) => {
      const jql = cfg.projectKey ? `project = ${cfg.projectKey} ORDER BY updated DESC` : 'ORDER BY updated DESC';
      const r = await searchIssuesFor(actor, jql, Number(cfg.maxResults) || 10);
      return { issues: r.issues, total: r.total };
    },
  },
  'watched-issues': {
    title: 'Watched Issues',
    description: 'Open issues the current user watches.',
    configFields: [MAX_RESULTS_FIELD],
    resolve: async (cfg, actor) => {
      const rows = await prisma.watcher.findMany({
        where: { userId: actor.user.id },
        select: { issue: { select: { project: { select: { key: true } }, issueNumber: true } } },
      });
      if (!rows.length) return { issues: [], total: 0 };
      const keys = rows.map((r) => `${r.issue.project.key}-${r.issue.issueNumber}`);
      const r = await searchIssuesFor(
        actor,
        `key IN (${keys.join(',')}) ORDER BY updated DESC`,
        Number(cfg.maxResults) || 10
      );
      return { issues: r.issues, total: r.total };
    },
  },
  'pie-chart': {
    title: 'Pie Chart',
    description: 'Issue counts grouped by a field, over a JQL filter.',
    configFields: [{ key: 'jql', label: 'Filter (JQL)', type: 'jql', required: true }, STAT_FIELDS],
    resolve: async (cfg, actor) => {
      const stat = String(cfg.statType ?? 'status');
      const get = FIELD_GET[stat];
      if (!get) return { error: 'bad-statType', message: `Cannot group by '${stat}'.` };
      const r = await searchIssuesFor(actor, String(cfg.jql), MAX_GADGET_ISSUES);
      const counts = new Map<string, number>();
      for (const i of r.issues) {
        const k = get(i.fields as Record<string, unknown>);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return {
        statType: stat,
        total: r.total,
        truncated: r.total > r.issues.length,
        groups: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      };
    },
  },
  'two-dimensional': {
    title: 'Two-Dimensional Filter Statistics',
    description: 'Issue counts in an xField × yField matrix over a JQL filter.',
    configFields: [
      { key: 'jql', label: 'Filter (JQL)', type: 'jql', required: true },
      { key: 'xstatType', label: 'X axis', type: 'field', required: true, default: 'status' },
      { key: 'ystatType', label: 'Y axis', type: 'field', required: true, default: 'assignee' },
    ],
    resolve: async (cfg, actor) => {
      const gx = FIELD_GET[String(cfg.xstatType ?? 'status')];
      const gy = FIELD_GET[String(cfg.ystatType ?? 'assignee')];
      if (!gx || !gy) return { error: 'bad-statType', message: 'Axis fields must be grouping-capable.' };
      const r = await searchIssuesFor(actor, String(cfg.jql), MAX_GADGET_ISSUES);
      const cells = new Map<string, number>();
      const xs = new Set<string>();
      const ys = new Set<string>();
      for (const i of r.issues) {
        const x = gx(i.fields as Record<string, unknown>);
        const y = gy(i.fields as Record<string, unknown>);
        xs.add(x);
        ys.add(y);
        // 057 US5 — JSON tuple key: unambiguous even when x+y concatenations collide
        const k = JSON.stringify([x, y]);
        cells.set(k, (cells.get(k) ?? 0) + 1);
      }
      return {
        xstatType: cfg.xstatType,
        ystatType: cfg.ystatType,
        total: r.total,
        truncated: r.total > r.issues.length,
        xLabels: [...xs],
        yLabels: [...ys],
        cells: Object.fromEntries(cells),
      };
    },
  },
  'created-vs-resolved': {
    title: 'Created vs Resolved',
    description: 'Daily created vs resolved issue counts over a JQL filter.',
    configFields: [
      { key: 'jql', label: 'Filter (JQL)', type: 'jql', required: true },
      { key: 'days', label: 'Days back', type: 'number', default: 30 },
    ],
    resolve: async (cfg, actor) => {
      const r = await searchIssuesFor(actor, String(cfg.jql), MAX_GADGET_ISSUES, ['created', 'resolutiondate', 'key']);
      const days = Math.min(365, Number(cfg.days) || 30);
      const since = new Date(Date.now() - days * 86400_000);
      const created = new Map<string, number>();
      const resolved = new Map<string, number>();
      const day = (iso?: string) => (iso ? iso.slice(0, 10) : undefined);
      for (const i of r.issues) {
        const f = i.fields as { created?: string; resolutiondate?: string };
        const c = day(f.created);
        if (c && new Date(c) >= since) created.set(c, (created.get(c) ?? 0) + 1);
        const rd = day(f.resolutiondate);
        if (rd && new Date(rd) >= since) resolved.set(rd, (resolved.get(rd) ?? 0) + 1);
      }
      return {
        days,
        truncated: r.total > r.issues.length,
        created: Object.fromEntries([...created.entries()].sort()),
        resolved: Object.fromEntries([...resolved.entries()].sort()),
      };
    },
  },
  'sprint-health': {
    title: 'Sprint Health',
    description: 'Active-sprint progress: issue counts by status category.',
    configFields: [{ key: 'boardId', label: 'Board', type: 'board', required: true }],
    resolve: async (cfg, _actor) => {
      const sprint = await prisma.sprint.findFirst({
        where: { boardId: String(cfg.boardId), state: 'active' },
        select: { id: true, name: true, startDate: true, endDate: true },
      });
      if (!sprint) return { sprint: null, message: 'No active sprint on this board.' };
      const counts = { todo: 0, inProgress: 0, done: 0, other: 0 };
      const issues = await prisma.issue.findMany({
        where: { sprintId: sprint.id },
        select: { status: { select: { category: true } } },
      });
      for (const i of issues) {
        const c = i.status.category;
        if (c === 'done') counts.done++;
        else if (c === 'inprogress') counts.inProgress++;
        else if (c === 'todo') counts.todo++;
        else counts.other++;
      }
      return { sprint, total: issues.length, counts };
    },
  },
  'burndown-chart': {
    title: 'Sprint Burndown Chart',
    description: 'Daily remaining-points series for a sprint (default: active).',
    configFields: [
      { key: 'boardId', label: 'Board', type: 'board', required: true },
      { key: 'sprintId', label: 'Sprint (blank = active)', type: 'number' },
    ],
    resolve: async (cfg, actor) => {
      try {
        return await getBurndown(actor, String(cfg.boardId), cfg.sprintId ? String(cfg.sprintId) : undefined);
      } catch (err) {
        if (err instanceof JiraApiError && err.status === 404) {
          return { sprint: null, message: 'No active/matching sprint on this board.' };
        }
        throw err;
      }
    },
  },
  'velocity-chart': {
    title: 'Velocity Chart',
    description: 'Committed vs completed story points per closed sprint.',
    configFields: [{ key: 'boardId', label: 'Board', type: 'board', required: true }],
    resolve: async (cfg, actor) => getVelocity(actor, String(cfg.boardId)),
  },
  'activity-stream': {
    title: 'Activity Stream',
    description: 'Recent domain events, scoped like the events feed.',
    configFields: [{ key: 'projectKey', label: 'Project', type: 'project' }, MAX_RESULTS_FIELD],
    resolve: async (cfg, actor) => {
      // Same scoping as /api/internal/events: token allow-list ∩ requested.
      const allow = actor.token?.projectKeys;
      const requested = cfg.projectKey ? [String(cfg.projectKey).toUpperCase()] : [];
      const keys = allow?.length ? (requested.length ? requested.filter((k) => allow.includes(k)) : allow) : requested;
      const rows = await prisma.domainEvent.findMany({
        where: keys.length || allow?.length ? { project: { key: { in: keys } } } : {},
        orderBy: { id: 'desc' },
        take: Math.min(50, Number(cfg.maxResults) || 10),
      });
      return { events: rows.map(toEventResponse) };
    },
  },
};

export function gadgetRegistry() {
  return Object.entries(GADGET_REGISTRY).map(([type, g]) => ({
    type,
    title: g.title,
    description: g.description,
    configFields: g.configFields,
  }));
}

export async function gadgetData(actor: Actor, dashboardId: string, gadgetId: string) {
  const d = await requireVisible(dashboardId, actor);
  const g = d.gadgets.find((x) => x.id === gadgetId);
  if (!g) throw new JiraApiError(404, jiraError(['Gadget does not exist.']));
  const def = GADGET_REGISTRY[g.type];
  if (!def) return { type: g.type, error: 'unknown-gadget-type' };
  try {
    const data = await def.resolve((g.config ?? {}) as Record<string, unknown>, actor);
    return { type: g.type, title: def.title, data };
  } catch (err) {
    // A gadget must never crash the dashboard — Jira shows a configure-me card.
    return { type: g.type, title: def.title, error: (err as Error).message };
  }
}

export async function dashboardData(actor: Actor, dashboardId: string) {
  const d = await requireVisible(dashboardId, actor);
  const out = [];
  for (const g of d.gadgets) {
    const def = GADGET_REGISTRY[g.type];
    let data: unknown;
    let error: string | undefined;
    try {
      data = def
        ? await def.resolve((g.config ?? {}) as Record<string, unknown>, actor)
        : { error: 'unknown-gadget-type' };
    } catch (err) {
      error = (err as Error).message;
    }
    out.push({
      gadget: toGadgetResponse(g, d.id),
      ...(error ? { error } : { data }),
    });
  }
  return { dashboard: toDashboardResponse(d), gadgets: out };
}

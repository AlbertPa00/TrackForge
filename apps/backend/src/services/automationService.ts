// Sprint 034 — automation engine. DomainEvents dispatched by the outbox tick
// are matched against enabled rules (WHEN trigger IF conditions THEN actions);
// actions run through the normal service layer as the rule actor on channel
// 'automation'. Automation-emitted events are post-annotated with the rule
// chain (jsonb payload.automation) so same-rule recursion and deep chains are
// structurally excluded (FR-004). Effective permissions are actor ∩ author.

import type { AutomationRule, AutomationRun, DomainEvent } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { parseJql } from '../jql/parser.js';
import { compileJql } from '../jql/compiler.js';
import { hasPermission } from './permissionService.js';
import { resolveUserRef } from './userService.js';
import * as issueService from './issueService.js';
import { addComment } from './commentService.js';
import { createLink } from './linkService.js';
import { egressFetch } from '../lib/egress.js';
import type { EventPayload } from './eventService.js';
import type { Prisma } from '@prisma/client';

const j = (v: unknown) => v as Prisma.InputJsonValue;

/** 064 US4 — who may run/inspect a rule: its author, the project admin of the
 *  rule's project, or a site admin. */
export async function canManageRule(
  actor: Actor,
  r: { createdById: string; projectId: string | null }
): Promise<boolean> {
  return (
    actor.user.isAdmin ||
    r.createdById === actor.user.id ||
    (!!r.projectId && (await hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId: r.projectId })))
  );
}

/** Read-path rule load — 404 hides existence for non-managers. */
export async function loadRuleManaged(
  actor: Actor,
  id: string,
  opts: { include?: Prisma.AutomationRuleInclude; message?: string } = {}
): Promise<AutomationRule> {
  const r = await prisma.automationRule.findUnique({
    where: { id },
    ...(opts.include ? { include: opts.include } : {}),
  });
  if (!r || !(await canManageRule(actor, r))) {
    throw new JiraApiError(404, jiraError([opts.message ?? 'Rule not found']));
  }
  return r as AutomationRule;
}

/** Write-path rule load — 404 when absent, 403 naming the requirement when
 *  the actor isn't author/project-admin/site-admin. */
export async function loadRuleForWrite(actor: Actor, id: string): Promise<AutomationRule> {
  const r = await prisma.automationRule.findUnique({ where: { id } });
  if (!r) throw new JiraApiError(404, jiraError(['Rule not found']));
  if (!(await canManageRule(actor, r))) {
    throw new JiraApiError(403, jiraError(['rule author, project admin or site admin required']));
  }
  return r;
}

const MAX_DEPTH = 5;
const SMART_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

// ---------- smart values ----------
// {{issue.key}}, {{issue.summary}}, {{actor.displayName}}, {{trigger.comment.body}}…
// Values are escaped for Markdown when used in comment bodies (threat model).
export function expandSmart(template: string, ctx: RunCtx, escapeMd = false): string {
  return template.replace(SMART_RE, (_, path: string) => {
    const segs = path.split('.');
    let val = resolvePath(ctx, segs);
    // {{issue.X}} fallback — the response snapshot nests scalars under fields.*
    if (val === undefined && segs[0] === 'issue' && ctx.issue) {
      const f = (ctx.issue.fields ?? {}) as Record<string, unknown>;
      val = resolvePath({ issue: { ...ctx.issue, ...f } } as RunCtx, segs);
    }
    if (val === undefined || val === null) return '';
    let s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (escapeMd) s = s.replace(/([\\`*_[\]<>|])/g, '\\$1');
    return s;
  });
}

interface RunCtx {
  issue: Record<string, unknown> | null;
  actor: { accountId: string; displayName?: string } | null;
  trigger: Record<string, unknown>;
}
function resolvePath(ctx: RunCtx, segs: string[]): unknown {
  let cur: unknown = ctx;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

// ---------- type registry ----------
export interface RegistryEntry {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** triggers match events; conditions evaluate; actions execute */
  match?: (cfg: unknown, ev: DomainEvent) => boolean;
  evaluate?: (cfg: unknown, ctx: RunCtx, actor: Actor) => Promise<boolean>;
  execute?: (cfg: unknown, ctx: RunCtx, actor: Actor, run: AutomationRun) => Promise<Record<string, unknown>>;
}

const triggerSchemas: Record<string, RegistryEntry> = {};
const conditionRegistry: Record<string, RegistryEntry> = {};
const actionRegistry: Record<string, RegistryEntry> = {};

function reg(map: Record<string, RegistryEntry>, e: RegistryEntry) {
  map[e.name] = e;
}

// ---- triggers ----
const eventTrigger = (name: string, types: string[], extra: z.ZodRawShape = {}, match?: RegistryEntry['match']) =>
  reg(triggerSchemas, {
    name,
    description: `Fires on ${types.join(', ')}`,
    schema: z.object({ type: z.literal(name), ...extra }).passthrough(),
    match: match ?? ((_, ev) => types.includes(ev.type)),
  });

eventTrigger('issue_created', ['jira:issue_created']);
eventTrigger(
  'issue_updated',
  ['jira:issue_updated'],
  {
    fields: z.array(z.string()).optional(), // only fire when these changelog fields changed
  },
  (cfg, ev) => {
    const fields = (cfg as { fields?: string[] }).fields;
    if (!fields?.length) return true;
    const items = ((ev.payload as EventPayload).changelog?.items ?? []) as { field?: string }[];
    return items.some((i) => fields.some((f) => (i.field ?? '').toLowerCase() === f.toLowerCase()));
  }
);
eventTrigger('issue_assigned', ['jira:issue_updated'], {}, (_, ev) => {
  const items = ((ev.payload as EventPayload).changelog?.items ?? []) as { field?: string }[];
  return items.some((i) => i.field === 'assignee');
});
eventTrigger(
  'issue_transitioned',
  ['jira:issue_updated'],
  {
    toStatus: z.string().optional(),
  },
  (cfg, ev) => {
    const items = ((ev.payload as EventPayload).changelog?.items ?? []) as { field?: string; toString?: string }[];
    const st = items.find((i) => i.field === 'status');
    if (!st) return false;
    const to = (cfg as { toStatus?: string }).toStatus;
    return !to || (st.toString ?? '').toLowerCase() === to.toLowerCase();
  }
);
eventTrigger('comment_created', ['comment_created']);
eventTrigger('issue_deleted', ['jira:issue_deleted']);
eventTrigger(
  'issue_linked',
  ['issuelink_created'],
  {
    linkType: z.string().optional(),
  },
  (cfg, ev) => {
    const lt = (cfg as { linkType?: string }).linkType;
    if (!lt) return true;
    const link = (ev.payload as EventPayload).link as { type?: { name?: string } } | undefined;
    return (link?.type?.name ?? '').toLowerCase() === lt.toLowerCase();
  }
);
eventTrigger('work_logged', ['worklog_created']);
reg(triggerSchemas, {
  name: 'manual',
  description: 'Fired via POST /rules/{id}/run or MCP run_rule',
  schema: z.object({ type: z.literal('manual'), jql: z.string().optional() }).passthrough(),
});
reg(triggerSchemas, {
  name: 'scheduled',
  description: 'Cron schedule + JQL selection; runs on the durable runner tick',
  schema: z.object({ type: z.literal('scheduled'), cron: z.string(), jql: z.string() }).passthrough(),
});

// ---- conditions ----
reg(conditionRegistry, {
  name: 'jql',
  description: 'Issue must match a JQL predicate',
  schema: z.object({ type: z.literal('jql'), jql: z.string() }).passthrough(),
  evaluate: async (cfg, ctx, actor) => {
    const jql = (cfg as { jql: string }).jql;
    const issue = ctx.issue as { key?: string } | null;
    if (!issue?.key) return false;
    const compiled = await compileJql(parseJql(`(${jql}) AND key = ${issue.key}`), actor);
    const n = await prisma.issue.count({ where: compiled.where });
    return n > 0;
  },
});
reg(conditionRegistry, {
  name: 'field_equals',
  description: 'Issue field equals a value (fields.* response paths, e.g. fields.status.name)',
  schema: z
    .object({
      type: z.literal('field_equals'),
      field: z.string(),
      value: z.unknown(),
      ignoreCase: z.boolean().optional(),
    })
    .passthrough(),
  evaluate: async (cfg, ctx) => {
    const c = cfg as { field: string; value: unknown; ignoreCase?: boolean };
    const issue = ctx.issue as Record<string, unknown> | null;
    if (!issue) return false;
    // allow "fields.X" or bare "X"; resolve nested paths on the issue snapshot
    const path = c.field.replace(/^fields\./, '').split('.');
    let cur: unknown = (issue.fields as Record<string, unknown> | undefined) ?? issue;
    for (const s of path) {
      if (cur === null || typeof cur !== 'object') {
        cur = undefined;
        break;
      }
      cur = (cur as Record<string, unknown>)[s];
    }
    if (typeof cur === 'string' && typeof c.value === 'string')
      return c.ignoreCase === false ? cur === c.value : cur.toLowerCase() === c.value.toLowerCase();
    return cur === c.value || JSON.stringify(cur) === JSON.stringify(c.value);
  },
});
reg(conditionRegistry, {
  name: 'user_in_group',
  description: 'Field user (assignee|reporter|event actor) is in group',
  schema: z
    .object({ type: z.literal('user_in_group'), field: z.string().default('actor'), group: z.string() })
    .passthrough(),
  evaluate: async (cfg, ctx, _actor) => {
    const c = cfg as { field?: string; group: string };
    let userId: string | undefined;
    if ((c.field ?? 'actor') === 'actor') userId = ctx.actor?.accountId;
    else {
      const f = (ctx.issue?.fields as Record<string, unknown> | undefined)?.[c.field!] as
        | { accountId?: string }
        | null
        | undefined;
      userId = f?.accountId ?? undefined;
    }
    if (!userId) return false;
    const m = await prisma.groupMember.findFirst({ where: { userId, group: { name: c.group } } });
    return !!m;
  },
});
reg(conditionRegistry, {
  name: 'user_in_role',
  description: 'Field user (assignee|reporter|actor) holds a project role',
  schema: z
    .object({ type: z.literal('user_in_role'), field: z.string().default('actor'), role: z.string() })
    .passthrough(),
  evaluate: async (cfg, ctx) => {
    const c = cfg as { field?: string; role: string };
    let userId: string | undefined;
    if ((c.field ?? 'actor') === 'actor') userId = ctx.actor?.accountId;
    else
      userId =
        (
          (ctx.issue?.fields as Record<string, unknown> | undefined)?.[c.field!] as
            | { accountId?: string }
            | null
            | undefined
        )?.accountId ?? undefined;
    const projectId = (ctx.issue as { fields?: { project?: { id?: string } } } | null)?.fields?.project?.id;
    if (!userId || !projectId) return false;
    const m = await prisma.projectRoleActor.findFirst({
      where: { role: { name: { equals: c.role, mode: 'insensitive' } }, projectId: String(projectId), userId },
    });
    return !!m;
  },
});
reg(conditionRegistry, {
  name: 'linked_issues_exist',
  description: 'Issue has at least one link (optionally of a link type)',
  schema: z.object({ type: z.literal('linked_issues_exist'), linkType: z.string().optional() }).passthrough(),
  evaluate: async (cfg, ctx) => {
    const c = cfg as { linkType?: string };
    const issue = ctx.issue as { id?: string } | null;
    if (!issue?.id) return false;
    const n = await prisma.issueLink.count({
      where: {
        OR: [{ outwardId: issue.id }, { inwardId: issue.id }],
        ...(c.linkType ? { type: { name: { equals: c.linkType, mode: 'insensitive' } } } : {}),
      },
    });
    return n > 0;
  },
});

// ---- actions ----
reg(actionRegistry, {
  name: 'edit_fields',
  description: 'Set fields via the normal update path (summary, priority, assignee, labels, customFields…)',
  schema: z.object({ type: z.literal('edit_fields'), fields: z.record(z.unknown()) }).passthrough(),
  execute: async (cfg, ctx, actor) => {
    const key = (ctx.issue as { key?: string } | null)?.key;
    if (!key) throw new JiraApiError(400, jiraError(['edit_fields requires an issue']));
    const fields = expandObj((cfg as { fields: Record<string, unknown> }).fields, ctx) as Record<string, unknown>;
    const data = fieldsToUpdateInput(fields);
    await issueService.updateIssue(key, data, actor);
    return { issueKey: key, updated: Object.keys(fields) };
  },
});
reg(actionRegistry, {
  name: 'transition',
  description: 'Transition by transition id, name or destination status name',
  schema: z.object({ type: z.literal('transition'), to: z.string(), comment: z.string().optional() }).passthrough(),
  execute: async (cfg, ctx, actor) => {
    const c = cfg as { to: string; comment?: string };
    const key = (ctx.issue as { key?: string } | null)?.key;
    if (!key) throw new JiraApiError(400, jiraError(['transition requires an issue']));
    const to = expandSmart(c.to, ctx);
    const list = (await issueService.getIssueTransitions(key, actor)) as unknown as {
      id: string;
      name?: string;
      to?: { name?: string };
    }[];
    const t = list.find(
      (x) => x.id === to || x.name?.toLowerCase() === to.toLowerCase() || x.to?.name?.toLowerCase() === to.toLowerCase()
    );
    if (!t)
      throw new JiraApiError(
        400,
        jiraError([`No transition matching '${to}'. Available: ${list.map((x) => x.name ?? x.id).join(', ')}`])
      );
    await issueService.executeTransition(
      key,
      t.id,
      actor,
      c.comment ? { update: { comment: [{ add: { body: expandSmart(c.comment, ctx, true) } }] } } : {}
    );
    return { issueKey: key, transition: t.name ?? t.id };
  },
});
reg(actionRegistry, {
  name: 'assign',
  description: 'Assign to a user (accountId/name), "unassigned", "reporter", or "lead"',
  schema: z.object({ type: z.literal('assign'), to: z.string() }).passthrough(),
  execute: async (cfg, ctx, actor) => {
    const key = (ctx.issue as { key?: string } | null)?.key;
    if (!key) throw new JiraApiError(400, jiraError(['assign requires an issue']));
    const to = expandSmart((cfg as { to: string }).to, ctx);
    // 057 US2 — every documented value resolves: 'reporter' comes from the
    // triggering issue's fields; an accountId (or email/displayName) resolves
    // through both ref keys instead of being looked up by name only.
    const fields = (ctx.issue as { fields?: Record<string, { accountId?: string } | null> } | null)?.fields;
    const reporterId = fields?.reporter?.accountId;
    if (to === 'reporter' && !reporterId) {
      throw new JiraApiError(400, jiraError(['assign to reporter requires an issue with a reporter.']));
    }
    const data =
      to === 'unassigned'
        ? { assignee: null }
        : to === 'lead'
          ? { assignee: { accountId: await projectLeadId(ctx) } }
          : to === 'reporter'
            ? { assignee: { accountId: reporterId } }
            : { assignee: { accountId: to, name: to } };
    await issueService.updateIssue(key, data as issueService.UpdateIssueInput, actor);
    return { issueKey: key, assignee: to };
  },
});
reg(actionRegistry, {
  name: 'comment',
  description: 'Add a comment (smart values expanded, Markdown-escaped)',
  schema: z.object({ type: z.literal('comment'), body: z.string(), visibility: z.unknown().optional() }).passthrough(),
  execute: async (cfg, ctx, actor) => {
    const key = (ctx.issue as { key?: string } | null)?.key;
    if (!key) throw new JiraApiError(400, jiraError(['comment requires an issue']));
    const c = cfg as { body: string; visibility?: unknown };
    const body = expandSmart(c.body, ctx, true);
    const res = await addComment(key, body, actor, c.visibility);
    return { issueKey: key, commentId: res.id };
  },
});
for (const [name, op] of [
  ['add_labels', 'labelsAdd'],
  ['remove_labels', 'labelsRemove'],
] as const) {
  reg(actionRegistry, {
    name,
    description: `${op === 'labelsAdd' ? 'Add' : 'Remove'} labels`,
    schema: z.object({ type: z.literal(name), labels: z.array(z.string()) }).passthrough(),
    execute: async (cfg, ctx, actor) => {
      const key = (ctx.issue as { key?: string } | null)?.key;
      if (!key) throw new JiraApiError(400, jiraError([`${name} requires an issue`]));
      const labels = ((cfg as { labels: string[] }).labels ?? []).map((l) => expandSmart(l, ctx));
      await issueService.updateIssue(key, { [op]: labels } as issueService.UpdateIssueInput, actor);
      return { issueKey: key, labels };
    },
  });
}
reg(actionRegistry, {
  name: 'link_issues',
  description: 'Link issue to another key (smart values ok)',
  schema: z.object({ type: z.literal('link_issues'), linkType: z.string(), to: z.string() }).passthrough(),
  execute: async (cfg, ctx, actor) => {
    const key = (ctx.issue as { key?: string } | null)?.key;
    if (!key) throw new JiraApiError(400, jiraError(['link_issues requires an issue']));
    const c = cfg as { linkType: string; to: string };
    const res = await createLink(c.linkType, key, expandSmart(c.to, ctx), actor);
    return { issueKey: key, linkId: res.id };
  },
});
reg(actionRegistry, {
  name: 'move_to_sprint',
  description: 'Move the issue to a sprint (id/name) or "backlog"',
  schema: z.object({ type: z.literal('move_to_sprint'), to: z.string() }).passthrough(),
  execute: async (cfg, ctx, actor) => {
    const key = (ctx.issue as { key?: string } | null)?.key;
    if (!key) throw new JiraApiError(400, jiraError(['move_to_sprint requires an issue']));
    const to = expandSmart((cfg as { to: string }).to, ctx);
    const { moveIssuesToSprint, moveIssuesToBacklog } = await import('./sprintService.js');
    if (to === 'backlog') {
      await moveIssuesToBacklog([key], actor);
      return { issueKey: key, sprint: 'backlog' };
    }
    const projectId = (ctx.issue as { fields?: { project?: { id?: string } } } | null)?.fields?.project?.id;
    const sprint = await prisma.sprint.findFirst({
      where: {
        OR: [{ id: to }, { name: { equals: to, mode: 'insensitive' } }],
        ...(projectId ? { board: { projectId: String(projectId) } } : {}),
      },
    });
    if (!sprint) throw new JiraApiError(404, jiraError([`Sprint '${to}' not found`]));
    await moveIssuesToSprint(sprint.id, [key], actor);
    return { issueKey: key, sprint: sprint.name };
  },
});
reg(actionRegistry, {
  name: 'webhook',
  description: 'POST the issue payload to a public URL (SSRF-guarded, HMAC-signed)',
  schema: z.object({ type: z.literal('webhook'), url: z.string().url(), secret: z.string().optional() }).passthrough(),
  execute: async (cfg, ctx) => {
    const c = cfg as { url: string; secret?: string };
    // 065 audit D4 — egressFetch re-validates every redirect hop and strips
    // the HMAC signature after the first redirect; plain fetch follows
    // redirects anywhere, defeating assertPublicUrl.
    const body = JSON.stringify({ event: 'automation', issue: ctx.issue, rule: ctx.trigger.ruleId });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (c.secret) {
      const { createHmac } = await import('crypto');
      headers['X-Hub-Signature-256'] = `sha256=${createHmac('sha256', c.secret).update(body).digest('hex')}`;
    }
    const res = await egressFetch(
      c.url,
      { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) },
      { allowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === 'true' }
    );
    return { status: res.status };
  },
});
reg(actionRegistry, {
  name: 'ask_agent',
  description: 'AI triage: copilot drafts a proposal; autoApply applies it if every check passes',
  schema: z
    .object({
      type: z.literal('ask_agent'),
      prompt: z.string(),
      autoApply: z.boolean().default(false),
    })
    .passthrough(),
  execute: async (cfg, ctx, actor, run) => {
    const { askAgentAction } = await import('./agentAction.js');
    return askAgentAction(cfg as { prompt: string; autoApply?: boolean }, ctx, actor, run);
  },
});

// Parameter specs per registry type — the frontend builder renders typed
// widgets from these. kind: text input · csv (comma → string[]) · bool
// checkbox · json (free-form value, parsed on save).
export interface FieldSpec {
  key: string;
  kind: 'text' | 'csv' | 'bool' | 'json';
  required?: boolean;
  hint?: string;
}
const FIELD_SPECS: Record<string, FieldSpec[]> = {
  'trigger:issue_updated': [
    { key: 'fields', kind: 'csv', hint: 'changelog fields, e.g. status, assignee — empty = any change' },
  ],
  'trigger:issue_transitioned': [{ key: 'toStatus', kind: 'text', hint: 'destination status name' }],
  'trigger:issue_linked': [{ key: 'linkType', kind: 'text' }],
  'trigger:manual': [{ key: 'jql', kind: 'text', hint: 'issue selection for manual runs' }],
  'trigger:scheduled': [
    { key: 'cron', kind: 'text', required: true, hint: 'e.g. 0 9 * * MON' },
    { key: 'jql', kind: 'text', required: true, hint: 'issues the rule runs on' },
  ],
  'condition:jql': [{ key: 'jql', kind: 'text', required: true }],
  'condition:field_equals': [
    { key: 'field', kind: 'text', required: true, hint: 'e.g. status.name, priority.name, customfield_x' },
    { key: 'value', kind: 'json', required: true, hint: 'string, number or true/false' },
    { key: 'ignoreCase', kind: 'bool' },
  ],
  'condition:user_in_group': [
    { key: 'field', kind: 'text', hint: 'actor | assignee | reporter (default actor)' },
    { key: 'group', kind: 'text', required: true },
  ],
  'condition:user_in_role': [
    { key: 'field', kind: 'text', hint: 'actor | assignee | reporter (default actor)' },
    { key: 'role', kind: 'text', required: true },
  ],
  'condition:linked_issues_exist': [{ key: 'linkType', kind: 'text' }],
  'action:edit_fields': [
    {
      key: 'fields',
      kind: 'json',
      required: true,
      hint: '{"priority":{"name":"High"},"labels":["x"],"assignee":null}',
    },
  ],
  'action:transition': [
    { key: 'to', kind: 'text', required: true, hint: 'transition id, name, or destination status' },
    { key: 'comment', kind: 'text' },
  ],
  'action:assign': [{ key: 'to', kind: 'text', required: true, hint: 'user, accountId, unassigned, reporter, lead' }],
  'action:comment': [{ key: 'body', kind: 'text', required: true, hint: '{{issue.key}} smart values ok' }],
  'action:add_labels': [{ key: 'labels', kind: 'csv', required: true }],
  'action:remove_labels': [{ key: 'labels', kind: 'csv', required: true }],
  'action:link_issues': [
    { key: 'linkType', kind: 'text', required: true, hint: 'e.g. blocks, relates' },
    { key: 'to', kind: 'text', required: true, hint: 'issue key or smart value' },
  ],
  'action:move_to_sprint': [{ key: 'to', kind: 'text', required: true, hint: 'sprint id/name or "backlog"' }],
  'action:webhook': [
    { key: 'url', kind: 'text', required: true, hint: 'public https URL (SSRF-guarded)' },
    { key: 'secret', kind: 'text' },
  ],
  'action:ask_agent': [
    { key: 'prompt', kind: 'text', required: true },
    { key: 'autoApply', kind: 'bool', hint: 'apply the draft when all checks pass' },
  ],
};

export function automationSchema() {
  const list = (m: Record<string, RegistryEntry>, kind: string) =>
    Object.values(m).map((e) => ({
      name: e.name,
      description: e.description,
      fields: FIELD_SPECS[`${kind}:${e.name}`] ?? [],
    }));
  return {
    triggers: list(triggerSchemas, 'trigger'),
    conditions: list(conditionRegistry, 'condition'),
    actions: list(actionRegistry, 'action'),
  };
}

// ---------- helpers ----------
function expandObj(v: unknown, ctx: RunCtx): unknown {
  if (typeof v === 'string') return expandSmart(v, ctx);
  if (Array.isArray(v)) return v.map((x) => expandObj(x, ctx));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = expandObj(x, ctx);
    return o;
  }
  return v;
}

function fieldsToUpdateInput(fields: Record<string, unknown>): issueService.UpdateIssueInput {
  const data: issueService.UpdateIssueInput = {};
  const cf: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    switch (k) {
      case 'summary':
        data.summary = String(v);
        break;
      case 'description':
        data.description = v === null ? null : String(v);
        break;
      case 'priority':
        data.priorityName = String(v);
        break;
      case 'issuetype':
      case 'issueType':
        data.issueTypeName = String(v);
        break;
      case 'status':
        data.statusName = String(v);
        break;
      case 'assignee':
        data.assignee =
          v === null ? null : typeof v === 'object' ? (v as issueService.AssigneeRef) : { name: String(v) };
        break;
      case 'reporter':
        data.reporter = v === null ? null : { name: String(v) };
        break;
      case 'labels':
        data.labels = Array.isArray(v) ? v.map(String) : [String(v)];
        break;
      case 'duedate':
      case 'dueDate':
        data.dueDate = v === null ? null : String(v);
        break;
      case 'resolution':
        data.resolutionName = v === null ? null : String(v);
        break;
      case 'parent':
        data.parentKey = v === null ? null : String(v);
        break;
      case 'storyPoints':
      case 'storypoints':
        data.storyPoints = v === null ? null : Number(v);
        break;
      case 'environment':
        data.environment = v === null ? null : String(v);
        break;
      case 'security':
        data.security = v;
        break;
      default:
        cf[k] = v; // customfield_*, alias, Flagged…
    }
  }
  if (Object.keys(cf).length) data.customFields = cf;
  return data;
}

async function projectLeadId(ctx: RunCtx): Promise<string | undefined> {
  const issue = ctx.issue as { fields?: { project?: { id?: string } } } | null;
  const pid = issue?.fields?.project?.id ?? (ctx.issue as { projectId?: string } | null)?.projectId;
  if (!pid) return undefined;
  const p = await prisma.project.findUnique({ where: { id: String(pid) }, select: { leadId: true } });
  return p?.leadId ?? undefined;
}

// ---------- permission intersection ----------
async function buildRuleActor(
  rule: AutomationRule,
  projectId: string | null
): Promise<{ actor: Actor; error?: string }> {
  const [actorUser, author] = await Promise.all([
    prisma.user.findUnique({ where: { id: rule.actorId } }),
    prisma.user.findUnique({ where: { id: rule.createdById } }),
  ]);
  if (!actorUser?.active) return { actor: null as unknown as Actor, error: 'rule actor missing or inactive' };
  if (!author?.active) return { actor: null as unknown as Actor, error: 'rule author missing or inactive' };
  const actor: Actor = { user: actorUser, channel: 'automation' };
  // Author/actor intersection: if EITHER lacks BROWSE_PROJECTS on the scope
  // project, the run refuses — a rule can never exceed its author's reach.
  if (projectId) {
    for (const u of [actorUser, author]) {
      const ok =
        u.isAdmin || (await hasPermission({ user: u, channel: 'automation' }, 'BROWSE_PROJECTS', { projectId }));
      if (!ok) return { actor, error: `permission intersection failed: ${u.displayName} lacks BROWSE_PROJECTS` };
    }
  }
  return { actor };
}

// ---------- run execution ----------
interface StepLog {
  step: string;
  index: number;
  detail?: string;
  result?: unknown;
  error?: string;
  at: string;
  [k: string]: unknown;
}
const step = (s: string, index: number, extra: Partial<StepLog> = {}): StepLog => ({
  step: s,
  index,
  at: new Date().toISOString(),
  ...extra,
});

async function annotateEmittedEvents(before: number, annotation: Record<string, unknown>) {
  // Post-annotate the events our actions just emitted with the rule chain so
  // the dispatcher can structurally exclude same-rule recursion + cap depth.
  const emitted = await prisma.domainEvent.findMany({
    where: { id: { gt: before }, channel: 'automation' },
    select: { id: true, payload: true },
  });
  for (const ev of emitted) {
    const payload = { ...(ev.payload as Record<string, unknown>), automation: annotation };
    await prisma.$executeRaw`UPDATE "DomainEvent" SET payload = ${JSON.stringify(payload)}::jsonb WHERE id = ${ev.id}`;
  }
  return emitted.map((e) => e.id);
}

export async function executeRule(
  rule: AutomationRule,
  triggerInfo: { event?: DomainEvent | null; issueKey?: string | null; dryRun?: boolean; chain?: string[] }
): Promise<AutomationRun> {
  const payload = (triggerInfo.event?.payload ?? {}) as EventPayload;
  const projectId = (rule.projectId ?? triggerInfo.event?.projectId ?? null) as string | null;
  const chain = triggerInfo.chain ?? (payload.automation as { chain?: string[] } | undefined)?.chain ?? [];
  const depth = chain.length;

  const run = await prisma.automationRun.create({
    data: {
      ruleId: rule.id,
      ruleVersion: rule.version,
      triggerEventId: triggerInfo.event?.id ?? null,
      issueId: triggerInfo.event?.issueId ?? null,
      status: 'running',
      steps: j([
        step('trigger', 0, {
          detail: `${(rule.trigger as { type: string }).type} ${triggerInfo.event ? `event ${triggerInfo.event.id}` : triggerInfo.issueKey ? `manual ${triggerInfo.issueKey}` : 'scheduled'}`,
          result: { depth },
        }),
      ]),
    },
  });
  const finish = async (status: string, error?: string) =>
    prisma.automationRun.update({
      where: { id: run.id },
      data: { status, error, finishedAt: new Date(), steps: j(await freshSteps(run.id)) },
    });

  try {
    // loop guard — structural (FR-004)
    if (chain.includes(rule.id)) return finish('skipped-loop', `rule ${rule.id} already in chain [${chain.join(',')}]`);
    if (depth >= MAX_DEPTH) return finish('skipped-loop', `automation depth ${depth} ≥ cap ${MAX_DEPTH}`);

    const { actor, error } = await buildRuleActor(rule, projectId);
    if (!actor) return finish('failed', error);

    // issue context: event snapshot → live lookup for manual/scheduled runs
    let issueSnap = (payload.issue ?? null) as Record<string, unknown> | null;
    const wantKey = triggerInfo.issueKey ?? payload.issueKey ?? null;
    if (wantKey && (!issueSnap || (issueSnap as { key?: string }).key !== wantKey)) {
      // 065 audit D1 — the key must sit inside the rule's project scope and be
      // visible to the RULE actor; otherwise manual run + webhook becomes a
      // read-anything/export-anything primitive for any project admin.
      const raw = await issueService.getIssueByKey(wantKey).catch(() => null);
      if (raw && rule.projectId && raw.projectId !== rule.projectId) {
        return finish('failed', `issue ${wantKey} is outside the rule's project scope`);
      }
      if (raw) {
        const { canSeeIssueFull } = await import('./visibilityService.js');
        if (!(await canSeeIssueFull(actor, raw))) {
          return finish('failed', `issue ${wantKey} is not visible to the rule actor`);
        }
      }
      issueSnap = raw ? ((await issueService.toIssueResponseWithCf(raw)) as Record<string, unknown>) : null;
    }
    if (issueSnap?.id && !run.issueId) {
      await prisma.automationRun.update({ where: { id: run.id }, data: { issueId: String(issueSnap.id) } });
    }
    const ctx: RunCtx = {
      issue: issueSnap,
      actor: (payload.actor as RunCtx['actor']) ?? { accountId: actor.user.id, displayName: actor.user.displayName },
      trigger: { ...(payload as Record<string, unknown>), ruleId: rule.id },
    };

    const steps = await freshSteps(run.id);
    // conditions
    const conditions = (rule.conditions ?? []) as Record<string, unknown>[];
    for (const [i, cond] of conditions.entries()) {
      const entry = conditionRegistry[cond.type as string];
      let ok = false,
        err: string | undefined;
      try {
        ok = entry?.evaluate ? await entry.evaluate(cond, ctx, actor) : false;
      } catch (e) {
        err = e instanceof Error ? e.message : 'condition error';
      }
      steps.push(
        step('condition', i, { detail: `${cond.type} ${JSON.stringify(cond).slice(0, 120)}`, result: ok, error: err })
      );
      if (!ok && !err) {
        await prisma.automationRun.update({ where: { id: run.id }, data: { steps: j(steps) } });
        return finish('skipped-condition', `condition ${i} (${cond.type}) false`);
      }
      if (err) {
        await prisma.automationRun.update({ where: { id: run.id }, data: { steps: j(steps) } });
        return finish('failed', `condition ${i} error: ${err}`);
      }
    }

    if (triggerInfo.dryRun) {
      steps.push(
        step('dry-run', 0, { detail: 'actions validated, not executed', result: (rule.actions as unknown[]).length })
      );
      await prisma.automationRun.update({ where: { id: run.id }, data: { steps: j(steps) } });
      return finish('success');
    }

    // actions — sequential, step-logged; emitted events get the chain appended
    let anyErr = false;
    const actions = (rule.actions ?? []) as Record<string, unknown>[];
    for (const [i, act] of actions.entries()) {
      const entry = actionRegistry[act.type as string];
      try {
        if (!entry?.execute) throw new JiraApiError(400, jiraError([`unknown action '${act.type}'`]));
        const before = Number((await prisma.domainEvent.aggregate({ _max: { id: true } }))._max.id ?? 0);
        const result = await entry.execute(act, ctx, actor, run);
        const emitted = await annotateEmittedEvents(before, {
          ruleId: rule.id,
          chain: [...chain, rule.id],
          depth: depth + 1,
        });
        steps.push(
          step('action', i, { detail: `${act.type} ${JSON.stringify(act).slice(0, 140)}`, result, error: undefined })
        );
        if (emitted.length) steps[steps.length - 1].result = { ...(result ?? {}), emittedEvents: emitted.map(Number) };
      } catch (e) {
        anyErr = true;
        const msg =
          e instanceof JiraApiError
            ? `${e.status}: ${JSON.stringify(e.response)}`
            : e instanceof Error
              ? e.message
              : 'action error';
        steps.push(step('action', i, { detail: `${act.type}`, error: msg }));
      }
      await prisma.automationRun.update({ where: { id: run.id }, data: { steps: j(steps) } });
    }
    await prisma.automationRule.update({
      where: { id: rule.id },
      data: anyErr ? { failureCount: { increment: 1 } } : { failureCount: 0 },
    });
    return finish(anyErr ? 'some-errors' : 'success');
  } catch (e) {
    return finish('failed', e instanceof Error ? e.message : 'engine error');
  }
}
async function freshSteps(id: string): Promise<StepLog[]> {
  const r = await prisma.automationRun.findUniqueOrThrow({ where: { id }, select: { steps: true } });
  return (r.steps as unknown as StepLog[]) ?? [];
}

// ---------- event dispatch ----------
export async function evaluateEventForRules(ev: DomainEvent): Promise<number> {
  if (ev.channel === 'system') return 0;
  const meta = (ev.payload as EventPayload).automation as { chain?: string[] } | undefined;
  const rules = await prisma.automationRule.findMany({
    where: {
      enabled: true,
      OR: [{ projectId: null }, { projectId: ev.projectId ?? '' }],
    },
  });
  let fired = 0;
  for (const rule of rules) {
    const t = rule.trigger as { type: string };
    if (t.type === 'manual' || t.type === 'scheduled') continue;
    const entry = triggerSchemas[t.type];
    try {
      if (!entry?.match?.(rule.trigger, ev)) continue;
      await executeRule(rule, { event: ev, chain: meta?.chain ?? [] });
      fired++;
    } catch (e) {
      console.error(`[automation] rule ${rule.id} match/eval failed:`, e);
    }
  }
  return fired;
}

// ---------- scheduled + manual ----------
// 065 audit G6 — real cron names (the UI hint advertises MON) and the
// day-of-week 7→Sunday alias; previously both silently never matched.
const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const fieldNum = (s: string, names?: Record<string, number>) =>
  names && s.toUpperCase() in names ? names[s.toUpperCase()] : parseInt(s, 10);

/** One cron field → [lo, hi, step] triples; null when any part is malformed. */
function cronField(spec: string, max: number, names?: Record<string, number>): [number, number, number][] | null {
  const out: [number, number, number][] = [];
  for (const part of spec.toUpperCase().split(',')) {
    const [rng, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : parseInt(stepS, 10);
    if (!Number.isInteger(step) || step < 1) return null;
    const [lo, hi] =
      rng === '*'
        ? [0, max]
        : rng.includes('-')
          ? rng.split('-').map((s) => fieldNum(s, names))
          : [fieldNum(rng, names), fieldNum(rng, names)];
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi > max || lo > hi) return null;
    out.push([lo, hi, step]);
  }
  return out.length ? out : null;
}

export function cronMatches(cron: string, d: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const match = (spec: string, val: number, max: number, names?: Record<string, number>, dow = false) => {
    const fs = cronField(spec, max, names);
    if (!fs) return false;
    return fs.some(([lo, hi, step]) => {
      if (dow && hi === 7) {
        // 7 is the Sunday alias of 0 — a range ending at 7 wraps to it.
        if (val === 0) return true;
        hi = 6;
      }
      return val >= lo && val <= hi && (val - lo) % step === 0;
    });
  };
  return (
    match(parts[0], d.getUTCMinutes(), 59) &&
    match(parts[1], d.getUTCHours(), 23) &&
    match(parts[2], d.getUTCDate(), 31) &&
    match(parts[3], d.getUTCMonth() + 1, 12, MONTH_NAMES) &&
    match(parts[4], d.getUTCDay(), 7, DOW_NAMES, true)
  );
}

/** Save-time check (065 audit G6 — a bad cron previously saved fine and never fired). */
export function cronError(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'expected 5 fields (minute hour day-of-month month weekday)';
  const specs: [number, Record<string, number> | undefined][] = [
    [59, undefined],
    [23, undefined],
    [31, undefined],
    [12, MONTH_NAMES],
    [7, DOW_NAMES],
  ];
  for (const [i, [max, names]] of specs.entries()) {
    if (!cronField(parts[i], max, names)) return `field '${parts[i]}' is invalid`;
  }
  return null;
}

export async function runScheduledRules(now = new Date()): Promise<number> {
  const rules = await prisma.automationRule.findMany({
    where: { enabled: true, trigger: { path: ['type'], equals: 'scheduled' } },
  });
  let n = 0;
  for (const rule of rules) {
    const t = rule.trigger as { cron?: string; jql?: string };
    if (!t.cron || !t.jql || !cronMatches(t.cron, now)) continue;
    const { actor, error } = await buildRuleActor(rule, rule.projectId);
    if (!actor) {
      await prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          ruleVersion: rule.version,
          status: 'failed',
          error,
          finishedAt: new Date(),
          steps: j([step('trigger', 0, { detail: 'scheduled', error })]),
        },
      });
      continue;
    }
    try {
      const compiled = await compileJql(parseJql(t.jql), actor);
      const issues = await prisma.issue.findMany({
        where: { ...compiled.where, ...(rule.projectId ? { projectId: rule.projectId } : {}) },
        select: { project: { select: { key: true } }, issueNumber: true },
        take: 500,
      });
      // 065 audit G6 — runs are capped at 500 issues; surface it instead of
      // silently processing a prefix.
      if (issues.length === 500) {
        console.warn(
          `[automation] scheduled rule '${rule.name}' (${rule.id}) hit the 500-issue cap — narrow its JQL or split the rule.`
        );
      }
      for (const i of issues) {
        await executeRule(rule, { issueKey: `${i.project.key}-${i.issueNumber}`, chain: [] });
        n++;
      }
    } catch (e) {
      await prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          ruleVersion: rule.version,
          status: 'failed',
          error: e instanceof Error ? e.message : 'schedule error',
          finishedAt: new Date(),
          steps: j([step('trigger', 0, { detail: 'scheduled JQL failed' })]),
        },
      });
    }
  }
  return n;
}

// ---------- validation ----------
export function validateRuleShape(input: { trigger?: unknown; conditions?: unknown; actions?: unknown }): string[] {
  const errs: string[] = [];
  const check = (list: unknown, map: Record<string, RegistryEntry>, kind: string) => {
    for (const [i, item] of ((list ?? []) as Record<string, unknown>[]).entries()) {
      const entry = item && typeof item === 'object' ? map[item.type as string] : undefined;
      if (!entry) {
        errs.push(`${kind}[${i}]: unknown type '${item?.type ?? item}'`);
        continue;
      }
      const r = entry.schema.safeParse(item);
      if (!r.success) errs.push(`${kind}[${i}] ${item.type}: ${r.error.issues.map((x) => x.message).join('; ')}`);
    }
  };
  const t = input.trigger as { type?: string; cron?: string } | undefined;
  const te = t?.type ? triggerSchemas[t.type] : undefined;
  if (!te) errs.push(`trigger: unknown type '${t?.type ?? 'missing'}'`);
  else {
    const r = te.schema.safeParse(t);
    if (!r.success) errs.push(`trigger ${t!.type}: ${r.error.issues.map((x) => x.message).join('; ')}`);
    else if (t?.type === 'scheduled' && t.cron) {
      const ce = cronError(t.cron);
      if (ce) errs.push(`trigger scheduled.cron: ${ce}`);
    }
  }
  check(input.conditions, conditionRegistry, 'condition');
  check(input.actions, actionRegistry, 'action');
  if (!(input.actions as unknown[])?.length) errs.push('actions: at least one required');
  return errs;
}

export async function validateRuleJql(input: { trigger?: unknown; conditions?: unknown }): Promise<string[]> {
  const errs: string[] = [];
  const jqls: string[] = [];
  const t = input.trigger as { jql?: string } | undefined;
  if (t?.jql) jqls.push(t.jql);
  for (const c of (input.conditions ?? []) as { type?: string; jql?: string }[])
    if (c.type === 'jql' && c.jql) jqls.push(c.jql);
  for (const j of jqls) {
    try {
      parseJql(j);
    } catch (e) {
      errs.push(`invalid JQL '${j.slice(0, 60)}': ${e instanceof Error ? e.message : e}`);
    }
  }
  return errs;
}

// ---------- route-facing authz + mappers (moved from routes/automation.ts — 065 US5) ----------

export async function canAuthor(actor: Actor, scope: string, projectId: string | null): Promise<string | null> {
  if (actor.user.isAdmin) return null;
  if (scope !== 'project' || !projectId) return 'only site admins can author global rules';
  if (await hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId })) return null;
  return 'project admin required for project-scoped rules';
}

export async function resolveProjectId(key: string | undefined, scope: string): Promise<string | null> {
  if (scope !== 'project') return null;
  if (!key) throw new JiraApiError(400, jiraError(['projectKey required for project-scoped rules']));
  const p = await prisma.project.findUnique({ where: { key: key.toUpperCase() } });
  if (!p) throw new JiraApiError(404, jiraError([`Project '${key}' not found`]));
  return p.id;
}

export async function resolveRuleActor(actor: Actor, raw: string | undefined): Promise<{ userId?: string; error?: string }> {
  if (!raw) return {};
  if (raw === actor.user.id) return { userId: raw };
  if (!actor.user.isAdmin) return { error: 'choosing another actor requires site admin' };
  const u = await resolveUserRef(raw);
  return u ? { userId: u.id } : { error: `actor '${raw}' not found or inactive` };
}

// triggerEventId is BigInt — res.json() throws on it (500 → "No runs yet").
export const toRunResponse = (r: AutomationRun) => ({
  ...r,
  triggerEventId: r.triggerEventId === null ? null : Number(r.triggerEventId),
});
// 065 audit C5 — webhook HMAC secrets never leave this surface; the UI sends
// the mask back verbatim on edit and PUT restores the stored value.
export const SECRET_MASK = '•••';
export const maskSecrets = (actions: unknown) =>
  Array.isArray(actions)
    ? actions.map((a) =>
        a && typeof a === 'object' && (a as { secret?: unknown }).secret
          ? { ...(a as Record<string, unknown>), secret: SECRET_MASK }
          : a
      )
    : actions;
export const toRuleResponse = (r: Record<string, unknown>) => ({
  ...r,
  actions: maskSecrets(r.actions),
  actor: r.actor
    ? { accountId: (r.actor as { id: string }).id, displayName: (r.actor as { displayName: string }).displayName }
    : undefined,
  author: r.author
    ? { accountId: (r.author as { id: string }).id, displayName: (r.author as { displayName: string }).displayName }
    : undefined,
  project: r.project
    ? {
        id: (r.project as { id: string }).id,
        key: (r.project as { key: string }).key,
        name: (r.project as { name: string }).name,
      }
    : undefined,
});
/** Any action carrying the read-mask re-inherits the stored secret (by index). */
export const unmaskSecrets = (incoming: unknown, existing: unknown) => {
  if (!Array.isArray(incoming) || !Array.isArray(existing)) return incoming;
  return incoming.map((a, i) => {
    const prev = existing[i] as { secret?: unknown } | undefined;
    if (a && typeof a === 'object' && (a as { secret?: unknown }).secret === SECRET_MASK && prev?.secret)
      return { ...(a as Record<string, unknown>), secret: prev.secret };
    return a;
  });
};
export const RULE_INCLUDE = {
  actor: { select: { id: true, displayName: true } },
  author: { select: { id: true, displayName: true } },
  project: { select: { id: true, key: true, name: true } },
} satisfies Prisma.AutomationRuleInclude;

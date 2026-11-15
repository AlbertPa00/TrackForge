// Sprint 032 — JQL function registry (D21-style discoverable table).
// Functions are declared here, not hardcoded in the compiler: name, arg
// shape, return kind, doc — exposed to agents via /api/internal/jql/functions.
//
// Return kinds drive compiler validation: a 'user' function is valid wherever
// a user id is expected (assignee/reporter/voter fields), 'issue' wherever an
// issue id is (key/parent/issue links), 'date' in date operands.

import { prisma } from '../prisma.js';
import { JqlFieldError } from './compiler.js';
import type { JqlOperand } from './ast.js';
import type { Actor } from '../lib/auth.js';

export type FnReturn = 'user' | 'issue' | 'date' | 'component' | 'project';

export interface JqlFunctionDef {
  name: string; // lowercase — JQL names are case-insensitive
  returns: FnReturn;
  minArgs: number;
  maxArgs: number;
  argHint: string;
  doc: string;
}

export const JQL_FUNCTIONS: JqlFunctionDef[] = [
  {
    name: 'membersof',
    returns: 'user',
    minArgs: 1,
    maxArgs: 1,
    argHint: '"group"',
    doc: 'Users belonging to the named group. Unknown group → error.',
  },
  { name: 'currentuser', returns: 'user', minArgs: 0, maxArgs: 0, argHint: '', doc: 'The authenticated user.' },
  {
    name: 'updatedby',
    returns: 'user',
    minArgs: 0,
    maxArgs: 1,
    argHint: '[username]',
    doc: 'Users who have authored issue changes (changelog). Optional user filter.',
  },
  {
    name: 'watchers',
    returns: 'user',
    minArgs: 0,
    maxArgs: 1,
    argHint: '[issueKey]',
    doc: 'Users watching issues — globally, or the given issue.',
  },
  {
    name: 'voters',
    returns: 'user',
    minArgs: 0,
    maxArgs: 1,
    argHint: '[issueKey]',
    doc: 'Users who voted on issues — globally, or the given issue.',
  },
  {
    name: 'linkedissues',
    returns: 'issue',
    minArgs: 1,
    maxArgs: 2,
    argHint: 'issueKey[, linkType]',
    doc: 'Issues linked to the given issue, optionally by a specific link type.',
  },
  {
    name: 'linkedissuesof',
    returns: 'issue',
    minArgs: 1,
    maxArgs: 1,
    argHint: '"linkType"',
    doc: 'Issues joined by the named link type (either direction).',
  },
  {
    name: 'subtasksof',
    returns: 'issue',
    minArgs: 1,
    maxArgs: 1,
    argHint: 'jql',
    doc: 'Subtasks whose parent matches the JQL argument.',
  },
  {
    name: 'parentsof',
    returns: 'issue',
    minArgs: 1,
    maxArgs: 1,
    argHint: 'jql',
    doc: 'Parents of issues matching the JQL argument.',
  },
  {
    name: 'epicsof',
    returns: 'issue',
    minArgs: 1,
    maxArgs: 1,
    argHint: 'jql',
    doc: 'Epics containing issues matching the JQL argument.',
  },
  {
    name: 'issuesinepics',
    returns: 'issue',
    minArgs: 1,
    maxArgs: 1,
    argHint: 'jql',
    doc: 'Issues whose epic matches the JQL argument.',
  },
  {
    name: 'hascomments',
    returns: 'issue',
    minArgs: 0,
    maxArgs: 0,
    argHint: '',
    doc: 'Issues having at least one comment (Appfire JQL-Extensions parity).',
  },
  {
    name: 'commentedby',
    returns: 'issue',
    minArgs: 1,
    maxArgs: 1,
    argHint: '"user"',
    doc: 'Issues commented on by the given user.',
  },
  {
    name: 'ready',
    returns: 'issue',
    minArgs: 0,
    maxArgs: 0,
    argHint: '',
    doc: 'Unresolved issues with no unresolved "blocks" links — the work an agent can pick up (TF ext).',
  },
  {
    name: 'blocked',
    returns: 'issue',
    minArgs: 0,
    maxArgs: 0,
    argHint: '',
    doc: 'Unresolved issues with at least one unresolved "blocks" link — inverse of ready() (TF ext).',
  },
  {
    name: 'componentsleadby',
    returns: 'component',
    minArgs: 1,
    maxArgs: 1,
    argHint: '"user"',
    doc: 'Components led by the given user.',
  },
  {
    name: 'projectsleadby',
    returns: 'project',
    minArgs: 1,
    maxArgs: 1,
    argHint: '"user"',
    doc: 'Projects led by the given user.',
  },
  {
    name: 'currentlogin',
    returns: 'date',
    minArgs: 0,
    maxArgs: 0,
    argHint: '',
    doc: "Timestamp of the current session's login.",
  },
  {
    name: 'previouslogin',
    returns: 'date',
    minArgs: 0,
    maxArgs: 0,
    argHint: '',
    doc: 'Timestamp of the login before the current one.',
  },
  {
    name: 'lastlogin',
    returns: 'date',
    minArgs: 0,
    maxArgs: 0,
    argHint: '',
    doc: 'Timestamp of the most recent login (same as currentLogin with token auth).',
  },
];

const byName = new Map(JQL_FUNCTIONS.map((f) => [f.name, f]));

export function lookupFunction(name: string): JqlFunctionDef | undefined {
  return byName.get(name.toLowerCase());
}

/** A3 discoverability — registry as the agent/extension-facing contract. */
export function listJqlFunctions() {
  return JQL_FUNCTIONS.map((f) => ({
    name: f.name,
    returns: f.returns,
    args: { min: f.minArgs, max: f.maxArgs, hint: f.argHint },
    doc: f.doc,
  }));
}

interface FnCtx {
  actor: Actor;
}

/** Ids of issues that have an unresolved "blocks" blocker — shared by the
 *  ready()/blocked() JQL functions and the agent claim endpoint (063). */
export async function blockedIssueIds(): Promise<Set<string>> {
  const links = await prisma.issueLink.findMany({
    where: {
      type: { outward: { equals: 'blocks', mode: 'insensitive' } },
      outwardIssue: { resolutionId: null },
    },
    select: { inwardId: true },
  });
  return new Set(links.map((l) => l.inwardId));
}

function checkArity(def: JqlFunctionDef, op: JqlOperand & { kind: 'function' }, field: string): string[] {
  const n = op.args.length;
  if (n < def.minArgs || n > def.maxArgs) {
    throw new JqlFieldError(
      `Function '${def.name}' expects ${def.minArgs === def.maxArgs ? def.minArgs : `${def.minArgs}-${def.maxArgs}`} argument(s)${def.argHint ? ` (${def.argHint})` : ''} — got ${n}.`,
      field
    );
  }
  return op.args;
}

function fnError(op: JqlOperand & { kind: 'function' }, expected: FnReturn, field: string): never {
  const def = lookupFunction(op.name);
  if (!def) {
    throw new JqlFieldError(`Function '${op.name}' does not exist for the field '${field}'.`, field);
  }
  throw new JqlFieldError(
    `Function '${op.name}' returns ${def.returns} values — it cannot be used as a ${expected} operand for the field '${field}'.`,
    field
  );
}

/** Resolve a function operand to user ids, or throw a Jira-style error. */
export async function evalUserFunction(
  ctx: FnCtx,
  op: JqlOperand & { kind: 'function' },
  field: string
): Promise<string[]> {
  const def = lookupFunction(op.name);
  if (!def || def.returns !== 'user') fnError(op, 'user', field);
  const args = checkArity(def, op, field);
  switch (def.name) {
    case 'currentuser':
      return [ctx.actor.user.id];
    case 'membersof': {
      const group = await prisma.group.findUnique({ where: { name: args[0] }, select: { id: true } });
      if (!group) {
        throw new JqlFieldError(`The group '${args[0]}' does not exist for the function 'membersOf'.`, field);
      }
      const rows = await prisma.groupMember.findMany({ where: { groupId: group.id }, select: { userId: true } });
      return rows.map((r) => r.userId);
    }
    case 'updatedby': {
      if (!args.length) {
        const rows = await prisma.changeHistory.findMany({ select: { authorId: true }, distinct: ['authorId'] });
        return rows.map((r) => r.authorId);
      }
      const user = await prisma.user.findFirst({
        where: { OR: [{ email: args[0].toLowerCase() }, { displayName: { equals: args[0], mode: 'insensitive' } }] },
        select: { id: true },
      });
      if (!user) throw new JqlFieldError(`The user '${args[0]}' does not exist for the function 'updatedBy'.`, field);
      const authored = await prisma.changeHistory.findFirst({ where: { authorId: user.id }, select: { id: true } });
      return authored ? [user.id] : [];
    }
    case 'watchers':
    case 'voters': {
      const table = def.name === 'watchers' ? prisma.watcher : prisma.issueVote;
      const where = args.length ? await issueIdForKey(args[0], field, def.name) : {};
      const rows = await (table as typeof prisma.watcher).findMany({
        where,
        select: { userId: true },
        distinct: ['userId'],
      });
      return rows.map((r) => r.userId);
    }
    default:
      return fnError(op, 'user', field);
  }
}

async function issueIdForKey(key: string, field: string, fnName: string): Promise<{ issueId: string }> {
  const [pk, pn] = key.split('-');
  const issue = await prisma.issue.findFirst({
    where: { project: { key: pk?.toUpperCase() }, issueNumber: Number(pn) || -1 },
    select: { id: true },
  });
  if (!issue) {
    throw new JqlFieldError(`An issue with key '${key}' does not exist for the function '${fnName}'.`, field);
  }
  return { issueId: issue.id };
}

/** Compile a JQL-string argument to matching issue ids (subquery support). */
async function subQueryIssueIds(ctx: FnCtx, jql: string, field: string, fnName: string): Promise<string[]> {
  const { parseJql, JqlParseError } = await import('./parser.js');
  const { compileJql } = await import('./compiler.js');
  let where;
  try {
    ({ where } = await compileJql(parseJql(jql), ctx.actor));
  } catch (e) {
    if (e instanceof JqlParseError || e instanceof JqlFieldError) {
      throw new JqlFieldError(`Invalid subquery for the function '${fnName}': ${(e as Error).message}`, field);
    }
    throw e;
  }
  const rows = await prisma.issue.findMany({ where: where as never, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Resolve a function operand to issue ids, or throw a Jira-style error. */
export async function evalIssueFunction(
  ctx: FnCtx,
  op: JqlOperand & { kind: 'function' },
  field: string
): Promise<string[]> {
  const def = lookupFunction(op.name);
  if (!def || def.returns !== 'issue') fnError(op, 'issue', field);
  const args = checkArity(def, op, field);
  switch (def.name) {
    case 'linkedissues': {
      const { issueId } = await issueIdForKey(args[0], field, def.name);
      const typeFilter = args[1]
        ? {
            type: {
              OR: [
                { name: { equals: args[1], mode: 'insensitive' as const } },
                { inward: { equals: args[1], mode: 'insensitive' as const } },
                { outward: { equals: args[1], mode: 'insensitive' as const } },
              ],
            },
          }
        : {};
      const links = await prisma.issueLink.findMany({
        where: { OR: [{ outwardId: issueId }, { inwardId: issueId }], ...typeFilter },
        select: { outwardId: true, inwardId: true },
      });
      return [...new Set(links.map((l) => (l.outwardId === issueId ? l.inwardId : l.outwardId)))];
    }
    case 'linkedissuesof': {
      const links = await prisma.issueLink.findMany({
        where: {
          type: {
            OR: [
              { name: { equals: args[0], mode: 'insensitive' } },
              { inward: { equals: args[0], mode: 'insensitive' } },
              { outward: { equals: args[0], mode: 'insensitive' } },
            ],
          },
        },
        select: { outwardId: true, inwardId: true },
      });
      return [...new Set(links.flatMap((l) => [l.outwardId, l.inwardId]))];
    }
    case 'subtasksof': {
      const parents = await subQueryIssueIds(ctx, args[0], field, def.name);
      if (!parents.length) return [];
      const rows = await prisma.issue.findMany({ where: { parentId: { in: parents } }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case 'parentsof': {
      const kids = await subQueryIssueIds(ctx, args[0], field, def.name);
      if (!kids.length) return [];
      const rows = await prisma.issue.findMany({
        where: { id: { in: kids }, parentId: { not: null } },
        select: { parentId: true },
      });
      return [...new Set(rows.map((r) => r.parentId!))];
    }
    case 'epicsof': {
      const kids = await subQueryIssueIds(ctx, args[0], field, def.name);
      if (!kids.length) return [];
      const rows = await prisma.issue.findMany({
        where: { id: { in: kids }, parent: { issueType: { hierarchyLevel: 1 } } },
        select: { parentId: true },
      });
      return [...new Set(rows.map((r) => r.parentId!))];
    }
    case 'issuesinepics': {
      const epics = await subQueryIssueIds(ctx, args[0], field, def.name);
      if (!epics.length) return [];
      const rows = await prisma.issue.findMany({ where: { parentId: { in: epics } }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case 'hascomments': {
      const rows = await prisma.comment.findMany({ select: { issueId: true }, distinct: ['issueId'] });
      return rows.map((r) => r.issueId);
    }
    case 'commentedby': {
      const uid = await resolveUserId(args[0], field, def.name);
      const rows = await prisma.comment.findMany({
        where: { authorId: uid },
        select: { issueId: true },
        distinct: ['issueId'],
      });
      return rows.map((r) => r.issueId);
    }
    case 'ready':
    case 'blocked': {
      // 063 US4 — link-aware readiness: an issue is blocked while any inward
      // "blocks" link points at an unresolved issue (resolution EMPTY =
      // unresolved, per Jira). ready() is unresolved-minus-blocked.
      const blocked = await blockedIssueIds();
      const rows = await prisma.issue.findMany({
        where: {
          resolutionId: null,
          id: def.name === 'blocked' ? { in: [...blocked] } : { notIn: [...blocked] },
        },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    }
    default:
      return fnError(op, 'issue', field);
  }
}

/** Shared user lookup for user-arg functions (id / email / display name). */
async function resolveUserId(raw: string, field: string, fnName: string): Promise<string> {
  const u = await prisma.user.findFirst({
    where: {
      OR: [
        { id: raw },
        { email: { equals: raw, mode: 'insensitive' } },
        { displayName: { equals: raw, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
  });
  if (!u) {
    throw new JqlFieldError(`The user '${raw}' does not exist for the function '${fnName}'.`, field);
  }
  return u.id;
}

/** Resolve a function operand to component ids (componentsLeadBy). */
export async function evalComponentFunction(
  ctx: FnCtx,
  op: JqlOperand & { kind: 'function' },
  field: string
): Promise<string[]> {
  const def = lookupFunction(op.name);
  if (!def || def.returns !== 'component') fnError(op, 'component', field);
  const args = checkArity(def, op, field);
  switch (def.name) {
    case 'componentsleadby': {
      const uid = await resolveUserId(args[0], field, def.name);
      const rows = await prisma.component.findMany({ where: { leadId: uid }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    default:
      return fnError(op, 'component', field);
  }
}

/** Resolve a function operand to project ids (projectsLeadBy). */
export async function evalProjectFunction(
  ctx: FnCtx,
  op: JqlOperand & { kind: 'function' },
  field: string
): Promise<string[]> {
  const def = lookupFunction(op.name);
  if (!def || def.returns !== 'project') fnError(op, 'project', field);
  const args = checkArity(def, op, field);
  switch (def.name) {
    case 'projectsleadby': {
      const uid = await resolveUserId(args[0], field, def.name);
      const rows = await prisma.project.findMany({ where: { leadId: uid }, select: { id: true } });
      return rows.map((r) => r.id);
    }
    default:
      return fnError(op, 'project', field);
  }
}

/** Login functions → instant for date operands. Null when the user has no
 *  recorded login (token-only agents) → resolves to a never-matching date. */
export async function evalLoginFunction(
  ctx: FnCtx,
  op: JqlOperand & { kind: 'function' },
  field: string
): Promise<Date | null> {
  const def = lookupFunction(op.name);
  if (!def || def.returns !== 'date') fnError(op, 'date', field);
  checkArity(def, op, field);
  const u = await prisma.user.findUnique({
    where: { id: ctx.actor.user.id },
    select: { lastLoginAt: true, previousLoginAt: true },
  });
  if (op.name === 'previouslogin') return u?.previousLoginAt ?? null;
  return u?.lastLoginAt ?? null; // currentlogin + lastlogin — stateless JWTs share the recorded login instant
}

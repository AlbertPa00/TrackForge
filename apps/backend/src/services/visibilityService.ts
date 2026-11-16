// Sprint 064 US3 — ONE visibility primitive. Every issue read surface must
// satisfy three independent gates:
//   1. token projectKeys allow-list   (PAT scoping — outer layer)
//   2. BROWSE_PROJECTS                (permission scheme)
//   3. canSeeIssue / security level   (+ archived-hidden)
// `securityGateWhere` (issueSecurityService) covers only gate 3 and several
// surfaces hand-rolled gate 1 while forgetting gate 2 — that split is the root
// cause of the 064 read-leak findings. New code should reach for these helpers
// and never consult `projectAllowed`/`nonBrowsableProjectIds` alone.

import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import type { Prisma } from '../lib/pc.js';
import { securityGateWhere, canSeeIssue } from './issueSecurityService.js';
import { nonBrowsableProjectIds } from './permissionService.js';

export interface ProjectScope {
  /** Project ids the actor may NOT see (BROWSE failure or outside allow-list). */
  denied: Set<string>;
  /** When the token carries a projectKeys allow-list: the matching project ids
   *  (already minus denied). null = no allow-list constraint. */
  allowed: Set<string> | null;
}

/** Resolve the actor's project scope once per request/handler. */
export async function visibleProjectScope(actor: Actor): Promise<ProjectScope> {
  const allowKeys = actor.token?.projectKeys;
  const [deniedIds, allowedRows] = await Promise.all([
    nonBrowsableProjectIds(actor),
    allowKeys?.length
      ? prisma.project.findMany({
          where: { key: { in: allowKeys.map((k) => k.toUpperCase()) } },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);
  const denied = new Set(deniedIds);
  const allowed = allowedRows ? new Set(allowedRows.map((p) => p.id).filter((id) => !denied.has(id))) : null;
  return { denied, allowed };
}

/** Cheap project check once the scope is resolved. */
export function canSeeProject(scope: ProjectScope, projectId: string): boolean {
  if (scope.denied.has(projectId)) return false;
  return scope.allowed === null || scope.allowed.has(projectId);
}

/**
 * Single-project check — O(1) alternative to `visibleProjectScope` for routes
 * that gate ONE project (boards, versions, epics). Resolves the project's key
 * only when the token actually carries an allow-list.
 */
export async function canSeeProjectId(actor: Actor, projectId: string): Promise<boolean> {
  const keys = actor.token?.projectKeys;
  if (keys?.length) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { key: true } });
    if (!p || !keys.some((k) => k.toUpperCase() === p.key)) return false;
  }
  const { hasPermission } = await import('./permissionService.js');
  return hasPermission(actor, 'BROWSE_PROJECTS', { projectId });
}

/** Prisma fragment for the project-scope gates — AND into any issue query. */
export function projectScopeWhere(scope: ProjectScope): Prisma.IssueWhereInput {
  const and: Prisma.IssueWhereInput[] = [];
  if (scope.denied.size) and.push({ projectId: { notIn: [...scope.denied] } });
  if (scope.allowed) and.push({ projectId: { in: [...scope.allowed] } });
  return and.length ? { AND: and } : {};
}

/**
 * Full issue-read predicate: security level + archived (gate 3) AND browse +
 * allow-list (gates 1-2). AND this into every issue list query — the same way
 * `executeSearch` already does for JQL.
 */
export async function visibleIssueWhere(actor: Actor): Promise<Prisma.IssueWhereInput> {
  const [security, scope] = await Promise.all([securityGateWhere(actor), visibleProjectScope(actor)]);
  return { AND: [security, projectScopeWhere(scope)] };
}

/**
 * Batch visibility check for issues embedded inside another issue's response
 * (subtasks, parent, link targets). One query, all three gates — cross-project
 * link targets need the project gates, not just the security predicate.
 */
export async function visibleIssueIds(actor: Actor, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await prisma.issue.findMany({
    where: { AND: [{ id: { in: ids } }, await visibleIssueWhere(actor)] },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Single-issue check for detail loads — all three gates on one object.
 * Shape matches what `canSeeIssue` needs plus projectId for the scope check.
 */
export async function canSeeIssueFull(
  actor: Actor,
  issue: {
    id: string;
    effSecurityLevelId: string | null;
    reporterId: string | null;
    assigneeId: string | null;
    projectId: string;
    archived?: boolean;
  }
): Promise<boolean> {
  if (!(await canSeeProjectId(actor, issue.projectId))) return false;
  return canSeeIssue(actor, issue);
}

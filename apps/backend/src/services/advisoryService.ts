// 072 FR-012 — Repo Advisories: path-scoped, verified lessons promoted from
// resolved incident topics or doNotRepeat handoffs. Context packs inject the
// matching ones so agent #50 doesn't repeat agent #1's mistake.

import type { Actor } from '../lib/auth.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hasPermission } from './permissionService.js';
import { projectAllowed } from '../middleware/auth.js';
import { normalizeLockPath, pathMatches } from './resourceLockService.js';

export const ADVISORY_SEVERITIES = ['info', 'warn', 'critical'] as const;

/** Humans, admins, reviewer/security-role agents, or ADMINISTER_PROJECTS. */
async function canWriteAdvisory(actor: Actor, projectId: string): Promise<boolean> {
  if (actor.user.isAdmin) return true;
  if (actor.user.type === 'agent') {
    const p = await prisma.agentProfile.findUnique({ where: { userId: actor.user.id }, select: { role: true } });
    if (p?.role === 'reviewer' || p?.role === 'security') return true;
  }
  return hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId });
}

export async function listAdvisories(actor: Actor, projectKey: string, path?: string) {
  const key = projectKey.toUpperCase();
  const project = await prisma.project.findUnique({ where: { key }, select: { id: true } });
  if (!project || !projectAllowed(actor, key)) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  const rows = await prisma.repoAdvisory.findMany({
    where: { projectId: project.id, active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    include: { createdBy: { select: { id: true, displayName: true } }, sourceIssue: { select: { issueNumber: true, project: { select: { key: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  const normalized = path ? normalizeLockPath(path) : null;
  return {
    advisories: rows
      .filter((r) => !normalized || pathMatches(r.pathGlob, normalized) || globOverlaps(r.pathGlob, normalized))
      .map((r) => ({
        id: r.id,
        pathGlob: r.pathGlob,
        severity: r.severity,
        summary: r.summary,
        createdBy: r.createdBy.displayName,
        sourceIssueKey: r.sourceIssue ? `${r.sourceIssue.project.key}-${r.sourceIssue.issueNumber}` : null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
  };
}

/** Advisory `dir/**` should surface when the caller asks about `dir/` itself
 *  or any path inside it — pathMatches already covers that; this covers the
 *  glob-vs-glob case where the caller passes a pattern. */
function globOverlaps(glob: string, query: string): boolean {
  if (!query.includes('*')) return false;
  const qp = query.endsWith('/**') ? query.slice(0, -2) : query.slice(0, query.indexOf('*'));
  return glob.startsWith(qp) || query.startsWith(glob.endsWith('/**') ? glob.slice(0, -2) : glob);
}

export async function createAdvisory(
  actor: Actor,
  projectKey: string,
  input: { pathGlob: string; summary: string; severity?: string; sourceIssueKey?: string; expiresInSec?: number }
) {
  const key = projectKey.toUpperCase();
  const project = await prisma.project.findUnique({ where: { key }, select: { id: true } });
  if (!project || !projectAllowed(actor, key)) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  if (!(await canWriteAdvisory(actor, project.id))) {
    throw new JiraApiError(403, jiraError(['Only an admin, project admin, or reviewer/security-role agent may publish advisories.']));
  }
  const pathGlob = normalizeLockPath(input.pathGlob);
  let sourceIssueId: string | null = null;
  if (input.sourceIssueKey) {
    const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(input.sourceIssueKey.toUpperCase());
    const src = m
      ? await prisma.issue.findFirst({ where: { issueNumber: Number(m[2]), project: { key: m[1] } }, select: { id: true } })
      : null;
    sourceIssueId = src?.id ?? null;
  }
  const row = await prisma.repoAdvisory.create({
    data: {
      projectId: project.id,
      pathGlob,
      severity: (ADVISORY_SEVERITIES as readonly string[]).includes(input.severity ?? '') ? input.severity! : 'info',
      summary: input.summary.slice(0, 2000),
      createdById: actor.user.id,
      sourceIssueId,
      expiresAt: input.expiresInSec ? new Date(Date.now() + input.expiresInSec * 1000) : null,
    },
    include: { createdBy: { select: { displayName: true } } },
  });
  return {
    id: row.id,
    pathGlob: row.pathGlob,
    severity: row.severity,
    summary: row.summary,
    createdBy: row.createdBy.displayName,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function deleteAdvisory(actor: Actor, projectKey: string, id: string) {
  const key = projectKey.toUpperCase();
  const project = await prisma.project.findUnique({ where: { key }, select: { id: true } });
  if (!project || !projectAllowed(actor, key)) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  }
  if (!(await canWriteAdvisory(actor, project.id))) {
    throw new JiraApiError(403, jiraError(['Only an admin, project admin, or reviewer/security-role agent may retire advisories.']));
  }
  const { count } = await prisma.repoAdvisory.updateMany({
    where: { id, projectId: project.id },
    data: { active: false },
  });
  if (!count) throw new JiraApiError(404, jiraError(['Advisory not found.']));
  return { retired: true };
}

/** Context-pack injector: advisories matching any of the caller's paths.
 *  Empty `paths` = cold-start agent with no declared traces yet — return the
 *  project's most severe recent advisories so pitfalls still surface. */
export async function matchingAdvisories(projectId: string, paths: string[]) {
  const rows = await prisma.repoAdvisory.findMany({
    where: { projectId, active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { id: true, pathGlob: true, severity: true, summary: true, createdBy: { select: { displayName: true } } },
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  });
  const rank = { critical: 0, warn: 1, info: 2 } as Record<string, number>;
  const out = paths.length ? rows.filter((r) => paths.some((p) => pathMatches(r.pathGlob, p) || globOverlaps(r.pathGlob, p))) : rows;
  return out
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
    .slice(0, 10)
    .map((r) => ({ id: r.id, pathGlob: r.pathGlob, severity: r.severity, summary: r.summary, createdBy: r.createdBy.displayName }));
}

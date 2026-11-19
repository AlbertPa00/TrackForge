// 071 — fleet pause: the instant brake for a misbehaving agent fleet.
// Two scopes: a global `agent.fleetPaused` SystemSetting and per-project
// `Project.agentPaused`. Both are read on the requireAuth hot path for every
// agent write, so state is cached in-process (5s TTL, matching tokenCache's
// consistency contract) and toggles invalidate immediately.
//
// Semantics: while paused, a User(type='agent') write method → 423 Locked.
// Reads, heartbeats and inbox acks stay open on purpose — a paused fleet must
// still be observable and able to drain wake-ups; humans are never gated.
import { prisma } from '../prisma.js';
import { jiraError, JiraApiError } from '../lib/errors.js';
import { audit } from './auditService.js';
import type { Actor } from '../lib/auth.js';
import type { Request } from 'express';

const GLOBAL_KEY = 'agent.fleetPaused';
const CACHE_TTL_MS = 5_000;

interface PauseState {
  paused: boolean;
  reason?: string;
}

let globalCache: { at: number; state: PauseState } | null = null;
const projectCache = new Map<string, { at: number; state: PauseState }>();
const projectKeyCache = new Map<string, { at: number; id: string | null }>();

async function globalPauseState(): Promise<PauseState> {
  if (globalCache && Date.now() - globalCache.at < CACHE_TTL_MS) return globalCache.state;
  const row = await prisma.systemSetting.findUnique({ where: { key: GLOBAL_KEY } });
  const state: PauseState = {
    paused: (row?.value as { paused?: boolean } | undefined)?.paused === true,
    reason: (row?.value as { reason?: string } | undefined)?.reason,
  };
  globalCache = { at: Date.now(), state };
  return state;
}

async function projectPauseState(projectId: string): Promise<PauseState> {
  const hit = projectCache.get(projectId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.state;
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: { agentPaused: true, agentPauseReason: true },
  });
  const state: PauseState = { paused: row?.agentPaused === true, reason: row?.agentPauseReason ?? undefined };
  projectCache.set(projectId, { at: Date.now(), state });
  return state;
}

/** Combined check — global OR project scope pauses the fleet. */
export async function fleetPausedFor(projectId?: string | null): Promise<PauseState> {
  const g = await globalPauseState();
  if (g.paused) return g;
  if (projectId) return projectPauseState(projectId);
  return { paused: false };
}

/** Express middleware check used by requireAuth — global pause plus, when the
 *  route path carries a project key (/issues/{KEY}-N, /projects/{KEY}), the
 *  per-project flag. Key → id resolution is itself cached so the common case
 *  costs zero DB round-trips. */
export async function assertNotPaused(req: Request, actor: Actor): Promise<void> {
  if (actor.user.type !== 'agent') return;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  // Agents must keep reporting liveness and draining wake-ups while paused.
  const path = req.originalUrl.split('?')[0];
  if (/\/(heartbeat|inbox\/ack)(\/|$)/.test(path)) return;

  let state = await globalPauseState();
  if (!state.paused) {
    const projectId = await projectIdFromPath(path);
    if (projectId) state = await projectPauseState(projectId);
  }
  if (state.paused) {
    throw new JiraApiError(
      423,
      jiraError([`Agent writes are paused${state.reason ? `: ${state.reason}` : '.'}`], {
        retryAfterSec: '60',
      })
    );
  }
}

const ISSUE_PATH = /(?:\/issue|\/issues)\/([A-Z][A-Z0-9]*)-\d+(?:\/|$)/;
const PROJECT_PATH = /\/projects\/([A-Z][A-Z0-9]*)(?:\/|$)/;

/** Extract the affected project id from a REST path; null when the write is
 *  not project-scoped (global pause still applies). */
async function projectIdFromPath(path: string): Promise<string | null> {
  const m = ISSUE_PATH.exec(path) ?? PROJECT_PATH.exec(path);
  const key = m?.[1];
  if (!key) return null;
  const hit = projectKeyCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.id;
  const row = await prisma.project.findUnique({ where: { key }, select: { id: true } });
  projectKeyCache.set(key, { at: Date.now(), id: row?.id ?? null });
  return row?.id ?? null;
}

export function invalidateFleetPauseCache(projectId?: string): void {
  if (projectId === undefined) globalCache = null;
  else projectCache.delete(projectId);
}

/** Project-scope toggle — project lead or site admin. Audited. */
export async function setProjectPause(
  actor: Actor,
  projectId: string,
  paused: boolean,
  reason: string | undefined,
  req?: Request
) {
  const { requirePermission } = await import('./permissionService.js');
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
  if (!actor.user.isAdmin && project.leadId !== actor.user.id) {
    await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId });
  }
  await prisma.project.update({
    where: { id: projectId },
    data: { agentPaused: paused, agentPauseReason: paused ? (reason ?? null) : null },
  });
  invalidateFleetPauseCache(projectId);
  // The key→id map can hold a stale id (project recreated under the same key);
  // a pause toggle must re-resolve the path key or writes bypass the brake.
  projectKeyCache.delete(project.key);
  if (req) {
    await audit(req, paused ? 'agent.pause' : 'agent.unpause', 'project', project.key, { reason: reason ?? null });
  }
  return { projectKey: project.key, agentPaused: paused, reason: paused ? (reason ?? null) : null };
}

/** Global toggle — site admin only. Audited. */
export async function setGlobalPause(actor: Actor, paused: boolean, reason: string | undefined, req?: Request) {
  await prisma.systemSetting.upsert({
    where: { key: GLOBAL_KEY },
    create: { key: GLOBAL_KEY, value: { paused, reason: reason ?? null, by: actor.user.displayName } },
    update: { value: { paused, reason: reason ?? null, by: actor.user.displayName } },
  });
  invalidateFleetPauseCache();
  if (req) {
    await audit(req, paused ? 'agent.fleet.pause' : 'agent.fleet.unpause', 'system', GLOBAL_KEY, { reason });
  }
  return { agentPaused: paused, reason: paused ? (reason ?? null) : null };
}

/** Current pause view for dashboards/heartbeat signals (no cache bypass —
 *  heartbeat reads hit the same 5s cache). */
export async function pauseStatus(projectId?: string | null) {
  const g = await globalPauseState();
  const p = projectId ? await projectPauseState(projectId) : { paused: false };
  return { global: g, project: p, paused: g.paused || p.paused };
}

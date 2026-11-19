// 071 US2 — agent roster: who the fleet's agents are (role, skills, model),
// whether they are reachable (heartbeat presence) and how much work they can
// take (maxConcurrentLeases). Presence derives from AgentProfile.lastHeartbeatAt
// — session heartbeats stamp it, so "online" means "recently beat", never a
// self-declared flag an agent can lie about.

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { hasPermission } from './permissionService.js';
import { projectAllowed } from '../middleware/auth.js';
import type { Actor } from '../lib/auth.js';

export const AGENT_ONLINE_TTL_SEC = Number(process.env.AGENT_ONLINE_TTL_SEC ?? 120);
export const AGENT_ROLES = ['planner', 'coder', 'reviewer', 'triage', 'security', 'qa', 'generalist'] as const;

export interface ProfileInput {
  role?: string;
  skills?: string[];
  model?: string | null;
  bio?: string | null;
  maxConcurrentLeases?: number;
}

export function presenceOf(lastHeartbeatAt: Date | null, activeLeases: number): 'online' | 'busy' | 'offline' {
  if (!lastHeartbeatAt) return 'offline';
  const alive = Date.now() - lastHeartbeatAt.getTime() <= AGENT_ONLINE_TTL_SEC * 1000;
  if (!alive) return 'offline';
  return activeLeases > 0 ? 'busy' : 'online';
}

/** Self (agent) or admin update. Skills normalize to lowercase tags so
 *  `[@role:Prisma]` and `skill=prisma` hit the same GIN index. */
export async function upsertProfile(actor: Actor, userId: string, input: ProfileInput) {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target || target.type !== 'agent' || !target.active) {
    throw new JiraApiError(404, jiraError(['Agent not found.']));
  }
  if (!actor.user.isAdmin && actor.user.id !== userId) {
    throw new JiraApiError(403, jiraError(['Only the agent itself or an admin may edit an agent profile.']));
  }
  if (input.role !== undefined && !AGENT_ROLES.includes(input.role as (typeof AGENT_ROLES)[number])) {
    throw new JiraApiError(
      400,
      jiraError([], { role: `Invalid role. Allowed: ${AGENT_ROLES.join(', ')}.` })
    );
  }
  const data = {
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.skills !== undefined ? { skills: input.skills.map((s) => s.trim().toLowerCase()).filter(Boolean) } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.bio !== undefined ? { bio: input.bio } : {}),
    ...(input.maxConcurrentLeases !== undefined ? { maxConcurrentLeases: input.maxConcurrentLeases } : {}),
  };
  const row = await prisma.agentProfile.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
  return row;
}

/** Session heartbeat stamps presence for the session's agent (upsert — an
 *  agent without a profile row still shows up as online). */
export async function touchPresence(userId: string, at: Date): Promise<void> {
  await prisma.agentProfile.upsert({
    where: { userId },
    create: { userId, lastHeartbeatAt: at },
    update: { lastHeartbeatAt: at },
  });
}

interface RosterRow {
  userId: string;
  role: string;
  skills: string[];
  model: string | null;
  bio: string | null;
  maxConcurrentLeases: number;
  lastHeartbeatAt: Date | null;
  lastSummonedAt: Date | null;
  user: { id: string; displayName: string; active?: boolean; isAssignableAgent?: boolean };
}

/** Live roster — project visibility applies when `projectKey` is given (the
 *  caller scopes "which fleet"). `status`: online|busy|offline per presenceOf. */
export async function listRoster(
  actor: Actor,
  opts: { projectKey?: string; role?: string; skill?: string; status?: 'online' | 'busy' | 'offline'; limit?: number }
) {
  if (opts.projectKey) {
    const project = await prisma.project.findUnique({ where: { key: opts.projectKey.toUpperCase() } });
    if (!project || !projectAllowed(actor, project.key)) {
      throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
    }
    if (!(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: project.id }))) {
      throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
    }
  }
  const rows = (await prisma.agentProfile.findMany({
    where: {
      user: { type: 'agent', active: true },
      ...(opts.role ? { role: opts.role.toLowerCase() } : {}),
      ...(opts.skill ? { skills: { has: opts.skill.toLowerCase() } } : {}),
    },
    include: { user: { select: { id: true, displayName: true, active: true, isAssignableAgent: true } } },
    take: Math.min(500, opts.limit ?? 200),
  })) as RosterRow[];

  // Active open-driver count per agent — presence "busy" and capacity math.
  const leaseCounts = await prisma.agentSession.groupBy({
    by: ['agentUserId'],
    where: {
      agentUserId: { in: rows.map((r) => r.userId) },
      status: { in: ['running', 'needs-answer', 'blocked'] },
      role: 'driver',
    },
    _count: { _all: true },
  });
  const countBy = new Map(leaseCounts.map((r) => [r.agentUserId, r._count._all]));

  const agents = rows.map((r) => {
    const activeLeases = countBy.get(r.userId) ?? 0;
    return {
      accountId: r.userId,
      displayName: r.user.displayName,
      role: r.role,
      skills: r.skills,
      model: r.model,
      bio: r.bio,
      maxConcurrentLeases: r.maxConcurrentLeases,
      activeLeases,
      status: presenceOf(r.lastHeartbeatAt, activeLeases),
      lastHeartbeatAt: r.lastHeartbeatAt?.toISOString() ?? null,
      assignable: r.user.isAssignableAgent,
    };
  });
  return { agents: opts.status ? agents.filter((a) => a.status === opts.status) : agents };
}

/** Agents matching a skill or role tag, ranked for summons: online first,
 *  then fewest active leases, then least-recently-summoned (round-robin so
 *  repeated `[@role:x]` summons rotate across the fleet instead of hammering
 *  the same agent). `k` bounds the wake set — a role mention must never fan
 *  out to hundreds of inboxes. */
export async function summonCandidates(
  projectId: string | null,
  tag: string,
  k = 3
): Promise<{ userId: string; displayName: string }[]> {
  const needle = tag.trim().toLowerCase();
  if (!needle) return [];
  const rows = (await prisma.agentProfile.findMany({
    where: {
      user: { type: 'agent', active: true, isAssignableAgent: true },
      OR: [{ role: needle }, { skills: { has: needle } }],
    },
    include: { user: { select: { id: true, displayName: true } } },
    take: 100,
  })) as unknown as RosterRow[];
  const onlineCutoff = new Date(Date.now() - AGENT_ONLINE_TTL_SEC * 1000);
  const leaseCounts = await prisma.agentSession.groupBy({
    by: ['agentUserId'],
    where: {
      agentUserId: { in: rows.map((r) => r.userId) },
      status: { in: ['running', 'needs-answer', 'blocked'] },
      role: 'driver',
    },
    _count: { _all: true },
  });
  const countBy = new Map(leaseCounts.map((r) => [r.agentUserId, r._count._all]));
  const ranked = rows
    .map((r) => ({
      userId: r.userId,
      displayName: r.user.displayName,
      online: r.lastHeartbeatAt !== null && r.lastHeartbeatAt >= onlineCutoff,
      leases: countBy.get(r.userId) ?? 0,
      capacity: r.maxConcurrentLeases,
      lastSummonedAt: r.lastSummonedAt?.getTime() ?? 0,
    }))
    // free capacity first; offline agents can still pick up inbox work later
    .filter((r) => r.leases < r.capacity)
    .sort((a, b) => Number(b.online) - Number(a.online) || a.leases - b.leases || a.lastSummonedAt - b.lastSummonedAt)
    .slice(0, Math.max(1, k));
  if (ranked.length) {
    await prisma.agentProfile.updateMany({
      where: { userId: { in: ranked.map((r) => r.userId) } },
      data: { lastSummonedAt: new Date() },
    });
  }
  return ranked.map(({ userId, displayName }) => ({ userId, displayName }));
}

/** Open driver-lease count used by claim/lease capacity checks. */
export async function activeDriverLeases(agentUserId: string): Promise<number> {
  return prisma.agentSession.count({
    where: { agentUserId, status: { in: ['running', 'needs-answer', 'blocked'] }, role: 'driver' },
  });
}

export async function maxConcurrentLeases(agentUserId: string): Promise<number> {
  const row = await prisma.agentProfile.findUnique({
    where: { userId: agentUserId },
    select: { maxConcurrentLeases: true },
  });
  return row?.maxConcurrentLeases ?? 1;
}

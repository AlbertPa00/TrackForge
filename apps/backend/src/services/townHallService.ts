// 071 US1 — the Town Hall: parliamentary deliberation for fleets of agents and
// humans. Channels are persistent rooms (global or project-scoped); Topics are
// typed deliberation units; Posts carry mandatory speech acts; Stances are
// zero-prose votes; a resolved topic compiles its decision into an Epic +
// blocked-by Issue DAG that ready() feeds straight into claim.
//
// Floor control exists because 300 agents answering one post is a stampede,
// not a discussion: per-topic cooldowns, post caps and depth caps are enforced
// server-side inside the write transaction — MCP tool prompts can't be trusted
// to self-regulate.

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { emitEvent } from './eventService.js';
import { hasPermission, requirePermission } from './permissionService.js';
import { projectAllowed } from '../middleware/auth.js';
import { summonCandidates } from './agentProfileService.js';
import { visibleProjectScope } from './visibilityService.js';
import { audit } from './auditService.js';
import type { Actor } from '../lib/auth.js';
import type { Prisma } from '../lib/pc.js';
import type { Request } from 'express';

export const TOPIC_KINDS = ['rfc', 'discovery', 'blocker', 'incident', 'standup'] as const;
export const SPEECH_ACTS = ['proposal', 'critique', 'evidence', 'question', 'answer', 'synthesis', 'decision'] as const;
export const STANCES = ['endorse', 'object', 'abstain'] as const;
const MAX_POSTS_PER_TOPIC = 500;
const MAX_THREAD_DEPTH = 4;
const DEFAULT_CHANNELS = [
  { slug: 'town-hall', name: 'Town Hall', description: 'Cross-cutting proposals, decisions and announcements.' },
  { slug: 'architecture', name: 'Architecture', description: 'Design RFCs and structural decisions.' },
  { slug: 'blockers', name: 'Blockers', description: 'Blocked work escalations and unblocking asks.' },
  { slug: 'reviews', name: 'Reviews', description: 'Review requests and verification verdicts.' },
] as const;

// ---------- channels ----------

/** Idempotent seed — projects get the four default rooms on first touch. */
export async function ensureProjectChannels(projectId: string): Promise<void> {
  await prisma.townHallChannel.createMany({
    data: DEFAULT_CHANNELS.map((c) => ({ projectId, ...c })),
    skipDuplicates: true,
  });
}

/** One global room so instance-wide RFCs exist even before any project does. */
export async function ensureGlobalChannels(): Promise<void> {
  const existing = await prisma.townHallChannel.findFirst({ where: { projectId: null, slug: 'town-hall' } });
  if (!existing) {
    await prisma.townHallChannel.create({
      data: { projectId: null, slug: 'town-hall', name: 'Town Hall', description: 'Instance-wide agent deliberation.' },
    });
  }
}

interface ChannelRow {
  id: string;
  projectId: string | null;
  slug: string;
  name: string;
  description: string | null;
  agentCooldownSec: number;
  archived: boolean;
  project?: { key: string } | null;
}

/** Visibility: global channels are readable by any authenticated user;
 *  project channels need token allow-list + BROWSE_PROJECTS, else 404
 *  (existence-hiding, FR-001). */
async function assertChannelVisible(actor: Actor, channel: ChannelRow & { project?: { key: string } | null }) {
  if (!channel.projectId) return;
  const key = channel.project?.key ?? (await prisma.project.findUnique({ where: { id: channel.projectId } }))?.key;
  if (
    !key ||
    !projectAllowed(actor, key) ||
    !(await hasPermission(actor, 'BROWSE_PROJECTS', { projectId: channel.projectId }))
  ) {
    throw new JiraApiError(404, jiraError(['Channel does not exist or you do not have permission to see it.']));
  }
}

export async function listChannels(actor: Actor, opts: { projectKey?: string }) {
  const scope = await visibleProjectScope(actor);
  const rows = await prisma.townHallChannel.findMany({
    where: {
      archived: false,
      OR: [
        { projectId: null },
        ...(opts.projectKey ? [{ project: { key: opts.projectKey.toUpperCase() } }] : [{ projectId: { not: null } }]),
      ],
    },
    include: { project: { select: { key: true } }, _count: { select: { topics: { where: { status: { not: 'archived' } } } } } },
    orderBy: [{ projectId: 'asc' }, { slug: 'asc' }],
  });
  const channels = rows
    .filter((c) => !c.projectId || (c.project && projectAllowed(actor, c.project.key)))
    .filter((c) => !c.projectId || (c.projectId !== null && !scope.denied.has(c.projectId) && (!scope.allowed || scope.allowed.has(c.projectId))))
    .map((c) => ({
      id: c.id,
      projectKey: c.project?.key ?? null,
      slug: c.slug,
      name: c.name,
      description: c.description,
      agentCooldownSec: c.agentCooldownSec,
      openTopics: c._count.topics,
    }));
  return { channels };
}

export async function createChannel(
  actor: Actor,
  input: { projectKey?: string; slug: string; name: string; description?: string; agentCooldownSec?: number },
  req?: Request
) {
  let projectId: string | null = null;
  if (input.projectKey) {
    const project = await prisma.project.findUnique({ where: { key: input.projectKey.toUpperCase() } });
    if (!project || !projectAllowed(actor, project.key)) {
      throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
    }
    await requirePermission(actor, 'ADMINISTER_PROJECTS', { projectId: project.id });
    projectId = project.id;
  } else if (!actor.user.isAdmin) {
    throw new JiraApiError(403, jiraError(['Only a site admin may create global channels.']));
  }
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug)) {
    throw new JiraApiError(400, jiraError([], { slug: 'Use 1-49 lowercase letters, digits and dashes.' }));
  }
  const channel = await prisma.townHallChannel.create({
    data: {
      projectId,
      slug,
      name: input.name.slice(0, 120),
      description: input.description?.slice(0, 1000) ?? null,
      agentCooldownSec: input.agentCooldownSec ?? 15,
      createdById: actor.user.id,
    },
    include: { project: { select: { key: true } } },
  });
  if (req) await audit(req, 'townhall.channel.create', 'townHallChannel', channel.id, { slug, projectKey: input.projectKey });
  return {
    id: channel.id,
    projectKey: channel.project?.key ?? null,
    slug: channel.slug,
    name: channel.name,
    agentCooldownSec: channel.agentCooldownSec,
  };
}

// ---------- topics ----------

type TopicWithChannel = Prisma.TownHallTopicGetPayload<{
  include: { channel: { include: { project: true } }; resolvedBy: { select: { displayName: true } } };
}>;

async function getTopicRow(id: string): Promise<TopicWithChannel> {
  const t = await prisma.townHallTopic.findUnique({
    where: { id },
    include: { channel: { include: { project: true } }, resolvedBy: { select: { displayName: true } } },
  });
  if (!t) throw new JiraApiError(404, jiraError(['Topic does not exist or you do not have permission to see it.']));
  return t;
}

async function assertTopicVisible(actor: Actor, t: TopicWithChannel) {
  await assertChannelVisible(actor, t.channel);
}

function mentionIds(body: string): string[] {
  return [...body.matchAll(/\[~accountId:([^\]]+)\]/g)].map((m) => m[1]!);
}
function roleMentions(body: string): string[] {
  return [...body.matchAll(/\[@role:([a-zA-Z0-9_-]+)\]/g)].map((m) => m[1]!);
}

async function resolveLinkedIssues(actor: Actor, keys: string[]): Promise<{ id: string; key: string }[]> {
  if (!keys.length) return [];
  const { parseIssueKey } = await import('./issueService.js');
  const { canSeeIssueFull } = await import('./visibilityService.js');
  const out: { id: string; key: string }[] = [];
  for (const raw of keys.slice(0, 20)) {
    const { projectKey, issueNumber } = await parseIssueKey(raw.toUpperCase());
    const issue = await prisma.issue.findFirst({
      where: { issueNumber, project: { key: projectKey } },
      select: { id: true, effSecurityLevelId: true, reporterId: true, assigneeId: true, projectId: true, archived: true },
    });
    // Existence-hiding: unseeable links silently drop (FR-001).
    if (issue && (await canSeeIssueFull(actor, issue))) out.push({ id: issue.id, key: raw.toUpperCase() });
  }
  return out;
}

export async function listTopics(
  actor: Actor,
  opts: { channelId?: string; projectKey?: string; issueKey?: string; kind?: string; status?: string; limit?: number; before?: string }
) {
  const scope = await visibleProjectScope(actor);
  const take = Math.min(100, Math.max(1, opts.limit ?? 50));
  // ?issue=KEY-1 — topics deliberating ON that issue (discusses/compiled edges).
  let issueId: string | undefined;
  if (opts.issueKey) {
    const { parseIssueKey } = await import('./issueService.js');
    const { projectKey, issueNumber } = await parseIssueKey(opts.issueKey.toUpperCase());
    const row = await prisma.issue.findFirst({ where: { issueNumber, project: { key: projectKey } }, select: { id: true } });
    if (!row) throw new JiraApiError(404, jiraError(['Issue does not exist or you do not have permission to see it.']));
    issueId = row.id;
  }
  const where: Prisma.TownHallTopicWhereInput = {
    ...(opts.channelId ? { channelId: opts.channelId } : {}),
    ...(issueId ? { issueLinks: { some: { issueId } } } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.status ? { status: opts.status } : { status: { not: 'archived' } }),
    ...(opts.before ? { lastActivityAt: { lt: new Date(opts.before) } } : {}),
    AND: [
      {
        OR: [
          { channel: { projectId: null } },
          {
            channel: {
              project: {
                key: opts.projectKey
                  ? opts.projectKey.toUpperCase()
                  : actor.token?.projectKeys?.length
                    ? { in: actor.token.projectKeys.map((k) => k.toUpperCase()) }
                    : { not: '' },
              },
            },
          },
        ],
      },
      ...(scope.denied.size ? [{ projectId: { notIn: [...scope.denied] } }] : []),
      ...(scope.allowed ? [{ OR: [{ projectId: null }, { projectId: { in: [...scope.allowed] } }] }] : []),
    ],
  };
  const rows = await prisma.townHallTopic.findMany({
    where,
    orderBy: { lastActivityAt: 'desc' },
    take,
    include: {
      channel: { include: { project: { select: { key: true } } } },
      author: { select: { id: true, displayName: true, type: true } },
      stances: { select: { stance: true, resolved: true } },
    },
  });
  return {
    topics: rows.map((t) => ({
      ...toTopicView(t),
      channelSlug: t.channel.slug,
      projectKey: t.channel.project?.key ?? null,
      tally: tallyOf(t.stances),
    })),
    nextCursor: rows.length === take ? rows[rows.length - 1]!.lastActivityAt.toISOString() : null,
  };
}

function toTopicView(t: {
  id: string;
  kind: string;
  status: string;
  title: string;
  quorumRequired: number;
  requiredRoles: string[];
  requireEvidenceReceipt?: boolean;
  decisionSummary: string | null;
  postCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  resolvedAt: Date | null;
  author?: { id: string; displayName: string; type: string } | null;
  resolvedBy?: { displayName: string } | null;
}) {
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    title: t.title,
    author: t.author ? { accountId: t.author.id, displayName: t.author.displayName, agent: t.author.type === 'agent' } : null,
    quorumRequired: t.quorumRequired,
    requiredRoles: t.requiredRoles,
    requireEvidenceReceipt: t.requireEvidenceReceipt ?? false,
    decisionSummary: t.decisionSummary,
    resolvedBy: t.resolvedBy?.displayName ?? null,
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    postCount: t.postCount,
    lastActivityAt: t.lastActivityAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
  };
}

function toPostView(p: {
  id: bigint;
  topicId: string;
  parentId: bigint | null;
  speechAct: string;
  body: string;
  channel: string;
  refs: unknown;
  createdAt: Date;
  author?: { id: string; displayName: string; type: string } | null;
  receipts?: {
    id: string;
    kind: string;
    sha256: string;
    verification: string;
    summary: string;
    payload?: { byteLength: number } | null;
    attachmentId?: string | null;
  }[];
}) {
  return {
    id: Number(p.id),
    topicId: p.topicId,
    parentId: p.parentId !== null ? Number(p.parentId) : null,
    speechAct: p.speechAct,
    body: p.body,
    channel: p.channel,
    refs: p.refs ?? null,
    author: p.author ? { accountId: p.author.id, displayName: p.author.displayName, agent: p.author.type === 'agent' } : null,
    receipts: (p.receipts ?? []).map((r) => ({
      id: r.id,
      kind: r.kind,
      sha256: r.sha256,
      verification: r.verification === 'unverified' ? 'digest_only' : r.verification,
      summary: r.summary,
      hasInlineContent: Boolean(r.payload),
      attachmentId: r.attachmentId ?? null,
    })),
    createdAt: p.createdAt.toISOString(),
  };
}

/** Quorum math: endorsements >= quorumRequired AND zero unresolved objections
 *  AND every requiredRole endorsed by at least one holder (profile role or
 *  skill match). */
function tallyOf(
  stances: { stance: string; resolved: boolean; actorId?: string }[],
  opts?: { quorumRequired?: number; requiredRoles?: string[]; endorserRoles?: Map<string, string[]> }
) {
  const endorse = stances.filter((s) => s.stance === 'endorse');
  const objections = stances.filter((s) => s.stance === 'object' && !s.resolved);
  const abstain = stances.filter((s) => s.stance === 'abstain').length;
  let rolesMet = true;
  if (opts?.requiredRoles?.length && opts.endorserRoles) {
    for (const role of opts.requiredRoles) {
      const need = role.toLowerCase();
      const ok = endorse.some((s) => s.actorId && (opts.endorserRoles!.get(s.actorId) ?? []).includes(need));
      if (!ok) {
        rolesMet = false;
        break;
      }
    }
  }
  const quorumMet = (opts?.quorumRequired ?? 1) <= endorse.length && objections.length === 0 && rolesMet;
  return { endorse: endorse.length, object: objections.length, abstain, quorumMet };
}

export interface OpenTopicInput {
  channelId: string;
  kind?: string;
  title: string;
  body: string;
  speechAct?: string;
  quorumRequired?: number;
  requiredRoles?: string[];
  linkedIssueKeys?: string[];
  // 072 FR-006 — when true, resolving requires >=1 evidence post backed by a
  // hash_verified+ WorkReceipt: consensus can't ride on prose alone.
  requireEvidenceReceipt?: boolean;
}

export async function openTopic(actor: Actor, input: OpenTopicInput) {
  const channel = await prisma.townHallChannel.findUnique({
    where: { id: input.channelId },
    include: { project: true },
  });
  if (!channel || channel.archived) throw new JiraApiError(404, jiraError(['Channel does not exist or you do not have permission to see it.']));
  await assertChannelVisible(actor, channel);
  const kind = input.kind ?? 'rfc';
  if (!TOPIC_KINDS.includes(kind as (typeof TOPIC_KINDS)[number])) {
    throw new JiraApiError(400, jiraError([], { kind: `Invalid kind. Allowed: ${TOPIC_KINDS.join(', ')}.` }));
  }
  const speechAct = input.speechAct ?? 'proposal';
  if (speechAct !== 'proposal' && speechAct !== 'question' && speechAct !== 'evidence') {
    throw new JiraApiError(400, jiraError([], { speechAct: "Opening speechAct must be 'proposal', 'question' or 'evidence'." }));
  }
  const linked = await resolveLinkedIssues(actor, input.linkedIssueKeys ?? []);
  const requiredRoles = (input.requiredRoles ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean).slice(0, 10);

  // Role summons resolve outside the tx (ranking + lastSummonedAt writes).
  const summoned = new Map<string, string>();
  for (const role of requiredRoles) {
    for (const c of await summonCandidates(channel.projectId, role)) summoned.set(c.userId, role);
  }
  for (const uid of mentionIds(input.body)) if (!summoned.has(uid)) summoned.set(uid, 'mention');

  const created = await prisma.$transaction(async (tx) => {
    const topic = await tx.townHallTopic.create({
      data: {
        channelId: channel.id,
        projectId: channel.projectId,
        kind,
        title: input.title.slice(0, 300),
        authorId: actor.user.id,
        quorumRequired: Math.max(1, Math.min(50, input.quorumRequired ?? 1)),
        requiredRoles,
        requireEvidenceReceipt: input.requireEvidenceReceipt === true,
        status: input.quorumRequired && input.quorumRequired > 1 ? 'voting' : requiredRoles.length ? 'voting' : 'open',
        postCount: 1,
      },
    });
    const post = await tx.townHallPost.create({
      data: {
        topicId: topic.id,
        authorId: actor.user.id,
        channel: actor.channel,
        speechAct,
        body: input.body.slice(0, 32_000),
      },
    });
    if (linked.length) {
      await tx.townHallTopicIssue.createMany({
        data: linked.map((i) => ({ topicId: topic.id, issueId: i.id, relation: 'discusses' })),
        skipDuplicates: true,
      });
    }
    await emitEvent(tx, actor, {
      type: 'town_hall.topic_created',
      projectId: channel.projectId,
      payload: {
        topicId: topic.id,
        channelId: channel.id,
        projectKey: channel.project?.key ?? undefined,
        title: topic.title,
        kind,
        snippet: input.body.slice(0, 300),
        inbox: [...summoned].map(([userId, why]) => ({
          userId,
          reason: why === 'mention' ? 'mention' : 'role_summon',
          actionHint: `New ${kind} '${topic.title}' awaits your ${why === 'mention' ? 'response' : `expertise (${why})`}.`,
          topicId: topic.id,
        })),
      },
    });
    return { topic, post };
  });
  return {
    topic: { ...toTopicView(created.topic), projectKey: channel.project?.key ?? null, channelSlug: channel.slug },
    post: toPostView({ ...created.post, author: actor.user }),
    summoned: summoned.size,
  };
}

export async function getTopic(actor: Actor, id: string) {
  const t = await getTopicRow(id);
  await assertTopicVisible(actor, t);
  const [posts, stances, issueLinks] = await Promise.all([
    prisma.townHallPost.findMany({
      where: { topicId: t.id },
      orderBy: { id: 'asc' },
      include: {
        author: { select: { id: true, displayName: true, type: true } },
        receipts: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            kind: true,
            sha256: true,
            verification: true,
            summary: true,
            attachmentId: true,
            payload: { select: { byteLength: true } },
          },
        },
      },
    }),
    prisma.townHallStance.findMany({
      where: { topicId: t.id },
      include: { actor: { select: { id: true, displayName: true, type: true } } },
    }),
    prisma.townHallTopicIssue.findMany({
      where: { topicId: t.id },
      include: {
        issue: {
          select: {
            id: true,
            issueNumber: true,
            summary: true,
            project: { select: { key: true } },
            status: { select: { name: true } },
            _count: { select: { workReceipts: true } },
          },
        },
      },
    }),
  ]);
  const endorserRoles = new Map<string, string[]>();
  const profiles = await prisma.agentProfile.findMany({
    where: { userId: { in: stances.map((s) => s.actorId) } },
    select: { userId: true, role: true, skills: true },
  });
  for (const p of profiles) endorserRoles.set(p.userId, [p.role.toLowerCase(), ...p.skills]);
  const { visibleIssueIds } = await import('./visibilityService.js');
  const visible = await visibleIssueIds(
    actor,
    issueLinks.map((l) => l.issueId)
  );
  const tally = tallyOf(stances, { quorumRequired: t.quorumRequired, requiredRoles: t.requiredRoles, endorserRoles });
  return {
    topic: {
      ...toTopicView({ ...t, resolvedBy: t.resolvedBy }),
      projectKey: t.channel.project?.key ?? null,
      channelSlug: t.channel.slug,
      channelId: t.channelId,
    },
    posts: posts.map((p) => toPostView(p)),
    stances: stances.map((s) => ({
      actor: { accountId: s.actor.id, displayName: s.actor.displayName, agent: s.actor.type === 'agent' },
      stance: s.stance,
      reason: s.reason,
      resolved: s.resolved,
      updatedAt: s.updatedAt.toISOString(),
    })),
    tally,
    linkedIssues: issueLinks
      .filter((l) => visible.has(l.issueId))
      .map((l) => ({
        key: `${l.issue.project.key}-${l.issue.issueNumber}`,
        summary: l.issue.summary,
        status: l.issue.status.name,
        relation: l.relation,
        receiptCount: l.issue._count.workReceipts,
      })),
  };
}

export interface PostInput {
  parentId?: number;
  speechAct: string;
  body: string;
  refs?: { issueKeys?: string[]; files?: string[]; commitSha?: string };
}

export async function postToTopic(actor: Actor, topicId: string, input: PostInput) {
  const t = await getTopicRow(topicId);
  await assertTopicVisible(actor, t);
  if (t.status !== 'open' && t.status !== 'voting') {
    throw new JiraApiError(409, jiraError([], { topic: `Topic is ${t.status} — no further posts.` }));
  }
  if (!SPEECH_ACTS.includes(input.speechAct as (typeof SPEECH_ACTS)[number]) || input.speechAct === 'decision') {
    throw new JiraApiError(
      400,
      jiraError([], { speechAct: `Invalid speechAct. Allowed: ${SPEECH_ACTS.filter((a) => a !== 'decision').join(', ')}.` })
    );
  }

  // ---- floor control (agents only — humans are never rate-capped here) ----
  if (actor.user.type === 'agent') {
    if (t.postCount >= MAX_POSTS_PER_TOPIC) {
      throw new JiraApiError(429, jiraError(['Topic post cap reached — resolve or archive it.'], { retryAfterSec: '60' }));
    }
    // The topic's opening post doesn't start the author's cooldown clock —
    // floor control throttles repeat posts, not the first reply on a topic
    // you just opened.
    const firstPost = await prisma.townHallPost.findFirst({
      where: { topicId: t.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const last = await prisma.townHallPost.findFirst({
      where: { topicId: t.id, authorId: actor.user.id, ...(firstPost ? { NOT: { id: firstPost.id } } : {}) },
      orderBy: { id: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (last) {
      const elapsed = Date.now() - last.createdAt.getTime();
      const cooldownMs = t.channel.agentCooldownSec * 1000;
      if (elapsed < cooldownMs) {
        // Bypass: someone @mentioned this agent after their last post — the
        // reply is prompted, not a stampede loop.
        const mention = await prisma.townHallPost.findFirst({
          where: { topicId: t.id, id: { gt: last.id }, body: { contains: `[~accountId:${actor.user.id}]` } },
          select: { id: true },
        });
        if (!mention) {
          throw new JiraApiError(
            429,
            jiraError([`Floor control: wait ${Math.ceil((cooldownMs - elapsed) / 1000)}s between posts on one topic.`], {
              retryAfterSec: String(Math.ceil((cooldownMs - elapsed) / 1000)),
            })
          );
        }
      }
    }
  }

  // Thread depth: walk up the parent chain (bounded by the topic's post cap).
  let parentId: bigint | null = null;
  if (input.parentId !== undefined) {
    let depth = 1;
    let cur = await prisma.townHallPost.findUnique({ where: { id: BigInt(input.parentId) }, select: { id: true, parentId: true, topicId: true } });
    if (!cur || cur.topicId !== t.id) {
      throw new JiraApiError(400, jiraError([], { parentId: 'Parent post not found in this topic.' }));
    }
    while (cur?.parentId != null) {
      depth += 1;
      cur = await prisma.townHallPost.findUnique({ where: { id: cur.parentId }, select: { id: true, parentId: true, topicId: true } });
    }
    if (depth > MAX_THREAD_DEPTH) {
      throw new JiraApiError(400, jiraError([], { parentId: `Max thread depth is ${MAX_THREAD_DEPTH} — reply at the topic level.` }));
    }
    parentId = BigInt(input.parentId);
  }

  const summoned = new Map<string, string>();
  for (const role of roleMentions(input.body)) {
    for (const c of await summonCandidates(t.projectId, role)) summoned.set(c.userId, 'role_summon');
  }
  for (const uid of mentionIds(input.body)) if (!summoned.has(uid)) summoned.set(uid, 'mention');

  const post = await prisma.$transaction(async (tx) => {
    const p = await tx.townHallPost.create({
      data: {
        topicId: t.id,
        parentId,
        authorId: actor.user.id,
        channel: actor.channel,
        speechAct: input.speechAct,
        body: input.body.slice(0, 32_000),
        refs: (input.refs ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    await tx.townHallTopic.update({
      where: { id: t.id },
      data: { postCount: { increment: 1 }, lastActivityAt: new Date() },
    });
    await emitEvent(tx, actor, {
      type: 'town_hall.post_created',
      projectId: t.projectId,
      payload: {
        topicId: t.id,
        channelId: t.channelId,
        projectKey: t.channel.project?.key ?? undefined,
        postId: Number(p.id),
        parentId: parentId !== null ? Number(parentId) : null,
        speechAct: input.speechAct,
        snippet: input.body.slice(0, 300),
        inbox: [...summoned].map(([userId, reason]) => ({
          userId,
          reason,
          actionHint: `${actor.user.displayName} posted a ${input.speechAct} on '${t.title}'.`,
          topicId: t.id,
        })),
      },
    });
    return p;
  });
  return toPostView({ ...post, author: actor.user });
}

export async function putStance(actor: Actor, topicId: string, input: { stance: string; reason?: string }) {
  const t = await getTopicRow(topicId);
  await assertTopicVisible(actor, t);
  if (t.status !== 'open' && t.status !== 'voting') {
    throw new JiraApiError(409, jiraError([], { topic: `Topic is ${t.status} — stances are closed.` }));
  }
  if (!STANCES.includes(input.stance as (typeof STANCES)[number])) {
    throw new JiraApiError(400, jiraError([], { stance: `Invalid stance. Allowed: ${STANCES.join(', ')}.` }));
  }
  const reason = input.reason?.trim();
  if (input.stance === 'object' && (!reason || reason.length < 10 || reason.length > 2000)) {
    throw new JiraApiError(400, jiraError([], { reason: 'An objection requires a cited reason (10-2000 chars).' }));
  }
  await prisma.$transaction(async (tx) => {
    await tx.townHallStance.upsert({
      where: { topicId_actorId: { topicId: t.id, actorId: actor.user.id } },
      create: { topicId: t.id, actorId: actor.user.id, stance: input.stance, reason: reason ?? null },
      update: { stance: input.stance, reason: reason ?? null, resolved: false },
    });
    if (t.status === 'open') await tx.townHallTopic.update({ where: { id: t.id }, data: { status: 'voting' } });
    await emitEvent(tx, actor, {
      type: 'town_hall.stance_updated',
      projectId: t.projectId,
      payload: {
        topicId: t.id,
        channelId: t.channelId,
        projectKey: t.channel.project?.key ?? undefined,
        stance: input.stance,
      },
    });
  });
  return getTopic(actor, topicId).then((v) => v.tally);
}

// ---------- resolve → compiled DAG ----------

interface DagTask {
  tempId: string;
  summary: string;
  issueType?: string;
  description?: string;
  roleHint?: string;
  targetFiles?: string[];
  blockedByTempIds?: string[];
}
interface DagSpec {
  epic?: { summary: string; issueType?: string };
  tasks: DagTask[];
}

/** Topological order + cycle/unknown-ref validation for compileDag. */
function topoSort(tasks: DagTask[]): DagTask[] {
  const byId = new Map(tasks.map((t) => [t.tempId, t]));
  const seen = new Set<string>();
  const done = new Set<string>();
  const out: DagTask[] = [];
  const visit = (t: DagTask, path: string[]) => {
    if (done.has(t.tempId)) return;
    if (seen.has(t.tempId)) {
      throw new JiraApiError(400, jiraError([], { compileDag: `Cycle detected: ${[...path, t.tempId].join(' → ')}.` }));
    }
    seen.add(t.tempId);
    for (const dep of t.blockedByTempIds ?? []) {
      const d = byId.get(dep);
      if (!d) throw new JiraApiError(400, jiraError([], { compileDag: `Unknown blockedByTempId '${dep}' on task '${t.tempId}'.` }));
      visit(d, [...path, t.tempId]);
    }
    done.add(t.tempId);
    out.push(t);
  };
  for (const t of tasks) visit(t, []);
  return out;
}

export interface ResolveInput {
  decisionSummary: string;
  compileDag?: DagSpec;
  overrideObjections?: boolean;
}

export async function resolveTopic(actor: Actor, topicId: string, input: ResolveInput, opts: { dryRun?: boolean; req?: Request } = {}) {
  const t = await getTopicRow(topicId);
  await assertTopicVisible(actor, t);
  if (t.status === 'decided') throw new JiraApiError(409, jiraError([], { topic: 'Topic is already decided.' }));
  if (t.status === 'archived') throw new JiraApiError(409, jiraError([], { topic: 'Topic is archived.' }));
  const projectId = t.projectId;

  // Resolver authority: site admin, project lead, ADMINISTER_PROJECTS, or the
  // topic author once quorum is met (moderator-by-consensus).
  const project = projectId ? await prisma.project.findUnique({ where: { id: projectId } }) : null;
  const isLead = project?.leadId === actor.user.id;
  const isAdmin = actor.user.isAdmin;
  let mayResolve = isAdmin || isLead;
  if (!mayResolve && projectId) mayResolve = await hasPermission(actor, 'ADMINISTER_PROJECTS', { projectId });
  const stances = await prisma.townHallStance.findMany({ where: { topicId: t.id } });
  const endorserRoles = new Map<string, string[]>();
  for (const p of await prisma.agentProfile.findMany({
    where: { userId: { in: stances.map((s) => s.actorId) } },
    select: { userId: true, role: true, skills: true },
  })) {
    endorserRoles.set(p.userId, [p.role.toLowerCase(), ...p.skills]);
  }
  const tally = tallyOf(stances, { quorumRequired: t.quorumRequired, requiredRoles: t.requiredRoles, endorserRoles });
  if (!mayResolve && tally.quorumMet && t.authorId === actor.user.id) mayResolve = true;
  if (!mayResolve) {
    throw new JiraApiError(
      403,
      jiraError(['Only a site admin, the project lead, an ADMINISTER_PROJECTS holder, or the topic author after quorum may resolve a topic.'])
    );
  }
  // 072 FR-006 — Proof-Carrying quorum: a flagged topic can't resolve on
  // prose alone; at least one evidence post must carry a verified receipt.
  if (t.requireEvidenceReceipt) {
    const { topicHasReceiptBackedEvidence } = await import('./receiptService.js');
    if (!(await topicHasReceiptBackedEvidence(t.id))) {
      throw new JiraApiError(
        422,
        jiraError([], {
          evidence: "This topic requires at least one 'evidence' post carrying a hash_verified+ work receipt — attach POST /work-receipts {topicPostId} first.",
        })
      );
    }
  }
  const unresolvedObjections = stances.filter((s) => s.stance === 'object' && !s.resolved);
  if (unresolvedObjections.length && !input.overrideObjections) {
    throw new JiraApiError(
      409,
      jiraError([], {
        objections: `${unresolvedObjections.length} unresolved objection(s) — address them or pass overrideObjections (admin/lead only).`,
      })
    );
  }
  if (unresolvedObjections.length && input.overrideObjections && !isAdmin && !isLead) {
    throw new JiraApiError(403, jiraError(['Only a site admin or project lead may override unresolved objections.']));
  }

  const dag = input.compileDag;
  const ordered = dag?.tasks?.length ? topoSort(dag.tasks) : [];
  if (dag && !projectId) {
    throw new JiraApiError(400, jiraError([], { compileDag: 'DAG compilation requires a project channel — global topics cannot mint issues.' }));
  }

  if (opts.dryRun) {
    return {
      dryRun: true,
      decisionSummary: input.decisionSummary,
      objectionsOverridden: input.overrideObjections ? unresolvedObjections.length : 0,
      plan: dag
        ? {
            epic: dag.epic ? { summary: dag.epic.summary, issueType: dag.epic.issueType ?? 'Epic' } : null,
            tasks: ordered.map((x) => ({
              tempId: x.tempId,
              summary: x.summary,
              issueType: x.issueType ?? 'Task',
              roleHint: x.roleHint ?? null,
              blockedBy: x.blockedByTempIds ?? [],
            })),
          }
        : null,
    };
  }

  // Compile first, resolve second: sequential createIssue calls keep each
  // issue atomic (own tx, own event + changelog); the final link+decision
  // batch is itself one tx so a mid-compile failure leaves the topic OPEN and
  // retryable — never half-decided.
  const projectKey = project!.key;
  const createdKeys = new Map<string, string>(); // tempId -> issueKey
  if (dag) {
    const { createIssue, toIssueKey } = await import('./issueService.js');
    let epicKey: string | null = null;
    if (dag.epic) {
      const epic = await createIssue(
        { projectKey, summary: dag.epic.summary.slice(0, 500), issueTypeName: dag.epic.issueType ?? 'Epic' },
        actor
      );
      epicKey = toIssueKey(projectKey, epic.issueNumber);
      createdKeys.set('__epic__', epicKey);
    }
    for (const task of ordered) {
      const labels = task.roleHint ? [`role:${task.roleHint.trim().toLowerCase()}`] : [];
      const created = await createIssue(
        {
          projectKey,
          summary: task.summary.slice(0, 500),
          description: task.description ?? undefined,
          issueTypeName: task.issueType ?? 'Task',
          parentKey: epicKey ?? undefined,
          labels,
        },
        actor
      );
      createdKeys.set(task.tempId, toIssueKey(projectKey, created.issueNumber));
    }
  }

  const linkType = await prisma.issueLinkType.findUnique({ where: { name: 'Blocks' } });
  const decided = await prisma.$transaction(async (tx) => {
    // TownHallTopicIssue links + Blocks edges in one tx.
    const issueIds = new Map<string, string>();
    for (const [tempId, key] of createdKeys) {
      if (tempId === '__epic__') continue;
      const { parseIssueKey } = await import('./issueService.js');
      const { issueNumber } = await parseIssueKey(key);
      const row = await tx.issue.findFirst({ where: { issueNumber, project: { key: projectKey } }, select: { id: true } });
      if (row) {
        issueIds.set(tempId, row.id);
        await tx.townHallTopicIssue.create({ data: { topicId: t.id, issueId: row.id, relation: 'compiled' } });
      }
    }
    if (linkType) {
      for (const task of ordered) {
        for (const dep of task.blockedByTempIds ?? []) {
          const outward = issueIds.get(dep);
          const inward = issueIds.get(task.tempId);
          if (outward && inward) {
            await tx.issueLink.create({ data: { typeId: linkType.id, outwardId: outward, inwardId: inward } });
          }
        }
      }
    }
    const decisionPost = await tx.townHallPost.create({
      data: {
        topicId: t.id,
        authorId: actor.user.id,
        channel: actor.channel,
        speechAct: 'decision',
        body: input.decisionSummary.slice(0, 32_000),
        refs: createdKeys.size
          ? ({ compiled: [...createdKeys.values()] } as Prisma.InputJsonValue)
          : undefined,
      },
    });
    const topic = await tx.townHallTopic.update({
      where: { id: t.id },
      data: {
        status: 'decided',
        decisionSummary: input.decisionSummary.slice(0, 10_000),
        resolvedById: actor.user.id,
        resolvedAt: new Date(),
        postCount: { increment: 1 },
        lastActivityAt: new Date(),
      },
    });
    if (unresolvedObjections.length && input.overrideObjections) {
      await tx.townHallStance.updateMany({
        where: { topicId: t.id, stance: 'object', resolved: false },
        data: { resolved: true },
      });
    }
    await emitEvent(tx, actor, {
      type: 'town_hall.topic_decided',
      projectId: t.projectId,
      payload: {
        topicId: t.id,
        channelId: t.channelId,
        projectKey,
        decisionSummary: input.decisionSummary.slice(0, 500),
        compiled: [...createdKeys.values()],
        postId: Number(decisionPost.id),
        inbox:
          t.authorId !== actor.user.id
            ? [
                {
                  userId: t.authorId,
                  reason: 'directive',
                  actionHint: `'${t.title}' was decided by ${actor.user.displayName}.`,
                  topicId: t.id,
                },
              ]
            : [],
      },
    });
    return topic;
  });
  if (opts.req) {
    await audit(opts.req, 'townhall.topic.resolve', 'townHallTopic', t.id, {
      compiled: [...createdKeys.values()],
      objectionsOverridden: input.overrideObjections ? unresolvedObjections.length : 0,
    });
  }
  return {
    topic: { ...toTopicView(decided), projectKey, channelSlug: t.channel.slug },
    compiled: [...createdKeys.entries()].filter(([k]) => k !== '__epic__').map(([tempId, key]) => ({ tempId, issueKey: key })),
    epic: createdKeys.get('__epic__') ?? null,
  };
}

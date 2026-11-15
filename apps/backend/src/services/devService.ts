// Sprint 038: git ingest, DevelopmentItem normalization, smart commits, panel data.
import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { issueKeyToWhere, parseIssueKeyParts } from '../lib/issueKey.js';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { addComment } from './commentService.js';
import { addWorklog } from './worklogService.js';
import { getIssueTransitions, executeTransition } from './issueService.js';
import { emitEvent } from './eventService.js';
import { encryptSecret, readSecret } from '../lib/ai.js';
import type { Actor } from '../lib/auth.js';

const KEY_RE = /[A-Z][A-Z0-9]+-\d+/g;

export function verifySignature(secret: string, raw: string, header?: string): boolean {
  if (!header) return false;
  const sig = header.replace(/^sha256=/, '');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface NormalizedItem {
  type: 'branch' | 'commit' | 'pull_request' | 'build' | 'deployment' | 'feature_flag';
  externalId: string;
  title: string;
  url?: string;
  authorName?: string;
  authorEmail?: string;
  state: string;
  keyText: string; // text scanned for issue keys
  smartCommitText?: string;
  /** 051: provider-typed extras the panel formats via a provider map (FR-002). */
  gitlab?: {
    mergeRequest?: { reviewers?: (string | undefined)[]; sourceBranch?: string; targetBranch?: string };
    pipeline?: { stages?: unknown; jobs?: unknown };
    deployment?: { environment?: string };
    featureFlag?: { name?: string; state?: string };
  };
}
type Normalized = NormalizedItem;

// --- provider adapters → shared shape (FR-002) ---
function normalize(provider: string, body: Record<string, unknown>): { deliveryId: string; items: Normalized[] } {
  const items: Normalized[] = [];
  let deliveryId = '';
  if (provider === 'github') {
    deliveryId = String(body.delivery ?? body.after ?? '');
    const repoUrl = (body.repository as { html_url?: string })?.html_url ?? '';
    for (const c of (body.commits as Record<string, unknown>[] | undefined) ?? []) {
      items.push({
        type: 'commit',
        externalId: String(c.id).slice(0, 12),
        title: String(c.message).split('\n')[0],
        url: String(c.url ?? `${repoUrl}/commit/${c.id}`),
        authorName: (c.author as { name?: string })?.name,
        authorEmail: (c.author as { email?: string })?.email,
        state: 'committed',
        keyText: String(c.message),
        smartCommitText: String(c.message),
      });
    }
    const pr = body.pull_request as Record<string, unknown> | undefined;
    if (pr) {
      items.push({
        type: 'pull_request',
        externalId: String(pr.number),
        title: String(pr.title),
        url: String(pr.html_url ?? ''),
        authorName: (pr.user as { login?: string })?.login,
        state: pr.merged_at ? 'merged' : String(pr.state ?? 'open'),
        keyText: `${(pr.head as { ref?: string })?.ref ?? ''} ${pr.title} ${pr.body ?? ''}`,
      });
      deliveryId ||= `pr-${pr.number}-${pr.updated_at}`;
    }
    if (body.ref && !pr && String(body.ref).startsWith('refs/heads/')) {
      // Any push to a branch upserts the branch item (Jira shows the branch itself).
      items.push({
        type: 'branch',
        externalId: String(body.ref),
        title: String(body.ref).split('/').pop()!,
        state: 'open',
        keyText: String(body.ref),
      });
      deliveryId ||= `branch-${body.ref}`;
    }
  } else if (provider === 'gitlab' || provider === 'bitbucket') {
    deliveryId = String(body.event_id ?? body.event_type ?? body.checkout_sha ?? '');
    for (const c of (body.commits as Record<string, unknown>[] | undefined) ?? []) {
      items.push({
        type: 'commit',
        externalId: String(c.id).slice(0, 12),
        title: String(c.message ?? c.title ?? '').split('\n')[0],
        url: String(c.url ?? ''),
        authorName: (c.author as { name?: string })?.name,
        authorEmail: (c.author as { email?: string })?.email,
        state: 'committed',
        keyText: String(c.message ?? ''),
        smartCommitText: String(c.message ?? ''),
      });
    }
    const mr = (body.object_attributes ?? body.pullrequest) as Record<string, unknown> | undefined;
    if (body.object_kind === 'merge_request' && mr) {
      // 051: reviewers/approvals + source→target ride the payload (FR-002).
      const proj = body.project as { web_url?: string } | undefined;
      items.push({
        type: 'pull_request',
        externalId: String(mr.iid ?? mr.id),
        title: String(mr.title ?? ''),
        url: String(mr.url ?? (proj?.web_url ? `${proj.web_url}/-/merge_requests/${mr.iid}` : '')),
        authorName: (body.user as { name?: string })?.name,
        state: String(mr.state === 'opened' ? 'open' : (mr.state ?? mr.action ?? 'open')),
        keyText: `${mr.source_branch ?? ''} ${mr.title ?? ''} ${mr.description ?? ''}`,
        gitlab: {
          mergeRequest: {
            reviewers: ((body.reviewers ?? mr.reviewers) as { name?: string }[] | undefined)?.map((r) => r.name),
            sourceBranch: String(mr.source_branch ?? ''),
            targetBranch: String(mr.target_branch ?? ''),
          },
        },
      });
      deliveryId ||= `mr-${mr.id}-${mr.updated_at ?? mr.updated_on ?? ''}`;
    } else if (mr) {
      items.push({
        type: 'pull_request',
        externalId: String(mr.iid ?? mr.id),
        title: String(mr.title ?? ''),
        url: String(mr.url ?? (mr.links as { html?: { href?: string } })?.html?.href ?? ''),
        state: String(mr.state ?? mr.action ?? 'open'),
        keyText: `${mr.source_branch ?? ''} ${mr.title ?? ''} ${mr.description ?? ''}`,
      });
      deliveryId ||= `mr-${mr.id}-${mr.updated_at ?? mr.updated_on ?? ''}`;
    }
    // 051: pipeline / deployment / feature_flag / tag_push coverage.
    if (body.object_kind === 'pipeline') {
      const p = (body.object_attributes ?? {}) as { id?: number; status?: string; ref?: string };
      const proj = body.project as { web_url?: string } | undefined;
      items.push({
        type: 'build',
        externalId: String(p.id),
        title: `Pipeline #${p.id} (${p.ref ?? ''})`,
        url: proj?.web_url ? `${proj.web_url}/-/pipelines/${p.id}` : undefined,
        state: String(p.status ?? 'unknown'),
        keyText: p.ref ?? '',
        gitlab: { pipeline: { stages: body.builds ?? [] } },
      });
      deliveryId ||= `pipe-${p.id}-${p.status}`;
    }
    if (body.object_kind === 'deployment') {
      const d = (body.object_attributes ?? body) as {
        id?: number;
        status?: string;
        environment?: string;
        deployable_url?: string;
      };
      items.push({
        type: 'deployment',
        externalId: String(d.id ?? body.deployment_id),
        title: `Deploy → ${d.environment ?? 'env'}`,
        url: String(d.deployable_url ?? ''),
        state: String(d.status ?? body.status ?? 'success'),
        keyText: `${d.environment ?? ''} ${body.ref ?? ''}`,
        gitlab: { deployment: { environment: String(d.environment ?? '') } },
      });
      deliveryId ||= `deploy-${d.id ?? body.deployment_id}-${d.status}`;
    }
    if (body.object_kind === 'feature_flag') {
      const f = (body.object_attributes ?? {}) as { name?: string; state?: string; id?: number };
      items.push({
        type: 'feature_flag',
        externalId: String(f.name ?? f.id),
        title: `Flag ${f.name}`,
        state: String(f.state ?? ''),
        keyText: f.name ?? '',
        gitlab: { featureFlag: { name: f.name, state: String(f.state ?? '') } },
      });
      deliveryId ||= `flag-${f.name}-${f.state}`;
    }
    if (body.object_kind === 'tag_push' || (provider === 'gitlab' && String(body.ref ?? '').startsWith('refs/tags/'))) {
      const tag = String(body.ref ?? '').replace('refs/tags/', '');
      items.push({ type: 'branch', externalId: `tag/${tag}`, title: `Tag ${tag}`, state: 'tagged', keyText: tag });
      deliveryId ||= `tag-${tag}-${body.checkout_sha ?? ''}`;
    }
  }
  return { deliveryId: deliveryId || crypto.randomUUID(), items };
}

async function resolveActor(email?: string | null): Promise<{ userId: string | null; attributed: string | null }> {
  if (email) {
    // 064 US4 — a git author email is attacker-controlled (`git commit
    // --author`). Only users with a *verified* external identity may be
    // impersonated by smart commits; everyone else runs as the service actor
    // with the claimed address recorded as attribution text. Admins always
    // fall through to the service actor — never by email alone.
    const u = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { externalIdentities: { take: 1, select: { id: true } } },
    });
    if (u?.active && !u.isAdmin && u.externalIdentities.length > 0) {
      return { userId: u.id, attributed: null };
    }
  }
  // 065 audit D2 — unverified authors get NO actor: their commands must not
  // execute as a site admin. Items still link; commands are skipped.
  return { userId: null, attributed: email ?? 'unknown committer' };
}

const CMD_RE = /#(comment|time|done|transition)(?:\s+"([^"]+)"|\s+(\S.*)?)?/g;

async function smartCommit(issueKey: string, actor: Actor, text: string, repoId: string) {
  for (const m of text.matchAll(CMD_RE)) {
    const [, cmd, quoted, rest] = m;
    const arg = (quoted ?? rest ?? '').trim();
    try {
      if (cmd === 'comment' && arg) {
        await addComment(issueKey, arg, actor);
      } else if (cmd === 'time' && arg) {
        const where = issueKeyToWhere(issueKey);
        const issue = where
          ? await prisma.issue.findFirst({
              where,
              select: { id: true, projectId: true, originalEstimateSec: true, remainingEstimateSec: true },
            })
          : null;
        if (issue) await addWorklog(issue, issueKey, { timeSpent: arg }, {}, actor);
      } else if (cmd === 'done' || cmd === 'transition') {
        const name = cmd === 'done' ? 'Done' : arg;
        const transitions = await getIssueTransitions(issueKey, actor);
        const t = transitions.find((x: { name: string; id: string }) => x.name.toLowerCase() === name.toLowerCase());
        if (t) await executeTransition(issueKey, t.id, actor);
      }
    } catch (e) {
      await prisma.devDelivery
        .create({
          data: {
            repoId,
            deliveryId: `smartcommit-fail-${crypto.randomUUID()}`,
            status: 'error',
            error: `${issueKey} #${cmd}: ${(e as Error).message}`.slice(0, 500),
          },
        })
        .catch(() => {});
    }
  }
}

/** Signed ingest entry. Returns delivery status. `deliveryHint` wins over
 * the body-derived id — 051 passes GitLab's X-Gitlab-Event-UUID here. */
export async function ingest(
  repoId: string,
  provider: string,
  raw: string,
  sig: string | undefined,
  deliveryHint = ''
) {
  const repo = await prisma.devRepository.findUnique({ where: { id: repoId } });
  if (!repo || !repo.enabled) throw new JiraApiError(404, jiraError(['Repository not found.']));
  // 065 F3 — secret is AES-256-GCM at rest; readSecret reads legacy plaintext.
  if (!verifySignature(readSecret(repo.webhookSecret), raw, sig)) {
    await prisma.devDelivery.create({
      data: { repoId, deliveryId: `forged-${crypto.randomUUID()}`, status: 'bad_signature' },
    });
    throw new JiraApiError(401, jiraError(['Bad signature.']));
  }
  const body = JSON.parse(raw) as Record<string, unknown>;
  const { deliveryId: bodyId, items } = normalize(provider, body);
  const deliveryId = deliveryHint || bodyId;
  const dup = await prisma.devDelivery.findUnique({ where: { repoId_deliveryId: { repoId, deliveryId } } });
  if (dup) return { status: 'duplicate', items: 0 };
  const stats = await ingestNormalized(repoId, items);
  await prisma.devDelivery.create({
    data: { repoId, deliveryId, status: 'processed', payload: body as Prisma.InputJsonValue },
  });
  return { status: 'processed', items: stats.items, linked: stats.linked };
}

/** 038 leftover: admin re-link/debug — re-run a stored delivery's payload
 * through ingestNormalized (e.g. after the issue was created post-delivery). */
export async function reprocessDelivery(deliveryId: string) {
  const d = await prisma.devDelivery.findUnique({ where: { id: deliveryId }, include: { repo: true } });
  if (!d || !d.payload) throw new JiraApiError(404, jiraError(['Delivery not found or has no stored payload.']));
  const { items } = normalize(d.repo.provider, d.payload as Record<string, unknown>);
  const stats = await ingestNormalized(d.repoId, items);
  await prisma.devDelivery.update({ where: { id: d.id }, data: { status: 'processed', error: null } });
  return { status: 'reprocessed', items: stats.items, linked: stats.linked };
}

/** 051: shared item upsert+link path — webhook ingest, devinfo receiver,
 * GitLab backfill/poll, and outbound actions all converge here. */
export async function ingestNormalized(repoId: string, items: NormalizedItem[]) {
  const linked: string[] = [];
  // 065 audit D2 — when the repo declares a project map, keys outside the
  // mapped projects must not link or execute smart-commit commands: push
  // access to one repo must never reach every project in the instance.
  const repo = await prisma.devRepository.findUnique({ where: { id: repoId }, select: { projectKeyMap: true } });
  const mappedProjects = new Set(
    Object.values((repo?.projectKeyMap ?? {}) as Record<string, string>).map((k) => k.toUpperCase())
  );
  for (const it of items) {
    const keys = [...new Set(it.keyText.match(KEY_RE) ?? [])].filter(
      (k) => !mappedProjects.size || mappedProjects.has(parseIssueKeyParts(k)?.projectKey ?? '')
    );
    const issues = keys.length
      ? await prisma.issue.findMany({
          where: {
            OR: keys.flatMap((k) => issueKeyToWhere(k) ?? []),
          },
          select: { id: true, issueNumber: true, project: { select: { key: true } } },
        })
      : [];
    // resolve keys → issues (keys are global: KEY-N)
    const keyMap = new Map<string, string>();
    for (const k of keys) {
      const parts = parseIssueKeyParts(k);
      const i = parts && issues.find((x) => x.project.key === parts.projectKey && x.issueNumber === parts.issueNumber);
      if (i) keyMap.set(k, i.id);
    }
    const item = await prisma.developmentItem.upsert({
      where: { repoId_type_externalId: { repoId, type: it.type, externalId: it.externalId } },
      create: {
        repoId,
        type: it.type,
        externalId: it.externalId,
        title: it.title.slice(0, 500),
        url: it.url,
        authorName: it.authorName,
        authorEmail: it.authorEmail,
        state: it.state,
        payload: it as unknown as Prisma.InputJsonValue,
      },
      update: { title: it.title.slice(0, 500), state: it.state, payload: it as unknown as Prisma.InputJsonValue },
    });
    for (const issueId of keyMap.values()) {
      await prisma.developmentItemIssue.upsert({
        where: { itemId_issueId: { itemId: item.id, issueId } },
        create: { itemId: item.id, issueId },
        update: {},
      });
      linked.push(issueId);
      // FR-004: dev events drive automation/realtime.
      const issue = await prisma.issue.findUnique({ where: { id: issueId }, include: { project: true } });
      if (issue) {
        await emitEvent(prisma, null, {
          type: 'dev_status_changed',
          issueId,
          projectId: issue.projectId,
          payload: {
            issueKey: `${issue.project.key}-${issue.issueNumber}`,
            itemType: it.type,
            state: it.state,
            externalId: it.externalId,
            repoId,
          },
        });
      }
      if (it.smartCommitText && it.type === 'commit') {
        const { userId, attributed } = await resolveActor(it.authorEmail);
        if (!userId) {
          // Unverified committer — record that commands were deliberately not run.
          await prisma.devDelivery
            .create({
              data: {
                repoId,
                deliveryId: `smartcommit-skip-${crypto.randomUUID()}`,
                status: 'skipped',
                error: `smart-commit commands ignored: unverified author ${attributed}`.slice(0, 500),
              },
            })
            .catch(() => {});
        } else {
          const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
          const actor: Actor = { user, channel: 'smartcommit' };
          const text = attributed ? `${it.smartCommitText} (via smart commit from ${attributed})` : it.smartCommitText;
          for (const k of [...keyMap.keys()]) {
            await smartCommit(k, actor, text, repoId);
          }
        }
      }
    }
  }
  return { items: items.length, linked: linked.length };
}

export async function panelData(issueKey: string) {
  const where = issueKeyToWhere(issueKey);
  const issue = where ? await prisma.issue.findFirst({ where }) : null;
  if (!issue) throw new JiraApiError(404, jiraError(['Issue not found.']));
  const links = await prisma.developmentItemIssue.findMany({
    where: { issueId: issue.id },
    include: { item: { include: { repo: { select: { name: true, baseUrl: true, provider: true } } } } },
    orderBy: { item: { createdAt: 'desc' } },
  });
  const out = {
    branches: [] as unknown[],
    commits: [] as unknown[],
    pullRequests: [] as unknown[],
    builds: [] as unknown[],
    deployments: [] as unknown[],
    featureFlags: [] as unknown[],
  };
  for (const l of links) {
    const i = l.item;
    const payload = (i.payload ?? {}) as { gitlab?: Record<string, unknown> };
    const row = {
      id: i.id,
      title: i.title,
      url: i.url,
      state: i.state,
      author: i.authorName ?? i.authorEmail,
      repo: i.repo.name,
      provider: i.repo.provider,
      createdAt: i.createdAt,
      ...(payload.gitlab ? { gitlab: payload.gitlab } : {}),
    };
    if (i.type === 'branch') out.branches.push(row);
    else if (i.type === 'commit') out.commits.push(row);
    else if (i.type === 'pull_request') out.pullRequests.push(row);
    else if (i.type === 'build') out.builds.push(row);
    else if (i.type === 'deployment') out.deployments.push(row);
    else if (i.type === 'feature_flag') out.featureFlags.push(row);
  }
  return out;
}

// ---------- webhook receivers + devinfo ingest (moved from routes/dev.ts — 065 US5) ----------

const constantTimeEq = (a: string, b: string) => {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
};

// GitLab sends a shared-token header rather than an HMAC. 051: a connection
// may ALSO set gitlab.signingToken — either secret authenticates (signing
// token preferred when both configured; both are constant-time compared).
export async function ingestGitlabSigned(repoId: string, token: string, raw: string, eventUuid = '') {
  const repo = await prisma.devRepository.findUnique({ where: { id: repoId } });
  const signing = (repo?.gitlab as { signingToken?: string } | null)?.signingToken;
  // 065 F3 — webhookSecret is AES-256-GCM at rest; readSecret handles legacy
  // plaintext rows.
  const whSecret = repo ? readSecret(repo.webhookSecret) : '';
  if (!repo || !(constantTimeEq(token, whSecret) || (signing ? constantTimeEq(token, signing) : false))) {
    await prisma.devDelivery.create({
      data: { repoId, deliveryId: `forged-${crypto.randomUUID()}`, status: 'bad_signature' },
    });
    throw new JiraApiError(401, jiraError(['Bad signature.']));
  }
  const sig = `sha256=${crypto.createHmac('sha256', whSecret).update(raw).digest('hex')}`;
  return ingest(repoId, 'gitlab', raw, sig, eventUuid);
}

const seqKey = 'lastDevinfoSeq';
// devinfo entities carry keys via issueKeys[] or associations[].values
const entityKeys = (e: { issueKeys?: string[]; associations?: { values?: string[] }[] }): string => {
  const direct = e.issueKeys ?? [];
  const assoc = (e.associations ?? []).flatMap((a) => a.values ?? []);
  return [...direct, ...assoc].join(' ');
};

export interface DevinfoRepository {
  id: string;
  name?: string;
  url?: string;
  updateSequenceId?: number;
  branches?: {
    name: string;
    issueKeys?: string[];
    associations?: { values?: string[] }[];
    lastCommit?: {
      id?: string;
      message?: string;
      url?: string;
      author?: { name?: string; email?: string };
      createIssueLink?: string;
    };
  }[];
  commits?: {
    id: string;
    issueKeys?: string[];
    associations?: { values?: string[] }[];
    message?: string;
    url?: string;
    author?: { name?: string; email?: string };
    updateSequenceId?: number;
  }[];
  pullRequests?: {
    id: string;
    issueKeys?: string[];
    associations?: { values?: string[] }[];
    title?: string;
    status?: string;
    url?: string;
    sourceBranch?: string;
    destinationBranch?: string;
    author?: { name?: string };
    updateSequenceId?: number;
  }[];
  builds?: {
    id?: string;
    issueKeys?: string[];
    associations?: { values?: string[] }[];
    pipelineId?: string;
    state?: string;
    url?: string;
    name?: string;
    ref?: string;
    updateSequenceId?: number;
  }[];
  deployments?: {
    id: string;
    issueKeys?: string[];
    associations?: { values?: string[] }[];
    state?: string;
    environment?: { displayName?: string };
    url?: string;
    updateSequenceId?: number;
  }[];
  featureFlags?: {
    id?: string;
    issueKeys?: string[];
    associations?: { values?: string[] }[];
    key?: string;
    state?: string;
    updateSequenceId?: number;
  }[];
}

/** Jira-devinfo-format bulk push: normalize every entity to a DevelopmentItem,
 *  with updateSequenceId staleness guards per repository. */
export async function ingestDevinfoBulk(body: { repositories?: DevinfoRepository[] }) {
  const { extras } = await import('./gitlabService.js');
  const touched: string[] = [];
  for (const r of body.repositories ?? []) {
    const repoId = `devinfo-${r.id}`;
    let repo = await prisma.devRepository.findFirst({ where: { provider: 'gitlab', name: repoId } });
    repo ??= await prisma.devRepository.create({
      data: {
        name: repoId,
        provider: 'gitlab',
        baseUrl: r.url?.replace(/^(https?:\/\/[^/]+).*/, '$1') ?? 'https://gitlab.invalid',
        webhookSecret: encryptSecret(crypto.randomBytes(24).toString('hex')),
        gitlab: {},
      },
    });
    const cur = extras(repo);
    const seq = Number(r.updateSequenceId ?? 0);
    const last = Number((cur as Record<string, unknown>)[seqKey] ?? 0);
    if (seq && seq <= last) {
      touched.push(`${r.id}:stale(seq ${seq}≤${last})`);
      continue;
    }
    const items: NormalizedItem[] = [];
    for (const b of r.branches ?? []) {
      items.push({
        type: 'branch',
        externalId: b.name,
        title: b.name,
        state: 'open',
        keyText: b.name,
        url: b.lastCommit?.createIssueLink ?? r.url,
      });
      if (b.lastCommit?.id) {
        items.push({
          type: 'commit',
          externalId: b.lastCommit.id.slice(0, 12),
          title: String(b.lastCommit.message ?? '').split('\n')[0],
          url: b.lastCommit.url,
          authorName: b.lastCommit.author?.name,
          authorEmail: b.lastCommit.author?.email,
          state: 'committed',
          keyText: `${b.lastCommit.message ?? ''} ${entityKeys(b)}`,
          smartCommitText: b.lastCommit.message,
        });
      }
    }
    for (const c of r.commits ?? []) {
      items.push({
        type: 'commit',
        externalId: c.id.slice(0, 12),
        title: String(c.message ?? '').split('\n')[0],
        url: c.url,
        authorName: c.author?.name,
        authorEmail: c.author?.email,
        state: 'committed',
        keyText: `${c.message ?? ''} ${entityKeys(c)}`,
        smartCommitText: c.message,
      });
    }
    for (const p of r.pullRequests ?? []) {
      items.push({
        type: 'pull_request',
        externalId: String(p.id),
        title: String(p.title ?? ''),
        url: p.url,
        authorName: p.author?.name,
        state: String(p.status ?? 'open').toLowerCase(),
        keyText: `${p.sourceBranch ?? ''} ${p.title ?? ''} ${entityKeys(p)}`,
        gitlab: { mergeRequest: { sourceBranch: p.sourceBranch, targetBranch: p.destinationBranch } },
      });
    }
    for (const b of r.builds ?? []) {
      items.push({
        type: 'build',
        externalId: String(b.pipelineId ?? b.id),
        title: b.name ?? `Pipeline ${b.pipelineId ?? b.id}`,
        url: b.url,
        state: String(b.state ?? 'unknown').toLowerCase(),
        keyText: `${b.ref ?? ''} ${entityKeys(b)}`,
      });
    }
    for (const d of r.deployments ?? []) {
      items.push({
        type: 'deployment',
        externalId: String(d.id),
        title: `Deploy → ${d.environment?.displayName ?? 'env'}`,
        url: d.url,
        state: String(d.state ?? 'success').toLowerCase(),
        keyText: `${d.environment?.displayName ?? ''} ${entityKeys(d)}`,
        gitlab: { deployment: { environment: d.environment?.displayName } },
      });
    }
    for (const f of r.featureFlags ?? []) {
      items.push({
        type: 'feature_flag',
        externalId: String(f.key ?? f.id),
        title: `Flag ${f.key ?? f.id}`,
        state: String(f.state ?? ''),
        keyText: `${f.key ?? ''} ${entityKeys(f)}`,
        gitlab: { featureFlag: { name: f.key, state: f.state } },
      });
    }
    await ingestNormalized(repo.id, items);
    if (seq) {
      const after = extras(repo);
      await prisma.devRepository.update({
        where: { id: repo.id },
        data: { gitlab: { ...(after as Record<string, unknown>), [seqKey]: seq } as object },
      });
    }
    touched.push(`${r.id}:${items.length} items`);
  }
  return { accepted: true as const, repositories: touched };
}

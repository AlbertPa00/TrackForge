// 051 — GitLab-specific depth over 038's provider-agnostic ingest:
// v4 API client (PAT via secretRef), connection test, backfill/poll sync,
// outbound branch/MR actions. Panel items stay DevRepository/DevItem-shaped.
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { resolveSecret } from './directoryService.js';
import { ingestNormalized, type NormalizedItem } from './devService.js';
import { publicBaseUrl } from '../config.js';
import { emitEvent } from './eventService.js';

export interface GitLabExtras {
  apiTokenRef?: string; // env:VAR — never the token itself
  groupPath?: string; // e.g. "platform" or "platform/backend"
  projectIds?: number[]; // explicit map when not group-enumerated
  mode?: 'webhook' | 'poll' | 'both';
  verifySsl?: boolean; // default true
  signingToken?: string; // GitLab ≥16 webhook signing secret (alt to webhookSecret)
  syncCursor?: Record<string, string>; // {projectId: updated_at watermark}
  backfill?: { state: string; done: number; total: number; error?: string };
  lastTestAt?: string;
  lastError?: string;
}

export function extras(repo: { gitlab: unknown }): GitLabExtras {
  return (repo.gitlab as GitLabExtras | null) ?? {};
}

// verifySsl:false → lazily-built rejectUnauthorized dispatcher (same undici
// global-Agent trick as 048's jiraClient — constructor exposed post-prime).
let tlsDispatchPrime: Promise<undefined | object> | null = null;
async function insecureDispatcher(): Promise<object | undefined> {
  tlsDispatchPrime ??= (async () => {
    await fetch('data:,0').catch(() => {});
    const gd = (globalThis as Record<symbol, { constructor?: new (o: object) => object }>)[
      Symbol.for('undici.globalDispatcher.1')
    ];
    return gd?.constructor ? new gd.constructor({ connect: { rejectUnauthorized: false } }) : undefined;
  })();
  return tlsDispatchPrime;
}

async function gitlabFetch(repo: { baseUrl: string; gitlab: unknown }, path: string, init: RequestInit = {}) {
  const x = extras(repo);
  const token = resolveSecret(x.apiTokenRef ?? null);
  const dispatcher =
    x.verifySsl === false && repo.baseUrl.startsWith('https:') ? await insecureDispatcher() : undefined;
  const headers = { ...(init.headers as Record<string, string> | undefined), 'PRIVATE-TOKEN': token };
  const res = await fetch(`${repo.baseUrl.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers,
    ...(dispatcher ? ({ dispatcher } as object) : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new JiraApiError(502, jiraError(['GitLab rejected the token (expired/insufficient scope).']));
  }
  if (res.status === 429) {
    throw new JiraApiError(429, jiraError(['GitLab rate limited — retry later.']));
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new JiraApiError(502, jiraError([`GitLab ${path} → ${res.status}: ${text.slice(0, 200)}`]));
  }
  return res;
}

/** GET /api/v4/user + /metadata — test-connection (US2-1). */
export async function testConnection(repo: { baseUrl: string; gitlab: unknown }) {
  const user = (await (await gitlabFetch(repo, '/api/v4/user')).json()) as { username?: string };
  let version: string | null = null;
  try {
    const meta = (await (await gitlabFetch(repo, '/api/v4/metadata')).json()) as { version?: string };
    version = meta.version ?? null;
  } catch {
    version = 'unavailable (needs admin scope or older GitLab)';
  }
  return { ok: true, username: user.username ?? 'unknown', version };
}

interface GlProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
}
interface GlMr {
  iid: number;
  id: number;
  title: string;
  state: string;
  web_url?: string;
  source_branch?: string;
  target_branch?: string;
  description?: string;
  author?: { name?: string; username?: string };
  updated_at?: string;
  reviewers?: { name?: string }[];
}
interface GlBranch {
  name: string;
  web_url?: string;
}

async function listProjects(repo: { baseUrl: string; gitlab: unknown }): Promise<GlProject[]> {
  const x = extras(repo);
  if (x.projectIds?.length) {
    const out: GlProject[] = [];
    for (const id of x.projectIds) {
      out.push((await (await gitlabFetch(repo, `/api/v4/projects/${id}`)).json()) as GlProject);
    }
    return out;
  }
  if (!x.groupPath) return [];
  return (await (
    await gitlabFetch(
      repo,
      `/api/v4/groups/${encodeURIComponent(x.groupPath)}/projects?include_subgroups=true&per_page=100`
    )
  ).json()) as GlProject[];
}

function mrToItem(proj: GlProject, mr: GlMr): NormalizedItem {
  return {
    type: 'pull_request',
    externalId: String(mr.iid),
    title: mr.title,
    url: mr.web_url ?? `${proj.web_url}/-/merge_requests/${mr.iid}`,
    authorName: mr.author?.name ?? mr.author?.username,
    state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
    keyText: `${mr.source_branch ?? ''} ${mr.title} ${mr.description ?? ''}`,
    gitlab: {
      mergeRequest: {
        reviewers: (mr.reviewers ?? []).map((r) => r.name),
        sourceBranch: mr.source_branch,
        targetBranch: mr.target_branch,
      },
    },
  };
}

/** Backfill: last-400 MRs + branches per mapped project (GitLab-for-Jira parity), 202-tracked in extras.backfill. */
export async function backfill(repoId: string, onLog?: (msg: string) => void) {
  const repo = await prisma.devRepository.findUnique({ where: { id: repoId } });
  if (!repo || repo.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['GitLab connection not found.']));
  const projects = await listProjects(repo);
  const x = extras(repo);
  await prisma.devRepository.update({
    where: { id: repoId },
    data: { gitlab: { ...x, backfill: { state: 'running', done: 0, total: projects.length } } },
  });
  let done = 0;
  try {
    for (const proj of projects) {
      const mrs = (await (
        await gitlabFetch(repo, `/api/v4/projects/${proj.id}/merge_requests?state=all&per_page=100&order_by=updated_at`)
      ).json()) as GlMr[];
      const items: NormalizedItem[] = mrs.slice(0, 400).map((m) => mrToItem(proj, m));
      const branches = (await (
        await gitlabFetch(repo, `/api/v4/projects/${proj.id}/repository/branches?per_page=100`)
      ).json()) as GlBranch[];
      for (const b of branches.slice(0, 400)) {
        items.push({
          type: 'branch',
          externalId: b.name,
          title: b.name,
          state: 'open',
          url: `${proj.web_url}/-/tree/${encodeURIComponent(b.name)}`,
          keyText: b.name,
        });
      }
      const stats = await ingestNormalized(repoId, items);
      onLog?.(`${proj.path_with_namespace}: ${stats.items} items, ${stats.linked} linked`);
      done += 1;
      const cur = (await prisma.devRepository.findUnique({ where: { id: repoId }, select: { gitlab: true } }))!
        .gitlab as GitLabExtras;
      await prisma.devRepository.update({
        where: { id: repoId },
        data: {
          gitlab: {
            ...cur,
            backfill: { state: 'running', done, total: projects.length },
            syncCursor: {
              ...(cur.syncCursor ?? {}),
              [String(proj.id)]: mrs[0]?.updated_at ?? new Date().toISOString(),
            },
          },
        },
      });
    }
    const cur = (await prisma.devRepository.findUnique({ where: { id: repoId }, select: { gitlab: true } }))!
      .gitlab as GitLabExtras;
    await prisma.devRepository.update({
      where: { id: repoId },
      data: { gitlab: { ...cur, backfill: { state: 'done', done, total: projects.length }, lastError: undefined } },
    });
    await emitEvent(prisma, null, {
      type: 'gitlab_backfill_done',
      projectId: undefined as never,
      payload: { repoId, projects: done },
    });
    return { projects: done };
  } catch (e) {
    const cur = (await prisma.devRepository.findUnique({ where: { id: repoId }, select: { gitlab: true } }))!
      .gitlab as GitLabExtras;
    await prisma.devRepository.update({
      where: { id: repoId },
      data: {
        gitlab: {
          ...cur,
          backfill: { state: 'error', done, total: projects.length, error: (e as Error).message },
          lastError: (e as Error).message,
        },
      },
    });
    throw e;
  }
}

/** Poll sync (webhook-unreachable instances): MRs updated since each project's cursor watermark. */
export async function pollSync(repoId: string) {
  const repo = await prisma.devRepository.findUnique({ where: { id: repoId } });
  if (!repo || repo.provider !== 'gitlab' || !repo.enabled) return { synced: 0 };
  const x = extras(repo);
  if (x.mode === 'webhook') return { synced: 0 };
  const projects = await listProjects(repo);
  let synced = 0;
  for (const proj of projects) {
    const cursor = x.syncCursor?.[String(proj.id)];
    const q = cursor ? `&updated_after=${encodeURIComponent(cursor)}` : '&per_page=50';
    const mrs = (await (
      await gitlabFetch(repo, `/api/v4/projects/${proj.id}/merge_requests?state=all&order_by=updated_at${q}`)
    ).json()) as GlMr[];
    if (!mrs.length) continue;
    await ingestNormalized(
      repoId,
      mrs.map((m) => mrToItem(proj, m))
    );
    synced += mrs.length;
    const newest = mrs[0]?.updated_at;
    if (newest) {
      const cur = (await prisma.devRepository.findUnique({ where: { id: repoId }, select: { gitlab: true } }))!
        .gitlab as GitLabExtras;
      await prisma.devRepository.update({
        where: { id: repoId },
        data: { gitlab: { ...cur, syncCursor: { ...(cur.syncCursor ?? {}), [String(proj.id)]: newest } } },
      });
    }
  }
  return { synced };
}

/** Outbound actions (US4) — same path the panel and MCP share (A1).
 * `issueKey` force-links the panel item even when the branch name carries
 * no parseable key. */
export async function createBranch(repoId: string, opts: { name: string; ref: string; issueKey?: string }) {
  const repo = await prisma.devRepository.findUnique({ where: { id: repoId } });
  if (!repo || repo.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['GitLab connection not found.']));
  const projects = await listProjects(repo);
  const proj = projects[0];
  if (!proj) throw new JiraApiError(400, jiraError(['Connection maps no GitLab project.']));
  const res = await gitlabFetch(
    repo,
    `/api/v4/projects/${proj.id}/repository/branches?branch=${encodeURIComponent(opts.name)}&ref=${encodeURIComponent(opts.ref)}`,
    { method: 'POST' }
  );
  const body = (await res.json()) as { name?: string; web_url?: string };
  const item = await ingestNormalized(repoId, [
    {
      type: 'branch',
      externalId: body.name ?? opts.name,
      title: body.name ?? opts.name,
      url: body.web_url ?? `${proj.web_url}/-/tree/${encodeURIComponent(opts.name)}`,
      state: 'open',
      keyText: `${opts.name} ${opts.issueKey ?? ''}`,
    },
  ]);
  return { name: body.name ?? opts.name, url: body.web_url, items: item.items, project: proj.path_with_namespace };
}

export async function createMergeRequest(
  repoId: string,
  opts: { sourceBranch: string; targetBranch: string; title: string; description?: string; issueKey?: string }
) {
  const repo = await prisma.devRepository.findUnique({ where: { id: repoId } });
  if (!repo || repo.provider !== 'gitlab') throw new JiraApiError(404, jiraError(['GitLab connection not found.']));
  const projects = await listProjects(repo);
  const proj = projects[0];
  if (!proj) throw new JiraApiError(400, jiraError(['Connection maps no GitLab project.']));
  const res = await gitlabFetch(repo, `/api/v4/projects/${proj.id}/merge_requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_branch: opts.sourceBranch,
      target_branch: opts.targetBranch,
      title: opts.title,
      description: opts.description,
    }),
  });
  const body = (await res.json()) as GlMr;
  const item = mrToItem(proj, body);
  item.keyText += ` ${opts.issueKey ?? ''}`;
  await ingestNormalized(repoId, [item]);
  return { iid: body.iid, url: body.web_url ?? `${proj.web_url}/-/merge_requests/${body.iid}`, state: body.state };
}

export function branchNameFor(issueKey: string, summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${issueKey}-${slug}`; // key stays uppercase — KEY_RE must match for panel linking
}

export function trackforgeBase(): string {
  return publicBaseUrl();
}

import { createJiraSource, JiraApiError } from './jiraClient.js';
import { jiraError, JiraApiError as HttpApiError } from '../lib/errors.js';
import { assertPublicUrl } from '../lib/egress.js';
import type { JiraSource } from './types.js';

/**
 * Sprint 048 — Jira Server / Data Center source.
 *
 * Wraps the generic JiraSource transport with the Server divergences from the
 * 048 divergence table, keeping every difference at this one boundary:
 *
 *  - `/rest/api/3/*` → `/rest/api/2/*` rewrite (agile untouched).
 *  - Override table for Cloud-only paths (users/search, workflow/search,
 *    filter/search, field contexts, fieldconfigurations).
 *  - User-bean normalization: Server has no accountId — inject
 *    `accountId = key ?? name` so every importer mapper works unchanged.
 *  - Identity keys on Jira `key` (stable across username renames).
 *  - Three-strategy user union (user/search + groups[] members + issue refs)
 *    so the 1000-user enumeration cap cannot silently truncate.
 *
 * Credentials/confinement/SSRF live in the transport (`createJiraSource`).
 */

export interface JiraServerOpts {
  baseUrl: string;
  /** 'basic': username + password|token. 'pat': Bearer token (Jira >= 8.14). */
  authMode: 'basic' | 'pat';
  /** required iff authMode === 'basic' (Server logs in by username). */
  username?: string;
  token?: string;
  /** job project keys — drives issue-ref user lookups + createmeta scope. */
  projectKeys?: string[];
  /** group names whose members join the user-discovery union (FR-006). */
  groups?: string[];
  /** admin overrides: canonical alias → customfield id (FR-007). */
  fieldAliases?: Record<string, string>;
  /** SSRF opt-in: allow loopback/link-local/private targets. */
  allowPrivate?: boolean;
  /** opt-in TLS skip for self-signed intranet instances — recorded on the job. */
  insecureSkipVerify?: boolean;
  /** transport override — tests pass a fixture source. */
  inner?: JiraSource;
  onWarn?: (msg: string) => void;
  fetchImpl?: typeof fetch;
  concurrency?: number;
}

/** Aliases the importer resolves by name via /rest/api/2/field at preflight. */
export const SERVER_FIELD_ALIASES: Record<string, string[]> = {
  storyPoints: ['Story Points', 'Story point estimate'],
  flagged: ['Flagged'],
  epicLink: ['Epic Link'],
  epicName: ['Epic Name'],
  sprint: ['Sprint'],
  rank: ['Rank'],
  jpoParent: ['Parent Link'],
};

/** Locale-independent fallback — the Jira Agile plugin's `schema.custom`
 *  types never change with the UI language, so 'Enlace de épica' still
 *  resolves via `gh-epic-link` where the English name list misses. */
export const SERVER_FIELD_SCHEMAS: Record<string, string[]> = {
  epicLink: ['gh-epic-link'],
  epicName: ['gh-epic-label'],
  sprint: ['gh-sprint'],
  // Greenhopper plugin CFs as first-class columns — the schema.custom suffix
  // is locale-independent, so 'Puntos de historia' resolves like 'Story Points'.
  storyPoints: ['story-points'], // jsw-story-points | gh-story-points
  flagged: ['gh-flagged'],
  rank: ['gh-lexo-rank'], // verbatim into Issue.rank — lib/lexorank decodes '0|…' format
  jpoParent: ['jpo-parent'], // Portfolio parent (initiative above epic) → parentId
};

/** US4-2 SSRF guard — http(s) only; private/loopback targets are opt-in.
 *  065 US1: the private/DNS checks delegate to lib/egress's assertPublicUrl —
 *  the local regex missed alternate IP encodings and hostnames that resolve to
 *  private addresses (DNS rebinding). Throws the route-mapped lib/errors
 *  JiraApiError (called from startImport + source construction). */
export async function assertServerBaseUrl(baseUrl: string, opts: { allowPrivate?: boolean } = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HttpApiError(400, jiraError(['baseUrl is not a valid URL']));
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new HttpApiError(400, jiraError([`scheme '${url.protocol.slice(0, -1)}' not allowed — http(s) only`]));
  }
  try {
    await assertPublicUrl(baseUrl, { allowPrivate: opts.allowPrivate });
  } catch (e) {
    throw new HttpApiError(
      400,
      jiraError([`${e instanceof Error ? e.message : String(e)} — pass allowPrivate:true to opt in (SSRF guard)`])
    );
  }
  return url;
}

/**
 * Deep-walk a Jira JSON payload injecting `accountId` into Server user beans.
 * A bean counts as a user when it has `displayName` (never present on project/
 * issuetype beans) and a `key` or `name` — `key` is stable across renames.
 */
export function normalizeServerUsers(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const item of node) normalizeServerUsers(item);
    return node;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (
      o.accountId == null &&
      typeof o.displayName === 'string' &&
      (typeof o.key === 'string' || typeof o.name === 'string')
    ) {
      o.accountId = (o.key ?? o.name) as string;
    }
    for (const v of Object.values(o)) normalizeServerUsers(v);
    return node;
  }
  return node;
}

/** '/rest/api/3/x?y' → '/rest/api/2/x?y'; anything else unchanged. */
export function serverPath(path: string): string {
  return path.replace(/\/rest\/api\/3\//, '/rest/api/2/');
}

/** Server workflow detail → the Cloud-ish {statuses,transitions} our mapper reads. */
function reshapeWorkflow(raw: any): any {
  if (!raw || !Array.isArray(raw.steps)) return raw;
  const steps = raw.steps as any[];
  const statuses = steps.map((s) => ({
    id: String(s.id ?? s.name),
    name: s.linkedStatusName ?? s.name ?? String(s.id),
  }));
  const transitions = steps.flatMap((s) =>
    (s.transitions ?? []).map((t: any) => ({
      name: t.name ?? 'Transition',
      to: { name: t.toStatusName ?? t.to?.name ?? null },
      from: [{ name: s.linkedStatusName ?? s.name ?? String(s.id) }],
    }))
  );
  return { name: raw.name, statuses, transitions, _serverSteps: true };
}

export async function createJiraServerSource(opts: JiraServerOpts): Promise<JiraSource> {
  const warn = (msg: string) => opts.onWarn?.(msg);
  if (opts.insecureSkipVerify) {
    warn('insecureSkipVerify enabled — TLS certificates will not be verified (recorded on the job)');
  }
  if (!opts.inner) {
    const u = await assertServerBaseUrl(opts.baseUrl, { allowPrivate: opts.allowPrivate });
    if (u.protocol === 'http:') warn('baseUrl is plain http — credentials travel unencrypted');
  }
  const inner =
    opts.inner ??
    createJiraSource({
      baseUrl: opts.baseUrl,
      authMode: opts.authMode,
      email: opts.username ?? '',
      apiToken: opts.token ?? '',
      fetchImpl: opts.fetchImpl,
      concurrency: opts.concurrency ?? 4,
      insecureSkipVerify: opts.insecureSkipVerify,
      onWarn: opts.onWarn,
    });
  const projectKeys = opts.projectKeys ?? [];
  const groups = opts.groups ?? [];

  // Lazily-cached createmeta (field {id} → allowedValues) for the context override.
  let createmetaCache: Promise<Map<string, Map<string, unknown>>> | null = null;
  function allowedValuesFor(fieldId: string): Promise<Map<string, unknown>> {
    createmetaCache ??= (async () => {
      const byField = new Map<string, Map<string, unknown>>();
      try {
        const meta = await inner.get<any>('/rest/api/2/issue/createmeta', {
          expand: 'projects.issuetypes.fields',
          ...(projectKeys.length ? { projectKeys: projectKeys.join(',') } : {}),
        });
        for (const p of meta?.projects ?? []) {
          for (const t of p.issuetypes ?? []) {
            for (const [fid, fdef] of Object.entries((t.fields ?? {}) as Record<string, any>)) {
              let byValue = byField.get(fid);
              if (!byValue) byField.set(fid, (byValue = new Map()));
              for (const av of fdef?.allowedValues ?? []) {
                const key = String(av.value ?? av.id ?? av.name ?? '');
                if (key && !byValue.has(key)) {
                  byValue.set(key, { id: String(av.id ?? key), value: key, disabled: av.disabled === true });
                }
              }
            }
          }
        }
      } catch {
        warn('createmeta unavailable — custom-field option discovery limited to observed values');
      }
      return byField;
    })();
    return createmetaCache.then((m) => m.get(fieldId) ?? new Map());
  }

  /** FR-006 union: user/search + configured groups + refs seen on issues. */
  async function* userUnion(params?: Record<string, unknown>): AsyncIterable<any> {
    const seen = new Set<string>();
    const push = function* (u: any): Generator<any> {
      normalizeServerUsers(u); // union rows bypass the paged() normalizer
      const k = String(u?.key ?? u?.name ?? u?.accountId ?? '');
      if (k && !seen.has(k)) {
        seen.add(k);
        yield u;
      }
    };
    let searchHitCap = false;
    try {
      const rows = await inner.get<any>('/rest/api/2/user/search', {
        username: params?.query === '' || params?.query == null ? '.' : params.query,
        includeInactive: true,
        maxResults: params?.maxResults ?? 1000,
      });
      const list = Array.isArray(rows) ? rows : [];
      if (list.length >= 1000) searchHitCap = true;
      for (const u of list) yield* push(u);
    } catch (e) {
      warn(`user/search failed (${(e as Error).message.slice(0, 80)}) — falling back to groups + issue refs`);
    }
    if (searchHitCap) {
      warn('user/search hit the 1000-result cap — unioning groups[] members + issue refs (FR-006)');
    }
    // groupMemberImporter enumerates groups/picker unconditionally, so the
    // union must cover the same surface or member users won't resolve. Configured
    // groups[] extends the picker list (covers groups outside picker results).
    const unionGroups = new Set(groups);
    try {
      const picker = await inner.get<any>('/rest/api/2/groups/picker', { query: '' });
      for (const g of picker?.groups ?? []) {
        const n = g?.name ?? g?.groupId;
        if (n) unionGroups.add(String(n));
      }
    } catch {
      /* picker best-effort — configured groups still enumerate */
    }
    for (const g of unionGroups) {
      try {
        for await (const u of inner.paged<any>('/rest/api/2/group/member', 'values', {
          groupname: g,
          includeInactiveUsers: true,
        })) {
          yield* push(u);
        }
      } catch {
        warn(`group '${g}' not enumerable (admin permission? system group?) — skipped`);
      }
    }
    if (projectKeys.length) {
      try {
        for await (const issue of inner.paged<any>('/rest/api/2/search', 'issues', {
          jql: `project in (${projectKeys.join(',')})`,
          fields: 'assignee,reporter,creator',
        })) {
          const f = issue?.fields ?? {};
          for (const ref of [f.assignee, f.reporter, f.creator]) {
            if (ref) yield* push(ref);
          }
        }
      } catch {
        /* issue-ref lookups best-effort — enumeration already covered above */
      }
    }
  }

  /** Cloud-only filter enumeration → favourites + explicit warning. */
  async function* filterOverride(): AsyncIterable<any> {
    warn(
      'Server/DC has no filter enumeration endpoint — importing service-account favourites ' +
        'only; favourite additional filters as the import user to include them'
    );
    try {
      const rows = await inner.get<any>('/rest/api/2/filter/favourite');
      for (const f of Array.isArray(rows) ? rows : []) yield f;
    } catch (e) {
      warn(`filter/favourite failed: ${(e as Error).message.slice(0, 80)}`);
    }
  }

  /** Cloud /workflow/search → Server's all-workflows list (admin-gated). */
  async function* workflowOverride(): AsyncIterable<any> {
    try {
      const all = await inner.get<any>('/rest/api/2/workflow');
      const list = Array.isArray(all) ? all : (all?.workflows ?? all?.values ?? []);
      for (const w of list) yield { id: { name: w.name ?? w.id?.name }, name: w.name ?? w.id?.name };
    } catch (e) {
      const status = e instanceof JiraApiError ? e.status : 0;
      warn(
        `workflow enumeration failed (${status}) — degrading to statuses-only import; ` +
          'grant the service account admin permission for full workflow fidelity'
      );
    }
    // Server exposes no per-workflow step detail via REST (`steps` is only a
    // count) — reconstruct each job project's effective workflow from
    // /project/{key}/statuses so the import still lands a status-complete
    // workflow for the migrated project.
    for (const key of projectKeys) {
      try {
        const its = await inner.get<any[]>(`/rest/api/2/project/${key}/statuses`);
        const seen = new Map<string, { id: string; name: string }>();
        for (const t of its ?? []) {
          for (const s of (t as { statuses?: { id?: unknown; name?: string }[] }).statuses ?? []) {
            const id = String(s.id);
            if (id && !seen.has(id)) seen.set(id, { id, name: s.name ?? id });
          }
        }
        const statuses = [...seen.values()];
        // Server REST exposes no transition topology (`steps` is a count and
        // /workflow enumeration is admin-gated) — synthesize the Jira
        // Simplified-Workflow shape instead: one global transition per status,
        // named after its target. _synthesized lets apply attach resolution
        // post-functions by target category; _projectKey lets apply attach the
        // reconstructed workflow to its project so it doesn't fall back to the
        // seeded 'Simple' workflow.
        yield {
          id: { name: `${key} workflow (reconstructed)` },
          name: `${key} workflow (reconstructed)`,
          statuses,
          transitions: statuses.map((s) => ({
            name: s.name,
            type: 'global',
            to: { name: s.name },
            _synthesized: true,
          })),
          _projectKey: key,
        };
      } catch {
        warn(`project ${key} statuses unavailable — no reconstructed workflow`);
      }
    }
  }

  const get = async <T>(path: string, params?: Record<string, unknown>): Promise<T> => {
    // Cloud-only paths with no Server equivalent — declared unsupported, never a silent 404.
    if (path.startsWith('/rest/api/3/fieldconfigurations')) {
      warn('field configurations have no Server REST API — skipped (re-create manually post-import)');
      throw new JiraApiError(404, path, 'fieldconfigurations: cloud-only (declared unsupported on Server)');
    }
    // CF option contexts don't exist on Server — one synthetic 'global' context.
    const ctxMatch = path.match(/^\/rest\/api\/3\/field\/(customfield_\d+)\/context$/);
    if (ctxMatch) {
      warn(`custom field ${ctxMatch[1]}: per-project contexts collapse to a global context on Server`);
      return { values: [{ id: '__server_global' }] } as T;
    }
    const detail = await inner.get<any>(
      serverPath(path),
      // Server's user/search takes `username`, not Cloud's `query`.
      path === '/rest/api/3/users/search'
        ? { ...params, username: (params?.query as string) || '.', query: undefined, includeInactive: true }
        : params
    );
    if (path === '/rest/api/3/workflow' || (path.startsWith('/rest/api/3/workflow') && detail?.steps)) {
      return normalizeServerUsers(reshapeWorkflow(detail)) as T;
    }
    return normalizeServerUsers(detail) as T;
  };

  return {
    get,

    async getBinary(path: string) {
      if (!inner.getBinary) throw new JiraApiError(501, path, 'source cannot fetch binaries');
      return inner.getBinary(path);
    },

    async *paged<T>(path: string, itemsKey?: string, params?: Record<string, unknown>): AsyncIterable<T> {
      if (path === '/rest/api/3/users/search') {
        yield* userUnion(params) as AsyncIterable<T>;
        return;
      }
      if (path === '/rest/api/3/workflow/search') {
        yield* workflowOverride() as AsyncIterable<T>;
        return;
      }
      if (path === '/rest/api/3/filter/search') {
        yield* filterOverride() as AsyncIterable<T>;
        return;
      }
      if (path.startsWith('/rest/api/3/fieldconfigurations')) {
        warn('field configurations have no Server REST API — skipped (re-create manually post-import)');
        return; // declared unsupported — empty discovery, warning recorded
      }
      const optMatch = path.match(/^\/rest\/api\/3\/field\/(customfield_\d+)\/context\/[^/]+\/option$/);
      if (optMatch) {
        const values = await allowedValuesFor(optMatch[1]);
        if (!values.size) warn(`custom field ${optMatch[1]}: no allowedValues in createmeta`);
        for (const v of values.values()) yield v as T;
        return;
      }
      const rewritten = path === '/rest/api/3/users/search' ? path : serverPath(path);
      for await (const item of inner.paged<T>(rewritten, itemsKey, params)) {
        yield normalizeServerUsers(item) as T;
      }
    },
  };
}

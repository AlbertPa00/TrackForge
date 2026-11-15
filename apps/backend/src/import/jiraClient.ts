import type { JiraSource } from './types.js';
import { assertPublicUrl, egressFetch, isPrivateAddress, normalizeIp } from '../lib/egress.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface JiraClientOpts {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** 048: 'basic' (email:user + apiToken|password) or 'pat' (Bearer, Jira >= 8.14). */
  authMode?: 'basic' | 'pat';
  /** 048: diagnostics channel — off-origin fetches, insecure schemes. */
  onWarn?: (msg: string) => void;
  /** 048: opt-in TLS skip for self-signed intranet instances (recorded on the job). */
  insecureSkipVerify?: boolean;
  /** max in-flight requests — Jira Cloud tolerates ~10; keep conservative. */
  concurrency?: number;
  maxRetries?: number;
  pageSize?: number;
  fetchImpl?: typeof fetch;
}

export class JiraApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    body: string
  ) {
    super(`Jira API ${status} ${path}: ${body.slice(0, 300)}`);
  }
}

class Semaphore {
  private avail: number;
  private queue: (() => void)[] = [];
  constructor(n: number) {
    this.avail = n;
  }
  async acquire(): Promise<void> {
    if (this.avail > 0) {
      this.avail--;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.avail--;
  }
  release(): void {
    this.avail++;
    const next = this.queue.shift();
    if (next) {
      this.avail--;
      next();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rate-limit-aware Jira Cloud REST client: API-token basic auth, bounded
 * concurrency, Retry-After on 429, exponential backoff on 5xx.
 * v2/v3 compatible — the importer picks the API root per endpoint.
 */
export function createJiraSource(opts: JiraClientOpts): JiraSource {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const baseOrigin = new URL(base).origin;
  // 048: PAT (Jira >= 8.14) sends Bearer — never Basic, never the username.
  const auth =
    opts.authMode === 'pat'
      ? `Bearer ${opts.apiToken}`
      : `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`).toString('base64')}`;
  const sem = new Semaphore(opts.concurrency ?? 4);
  const maxRetries = opts.maxRetries ?? 5;
  const pageSize = opts.pageSize ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 064 US5: the configured baseUrl is the trust anchor — self-hosted imports
  // legitimately live on private networks. Server-supplied off-origin URLs
  // (content:, nextPage, CSV attachment cells) are attacker-influenced and are
  // already credential-stripped; additionally a PUBLIC base must never be
  // talked into fetching private/LAN targets. Resolved lazily like TLS.
  let basePrivateOnce: Promise<boolean> | null = null;
  const baseIsPrivate = () => {
    basePrivateOnce ??= (async () => {
      const host = normalizeIp(new URL(base).hostname);
      if (isIP(host)) return isPrivateAddress(host);
      try {
        return (await dnsLookup(host, { all: true })).some((a) => isPrivateAddress(a.address));
      } catch {
        return false; // unresolvable base fails at fetch anyway — keep off-origin strict
      }
    })();
    return basePrivateOnce;
  };
  const egressCheck = async (u: string) => {
    try {
      await assertPublicUrl(u, { allowPrivate: await baseIsPrivate() });
    } catch (e) {
      throw new JiraApiError(400, u, `egress blocked: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // 048: undici exposes its global Agent constructor only after the first
  // fetch — prime lazily, then build a rejectUnauthorized:false dispatcher.
  let skipTlsOnce: Promise<unknown> | null = null;
  const tlsDispatcher = () => {
    skipTlsOnce ??= (async () => {
      if (!opts.insecureSkipVerify || opts.fetchImpl) return undefined;
      await fetch('data:,0').catch(() => {});
      const gd = (globalThis as Record<symbol, { constructor?: new (o: object) => unknown }>)[
        Symbol.for('undici.globalDispatcher.1')
      ];
      if (!gd?.constructor) {
        opts.onWarn?.('insecureSkipVerify unavailable on this runtime — TLS enforced');
        return undefined;
      }
      return new gd.constructor({ connect: { rejectUnauthorized: false } });
    })();
    return skipTlsOnce;
  };

  async function raw(path: string, params?: Record<string, unknown>): Promise<Response> {
    const url = new URL(path.startsWith('http') ? path : `${base}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    // 048 FR-002: credential confinement — Authorization is attached only when
    // the request origin equals the configured baseUrl origin. Server/DC
    // responses can carry off-origin absolute URLs (content, self, nextPage);
    // those fetch bare + warn rather than leak the import credential.
    const sameOrigin = url.origin === baseOrigin;
    if (!sameOrigin) {
      opts.onWarn?.(`off-origin fetch to ${url.host} — credential withheld`);
      // fetchImpl is the test seam — an injected impl makes real DNS
      // validation pointless (mirrors tlsDispatcher's fetchImpl skip).
      if (!opts.fetchImpl) await egressCheck(url.toString());
    }
    await sem.acquire();
    try {
      let attempt = 0;
      const dispatcher = await tlsDispatcher();
      for (;;) {
        const res = await fetchImpl(url, {
          headers: { ...(sameOrigin ? { Authorization: auth } : {}), Accept: 'application/json' },
          ...(dispatcher ? ({ dispatcher } as object) : {}),
        });
        if (res.status === 429) {
          if (attempt++ >= maxRetries) throw new JiraApiError(429, path, 'rate-limit retries exhausted');
          const ra = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * attempt);
          continue;
        }
        if (res.status >= 500 && attempt < maxRetries) {
          attempt++;
          await sleep(Math.min(1000 * 2 ** attempt, 15000));
          continue;
        }
        return res;
      }
    } finally {
      sem.release();
    }
  }

  return {
    async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
      const res = await raw(path, params);
      if (!res.ok) throw new JiraApiError(res.status, path, await res.text());
      return (await res.json()) as T;
    },

    async getBinary(path: string): Promise<Buffer> {
      const res = await raw(path);
      if (!res.ok) throw new JiraApiError(res.status, path, await res.text());
      return Buffer.from(await res.arrayBuffer());
    },

    async *paged<T>(path: string, itemsKey?: string, params?: Record<string, unknown>): AsyncIterable<T> {
      // Unpaginated endpoint — the response body is the array itself.
      if (!itemsKey) {
        const res = await raw(path, params);
        if (!res.ok) throw new JiraApiError(res.status, path, await res.text());
        const body = await res.json();
        for (const item of Array.isArray(body) ? body : []) yield item as T;
        return;
      }
      // Classic startAt/maxResults/total pagination (search, comments...).
      // Also handles agile-style {isLast, nextPage} payloads.
      let startAt = 0;
      let nextPath: string | null = path;
      while (nextPath) {
        const res = await raw(nextPath, nextPath === path ? { ...params, startAt, maxResults: pageSize } : undefined);
        if (!res.ok) throw new JiraApiError(res.status, nextPath, await res.text());
        const body = (await res.json()) as Record<string, unknown>;
        const items = (body[itemsKey] as T[] | undefined) ?? [];
        for (const item of items) yield item;
        const isLast = body.isLast as boolean | undefined;
        const nextPage = body.nextPage as string | undefined;
        if (isLast === false && nextPage) {
          // agile API returns an absolute URL — keep only path+query
          const u = new URL(nextPage);
          nextPath = u.pathname + u.search;
          continue;
        }
        const total = (body.total as number | undefined) ?? startAt + items.length;
        startAt += items.length;
        if (!items.length || startAt >= total) break;
      }
    },
  };
}

/**
 * Fixture source for tests + local dry-runs: a plain object mapping
 * path → response body. `paged` slices arrays into pages so pagination
 * logic is exercised identically to the real client.
 */
export function createFixtureSource(
  fixture: Record<string, unknown>,
  opts: { pageSize?: number; onRequest?: (path: string) => void; allowPrivate?: boolean } = {}
): JiraSource {
  const pageSize = opts.pageSize ?? 100;
  const lookup = (path: string) => {
    const clean = path.split('?')[0];
    const hit = fixture[clean];
    if (hit === undefined) throw new JiraApiError(404, path, `fixture has no entry for ${clean}`);
    return hit;
  };
  return {
    async get<T>(path: string): Promise<T> {
      opts.onRequest?.(path);
      return lookup(path) as T;
    },
    async *paged<T>(path: string, itemsKey?: string): AsyncIterable<T> {
      opts.onRequest?.(path);
      const body = lookup(path);
      const items = itemsKey ? (((body as Record<string, unknown>)[itemsKey] as T[] | undefined) ?? []) : (body as T[]);
      // Slice into pages to exercise the paging loop
      for (let i = 0; i < items.length; i += pageSize) {
        for (const item of items.slice(i, i + pageSize)) yield item;
      }
    },
    // Fixture binary: `{ $binary: '<base64>' }` or `'base64:<data>'` entries.
    // 039: absolute http(s) attachment URLs (Jira CSV `Attachment` cells) are
    // fetched live — imports are admin-gated and the plan stage already caps
    // size; we enforce a fetch timeout + hard byte cap regardless.
    async getBinary(path: string): Promise<Buffer> {
      opts.onRequest?.(path);
      try {
        const body = lookup(path) as unknown;
        if (typeof body === 'string' && body.startsWith('base64:')) return Buffer.from(body.slice(7), 'base64');
        if (body && typeof body === 'object' && typeof (body as { $binary?: unknown }).$binary === 'string') {
          return Buffer.from((body as { $binary: string }).$binary, 'base64');
        }
      } catch (e) {
        if (!(e instanceof JiraApiError && e.status === 404)) throw e;
      }
      if (/^https?:\/\//i.test(path)) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15_000);
        try {
          // 064 US5: egressFetch re-validates each redirect hop at delivery.
          const res = await egressFetch(path, { signal: ctrl.signal }, { allowPrivate: opts.allowPrivate === true });
          if (!res.ok) throw new JiraApiError(res.status, path, `attachment fetch failed: ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          const cap = 25 * 1024 * 1024;
          if (buf.length > cap) throw new JiraApiError(413, path, 'attachment exceeds 25MB fetch cap');
          return buf;
        } catch (e) {
          if (e instanceof JiraApiError) throw e;
          throw new JiraApiError(400, path, `attachment fetch blocked: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(t);
        }
      }
      throw new JiraApiError(404, path, `fixture entry for ${path} is not binary`);
    },
  };
}

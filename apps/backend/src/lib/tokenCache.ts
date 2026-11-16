// 070 — PAT lookup cache + debounced `lastUsedAt`.
//
// Fleet math that motivates this: 1,000 agents at ~2 req/s each used to cost
// one `ApiToken findUnique(+user)` AND one unconditional `lastUsedAt` write
// per request — 4,000 ops/s on a single table, most of it MVCC dead-tuple
// churn. The cache serves hits in-process and collapses the audit touch to
// at most one write per TOKEN_TOUCH_INTERVAL_MS per token.
//
// Consistency contract: entries live TOKEN_CACHE_TTL_MS at most, and every
// in-app revoke path calls invalidateApiTokens* so admin revocation is
// immediate (direct SQL revocation degrades to the TTL). Expiry is
// re-checked on every hit — a token never lives past its expiresAt.

import type { ApiToken, User } from '../lib/pc.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'token-cache' });

const TTL_MS = Math.max(0, Number(process.env.TOKEN_CACHE_TTL_MS ?? 30_000));
/** Min spacing between `lastUsedAt` writes for the same token. */
const TOUCH_MS = Math.max(0, Number(process.env.TOKEN_TOUCH_INTERVAL_MS ?? 300_000));
/** Hard cap — PATs per deployment are small; 10k is generous headroom. */
const MAX_ENTRIES = Math.max(1, Number(process.env.TOKEN_CACHE_MAX ?? 10_000));

export type ApiTokenWithUser = ApiToken & { user: User };

interface Entry {
  value: ApiTokenWithUser;
  expiresAt: number;
  /** Last time we flushed a `lastUsedAt` write for this token. */
  lastTouch: number;
}

const cache = new Map<string, Entry>();

/** Fresh cached row, or undefined. `expiresAt` is re-validated here so a
 *  cached row is never served past its hard expiry even inside the TTL. */
export function lookupApiToken(tokenHash: string): { token: ApiTokenWithUser; touchDue: boolean } | undefined {
  const e = cache.get(tokenHash);
  if (!e) return undefined;
  const now = Date.now();
  if (e.expiresAt <= now) {
    cache.delete(tokenHash);
    return undefined;
  }
  return { token: e.value, touchDue: now - e.lastTouch >= TOUCH_MS };
}

export function storeApiToken(tokenHash: string, value: ApiTokenWithUser): void {
  if (TTL_MS <= 0) return;
  const now = Date.now();
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
    // Still full → drop the insertion-order oldest entry (Map iterates FIFO).
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  cache.set(tokenHash, { value, expiresAt: now + TTL_MS, lastTouch: now });
}

/** Mark that a `lastUsedAt` write was just flushed for this hash. */
export function markTokenTouched(tokenHash: string): void {
  const e = cache.get(tokenHash);
  if (e) e.lastTouch = Date.now();
}

/** Drop every cached entry for one token id (revoke / rotate). */
export function invalidateApiTokens(opts: { tokenId?: string; userId?: string }): void {
  let n = 0;
  for (const [k, e] of cache) {
    if ((opts.tokenId && e.value.id === opts.tokenId) || (opts.userId && e.value.userId === opts.userId)) {
      cache.delete(k);
      n++;
    }
  }
  if (n) log.debug({ ...opts, evicted: n }, 'api-token cache entries evicted');
}

/** Test hook — empty the cache between suites. */
export function clearApiTokenCache(): void {
  cache.clear();
}

// 070 — PAT cache lifecycle: store/hit, explicit invalidation on revoke
// paths, TTL expiry, and the touch-debounce flag.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApiToken, User } from '../../../src/lib/pc.js';
import {
  lookupApiToken,
  storeApiToken,
  markTokenTouched,
  invalidateApiTokens,
  clearApiTokenCache,
  type ApiTokenWithUser,
} from '../../src/lib/tokenCache.js';

const token = (id: string, userId = 'u-1'): ApiTokenWithUser =>
  ({ id, userId, hash: `h-${id}` }) as ApiToken & { user: User };

beforeEach(() => clearApiTokenCache());
afterEach(() => vi.useRealTimers());

describe('api-token cache', () => {
  it('misses then hits; revoke-by-id evicts immediately', () => {
    expect(lookupApiToken('h-1')).toBeUndefined();
    storeApiToken('h-1', token('t-1'));
    expect(lookupApiToken('h-1')?.token.id).toBe('t-1');

    invalidateApiTokens({ tokenId: 't-1' });
    expect(lookupApiToken('h-1')).toBeUndefined();
  });

  it('user-wide invalidation drops every cached token of the user', () => {
    storeApiToken('h-1', token('t-1', 'u-1'));
    storeApiToken('h-2', token('t-2', 'u-1'));
    storeApiToken('h-3', token('t-3', 'u-2'));
    invalidateApiTokens({ userId: 'u-1' });
    expect(lookupApiToken('h-1')).toBeUndefined();
    expect(lookupApiToken('h-2')).toBeUndefined();
    expect(lookupApiToken('h-3')?.token.id).toBe('t-3');
  });

  it('fresh entries are not touch-due; expiry evicts on read', () => {
    storeApiToken('h-1', token('t-1'));
    expect(lookupApiToken('h-1')?.touchDue).toBe(false);
    markTokenTouched('h-1');
    expect(lookupApiToken('h-1')?.touchDue).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 31_000); // default TTL is 30s
    expect(lookupApiToken('h-1')).toBeUndefined();
  });
});

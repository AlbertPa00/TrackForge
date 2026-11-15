// 044 US5 — update-check unit tests (injected fetch; no network).
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureTestAuth } from '../request.js';
import { isNewer, checkForUpdates, lastCheck, updateCheckEnabled } from '../../src/services/updateCheckService.js';

const fakeFetch = (tag: string, status = 200): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ tag_name: tag, html_url: 'https://x/r' }), { status })) as typeof fetch;

beforeAll(async () => { await ensureTestAuth(); });

describe('044 update check', () => {
  it('isNewer compares semver numerically', () => {
    expect(isNewer('0.1.0', '0.1.1')).toBe(true);
    expect(isNewer('0.1.0', '0.10.0')).toBe(true);
    expect(isNewer('0.10.0', '0.1.0')).toBe(false);
    expect(isNewer('1.0.0', 'v1.0.0')).toBe(false);
    expect(isNewer('0.9.9', '1.0.0')).toBe(true);
  });

  it('disabled by default — no phone-home', () => {
    delete process.env.UPDATE_CHECK_ENABLED;
    expect(updateCheckEnabled()).toBe(false);
    process.env.UPDATE_CHECK_ENABLED = 'true';
    expect(updateCheckEnabled()).toBe(true);
    delete process.env.UPDATE_CHECK_ENABLED;
  });

  it('checkForUpdates persists result; updateAvailable on newer tag', async () => {
    const r = await checkForUpdates(fakeFetch('v99.0.0'));
    expect(r.latest).toBe('99.0.0');
    expect(r.updateAvailable).toBe(true);
    const stored = await lastCheck();
    expect(stored?.latest).toBe('99.0.0');
  });

  it('checkForUpdates fails closed on endpoint error', async () => {
    const r = await checkForUpdates(fakeFetch('x', 500));
    expect(r.updateAvailable).toBe(false);
    expect(r.error).toContain('500');
  });
});

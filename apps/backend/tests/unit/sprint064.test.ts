import { describe, it, expect } from 'vitest';
import { parseJql } from '../../src/jql/parser.js';
import { assertPublicUrl, isPrivateAddress, normalizeIp } from '../../src/lib/egress.js';
import { parseCookies } from '../../src/lib/auth.js';
import { isAllowedExternalUrl } from '../../src/lib/urls.js';

/**
 * Sprint 064 — regression tests for the pre-release security audit.
 * Pure unit tests: no DB, no app server. API-level regressions live in
 * tests/integration/sprint064.test.ts.
 */

describe('064 US1.2 — malformed cookies cannot crash auth resolution', () => {
  it('parseCookies survives invalid percent-encoding', () => {
    expect(() => parseCookies('x=%')).not.toThrow();
    expect(parseCookies('x=%')).toEqual({ x: '%' });
    expect(() => parseCookies('a=%E0%A4%A;b=ok')).not.toThrow();
    expect(parseCookies('a=%E0%A4%A;b=ok').b).toBe('ok');
  });
});

describe('064 US2 — unsafe URL schemes rejected', () => {
  it('isAllowedExternalUrl blocks javascript:/data:/vbscript:', () => {
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('  JAVASCRIPT:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('java\tscript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('data:text/html,<script>x</script>')).toBe(false);
    expect(isAllowedExternalUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('https://example.com/x?y=1')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
    expect(isAllowedExternalUrl('mailto:a@b.c')).toBe(true);
    expect(isAllowedExternalUrl('/relative/path')).toBe(false);
    expect(isAllowedExternalUrl('notaurl')).toBe(false);
  });
});

describe('064 US5 — egress guard', () => {
  it('blocks loopback/private literals incl. bracketed + mapped forms', async () => {
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.1.2.3')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    await expect(assertPublicUrl('http://[::1]:3000/x')).rejects.toThrow();
    await expect(assertPublicUrl('http://127.0.0.1/')).rejects.toThrow();
    await expect(assertPublicUrl('http://localhost/')).rejects.toThrow();
    await expect(assertPublicUrl('ftp://example.com/')).rejects.toThrow();
    await expect(assertPublicUrl('http://user:pass@example.com/')).rejects.toThrow();
    // Alternate IP encodings collapse via URL parsing then hit the blocklist.
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow(); // 127.0.0.1 decimal
    await expect(assertPublicUrl('http://0x7f000001/')).rejects.toThrow();  // hex
  });
  it('allowPrivate escape hatch works for self-hosted targets', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/', { allowPrivate: true })).resolves.toBeTruthy();
  });
});

describe('064 US6 — JQL complexity budgets', () => {
  const big = 'x'.repeat(10_001);
  it('rejects over-length input', () => {
    expect(() => parseJql(big)).toThrow(/limit/);
  });
  it('rejects deep nesting', () => {
    const deep = 'project = X and '.repeat(1) + '('.repeat(60) + 'a = 1' + ')'.repeat(60);
    expect(() => parseJql(deep)).toThrow(/nesting|limit/i);
  });
  it('rejects giant IN lists', () => {
    const list = `assignee in (${Array.from({ length: 501 }, (_, i) => `u${i}`).join(',')})`;
    expect(() => parseJql(list)).toThrow(/limit/);
  });
  it('still parses normal queries', () => {
    expect(() => parseJql('project = TF and status != Done order by created desc')).not.toThrow();
    expect(() => parseJql(`assignee in (${Array.from({ length: 20 }, (_, i) => `u${i}`).join(',')})`)).not.toThrow();
  });
});

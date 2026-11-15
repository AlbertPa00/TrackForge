import { describe, it, expect, vi } from 'vitest';
import { createJiraSource, createFixtureSource, JiraApiError } from '../../src/import/jiraClient.js';

const jsonRes = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('createJiraSource', () => {
  it('sends basic auth and parses JSON', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ key: 'TF' }));
    const src = createJiraSource({ baseUrl: 'https://x.atlassian.net', email: 'a@b.c', apiToken: 'tok', fetchImpl });
    const out = await src.get('/rest/api/3/project/TF');
    expect(out).toEqual({ key: 'TF' });
    const [, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`);
  });

  it('paginates startAt/total responses', async () => {
    const issues = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
    const fetchImpl = vi.fn(async (url: URL) => {
      const startAt = Number(url.searchParams.get('startAt') ?? 0);
      return jsonRes({ startAt, maxResults: 2, total: 5, issues: issues.slice(startAt, startAt + 2) });
    });
    const src = createJiraSource({ baseUrl: 'https://x', email: 'e', apiToken: 't', fetchImpl, pageSize: 2 });
    const got: unknown[] = [];
    for await (const i of src.paged('/rest/api/3/search', 'issues')) got.push(i);
    expect(got).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('follows agile nextPage URLs', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1
        ? jsonRes({ isLast: false, nextPage: 'https://x/rest/agile/1.0/board/1/sprint?startAt=2', values: [1, 2] })
        : jsonRes({ isLast: true, values: [3] });
    });
    const src = createJiraSource({ baseUrl: 'https://x', email: 'e', apiToken: 't', fetchImpl });
    const got: unknown[] = [];
    for await (const v of src.paged('/rest/agile/1.0/board/1/sprint', 'values')) got.push(v);
    expect(got).toEqual([1, 2, 3]);
    const [url] = fetchImpl.mock.calls[1] as [URL];
    expect(url.pathname).toBe('/rest/agile/1.0/board/1/sprint');
    expect(url.searchParams.get('startAt')).toBe('2');
  });

  it('honors Retry-After on 429 then succeeds', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls++;
        return calls === 1 ? jsonRes({ err: 1 }, 429, { 'retry-after': '1' }) : jsonRes({ ok: true });
      });
      const src = createJiraSource({ baseUrl: 'https://x', email: 'e', apiToken: 't', fetchImpl });
      const p = src.get('/x');
      await vi.advanceTimersByTimeAsync(1500);
      await expect(p).resolves.toEqual({ ok: true });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws JiraApiError on 4xx and never retries it', async () => {
    const fetchImpl = vi.fn(async () => jsonRes({ errorMessages: ['nope'] }, 403));
    const src = createJiraSource({ baseUrl: 'https://x', email: 'e', apiToken: 't', fetchImpl });
    await expect(src.get('/x')).rejects.toBeInstanceOf(JiraApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps concurrency', async () => {
    let inflight = 0; let max = 0;
    const fetchImpl = vi.fn(async () => {
      inflight++; max = Math.max(max, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return jsonRes({});
    });
    const src = createJiraSource({ baseUrl: 'https://x', email: 'e', apiToken: 't', fetchImpl, concurrency: 2 });
    await Promise.all(Array.from({ length: 8 }, () => src.get('/x')));
    expect(max).toBeLessThanOrEqual(2);
    expect(fetchImpl).toHaveBeenCalledTimes(8);
  });
});

describe('createFixtureSource', () => {
  it('serves get + paged from the fixture map', async () => {
    const src = createFixtureSource({
      '/rest/api/3/project/TF': { key: 'TF' },
      '/rest/api/3/search': { issues: [{ id: '1' }, { id: '2' }, { id: '3' }] },
    }, { pageSize: 2 });
    expect(await src.get('/rest/api/3/project/TF')).toEqual({ key: 'TF' });
    const got: unknown[] = [];
    for await (const i of src.paged('/rest/api/3/search', 'issues')) got.push(i);
    expect(got).toHaveLength(3);
  });

  it('404s on missing fixture entries', async () => {
    const src = createFixtureSource({});
    await expect(src.get('/nope')).rejects.toBeInstanceOf(JiraApiError);
  });
});

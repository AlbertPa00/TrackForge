import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';

async function seedProject(key: string) {
  await request(app)
    .post('/rest/api/2/project')
    .send({ key, name: `Project ${key}` })
    .expect(201);
}

async function createIssue(projectKey: string, summary: string) {
  return request(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: projectKey }, summary } });
}

describe('Issue number integrity', () => {
  it(
    'allocates distinct gap-free numbers under concurrency',
    { timeout: 60000 },
    async () => {
      await seedProject('CNCR');
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => createIssue('CNCR', `Concurrent ${i}`))
      );
      results.forEach((r) => expect(r.status).toBe(201));
      const keys = results.map((r) => r.body.key);
      expect(new Set(keys).size).toBe(20);
      const numbers = keys.map((k) => Number(k.split('-')[1])).sort((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    }
  );
});

describe('JQL summary ~ clause', () => {
  it('filters summaries case-insensitively', async () => {
    await seedProject('TXF');
    for (const s of ['Fix login crash', 'Add dashboard', 'Login page polish']) {
      await createIssue('TXF', s);
    }
    const res = await request(app).get(
      '/rest/api/2/search?jql=' +
        encodeURIComponent('project = TXF AND summary ~ "login"')
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.issues.map((i: { key: string }) => i.key)).toEqual(['TXF-1', 'TXF-3']);
  });

  it('treats empty summary ~ "" as no filter', async () => {
    await seedProject('EMP');
    await createIssue('EMP', 'One');
    const res = await request(app).get(
      '/rest/api/2/search?jql=' + encodeURIComponent('project = EMP AND summary ~ ""')
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });

  it('accepts unquoted single-word contains value', async () => {
    await seedProject('UQ');
    await createIssue('UQ', 'login fix');
    const res = await request(app).get(
      '/rest/api/2/search?jql=' + encodeURIComponent('project = UQ AND summary ~ login')
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

describe('Pagination edge cases', () => {
  it('page beyond the last page returns empty issues with correct total', async () => {
    await seedProject('PGN');
    for (const s of ['A', 'B']) await createIssue('PGN', s);
    const res = await request(app).get(
      '/rest/api/2/search?jql=' +
        encodeURIComponent('project = PGN') +
        '&startAt=50&maxResults=25'
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.issues).toEqual([]);
  });
});

describe('JSON 404 and self links', () => {
  it('returns Jira-shaped JSON for unknown /rest routes', async () => {
    const res = await request(app).get('/rest/api/2/nonexistent');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.errorMessages).toEqual(['Route not found']);
  });

  it('also covers unknown agile routes', async () => {
    const res = await request(app).get('/rest/agile/1.0/nope');
    expect(res.status).toBe(404);
    expect(res.body.errorMessages).toEqual(['Route not found']);
  });

  it('derives self links from PUBLIC_BASE_URL', async () => {
    await seedProject('SLF');
    await createIssue('SLF', 'Self link');
    process.env.PUBLIC_BASE_URL = 'https://trackforge.example.com/';
    const res = await request(app).get('/rest/api/2/issue/SLF-1');
    delete process.env.PUBLIC_BASE_URL;
    expect(res.body.self).toBe(
      'https://trackforge.example.com/rest/api/2/issue/SLF-1'
    );
  });
});

describe('065 E3 — client-error mapping', () => {
  it('malformed JSON returns a Jira-shaped 400, not a 500', async () => {
    const res = await request(app)
      .post('/rest/api/2/issue')
      .set('Content-Type', 'application/json')
      .send('{"fields": oops');
    expect(res.status).toBe(400);
    expect(res.body.errorMessages[0]).toMatch(/malformed|bad request/i);
  });

  it('security headers ride every response (E4)', async () => {
    const res = await request(app).get('/rest/api/2/serverInfo');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
});

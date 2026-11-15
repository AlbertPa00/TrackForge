// Sprint 060 US7 — Jira DC issue archiving: archived issues leave every read
// surface (search, direct GET, comments) via the single securityGateWhere
// predicate + canSeeIssue existence-hiding, are read-only until restored, and
// remain visible only in the per-project archived browse + restore paths.
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { authed, ensureTestAuth } from '../request.js';

describe('issue archiving (060 US7)', () => {
  const KEY = 'ARCH-1';

  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'ARCH', name: 'ARCH' }).expect(201);
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'ARCH' }, summary: 'archive me', issuetype: { name: 'Task' } } })
      .expect(201);
  });

  it('dryRun previews without archiving', async () => {
    const preview = await authed(app)
      .put(`/rest/api/2/issue/${KEY}/archive?dryRun=true`)
      .expect(200);
    expect(preview.body.wouldArchive).toBe(true);
    // still visible
    await authed(app).get(`/rest/api/2/issue/${KEY}`).expect(200);
  });

  it('archive hides the issue from every read surface and makes it read-only', async () => {
    await authed(app).put(`/rest/api/2/issue/${KEY}/archive`).expect(204);

    // direct GET 404s (existence-hiding, same as security levels)
    await authed(app).get(`/rest/api/2/issue/${KEY}`).expect(404);
    // JQL search excludes it
    const search = await authed(app)
      .post('/rest/api/2/search')
      .send({ jql: `project = ARCH` })
      .expect(200);
    expect(search.body.issues.map((i: { key: string }) => i.key)).not.toContain(KEY);
    // mutations are rejected — the 404 applies to writes too
    await authed(app)
      .put(`/rest/api/2/issue/${KEY}`)
      .send({ fields: { summary: 'nope' } })
      .expect(404);
    await authed(app)
      .post(`/rest/api/2/issue/${KEY}/comment`)
      .send({ body: 'nope' })
      .expect(404);
    // already-archived issue can't be archived again (hidden → 404)
    await authed(app).put(`/rest/api/2/issue/${KEY}/archive`).expect(404);
  });

  it('archived browse lists it; restore brings it back', async () => {
    await authed(app).put(`/rest/api/2/issue/${KEY}/archive`).expect(204);

    const browse = await authed(app)
      .get('/api/internal/projects/ARCH/issues/archived')
      .expect(200);
    expect(browse.body).toHaveLength(1);
    expect(browse.body[0].issueNumber).toBe(1);
    expect(browse.body[0].summary).toBe('archive me');

    // restore bypasses the existence-hiding deliberately
    await authed(app).put(`/rest/api/2/issue/${KEY}/restore`).expect(204);
    await authed(app).get(`/rest/api/2/issue/${KEY}`).expect(200);
    const search = await authed(app)
      .post('/rest/api/2/search')
      .send({ jql: `project = ARCH` })
      .expect(200);
    expect(search.body.issues.map((i: { key: string }) => i.key)).toContain(KEY);

    // restored issue is writable again (Jira PUT returns 204)
    await authed(app)
      .put(`/rest/api/2/issue/${KEY}`)
      .send({ fields: { summary: 'restored' } })
      .expect(204);
    const browse2 = await authed(app)
      .get('/api/internal/projects/ARCH/issues/archived')
      .expect(200);
    expect(browse2.body).toHaveLength(0);
  });

  it('restore on a non-archived issue 400s', async () => {
    await authed(app).put(`/rest/api/2/issue/${KEY}/restore`).expect(400);
  });
});

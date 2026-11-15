import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';
import { MemoryStore, setAttachmentStore } from '../../src/ports/attachmentStore.js';
import { registerAttachmentJobs } from '../../src/services/attachmentService.js';

/**
 * Sprint 020 G5 — leak test. Two layers under test:
 *  1. Unauthenticated: every /rest|/api/internal read must 401 (global requireAuth).
 *  2. Token project allow-list: a token scoped to AAA must get 404 (never 200/403)
 *     on every BBB resource — including board/sprint/component/version entities
 *     whose ids don't embed the project key.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Mint an API token for `email` (created if absent) with the given scopes/project allow-list. */
async function mintToken(email: string, scopes: string[], projectKeys: string[], isAdmin = false) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: email, passwordHash: await hashPassword('x-'.repeat(8)), isAdmin },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes, projectKeys } });
  return request.agent(app).set('Authorization', `Bearer ${plain}`);
}

async function makeProject(key: string) {
  // Via the route (not prisma.project.create) — the project endpoint also
  // provisions the default board, which the fixture's scoped reads rely on.
  const exists = await prisma.project.findUnique({ where: { key } });
  if (exists) return;
  await authed(app).post('/rest/api/2/project').send({ key, name: key }).expect(201);
}

async function makeIssue(key: string, summary = 'leak probe') {
  const res = await authed(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key }, summary } })
    .expect(201);
  return res.body.key as string;
}

/** Full BBB fixture: issue + comment + attachment + component + version + board + sprint. Returns their ids. */
async function bbbFixture() {
  await makeProject('AAA');
  await makeProject('BBB');
  const aaaIssue = await makeIssue('AAA', 'visible');
  const key = await makeIssue('BBB', 'hidden');
  await authed(app).post(`/rest/api/2/issue/${key}/comment`).send({ body: 'secret comment' }).expect(201);
  const att = (await authed(app)
    .post(`/rest/api/2/issue/${key}/attachments`)
    .set('X-Atlassian-Token', 'no-check')
    .attach('file', PNG, 's.png')
    .expect(200)).body[0];
  const comp = (await authed(app)
    .post('/rest/api/2/component')
    .send({ project: 'BBB', name: 'hidden-comp' })
    .expect(201)).body;
  const ver = (await authed(app)
    .post('/rest/api/2/version')
    .send({ project: 'BBB', name: 'hidden-ver' })
    .expect(201)).body;
  const board = (await authed(app).get('/rest/agile/1.0/board?projectKeyOrId=BBB').expect(200)).body.values[0];
  const sprint = (await authed(app)
    .post('/rest/agile/1.0/sprint')
    .send({ originBoardId: board.id, name: 'hidden-sprint' })
    .expect(201)).body;
  const aaaBoard = (await authed(app).get('/rest/agile/1.0/board?projectKeyOrId=AAA').expect(200)).body.values[0];
  return { key, aaaIssue, attId: att.id as string, compId: comp.id as string, verId: ver.id as string, boardId: board.id as string, sprintId: sprint.id as string, aaaBoardId: aaaBoard.id as string };
}

describe('Sprint 020 G5 — leak test', () => {
  beforeAll(async () => {
    await ensureTestAuth();
    await (await import('../../src/seed.js')).seedPermissionDefaults();
    setAttachmentStore(new MemoryStore());
    registerAttachmentJobs();
  });

  it('unauthenticated requests 401 on every read surface', async () => {
    const f = await bbbFixture();
    const paths = [
      `/rest/api/2/issue/${f.key}`,
      `/rest/api/2/issue/${f.key}/comment`,
      `/rest/api/2/issue/${f.key}/changelog`,
      `/rest/api/2/issue/${f.key}/transitions`,
      `/rest/api/2/attachment/${f.attId}`,
      `/rest/api/2/attachment/content/${f.attId}`,
      `/rest/api/2/component/${f.compId}`,
      `/rest/api/2/version/${f.verId}`,
      '/rest/api/2/project/BBB',
      '/rest/api/2/project/BBB/components',
      '/rest/api/2/search?jql=project=BBB',
      '/rest/api/2/field',
      `/rest/agile/1.0/board/${f.boardId}`,
      `/rest/agile/1.0/board/${f.boardId}/issue`,
      `/rest/agile/1.0/sprint/${f.sprintId}`,
      '/api/internal/users',
      '/api/internal/events',
      '/api/internal/me/work',
    ];
    for (const p of paths) {
      const res = await request(app).get(p);
      expect(res.status, `GET ${p} should be 401 unauthenticated, got ${res.status}`).toBe(401);
    }
  });

  it('scoped token gets 404 on every BBB resource (id-keyed surfaces included)', async () => {
    const f = await bbbFixture();
    const scoped = await mintToken('scoped@test.local', ['read', 'write'], ['AAA']);
    const paths = [
      `/rest/api/2/issue/${f.key}`,
      `/rest/api/2/issue/${f.key}/comment`,
      `/rest/api/2/issue/${f.key}/changelog`,
      `/rest/api/2/issue/${f.key}/transitions`,
      `/rest/api/2/issue/${f.key}/editmeta`,
      `/rest/api/2/issue/${f.key}/watchers`,
      `/rest/api/2/attachment/${f.attId}`,
      `/rest/api/2/attachment/content/${f.attId}`,
      `/rest/api/2/attachment/thumbnail/${f.attId}`,
      `/rest/api/2/component/${f.compId}`,
      `/rest/api/2/component/${f.compId}/relatedIssueCounts`,
      `/rest/api/2/version/${f.verId}`,
      `/rest/api/2/version/${f.verId}/releasenotes`,
      `/rest/api/2/version/${f.verId}/relatedIssueCounts`,
      `/rest/api/2/version/${f.verId}/unresolvedIssueCount`,
      '/rest/api/2/project/BBB',
      '/rest/api/2/project/BBB/components',
      '/rest/api/2/project/BBB/versions',
      '/rest/api/2/project/BBB/statuses',
      `/rest/agile/1.0/board/${f.boardId}`,
      `/rest/agile/1.0/board/${f.boardId}/configuration`,
      `/rest/agile/1.0/board/${f.boardId}/issue`,
      `/rest/agile/1.0/board/${f.boardId}/sprint`,
      `/rest/agile/1.0/board/${f.boardId}/backlog`,
      `/rest/agile/1.0/sprint/${f.sprintId}`,
      `/rest/agile/1.0/sprint/${f.sprintId}/issue`,
      `/rest/agile/1.0/issue/${f.key}`,
      `/rest/agile/1.0/epic/${f.key}`,
      // 065 audit C3 — print export must apply the token allow-list too.
      `/api/internal/export/issue/${f.key}`,
    ];
    for (const p of paths) {
      const res = await scoped.get(p);
      expect(res.status, `GET ${p} should be 404 for scoped token, got ${res.status}`).toBe(404);
    }
    // Positive control — AAA resources still readable.
    await scoped.get(`/rest/api/2/issue/${f.aaaIssue}`).expect(200);
    await scoped.get('/rest/api/2/project/AAA').expect(200);
    await scoped.get(`/rest/agile/1.0/board/${f.aaaBoardId}`).expect(200);
  });

  it('scoped token writes to BBB entities get 404, not 403/200', async () => {
    const f = await bbbFixture();
    const scoped = await mintToken('scoped2@test.local', ['read', 'write'], ['AAA']);
    const attempts: [string, object][] = [
      [`/rest/api/2/component/${f.compId}`, { name: 'x' }],
      [`/rest/api/2/version/${f.verId}`, { name: 'x' }],
      [`/rest/agile/1.0/board/${f.boardId}/type`, { type: 'scrum' }],
    ];
    for (const [p, body] of attempts) {
      const res = await scoped.put(p).send(body);
      expect(res.status, `PUT ${p} should be 404 for scoped token, got ${res.status}`).toBe(404);
    }
    await scoped.delete(`/rest/api/2/component/${f.compId}`).expect(404);
    await scoped.delete(`/rest/api/2/version/${f.verId}`).expect(404);
    await scoped.delete(`/rest/agile/1.0/sprint/${f.sprintId}`).expect(404);
    await scoped.post('/rest/api/2/component').send({ project: 'BBB', name: 'sneaky' }).expect(404);
    await scoped.post('/rest/agile/1.0/sprint').send({ originBoardId: f.boardId, name: 'sneaky' }).expect(404);
    await scoped
      .post(`/rest/agile/1.0/sprint/${f.sprintId}/issue`)
      .send({ issues: ['AAA-1'] })
      .expect(404);
    // Bulk issue-key bodies containing an out-of-scope key are rejected wholesale.
    await scoped.post('/rest/agile/1.0/backlog/issue').send({ issues: [f.key] }).expect(404);
    await scoped.put('/rest/agile/1.0/issue/rank').send({ issues: [f.key] }).expect(404);
  });

  it('search narrows to the token allow-list', async () => {
    const f = await bbbFixture();
    const scoped = await mintToken('scoped3@test.local', ['read'], ['AAA']);
    const all = await scoped.get('/rest/api/2/search?jql=' + encodeURIComponent('project = AAA')).expect(200);
    const keys = all.body.issues.map((i: { key: string }) => i.key);
    expect(keys).toContain(f.aaaIssue);
    expect(keys).not.toContain(f.key);
    // Querying an out-of-scope project is rejected (400) or empty — either way
    // no BBB issue keys come back, matching Jira's "project not found" behavior.
    const onlyB = await scoped.get('/rest/api/2/search?jql=' + encodeURIComponent('project = BBB'));
    expect([200, 400]).toContain(onlyB.status);
    if (onlyB.status === 200) expect(onlyB.body.issues).toHaveLength(0);
  });

  it('board list filters out-of-scope boards', async () => {
    await bbbFixture();
    const scoped = await mintToken('scoped4@test.local', ['read'], ['AAA']);
    const res = await scoped.get('/rest/agile/1.0/board').expect(200);
    const keys = res.body.values.map((b: { location: { projectKey: string } }) => b.location.projectKey);
    expect(keys).toEqual(['AAA']);
    const filtered = await scoped.get('/rest/agile/1.0/board?projectKeyOrId=BBB').expect(200);
    expect(filtered.body.values).toHaveLength(0);
  });

  it('read-scope token can read but not write', async () => {
    const f = await bbbFixture();
    const reader = await mintToken('reader@test.local', ['read'], []);
    await reader.get(`/rest/api/2/issue/${f.key}`).expect(200);
    const res = await reader.post('/rest/api/2/issue').send({ fields: { project: { key: 'BBB' }, summary: 'nope' } });
    expect(res.status).toBe(403);
  });

  it('non-admin user token gets 403 on admin surfaces', async () => {
    await bbbFixture();
    const pleb = await mintToken('pleb@test.local', ['read', 'write'], []);
    // /api/internal/tokens is self-service (own tokens) — intentionally absent.
    const adminPaths = ['/api/internal/users', '/api/internal/audit', '/api/internal/admin/jobs'];
    for (const p of adminPaths) {
      const res = await pleb.get(p);
      expect(res.status, `GET ${p} should be 403 for non-admin, got ${res.status}`).toBe(403);
    }
    // …while plain project data stays readable.
    await pleb.get('/rest/api/2/project/BBB').expect(200);
  });
});

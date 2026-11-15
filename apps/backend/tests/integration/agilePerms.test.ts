// H2-a (sprint 025): agile write paths must evaluate permissions — previously
// any authenticated actor could create/edit sprints, reconfigure boards,
// re-rank backlog, and re-parent epics (020's leak test only added the
// token-allow-list read layer). Regression: unprivileged → 403, admin → 2xx.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { generateToken, hashPassword } from '../../src/lib/auth.js';

async function mintToken(email: string, scopes: string[]) {
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: email, passwordHash: await hashPassword('x-'.repeat(8)) },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes, projectKeys: [] } });
  return { agent: request.agent(app).set('Authorization', `Bearer ${plain}`), user };
}

// Bind `projectKey` to a fresh scheme whose only grant is `permission`→user —
// the default scheme grants every non-admin perm to 'applicationRole' (any
// logged-in user), which would make the gate checks trivially pass.
async function bindNarrowScheme(projectKey: string, userId: string, permission: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { key: projectKey } });
  const scheme = await prisma.permissionScheme.create({
    data: { name: `narrow-${projectKey}-${userId.slice(0, 6)}` },
  });
  await prisma.permissionGrant.create({
    data: { schemeId: scheme.id, permission, holderType: 'user', holderParam: userId },
  });
  await prisma.project.update({ where: { id: project.id }, data: { permissionSchemeId: scheme.id } });
}

describe('agile write-permission gates (H2-a)', () => {
  let boardId: string;
  let sprintId: string;
  let issueKey: string;

  // setup.ts wipes the DB before each test — fixtures live in beforeEach.
  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'WPG', name: 'WPG' }).expect(201);
    const issue = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'WPG' }, summary: 'perm probe' } })
      .expect(201);
    issueKey = issue.body.key;
    const boards = await authed(app).get('/rest/agile/1.0/board?projectKeyOrId=WPG').expect(200);
    boardId = boards.body.values[0].id;
    const sprint = await authed(app)
      .post('/rest/agile/1.0/sprint')
      .send({ originBoardId: boardId, name: 'WPG Sprint 1' })
      .expect(201);
    sprintId = sprint.body.id;
  });

  it('browse-only token gets 403 on every agile write surface', async () => {
    const { agent, user } = await mintToken('nopriv@test.local', ['read', 'write']);
    // BROWSE so the scope layer resolves the board/sprint; no write perms.
    await bindNarrowScheme('WPG', user.id, 'BROWSE_PROJECTS');
    const writes: [string, string, object?][] = [
      ['post', '/rest/agile/1.0/sprint', { originBoardId: boardId, name: 'x' }],
      ['put', `/rest/agile/1.0/sprint/${sprintId}`, { name: 'renamed' }],
      ['delete', `/rest/agile/1.0/sprint/${sprintId}`],
      ['post', `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues: [issueKey] }],
      ['post', '/rest/agile/1.0/backlog/issue', { issues: [issueKey] }],
      ['put', `/rest/agile/1.0/board/${boardId}/configuration`, { columns: [{ name: 'x', statusIds: ['any'] }] }],
      ['put', `/rest/agile/1.0/board/${boardId}/type`, { type: 'kanban' }],
      ['put', '/rest/agile/1.0/issue/rank', { issues: [issueKey], rankBeforeIssue: issueKey }],
      ['post', '/rest/agile/1.0/epic/none/issue', { issues: [issueKey] }],
    ];
    for (const [method, path, body] of writes) {
      const res = await (agent as never)[method](path).send(body);
      expect(res.status, `${method.toUpperCase()} ${path} → ${res.status}`).toBe(403);
    }
  });

  it('admin still succeeds on the same surfaces', async () => {
    // sprint CRUD + move + board config are exercised green elsewhere; this
    // checks the gate does not over-block a privileged actor.
    const sp = await authed(app)
      .post('/rest/agile/1.0/sprint')
      .send({ originBoardId: boardId, name: 'WPG Sprint 2' });
    expect(sp.status).toBe(201);
    await authed(app).delete(`/rest/agile/1.0/sprint/${sp.body.id}`).expect(204);
  });
});

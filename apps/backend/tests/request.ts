import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import { afterAll } from 'vitest';
import { prisma } from '../src/prisma.js';
import { hashPassword, generateToken } from '../src/lib/auth.js';

export const TEST_ADMIN = {
  email: 'admin@test.local',
  displayName: 'Test Admin',
  password: 'test-password-1',
};

let cachedPlain: string | null = null;
let cachedHash: string | null = null;

/** Ensures a test admin + full-scope token exist in the (freshly wiped) test DB. */
export async function ensureTestAuth() {
  // scryptSync is deliberately slow (~80ms); the password is constant so the
  // hash is computed once per run instead of once per test.
  cachedHash ??= await hashPassword(TEST_ADMIN.password);
  const user = await prisma.user.upsert({
    where: { email: TEST_ADMIN.email },
    update: {},
    create: {
      email: TEST_ADMIN.email,
      displayName: TEST_ADMIN.displayName,
      passwordHash: cachedHash,
      isAdmin: true,
    },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: { userId: user.id, name: 'test', prefix, hash, scopes: ['read', 'write', 'admin'] },
  });
  cachedPlain = plain;
  return { user, bearer: plain };
}

export function bearer() {
  return cachedPlain!;
}

/**
 * Drop-in replacement for `request(app)` that attaches the admin token.
 * Reuses one listening server per app — supertest's `request(app)` form
 * binds, listens, and closes an ephemeral port on EVERY call, which is a
 * large share of per-request cost on Windows.
 */
const servers = new Map<Express, Server>();

export function authed(app: Express) {
  let server = servers.get(app);
  if (!server) {
    server = app.listen(0);
    servers.set(app, server);
  }
  return request.agent(server).set('Authorization', `Bearer ${cachedPlain}`);
}

/**
 * Session-cookie agent — logs in as TEST_ADMIN. Required for endpoints that
 * are session-only by design (065 audit B1: POST /api/internal/tokens rejects
 * token-authenticated callers).
 */
export async function sessioned(app: Express) {
  let server = servers.get(app);
  if (!server) {
    server = app.listen(0);
    servers.set(app, server);
  }
  const agent = request.agent(server);
  const res = await agent
    .post('/api/internal/auth/login')
    .send({ email: TEST_ADMIN.email, password: TEST_ADMIN.password });
  if (res.status !== 200) throw new Error(`sessioned login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}

afterAll(() => {
  for (const server of servers.values()) server.close();
  servers.clear();
});

/**
 * Moves an issue to `statusName` via the workflow transitions API, taking as
 * many hops as needed (e.g. To Do → In Progress → Done). Supplies a resolution
 * automatically when the target status is in the `done` category.
 */
export async function transitionTo(app: Express, issueKey: string, statusName: string) {
  for (let i = 0; i < 6; i++) {
    const issue = await authed(app).get(`/rest/api/2/issue/${issueKey}`).expect(200);
    if (issue.body.fields.status.name === statusName) return;
    const list = await authed(app).get(`/rest/api/2/issue/${issueKey}/transitions`).expect(200);
    const direct = list.body.transitions.find((t: { to: { name: string } }) => t.to.name === statusName);
    const t = direct ?? list.body.transitions.find((x: { name: string }) => x.name === 'Start Progress') ?? list.body.transitions[0];
    if (!t) throw new Error(`No transitions available for ${issueKey} (wanted ${statusName})`);
    const body: Record<string, unknown> = { transition: { id: t.id } };
    if (t.to.statusCategory?.key === 'done') body.fields = { resolution: { name: 'Done' } };
    await authed(app).post(`/rest/api/2/issue/${issueKey}/transitions`).send(body).expect(204);
  }
  throw new Error(`Could not reach ${statusName} for ${issueKey}`);
}

// 049 — SCIM 2.0 service provider: SC-001 round-trip (Okta-style payloads).
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { generateToken } from '../../src/lib/auth.js';

let server: Server | null = null;
afterAll(() => { server?.close(); server = null; });

async function makeConnection(enabled = true) {
  const created = await authed(app).post('/api/internal/admin/directory')
    .send({ type: 'scim', name: 'Okta', enabled }).expect(201);
  return { connId: created.body.id as string, token: created.body.scimToken as string };
}

const scim = (token: string) => {
  server ??= app.listen(0);
  return request.agent(server).set('Authorization', `Bearer ${token}`);
};

const OKTA_USER = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
  externalId: '00u1abcXYZ',
  userName: 'jane.doe@corp.example',
  displayName: 'Jane Doe',
  name: { givenName: 'Jane', familyName: 'Doe' },
  emails: [{ value: 'jane.doe@corp.example', primary: true }],
  active: true,
};

describe('049 US1 — SCIM 2.0 service provider (SC-001)', () => {
  it('discovery advertises patch+filter, no bulk', async () => {
    const { token } = await makeConnection();
    const cfg = await scim(token).get('/scim/v2/ServiceProviderConfig').expect(200);
    expect(cfg.body.patch.supported).toBe(true);
    expect(cfg.body.filter.supported).toBe(true);
    expect(cfg.body.bulk.supported).toBe(false);
    const rt = await scim(token).get('/scim/v2/ResourceTypes').expect(200);
    expect(rt.body.Resources.map((r: { id: string }) => r.id)).toEqual(['User', 'Group']);
  });

  it('provision → update → deactivate → credentials revoked; replay idempotent', async () => {
    const { connId, token } = await makeConnection();

    // Provision.
    const created = await scim(token).post('/scim/v2/Users').send(OKTA_USER).expect(201);
    expect(created.body.externalId).toBe('00u1abcXYZ');
    const userId = created.body.id as string;
    const ident = await prisma.externalIdentity.findFirst({ where: { userId, provider: 'scim' } });
    expect(ident!.externalId).toBe('00u1abcXYZ');
    expect(ident!.directoryConnectionId).toBe(connId);

    // Replay — same externalId converges, no duplicate.
    const replay = await scim(token).post('/scim/v2/Users').send(OKTA_USER).expect(200);
    expect(replay.body.id).toBe(userId);
    expect(await prisma.user.count({ where: { email: 'jane.doe@corp.example' } })).toBe(1);

    // Rename via PUT — keyed by externalId, not name (FR-004).
    await scim(token).put(`/scim/v2/Users/${userId}`).send({
      ...OKTA_USER, userName: 'jane.roe@corp.example',
      emails: [{ value: 'jane.roe@corp.example', primary: true }],
    }).expect(200);
    const renamed = await prisma.user.findUnique({ where: { id: userId } });
    expect(renamed!.email).toBe('jane.roe@corp.example');

    // Filter queries.
    const byName = await scim(token).get('/scim/v2/Users?filter=' +
      encodeURIComponent('userName eq "jane.roe@corp.example"')).expect(200);
    expect(byName.body.totalResults).toBe(1);
    const byExt = await scim(token).get('/scim/v2/Users?filter=' +
      encodeURIComponent('externalId eq "00u1abcXYZ"')).expect(200);
    expect(byExt.body.Resources[0].id).toBe(userId);

    // Give the user credentials, then deprovision — all revoked (FR-003).
    const { hash } = generateToken();
    const pat = await prisma.apiToken.create({
      data: { userId, name: 'doomed', prefix: 'x', hash, scopes: ['read'] },
    });
    const session = await prisma.session.create({
      data: { userId, expiresAt: new Date(Date.now() + 864e5) },
    });
    await scim(token).patch(`/scim/v2/Users/${userId}`).send({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'Replace', path: 'active', value: 'False' }],
    }).expect(200);
    const dead = await prisma.user.findUnique({ where: { id: userId } });
    expect(dead!.active).toBe(false);
    expect((await prisma.apiToken.findUnique({ where: { id: pat.id } }))!.revokedAt).not.toBeNull();
    expect((await prisma.session.findUnique({ where: { id: session.id } }))!.revokedAt).not.toBeNull();

    // DELETE also deactivates, never removes the row.
    await scim(token).delete(`/scim/v2/Users/${userId}`).expect(204);
    expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  });

  it('groups converge membership; unknown members warn in syncStatus', async () => {
    const { connId, token } = await makeConnection();
    const u1 = await scim(token).post('/scim/v2/Users').send({ ...OKTA_USER, externalId: 'e1', userName: 'a@x.c', emails: [{ value: 'a@x.c', primary: true }] }).expect(201);
    const u2 = await scim(token).post('/scim/v2/Users').send({ ...OKTA_USER, externalId: 'e2', userName: 'b@x.c', emails: [{ value: 'b@x.c', primary: true }] }).expect(201);

    const g = await scim(token).post('/scim/v2/Groups').send({
      displayName: 'Engineering', members: [{ value: u1.body.id }, { value: 'ghost-user-id' }],
    }).expect(201);
    const groupId = g.body.id as string;
    expect(g.body.members).toHaveLength(1); // ghost skipped

    // Membership replace — converges exactly.
    const replaced = await scim(token).put(`/scim/v2/Groups/${groupId}`).send({
      displayName: 'Engineering', members: [{ value: u2.body.id }],
    }).expect(200);
    expect(replaced.body.members.map((m: { value: string }) => m.value)).toEqual([u2.body.id]);
    const members = await prisma.groupMember.findMany({ where: { groupId } });
    expect(members.map((m) => m.userId)).toEqual([u2.body.id]);

    // Warning landed in the connection's sync log.
    const conn = await prisma.directoryConnection.findUnique({ where: { id: connId } });
    const log = (conn!.syncStatus as { log: { level: string; msg: string }[] }).log;
    expect(log.some((l) => l.level === 'warn' && l.msg.includes('ghost-user-id'))).toBe(true);
  });

  it('auth + config hardening: bad token 401, disabled conn 401, tls:none refused', async () => {
    await request(app).get('/scim/v2/Users').set('Authorization', 'Bearer bogus').expect(401);
    const { connId } = await makeConnection(false); // disabled
    const { token } = await makeConnection();
    await request(app).get('/scim/v2/Users').set('Authorization', `Bearer ${token}`).expect(200);
    const disabled = await authed(app).post('/api/internal/admin/directory')
      .send({ type: 'scim', name: 'Off', enabled: false }).expect(201);
    await request(app).get('/scim/v2/Users')
      .set('Authorization', `Bearer ${disabled.body.scimToken}`).expect(401);
    await authed(app).post('/api/internal/admin/directory')
      .send({ type: 'ldap', name: 'AD', enabled: false, config: { tls: 'none' } }).expect(400);
    expect(connId).toBeTruthy();
  });

  it('SC-005 flood: per-connection cap trips while other connections stay healthy', async () => {
    const prev = process.env.SCIM_RATE_LIMIT;
    process.env.SCIM_RATE_LIMIT = '20';
    try {
      const a = await makeConnection();
      const b = await makeConnection();
      let saw429 = 0;
      for (let i = 0; i < 40; i++) {
        const r = await scim(a.token).get('/scim/v2/Users');
        if (r.status === 429) saw429++;
      }
      expect(saw429).toBeGreaterThan(0);
      // Other connections unaffected — the flood is connection-scoped.
      await scim(b.token).get('/scim/v2/Users').expect(200);
      // Non-SCIM API unaffected.
      await authed(app).get('/api/internal/admin/directory').expect(200);
    } finally {
      if (prev === undefined) delete process.env.SCIM_RATE_LIMIT; else process.env.SCIM_RATE_LIMIT = prev;
    }
  });

  it('secret material: secretRef + scimToken never re-emitted (FR-007)', async () => {
    const { connId, token } = await makeConnection();
    const list = await authed(app).get('/api/internal/admin/directory').expect(200);
    const row = list.body.connections.find((c: { id: string }) => c.id === connId);
    expect(row.secretRef).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain(token);
  });
});

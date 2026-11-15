// 049 — LDAP/AD bind auth + sync (SC-002): real OpenLDAP container fixture.
// Requires trackforge-openldap on 127.0.0.1:1389 (seeded via tests/fixtures/ldap-seed.ldif).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import net from 'node:net';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { escapeLdapFilter } from '../../src/services/directoryService.js';

let server: Server | null = null;
afterAll(() => { server?.close(); server = null; });
const plain = () => { server ??= app.listen(0); return request.agent(server); };

const LDAP_HOST = '127.0.0.1';
const LDAP_PORT = 1389;
let ldapUp = false;

const CONFIG = {
  hosts: [LDAP_HOST], port: LDAP_PORT, tls: 'starttls', insecureSkipVerify: true,
  bindDn: 'cn=admin,dc=test,dc=local', baseDn: 'dc=test,dc=local',
  userFilter: '(&(objectClass=inetOrgPerson)(uid={login}))',
  attrMap: {},
  groupMap: { engineers: 'dev-team' },
};

beforeAll(async () => {
  ldapUp = await new Promise<boolean>((resolve) => {
    const s = net.connect({ host: LDAP_HOST, port: LDAP_PORT, timeout: 2000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
  process.env.LDAP_TEST_BIND_PW = 'admin-secret';
  if (ldapUp) {
    // The LDAP container persists across runs — reset mutated entries so the
    // suite is idempotent (alice's mail restored, carol's disable bit cleared).
    const { execSync } = await import('node:child_process');
    const mod = (ldif: string) => {
      try {
        execSync(`docker exec -i trackforge-openldap ldapmodify -x -H ldap://localhost -D "cn=admin,dc=test,dc=local" -w admin-secret`, { input: ldif });
      } catch { /* entry already in desired state */ }
    };
    mod('dn: uid=alice,ou=users,dc=test,dc=local\nchangetype: modify\nreplace: mail\nmail: alice@test.local\n');
    mod('dn: uid=carol,ou=users,dc=test,dc=local\nchangetype: modify\ndelete: description\n');
  }
});

async function makeConn(enabled = true) {
  const created = await authed(app).post('/api/internal/admin/directory').send({
    type: 'ldap', name: 'TestAD', enabled, config: CONFIG, secretRef: 'env:LDAP_TEST_BIND_PW',
  }).expect(201);
  return created.body.id as string;
}

async function ldapModify(ldif: string) {
  const { execSync } = await import('node:child_process');
  execSync(`docker exec -i trackforge-openldap ldapmodify -x -H ldap://localhost -D "cn=admin,dc=test,dc=local" -w admin-secret`, { input: ldif });
}

describe('049 US2 — LDAP bind auth + sync (SC-002)', () => {
  it('connection test reports bind + sample resolution before enable', async (ctx) => {
    if (!ldapUp) return ctx.skip();
    const id = await makeConn(false);
    const r = await authed(app).post(`/api/internal/admin/directory/${id}/test`)
      .send({ sampleLogin: 'alice' }).expect(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sampleUser.login).toBe('alice');
    expect(r.body.sampleUser.dn).toBe('uid=alice,ou=users,dc=test,dc=local');
  });

  it('bind auth provisions a shadow user; bad password is ordinary 401', async (ctx) => {
    if (!ldapUp) return ctx.skip();
    await makeConn();
    // Directory password works → session issued, shadow user provisioned.
    const ok = await plain().post('/api/internal/auth/login')
      .send({ email: 'alice', password: 'alice-secret-pass' }).expect(200);
    expect(ok.headers['set-cookie']?.[0]).toContain('tf_session');
    const user = await prisma.user.findUnique({ where: { email: 'alice@test.local' } });
    expect(user).not.toBeNull();
    expect(user!.passwordHash).toBe('!external');
    const ident = await prisma.externalIdentity.findFirst({ where: { userId: user!.id, provider: 'ldap' } });
    expect(ident!.externalId).toBeTruthy(); // entryUUID

    // Wrong directory password → ordinary 401, not "directory unavailable".
    await plain().post('/api/internal/auth/login')
      .send({ email: 'alice', password: 'wrong-password' }).expect(401);
    // Unknown-in-directory user also 401.
    await plain().post('/api/internal/auth/login')
      .send({ email: 'nobody', password: 'x' }).expect(401);
  });

  it('sync converges renames by entryUUID and deactivates disabled entries', async (ctx) => {
    if (!ldapUp) return ctx.skip();
    const id = await makeConn();
    const first = await authed(app).post(`/api/internal/admin/directory/${id}/sync`).send({}).expect(200);
    expect(first.body.stats.provisioned).toBeGreaterThanOrEqual(3);
    const alice = await prisma.user.findUnique({ where: { email: 'alice@test.local' } });
    expect(alice).not.toBeNull();
    // groupMap: engineers → dev-team membership applied.
    const devTeam = await prisma.group.findUnique({ where: { name: 'dev-team' } });
    if (devTeam) {
      const m = await prisma.groupMember.findFirst({ where: { groupId: devTeam.id, userId: alice!.id } });
      expect(m).not.toBeNull();
    }

    // Rename: change alice's mail — entryUUID stays, user converges (no dup).
    ldapModify('dn: uid=alice,ou=users,dc=test,dc=local\nchangetype: modify\nreplace: mail\nmail: alice.anderson@test.local\n');
    await authed(app).post(`/api/internal/admin/directory/${id}/sync`).send({}).expect(200);
    const renamed = await prisma.user.findUnique({ where: { email: 'alice.anderson@test.local' } });
    expect(renamed!.id).toBe(alice!.id); // same row, new login
    expect(await prisma.user.count({ where: { email: { contains: 'alice' } } })).toBe(1);

    // Disable carol via a fake userAccountControl bit → deactivate + revoke.
    ldapModify('dn: uid=carol,ou=users,dc=test,dc=local\nchangetype: modify\nreplace: description\ndescription: 2\n');
    const cfgConn = await prisma.directoryConnection.update({
      where: { id },
      data: { config: { ...CONFIG, attrMap: { disabled: 'description' } } },
    });
    expect(cfgConn).toBeTruthy();
    const third = await authed(app).post(`/api/internal/admin/directory/${id}/sync`).send({}).expect(200);
    const carol = await prisma.user.findUnique({ where: { email: 'carol@test.local' } });
    expect(carol!.active).toBe(false);
    expect(third.body.stats.deactivated).toBeGreaterThanOrEqual(1);
  });

  it('RFC 4515 escaping blocks filter injection (FR-005)', async (ctx) => {
    if (!ldapUp) return ctx.skip();
    // A login crafted as a filter must not escape the userFilter context.
    const evil = '*)(uid=*';
    const escaped = escapeLdapFilter(evil);
    expect(escaped).toBe('\\2A\\29\\28uid\\3D\\2A'); // every metachar is hex-escaped
    await makeConn();
    await plain().post('/api/internal/auth/login')
      .send({ email: evil, password: 'x' }).expect(401);
  });
});

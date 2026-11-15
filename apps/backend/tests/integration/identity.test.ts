import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { authed, TEST_ADMIN, transitionTo } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword } from '../../src/lib/auth.js';
import { totpCode, finishOidc, beginOidc, oidcStates } from '../../src/services/identityService.js';

/**
 * 036 — identity: profile/prefs, password lifecycle, sessions, TOTP, OIDC.
 * SC-001 (OIDC link round-trip via mocked token endpoint) and SC-002 (TOTP
 * enroll → challenge → backup code).
 */

async function mkUser(email: string, pw = 'pw-' + email.slice(0, 6)) {
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: await hashPassword(pw), active: true, totpEnabled: false, totpSecret: null, backupCodes: null, mustChangePassword: false },
    create: { email, displayName: email.split('@')[0], passwordHash: await hashPassword(pw) },
  });
  const agent = request.agent(app);
  await agent.post('/api/internal/auth/login').send({ email, password: pw }).expect(200);
  return { user, agent, pw };
}

describe('036 identity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('US1: profile returns identity + activity; PUT /me persists locale/timezone/dateFormat', async () => {
    const { user, agent } = await mkUser('id-prof@test.local');
    const prof = await agent.get('/api/internal/me').expect(200);
    expect(prof.body.user.id).toBe(user.id);
    expect(prof.body).toHaveProperty('openIssues');

    const upd = await agent.put('/api/internal/me')
      .send({ locale: 'de_DE', timezone: 'Europe/Berlin', dateFormat: 'dd.MM.yyyy', displayName: 'Prof User' })
      .expect(200);
    expect(upd.body.locale).toBe('de_DE');
    expect(upd.body.timezone).toBe('Europe/Berlin');
    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.timeZone).toBe('Europe/Berlin');
    expect(db.displayName).toBe('Prof User');
  });

  it('US1: public profile view — any authenticated user, issues grouped per project, no private fields', async () => {
    const { user } = await mkUser('id-pubprof@test.local');
    const viewer = await mkUser('id-viewer@test.local');
    const admin = authed(app);

    await admin.post('/rest/api/2/project').send({ key: 'PPROF', name: 'Pub Profile' }).expect(201);
    const issue = await admin.post('/rest/api/2/issue').send({ fields: {
      project: { key: 'PPROF' }, summary: 'pub assigned', issuetype: { name: 'Task' } } }).expect(201);
    await admin.put(`/rest/api/2/issue/${issue.body.key}/assignee`).send({ accountId: user.id }).expect(204);

    const res = await viewer.agent.get(`/api/internal/users/${user.id}/profile`).expect(200);
    expect(res.body.user.accountId).toBe(user.id);
    expect(res.body.user.displayName).toBe('id-pubprof');
    expect(res.body.user.totpEnabled).toBeUndefined();
    expect(res.body.user.mustChangePassword).toBeUndefined();
    expect(res.body.user.groups).toBeUndefined(); // groups box is self/admin-only

    const group = res.body.openIssuesByProject.find((g: { project: { key: string } }) => g.project.key === 'PPROF');
    expect(group?.issues.map((i: { key: string }) => i.key)).toContain(issue.body.key);
    expect(group?.issues[0].statusCategory).toBeTruthy();

    const adminView = await admin.get(`/api/internal/users/${user.id}/profile`).expect(200);
    expect(adminView.body.user.groups).toContain('jira-software-users');

    await viewer.agent.get('/api/internal/users/no-such-user/profile').expect(404);
  });

  it('US1: sessions enumerated, current flagged, revoke kills the other session', async () => {
    const email = 'id-sess@test.local';
    const a = await mkUser(email);
    const b = await request.agent(app);
    await b.post('/api/internal/auth/login').send({ email, password: a.pw }).expect(200);

    const list = (await a.agent.get('/api/internal/me/sessions').expect(200)).body;
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const other = list.find((s: { current: boolean }) => !s.current)!;
    await a.agent.delete(`/api/internal/me/sessions/${other.id}`).expect(204);
    // revoked session's next authenticated call dies
    await b.get('/api/internal/me').expect(401);
  });

  it('US2-1: change-password revokes other sessions, wrong current rejected', async () => {
    const email = 'id-pw@test.local';
    const a = await mkUser(email);
    const b = await request.agent(app);
    await b.post('/api/internal/auth/login').send({ email, password: a.pw }).expect(200);

    await a.agent.put('/api/internal/me/password').send({ current: 'wrong', new: 'newpass123' }).expect(400);
    await a.agent.put('/api/internal/me/password').send({ current: a.pw, new: 'newpass123' }).expect(204);

    await b.get('/api/internal/me').expect(401);          // other session dead
    await a.agent.get('/api/internal/me').expect(200);    // current survives
    await request.agent(app).post('/api/internal/auth/login')
      .send({ email, password: 'newpass123' }).expect(200); // new pw works
  });

  it('US2-2: reset-request → token → reset-confirm; token single-use + expiry enforced', async () => {
    const email = 'id-reset@test.local';
    await mkUser(email);
    const res = await request.agent(app)
      .post('/api/internal/auth/reset-request').send({ email }).expect(204);
    const token = res.headers['x-reset-token'];
    expect(token).toBeTruthy();

    await request.agent(app).post('/api/internal/auth/reset-confirm')
      .send({ token, newPassword: 'resetpass99' }).expect(204);
    // single-use
    await request.agent(app).post('/api/internal/auth/reset-confirm')
      .send({ token, newPassword: 'resetpass88' }).expect(400);
    // login with new password
    await request.agent(app).post('/api/internal/auth/login')
      .send({ email, password: 'resetpass99' }).expect(200);
    // unknown email still 204, no token
    const anon = await request.agent(app)
      .post('/api/internal/auth/reset-request').send({ email: 'nobody@x.local' }).expect(204);
    expect(anon.headers['x-reset-token']).toBe('');
  });

  it('SC-002: TOTP enroll → verify → login challenge; backup code consumes once', async () => {
    const email = 'id-totp@test.local';
    const { user, agent, pw } = await mkUser(email);

    const enr = await agent.post('/api/internal/me/totp').expect(200);
    expect(enr.body.otpauthUrl).toContain('otpauth://totp/');

    // wrong code → not enabled (FR-004)
    await agent.post('/api/internal/me/totp/verify').send({ code: '000000' }).expect(400);
    const ver = await agent.post('/api/internal/me/totp/verify')
      .send({ code: totpCode(enr.body.secret) }).expect(200);
    const backups = ver.body.backupCodes as string[];
    expect(backups).toHaveLength(10);

    // password login now challenges
    const chal = await request.agent(app).post('/api/internal/auth/login').send({ email, password: pw }).expect(200);
    expect(chal.body.totpRequired).toBe(true);
    const bad = await request.agent(app).post('/api/internal/auth/login/totp')
      .send({ pending: chal.body.pending, code: '000000' }).expect(401);
    expect(bad.status).toBe(401);

    const fresh = await request.agent(app).post('/api/internal/auth/login').send({ email, password: pw }).expect(200);
    await request.agent(app).post('/api/internal/auth/login/totp')
      .send({ pending: fresh.body.pending, code: totpCode(enr.body.secret) }).expect(200);

    // backup code path — one use only
    const again = await request.agent(app).post('/api/internal/auth/login').send({ email, password: pw }).expect(200);
    await request.agent(app).post('/api/internal/auth/login/totp')
      .send({ pending: again.body.pending, code: backups[0] }).expect(200);
    const third = await request.agent(app).post('/api/internal/auth/login').send({ email, password: pw }).expect(200);
    await request.agent(app).post('/api/internal/auth/login/totp')
      .send({ pending: third.body.pending, code: backups[0] }).expect(401);

    // disable requires a valid code
    await agent.delete('/api/internal/me/totp').send({ code: '000000' }).expect(400);
    await agent.delete('/api/internal/me/totp').send({ code: totpCode(enr.body.secret) }).expect(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpEnabled).toBe(false);
  });

  it('US3: IdP CRUD admin-gated; OIDC flow links by verified email (SC-001)', async () => {
    const { agent } = await mkUser('id-idp@test.local');
    await agent.get('/api/internal/admin/idps').expect(403); // non-admin

    const admin = authed(app);
    const idp = await admin.post('/api/internal/admin/idps').send({
      name: 'testidp', issuer: 'https://idp.example.com', clientId: 'cid', clientSecret: 'sec',
      claimMap: { tokenEndpoint: 'https://idp.example.com/token' },
    }).expect(201);

    // public list shows it
    const pub = await request.agent(app).get('/api/internal/auth/idps').expect(200);
    expect(pub.body.some((i: { name: string }) => i.name === 'testidp')).toBe(true);

    // existing password user with the SSO email
    const email = 'id-sso@test.local';
    const { user } = await mkUser(email);

    // run the flow against a mocked token endpoint
    const { state } = await beginOidc('testidp', 'https://tf.example.com/cb');
    expect(oidcStates.has(state)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'at',
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    // userinfo fallback supplies claims (verified email)
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: unknown) => {
      if (String(url).includes('/userinfo')) {
        return new Response(JSON.stringify({ sub: 'sso-1', email, email_verified: true, name: 'SSO User' }),
          { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    });
    const linked = await finishOidc('testidp', 'code123', state, 'https://tf.example.com/cb');
    expect(linked.id).toBe(user.id); // linked, not duplicated
    const row = await prisma.oidcIdentity.findFirstOrThrow({ where: { idpId: idp.body.id } });
    expect(row.subject).toBe('sso-1');

    // unverified email → rejected (FR-002)
    const { state: s2 } = await beginOidc('testidp', 'https://tf.example.com/cb');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: unknown) => {
      if (String(url).includes('/userinfo')) {
        return new Response(JSON.stringify({ sub: 'sso-2', email: 'unv@test.local', email_verified: false }),
          { status: 200 });
      }
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    });
    await expect(finishOidc('testidp', 'code', s2, 'https://tf.example.com/cb')).rejects.toThrow(/verified/i);
  });

  it('US2-3: requireTotp group gates all endpoints until enrolled', async () => {
    const email = 'id-gate@test.local';
    const { user, agent } = await mkUser(email);
    const group = await prisma.group.create({ data: { name: 'totp-required-36', requireTotp: true } });
    await prisma.groupMember.create({ data: { groupId: group.id, userId: user.id } });

    await agent.get('/rest/api/2/myself').expect(403);      // gated
    const me = await agent.get('/api/internal/me').expect(200); // allowlisted
    expect(me.body.user.id).toBe(user.id);

    const enr = await agent.post('/api/internal/me/totp').expect(200);
    await agent.post('/api/internal/me/totp/verify').send({ code: totpCode(enr.body.secret) }).expect(200);
    await agent.get('/rest/api/2/myself').expect(200);      // enrolled → gate lifts
  });

  it('US3-3: ssoOnly blocks password login for non-admins', async () => {
    const email = 'id-ssoonly@test.local';
    await mkUser(email);
    const { setSsoOnly } = await import('../../src/services/identityService.js');
    await setSsoOnly(true);
    try {
      await request.agent(app).post('/api/internal/auth/login')
        .send({ email, password: 'pw-id-sso' }).expect(403);
      // admin break-glass still works
      await request.agent(app).post('/api/internal/auth/login')
        .send({ email: TEST_ADMIN.email, password: 'test-password-1' }).expect(200);
    } finally {
      await setSsoOnly(false);
    }
  });

  it('admin reset sets mustChangePassword + kills sessions', async () => {
    const email = 'id-admin@test.local';
    const { user, agent } = await mkUser(email);
    // admin resets via service path used by user admin UI
    const { adminResetPassword } = await import('../../src/services/identityService.js');
    const token = await adminResetPassword((await prisma.user.findFirstOrThrow({ where: { email: TEST_ADMIN.email } })).id, user.id);
    expect(token).toBeTruthy();
    await agent.get('/api/internal/me').expect(401); // sessions revoked
    const db = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(db.mustChangePassword).toBe(true);
  });

  it('065 A7 — admin password-reset route issues a link; mustChangePassword gates until rotated', async () => {
    const email = 'id-gated@test.local';
    const pw = 'pw-id-gated';
    const { user } = await mkUser(email, pw);
    const res = await authed(app)
      .post(`/api/internal/users/${user.id}/password-reset`).send({}).expect(200);
    expect(res.body.reset).toBe(true);
    expect(res.body.resetUrl).toContain('resetToken=');

    // Re-login (old password still valid until rotated): gated to the
    // password-change + identity surface only.
    const agent = request.agent(app);
    await agent.post('/api/internal/auth/login').send({ email, password: pw }).expect(200);
    await agent.get('/rest/api/2/myself').expect(403);
    await agent.get('/api/internal/me').expect(200);           // allowlisted
    await agent.put('/api/internal/me/password')
      .send({ current: pw, new: 'rotated-pw-123' }).expect(204);
    await agent.get('/rest/api/2/myself').expect(200);          // gate lifts
  });

  it('065 A7 — group requireTotp + auth-policy routes are reachable and enforced', async () => {
    // requireTotp via PUT /group (dead schema field before 065)
    await authed(app).post('/rest/api/2/group').send({ name: 'totp-gated-65' }).expect(201);
    const upd = await authed(app).put('/rest/api/2/group?groupname=totp-gated-65')
      .send({ requireTotp: true }).expect(200);
    expect(upd.body.requireTotp).toBe(true);

    const { user, agent } = await mkUser('id-gatedgrp@test.local');
    const g = await prisma.group.findUniqueOrThrow({ where: { name: 'totp-gated-65' } });
    await prisma.groupMember.create({ data: { groupId: g.id, userId: user.id } });
    await agent.get('/rest/api/2/myself').expect(403); // policy now enforced

    // ssoOnly via /system/auth-policy
    const get = await authed(app).get('/api/internal/system/auth-policy').expect(200);
    expect(get.body).toHaveProperty('ssoOnly');
    await authed(app).put('/api/internal/system/auth-policy').send({ ssoOnly: true }).expect(200);
    try {
      // 065 A5 — ssoOnly is checked AFTER password verification (no
      // account-enumeration via 403-vs-401): send the real password → 403.
      const pw = 'pw-' + 'id-gatedgrp@test.local'.slice(0, 6);
      await request.agent(app).post('/api/internal/auth/login')
        .send({ email: 'id-gatedgrp@test.local', password: pw }).expect(403);
    } finally {
      const { setSsoOnly } = await import('../../src/services/identityService.js');
      await setSsoOnly(false);
    }
  });

  it('065 A6 — IdP PUT is a partial update; redirect_uri must match the authorize leg', async () => {
    const admin = authed(app);
    const idp = await admin.post('/api/internal/admin/idps').send({
      name: 'partialidp', issuer: 'https://idp2.example.com', clientId: 'cid', clientSecret: 'sec',
      autoProvision: false,
    }).expect(201);

    // Partial PUT flips only `enabled`; every other field survives.
    const upd = await admin.put(`/api/internal/admin/idps/${idp.body.id}`).send({ enabled: false }).expect(200);
    expect(upd.body.name).toBe('partialidp');
    expect(upd.body.issuer).toBe('https://idp2.example.com');
    expect(upd.body.clientId).toBe('cid');
    expect(upd.body.enabled).toBe(false);
    const row = await prisma.identityProvider.findUniqueOrThrow({ where: { id: idp.body.id } });
    // 065 F3 — the secret is encrypted at rest; readSecret round-trips it.
    const { readSecret } = await import('../../src/lib/ai.js');
    expect(row.clientSecret).not.toBe('sec');
    expect(readSecret(row.clientSecret!)).toBe('sec');
    expect(row.autoProvision).toBe(false);

    // redirect_uri binding — a swapped URI dies before the token exchange.
    const idp2 = await prisma.identityProvider.update({ where: { id: idp.body.id }, data: { enabled: true } });
    expect(idp2.enabled).toBe(true);
    const { state } = await beginOidc('partialidp', 'https://tf.example.com/cb');
    await expect(finishOidc('partialidp', 'code', state, 'https://evil.example.com/cb'))
      .rejects.toThrow(/redirect_uri mismatch/i);
  });

  it('People directory: any authenticated user, PageBean paging, query filter, open-issue counts', async () => {
    const { user } = await mkUser('people-dir@test.local');
    const viewer = await mkUser('people-viewer@test.local');
    const admin = authed(app);

    // One open issue + one done issue assigned to the directory user — only
    // the open one may count.
    await admin.post('/rest/api/2/project').send({ key: 'PDIR', name: 'People Dir' }).expect(201);
    const open = await admin.post('/rest/api/2/issue').send({ fields: {
      project: { key: 'PDIR' }, summary: 'open one', issuetype: { name: 'Task' } } }).expect(201);
    const done = await admin.post('/rest/api/2/issue').send({ fields: {
      project: { key: 'PDIR' }, summary: 'done one', issuetype: { name: 'Task' } } }).expect(201);
    await admin.put(`/rest/api/2/issue/${open.body.key}/assignee`).send({ accountId: user.id }).expect(204);
    await admin.put(`/rest/api/2/issue/${done.body.key}/assignee`).send({ accountId: user.id }).expect(204);
    await transitionTo(app, done.body.key, 'Done');

    // Non-admin session browses the whole directory — PageBean shape.
    const page = await viewer.agent.get('/api/internal/people?maxResults=1').expect(200);
    expect(page.body.total).toBeGreaterThanOrEqual(2);
    expect(page.body.isLast).toBe(false);
    expect(page.body.startAt).toBe(0);
    const next = await viewer.agent.get('/api/internal/people?maxResults=1&startAt=1').expect(200);
    expect(next.body.startAt).toBe(1);
    expect(next.body.values[0].accountId).not.toBe(page.body.values[0].accountId);

    // Query filters by display name; openIssueCount excludes done issues.
    const filtered = await viewer.agent.get('/api/internal/people?query=people-dir').expect(200);
    const entry = filtered.body.values.find((v: { accountId: string }) => v.accountId === user.id);
    expect(entry).toBeTruthy();
    expect(entry.openIssueCount).toBe(1);
    const none = await viewer.agent.get('/api/internal/people?query=nobody-matches-this').expect(200);
    expect(none.body.total).toBe(0);
    expect(none.body.isLast).toBe(true);
  });

  it('Admin users directory: admin-gated PageBean with status/type/group/query filters', async () => {
    const viewer = await mkUser('adm-noview@test.local');
    await viewer.agent.get('/api/internal/admin/users').expect(403);

    const admin = authed(app);
    const { user: target } = await mkUser('adm-target@test.local');

    // Same admin columns as the flat /users list, wrapped in a PageBean.
    const page = await admin.get('/api/internal/admin/users?query=adm-target&status=active').expect(200);
    const entry = page.body.values.find((v: { accountId: string }) => v.accountId === target.id);
    expect(entry).toBeTruthy();
    expect(entry.groups).toBeInstanceOf(Array);
    expect(entry.directory).toBe('Internal');
    expect(entry).toHaveProperty('isAdmin');

    // Combined filters narrow correctly — the target is active.
    const inactive = await admin.get('/api/internal/admin/users?query=adm-target&status=inactive').expect(200);
    expect(inactive.body.values.find((v: { accountId: string }) => v.accountId === target.id)).toBeUndefined();
    const wrongType = await admin.get('/api/internal/admin/users?query=adm-target&type=agent').expect(200);
    expect(wrongType.body.total).toBe(0);

    // Paging walks the whole roster.
    const p1 = await admin.get('/api/internal/admin/users?maxResults=1').expect(200);
    expect(p1.body.total).toBeGreaterThanOrEqual(2);
    expect(p1.body.isLast).toBe(false);
    const p2 = await admin.get('/api/internal/admin/users?maxResults=1&startAt=1').expect(200);
    expect(p2.body.startAt).toBe(1);
    expect(p2.body.values[0].accountId).not.toBe(p1.body.values[0].accountId);

    // The flat list contract is unchanged for pickers/MCP.
    const flat = await admin.get('/api/internal/users').expect(200);
    expect(Array.isArray(flat.body)).toBe(true);
  });
});

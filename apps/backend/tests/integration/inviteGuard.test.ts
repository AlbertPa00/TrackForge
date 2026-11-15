// Sprint 061 US2 — invite lifecycle hardening.
// re-invite is restricted to pending-invite accounts (User.invitedAt), and
// invite-accept only activates a pending invitee — a password-reset token
// presented to /invite/:token can no longer re-activate a deactivated account.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { issueResetToken } from '../../src/services/identityService.js';
import { resetMailAdapter } from '../../src/services/mailService.js';

describe('invite lifecycle guard (061 US2)', () => {
  beforeEach(async () => {
    await ensureTestAuth();
    resetMailAdapter();
  });

  it('invite → re-invite → accept activates and clears the pending marker', async () => {
    const invited = await authed(app).post('/api/internal/users/invite')
      .send({ email: 'inv@ig.test' }).expect(201);
    expect(invited.body.active).toBe(false);
    expect(invited.body.inviteUrl).toContain('/invite/');
    const token = invited.headers['x-invite-token'];
    expect(token).toBeTruthy();
    const userId = invited.body.accountId;
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).invitedAt).not.toBeNull();

    // pending invite → re-invite allowed and refreshes the marker
    const re = await authed(app).post(`/api/internal/users/${userId}/invite`).expect(200);
    expect(re.body.inviteUrl).toContain('/invite/');

    await request(app).post('/api/internal/auth/invite-accept')
      .send({ token, newPassword: 'longenoughpassword' }).expect(204);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.active).toBe(true);
    expect(u.invitedAt).toBeNull();
  });

  it('re-invite is refused for a deactivated real account', async () => {
    const created = await authed(app).post('/api/internal/users')
      .send({ email: 'real@ig.test', displayName: 'Real', password: 'longenoughpassword' }).expect(201);
    await authed(app).patch(`/api/internal/users/${created.body.accountId}`)
      .send({ active: false }).expect(200);
    const r = await authed(app).post(`/api/internal/users/${created.body.accountId}/invite`).expect(400);
    expect(r.body.errorMessages[0]).toContain('pending invite');
  });

  it('invite-accept with a reset token cannot re-activate a deactivated user', async () => {
    const created = await authed(app).post('/api/internal/users')
      .send({ email: 'deact@ig.test', displayName: 'Deact', password: 'longenoughpassword' }).expect(201);
    await authed(app).patch(`/api/internal/users/${created.body.accountId}`)
      .send({ active: false }).expect(200);
    const token = await issueResetToken(created.body.accountId);
    await request(app).post('/api/internal/auth/invite-accept')
      .send({ token, newPassword: 'anotherpassword1' }).expect(400);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: created.body.accountId } });
    expect(u.active).toBe(false);
  });

  it('accepted invitee cannot be re-invited after deactivation (marker cleared)', async () => {
    const invited = await authed(app).post('/api/internal/users/invite')
      .send({ email: 'acc@ig.test' }).expect(201);
    await request(app).post('/api/internal/auth/invite-accept')
      .send({ token: invited.headers['x-invite-token'], newPassword: 'longenoughpassword' }).expect(204);
    // active → refused
    await authed(app).post(`/api/internal/users/${invited.body.accountId}/invite`).expect(400);
    // deactivated → invitedAt was cleared on accept → still refused
    await authed(app).patch(`/api/internal/users/${invited.body.accountId}`)
      .send({ active: false }).expect(200);
    await authed(app).post(`/api/internal/users/${invited.body.accountId}/invite`).expect(400);
  });
});

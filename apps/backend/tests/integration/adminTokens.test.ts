// Sprint 061 US5 — GET /admin/tokens aggregate: every user's PAT with owner
// inline, one request (the page used to fetch the user list + N per-user calls).
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth, TEST_ADMIN } from '../request.js';
import { generateToken } from '../../src/lib/auth.js';

describe('admin tokens aggregate (061 US5)', () => {
  beforeEach(ensureTestAuth);

  it('returns tokens joined to their owner in a single response', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: TEST_ADMIN.email } });
    const { prefix, hash } = generateToken();
    await prisma.apiToken.create({
      data: { userId: owner.id, name: 'agg-token', prefix, hash, scopes: ['read'], projectKeys: [] },
    });

    const r = await authed(app).get('/api/internal/admin/tokens').expect(200);
    const row = (r.body as { id: string; name: string; owner: { accountId: string; displayName: string; emailAddress: string; active: boolean } }[])
      .find((t) => t.name === 'agg-token');
    expect(row).toBeTruthy();
    expect(row!.owner.accountId).toBe(owner.id);
    expect(row!.owner.displayName).toBe(TEST_ADMIN.displayName);
    expect(row!.owner.emailAddress).toBe(TEST_ADMIN.email);
    expect(row!.owner.active).toBe(true);
  });
});

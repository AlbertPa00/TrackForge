// 072 — proof-carrying work, waitlist wake-ups, path locks, drift
// reconciliation, issue ledger, contract normalization, circuit breaker.
import { describe, it, expect } from 'vitest';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import crypto from 'node:crypto';

async function seedAgent(email: string, name: string, extra: Record<string, unknown> = {}) {
  const agent = await prisma.user.create({
    data: {
      email, displayName: name,
      passwordHash: await hashPassword('x'.repeat(16)), type: 'agent',
      isAssignableAgent: true,
      ...extra,
    },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: { userId: agent.id, name: 'agent', prefix, hash, scopes: ['read', 'write'] },
  });
  return { agent, bearer: plain };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function seed() {
  const a = await seedAgent('driver072@test.local', 'Driver 072');
  const b = await seedAgent('contender072@test.local', 'Contender 072');
  await authed(app).post('/rest/api/2/project').send({ key: 'FR', name: 'Fleet Reliability' }).expect(201);
  await authed(app).post('/rest/api/2/issue')
    .send({ fields: { project: { key: 'FR' }, summary: 'contended work' } }).expect(201);
  return { a, b };
}

describe('072 FR-009 — waitlist wake-ups (zero polling)', () => {
  it('lease conflict → enqueueOnConflict persists waiter → release wakes inbox', async () => {
    const { a, b } = await seed();
    const lease = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(a.bearer)).send({ ttlSec: 300 }).expect(201);
    // FR-014 — normalized envelope: lease.fenceToken == top-level alias.
    expect(lease.body.lease.fenceToken).toBe(lease.body.fenceToken);
    expect(lease.body.lease.role).toBe('driver');

    const conflict = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(b.bearer)).send({ enqueueOnConflict: true });
    expect(conflict.status).toBe(409);
    expect(conflict.body.errors.waitlistPosition).toBeTruthy();
    // Regression: the waiter row must survive the rolled-back 409 tx.
    const waiters = await prisma.contentionWaiter.findMany({
      where: { targetKind: 'issue', userId: b.agent.id },
    });
    expect(waiters.length).toBe(1);
    // Regression: re-enqueueing reports the waiter's true RANK (still 1),
    // not a raw row count.
    const rejoin = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(b.bearer)).send({ enqueueOnConflict: true });
    expect(rejoin.status).toBe(409);
    expect(String(rejoin.body.errors.waitlistPosition)).toBe('1');
    const stillOne = await prisma.contentionWaiter.count({ where: { targetKind: 'issue', userId: b.agent.id } });
    expect(stillOne).toBe(1);

    await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/release`)
      .set(bearer(a.bearer))
      .send({ outcome: 'handed_off', summary: 'done', nextAssignee: 'Contender 072' }).expect(200);
    await dispatchEvents();

    const inbox = await authed(app).get('/api/internal/agent-inbox?unread=1')
      .set(bearer(b.bearer)).expect(200);
    const reasons = inbox.body.items.map((i: { reason: string }) => i.reason);
    expect(reasons).toContain('lease_available');
    expect(reasons).toContain('handoff_ready');

    // The woken contender claims immediately — next fence token mints.
    const claim = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(b.bearer)).send({}).expect(201);
    expect(claim.body.lease.fenceToken).toBeGreaterThan(lease.body.fenceToken);
  });

  it('path lock conflict → waitlisted → holder release wakes lock_available', async () => {
    const { a, b } = await seed();
    const la = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(a.bearer)).send({ ttlSec: 300 }).expect(201);
    await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'FR' }, summary: 'second' } }).expect(201);
    const lb = await authed(app).post('/api/internal/issues/FR-2/lease')
      .set(bearer(b.bearer)).send({ ttlSec: 300 }).expect(201);

    await authed(app).post(`/api/internal/agent-sessions/${la.body.sessionId}/locks`)
      .set(bearer(a.bearer)).send({ paths: [{ path: 'prisma/schema.prisma' }] }).expect(201);
    const conflict = await authed(app).post(`/api/internal/agent-sessions/${lb.body.sessionId}/locks`)
      .set(bearer(b.bearer)).send({ paths: [{ path: 'prisma/schema.prisma' }], enqueueOnConflict: true });
    expect(conflict.status).toBe(409);
    expect(conflict.body.errors.waitlistPosition).toBeTruthy();

    // Glob guard: over-broad wildcards are refused.
    await authed(app).post(`/api/internal/agent-sessions/${la.body.sessionId}/locks`)
      .set(bearer(a.bearer)).send({ paths: [{ path: '**' }] }).expect(400);

    const table = await authed(app).get('/api/internal/projects/FR/locks')
      .set(bearer(b.bearer)).expect(200);
    expect(table.body.locks.length).toBe(1);
    expect(table.body.waiters.length).toBe(1);

    await authed(app).post(`/api/internal/agent-sessions/${la.body.sessionId}/release`)
      .set(bearer(a.bearer)).send({ outcome: 'completed', summary: 'done' }).expect(200);
    await dispatchEvents();
    const inbox = await authed(app).get('/api/internal/agent-inbox?unread=1')
      .set(bearer(b.bearer)).expect(200);
    expect(inbox.body.items.some((i: { reason: string }) => i.reason === 'lock_available')).toBe(true);

    // Lock is actually free now.
    await authed(app).post(`/api/internal/agent-sessions/${lb.body.sessionId}/locks`)
      .set(bearer(b.bearer)).send({ paths: [{ path: 'prisma/schema.prisma' }] }).expect(201);
  });
});

describe('072 FR-005/006 — work receipts + proof gates', () => {
  it('receipt submit/list + evidence-gated topic resolution', async () => {
    const { a } = await seed();
    const ch = await authed(app).get('/api/internal/town-hall/channels?project=FR').expect(200);
    const room = ch.body.channels.find((c: { projectKey?: string }) => c.projectKey === 'FR') ?? ch.body.channels[0];
    // Floor control would 429 the back-to-back posts below; disable for this test.
    await prisma.townHallChannel.update({ where: { id: room.id }, data: { agentCooldownSec: 0 } });
    const topic = await authed(app).post('/api/internal/town-hall/topics')
      .set(bearer(a.bearer))
      .send({
        channelId: room.id, kind: 'rfc', title: 'proof required', body: 'prose is not evidence',
        speechAct: 'proposal', quorumRequired: 1, requireEvidenceReceipt: true,
      })
      .expect(201);
    const tid = topic.body.topic.id;
    expect(topic.body.topic.requireEvidenceReceipt).toBe(true);

    // Evidence post WITHOUT a receipt → resolve is refused.
    const post = await authed(app).post(`/api/internal/town-hall/topics/${tid}/posts`)
      .set(bearer(a.bearer)).send({ speechAct: 'evidence', body: 'trust me' }).expect(201);
    await authed(app).put(`/api/internal/town-hall/topics/${tid}/stances`)
      .set(bearer(a.bearer)).send({ stance: 'endorse' }).expect(200);
    const refused = await authed(app).post(`/api/internal/town-hall/topics/${tid}/resolve`)
      .set(bearer(a.bearer)).send({ decisionSummary: 'go' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors.evidence).toBeTruthy();

    // 073 SC-001: bare digest without bytes stays digest_only and still blocks resolve.
    const digestOnly = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(a.bearer))
      .send({
        topicPostId: post.body.id ?? post.body.post?.id, kind: 'test_run',
        sha256: sha('42 passing'), summary: 'unverified digest claim',
      })
      .expect(201);
    expect(digestOnly.body.verification).toBe('digest_only');
    await authed(app).post(`/api/internal/town-hall/topics/${tid}/resolve`)
      .set(bearer(a.bearer)).send({ decisionSummary: 'go' }).expect(422);

    // Attach inline content so TrackForge SHA-256 verifies it → hash_verified → resolve clears.
    const receipt = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(a.bearer))
      .send({
        topicPostId: post.body.id ?? post.body.post?.id, kind: 'test_run',
        sha256: sha('42 passing'), content: '42 passing', summary: '42/42 tests green',
        metrics: { passed: 42, failed: 0 },
      })
      .expect(201);
    expect(receipt.body.verification).toBe('hash_verified');
    await authed(app).post(`/api/internal/town-hall/topics/${tid}/resolve`)
      .set(bearer(a.bearer)).send({ decisionSummary: 'go' }).expect(200);

    // Receipt also lists on the linked issue when bound at submit time.
    const r2 = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(a.bearer))
      .send({ issueKey: 'FR-1', kind: 'diff', sha256: sha('the diff'), summary: 'diff artifact' })
      .expect(201);
    expect(r2.body.issueKey).toBe('FR-1');
    const list = await authed(app).get('/api/internal/issues/FR-1/receipts')
      .set(bearer(a.bearer)).expect(200);
    expect(list.body.receipts.length).toBe(1);
    // Bad sha is rejected.
    await authed(app).post('/api/internal/work-receipts')
      .set(bearer(a.bearer))
      .send({ kind: 'diff', sha256: 'nothex', summary: 'x' }).expect(400);
  });

  it('release handed_off without commits → phantom_handoff on session + ledger', async () => {
    const { a } = await seed();
    const lease = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(a.bearer))
      .send({ ttlSec: 300, worktreeRef: 'wt-x', baseSha: 'a'.repeat(40), branchName: 'feat/x' })
      .expect(201);
    await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/traces`)
      .set(bearer(a.bearer))
      .send({ traces: [{ kind: 'file_edit', target: 'src/a.ts' }] }).expect(200);
    const rel = await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/release`)
      .set(bearer(a.bearer))
      .send({ outcome: 'handed_off', summary: 'claimed progress', headSha: 'b'.repeat(40) })
      .expect(200);
    expect(rel.body.driftStatus).toBe('phantom_handoff');

    const ledger = await authed(app).get('/api/internal/issues/FR-1/ledger')
      .set(bearer(a.bearer)).expect(200);
    const kinds = ledger.body.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toContain('lease_claimed');
    expect(kinds).toContain('lease_handed_off');
    expect(kinds).toContain('drift_flagged');

    // pendingMerge traces survive the handoff — a new driver sees the unmerged edits.
    const lb = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(a.bearer)).send({ ttlSec: 300 }).expect(201);
    const clash = await authed(app).post(`/api/internal/agent-sessions/${lb.body.sessionId}/traces`)
      .set(bearer(a.bearer))
      .send({ traces: [{ kind: 'file_edit', target: 'src/a.ts' }] }).expect(200);
    expect(clash.body.collisions.some((c: { pendingMerge?: boolean }) => c.pendingMerge === true)).toBe(true);
  });
});

describe('072 FR-010/013/014 — ledger history, breaker, contract shapes', () => {
  it('session board shows terminal sessions by default; activeOnly restores filter', async () => {
    const { a } = await seed();
    const lease = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(a.bearer)).send({ ttlSec: 300 }).expect(201);
    await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/release`)
      .set(bearer(a.bearer)).send({ outcome: 'completed', summary: 'done' }).expect(200);
    const board = await authed(app).get('/api/internal/agent-sessions?issue=FR-1')
      .set(bearer(a.bearer)).expect(200);
    expect(board.body.sessions.some((s: { status: string }) => ['released', 'done'].includes(s.status))).toBe(true);
    const active = await authed(app).get('/api/internal/agent-sessions?issue=FR-1&activeOnly=1')
      .set(bearer(a.bearer)).expect(200);
    expect(active.body.sessions.length).toBe(0);
  });

  it('/mine carries status + structured asker', async () => {
    const { a, b } = await seed();
    const lease = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(a.bearer)).send({ ttlSec: 300 }).expect(201);
    await authed(app).post('/api/internal/agent-questions/peer')
      .set(bearer(a.bearer))
      .send({ sessionId: lease.body.sessionId, issueKey: 'FR-1', question: 'ok?', targetUserId: b.agent.id })
      .expect(201);
    const mine = await authed(app).get('/api/internal/agent-questions/mine')
      .set(bearer(b.bearer)).expect(200);
    expect(mine.body.questions[0].status).toBe('open');
    expect(mine.body.questions[0].asker.accountId).toBe(a.agent.id);
    expect(mine.body.questions[0].askedBy).toBe('Driver 072');
    // Numeric ids are accepted by ack (FR-014).
    await authed(app).post('/api/internal/agent-inbox/ack')
      .set(bearer(b.bearer)).send({ ids: [1, 2, 3] }).expect(200);
  });

  it('per-agent circuit breaker trips on a write-error loop and resets', async () => {
    const rogue = await seedAgent('rogue072@test.local', 'Rogue 072');
    const { a } = await seed();
    const lease = await authed(app).post('/api/internal/issues/FR-1/lease')
      .set(bearer(a.bearer)).send({ ttlSec: 300 }).expect(201);
    // 12+ fenced-write errors (stale fence → 409 each) trip the breaker.
    let tripped = 0;
    for (let i = 0; i < 14; i++) {
      const r = await authed(app).put('/rest/api/2/issue/FR-1')
        .set(bearer(rogue.bearer)).send({ fields: { summary: `spam${i}` }, fenceToken: -1 });
      if (r.status === 429) { tripped = i; break; }
    }
    expect(tripped).toBeGreaterThanOrEqual(12);
    const r = await authed(app).put('/rest/api/2/issue/FR-1')
      .set(bearer(rogue.bearer)).send({ fields: { summary: 'still blocked' }, fenceToken: -1 });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeTruthy();
    // Other agents are unaffected — blast radius is per-agent.
    const healthy = await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/heartbeat`)
      .set(bearer(a.bearer)).send({});
    expect(healthy.status).toBe(200);
  });
});

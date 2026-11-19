// 071 — fenced leases + optimistic versions, town hall deliberation, durable
// inboxes, peer consults, stigmergic traces and the fleet brake.
import { describe, it, expect } from 'vitest';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import { sweepExpiredLeases } from '../../src/services/agentSessionService.js';

async function seedAgent(email: string, name: string) {
  const agent = await prisma.user.create({
    data: {
      email, displayName: name,
      passwordHash: await hashPassword('x'.repeat(16)), type: 'agent',
      isAssignableAgent: true,
    },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: { userId: agent.id, name: 'agent', prefix, hash, scopes: ['read', 'write'] },
  });
  return { agent, bearer: plain };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function seed() {
  const a = await seedAgent('driver@test.local', 'Driver Bot');
  const b = await seedAgent('reviewer@test.local', 'Reviewer Bot');
  await authed(app).post('/rest/api/2/project').send({ key: 'TH', name: 'Town Hall' }).expect(201);
  await authed(app).post('/rest/api/2/issue')
    .send({ fields: { project: { key: 'TH' }, summary: 'leased work' } }).expect(201);
  return { a, b };
}

describe('071 US4 — fenced leases + optimistic version', () => {
  it('lease → fence-gated writes → break → zombie kill', async () => {
    const { a, b } = await seed();

    const lease = await authed(app).post('/api/internal/issues/TH-1/lease')
      .set(bearer(a.bearer)).send({}).expect(201);
    expect(lease.body.fenceToken).toBeGreaterThanOrEqual(1);
    expect(lease.body.leaseExpiresAt).toBeTruthy();
    const fence = lease.body.fenceToken;
    const sid = lease.body.sessionId;

    // Another agent cannot lease the same issue while the driver is live.
    await authed(app).post('/api/internal/issues/TH-1/lease')
      .set(bearer(b.bearer)).send({}).expect(409);

    // The other agent cannot write WITHOUT a token either — the driver owns the issue.
    await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(b.bearer)).send({ fields: { summary: 'hijack' } }).expect(409);

    // Stale fence token → 409.
    await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(a.bearer)).send({ fields: { summary: 'bad fence' }, fenceToken: -1 }).expect(409);

    // Stale expectedVersion → 409 (optimistic concurrency).
    const v = await authed(app).get('/rest/api/2/issue/TH-1').expect(200);
    const version = v.body.fields.tf_version;
    await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(a.bearer)).send({ fields: { summary: 'stale' }, expectedVersion: -1 }).expect(409);

    // Correct fence + version → write lands, version bumps.
    await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(a.bearer))
      .send({ fields: { summary: 'driver write' }, fenceToken: fence, expectedVersion: version }).expect(204);
    const after = await authed(app).get('/rest/api/2/issue/TH-1').expect(200);
    expect(after.body.fields.summary).toBe('driver write');
    expect(after.body.fields.tf_version).toBe(version + 1);

    // Heartbeat renews and reports pause/inbox signals.
    const hb = await authed(app).post(`/api/internal/agent-sessions/${sid}/heartbeat`)
      .set(bearer(a.bearer)).send({}).expect(200);
    expect(hb.body.fenceToken).toBe(fence);
    expect(hb.body.paused).toBe(false);

    // Human break: the zombie session dies and its heartbeat is refused.
    await authed(app).post('/api/internal/issues/TH-1/lease/break').send({}).expect(200);
    const zombie = await authed(app).post(`/api/internal/agent-sessions/${sid}/heartbeat`)
      .set(bearer(a.bearer)).send({});
    expect([404, 409]).toContain(zombie.status);
    const zombieWrite = await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(a.bearer)).send({ fields: { summary: 'zombie' }, fenceToken: fence });
    expect(zombieWrite.status).toBe(409);

    // The reviewer can now lease it.
    await authed(app).post('/api/internal/issues/TH-1/lease')
      .set(bearer(b.bearer)).send({}).expect(201);
  });

  it('expired leases are swept → the driver goes stale', async () => {
    const { a } = await seed();
    const lease = await authed(app).post('/api/internal/issues/TH-1/lease')
      .set(bearer(a.bearer)).send({}).expect(201);
    await prisma.agentSession.update({
      where: { id: lease.body.sessionId },
      data: { leaseExpiresAt: new Date(Date.now() - 60_000), heartbeatAt: new Date(Date.now() - 60_000) },
    });
    expect(await sweepExpiredLeases()).toBeGreaterThanOrEqual(1);
    const s = await prisma.agentSession.findUniqueOrThrow({ where: { id: lease.body.sessionId } });
    expect(['expired', 'broken']).toContain(s.status);
    // …and the old fence can no longer write.
    await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(a.bearer)).send({ fields: { summary: 'zombie' }, fenceToken: lease.body.fenceToken }).expect(409);
  });

  it('fleet pause → agent writes 423 while heartbeats stay open', async () => {
    const { a } = await seed();
    const lease = await authed(app).post('/api/internal/issues/TH-1/lease')
      .set(bearer(a.bearer)).send({}).expect(201);

    await authed(app).put('/api/internal/projects/TH/pause')
      .send({ paused: true, reason: 'eval brake' }).expect(200);
    const st = await authed(app).get('/api/internal/fleet/pause?project=TH').expect(200);
    expect(st.body.paused).toBe(true);

    // Liveness keeps working; mutations are frozen.
    await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/heartbeat`)
      .set(bearer(a.bearer)).send({}).expect(200);
    const frozen = await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(a.bearer)).send({ fields: { summary: 'while paused' }, fenceToken: lease.body.fenceToken });
    expect(frozen.status).toBe(423);

    // Humans are never gated; the admin unpause restores the fleet.
    await authed(app).put('/rest/api/2/issue/TH-1')
      .send({ fields: { summary: 'human override' } }).expect(204);
    await authed(app).put('/api/internal/projects/TH/pause').send({ paused: false }).expect(200);
    await authed(app).put('/rest/api/2/issue/TH-1')
      .set(bearer(a.bearer))
      .send({ fields: { summary: 'resumed' }, fenceToken: lease.body.fenceToken }).expect(204);
  });
});

describe('071 US1/US2 — town hall deliberation + durable inbox', () => {
  it('channel → topic → post → stance → resolve → compiled DAG', async () => {
    const { a } = await seed();
    const ch = await authed(app).get('/api/internal/town-hall/channels?project=TH').expect(200);
    const room = ch.body.channels.find((c: { projectKey?: string }) => c.projectKey === 'TH') ?? ch.body.channels[0];
    expect(room).toBeTruthy();
    // Floor control would 429 the rapid-fire posts below; disable for this test.
    await prisma.townHallChannel.update({ where: { id: room.id }, data: { agentCooldownSec: 0 } });

    const topic = await authed(app).post('/api/internal/town-hall/topics')
      .set(bearer(a.bearer))
      .send({
        channelId: room.id, kind: 'rfc', title: 'adopt fences?', body: 'every write carries the fence.',
        speechAct: 'proposal', quorumRequired: 1, linkedIssueKeys: ['TH-1'],
      })
      .expect(201);
    expect(topic.body.topic.status).toBe('open');
    const tid = topic.body.topic.id;

    await authed(app).post(`/api/internal/town-hall/topics/${tid}/posts`)
      .set(bearer(a.bearer)).send({ speechAct: 'evidence', body: 'claim path already mints them' }).expect(201);

    // Objection demands a cited reason.
    await authed(app).put(`/api/internal/town-hall/topics/${tid}/stances`)
      .set(bearer(a.bearer)).send({ stance: 'object' }).expect(400);
    const tally = await authed(app).put(`/api/internal/town-hall/topics/${tid}/stances`)
      .set(bearer(a.bearer)).send({ stance: 'endorse' }).expect(200);
    expect(tally.body.endorse).toBe(1);

    // dryRun previews the DAG; the real call compiles it + decides the topic.
    const prev = await authed(app).post(`/api/internal/town-hall/topics/${tid}/resolve?dryRun=true`)
      .set(bearer(a.bearer))
      .send({
        decisionSummary: 'adopt fences',
        compileDag: {
          epic: { summary: 'town hall epic' },
          tasks: [
            { tempId: 't1', summary: 'task one' },
            { tempId: 't2', summary: 'task two', blockedByTempIds: ['t1'] },
          ],
        },
      })
      .expect(200);
    expect(prev.body.dryRun).toBe(true);
    expect(prev.body.plan.tasks.length).toBe(2);

    const res = await authed(app).post(`/api/internal/town-hall/topics/${tid}/resolve`)
      .set(bearer(a.bearer))
      .send({
        decisionSummary: 'adopt fences',
        compileDag: {
          epic: { summary: 'town hall epic' },
          tasks: [
            { tempId: 't1', summary: 'task one' },
            { tempId: 't2', summary: 'task two', blockedByTempIds: ['t1'] },
          ],
        },
      })
      .expect(200);
    expect(res.body.topic.status).toBe('decided');
    expect(res.body.compiled.length).toBe(2);
    // blocked-by edge compiled: t2 ← Blocks → t1.
    const t2 = await authed(app)
      .get(`/rest/api/2/issue/${res.body.compiled[1].issueKey}?fields=issuelinks`).expect(200);
    expect(JSON.stringify(t2.body.fields.issuelinks)).toContain(res.body.compiled[0].issueKey);
  });

  it('peer question lands in the target inbox; ack clears it', async () => {
    const { a, b } = await seed();
    const lease = await authed(app).post('/api/internal/issues/TH-1/lease')
      .set(bearer(a.bearer)).send({}).expect(201);

    const q = await authed(app).post('/api/internal/agent-questions/peer')
      .set(bearer(a.bearer))
      .send({ sessionId: lease.body.sessionId, issueKey: 'TH-1', question: 'review my diff?', targetUserId: b.agent.id })
      .expect(201);
    expect(q.body.questionId).toBeTruthy();
    await dispatchEvents();

    const inbox = await authed(app).get('/api/internal/agent-inbox')
      .set(bearer(b.bearer)).expect(200);
    expect(inbox.body.unreadCount).toBeGreaterThanOrEqual(1);
    expect(inbox.body.items.some((i: { reason: string }) => i.reason === 'peer_question')).toBe(true);

    // The question is also visible on the peer-consult surface…
    const mine = await authed(app).get('/api/internal/agent-questions/mine')
      .set(bearer(b.bearer)).expect(200);
    expect(mine.body.questions.length).toBe(1);
    // …and answering it does NOT pause the asker's session (non-blocking consult).
    await authed(app).post(`/api/internal/agent-questions/${q.body.questionId}/answer`)
      .set(bearer(b.bearer)).send({ answer: 'lgtm' }).expect(200);
    const s = await prisma.agentSession.findUniqueOrThrow({ where: { id: lease.body.sessionId } });
    expect(s.status).toBe('running');

    const ack = await authed(app).post('/api/internal/agent-inbox/ack')
      .set(bearer(b.bearer)).send({ all: true }).expect(200);
    expect(ack.body.acked).toBeGreaterThanOrEqual(1);
    const cleared = await authed(app).get('/api/internal/agent-inbox?unread=1')
      .set(bearer(b.bearer)).expect(200);
    expect(cleared.body.unreadCount).toBe(0);
  });

  it('traces flag cross-driver collisions; context pack bootstraps the issue', async () => {
    const { a, b } = await seed();
    await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'TH' }, summary: 'second issue' } }).expect(201);
    const la = await authed(app).post('/api/internal/issues/TH-1/lease')
      .set(bearer(a.bearer)).send({}).expect(201);
    const lb = await authed(app).post('/api/internal/issues/TH-2/lease')
      .set(bearer(b.bearer)).send({}).expect(201);

    const dep = await authed(app).post(`/api/internal/agent-sessions/${la.body.sessionId}/traces`)
      .set(bearer(a.bearer))
      .send({ traces: [{ kind: 'file_edit', target: 'src/shared.ts', summary: 'rewrite' }] }).expect(200);
    expect(dep.body.deposited).toBe(1);

    const clash = await authed(app).post(`/api/internal/agent-sessions/${lb.body.sessionId}/traces`)
      .set(bearer(b.bearer))
      .send({ traces: [{ kind: 'file_edit', target: 'src/shared.ts' }] }).expect(200);
    expect(clash.body.collisions.length).toBe(1);
    expect(clash.body.collisions[0].issueKey).toBe('TH-1');

    const pack = await authed(app).get('/api/internal/issues/TH-1/context-pack')
      .set(bearer(b.bearer)).expect(200);
    expect(pack.body.issueKey).toBe('TH-1');
    expect(pack.body.version).toBeGreaterThanOrEqual(0);
    expect(pack.body.sections.length).toBeGreaterThanOrEqual(1);
  });
});

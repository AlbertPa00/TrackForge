// 073 — Human Verifiability, Artifact Storage & Deliverable Sign-Off.
// Covers SC-001 (honest SHA-256 verification over inline content + Attachments),
// SC-002 (consolidated Work Product Dossier comments), SC-003 (bidirectional
// RFC↔Issue↔Receipt provenance), SC-004 (deliverableApproved workflow gate,
// staleness invalidation, changes_requested inbox wakeup), and FR-005 notifications.
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');

async function seedAgent(email: string, name: string, ownerId?: string) {
  const agent = await prisma.user.create({
    data: {
      email,
      displayName: name,
      passwordHash: await hashPassword('x'.repeat(16)),
      type: 'agent',
      isAssignableAgent: true,
      ownerId: ownerId ?? null,
    },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({
    data: { userId: agent.id, name: 'agent', prefix, hash, scopes: ['read', 'write'] },
  });
  return { agent, bearer: plain };
}

describe('073 — Human Verifiability & Deliverable Sign-Off', () => {
  it('SC-001: server-verified inline content + Attachment bytes vs digest_only & 422 mismatch', async () => {
    const driver = await seedAgent('hv-driver@test.local', 'HV Driver');
    await authed(app).post('/rest/api/2/project').send({ key: 'HV', name: 'Human Verify' }).expect(201);
    await authed(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'HV' }, summary: 'verify receipts' } }).expect(201);

    // 1. Bare digest without content or attachment stays digest_only.
    const dOnly = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(driver.bearer))
      .send({ issueKey: 'HV-1', kind: 'command', sha256: sha('opaque'), summary: 'external run' })
      .expect(201);
    expect(dOnly.body.verification).toBe('digest_only');
    expect(dOnly.body.hasInlineContent).toBe(false);

    // 2. Inline content with tampered sha256 → 422.
    const diffText = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n';
    const bad = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(driver.bearer))
      .send({ issueKey: 'HV-1', kind: 'diff', sha256: '0'.repeat(64), content: diffText, summary: 'tampered' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.sha256).toBeTruthy();

    // 3. Inline content without sha256 computes digest server-side → hash_verified + readable via GET /:id.
    const okInline = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(driver.bearer))
      .send({
        issueKey: 'HV-1',
        kind: 'diff',
        content: diffText,
        changedFiles: ['src/a.ts'],
        summary: 'bump x to 2',
      })
      .expect(201);
    expect(okInline.body.verification).toBe('hash_verified');
    expect(okInline.body.sha256).toBe(sha(diffText));
    expect(okInline.body.hasInlineContent).toBe(true);
    expect(okInline.body.changedFiles).toEqual(['src/a.ts']);

    const detail = await authed(app).get(`/api/internal/work-receipts/${okInline.body.id}`)
      .set(bearer(driver.bearer)).expect(200);
    expect(detail.body.content).toBe(diffText);

    // 4. Attachment-backed receipt verifies stored attachment bytes.
    const logBuf = Buffer.from('TAP version 14\n1..2\nok 1 - parses header\nok 2 - validates token\n', 'utf8');
    const uploaded = await authed(app)
      .post('/rest/api/2/issue/HV-1/attachments')
      .set('X-Atlassian-Token', 'no-check')
      .attach('file', logBuf, { filename: 'test-output.txt', contentType: 'text/plain' })
      .expect(200);
    const attId = uploaded.body[0].id;

    const attReceipt = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(driver.bearer))
      .send({
        issueKey: 'HV-1',
        kind: 'test_run',
        attachmentId: attId,
        sha256: sha(logBuf),
        summary: 'TAP suite green',
        metrics: { passed: 2, failed: 0 },
      })
      .expect(201);
    expect(attReceipt.body.verification).toBe('hash_verified');
    expect(attReceipt.body.attachment.filename).toBe('test-output.txt');
  });

  it('SC-002/003/004 & FR-005: RFC→DAG provenance, dossier comment, deliverableApproved gate, inbox feedback & staleness', async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { isAdmin: true } });
    const driver = await seedAgent('hv-coder@test.local', 'HV Coder', admin.id);
    const peer = await seedAgent('hv-peer@test.local', 'HV Peer');

    await authed(app).post('/rest/api/2/project').send({ key: 'HVG', name: 'HV Gated' }).expect(201);

    // Attach deliverableApproved(requireHuman:true) validator to Done transitions in HVG's workflow.
    const doneStatus = await prisma.status.findFirstOrThrow({ where: { category: 'done' } });
    const transitionsToDone = await prisma.workflowTransition.findMany({
      where: { toStatusId: doneStatus.id },
      select: { id: true },
    });
    for (const tr of transitionsToDone) {
      await prisma.transitionRule.create({
        data: {
          transitionId: tr.id,
          kind: 'validator',
          type: 'deliverableApproved',
          config: { requireHuman: true, minReceiptTier: 'hash_verified' },
        },
      });
    }

    // Open Town Hall RFC → resolve + compile task HVG-1.
    const ch = await authed(app).get('/api/internal/town-hall/channels?project=HVG').expect(200);
    const room = ch.body.channels.find((c: { projectKey?: string }) => c.projectKey === 'HVG') ?? ch.body.channels[0];
    const topicRes = await authed(app).post('/api/internal/town-hall/topics')
      .set(bearer(driver.bearer))
      .send({
        channelId: room.id,
        kind: 'rfc',
        title: 'RFC: Build health probe CLI',
        body: 'Ship tools/probe.mjs with zero dependencies.',
        speechAct: 'proposal',
        quorumRequired: 1,
      })
      .expect(201);
    const tid = topicRes.body.topic.id;
    await authed(app).put(`/api/internal/town-hall/topics/${tid}/stances`)
      .set(bearer(peer.bearer)).send({ stance: 'endorse' }).expect(200);
    const resolved = await authed(app).post(`/api/internal/town-hall/topics/${tid}/resolve`)
      .send({
        decisionSummary: 'Approved probe CLI.',
        compileDag: {
          tasks: [{ tempId: 't1', summary: 'Implement tools/probe.mjs', issueType: 'Task' }],
        },
      })
      .expect(200);
    const taskKey = resolved.body.compiled[0].issueKey as string;

    // Driver leases task, declares trace, attaches verified diff receipt, releases ready_for_review.
    const lease = await authed(app).post(`/api/internal/issues/${taskKey}/lease`)
      .set(bearer(driver.bearer))
      .send({ branchName: 'feat/probe', baseSha: '1'.repeat(40) })
      .expect(201);
    await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/traces`)
      .set(bearer(driver.bearer))
      .send({ traces: [{ kind: 'file_edit', target: 'tools/probe.mjs' }] })
      .expect(200);
    const diffReceipt = await authed(app).post('/api/internal/work-receipts')
      .set(bearer(driver.bearer))
      .send({
        issueKey: taskKey,
        sessionId: lease.body.sessionId,
        kind: 'diff',
        content: '--- /dev/null\n+++ b/tools/probe.mjs\n@@ -0,0 +1 @@\n+console.log("ok");\n',
        changedFiles: ['tools/probe.mjs'],
        summary: 'Add probe CLI',
      })
      .expect(201);

    const rel = await authed(app).post(`/api/internal/agent-sessions/${lease.body.sessionId}/release`)
      .set(bearer(driver.bearer))
      .send({
        outcome: 'ready_for_review',
        summary: 'Implemented probe CLI; ready for human acceptance.',
        headSha: '2'.repeat(40),
        receiptIds: [diffReceipt.body.id],
      })
      .expect(200);
    expect(rel.body.driftStatus).toBe('clean');
    expect(rel.body.dossierCommentId).toBeTruthy();
    await dispatchEvents();

    // FR-005: Human owner received deliverable_review_requested notification.
    const notifs = await prisma.notification.findMany({
      where: { userId: admin.id, reason: 'deliverable_review_requested' },
    });
    expect(notifs.length).toBeGreaterThanOrEqual(1);

    // SC-002: Dossier comment is visible in standard Jira comments API with structured metadata + RFC provenance.
    const comments = await authed(app).get(`/rest/api/2/issue/${taskKey}/comment`).expect(200);
    expect(comments.body.comments.length).toBe(1);
    expect(comments.body.comments[0].body).toContain('Work Product Dossier — Ready for Review');
    expect(comments.body.comments[0].body).toContain('tools/probe.mjs');
    expect(comments.body.comments[0].body).toContain('RFC: Build health probe CLI');
    expect(comments.body.comments[0].metadata.kind).toBe('agent_dossier');
    expect(comments.body.comments[0].metadata.receiptIds).toContain(diffReceipt.body.id);

    // SC-003: Single-call provenance surfaces RFC, receipts, changedFiles, and awaiting_review.
    const prov1 = await authed(app).get(`/api/internal/issues/${taskKey}/provenance`)
      .set(bearer(driver.bearer)).expect(200);
    expect(prov1.body.topics[0].title).toBe('RFC: Build health probe CLI');
    expect(prov1.body.changedFiles).toEqual(['tools/probe.mjs']);
    expect(prov1.body.deliverableReview.status).toBe('awaiting_review');

    // Move issue to In Progress first so the Done transition is reachable, then test deliverableApproved gate.
    const startList = await authed(app).get(`/rest/api/2/issue/${taskKey}/transitions`).expect(200);
    const startTr = startList.body.transitions.find((t: { name: string }) => t.name === 'Start Progress');
    if (startTr) {
      await authed(app).post(`/rest/api/2/issue/${taskKey}/transitions`)
        .set(bearer(driver.bearer)).send({ transition: { id: startTr.id } }).expect(204);
    }

    const trList = await authed(app).get(`/rest/api/2/issue/${taskKey}/transitions`).expect(200);
    const toDone = trList.body.transitions.find((t: { to: { statusCategory: { key: string } } }) => t.to.statusCategory.key === 'done');
    expect(toDone).toBeTruthy();
    const donePayload = { transition: { id: toDone.id }, fields: { resolution: { name: 'Done' } } };

    // SC-004: Transition to Done is blocked before human sign-off (422).
    const blocked1 = await authed(app).post(`/rest/api/2/issue/${taskKey}/transitions`)
      .set(bearer(driver.bearer))
      .send(donePayload);
    expect(blocked1.status).toBe(422);
    expect(blocked1.body.errors.deliverableReview).toBeTruthy();

    // Driver cannot self-approve (403); peer agent approval does not satisfy requireHuman:true (422).
    await authed(app).post(`/api/internal/issues/${taskKey}/deliverable-review`)
      .set(bearer(driver.bearer)).send({ verdict: 'approved' }).expect(403);
    await authed(app).post(`/api/internal/issues/${taskKey}/deliverable-review`)
      .set(bearer(peer.bearer)).send({ verdict: 'approved', body: 'peer lgtm' }).expect(201);
    const blockedPeer = await authed(app).post(`/rest/api/2/issue/${taskKey}/transitions`)
      .set(bearer(driver.bearer)).send(donePayload);
    expect(blockedPeer.status).toBe(422);
    expect(blockedPeer.body.errors.deliverableReview).toContain('human reviewer');

    // Human requests changes → wakes driver's durable inbox + context pack carries notes.
    await authed(app).post(`/api/internal/issues/${taskKey}/deliverable-review`)
      .send({ verdict: 'changes_requested', body: 'Exit non-zero when server returns 500.' })
      .expect(201);
    await dispatchEvents();

    const inbox = await authed(app).get('/api/internal/agent-inbox?unread=1')
      .set(bearer(driver.bearer)).expect(200);
    expect(inbox.body.items.some((i: { reason: string }) => i.reason === 'changes_requested')).toBe(true);

    const pack = await authed(app).get(`/api/internal/issues/${taskKey}/context-pack`)
      .set(bearer(driver.bearer)).expect(200);
    expect(JSON.stringify(pack.body)).toContain('Exit non-zero when server returns 500.');

    // Human approves → receipt upgrades to human_attested.
    const approved = await authed(app).post(`/api/internal/issues/${taskKey}/deliverable-review`)
      .send({ verdict: 'approved', body: 'Verified diff and exit code.' })
      .expect(201);
    expect(approved.body.stale).toBe(false);
    const upgraded = await authed(app).get(`/api/internal/work-receipts/${diffReceipt.body.id}`).expect(200);
    expect(upgraded.body.verification).toBe('human_attested');

    // Staleness guard: submitting a new diff receipt after approval marks prior approval stale → blocks Done (422).
    await authed(app).post('/api/internal/work-receipts')
      .set(bearer(driver.bearer))
      .send({
        issueKey: taskKey,
        kind: 'diff',
        content: '--- a/tools/probe.mjs\n+++ b/tools/probe.mjs\n@@ -1 +1 @@\n-console.log("ok");\n+console.log("sneaky");\n',
        changedFiles: ['tools/probe.mjs'],
        summary: 'post-approval edit',
      })
      .expect(201);
    const provStale = await authed(app).get(`/api/internal/issues/${taskKey}/provenance`).expect(200);
    expect(provStale.body.deliverableReview.status).toBe('stale');

    const blockedStale = await authed(app).post(`/rest/api/2/issue/${taskKey}/transitions`)
      .set(bearer(driver.bearer)).send(donePayload);
    expect(blockedStale.status).toBe(422);
    expect(blockedStale.body.errors.deliverableReview).toContain('stale');

    // Human re-approves current bundle → Done transition succeeds (204)!
    await authed(app).post(`/api/internal/issues/${taskKey}/deliverable-review`)
      .send({ verdict: 'approved', body: 'Re-verified updated diff.' })
      .expect(201);
    await authed(app).post(`/rest/api/2/issue/${taskKey}/transitions`)
      .set(bearer(driver.bearer)).send(donePayload).expect(204);
  });
});

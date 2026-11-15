// Sprint 029 — email & notification schemes.
// Scheme CRUD (admin), event → outbox → send via memory adapter, recipient
// dedupe + actor suppression, prefs opt-out, digest batching, subscriptions.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import {
  ensureDefaultScheme, sendPendingMail, sendDigests, runSubscriptions,
  getMailAdapter, resetMailAdapter, MemoryAdapter,
} from '../../src/services/mailService.js';

async function mkIssue(fields: object) {
  const r = await authed(app).post('/rest/api/2/issue').send({ fields }).expect(201);
  return r.body.key as string;
}

function mem() {
  const a = getMailAdapter();
  return a instanceof MemoryAdapter ? a : null;
}

describe('email & notification schemes (029)', () => {
  let issueKey: string;

  beforeEach(async () => {
    await ensureTestAuth();
    resetMailAdapter();
    await ensureDefaultScheme();
    await authed(app).post('/rest/api/2/project').send({ key: 'ML', name: 'ML' }).expect(201);
    issueKey = await mkIssue({ project: { key: 'ML' }, summary: 'mail probe' });
    // Drain the create event before tests add watchers — dispatch is lazy, so
    // a watcher added before dispatch would also get the create-event mail.
    await dispatchEvents();
  });

  it('scheme CRUD is admin-gated and stores the event→recipient matrix', async () => {
    const created = await authed(app).post('/api/internal/notificationschemes')
      .send({ name: 'Custom', entries: [{ event: 'comment_created', recipientKind: 'reporter' }] })
      .expect(201);
    expect(created.body.entries).toHaveLength(1);

    const list = await authed(app).get('/api/internal/notificationschemes').expect(200);
    const def = list.body.schemes.find((s: { isDefault: boolean }) => s.isDefault);
    expect(def).toBeTruthy();
    expect(def.entries.length).toBeGreaterThan(0);

    const updated = await authed(app).put(`/api/internal/notificationschemes/${created.body.id}`)
      .send({ entries: [{ event: 'issue_created', recipientKind: 'watchers' }, { event: 'issue_created', recipientKind: 'projectlead' }] })
      .expect(200);
    expect(updated.body.entries).toHaveLength(2);

    // assignment
    await authed(app).post('/api/internal/projects/ML/notificationscheme')
      .send({ schemeId: created.body.id }).expect(200);
    const proj = await prisma.project.findUnique({ where: { key: 'ML' } });
    expect(proj?.notificationSchemeId).toBe(created.body.id);

    // default scheme can't be deleted
    await authed(app).delete(`/api/internal/notificationschemes/${def.id}`).expect(400);
    await authed(app).delete(`/api/internal/notificationschemes/${created.body.id}`).expect(204);
  });

  it('issue events enqueue §14.4-shaped outbox mail minus the actor', async () => {
    // actor creates the issue → reporter/assignee = actor → suppressed → 0 rows;
    // a second user watches → a comment event mails the watcher.
    const viewer = await prisma.user.upsert({
      where: { email: 'w@ml.test' },
      update: {},
      create: { email: 'w@ml.test', displayName: 'w', passwordHash: 'x' },
    });
    const issue = await prisma.issue.findFirst({ where: { project: { key: 'ML' } } });
    await prisma.watcher.create({ data: { issueId: issue!.id, userId: viewer.id } });

    await authed(app).post(`/rest/api/2/issue/${issueKey}/comment`).send({ body: 'ping' }).expect(201);
    await dispatchEvents();

    const rows = await prisma.emailOutbox.findMany({ where: { issueKey } });
    expect(rows.length).toBe(1);
    expect(rows[0].toUserId).toBe(viewer.id);
    expect(rows[0].subject).toContain('[ML-');
    expect(rows[0].subject).toContain('comment created');
    expect(rows[0].status).toBe('pending');

    const sent = await sendPendingMail();
    expect(sent).toBe(1);
    const adapter = mem();
    expect(adapter?.sent.length).toBe(1);
    expect(adapter?.sent[0].to).toBe('w@ml.test');
    const row = await prisma.emailOutbox.findUnique({ where: { id: rows[0].id } });
    expect(row?.status).toBe('sent');
  });

  it('prefs opt-out suppresses email; digest=daily batches into one mail', async () => {
    const u = await prisma.user.upsert({
      where: { email: 'd@ml.test' },
      update: {},
      create: { email: 'd@ml.test', displayName: 'd', passwordHash: 'x' },
    });
    const issue = await prisma.issue.findFirst({ where: { project: { key: 'ML' } } });
    await prisma.watcher.create({ data: { issueId: issue!.id, userId: u.id } });

    // opt out
    await authed(app).put('/api/internal/me/preferences')
      .send({ events: { comment_created: { email: false } } }).expect(200);
    // ^ sets prefs for the admin actor, not u — set u's directly
    await prisma.userPreference.upsert({
      where: { userId_key: { userId: u.id, key: 'notify.prefs' } },
      create: { userId: u.id, key: 'notify.prefs', value: { digest: 'daily' } },
      update: { value: { digest: 'daily' } },
    });

    await authed(app).post(`/rest/api/2/issue/${issueKey}/comment`).send({ body: 'one' }).expect(201);
    await authed(app).post(`/rest/api/2/issue/${issueKey}/comment`).send({ body: 'two' }).expect(201);
    await dispatchEvents();

    const rows = await prisma.emailOutbox.findMany({ where: { issueKey, toUserId: u.id } });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === 'digest')).toBe(true);

    // 065 G5 — fresh digest rows must NOT flush (one batch a day): age the
    // oldest row past the ~20h gate, then the whole user batch flushes.
    expect(await sendDigests()).toBe(0);
    await prisma.emailOutbox.updateMany({
      where: { toUserId: u.id },
      data: { createdAt: new Date(Date.now() - 21 * 3_600_000) },
    });

    const sent = await sendDigests();
    expect(sent).toBe(1);
    const adapter = mem();
    expect(adapter?.sent.length).toBe(1);
    expect(adapter?.sent[0].subject).toContain('Daily digest');
  });

  it('037: recipient locale renders localized subject + body, en fallback', async () => {
    const de = await prisma.user.upsert({
      where: { email: 'de@ml.test' },
      update: { locale: 'de' },
      create: { email: 'de@ml.test', displayName: 'Dora', passwordHash: 'x', locale: 'de' },
    });
    const issue = await prisma.issue.findFirst({ where: { project: { key: 'ML' } } });
    await prisma.watcher.create({ data: { issueId: issue!.id, userId: de.id } });

    await authed(app).post(`/rest/api/2/issue/${issueKey}/comment`).send({ body: 'hallo' }).expect(201);
    await dispatchEvents();

    const row = await prisma.emailOutbox.findFirst({ where: { issueKey, toUserId: de.id } });
    expect(row?.subject).toContain('Kommentar erstellt');
    expect(row?.body).toContain(`kommentiert`);
    expect(row?.body).toContain('Vorgang anzeigen');
  });

  it('filter subscription runs on schedule and unsubscribes by token', async () => {
    const filter = await prisma.filter.create({
      data: { ownerId: (await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } })).id, name: 'all ML', jql: 'project = ML' },
    });
    // 065 G5 — subscriptions honor their stored hour (UTC): a sub for a
    // different hour skips; one for the current hour runs.
    const skipped = await authed(app).post(`/api/internal/filters/${filter.id}/subscriptions`)
      .send({ frequency: 'daily' }).expect(201);
    expect(skipped.body.id).toBeTruthy();

    const sub = await authed(app).post(`/api/internal/filters/${filter.id}/subscriptions`)
      .send({ frequency: 'daily' }).expect(201);
    expect(sub.body.unsubscribeToken).toBeTruthy();
    // Pin the hours at run time — a POST-time value could drift at an hour edge.
    const nowHour = new Date().getUTCHours();
    await prisma.filterSubscription.update({
      where: { id: skipped.body.id },
      data: { hour: (nowHour + 1) % 24 },
    });
    await prisma.filterSubscription.update({
      where: { id: sub.body.id },
      data: { hour: nowHour },
    });

    const ran = await runSubscriptions();
    expect(ran).toBe(1);
    const adapter = mem();
    expect(adapter?.sent[0]?.subject).toContain('all ML');
    expect(adapter?.sent[0]?.html).toContain('ML-1');

    // second immediate run is a no-op (23h gate)
    expect(await runSubscriptions()).toBe(0);

    // token unsubscribe — public route, no auth needed. 064: GET renders a
    // confirm page (mail-scanner prefetch must not mutate); POST confirms.
    const page = await request(app).get(`/unsubscribe?token=${sub.body.unsubscribeToken}`).expect(200);
    expect(page.text).toContain('Unsubscribe');
    const stillThere = await prisma.filterSubscription.findUnique({ where: { id: sub.body.id } });
    expect(stillThere).not.toBeNull();
    await request(app).post('/unsubscribe').send(`token=${sub.body.unsubscribeToken}`).expect(200);
    const gone = await prisma.filterSubscription.findUnique({ where: { id: sub.body.id } });
    expect(gone).toBeNull();
  });

  it('065 F2 — mail config PUT never returns the SMTP password', async () => {
    const put = await authed(app).put('/api/internal/admin/mail')
      .send({ host: 'smtp.test', port: 2525, user: 'u', pass: 'sup3r-secret', from: 't@t.local' })
      .expect(200);
    expect(put.body.pass).toBe('•••');
    expect(JSON.stringify(put.body)).not.toContain('sup3r-secret');
    const get = await authed(app).get('/api/internal/admin/mail').expect(200);
    expect(get.body.pass).toBe('•••');
  });

  it('outbox endpoint lists send status; mail test hits the adapter', async () => {
    await authed(app).post('/api/internal/admin/mail/test').send({}).expect(200);
    expect(mem()?.sent[0]?.subject).toContain('SMTP test');

    const ob = await authed(app).get('/api/internal/admin/outbox').expect(200);
    expect(ob.body).toHaveProperty('outbox');
    // non-admin gets 403 on the admin surface
    const viewer = await prisma.user.upsert({
      where: { email: 'v@ml.test' }, update: {}, create: { email: 'v@ml.test', displayName: 'v', passwordHash: 'x' },
    });
    const { generateToken } = await import('../../src/lib/auth.js');
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({ data: { userId: viewer.id, name: 'v', prefix, hash, scopes: [], projectKeys: [] } });
    await request(app).get('/api/internal/admin/outbox').set('Authorization', `Bearer ${plain}`).expect(403);
  });
});

// Sprint 011 — events, webhooks, watchers, notifications.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Express } from 'express';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, TEST_ADMIN } from '../request.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import { deliverPending, signBody } from '../../src/services/webhookService.js';
import { generateToken } from '../../src/lib/auth.js';

// Lazy agent — the test token is created per-test in setup's beforeEach.
const a = new Proxy({} as ReturnType<typeof authed>, {
  get: (_t, prop) => (authed(app as Express) as unknown as Record<string | symbol, unknown>)[prop],
});

async function ensureProject() {
  const res = await a.post('/rest/api/2/project').send({ key: 'TF', name: 'TrackForge' });
  if (res.status !== 201 && res.status !== 400) {
    throw new Error(`project create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

async function makeIssue(overrides: Record<string, unknown> = {}) {
  await ensureProject();
  const res = await a
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: 'TF' }, summary: 'ev issue', issuetype: { name: 'Task' }, ...overrides } });
  if (res.status !== 201) throw new Error(`issue create failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.key as string;
}

async function makeUser(email: string, displayName: string, isAdmin = false) {
  const user = await prisma.user.create({
    data: { email, displayName, passwordHash: 'x', isAdmin, type: 'human' },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: 't', prefix, hash, scopes: ['read', 'write', 'admin'] } });
  return { user, bearer: plain };
}

// ---------- transactional outbox ----------

describe('transactional outbox', () => {
  it('emits jira:issue_created with changelog items in the same transaction', async () => {
    const key = await makeIssue({ summary: 'atomic create' });
    const ev = await prisma.domainEvent.findFirst({
      where: { type: 'jira:issue_created' },
      orderBy: { id: 'desc' },
    });
    expect(ev).toBeTruthy();
    const p = ev!.payload as { issueKey: string; projectKey: string; changelog: { items: { field: string }[] }; issue: { fields: { summary: string } } };
    expect(p.issueKey).toBe(key);
    expect(p.projectKey).toBe('TF');
    expect(p.issue.fields.summary).toBe('atomic create');
    expect(p.changelog.items.map((i) => i.field)).toEqual(
      expect.arrayContaining(['summary', 'status', 'issuetype', 'priority', 'reporter'])
    );
  });

  it('emits jira:issue_updated on field change with before/after changelog', async () => {
    const key = await makeIssue();
    await a.put(`/rest/api/2/issue/${key}`).send({ fields: { summary: 'renamed' } }).expect(204);
    const ev = await prisma.domainEvent.findFirst({
      where: { type: 'jira:issue_updated', payload: { path: ['issueKey'], equals: key } },
      orderBy: { id: 'desc' },
    });
    const p = ev!.payload as { changelog: { items: { field: string; fromString?: string; toString?: string }[] } };
    const item = p.changelog.items.find((i) => i.field === 'summary');
    expect(item).toBeTruthy();
    expect(item!.toString).toBe('renamed');
  });

  it('emits comment_created / comment_updated / comment_deleted', async () => {
    const key = await makeIssue();
    const created = await a.post(`/rest/api/2/issue/${key}/comment`).send({ body: 'first' }).expect(201);
    const id = created.body.id;
    await a.put(`/rest/api/2/issue/${key}/comment/${id}`).send({ body: 'edited' }).expect(200);
    await a.delete(`/rest/api/2/issue/${key}/comment/${id}`).expect(204);
    const types = (await prisma.domainEvent.findMany({ select: { type: true } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['comment_created', 'comment_updated', 'comment_deleted']));
  });

  it('emits issuelink_created and issuelink_deleted', async () => {
    const k1 = await makeIssue({ summary: 'link a' });
    const k2 = await makeIssue({ summary: 'link b' });
    await a.post('/rest/api/2/issueLink').send({ type: { name: 'Blocks' }, outwardIssue: { key: k1 }, inwardIssue: { key: k2 } }).expect(201);
    const created = await prisma.domainEvent.findFirst({ where: { type: 'issuelink_created' } });
    expect(created).toBeTruthy();
    const linkId = (created!.payload as { link: { id: string } }).link.id;
    await a.delete(`/rest/api/2/issueLink/${linkId}`).expect(204);
    expect(await prisma.domainEvent.count({ where: { type: 'issuelink_deleted' } })).toBe(1);
  });

  it('emits jira:issue_deleted with the issue snapshot and survives deletion', async () => {
    const key = await makeIssue();
    const preview = await a.delete(`/rest/api/2/issue/${key}?dryRun=true`).expect(200);
    await a.delete(`/rest/api/2/issue/${key}?confirmToken=${preview.body.confirmToken}`).expect(204);
    const ev = await prisma.domainEvent.findFirst({ where: { type: 'jira:issue_deleted' } });
    expect(ev).toBeTruthy();
    expect((ev!.payload as { issue: { fields: { summary: string } } }).issue.fields.summary).toBe('ev issue');
    expect(ev!.issueId).toBeNull(); // dangling — snapshot in payload
  });

  it('emits jira:issue_updated on workflow transition and sprint moves', async () => {
    const key = await makeIssue();
    const transitions = await a.get(`/rest/api/2/issue/${key}/transitions`).expect(200);
    const t = transitions.body.transitions[0];
    await a.post(`/rest/api/2/issue/${key}/transitions`).send({ transition: { id: t.id } }).expect(204);
    const ev = await prisma.domainEvent.findFirst({
      where: { type: 'jira:issue_updated', payload: { path: ['issueKey'], equals: key } },
      orderBy: { id: 'desc' },
    });
    const items = (ev!.payload as { changelog: { items: { field: string }[] } }).changelog.items;
    expect(items.map((i) => i.field)).toContain('status');
  });
});

// ---------- event feed ----------

describe('event feed', () => {
  it('returns events after a cursor in id order', async () => {
    await makeIssue({ summary: 'feed1' });
    await makeIssue({ summary: 'feed2' });
    const feed = await a.get('/api/internal/events').expect(200);
    expect(feed.body.events.length).toBeGreaterThanOrEqual(2);
    const ids = feed.body.events.map((e: { id: number }) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(feed.body.nextCursor).toBe(ids[ids.length - 1]);
  });

  it('resumes strictly after the cursor', async () => {
    const first = await a.get('/api/internal/events?limit=1').expect(200);
    const second = await a.get(`/api/internal/events?after=${first.body.nextCursor}`).expect(200);
    for (const e of second.body.events as { id: number }[]) {
      expect(e.id).toBeGreaterThan(first.body.nextCursor);
    }
  });

  it('filters by type and project', async () => {
    await makeIssue();
    const filtered = await a.get('/api/internal/events?types=jira:issue_created&projects=TF').expect(200);
    for (const e of filtered.body.events as { type: string; projectKey: string }[]) {
      expect(e.type).toBe('jira:issue_created');
      expect(e.projectKey).toBe('TF');
    }
    const noMatch = await a.get('/api/internal/events?projects=ZZZ').expect(200);
    expect(noMatch.body.events).toEqual([]);
  });

  it('returns 410 for an expired cursor', async () => {
    await makeIssue({ summary: 'e1' });
    await makeIssue({ summary: 'e2' });
    const oldest = await prisma.domainEvent.findFirst({ orderBy: { id: 'asc' } });
    await prisma.domainEvent.delete({ where: { id: oldest!.id } });
    const res = await a.get(`/api/internal/events?after=${oldest!.id}`).expect(410);
    expect(res.body.errorMessages[0]).toMatch(/expired/i);
  });

  it('scopes the feed to the token project allow-list', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: TEST_ADMIN.email } });
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({
      data: { userId: admin.id, name: 'scoped', prefix, hash, scopes: ['read'], projectKeys: ['ZZZ'] },
    });
    await makeIssue();
    const scoped = await a
      .get('/api/internal/events')
      .set('Authorization', `Bearer ${plain}`)
      .expect(200);
    expect(scoped.body.events).toEqual([]);
  });
});

// ---------- watchers ----------

describe('watchers', () => {
  it('auto-watches the creator on create', async () => {
    const key = await makeIssue();
    const res = await a.get(`/rest/api/2/issue/${key}/watchers`).expect(200);
    expect(res.body.isWatching).toBe(true);
    expect(res.body.watchCount).toBe(1);
  });

  it('auto-watches commenters', async () => {
    const key = await makeIssue();
    const bob = await makeUser('bob-w@t.local', 'Bob W');
    const res = await a
      .post(`/rest/api/2/issue/${key}/comment`)
      .set('Authorization', `Bearer ${bob.bearer}`)
      .send({ body: 'bob comments' });
    expect(res.status).toBe(201);
    const watchers = await a.get(`/rest/api/2/issue/${key}/watchers`).expect(200);
    expect(watchers.body.watchCount).toBe(2);
  });

  it('supports manual add/remove', async () => {
    const key = await makeIssue();
    await a.post(`/rest/api/2/issue/${key}/watchers`).expect(204); // idempotent self-watch
    await a.delete(`/rest/api/2/issue/${key}/watchers`).expect(204);
    const res = await a.get(`/rest/api/2/issue/${key}/watchers`).expect(200);
    expect(res.body.isWatching).toBe(false);
    expect(res.body.watchCount).toBe(0);
  });
});

// ---------- notifications ----------

describe('notifications', () => {
  it('notifies the new assignee (reason=assigned), not the actor', async () => {
    const bob = await makeUser('bob-n@t.local', 'Bob N');
    const key = await makeIssue();
    await a.put(`/rest/api/2/issue/${key}/assignee`).send({ accountId: bob.user.id }).expect(204);
    await dispatchEvents();
    const rows = await prisma.notification.findMany({ where: { userId: bob.user.id } });
    expect(rows.some((n) => n.reason === 'assigned')).toBe(true);
    // actor (admin) should not get a notification for their own action
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: TEST_ADMIN.email } });
    expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(0);
  });

  it('notifies mentions in comments (reason=mentioned)', async () => {
    const bob = await makeUser('bob-m@t.local', 'Bob M');
    const key = await makeIssue();
    await a.post(`/rest/api/2/issue/${key}/comment`).send({ body: `hey [~accountId:${bob.user.id}] look` }).expect(201);
    await dispatchEvents();
    expect(await prisma.notification.count({ where: { userId: bob.user.id, reason: 'mentioned' } })).toBe(1);
  });

  it('notifies watchers on change (reason=watching)', async () => {
    const bob = await makeUser('bob-watch@t.local', 'Bob Watch');
    const key = await makeIssue();
    // bob watches the issue
    await a
      .post(`/rest/api/2/issue/${key}/watchers`)
      .set('Authorization', `Bearer ${bob.bearer}`)
      .expect(204);
    // admin updates — bob is a watcher, should be notified
    await a.put(`/rest/api/2/issue/${key}`).send({ fields: { summary: 'watch me' } }).expect(204);
    await dispatchEvents();
    expect(await prisma.notification.count({ where: { userId: bob.user.id, reason: 'watching' } })).toBe(1);
  });

  it('serves list + mark-read endpoints', async () => {
    const bob = await makeUser('bob-l@t.local', 'Bob L');
    const key = await makeIssue();
    await a.put(`/rest/api/2/issue/${key}/assignee`).send({ accountId: bob.user.id }).expect(204);
    await dispatchEvents();
    const list = await a
      .get('/api/internal/me/notifications')
      .set('Authorization', `Bearer ${bob.bearer}`)
      .expect(200);
    expect(list.body.total).toBeGreaterThanOrEqual(1);
    expect(list.body.unreadCount).toBeGreaterThanOrEqual(1);
    const id = list.body.notifications[0].id;
    await a
      .post('/api/internal/me/notifications/read')
      .set('Authorization', `Bearer ${bob.bearer}`)
      .send({ ids: [id] })
      .expect(200);
    const after = await a
      .get('/api/internal/me/notifications?unreadOnly=true')
      .set('Authorization', `Bearer ${bob.bearer}`)
      .expect(200);
    expect(after.body.total).toBe(0);
  });
});

// ---------- webhooks ----------

describe('webhooks', () => {
  let receiver: Server;
  let port: number;
  const received: { headers: IncomingMessage['headers']; body: string }[] = [];

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
    receiver = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    port = (receiver.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise((r) => receiver.close(r));
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
  });

  it('rejects private URLs by default (SSRF)', async () => {
    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    const res = await a
      .post('/rest/webhooks/1.0/webhook')
      .send({ name: 'bad', url: 'http://127.0.0.1:1234/x', events: ['jira:issue_created'] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/private/i);
    process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  });

  it('enforces admin', async () => {
    const bob = await makeUser('bob-wh@t.local', 'Bob WH');
    await prisma.apiToken.updateMany({ where: { userId: bob.user.id }, data: { scopes: ['read', 'write'] } });
    const res = await a
      .get('/rest/webhooks/1.0/webhook')
      .set('Authorization', `Bearer ${bob.bearer}`)
      .send();
    expect([401, 403]).toContain(res.status);
  });

  it('delivers signed Jira-shaped payloads on matching events', async () => {
    const wh = await a
      .post('/rest/webhooks/1.0/webhook')
      .send({ name: 'hook', url: `http://127.0.0.1:${port}/hook`, events: ['jira:issue_created'], secret: 's3cr3t' })
      .expect(201);
    const key = await makeIssue({ summary: 'webhooked' });
    await dispatchEvents();
    await deliverPending();
    const hit = received.find((r) => r.headers['x-trackforge-event-id']);
    expect(hit).toBeTruthy();
    const body = JSON.parse(hit!.body);
    expect(body.webhookEvent).toBe('jira:issue_created');
    expect(body.issue.fields.summary).toBe('webhooked');
    expect(body.issue.key).toBe(key);
    expect(body.user.accountId).toBeTruthy();
    // HMAC-SHA256 over the exact body
    expect(hit!.headers['x-hub-signature-256']).toBe(signBody('s3cr3t', hit!.body));
    // delivery logged
    const deliveries = await a.get(`/api/internal/webhooks/${wh.body.id}/deliveries`).expect(200);
    expect(deliveries.body.deliveries[0].status).toBe('success');
    expect(deliveries.body.deliveries[0].responseCode).toBe(200);
  });

  it('retries failed deliveries and requeues on redeliver', async () => {
    const wh = await a
      .post('/rest/webhooks/1.0/webhook')
      .send({ name: 'dead', url: 'http://127.0.0.1:1/unreachable', events: ['jira:issue_created'] })
      .expect(201);
    await makeIssue({ summary: 'retry me' });
    await dispatchEvents();
    await deliverPending();
    let deliveries = await a.get(`/api/internal/webhooks/${wh.body.id}/deliveries`).expect(200);
    const d = deliveries.body.deliveries[0];
    expect(d.status).toBe('pending'); // scheduled for retry
    expect(d.attempt).toBe(1);
    // redeliver resets the attempt counter
    await a.post(`/api/internal/webhooks/${wh.body.id}/deliveries/${d.id}/redeliver`).expect(202);
    deliveries = await a.get(`/api/internal/webhooks/${wh.body.id}/deliveries`).expect(200);
    expect(deliveries.body.deliveries[0].attempt).toBe(0);
  });

  it('skips events from excluded actors (loop guard)', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: TEST_ADMIN.email } });
    const wh = await a
      .post('/rest/webhooks/1.0/webhook')
      .send({
        name: 'noguard',
        url: `http://127.0.0.1:${port}/hook`,
        events: ['jira:issue_created'],
        excludeActorIds: [admin.id],
      })
      .expect(201);
    const before = await prisma.webhookDelivery.count({ where: { webhookId: wh.body.id } });
    await makeIssue({ summary: 'loop' });
    await dispatchEvents();
    expect(await prisma.webhookDelivery.count({ where: { webhookId: wh.body.id } })).toBe(before);
  });

  it('honours the issue-related JQL filter', async () => {
    const wh = await a
      .post('/rest/webhooks/1.0/webhook')
      .send({
        name: 'jql',
        url: `http://127.0.0.1:${port}/hook`,
        events: ['jira:issue_created'],
        filters: { 'issue-related-events-section': 'labels = jqlmatch' },
      })
      .expect(201);
    await makeIssue({ summary: 'no label' });
    await makeIssue({ summary: 'has label', labels: ['jqlmatch'] });
    await dispatchEvents();
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId: wh.body.id },
      include: { event: true },
    });
    expect(deliveries.length).toBe(1);
    const evKey = (deliveries[0]!.event.payload as { issueKey: string }).issueKey;
    expect(evKey).toBeTruthy();
  });
});

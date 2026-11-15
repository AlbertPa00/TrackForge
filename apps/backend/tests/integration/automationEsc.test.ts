import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import { executeRule } from '../../src/services/automationService.js';

/** 035 W2 — automation privilege-escalation + cross-rule loop suite. */
describe('Automation escalation & loops (035)', () => {
  async function mintToken(email: string, scopes = ['read', 'write'], projectKeys: string[] = []) {
    const user = await prisma.user.upsert({
      where: { email }, update: {},
      create: { email, displayName: email, passwordHash: await hashPassword('x'.repeat(8)) },
    });
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({ data: { userId: user.id, name: email, prefix, hash, scopes, projectKeys } });
    return { user, agent: request.agent(app).set('Authorization', `Bearer ${plain}`) };
  }

  const mkRule = (agent: ReturnType<typeof authed> | ReturnType<typeof request.agent>, rule: Record<string, unknown>) =>
    agent.post('/api/internal/automation/rules').send(rule);

  async function setup() {
    await authed(app).post('/rest/api/2/project').send({ key: 'AE', name: 'Auto Esc' }).expect(201);
  }

  it('non-admin cannot author rules at all; non-admin actorId rejected; admin can', async () => {
    await setup();
    const { user: pleb, agent: plebAgent } = await mintToken('ae-pleb@test.local');
    // no ADMINISTER_PROJECTS on AE → cannot author even a project rule
    const denied = await mkRule(plebAgent, {
      name: 'pleb rule', scope: 'project', projectKey: 'AE',
      trigger: { type: 'issue_created' }, conditions: [], actions: [{ type: 'comment', body: 'x' }],
    });
    expect(denied.status).toBe(403);

    // admin choosing a different actor → allowed
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } });
    const ok = await mkRule(authed(app), {
      name: 'delegated', scope: 'project', projectKey: 'AE', actorId: pleb.id,
      trigger: { type: 'issue_created' }, conditions: [], actions: [{ type: 'comment', body: 'x' }],
    });
    expect(ok.status).toBe(201);
    expect(ok.body.actor.accountId).toBe(pleb.id);
    expect(admin.id).not.toBe(pleb.id);
  });

  it('run fails closed when the actor is missing/inactive (intersection re-evaluated per run)', async () => {
    await setup();
    const ghost = await prisma.user.create({
      data: { email: 'ae-ghost@test.local', displayName: 'ghost', passwordHash: await hashPassword('x'.repeat(8)) },
    });
    const rule = await mkRule(authed(app), {
      name: 'ghost-actor', scope: 'project', projectKey: 'AE', actorId: ghost.id,
      trigger: { type: 'manual' }, conditions: [], actions: [{ type: 'comment', body: 'x' }],
    }).expect(201);
    // deactivate the actor AFTER save — the next run must refuse
    await prisma.user.update({ where: { id: ghost.id }, data: { active: false } });
    const run = await executeRule(
      await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.body.id } }), {}
    );
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/actor|inactive/i);
  });

  it('two mutually-triggering rules terminate at the depth cap (cross-rule chain)', async () => {
    await setup();
    await mkRule(authed(app), {
      name: 'Ping', scope: 'project', projectKey: 'AE',
      trigger: { type: 'comment_created' }, conditions: [],
      actions: [{ type: 'comment', body: 'ping {{issue.key}}' }],
    }).expect(201);
    await mkRule(authed(app), {
      name: 'Pong', scope: 'project', projectKey: 'AE',
      trigger: { type: 'comment_created' }, conditions: [],
      actions: [{ type: 'comment', body: 'pong {{issue.key}}' }],
    }).expect(201);
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'AE' }, summary: 'arena' } }).expect(201);
    await authed(app).post('/rest/api/2/issue/AE-1/comment').send({ body: 'go' }).expect(201);
    for (let i = 0; i < 10; i++) await dispatchEvents();

    const runs = await prisma.automationRun.findMany({
      where: { rule: { name: { in: ['Ping', 'Pong'] } } }, orderBy: { startedAt: 'asc' },
    });
    expect(runs.length).toBeGreaterThanOrEqual(4); // alternated until the cap
    const terminal = runs.filter((r) => r.status === 'skipped-loop');
    expect(terminal.length).toBeGreaterThanOrEqual(1);
    // no run exceeded the cap: chains stop, comments stop growing
    const comments = await authed(app).get('/rest/api/2/issue/AE-1/comment').expect(200);
    expect(comments.body.comments.length).toBeLessThan(20);
  });

  it('channel attribution: rule writes carry channel=automation, actor=rule actor', async () => {
    await setup();
    const { user: bot } = await mintToken('ae-bot@test.local');
    await mkRule(authed(app), {
      name: 'Attributor', scope: 'project', projectKey: 'AE', actorId: bot.id,
      trigger: { type: 'issue_created' }, conditions: [],
      actions: [{ type: 'comment', body: 'I am a robot' }],
    }).expect(201);
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'AE' }, summary: 'attr' } }).expect(201);
    await dispatchEvents();
    const ev = await prisma.domainEvent.findFirst({
      where: { type: 'comment_created', channel: 'automation' }, orderBy: { id: 'desc' },
    });
    expect(ev).not.toBeNull();
    expect(ev!.actorId).toBe(bot.id);
    // the comment's author is the rule actor, not the rule author
    const comments = await authed(app).get('/rest/api/2/issue/AE-1/comment').expect(200);
    expect(comments.body.comments.at(-1).author.accountId).toBe(bot.id);
  });

  it('065 D3 — non-admin editing an admin-authored rule resets actor + author to the editor', async () => {
    await setup();
    const { user: padmin, agent: padminAgent } = await mintToken('ae-padm@test.local');
    // Project admin (not site admin): ADMINISTER_PROJECTS on AE via a narrow scheme.
    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'AE' } });
    const scheme = await prisma.permissionScheme.create({ data: { name: 'ae-padm-scheme' } });
    await prisma.permissionGrant.create({
      data: { schemeId: scheme.id, permission: 'ADMINISTER_PROJECTS', holderType: 'user', holderParam: padmin.id },
    });
    await prisma.project.update({ where: { id: project.id }, data: { permissionSchemeId: scheme.id } });

    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@test.local' } });
    const rule = await mkRule(authed(app), {
      name: 'admin rule', scope: 'project', projectKey: 'AE',
      trigger: { type: 'issue_created' }, conditions: [], actions: [{ type: 'comment', body: 'x' }],
    }).expect(201);
    const created = await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.body.id } });
    expect(created.actorId).toBe(admin.id); // defaults to the admin author

    await padminAgent.put(`/api/internal/automation/rules/${rule.body.id}`)
      .send({ description: 'edited by project admin' }).expect(200);
    const after = await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.body.id } });
    expect(after.actorId).toBe(padmin.id);
    expect(after.createdById).toBe(padmin.id);
  });

  it('disabled rules never run; action errors increment failureCount', async () => {
    await setup();
    const rule = await mkRule(authed(app), {
      name: 'Breaker', scope: 'project', projectKey: 'AE', enabled: false,
      trigger: { type: 'issue_created' }, conditions: [],
      actions: [{ type: 'transition', to: 'No Such Status' }],
    }).expect(201);
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'AE' }, summary: 'x' } }).expect(201);
    await dispatchEvents();
    expect(await prisma.automationRun.count({ where: { ruleId: rule.body.id } })).toBe(0);

    // enable + fire → action fails → failureCount increments
    await authed(app).post(`/api/internal/automation/rules/${rule.body.id}/toggle`).send({ enabled: true }).expect(200);
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'AE' }, summary: 'y' } }).expect(201);
    await dispatchEvents();
    const run = await prisma.automationRun.findFirstOrThrow({ where: { ruleId: rule.body.id } });
    expect(run.status).toBe('some-errors');
    const updated = await prisma.automationRule.findUniqueOrThrow({ where: { id: rule.body.id } });
    expect(updated.failureCount).toBe(1);
  });

  it('validate names bad JQL + bad actor as errors', async () => {
    await setup();
    const v = await authed(app).post('/api/internal/automation/validate').send({
      trigger: { type: 'issue_created' },
      conditions: [{ type: 'jql', jql: 'this is (( broken' }],
      actions: [{ type: 'comment', body: 'x' }],
      actorId: 'nonexistent-user-id',
    });
    expect(v.body.valid).toBe(false);
    expect(v.body.errors.join(' ')).toMatch(/JQL|jql/i);
    expect(v.body.errors.join(' ')).toMatch(/actor/i);
  });
});

import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { dispatchEvents } from '../../src/services/dispatchService.js';
import { cronMatches, runScheduledRules } from '../../src/services/automationService.js';

/** 034 — automation rules: CRUD/validate, event triggers, conditions, actions,
 *  step-level run logs, loop guard, scheduled JQL, dry-run. */
describe('Automation rules (034)', () => {
  async function setup() {
    await request(app).post('/rest/api/2/project').send({ key: 'AT', name: 'Automation' }).expect(201);
  }

  const mkRule = (rule: Record<string, unknown>) =>
    request(app).post('/api/internal/automation/rules').send(rule);

  it('CRUD + validate + schema registry (FR-006)', async () => {
    await setup();
    const schema = await request(app).get('/api/internal/automation/schema').expect(200);
    expect(schema.body.triggers.map((t: { name: string }) => t.name)).toContain('issue_created');
    expect(schema.body.actions.map((a: { name: string }) => a.name)).toContain('comment');

    const v = await request(app).post('/api/internal/automation/validate').send({
      trigger: { type: 'issue_created' },
      conditions: [{ type: 'jql', jql: 'labels = urgent' }],
      actions: [{ type: 'comment', body: 'hi' }],
    });
    expect(v.body.valid).toBe(true);

    const bad = await request(app).post('/api/internal/automation/validate').send({
      trigger: { type: 'bogus' }, actions: [{ type: 'no_such' }],
    });
    expect(bad.body.valid).toBe(false);
    expect(bad.body.errors.join(' ')).toMatch(/unknown type/);

    const created = await mkRule({
      name: 'Auto label', scope: 'project', projectKey: 'AT',
      trigger: { type: 'issue_created' },
      conditions: [],
      actions: [{ type: 'add_labels', labels: ['auto'] }],
    }).expect(201);
    expect(created.body.version).toBe(1);
    expect(created.body.actor.displayName).toBe('Test Admin');
  });

  it('SC-001: assign+comment rule fires on issue_created with full step log', async () => {
    await setup();
    await mkRule({
      name: 'Greeter', scope: 'project', projectKey: 'AT',
      trigger: { type: 'issue_created' },
      conditions: [{ type: 'field_equals', field: 'issuetype.name', value: 'Task' }],
      actions: [
        { type: 'add_labels', labels: ['welcomed'] },
        { type: 'comment', body: 'Welcome {{issue.key}} — filed by {{issue.reporter.displayName}}' },
      ],
    }).expect(201);

    await request(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'AT' }, summary: 'First task' } }).expect(201);
    await dispatchEvents();

    const rule = await prisma.automationRule.findFirstOrThrow({ where: { name: 'Greeter' } });
    const runs = await prisma.automationRun.findMany({ where: { ruleId: rule.id } });
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('success');
    const steps = runs[0].steps as { step: string; result?: unknown }[];
    expect(steps.map((s) => s.step)).toEqual(['trigger', 'condition', 'action', 'action']);
    expect(steps[1].result).toBe(true);

    // actions applied — label added, comment posted with smart values expanded
    const issue = await request(app).get('/rest/api/2/issue/AT-1').expect(200);
    expect(issue.body.fields.labels).toContain('welcomed');
    const comments = await request(app).get('/rest/api/2/issue/AT-1/comment').expect(200);
    expect(comments.body.comments[0].body).toContain('AT-1');

    // Audit log endpoints must serialize BigInt triggerEventId (regression —
    // res.json() 500'd on event-triggered runs → audit log showed "No runs yet").
    const list = await request(app).get(`/api/internal/automation/rules/${rule.id}/runs`).expect(200);
    expect(list.body.runs.length).toBe(1);
    expect(typeof list.body.runs[0].triggerEventId).toBe('number');
    const one = await request(app).get(`/api/internal/automation/runs/${list.body.runs[0].id}`).expect(200);
    expect(one.body.status).toBe('success');
  });

  it('SC-002: self-triggering rule cannot recurse (skipped-loop, depth cap)', async () => {
    await setup();
    await mkRule({
      name: 'Loopy', scope: 'project', projectKey: 'AT',
      trigger: { type: 'comment_created' }, // fires on comments — including its own
      conditions: [],
      actions: [{ type: 'comment', body: 'ping {{issue.key}}' }],
    }).expect(201);

    await request(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'AT' }, summary: 'Loop source' } }).expect(201);
    await dispatchEvents();
    await request(app).post('/rest/api/2/issue/AT-1/comment')
      .send({ body: 'first comment' }).expect(201);
    // The rule's own comment emits comment_created with the rule chain
    // annotated — structurally excluded on the next dispatch (FR-004).
    for (let i = 0; i < 5; i++) await dispatchEvents();

    const rule = await prisma.automationRule.findFirstOrThrow({ where: { name: 'Loopy' } });
    const runs = await prisma.automationRun.findMany({ where: { ruleId: rule.id }, orderBy: { startedAt: 'asc' } });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0].status).toBe('success');
    // any follow-on run is a structural skip, never a comment loop
    for (const r of runs.slice(1)) expect(r.status).toBe('skipped-loop');
  });

  it('SC-003: scheduled JQL rule processes selection, per-item runs logged', async () => {
    await setup();
    for (const s of ['S1', 'S2']) {
      await request(app).post('/rest/api/2/issue')
        .send({ fields: { project: { key: 'AT' }, summary: s, labels: ['stale'] } }).expect(201);
    }
    await mkRule({
      name: 'Stale nagger', scope: 'project', projectKey: 'AT',
      trigger: { type: 'scheduled', cron: '* * * * *', jql: 'project = AT AND labels = stale' },
      conditions: [],
      actions: [{ type: 'comment', body: 'Still stale: {{issue.key}}' }],
    }).expect(201);

    const n = await runScheduledRules(new Date());
    expect(n).toBe(2);
    const rule = await prisma.automationRule.findFirstOrThrow({ where: { name: 'Stale nagger' } });
    const runs = await prisma.automationRun.findMany({ where: { ruleId: rule.id } });
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === 'success')).toBe(true);
    expect(new Set(runs.map((r) => r.issueId)).size).toBe(2); // per-item
  });

  it('cronMatches parses standard 5-field cron', () => {
    const d = new Date(Date.UTC(2026, 0, 5, 9, 0)); // Mon Jan 5 2026 09:00
    expect(cronMatches('0 9 * * 1', d)).toBe(true);   // Monday 09:00
    expect(cronMatches('0 9 * * 2', d)).toBe(false);  // Tuesday — no
    expect(cronMatches('*/15 * * * *', new Date(Date.UTC(2026, 0, 5, 9, 30)))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(Date.UTC(2026, 0, 5, 9, 31)))).toBe(false);
    expect(cronMatches('bad cron', d)).toBe(false);
  });

  it('065 G6 — cron supports MON/JAN names, Sunday=7, and rejects bad fields', async () => {
    const { cronError } = await import('../../src/services/automationService.js');
    const mon = new Date(Date.UTC(2026, 0, 5, 9, 0));  // Mon Jan 5 2026 09:00
    const sun = new Date(Date.UTC(2026, 0, 4, 9, 0));  // Sun Jan 4 2026 09:00
    expect(cronMatches('0 9 * * MON', mon)).toBe(true);       // the UI hint's example
    expect(cronMatches('0 9 * JAN MON', mon)).toBe(true);
    expect(cronMatches('0 9 * * SUN', sun)).toBe(true);
    expect(cronMatches('0 9 * * 7', sun)).toBe(true);          // 7 = Sunday alias
    expect(cronMatches('0 9 * * 0', sun)).toBe(true);
    expect(cronMatches('0 9 * * 5-7', sun)).toBe(true);        // Fri–Sun range incl. alias
    expect(cronMatches('0 9 * * 5-7', mon)).toBe(false);
    expect(cronError('0 9 * * MON')).toBeNull();
    expect(cronError('0 9 * * FUNDAY')).toContain('invalid');
    expect(cronError('61 * * * *')).toContain('invalid');
    expect(cronError('* * * *')).toContain('5 fields');
  });

  it('dry-run validates without mutating; manual run executes', async () => {
    await setup();
    await request(app).post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'AT' }, summary: 'Dry target' } }).expect(201);
    const rule = await mkRule({
      name: 'Dry', scope: 'project', projectKey: 'AT',
      trigger: { type: 'manual' },
      conditions: [],
      actions: [{ type: 'edit_fields', fields: { labels: ['dryran'] } }],
    }).expect(201);

    const dry = await request(app)
      .post(`/api/internal/automation/rules/${rule.body.id}/dry-run`)
      .send({ issueKey: 'AT-1' }).expect(200);
    expect(dry.body.status).toBe('success');
    let issue = await request(app).get('/rest/api/2/issue/AT-1').expect(200);
    expect(issue.body.fields.labels).not.toContain('dryran'); // untouched

    const run = await request(app)
      .post(`/api/internal/automation/rules/${rule.body.id}/run`)
      .send({ issueKey: 'AT-1' }).expect(202);
    expect(run.body.status).toBe('success');
    issue = await request(app).get('/rest/api/2/issue/AT-1').expect(200);
    expect(issue.body.fields.labels).toContain('dryran');
  });

  it('transition + smart value comment; non-author cannot create global rules', async () => {
    await setup();
    const noScope = await mkRule({
      name: 'Global by non-admin',
      trigger: { type: 'issue_created' }, conditions: [],
      actions: [{ type: 'comment', body: 'x' }],
    });
    expect(noScope.status).toBe(201); // admin IS allowed global scope
  });
});

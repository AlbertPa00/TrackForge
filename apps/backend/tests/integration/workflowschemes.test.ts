// Sprint 031 (US3) — workflow schemes: issueType -> workflow mapping within a
// project. Resolution chain: scheme mapping ?? scheme default; projects with
// no scheme use the legacy single-workflow binding ('Simple' fallback).
import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';

describe('workflow schemes (031 US3)', () => {
  let bugFlowId: string;
  let schemeId: string;
  let bugId: string;
  let inprogId: string;
  let doneId: string;
  let simpleId: string;

  beforeEach(async () => {
    await ensureTestAuth();
    await authed(app).post('/rest/api/2/project').send({ key: 'WF', name: 'WF' }).expect(201);
    bugId = (await prisma.issueType.findUniqueOrThrow({ where: { name: 'Bug' } })).id;
    const status = async (name: string) =>
      (await prisma.status.findUniqueOrThrow({ where: { name } })).id;
    inprogId = await status('In Progress');
    doneId = await status('Done');
    simpleId = (await prisma.workflow.findUniqueOrThrow({ where: { name: 'Simple' } })).id;
    // BugFlow: bugs are born "In Progress" and transition via 'Bug Fix'
    const wf = await authed(app)
      .post('/api/internal/workflows')
      .send({
        name: 'BugFlow',
        statuses: [
          { statusId: inprogId, isInitial: true, position: 0 },
          { statusId: doneId, position: 1 },
        ],
        transitions: [
          { name: 'Bug Fix', fromStatusId: inprogId, toStatusId: doneId },
          { name: 'Bug Reopen', fromStatusId: doneId, toStatusId: inprogId },
        ],
      })
      .expect(201);
    bugFlowId = wf.body.id;
    const s = await authed(app)
      .post('/api/internal/workflowschemes')
      .send({ name: 'WF Scheme', defaultWorkflowId: simpleId, mappings: { [bugId]: bugFlowId } })
      .expect(201);
    schemeId = s.body.id;
    await authed(app)
      .post('/api/internal/projects/WF/workflowscheme')
      .send({ schemeId })
      .expect(200);
  });

  it('scheme CRUD + in-use guard', async () => {
    const list = await authed(app).get('/api/internal/workflowschemes').expect(200);
    const s = list.body.find((x: { id: string }) => x.id === schemeId);
    expect(s.defaultWorkflow.name).toBe('Simple');
    expect(s.mappings).toHaveLength(1);
    expect(s.mappings[0].issueType.name).toBe('Bug');
    await authed(app).delete(`/api/internal/workflowschemes/${schemeId}`).expect(400);
  });

  // 060 US1 — scheme editor needs GET-by-id and a guarded workflow delete.
  it('GET /workflowschemes/:id returns default + mappings', async () => {
    const s = await authed(app).get(`/api/internal/workflowschemes/${schemeId}`).expect(200);
    expect(s.body.defaultWorkflow.name).toBe('Simple');
    expect(s.body.mappings).toHaveLength(1);
    expect(s.body.projectsUsed).toBe(1);
    await authed(app).get('/api/internal/workflowschemes/nope').expect(404);
  });

  it('DELETE /workflows/:id refuses while bound, deletes when unbound', async () => {
    // Mapped via scheme item + default — both refused.
    await authed(app).delete(`/api/internal/workflows/${bugFlowId}`).expect(400);
    await authed(app).delete(`/api/internal/workflows/${simpleId}`).expect(400);
    // Unbound workflow deletes cleanly (statuses + transitions go with it).
    const wf = await authed(app)
      .post('/api/internal/workflows')
      .send({
        name: 'DisposableFlow',
        statuses: [{ statusId: doneId, isInitial: true }],
        transitions: [{ name: 'Reset', fromStatusId: doneId, toStatusId: doneId }],
      })
      .expect(201);
    await authed(app).delete(`/api/internal/workflows/${wf.body.id}`).expect(204);
    await authed(app).get(`/api/internal/workflows/${wf.body.id}`).expect(404);
  });

  it('mapped type uses its workflow initial status; unmapped uses default', async () => {
    const bug = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'WF' }, summary: 'b', issuetype: { name: 'Bug' } } })
      .expect(201);
    const bugGet = await authed(app).get(`/rest/api/2/issue/${bug.body.key}`).expect(200);
    expect(bugGet.body.fields.status.name).toBe('In Progress'); // BugFlow initial

    const task = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'WF' }, summary: 't', issuetype: { name: 'Task' } } })
      .expect(201);
    const taskGet = await authed(app).get(`/rest/api/2/issue/${task.body.key}`).expect(200);
    expect(taskGet.body.fields.status.name).toBe('To Do'); // Simple initial
  });

  it('transitions resolve through the issue type workflow', async () => {
    const bug = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'WF' }, summary: 'b', issuetype: { name: 'Bug' } } })
      .expect(201);
    const tr = await authed(app).get(`/rest/api/2/issue/${bug.body.key}/transitions`).expect(200);
    const names = tr.body.transitions.map((t: { name: string }) => t.name);
    expect(names).toContain('Bug Fix');
    expect(names).not.toContain('Start Progress');
    // executing a BugFlow transition works
    const fix = tr.body.transitions.find((t: { name: string }) => t.name === 'Bug Fix');
    await authed(app)
      .post(`/rest/api/2/issue/${bug.body.key}/transitions`)
      .send({ transition: { id: fix.id } })
      .expect(204);
    const after = await authed(app).get(`/rest/api/2/issue/${bug.body.key}`).expect(200);
    expect(after.body.fields.status.name).toBe('Done');
  });

  it('unbound project uses Simple for all types', async () => {
    await authed(app).post('/rest/api/2/project').send({ key: 'UW', name: 'UW' }).expect(201);
    const bug = await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'UW' }, summary: 'b', issuetype: { name: 'Bug' } } })
      .expect(201);
    const bugGet = await authed(app).get(`/rest/api/2/issue/${bug.body.key}`).expect(200);
    expect(bugGet.body.fields.status.name).toBe('To Do');
    const tr = await authed(app).get(`/rest/api/2/issue/${bug.body.key}/transitions`).expect(200);
    const names = tr.body.transitions.map((t: { name: string }) => t.name);
    expect(names).toContain('Start Progress');
  });
});

import { describe, it, expect } from 'vitest';
import { authed as request, transitionTo } from '../request.js';
import app from '../../src/main.js';

describe('Sprint API', () => {
  async function setupProject(key = 'SPR') {
    await request(app).post('/rest/api/2/project').send({ key, name: 'Sprint Project' }).expect(201);
  }
  async function createIssue(key: string, summary: string) {
    await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key }, summary } })
      .expect(201);
  }

  it('creates a sprint with auto-generated name', async () => {
    await setupProject();
    const res = await request(app)
      .post('/rest/agile/1.0/sprint')
      .send({ originBoardId: 'SPR' })
      .expect(201);
    expect(res.body.name).toBe('SPR Sprint 1');
    expect(res.body.state).toBe('future');
  });

  it('lists sprints for a board, ordered active then future', async () => {
    await setupProject();
    const s1 = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    await request(app)
      .post(`/rest/agile/1.0/sprint/${s1.body.id}`)
      .send({ state: 'active' })
      .expect(200);

    const res = await request(app).get('/rest/agile/1.0/board/SPR/sprint').expect(200);
    expect(res.body.total).toBe(2);
    expect(res.body.values[0].state).toBe('active');
    expect(res.body.values[1].state).toBe('future');
  });

  it('rejects a second active sprint', async () => {
    await setupProject();
    const s1 = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    const s2 = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s1.body.id}`).send({ state: 'active' }).expect(200);

    const res = await request(app)
      .post(`/rest/agile/1.0/sprint/${s2.body.id}`)
      .send({ state: 'active' })
      .expect(400);
    expect(res.body.errorMessages[0]).toMatch(/already active/);
  });

  it('moves issues into a sprint and back to backlog', async () => {
    await setupProject();
    await createIssue('SPR', 'Sprintable');
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);

    await request(app)
      .post(`/rest/agile/1.0/sprint/${s.body.id}/issue`)
      .send({ issues: ['SPR-1'] })
      .expect(204);

    let issue = (await request(app).get('/rest/api/2/issue/SPR-1')).body;
    expect(issue.fields.sprint.name).toBe('SPR Sprint 1');

    await request(app)
      .post('/rest/agile/1.0/backlog/issue')
      .send({ issues: ['SPR-1'] })
      .expect(204);

    issue = (await request(app).get('/rest/api/2/issue/SPR-1')).body;
    expect(issue.fields.sprint).toBeNull();
  });

  it('completing a sprint returns unfinished issues to the backlog', async () => {
    await setupProject();
    await createIssue('SPR', 'Will finish');
    await createIssue('SPR', 'Will spill');
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    await request(app)
      .post(`/rest/agile/1.0/sprint/${s.body.id}/issue`)
      .send({ issues: ['SPR-1', 'SPR-2'] })
      .expect(204);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'active' }).expect(200);
    await transitionTo(app, 'SPR-1', 'Done');

    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'closed' }).expect(200);

    const done = (await request(app).get('/rest/api/2/issue/SPR-1')).body;
    const spilled = (await request(app).get('/rest/api/2/issue/SPR-2')).body;
    expect(done.fields.sprint.id).toBe(s.body.id);
    expect(spilled.fields.sprint).toBeNull();
  });

  it('board issues scope to the active sprint', async () => {
    await setupProject();
    await createIssue('SPR', 'In sprint');
    await createIssue('SPR', 'In backlog');
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    await request(app)
      .post(`/rest/agile/1.0/sprint/${s.body.id}/issue`)
      .send({ issues: ['SPR-1'] })
      .expect(204);

    // Creating a sprint flips the board to scrum — a scrum board with no
    // active sprint is empty (Sprint 013 semantics).
    let res = await request(app).get('/rest/agile/1.0/board/SPR/issue').expect(200);
    expect(res.body.total).toBe(0);

    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'active' }).expect(200);

    res = await request(app).get('/rest/agile/1.0/board/SPR/issue').expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].key).toBe('SPR-1');
  });

  // 062 US1 — the epic rail, epic pills and sprint-row avatars all read
  // fields.parent / fields.assignee; the slim agile issueIncludes dropped
  // both, leaving those features dead on every list payload.
  it('agile list payloads expose fields.parent and fields.assignee', async () => {
    await setupProject();
    const epic = await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SPR' }, summary: 'Epic one', issuetype: { name: 'Epic' } } })
      .expect(201);
    const child = await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SPR' }, summary: 'Child', parent: { key: epic.body.key } } })
      .expect(201);
    await request(app)
      .put(`/rest/api/2/issue/${child.body.key}/assignee`)
      .send({ name: 'Test Admin' })
      .expect(204);

    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    await request(app)
      .post(`/rest/agile/1.0/sprint/${s.body.id}/issue`)
      .send({ issues: [child.body.key] })
      .expect(204);

    const sprintIssues = await request(app).get(`/rest/agile/1.0/sprint/${s.body.id}/issue`).expect(200);
    const sRow = sprintIssues.body.issues.find((i: { key: string }) => i.key === child.body.key);
    expect(sRow.fields.parent?.key).toBe(epic.body.key);
    expect(sRow.fields.assignee?.displayName).toBe('Test Admin');

    await request(app).post('/rest/agile/1.0/backlog/issue').send({ issues: [child.body.key] }).expect(204);
    const backlog = await request(app).get('/rest/agile/1.0/board/SPR/backlog').expect(200);
    const bRow = backlog.body.issues.find((i: { key: string }) => i.key === child.body.key);
    expect(bRow.fields.parent?.key).toBe(epic.body.key);
    expect(bRow.fields.assignee?.displayName).toBe('Test Admin');
  });

  // Jira parity: the backlog + not-started sprints hide issues in statuses
  // mapped to the board's rightmost column; the active sprint still shows
  // them (struck through on the client) until completion.
  it('hides done-column issues from backlog and future sprints', async () => {
    await setupProject();
    await createIssue('SPR', 'Still open');
    await createIssue('SPR', 'Finished');
    await transitionTo(app, 'SPR-2', 'Done');
    const keys = (r: { body: { issues: { key: string }[] } }) => r.body.issues.map((i) => i.key);
    // Creating a sprint flips the board to scrum — backlog needs that first.
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);

    let res = await request(app).get('/rest/agile/1.0/board/SPR/backlog').expect(200);
    expect(keys(res)).toContain('SPR-1');
    expect(keys(res)).not.toContain('SPR-2');

    await request(app)
      .post(`/rest/agile/1.0/sprint/${s.body.id}/issue`)
      .send({ issues: ['SPR-1', 'SPR-2'] })
      .expect(204);
    res = await request(app).get(`/rest/agile/1.0/sprint/${s.body.id}/issue`).expect(200);
    expect(keys(res)).toEqual(['SPR-1']);

    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'active' }).expect(200);
    res = await request(app).get(`/rest/agile/1.0/sprint/${s.body.id}/issue`).expect(200);
    expect(keys(res)).toContain('SPR-2');
  });

  it('rejects adding issues to a closed sprint', async () => {
    await setupProject();
    await createIssue('SPR', 'Late');
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SPR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'active' }).expect(200);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'closed' }).expect(200);

    await request(app)
      .post(`/rest/agile/1.0/sprint/${s.body.id}/issue`)
      .send({ issues: ['SPR-1'] })
      .expect(400);
  });
});

import { describe, it, expect } from 'vitest';
import { authed as request, transitionTo } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';

async function setupProject(key = 'SCR') {
  await request(app).post('/rest/api/2/project').send({ key, name: 'Scrum Project' }).expect(201);
  const board = (await request(app).get(`/rest/agile/1.0/board/${key}`).expect(200)).body;
  return board.id as string;
}
async function createIssue(key: string, summary: string, storyPoints?: number) {
  const fields: Record<string, unknown> = { project: { key }, summary };
  if (storyPoints !== undefined) fields.story_points = storyPoints;
  const res = await request(app).post('/rest/api/2/issue').send({ fields }).expect(201);
  return res.body.key as string;
}
async function jql(q: string) {
  const res = await request(app).get('/rest/api/2/search').query({ jql: q }).expect(200);
  return res.body.issues.map((i: { key: string }) => i.key);
}

describe('Sprint 013 — Scrum completion', () => {
  it('re-parents sprints to the board and flips the board to scrum', async () => {
    const boardId = await setupProject();
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: boardId }).expect(201);
    expect(s.body.originBoardId).toBe(boardId);
    expect(s.body.sequence).toBe(1);

    const board = (await request(app).get(`/rest/agile/1.0/board/${boardId}`).expect(200)).body;
    expect(board.type).toBe('scrum');
  });

  it('GET/PUT/DELETE sprint lifecycle', async () => {
    await setupProject();
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);

    const got = await request(app).get(`/rest/agile/1.0/sprint/${s.body.id}`).expect(200);
    expect(got.body.name).toBe('SCR Sprint 1');

    const renamed = await request(app)
      .put(`/rest/agile/1.0/sprint/${s.body.id}`)
      .send({ name: 'Renamed', goal: 'Ship it' })
      .expect(200);
    expect(renamed.body.name).toBe('Renamed');
    expect(renamed.body.goal).toBe('Ship it');

    await request(app).delete(`/rest/agile/1.0/sprint/${s.body.id}`).expect(204);
    await request(app).get(`/rest/agile/1.0/sprint/${s.body.id}`).expect(404);
  });

  it('rejects deleting an active sprint', async () => {
    await setupProject();
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'active' }).expect(200);
    const res = await request(app).delete(`/rest/agile/1.0/sprint/${s.body.id}`).expect(400);
    expect(res.body.errorMessages[0]).toMatch(/future/i);
  });

  it('records IssueSprint membership history on moves', async () => {
    await setupProject();
    await createIssue('SCR', 'Tracked');
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}/issue`).send({ issues: ['SCR-1'] }).expect(204);

    let rows = await prisma.issueSprint.findMany({ where: { sprintId: s.body.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].removedAt).toBeNull();

    await request(app).post('/rest/agile/1.0/backlog/issue').send({ issues: ['SCR-1'] }).expect(204);
    rows = await prisma.issueSprint.findMany({ where: { sprintId: s.body.id } });
    expect(rows[0].removedAt).not.toBeNull();
  });

  it('carry-over moves open issues to a named future sprint, done ones stay', async () => {
    await setupProject();
    await createIssue('SCR', 'Done work');
    await createIssue('SCR', 'Spillover');
    const s1 = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    const s2 = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s1.body.id}/issue`).send({ issues: ['SCR-1', 'SCR-2'] }).expect(204);
    await request(app).post(`/rest/agile/1.0/sprint/${s1.body.id}`).send({ state: 'active' }).expect(200);
    await transitionTo(app, 'SCR-1', 'Done');

    const closed = await request(app)
      .post(`/rest/agile/1.0/sprint/${s1.body.id}`)
      .send({ state: 'closed', moveOpenIssuesTo: s2.body.id })
      .expect(200);
    expect(closed.body.completeDate).toBeTruthy();

    const done = (await request(app).get('/rest/api/2/issue/SCR-1')).body;
    const spilled = (await request(app).get('/rest/api/2/issue/SCR-2')).body;
    expect(done.fields.sprint.id).toBe(s1.body.id);
    expect(spilled.fields.sprint.id).toBe(s2.body.id);
  });

  it('carry-over can create a new sprint on close', async () => {
    await setupProject();
    await createIssue('SCR', 'Spill');
    const s1 = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s1.body.id}/issue`).send({ issues: ['SCR-1'] }).expect(204);
    await request(app).post(`/rest/agile/1.0/sprint/${s1.body.id}`).send({ state: 'active' }).expect(200);
    await request(app)
      .post(`/rest/agile/1.0/sprint/${s1.body.id}`)
      .send({ state: 'closed', moveOpenIssuesTo: 'new', newSprintName: 'Rollover' })
      .expect(200);

    const spilled = (await request(app).get('/rest/api/2/issue/SCR-1')).body;
    expect(spilled.fields.sprint.name).toBe('Rollover');
    expect((await request(app).get('/rest/agile/1.0/board/SCR/sprint?state=future')).body.total).toBe(1);
  });

  it('story points: create, update, response, JQL compare + EMPTY', async () => {
    await setupProject();
    await createIssue('SCR', 'Estimated', 5);
    await createIssue('SCR', 'Unestimated');

    let issue = (await request(app).get('/rest/api/2/issue/SCR-1')).body;
    expect(issue.fields.story_points).toBe(5);

    await request(app)
      .put('/rest/api/2/issue/SCR-1')
      .send({ fields: { story_points: 8 } })
      .expect(204);
    issue = (await request(app).get('/rest/api/2/issue/SCR-1')).body;
    expect(issue.fields.story_points).toBe(8);

    // changelog records the change
    const hist = (await request(app).get('/rest/api/2/issue/SCR-1?expand=changelog')).body.changelog;
    expect(hist.histories[0].items[0].field).toBe('Story Points');

    expect(await jql('storypoints >= 5')).toEqual(['SCR-1']);
    expect(await jql('storypoints is EMPTY')).toEqual(['SCR-2']);
    expect(await jql('storypoints < 10 order by storypoints desc')).toEqual(['SCR-1']);
  });

  it('JQL sprint field: =, IN, openSprints(), closedSprints()', async () => {
    await setupProject();
    await createIssue('SCR', 'In sprint');
    await createIssue('SCR', 'In backlog');
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}/issue`).send({ issues: ['SCR-1'] }).expect(204);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'active' }).expect(200);

    expect(await jql(`sprint = "${s.body.id}"`)).toEqual(['SCR-1']);
    expect(await jql(`sprint = ${s.body.sequence}`)).toEqual(['SCR-1']);
    expect(await jql('sprint is EMPTY')).toEqual(['SCR-2']);
    expect(await jql('sprint in openSprints()')).toEqual(['SCR-1']);
    expect(await jql('sprint in closedSprints()')).toEqual([]);

    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'closed' }).expect(200);
    // After close the issue's sprintId stays (it was done? no — open issues carry to backlog)
    // SCR-1 was open → carried to backlog, so closedSprints() matches nothing current.
    expect(await jql('sprint is EMPTY')).toEqual(['SCR-1', 'SCR-2']);
  });

  it('backlog endpoint lists only un-sprinted issues, scrum boards only', async () => {
    const boardId = await setupProject();
    await createIssue('SCR', 'Backlog one');
    await createIssue('SCR', 'Backlog two');
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}/issue`).send({ issues: ['SCR-1'] }).expect(204);

    const res = await request(app).get(`/rest/agile/1.0/board/${boardId}/backlog`).expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.issues[0].key).toBe('SCR-2');
  });

  it('backlog endpoint rejects kanban boards', async () => {
    await request(app).post('/rest/api/2/project').send({ key: 'KAN', name: 'Kanban' }).expect(201);
    // KAN board is kanban (no sprints created → stays kanban)
    const res = await request(app).get('/rest/agile/1.0/board/KAN/backlog').expect(400);
    expect(res.body.errorMessages[0]).toMatch(/scrum/i);
  });

  it('board type flip: kanban→scrum works; scrum→kanban blocked by open sprints', async () => {
    const boardId = await setupProject();
    await request(app).put(`/rest/agile/1.0/board/${boardId}/type`).send({ type: 'scrum' }).expect(200);

    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: boardId }).expect(201);
    await request(app).put(`/rest/agile/1.0/board/${boardId}/type`).send({ type: 'kanban' }).expect(400);

    // delete the open sprint, then flip succeeds
    await request(app).delete(`/rest/agile/1.0/sprint/${s.body.id}`).expect(204);
    const res = await request(app).put(`/rest/agile/1.0/board/${boardId}/type`).send({ type: 'kanban' }).expect(200);
    expect(res.body.type).toBe('kanban');
  });

  it('epic endpoints: get, move issues, list, remove', async () => {
    await setupProject();
    const epicKey = await request(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'SCR' }, summary: 'Big epic', issuetype: { name: 'Epic' } } })
      .expect(201);
    await createIssue('SCR', 'Story one');
    await createIssue('SCR', 'Story two');

    const epic = await request(app).get(`/rest/agile/1.0/epic/${epicKey.body.key}`).expect(200);
    expect(epic.body.name).toBe('Big epic');
    expect(epic.body.done).toBe(false);

    await request(app)
      .post(`/rest/agile/1.0/epic/${epicKey.body.key}/issue`)
      .send({ issues: ['SCR-2', 'SCR-3'] })
      .expect(204);

    const children = await request(app).get(`/rest/agile/1.0/epic/${epicKey.body.key}/issue`).expect(200);
    expect(children.body.total).toBe(2);

    // epic/none/issue removes the link
    await request(app).post('/rest/agile/1.0/epic/none/issue').send({ issues: ['SCR-3'] }).expect(204);
    const removed = (await request(app).get('/rest/api/2/issue/SCR-3')).body;
    expect(removed.fields.parent ?? null).toBeNull();
  });

  it('velocity + burndown + sprint report derive from history', async () => {
    await setupProject();
    await createIssue('SCR', 'Done 5', 5);
    await createIssue('SCR', 'Open 3', 3);
    const s = await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: 'SCR' }).expect(201);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}/issue`).send({ issues: ['SCR-1', 'SCR-2'] }).expect(204);
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'active' }).expect(200);
    await transitionTo(app, 'SCR-1', 'Done');
    await request(app).post(`/rest/agile/1.0/sprint/${s.body.id}`).send({ state: 'closed' }).expect(200);

    const velocity = await request(app).get('/api/internal/reports/board/SCR/velocity').expect(200);
    expect(velocity.body.sprints).toHaveLength(1);
    expect(velocity.body.sprints[0].committedPoints).toBe(8);
    expect(velocity.body.sprints[0].completedPoints).toBe(5);

    const burndown = await request(app)
      .get('/api/internal/reports/board/SCR/burndown')
      .query({ sprintId: s.body.id })
      .expect(200);
    expect(burndown.body.series.length).toBeGreaterThanOrEqual(1);
    // final day: only the open issue (3 pts) remains
    const last = burndown.body.series[burndown.body.series.length - 1];
    expect(last.remaining).toBe(3);
    expect(last.done).toBe(5);

    const report = await request(app)
      .get(`/api/internal/reports/board/SCR/sprint/${s.body.id}/report`)
      .expect(200);
    expect(report.body.issues).toHaveLength(2);
    const doneRow = report.body.issues.find((i: { key: string }) => i.key === 'SCR-1');
    expect(doneRow.done).toBe(true);
    expect(doneRow.points).toBe(5);
  });

  it('scrum board with no active sprint lists no issues; kanban lists all', async () => {
    const boardId = await setupProject();
    await createIssue('SCR', 'Loose issue');
    await request(app).post('/rest/agile/1.0/sprint').send({ originBoardId: boardId }).expect(201);

    // board is now scrum, no active sprint → empty board
    let res = await request(app).get(`/rest/agile/1.0/board/${boardId}/issue`).expect(200);
    expect(res.body.total).toBe(0);

    await request(app).post('/rest/api/2/project').send({ key: 'K2', name: 'Kanban2' }).expect(201);
    await createIssue('K2', 'Kanban issue');
    res = await request(app).get('/rest/agile/1.0/board/K2/issue').expect(200);
    expect(res.body.total).toBe(1);
  });
});

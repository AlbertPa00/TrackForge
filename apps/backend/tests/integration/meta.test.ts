import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';

describe('Metadata API', () => {
  it('lists statuses with status categories', async () => {
    const res = await request(app).get('/rest/api/2/status').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    const names = res.body.map((s: { name: string }) => s.name);
    expect(names).toContain('To Do');
    expect(names).toContain('In Progress');
    expect(names).toContain('Done');

    const done = res.body.find((s: { name: string }) => s.name === 'Done');
    expect(done.statusCategory.key).toBe('done');
    const todo = res.body.find((s: { name: string }) => s.name === 'To Do');
    expect(todo.statusCategory.key).toBe('new');
  });

  it('lists priorities', async () => {
    const res = await request(app).get('/rest/api/2/priority').expect(200);
    expect(res.body.length).toBeGreaterThanOrEqual(5);
    const names = res.body.map((p: { name: string }) => p.name);
    expect(names).toEqual(['Highest', 'High', 'Medium', 'Low', 'Lowest']);
  });

  it('lists issue types', async () => {
    const res = await request(app).get('/rest/api/2/issuetype').expect(200);
    const names = res.body.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Epic', 'Story', 'Task', 'Bug', 'Subtask']));
    const subtask = res.body.find((t: { name: string }) => t.name === 'Subtask');
    expect(subtask.subtask).toBe(true);
  });

  it('returns the authenticated user from /myself', async () => {
    const res = await request(app).get('/rest/api/2/myself').expect(200);
    expect(res.body.accountId).toBeTruthy();
    expect(res.body.displayName).toBe('Test Admin');
    expect(res.body.emailAddress).toBe('admin@test.local');
    expect(res.body.active).toBe(true);
  });
});

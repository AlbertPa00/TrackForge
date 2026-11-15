import { describe, it, expect } from 'vitest';
import { authed as request } from '../request.js';
import app from '../../src/main.js';

async function issueWithComments(count: number) {
  await request(app).post('/rest/api/2/project').send({ key: 'CMT', name: 'Comment Project' }).expect(201);
  const res = await request(app)
    .post('/rest/api/2/issue')
    .send({ fields: { project: { key: 'CMT' }, summary: 'Commented issue' } })
    .expect(201);
  const key = res.body.key as string;
  for (let i = 1; i <= count; i++) {
    await request(app)
      .post(`/rest/api/2/issue/${key}/comment`)
      .send({ body: `comment-${i}` })
      .expect(201);
  }
  return key;
}

describe('Comment list orderBy (Sprint 055)', () => {
  it('defaults to newest-first', async () => {
    const key = await issueWithComments(3);
    const res = await request(app).get(`/rest/api/2/issue/${key}/comment`).expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.comments.map((c: { body: string }) => c.body)).toEqual([
      'comment-3',
      'comment-2',
      'comment-1',
    ]);
  });

  it('orderBy=created returns oldest-first', async () => {
    const key = await issueWithComments(3);
    const res = await request(app)
      .get(`/rest/api/2/issue/${key}/comment?orderBy=created`)
      .expect(200);
    expect(res.body.comments.map((c: { body: string }) => c.body)).toEqual([
      'comment-1',
      'comment-2',
      'comment-3',
    ]);
  });

  it('orderBy applies to the server-side page window, not just the slice', async () => {
    const key = await issueWithComments(4);
    const res = await request(app)
      .get(`/rest/api/2/issue/${key}/comment?orderBy=%2Bcreated&startAt=1&maxResults=2`)
      .expect(200);
    expect(res.body.total).toBe(4);
    expect(res.body.startAt).toBe(1);
    expect(res.body.comments.map((c: { body: string }) => c.body)).toEqual(['comment-2', 'comment-3']);
  });
});

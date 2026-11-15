import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { requestLogger, loggerOptions } from '../../src/lib/logger.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('016 request logger', () => {
  it('emits request/actor/channel/trace fields and never logs secrets', async () => {
    const { lines, stream } = capture();
    const app = express();
    app.use(requestLogger(pino({ ...loggerOptions, level: 'info' }, stream)));
    app.get('/rest/api/2/issue/:key', (req, res) => {
      req.actor = { user: { id: 'u1' }, token: { id: 't9' }, channel: 'api' } as never;
      res.json({ ok: true });
    });

    const SECRET = 'tf_secret_zzz_never_logged';
    await request(app)
      .get(`/rest/api/2/issue/TF-1?access_token=${SECRET}`)
      .set('Authorization', `Bearer ${SECRET}`)
      .expect(200);
    await sleep(10);

    const out = lines.join('');
    expect(out).not.toContain(SECRET); // neither bearer header nor ?access_token
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.method).toBe('GET');
    expect(parsed.path).toBe('/rest/api/2/issue/TF-1'); // query stripped
    expect(parsed.status).toBe(200);
    expect(parsed.actorId).toBe('u1');
    expect(parsed.channel).toBe('api');
    expect(parsed.tokenId).toBe('t9');
    expect(parsed.requestId).toBeTruthy();
    expect(parsed.traceId).toBeTruthy();
  });
});

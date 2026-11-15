// 047 US5-3 — ephemeral ai.progress frames reach only the requesting user's
// SSE clients; they are not DomainEvents and are never backfilled.
import { describe, it, expect } from 'vitest';
import type { Response } from 'express';
import { sseSubscribe, sseEmitToUser, sseClientCount } from '../../src/services/sseHub.js';

function fakeRes() {
  const writes: string[] = [];
  const res = {
    write: (s: string) => { writes.push(s); return true; },
    on: () => {},
  } as unknown as Response;
  return { res, writes };
}

const actor = (id: string) => ({ user: { id, displayName: id }, channel: 'ui' }) as never;

describe('sseEmitToUser — ai.progress frames', () => {
  it('targets only the requesting user; writes a tf-progress frame, not tf-event', () => {
    const a = fakeRes(); const b = fakeRes();
    sseSubscribe(a.res, null, actor('u-a'));
    sseSubscribe(b.res, null, actor('u-b'));
    expect(sseClientCount()).toBeGreaterThanOrEqual(2);

    sseEmitToUser('u-a', { type: 'ai.progress', feature: 'plan', step: 'llm' });

    expect(a.writes).toHaveLength(1);
    expect(a.writes[0]).toContain('event: tf-progress');
    expect(a.writes[0]).toContain('"feature":"plan"');
    expect(a.writes[0]).toContain('"step":"llm"');
    expect(b.writes).toHaveLength(0);
  });

  it('no-ops cleanly when the user has no SSE client', () => {
    expect(() => sseEmitToUser('no-such-user', { type: 'ai.progress' })).not.toThrow();
  });
});

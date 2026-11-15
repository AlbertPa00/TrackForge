import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../prisma.js';
import { internalRequest, type InternalCallOptions } from './internalRequest.js';

/** Preview→confirm flows get 10 minutes before the token lapses. */
const TTL_MS = 10 * 60 * 1000;

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');

/**
 * Issue a single-use confirm token for `kind`+`subject` (065 audit F4 — the
 * old HMAC-of-fixed-string tokens never expired and could be replayed
 * forever). The raw value is returned to the preview caller once; only its
 * hash is persisted.
 */
export async function issueConfirmToken(kind: string, subject: string): Promise<string> {
  const raw = randomBytes(24).toString('hex');
  await prisma.confirmToken.create({
    data: { tokenHash: hash(raw), kind, subject, expiresAt: new Date(Date.now() + TTL_MS) },
  });
  return raw;
}

/**
 * Atomically claim a confirm token. Returns true exactly once per issued
 * token: expired, wrong-kind, wrong-subject, replayed and unknown tokens all
 * return false (updateMany is the race-safe claim).
 */
export async function consumeConfirmToken(kind: string, subject: string, raw: string | undefined): Promise<boolean> {
  if (!raw) return false;
  const { count } = await prisma.confirmToken.updateMany({
    where: {
      tokenHash: hash(raw),
      kind,
      subject,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { usedAt: new Date() },
  });
  return count === 1;
}

/** Strip any `confirmToken=` param — a stale stored token must never be replayed. */
export function stripConfirmToken(path: string): string {
  return path.replace(/([?&])confirmToken=[^&]+&?/, '$1').replace(/[?&]$/, '');
}

/**
 * 065 US4.5 — the strip → dry-run → re-append dance lived in both
 * proposalService and copilotService and had already diverged (one stripped
 * stale tokens, one didn't). One helper: dry-run `method path` as `actor`,
 * and if the preview returns a confirmToken, return the path with the fresh
 * token appended.
 */
export async function pathWithFreshConfirmToken(
  actor: InternalCallOptions,
  path: string,
  method = 'DELETE'
): Promise<string> {
  const clean = stripConfirmToken(path);
  const sep = clean.includes('?') ? '&' : '?';
  const { body } = await internalRequest<{ confirmToken?: string }>(actor, method, `${clean}${sep}dryRun=true`);
  return body?.confirmToken ? `${clean}${sep}confirmToken=${body.confirmToken}` : clean;
}

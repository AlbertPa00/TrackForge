import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../prisma.js';
import { jiraError } from '../lib/errors.js';

const TTL_MS = 24 * 60 * 60 * 1000;

function requestHash(req: Request): string {
  // 065 audit E5 — originalUrl keeps the query string: a ?dryRun=true preview
  // and the real write hash differently, so the preview can no longer replay
  // over the actual mutation.
  return crypto
    .createHash('sha256')
    .update(`${req.method} ${req.originalUrl} ${JSON.stringify(req.body ?? {})}`)
    .digest('hex');
}

// Periodically purge expired records (best-effort, once per minute at most).
let lastPurge = 0;
async function purgeExpired() {
  if (Date.now() - lastPurge < 60_000) return;
  lastPurge = Date.now();
  await prisma.idempotencyRecord
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - TTL_MS) } } })
    .catch(() => undefined);
}

/**
 * Jira-compatible idempotent writes. When an `Idempotency-Key` header is
 * present on a write request, the (principal, key) pair is looked up:
 *  - replay with the same body  → stored status + body are returned
 *  - replay with a different body → 422
 *  - first sighting             → executed; the response is captured + stored
 */
/** Sentinel status marking an in-flight request (never a real HTTP status). */
const PENDING = -1;

export async function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !key.trim() || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    next();
    return;
  }
  const idemKey = key.trim().slice(0, 255);
  const principalId = req.actor?.token?.id ?? req.actor?.user.id ?? 'anonymous';
  const hash = requestHash(req);

  // 065 audit E5 — claim-then-execute: insert the pending record FIRST so a
  // concurrent replay loses the unique-key race instead of executing twice.
  let claimId: string | null = null;
  try {
    await purgeExpired();
    for (let attempt = 0; attempt < 2 && !claimId; attempt++) {
      try {
        const claim = await prisma.idempotencyRecord.create({
          data: {
            principalId,
            key: idemKey,
            method: req.method,
            path: req.originalUrl,
            requestHash: hash,
            status: PENDING,
          },
          select: { id: true },
        });
        claimId = claim.id;
        break;
      } catch {
        const existing = await prisma.idempotencyRecord.findUnique({
          where: { principalId_key: { principalId, key: idemKey } },
        });
        if (!existing) {
          // Claim failed for another reason (or the row was purged) — execute.
          next();
          return;
        }
        if (existing.requestHash !== hash) {
          res
            .status(422)
            .json(
              jiraError([
                `Idempotency-Key '${idemKey}' was already used with a different request. Choose a new key for a new request.`,
              ])
            );
          return;
        }
        if (existing.status === PENDING) {
          // A request that died mid-flight leaves a stale claim; reclaim keys
          // idle past two minutes so they are not blocked for the full TTL.
          const stale = Date.now() - existing.createdAt.getTime() > 120_000;
          if (stale && attempt === 0) {
            await prisma.idempotencyRecord
              .deleteMany({ where: { id: existing.id, status: PENDING } })
              .catch(() => undefined);
            continue;
          }
          res
            .status(409)
            .json(jiraError([`Idempotency-Key '${idemKey}' belongs to a request still in progress. Retry shortly.`]));
          return;
        }
        res.setHeader('X-TrackForge-Idempotent-Replay', 'true');
        res.status(existing.status);
        if (existing.responseBody) {
          res.type('application/json').send(existing.responseBody);
        } else {
          res.end();
        }
        return;
      }
    }
  } catch {
    // storage unavailable — fall through and execute without idempotency
    next();
    return;
  }
  if (!claimId) {
    next();
    return;
  }

  // Capture the response and finalize the claim after it is sent.
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  let captured: { status: number; body?: string } | null = null;

  res.json = ((body: unknown) => {
    captured = { status: res.statusCode, body: JSON.stringify(body) };
    return origJson(body);
  }) as typeof res.json;
  res.send = ((body: unknown) => {
    if (!captured) {
      captured = {
        status: res.statusCode,
        body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
      };
    }
    return origSend(body);
  }) as typeof res.send;

  res.on('finish', () => {
    const status = captured?.status ?? res.statusCode;
    if (status < 500) {
      void prisma.idempotencyRecord
        .update({ where: { id: claimId }, data: { status, responseBody: captured?.body ?? null } })
        .catch(() => undefined);
    } else {
      // Never persist 5xx as replayable — release the key so a retry executes.
      void prisma.idempotencyRecord.delete({ where: { id: claimId } }).catch(() => undefined);
    }
  });
  next();
}

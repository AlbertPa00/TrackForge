import { pino, type Logger, type LoggerOptions } from 'pino';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Sprint 016 US2 — structured request logs. One `info` line per request at
 * finish with request/trace/actor/channel ids. Secret-free: bearer tokens,
 * cookies, `access_token` query params, and passwords are redacted (and
 * query strings are never logged — SSE accepts `?access_token=`).
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'trackforge-backend', pid: process.pid },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-trackforge-token"]',
      '*.password',
      '*.secret',
      '*.token',
      '*.access_token',
    ],
    censor: '[redacted]',
  },
};

export const logger: Logger = pino(loggerOptions);

/** Trace id from the inbound header or a fresh UUID (no backend — emit ids only). */
function traceIdFrom(req: Request): string {
  const h = String(req.headers['x-trace-id'] ?? req.headers.traceparent ?? '');
  const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(h);
  return m?.[0] ?? randomUUID();
}

export function requestLogger(log: Logger = logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = String(req.headers['x-request-id'] ?? '') || randomUUID();
    const traceId = traceIdFrom(req);
    res.setHeader('x-request-id', requestId);
    const t0 = performance.now();
    res.on('finish', () => {
      // Path only — never originalUrl: query strings can carry ?access_token=.
      const path = (req.baseUrl ?? '') + (req.path ?? '');
      log.info(
        {
          requestId,
          traceId,
          method: req.method,
          path,
          status: res.statusCode,
          ms: Math.round(performance.now() - t0),
          actorId: req.actor?.user.id,
          channel: req.actor?.channel,
          tokenId: req.actor?.token?.id,
        },
        'request'
      );
    });
    next();
  };
}
